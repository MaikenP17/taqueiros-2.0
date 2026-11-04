-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 19  (deja la base como despues del SQL 16)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de correr supabase/19-superadmin-lectura.sql, algo deja de funcionar. Despues de revertir,
--   las acciones ver_pedidos, ver_menu, ver_config y ver_resumen de api/superadmin.js responden un aviso claro
--   ("falta el SQL 19") y los rechazos por falta de MFA ya no dejan constancia en la auditoria (lo demas sigue igual:
--   la MFA se sigue exigiendo, porque eso vive en el servidor y no en la base).
--
-- QUE HACE
--   Borra las 5 funciones sa_ver_pedidos, sa_ver_menu, sa_ver_config, sa_ver_resumen y sa_registrar_rechazo_mfa y la
--   ayuda interna auditar_lectura_superadmin.
--
-- QUE NO HACE
--   * No toca la tabla de auditoria ni sus filas (las constancias de lecturas y rechazos que ya existan se quedan: es de
--     solo agregar a proposito). No toca ningun dato de negocio, ni las 15 funciones del SQL 16.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a aplicarlo: supabase/19-superadmin-lectura.sql.
-- Si tambien vas a revertir el SQL 16, revierte primero ESTE (el 16-revertir.sql tambien borraria estas funciones, pero asi
-- queda claro que se quito cada cosa).
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 19 SE REVIRTIO" con la lista. Todo se revierte.
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
    raise exception 'Falta public.restaurantes: este archivo solo revierte el SQL 19';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr19r_antes;
create temp table _mr19r_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;

-- La tabla de auditoria se cuenta aparte (puede no existir si el 16 nunca se aplico): debe quedar igual.
drop table if exists pg_temp._mr19r_aud;
create temp table _mr19r_aud (momento text primary key, filas bigint, triggers bigint);
do $do$
begin
  -- (dentro de un IF: si la tabla no existe, esta sentencia ni se planifica)
  if to_regclass('public.auditoria_superadmin') is not null then
    insert into _mr19r_aud
    select 'antes', (select count(*) from public.auditoria_superadmin),
           (select count(*) from pg_trigger t where t.tgrelid = 'public.auditoria_superadmin'::regclass and not t.tgisinternal and t.tgenabled <> 'D');
  end if;
end
$do$;


-- =============================================================
-- >>> PASO 1) BORRAR LAS FUNCIONES
-- =============================================================
do $do$
declare
  v_paso constant text := '1 borrar las funciones del SQL 19';
  v_item text := '';
  p record;
begin
  for p in
    select pr.proname, pg_get_function_identity_arguments(pr.oid) as args
    from pg_proc pr
    where pr.pronamespace = 'public'::regnamespace
      and pr.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa', 'auditar_lectura_superadmin')
  loop
    v_item := p.proname || '(' || p.args || ')';
    execute format('drop function public.%I(%s)', p.proname, p.args);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


do $do$
begin
  if to_regclass('public.auditoria_superadmin') is not null then
    insert into _mr19r_aud
    select 'despues', (select count(*) from public.auditoria_superadmin),
           (select count(*) from pg_trigger t where t.tgrelid = 'public.auditoria_superadmin'::regclass and not t.tgisinternal and t.tgenabled <> 'D');
  end if;
end
$do$;


-- =============================================================
-- >>> PASO 2) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr19r_verif;
create temp table _mr19r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr19r_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('ya no existe ninguna de las 5 funciones del SQL 19 ni su ayuda interna',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa', 'auditar_lectura_superadmin')),
    null),

  ('las funciones del SQL 16 siguen en pie (si el 16 estaba aplicado, siguen sus 15 funciones sa_* y las dos ayudas)',
    to_regprocedure('public.exigir_superadmin(uuid)') is null
      or ((select count(*) = 15 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'sa\_%' escape '\'
             and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno'))
          and to_regprocedure('public.auditar_superadmin(uuid,text,uuid,jsonb)') is not null),
    null),

  ('la auditoria no cambio: mismas filas y mismos triggers de solo agregar (si existe)',
    not exists (select 1 from _mr19r_aud a where a.momento = 'antes')
      or (exists (select 1 from _mr19r_aud a where a.momento = 'despues')
          and (select a.filas from _mr19r_aud a where a.momento = 'antes') = (select a.filas from _mr19r_aud a where a.momento = 'despues')
          and (select a.triggers from _mr19r_aud a where a.momento = 'antes') = (select a.triggers from _mr19r_aud a where a.momento = 'despues')),
    null),

  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('ninguna fila de negocio cambio (conteos y huellas)',
    not exists (select 1 from _mr19r_antes a
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
  from _mr19r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 19 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK (esperadas: 5).
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr19r_verif
order by orden;
