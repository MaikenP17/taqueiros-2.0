-- =============================================================
-- TAQUEIROS 2.0 — DOMINIOS POR RESTAURANTE  (SQL 11)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo activa RLS por su cuenta)
--
-- ANTES DE CORRERLO
--   * El SQL 10 ya debe estar aplicado (restaurantes, Taqueiros #1).
--
-- QUE HACE
--   * Crea public.restaurante_dominios: que "host" (taqueiros-2-0.vercel.app,
--     lostaqueiros.midominio.com...) pertenece a que restaurante. Es lo
--     primero que consulta el servidor (api/_restaurante.js) para saber de
--     que restaurante es cada peticion.
--   * Siembra el host taqueiros-2-0.vercel.app para Taqueiros.
--   * RLS activo y SIN politicas, y sin privilegios para anon ni
--     authenticated: solo el servidor (llave secreta) la lee o la escribe.
--     Asi nadie puede averiguar con la llave publishable que hosts existen.
--
-- QUE NO HACE
--   * No toca ninguna otra tabla, funcion ni politica.
--   * No retira el valor por defecto transitorio de restaurante_id.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una
-- transaccion. Si cualquier paso o comprobacion falla, TODO se revierte.
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Para SQL plano, el editor muestra el numero de linea: en VS Code usa Ctrl+G y busca hacia
--     arriba el marcador "-- >>> PASO ..." mas cercano. Lista de marcadores: buscar ">>> PASO".
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 11 SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := '';
begin
  v_item := 'public.restaurantes';
  if to_regclass('public.restaurantes') is null then
    raise exception 'Falta public.restaurantes: corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'public.restaurante_taqueiros_id()';
  if to_regprocedure('public.restaurante_taqueiros_id()') is null then
    raise exception 'Falta public.restaurante_taqueiros_id(): corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'restaurante Taqueiros';
  if not exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) then
    raise exception 'No existe el restaurante Taqueiros (id fijo del SQL 10)';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr11_flags;
create temp table _mr11_flags (k text primary key, v boolean not null);


-- =============================================================
-- >>> PASO 1) TABLA restaurante_dominios
-- =============================================================
-- host: el nombre exacto que llega en el encabezado Host, SIN puerto y en
-- minusculas (el servidor lo normaliza igual antes de buscar). La llave
-- primaria lo hace unico: un host pertenece a UN solo restaurante.
do $do$
declare
  v_paso constant text := '1 crear restaurante_dominios';
  v_item text := 'public.restaurante_dominios';
begin
  if to_regclass('public.restaurante_dominios') is null then
    create table public.restaurante_dominios (
      host           text primary key,
      restaurante_id uuid not null references public.restaurantes(id) on delete cascade,
      creado_en      timestamptz not null default now(),
      constraint restaurante_dominios_host_formato
        check (host = lower(host)
               and char_length(host) between 3 and 253
               and host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
               and host !~ '\.\.')
    );
    insert into _mr11_flags (k, v) values ('tabla_nueva', true) on conflict (k) do nothing;
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

create index if not exists restaurante_dominios_restaurante_idx
  on public.restaurante_dominios (restaurante_id);


-- =============================================================
-- >>> PASO 2) SEGURIDAD: RLS activo, sin politicas, solo el servidor
-- =============================================================
-- En Supabase las tablas nuevas de public nacen con privilegios para anon y
-- authenticated (ALTER DEFAULT PRIVILEGES). Se quitan explicitamente.
alter table public.restaurante_dominios enable row level security;

do $do$
declare
  v_paso constant text := '2 politicas y privilegios de restaurante_dominios';
  v_item text := '';
  r record;
begin
  -- Fuera cualquier politica que exista (por OID del catalogo, no por nombre armado a mano)
  for r in select p.polname
           from pg_policy p
           where p.polrelid = 'public.restaurante_dominios'::regclass loop
    v_item := r.polname;
    execute format('drop policy %I on public.restaurante_dominios', r.polname);
  end loop;

  v_item := 'privilegios';
  revoke all on public.restaurante_dominios from public, anon, authenticated;
  grant select, insert, update, delete on public.restaurante_dominios to service_role;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 3) SEMILLA: el host de produccion de Taqueiros
