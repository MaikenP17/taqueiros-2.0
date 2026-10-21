-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 15  (deja la base como despues del SQL 13/14)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de correr supabase/15-datos-restaurante.sql, algo deja de funcionar en produccion (por
--   ejemplo, el panel no puede guardar un horario que antes si guardaba). Antes de usarlo, mira el mensaje
--   de error exacto: casi siempre el problema esta en el dato que se manda, no en la regla.
--
-- QUE HACE
--   1. Quita el trigger configuracion_validar (la validacion del horario y del mensaje de cerrado) y sus
--      funciones validar_configuracion() y configuracion_errores().
--   2. Quita la funcion guardar_datos_restaurante(uuid, jsonb) (el formulario "Datos de mi restaurante" del
--      panel mostrara que falta; el dueno sigue pudiendo editar su nombre, textos y contacto con el SQL 13).
--
-- QUE NO HACE
--   * No cambia ni borra datos. No toca el SQL 13 (config_restaurante_errores, proteger_campos_restaurante...)
--     ni permisos, politicas, Storage o tablas.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a aplicarlo: supabase/15-datos-restaurante.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 15 SE REVIRTIO" con la lista. Todo se revierte.
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
  v_item := 'public.configuracion';
  if to_regclass('public.configuracion') is null then
    raise exception 'Falta public.configuracion: este archivo solo revierte el SQL 15';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr15r_antes;
create temp table _mr15r_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t;


-- =============================================================
-- >>> PASO 1) QUITAR LA VALIDACION DEL HORARIO
-- =============================================================
do $do$
declare
  v_paso constant text := '1 quitar la validacion del horario y del mensaje de cerrado';
  v_item text := '';
begin
  v_item := 'trigger configuracion_validar';
  drop trigger if exists configuracion_validar on public.configuracion;
  v_item := 'function validar_configuracion()';
  drop function if exists public.validar_configuracion();
  v_item := 'function configuracion_errores(jsonb, text, boolean, boolean)';
  drop function if exists public.configuracion_errores(jsonb, text, boolean, boolean);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) QUITAR LA FUNCION DEL FORMULARIO
-- =============================================================
do $do$
declare
  v_paso constant text := '2 quitar guardar_datos_restaurante';
  v_item text := 'function guardar_datos_restaurante(uuid, jsonb)';
begin
  drop function if exists public.guardar_datos_restaurante(uuid, jsonb);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 3) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr15r_verif;
create temp table _mr15r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr15r_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('el trigger configuracion_validar ya no existe',
    not exists (select 1 from pg_trigger t where t.tgrelid = 'public.configuracion'::regclass and t.tgname = 'configuracion_validar'),
    null),

  ('las funciones configuracion_errores, validar_configuracion y guardar_datos_restaurante ya no existen',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                and p.proname in ('configuracion_errores', 'validar_configuracion', 'guardar_datos_restaurante')),
    null),

  ('el SQL 13 sigue en pie: config_restaurante_errores y el trigger restaurantes_validar_config',
    to_regprocedure('public.config_restaurante_errores(jsonb)') is not null
      and exists (select 1 from pg_trigger t where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_validar_config' and not t.tgisinternal and t.tgenabled <> 'D'),
    null),

  ('el SQL 13 sigue en pie: el dueno solo cambia nombre y config.publico.textos / contacto',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_proteger'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc like '%publico,textos%' and f.prosrc like '%permitidas%'),
    null),

  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('ninguna fila cambio (conteos y huellas)',
    not exists (select 1 from _mr15r_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
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
  from _mr15r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 15 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
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
from _mr15r_verif
order by orden;
