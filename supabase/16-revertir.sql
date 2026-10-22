-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 16  (deja la base como despues del SQL 13/15)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de correr supabase/16-superadmin.sql, algo deja de funcionar. Antes de usarlo, mira el mensaje
--   de error exacto. Despues de revertir, api/superadmin.js deja de funcionar (todas sus acciones responden error) y
--   el panel del dueno deja de mostrar el aviso de la suscripcion (no se rompe: simplemente no hay aviso).
--
-- QUE HACE
--   1. Borra las funciones de superadmin (public.sa_*), las ayudas internas (exigir_superadmin, auditar_superadmin)
--      y las de vigencia (calcular_vigencia, vigencia_restaurante).
--   2. La TABLA DE AUDITORIA (public.auditoria_superadmin) es la constancia de lo que hizo cada superadmin y esta
--      hecha para no poder borrarse con el cliente: por eso
--        * si NO tiene ninguna fila (no se uso), se borra junto con su trigger;
--        * si TIENE filas, se CONSERVA tal cual (con sus triggers de solo-agregar) y el resultado lo dice. Para
--          borrarla a proposito, a mano y sabiendo que se pierde esa constancia:
--            drop table public.auditoria_superadmin;  drop function public.auditoria_solo_agregar();
--
-- QUE NO HACE
--   * No cambia ni borra datos de negocio (restaurantes, secretos, miembros, superadmins, pedidos...), ni el
--     SQL 13/15/16b, ni permisos de tablas, politicas o Storage. Los restaurantes creados con sa_crear_restaurante
--     siguen existiendo; los superadmins dados de alta con crear-superadmin.mjs siguen en public.superadmins.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a aplicarlo: supabase/16-superadmin.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 16 SE REVIRTIO" con la lista. Todo se revierte.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := 'public.restaurantes';
begin
  if to_regclass('public.restaurantes') is null then
    raise exception 'Falta public.restaurantes: este archivo solo revierte el SQL 16';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr16r_antes;
create temp table _mr16r_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;


-- =============================================================
-- >>> PASO 1) BORRAR LAS FUNCIONES
-- =============================================================
do $do$
declare
  v_paso constant text := '1 borrar las funciones de superadmin y de vigencia';
  v_item text := '';
  p record;
begin
  for p in
    select pr.proname, pg_get_function_identity_arguments(pr.oid) as args
    from pg_proc pr
    where pr.pronamespace = 'public'::regnamespace
      and (pr.proname like 'sa\_%' escape '\'
           or pr.proname in ('exigir_superadmin', 'auditar_superadmin', 'calcular_vigencia', 'vigencia_restaurante'))
  loop
    v_item := p.proname || '(' || p.args || ')';
    execute format('drop function public.%I(%s)', p.proname, p.args);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) LA TABLA DE AUDITORIA: se borra solo si esta vacia
-- =============================================================
drop table if exists pg_temp._mr16r_auditoria;
create temp table _mr16r_auditoria (k text primary key, v text);

do $do$
declare
  v_paso constant text := '2 tabla de auditoria';
  v_item text := 'public.auditoria_superadmin';
  v_n bigint;
begin
  if to_regclass('public.auditoria_superadmin') is null then
    insert into _mr16r_auditoria values ('estado', 'no existia');
  else
    select count(*) into v_n from public.auditoria_superadmin;
    if v_n = 0 then
      drop table public.auditoria_superadmin;
      drop function if exists public.auditoria_solo_agregar();
      insert into _mr16r_auditoria values ('estado', 'borrada (estaba vacia)');
    else
      insert into _mr16r_auditoria values ('estado', 'CONSERVADA con ' || v_n || ' filas');
    end if;
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 3) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr16r_verif;
create temp table _mr16r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr16r_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('ya no existe ninguna funcion sa_*, exigir_superadmin, auditar_superadmin, calcular_vigencia ni vigencia_restaurante',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                and (p.proname like 'sa\_%' escape '\' or p.proname in ('exigir_superadmin', 'auditar_superadmin', 'calcular_vigencia', 'vigencia_restaurante'))),
    null),

  ('la tabla de auditoria o ya no existe (estaba vacia) o sigue con sus triggers de solo-agregar y sin privilegios para clientes',
    (to_regclass('public.auditoria_superadmin') is null and to_regprocedure('public.auditoria_solo_agregar()') is null)
      or (to_regclass('public.auditoria_superadmin') is not null
          and (select count(*) = 3 from pg_trigger t where t.tgrelid = 'public.auditoria_superadmin'::regclass and not t.tgisinternal and t.tgenabled <> 'D')
          and not has_table_privilege('service_role', 'public.auditoria_superadmin', 'select,insert,update,delete,truncate')
          and not has_table_privilege('authenticated', 'public.auditoria_superadmin', 'select,insert,update,delete,truncate')),
    (select v from _mr16r_auditoria where k = 'estado')),

  ('el SQL 13 sigue en pie: config_restaurante_errores y el trigger restaurantes_validar_config',
    to_regprocedure('public.config_restaurante_errores(jsonb)') is not null
      and exists (select 1 from pg_trigger t where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_validar_config' and not t.tgisinternal and t.tgenabled <> 'D'),
    null),

  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('RLS activo en TODAS las tablas de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
    null),

  ('ninguna fila de negocio cambio (conteos y huellas)',
    not exists (select 1 from _mr16r_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
                      union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
                      union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
                      union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t
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
  from _mr16r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 16 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
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
from _mr16r_verif
order by orden;
