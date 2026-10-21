-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 14  (vuelve la regla transitoria de la raiz del bucket)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query  ("Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de supabase/14-retirar-regla-bucket.sql, hace falta que el dueno de Taqueiros
--   vuelva a poder escribir en la RAIZ del bucket productos (por ejemplo para deshacer la migracion de
--   fotos con migrar-fotos-raiz.mjs --deshacer=<registro>).
--
-- QUE HACE
--   Devuelve puede_gestionar_fotos() y validar_producto() a las versiones del SQL 10 (con la regla de la
--   raiz para Taqueiros). No mueve archivos ni cambia datos.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO.
-- SI ALGO FALLA: "MR paso <paso>: ..." o "LA REVERSA 14 SE REVIRTIO" con la lista; todo se revierte.
-- =============================================================

begin;

set local lock_timeout = '20s';

-- >>> PASO 0) PRECONDICIONES
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := '';
begin
  v_item := 'funciones y tablas del SQL 10';
  if to_regprocedure('public.puede_gestionar_fotos(text)') is null
     or to_regprocedure('public.validar_producto()') is null
     or to_regprocedure('public.restaurante_taqueiros_id()') is null
     or to_regclass('public.productos') is null then
    raise exception 'Faltan cosas del SQL 10. Corre primero supabase/10-multirestaurante.sql';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr14r_antes;
create temp table _mr14r_antes as
select count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) as huella
from public.productos t;

-- >>> PASO 1) STORAGE: la raiz del bucket vuelve a ser de Taqueiros
create or replace function public.puede_gestionar_fotos(p_ruta text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_ruta !~ '(^|/)\.\.(/|$)'
     and ( (select public.es_superadmin())
        or exists (
             select 1 from public.miembros m
             where m.user_id = (select auth.uid())
               and m.activo
               and m.rol = 'dueno'
               and ( m.restaurante_id::text = (storage.foldername(p_ruta))[1]
                  -- transitorio: la raiz del bucket es de Taqueiros
                  or ( coalesce(array_length(storage.foldername(p_ruta), 1), 0) = 0
                       and m.restaurante_id = public.restaurante_taqueiros_id() ) ) ) );
$$;

revoke all on function public.puede_gestionar_fotos(text) from public, anon;
grant execute on function public.puede_gestionar_fotos(text) to authenticated, service_role;

-- >>> PASO 2) PRODUCTOS: vuelve la ruta plana (solo Taqueiros)
create or replace function public.validar_producto()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  tope_precio   constant integer := 300000;
  prefijo_bucket constant text :=
    'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/';
  resto text;
begin
  new.nombre := btrim(coalesce(new.nombre, ''));

  if new.nombre = '' then
    raise exception 'El nombre del producto es obligatorio';
  end if;
  if char_length(new.nombre) > 60 then
    raise exception 'El nombre del producto no puede pasar de 60 caracteres';
  end if;
  if new.nombre ~ '[[:cntrl:]]' then
    raise exception 'El nombre del producto tiene caracteres no permitidos';
  end if;

  if new.descripcion is not null and char_length(new.descripcion) > 300 then
    raise exception 'La descripción no puede pasar de 300 caracteres';
  end if;

  if new.precio is null or new.precio < 1 or new.precio > tope_precio then
    raise exception 'El precio debe estar entre $1 y $300.000';
  end if;

  -- La categoria tiene que ser de ESTE restaurante
  if not exists (select 1 from public.categorias c
                 where c.restaurante_id = new.restaurante_id and c.id = new.categoria) then
    raise exception 'La categoría elegida no existe';
  end if;

  if tg_op = 'INSERT' and new.id !~ '^[a-z0-9][a-z0-9-]{1,59}$' then
    raise exception 'Identificador de producto inválido';
  end if;

  -- La foto solo se revisa cuando cambia.
  if new.imagen is not null
     and (tg_op = 'INSERT' or new.imagen is distinct from old.imagen) then
    if left(new.imagen, char_length(prefijo_bucket)) = prefijo_bucket then
      resto := substr(new.imagen, char_length(prefijo_bucket) + 1);
      if resto ~ '^[A-Za-z0-9._-]{1,100}$' then
        -- Ruta plana (la estructura antigua): solo el restaurante original
        if new.restaurante_id <> public.restaurante_taqueiros_id() then
          raise exception 'La dirección de la foto no es válida';
        end if;
      elsif resto ~ ('^' || new.restaurante_id::text || '/[A-Za-z0-9._-]{1,100}$') then
        null;   -- carpeta propia: {restaurante_id}/archivo
      else
        raise exception 'La dirección de la foto no es válida';
      end if;
    elsif new.imagen ~ '^Recursos/[A-Za-z0-9 ._/-]{1,200}$' and new.imagen !~ '\.\.' then
      null;   -- foto que ya viene con el sitio
    else
      raise exception 'La foto debe estar guardada en el bucket de productos';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists productos_validar on public.productos;
create trigger productos_validar
  before insert or update on public.productos
  for each row execute function public.validar_producto();



-- >>> PASO 3) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
drop table if exists pg_temp._mr14r_verif;
create temp table _mr14r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr14r_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('puede_gestionar_fotos vuelve a incluir la raiz del bucket para Taqueiros',
    exists (select 1 from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'puede_gestionar_fotos'
              and p.prosrc like '%restaurante_taqueiros_id%' and not p.prosecdef
              and not has_function_privilege('anon', p.oid, 'execute')),
    null),

  ('validar_producto vuelve a aceptar la ruta plana de Taqueiros y su trigger esta activo',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.productos'::regclass and t.tgname = 'productos_validar'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc like '%estructura antigua%'),
    null),

  ('Storage: las 4 politicas mr_ del bucket siguen puestas',
    (select count(*) = 4 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'mr_productos_fotos_%'),
    null),

  ('ninguna fila de productos cambio (conteo y huella)',
    not exists (select 1 from _mr14r_antes a,
                  (select count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) as huella
                   from public.productos t) d
                where d.filas <> a.filas or d.huella <> a.huella),
    null)
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'
  - ' order by orden)
    into malas
  from _mr14r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 14 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:
  - %', malas;
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
from _mr14r_verif
order by orden;