-- =============================================================
do $do$
declare
  v_paso constant text := '3 sembrar el host de Taqueiros';
  v_item text := 'taqueiros-2-0.vercel.app';
begin
  insert into public.restaurante_dominios (host, restaurante_id)
  values ('taqueiros-2-0.vercel.app', public.restaurante_taqueiros_id())
  on conflict (host) do nothing;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 4) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr11_verif;
create temp table _mr11_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr11_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('restaurante_dominios existe, con RLS activo',
    (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.restaurante_dominios')),
    null),

  ('restaurante_dominios: ninguna politica (solo el servidor la lee)',
    not exists (select 1 from pg_policy p where p.polrelid = to_regclass('public.restaurante_dominios')),
    (select string_agg(p.polname, ', ') from pg_policy p where p.polrelid = to_regclass('public.restaurante_dominios'))),

  ('restaurante_dominios: anon y authenticated sin ningun privilegio',
    not has_table_privilege('anon', to_regclass('public.restaurante_dominios'), 'select,insert,update,delete,truncate,references,trigger')
      and not has_table_privilege('authenticated', to_regclass('public.restaurante_dominios'), 'select,insert,update,delete,truncate,references,trigger'),
    null),

  ('restaurante_dominios: ninguna columna visible para anon ni authenticated',
    not exists (select 1 from pg_attribute a
                where a.attrelid = to_regclass('public.restaurante_dominios') and a.attnum > 0 and not a.attisdropped
                  and (has_column_privilege('anon', a.attrelid, a.attnum, 'select')
                       or has_column_privilege('authenticated', a.attrelid, a.attnum, 'select'))),
    null),

  ('restaurante_dominios: el servidor (service_role) si puede leer y escribir',
    has_table_privilege('service_role', to_regclass('public.restaurante_dominios'), 'select,insert,update,delete'),
    null),

  ('restaurante_dominios: host unico (llave primaria) y formato en minusculas',
    exists (select 1 from pg_constraint k
            where k.conrelid = to_regclass('public.restaurante_dominios') and k.contype = 'p'
              and pg_get_constraintdef(k.oid) = 'PRIMARY KEY (host)')
      and exists (select 1 from pg_constraint k
                  where k.conrelid = to_regclass('public.restaurante_dominios') and k.contype = 'c'
                    and k.conname = 'restaurante_dominios_host_formato'),
    null),

  ('restaurante_dominios: restaurante_id es NOT NULL con llave foranea a restaurantes',
    exists (select 1 from pg_attribute a
            where a.attrelid = to_regclass('public.restaurante_dominios') and a.attname = 'restaurante_id'
              and a.attnum > 0 and not a.attisdropped and a.attnotnull)
      and exists (select 1 from pg_constraint k
                  where k.conrelid = to_regclass('public.restaurante_dominios') and k.contype = 'f'
                    and k.confrelid = 'public.restaurantes'::regclass),
    null),

  ('taqueiros-2-0.vercel.app apunta a Taqueiros',
    exists (select 1 from public.restaurante_dominios d
            where d.host = 'taqueiros-2-0.vercel.app' and d.restaurante_id = public.restaurante_taqueiros_id()),
    (select string_agg(d.host, ', ') from public.restaurante_dominios d)),

  ('ningun host con mayusculas, espacios ni puerto',
    not exists (select 1 from public.restaurante_dominios d where d.host <> lower(d.host) or d.host ~ '[\s:/]'),
    null),

  -- Misma comprobacion que el SQL 10, por OID: esta migracion no debe abrir nada a anon.
  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    (select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and has_table_privilege('anon', c.oid, 'select,insert,update,delete'))),

  ('RLS activo en TODAS las tablas de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
    (select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))),

  ('las demas tablas de Taqueiros siguen intactas (restaurantes con Taqueiros #1)',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id() and r.slug = 'taqueiros'),
    null)
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr11_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 11 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- PostgREST tiene que enterarse de la tabla nueva (el servidor la consulta por REST).
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr11_verif
order by orden;
