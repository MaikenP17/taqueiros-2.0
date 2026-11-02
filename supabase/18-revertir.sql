-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 18  (deja la base como antes de las opciones de producto)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de correr supabase/18-opciones-producto.sql, algo deja de funcionar en produccion y no se arregla
--   corrigiendo el dato. Antes de usarlo, mira el mensaje de error exacto.
--
-- QUE HACE
--   1. Borra la tabla public.producto_opciones (con sus politicas, triggers, indices y restricciones) y las dos funciones
--      que creo el SQL 18: opcion_nombre_valido(text) y validar_producto_opcion().
--
-- QUE NO HACE
--   * NO toca pedidos: cada pedido guarda su propia COPIA de las opciones que se eligieron (nombre y precio de ese momento),
--     asi que los pedidos viejos se siguen leyendo, imprimiendo y sumando exactamente igual.
--   * NO toca productos, categorias, restaurantes, miembros, configuracion, Storage ni Realtime.
--
-- LO UNICO QUE SE PIERDE: las opciones que estaban cargadas en la tabla (las 57 de la semilla y las que el dueno haya
--   agregado o cambiado). La ultima fila del resultado dice cuantas eran. Si quieres conservarlas, antes corre en el
--   SQL Editor:   select * from public.producto_opciones order by restaurante_id, producto_id, orden;   y guarda el resultado.
--   Volver a aplicar supabase/18-opciones-producto.sql vuelve a sembrar las del demo.
--
-- EL SERVIDOR NO SE ROMPE: sin la tabla, el menu publico sigue igual (sin opciones), un pedido sin opciones funciona igual
--   y uno con opciones responde un error claro. Si ya desplegaste una pantalla que ofrece opciones, no las veras hasta
--   volver a aplicar el SQL 18.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a aplicarlo: supabase/18-opciones-producto.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 18 SE REVIRTIO" con la lista. Todo se revierte.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES Y FOTO DEL "ANTES"
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := '';
begin
  v_item := 'public.productos';
  if to_regclass('public.productos') is null or to_regclass('public.pedidos') is null then
    raise exception 'Faltan public.productos o public.pedidos: este archivo solo revierte el SQL 18';
  end if;

  -- Si algo mas dependiera de la tabla (una vista, una funcion escrita a mano...), no se borra a ciegas.
  v_item := 'dependencias';
  -- (to_regclass y no un cast ::regclass: el cast falla al planear la consulta cuando la tabla ya no existe, y esta reversa debe poder repetirse)
  if to_regclass('public.producto_opciones') is not null and exists (
       select 1 from pg_depend d join pg_rewrite rw on rw.oid = d.objid
       where d.refobjid = to_regclass('public.producto_opciones') and d.classid = 'pg_rewrite'::regclass and d.deptype = 'n') then
    raise exception 'Hay una vista que depende de public.producto_opciones. Bórrala antes de revertir. No se cambió nada.';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr18r_antes;
create temp table _mr18r_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t;

drop table if exists pg_temp._mr18r_info;
create temp table _mr18r_info (k text primary key, v bigint not null);
do $do$
begin
  if to_regclass('public.producto_opciones') is not null then
    execute 'insert into _mr18r_info select ''filas'', count(*) from public.producto_opciones';
  else
    insert into _mr18r_info values ('filas', 0);
  end if;
end
$do$;

drop table if exists pg_temp._mr18r_pub;
create temp table _mr18r_pub as
select coalesce(string_agg(pt.schemaname || '.' || pt.tablename, ',' order by pt.schemaname, pt.tablename), '') as tablas
from pg_publication_tables pt where pt.pubname = 'supabase_realtime';


-- =============================================================
-- >>> PASO 1) BORRAR LA TABLA Y SUS FUNCIONES
-- =============================================================
-- Al borrar la tabla se van sus politicas, triggers, indices y restricciones. Las funciones se borran despues (la tabla las usaba).
do $do$
declare
  v_paso constant text := '1 borrar producto_opciones y sus funciones';
  v_item text := '';
begin
  v_item := 'tabla public.producto_opciones';
  drop table if exists public.producto_opciones;
  v_item := 'function validar_producto_opcion()';
  drop function if exists public.validar_producto_opcion();
  v_item := 'function opcion_nombre_valido(text)';
  drop function if exists public.opcion_nombre_valido(text);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr18r_verif;
create temp table _mr18r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr18r_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('la tabla producto_opciones ya no existe',
    to_regclass('public.producto_opciones') is null,
    null),

  ('las funciones opcion_nombre_valido y validar_producto_opcion ya no existen',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('opcion_nombre_valido', 'validar_producto_opcion')),
    null),

  ('no queda ninguna politica, trigger ni restriccion con el nombre producto_opciones_* ni mr_opciones_*',
    not exists (select 1 from pg_policies where schemaname = 'public' and policyname like 'mr\_opciones\_%')
      and not exists (select 1 from pg_trigger t where not t.tgisinternal and t.tgname like 'producto\_opciones\_%')
      and not exists (select 1 from pg_constraint c where c.conname like 'producto\_opciones\_%'),
    null),

  ('el trigger de restaurante inmutable de productos y categorias sigue en pie (la funcion compartida no se borro)',
    to_regprocedure('public.bloquear_cambio_restaurante()') is not null
      and exists (select 1 from pg_trigger t where t.tgrelid = 'public.productos'::regclass and t.tgname = 'productos_restaurante_inmutable' and not t.tgisinternal and t.tgenabled <> 'D')
      and exists (select 1 from pg_trigger t where t.tgrelid = 'public.categorias'::regclass and t.tgname = 'categorias_restaurante_inmutable' and not t.tgisinternal and t.tgenabled <> 'D'),
    null),

  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('la publicacion de Realtime quedo igual',
    (select coalesce(string_agg(pt.schemaname || '.' || pt.tablename, ',' order by pt.schemaname, pt.tablename), '') from pg_publication_tables pt where pt.pubname = 'supabase_realtime')
      = (select p.tablas from _mr18r_pub p),
    null),

  ('ninguna fila de pedidos, productos, categorias, restaurantes ni miembros cambio (conteos y huellas)',
    not exists (select 1 from _mr18r_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
                      union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
                     ) d on d.tabla = a.tabla
                where d.filas <> a.filas or d.huella <> a.huella),
    null),

  ('informativo: filas de opciones que tenia la tabla y se perdieron',
    true,
    (select i.v::text || ' filas' from _mr18r_info i where i.k = 'filas'))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr18r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 18 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
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
from _mr18r_verif
order by orden;
