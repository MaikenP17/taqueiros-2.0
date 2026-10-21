-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 13  (deja la base como despues del SQL 12)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de correr supabase/13-endurecer.sql, algo deja de funcionar en produccion
--   (por ejemplo, un script o una pantalla que inserta sin restaurante_id, o un dueno que ya no puede
--   guardar algo que antes si). Antes de usarlo, mira el mensaje de error exacto: casi siempre el
--   problema esta en quien manda el dato, no en la regla.
--
-- QUE HACE
--   1. Devuelve el valor por defecto transitorio restaurante_id = restaurante_taqueiros_id() a
--      pedidos, categorias, productos, configuracion y salud_notificaciones (las 5 tablas a las que
--      el SQL 10 se lo puso).
--   2. Quita el trigger de validacion de restaurantes.config y el de rangos de tarifas, y borra sus
--      funciones.
--   3. Quita la proteccion de columnas de configuracion y devuelve proteger_campos_restaurante() a la
--      version del SQL 10 (el dueno vuelve a poder editar toda la config, pero no plan, estado,
--      vigencia, modulos, slug, zona horaria ni hora de corte).
--   4. Devuelve al dueno el permiso de escribir tarifas_domicilio (como en el SQL 10).
--
-- QUE NO HACE
--   * No cambia ni borra datos. No toca Storage, ni las politicas de las demas tablas.
--   * No quita los privilegios que el SQL 13 re-afirmo sobre las tablas privadas (secretos,
--     contadores, dominios, intentos, personal): siguen cerrados, como estaban.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a endurecer: supabase/13-endurecer.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 13 SE REVIRTIO" con la lista. Todo se revierte.
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
    raise exception 'Falta public.restaurantes: este archivo solo revierte el SQL 13';
  end if;
  v_item := 'public.restaurante_taqueiros_id()';
  if to_regprocedure('public.restaurante_taqueiros_id()') is null then
    raise exception 'Falta public.restaurante_taqueiros_id(): sin ella no se puede devolver el valor por defecto';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr13r_antes;
create temp table _mr13r_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;


-- =============================================================
-- >>> PASO 1) DEVOLVER EL VALOR POR DEFECTO TRANSITORIO
-- =============================================================
do $do$
declare
  v_paso constant text := '1 devolver el valor por defecto de restaurante_id';
  v_item text := '';
  t text;
begin
  foreach t in array array['pedidos','categorias','productos','configuracion','salud_notificaciones'] loop
    v_item := t;
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I alter column restaurante_id set default public.restaurante_taqueiros_id()', t);
    end if;
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) QUITAR LAS VALIDACIONES Y LAS PROTECCIONES NUEVAS
-- =============================================================
drop trigger if exists restaurantes_validar_config on public.restaurantes;
drop trigger if exists tarifas_domicilio_validar on public.tarifas_domicilio;
drop trigger if exists configuracion_proteger on public.configuracion;

drop function if exists public.validar_config_restaurante();
drop function if exists public.config_restaurante_errores(jsonb);
drop function if exists public.validar_tarifa_domicilio();
drop function if exists public.proteger_campos_configuracion();

-- La version del SQL 10: lista de columnas prohibidas (el dueno edita nombre y config completos)
create or replace function public.proteger_campos_restaurante()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if public.es_servidor() or (select public.es_superadmin()) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.slug is distinct from old.slug
     or new.estado is distinct from old.estado
     or new.plan is distinct from old.plan
     or new.modalidad_pago is distinct from old.modalidad_pago
     or new.vigente_hasta is distinct from old.vigente_hasta
     or new.dias_gracia is distinct from old.dias_gracia
     or new.modulos is distinct from old.modulos
     or new.zona_horaria is distinct from old.zona_horaria
     or new.hora_corte_jornada is distinct from old.hora_corte_jornada
     or new.creado_en is distinct from old.creado_en then
    raise exception 'Solo se puede cambiar el nombre y la configuracion del restaurante' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke all on function public.proteger_campos_restaurante() from public, anon;
