-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 16b  (deja el horario como despues del SQL 15)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CUANDO USARLO
--   Solo si, despues de correr supabase/16b-horario.sql, algo deja de funcionar (por ejemplo, el panel no deja
--   guardar un horario que antes si guardaba). Antes mira el mensaje de error exacto: casi siempre el problema esta
--   en el dato que se manda, no en la regla.
--
-- QUE HACE
--   Devuelve las dos funciones del SQL 15 EXACTAMENTE como estaban:
--     * public.configuracion_errores(jsonb, text, boolean, boolean)  (sin hora de corte; se borra la de 5 parametros)
--     * public.validar_configuracion()  (el trigger configuracion_validar vuelve a no mirar la hora de corte)
--   Vuelve a aceptarse un cierre igual a la apertura y un cierre de madrugada posterior a la hora de corte
--   (el servidor seguira cortando a la hora de corte, como siempre).
--
-- QUE NO HACE
--   * No cambia ni borra datos. No toca el SQL 15 (guardar_datos_restaurante), el SQL 13 ni el SQL 16.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a aplicarlo: supabase/16b-horario.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 16b SE REVIRTIO" con la lista. Todo se revierte.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := 'public.configuracion';
begin
  if to_regclass('public.configuracion') is null then
    raise exception 'Falta public.configuracion: este archivo solo revierte el SQL 16b';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr16br_antes;
create temp table _mr16br_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t;


-- =============================================================
-- >>> PASO 1) VOLVER A LAS FUNCIONES DEL SQL 15
-- =============================================================
do $do$
declare
  v_paso constant text := '1 quitar las funciones nuevas';
  v_item text := '';
begin
  v_item := 'function configuracion_errores(jsonb, text, boolean, boolean)';
  drop function if exists public.configuracion_errores(jsonb, text, boolean, boolean);
  v_item := 'function configuracion_errores(jsonb, text, boolean, boolean, text)';
  drop function if exists public.configuracion_errores(jsonb, text, boolean, boolean, text);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 1.1 configuracion_errores de 4 parametros, igual que en el SQL 15
create or replace function public.configuracion_errores(p_horarios jsonb, p_mensaje text,
                                                       p_validar_horarios boolean default true,
                                                       p_validar_mensaje boolean default true)
returns text[]
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  e text[] := '{}';
  v_n integer;
  v_i integer;
  v_dia jsonb;
  v_k text;
  v_t text;
  -- Controles, ancho cero y marcas de direccion (bidi). El nombre del dia no admite ninguno; el mensaje admite
  -- el salto de linea (chr(10)) porque lo escribe un cuadro de texto de varias lineas.
  c_invisibles constant text := chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279);
  c_control       constant text := '[\x01-\x1f\x7f-\x9f' || c_invisibles || ']';
  c_control_linea constant text := '[\x01-\x09\x0b-\x1f\x7f-\x9f' || c_invisibles || ']';
  c_hora constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  -- ---- horarios ----
  if not p_validar_horarios then
    null;
  elsif p_horarios is null or jsonb_typeof(p_horarios) <> 'array' then
    e := e || 'horarios: debe ser una lista de 7 dias'::text;
  else
    v_n := jsonb_array_length(p_horarios);
    if v_n <> 7 then
      e := e || ('horarios: debe tener exactamente 7 dias (hay ' || v_n || ')');
    end if;
    for v_i in 0 .. least(v_n, 14) - 1 loop
      v_dia := p_horarios -> v_i;
      if coalesce(jsonb_typeof(v_dia), '') <> 'object' then
        e := e || ('horarios.' || v_i || ': cada dia debe ser un objeto con dia, abre, cierra y activo');
        continue;
      end if;
      for v_k in select jsonb_object_keys(v_dia) loop
        if v_k not in ('dia', 'abre', 'cierra', 'activo') then
          e := e || ('horarios.' || v_i || '.' || v_k || ': clave desconocida');
        end if;
      end loop;

      v_t := case when jsonb_typeof(v_dia -> 'dia') = 'string' then v_dia ->> 'dia' end;
      if v_t is null or char_length(v_t) not between 1 and 20 or v_t ~ '[<>]' or v_t ~ c_control then
        e := e || ('horarios.' || v_i || '.dia: debe ser el nombre del dia (texto de 1 a 20 caracteres, sin < ni > ni caracteres de control)');
      end if;

      v_t := case when jsonb_typeof(v_dia -> 'abre') = 'string' then v_dia ->> 'abre' end;
      if v_t is null or v_t !~ c_hora then
        e := e || ('horarios.' || v_i || '.abre: hora no valida (se espera HH:MM, de 00:00 a 23:59)');
      end if;

      v_t := case when jsonb_typeof(v_dia -> 'cierra') = 'string' then v_dia ->> 'cierra' end;
      if v_t is null or not (v_t ~ c_hora or v_t = '24:00') then
        e := e || ('horarios.' || v_i || '.cierra: hora no valida (se espera HH:MM, de 00:00 a 23:59, o 24:00)');
      end if;

      if coalesce(jsonb_typeof(v_dia -> 'activo'), '') <> 'boolean' then
        e := e || ('horarios.' || v_i || '.activo: debe ser verdadero o falso');
      end if;
    end loop;
  end if;

  -- ---- mensaje_cerrado ----
  if p_validar_mensaje and p_mensaje is not null then
    if char_length(p_mensaje) > 300 then
      e := e || 'mensaje_cerrado: demasiado largo (maximo 300 caracteres)'::text;
    end if;
    if p_mensaje ~ '[<>]' then
      e := e || 'mensaje_cerrado: no se permiten etiquetas HTML (los caracteres < y >)'::text;
    end if;
    if p_mensaje ~ c_control_linea then
      e := e || 'mensaje_cerrado: no se permiten caracteres de control o invisibles (si el salto de linea)'::text;
    end if;
  end if;

  return e;