grant execute on function public.proteger_campos_restaurante() to authenticated, service_role;

drop trigger if exists restaurantes_proteger on public.restaurantes;
create trigger restaurantes_proteger
  before update on public.restaurantes
  for each row execute function public.proteger_campos_restaurante();


-- =============================================================
-- >>> PASO 3) TARIFAS: EL DUENO VUELVE A ESCRIBIR (como en el SQL 10)
-- =============================================================
do $do$
declare
  v_paso constant text := '3 politicas de tarifas_domicilio';
  v_item text := '';
begin
  v_item := 'borrar';
  drop policy if exists mr_tarifas_insert on public.tarifas_domicilio;
  drop policy if exists mr_tarifas_update on public.tarifas_domicilio;
  drop policy if exists mr_tarifas_delete on public.tarifas_domicilio;

  v_item := 'crear mr_tarifas_insert';
  create policy mr_tarifas_insert on public.tarifas_domicilio for insert to authenticated
    with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
  v_item := 'crear mr_tarifas_update';
  create policy mr_tarifas_update on public.tarifas_domicilio for update to authenticated
    using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')
    with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
  v_item := 'crear mr_tarifas_delete';
  create policy mr_tarifas_delete on public.tarifas_domicilio for delete to authenticated
    using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 4) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr13r_verif;
create temp table _mr13r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr13r_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('pedidos, categorias, productos, configuracion y salud_notificaciones tienen otra vez el valor por defecto transitorio (y siguen NOT NULL)',
    (select count(*) = 5 and bool_and(a.atthasdef and a.attnotnull
              and pg_get_expr(d.adbin, d.adrelid) like '%restaurante_taqueiros_id%')
     from pg_class c
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
     left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and c.relname in ('pedidos', 'categorias', 'productos', 'configuracion', 'salud_notificaciones')),
    null),

  ('sin trigger de validacion de config, sin trigger de tarifas y sin proteccion de columnas de configuracion',
    not exists (select 1 from pg_trigger t
                where not t.tgisinternal and t.tgname in ('restaurantes_validar_config', 'tarifas_domicilio_validar', 'configuracion_proteger')),
    null),

  ('sin las funciones del SQL 13 (config_restaurante_errores, validar_config_restaurante, validar_tarifa_domicilio, proteger_campos_configuracion)',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and p.proname in ('config_restaurante_errores', 'validar_config_restaurante', 'validar_tarifa_domicilio', 'proteger_campos_configuracion')),
    null),

  ('restaurantes_proteger vuelve a ser el del SQL 10 (lista de columnas prohibidas) y sigue activo',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_proteger'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc like '%vigente_hasta%' and f.prosrc not like '%permitidas%'),
    null),

  ('tarifas_domicilio: el dueno vuelve a poder escribir (politicas del SQL 10)',
    (select count(*) = 3 and bool_and(coalesce(pl.qual, '') || coalesce(pl.with_check, '') like '%rol_en%')
     from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'tarifas_domicilio' and pl.cmd in ('INSERT', 'UPDATE', 'DELETE')),
    null),

  ('restaurante_secretos, contadores_pedido, restaurante_dominios, intentos_buscar_pedido y personal siguen cerradas para clientes',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and c.relname in ('restaurante_secretos', 'contadores_pedido', 'restaurante_dominios', 'intentos_buscar_pedido', 'personal')
                  and (has_table_privilege('anon', c.oid, 'select,insert,update,delete')
                       or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'))),
    null),

  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('Storage: la regla transitoria de la raiz del bucket sigue como estaba',
    exists (select 1 from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'puede_gestionar_fotos'
              and p.prosrc like '%restaurante_taqueiros_id%'),
    null),

  ('ninguna fila cambio (conteos y huellas)',
    not exists (select 1 from _mr13r_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
                      union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
                     ) d on d.tabla = a.tabla
                where d.filas <> a.filas or d.huella <> a.huella),
    null)
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr13r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 13 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr13r_verif
order by orden;