end;
$fn$;

revoke all on function public.configuracion_errores(jsonb, text, boolean, boolean) from public, anon;
grant execute on function public.configuracion_errores(jsonb, text, boolean, boolean) to authenticated, service_role;

-- >>> PASO 1.2 validar_configuracion, igual que en el SQL 15
create or replace function public.validar_configuracion()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_err text[];
  v_horarios boolean := true;
  v_mensaje boolean := true;
begin
  -- En UPDATE solo se revisa lo que cambio: cambiar el mensaje no se frena por un horario viejo (ni al reves)
  if tg_op = 'UPDATE' then
    v_horarios := new.horarios is distinct from old.horarios;
    v_mensaje := new.mensaje_cerrado is distinct from old.mensaje_cerrado;
    if not v_horarios and not v_mensaje then
      return new;
    end if;
  end if;

  v_err := public.configuracion_errores(new.horarios, new.mensaje_cerrado, v_horarios, v_mensaje);
  if cardinality(v_err) > 0 then
    raise exception 'Horario o mensaje de cerrado no validos: %',
      array_to_string(v_err[1:6], '; ')
      || case when cardinality(v_err) > 6 then format(' (y %s problemas mas)', cardinality(v_err) - 6) else '' end
      using errcode = '23514', hint = 'Las reglas estan en docs/multirestaurante.md, seccion 17';
  end if;
  return new;
end;
$fn$;

revoke all on function public.validar_configuracion() from public, anon;
grant execute on function public.validar_configuracion() to authenticated, service_role;


-- =============================================================
-- >>> PASO 2) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr16br_verif;
create temp table _mr16br_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr16br_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('configuracion_errores de 5 parametros ya no existe y la de 4 parametros si',
    to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean,text)') is null
      and to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean)') is not null,
    null),

  ('las funciones son las del SQL 15: la de 4 parametros es plpgsql y no menciona la hora de corte; el trigger no la usa',
    (select p.prolang = (select oid from pg_language where lanname = 'plpgsql') and p.prosrc not like '%p_hora_corte%'
     from pg_proc p where p.oid = 'public.configuracion_errores(jsonb,text,boolean,boolean)'::regprocedure)
    and (select p.prosrc not like '%hora_corte_jornada%' from pg_proc p where p.oid = 'public.validar_configuracion()'::regprocedure),
    null),

  ('el trigger configuracion_validar sigue activo',
    exists (select 1 from pg_trigger t
            where t.tgrelid = 'public.configuracion'::regclass and t.tgname = 'configuracion_validar'
              and not t.tgisinternal and t.tgenabled <> 'D'),
    null),

  ('el horario actual de Taqueiros cumple las reglas del SQL 15',
    (select cardinality(public.configuracion_errores(c.horarios, c.mensaje_cerrado)) = 0
     from public.configuracion c where c.restaurante_id = public.restaurante_taqueiros_id()),
    null),

  ('anon no ejecuta las funciones del horario; authenticated y service_role si',
    (select count(*) = 2 and bool_and(not has_function_privilege('anon', p.oid, 'execute')
                                     and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('configuracion_errores', 'validar_configuracion')),
    null),

  ('el SQL 15 sigue en pie: guardar_datos_restaurante existe',
    to_regprocedure('public.guardar_datos_restaurante(uuid,jsonb)') is not null,
    null),

  ('ninguna fila cambio (conteos y huellas)',
    not exists (select 1 from _mr16br_antes a
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
  from _mr16br_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 16b SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
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
from _mr16br_verif
order by orden;
