-- =============================================================
-- TAQUEIROS 2.0 — HORARIO CON 24:00 Y MEDIANOCHE  (SQL 16b)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo no crea tablas)
--
-- ANTES DE CORRERLO
--   * El SQL 15 ya debe estar aplicado (este archivo reemplaza dos de sus funciones).
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs
--
-- QUE HACE  (pendiente R7 de la revision de Opus, docs/multirestaurante.md seccion 19.7)
--   Fija UNA regla para las horas de abrir y cerrar y la aplica en la base. Es la misma que aplican el panel
--   (horario-regla.js), la pagina publica y el servidor (api/_horario.js):
--     1. "abre" es HH:MM de 00:00 a 23:59.        2. "cierra" es HH:MM de 00:00 a 23:59, o 24:00.
--     3. 24:00 = cierra a la MEDIANOCHE de ese mismo dia. 00:00 a 24:00 = abierto todo el dia.
--     4. Si cierra < abre (ej. 18:00 a 02:00) el horario CRUZA la medianoche: la madrugada cuenta para la jornada
--        del dia anterior y llega hasta la hora de cierre, pero NUNCA mas alla de la hora de corte de la jornada
--        (configuracion.hora_corte_jornada, 05:00 por defecto): el servidor ya cortaba ahi, ahora la base lo exige para
--        que nadie crea que cierra a las 06:00 y cierre a las 05:00.
--     5. cierra = abre en un dia activo NO vale (no se sabe si es cerrado o 24 horas): para 24 horas, 00:00 a 24:00.
--     6. Un dia desmarcado (activo false) esta cerrado; sus horas no se revisan.
--   La base (SQL 15) ya aceptaba 24:00 y los horarios que cruzan la medianoche; lo NUEVO es 5 y la parte final de 4.
--   Tambien se revisa el horario cuando cambia la hora de corte (no solo cuando cambia el horario).
--
--   Cambia dos funciones de la SQL 15 y nada mas:
--     * public.configuracion_errores(jsonb, text, boolean, boolean, text)   <- nueva, con la hora de corte
--       (la de 4 parametros sigue existiendo: llama a la nueva con 05:00)
--     * public.validar_configuracion()  <- el trigger configuracion_validar le pasa la hora de corte de la fila
--
-- QUE NO HACE
--   * No cambia datos (comprueba que ninguna fila cambio). No cambia permisos de tablas, politicas ni Storage.
--   * ANTES de activarse comprueba que el horario ACTUAL de Taqueiros cumple la regla nueva y, si no, SE DETIENE
--     sin cambiar nada diciendo que dia corregir (0 = Domingo ... 6 = Sabado). Los demas restaurantes solo se informan.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para deshacerlo: supabase/16b-revertir.sql.
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 16b SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA.
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
  v_item := 'SQL 15 (configuracion_errores de 4 parametros)';
  if to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean)') is null
     or to_regprocedure('public.validar_configuracion()') is null then
    raise exception 'Falta el SQL 15. Corre primero supabase/15-datos-restaurante.sql';
  end if;

  v_item := 'trigger configuracion_validar';
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.configuracion'::regclass
                 and t.tgname = 'configuracion_validar' and not t.tgisinternal) then
    raise exception 'Falta el trigger configuracion_validar del SQL 15. Corre primero supabase/15-datos-restaurante.sql';
  end if;

  v_item := 'restaurante Taqueiros';
  if not exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) then
    raise exception 'No existe el restaurante Taqueiros (id fijo del SQL 10)';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- Lo que NO debe cambiar: la comprobacion final compara contra esto.
drop table if exists pg_temp._mr16b_antes;
create temp table _mr16b_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;


-- =============================================================
-- >>> PASO 1) LA REGLA DEL HORARIO EN LA BASE
-- =============================================================

-- >>> PASO 1.1 la funcion de reglas con la hora de corte (pura). Devuelve la lista de problemas (vacia = valido).
create or replace function public.configuracion_errores(p_horarios jsonb, p_mensaje text,
                                                       p_validar_horarios boolean,
                                                       p_validar_mensaje boolean,
                                                       p_hora_corte text)
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
  v_corte integer;
  v_abre integer;
  v_cierra integer;
begin
  -- Hora de corte de la jornada (HH:MM o HH:MM:SS); un valor que no sea una hora cae en las 05:00 de siempre.
  v_t := left(coalesce(p_hora_corte, ''), 5);
  if v_t !~ c_hora then v_t := '05:00'; end if;
  v_corte := substr(v_t, 1, 2)::integer * 60 + substr(v_t, 4, 2)::integer;

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

      -- Regla 16b (solo en un dia activo con horas bien escritas): cierre igual a la apertura no vale, y un horario
      -- que cruza la medianoche no puede cerrar despues de la hora de corte de la jornada.
      if v_dia -> 'activo' = 'true'::jsonb
         and jsonb_typeof(v_dia -> 'abre') = 'string' and (v_dia ->> 'abre') ~ c_hora
         and jsonb_typeof(v_dia -> 'cierra') = 'string' and ((v_dia ->> 'cierra') ~ c_hora or (v_dia ->> 'cierra') = '24:00') then
        v_abre := substr(v_dia ->> 'abre', 1, 2)::integer * 60 + substr(v_dia ->> 'abre', 4, 2)::integer;
        v_cierra := substr(v_dia ->> 'cierra', 1, 2)::integer * 60 + substr(v_dia ->> 'cierra', 4, 2)::integer;
        if v_cierra = v_abre then
          e := e || ('horarios.' || v_i || ': la hora de cierre no puede ser igual a la de apertura (para abrir todo el dia usa 00:00 a 24:00)');
        elsif v_cierra < v_abre and v_cierra > v_corte then
          e := e || ('horarios.' || v_i || '.cierra: si cierras despues de la medianoche, la hora de cierre no puede pasar de las ' || lpad((v_corte / 60)::text, 2, '0') || ':' || lpad((v_corte % 60)::text, 2, '0') || ' (hora de corte de la jornada); para cerrar a la medianoche usa 24:00');
        end if;
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

revoke all on function public.configuracion_errores(jsonb, text, boolean, boolean, text) from public, anon;
grant execute on function public.configuracion_errores(jsonb, text, boolean, boolean, text) to authenticated, service_role;

-- >>> PASO 1.2 la de 4 parametros (SQL 15) sigue existiendo y usa la hora de corte por defecto (05:00)
create or replace function public.configuracion_errores(p_horarios jsonb, p_mensaje text,
                                                       p_validar_horarios boolean default true,
                                                       p_validar_mensaje boolean default true)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select public.configuracion_errores(p_horarios, p_mensaje, p_validar_horarios, p_validar_mensaje, '05:00');
$fn$;

revoke all on function public.configuracion_errores(jsonb, text, boolean, boolean) from public, anon;
grant execute on function public.configuracion_errores(jsonb, text, boolean, boolean) to authenticated, service_role;

-- >>> PASO 1.3 el horario ACTUAL de Taqueiros tiene que cumplir la regla (si no, no se activa nada)
-- Taqueiros: bloquea. Los demas restaurantes: solo se informan (se validan cuando cambien su horario).
do $do$
declare
  v_paso constant text := '1.3 el horario actual de Taqueiros cumple la regla nueva';
  v_item text := 'configuracion de Taqueiros';
  v_err text[];
begin
  select public.configuracion_errores(c.horarios, c.mensaje_cerrado, true, true, left(c.hora_corte_jornada::text, 5)) into v_err
  from public.configuracion c where c.restaurante_id = public.restaurante_taqueiros_id();

  if v_err is null then
    raise exception 'Taqueiros no tiene fila en public.configuracion: no se puede comprobar su horario';
  end if;
  if cardinality(v_err) > 0 then
    raise exception E'El horario ACTUAL de Taqueiros no cumple la regla nueva del horario y por eso no se activo nada. Corrigelo en el panel (Horarios) o en Table editor -> configuracion -> la fila de Taqueiros (los dias van de horarios.0 = Domingo a horarios.6 = Sabado):\n  - %',
      array_to_string(v_err, E'\n  - ');
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 1.4 el trigger: le pasa la hora de corte de la fila y tambien revisa el horario si cambia la hora de corte
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
    -- (16b) tambien se revisa el horario si cambia la hora de corte: un cierre de madrugada puede quedar pasado de ella
    v_horarios := new.horarios is distinct from old.horarios or new.hora_corte_jornada is distinct from old.hora_corte_jornada;
    v_mensaje := new.mensaje_cerrado is distinct from old.mensaje_cerrado;
    if not v_horarios and not v_mensaje then
      return new;
    end if;
  end if;

  v_err := public.configuracion_errores(new.horarios, new.mensaje_cerrado, v_horarios, v_mensaje, left(new.hora_corte_jornada::text, 5));
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
-- (el trigger configuracion_validar ya existe y sigue apuntando a esta funcion)


-- =============================================================
-- >>> PASO 2) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================

-- >>> PASO 2.1 pruebas del trigger sobre una copia temporal de la tabla (no toca la tabla real ni su trigger)
drop table if exists pg_temp._mr16b_trigger;
create temp table _mr16b_trigger (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '2.1 pruebas del trigger con la hora de corte';
  v_item text := '';
  v_cod text;
  v_dia constant text := '{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}';
  v_base constant jsonb := ('[' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ']')::jsonb;
  v_cruza_5 constant jsonb := ('[{"dia":"D","abre":"18:00","cierra":"05:00","activo":true},' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ']')::jsonb;
  v_cruza_6 constant jsonb := ('[{"dia":"D","abre":"18:00","cierra":"06:00","activo":true},' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ',' || v_dia || ']')::jsonb;
  v_res jsonb := '{}'::jsonb;
  v_rid uuid := public.restaurante_taqueiros_id();
begin
  v_item := 'copia temporal de configuracion';
  create temp table _mr16b_cfg (like public.configuracion including defaults);
  insert into _mr16b_cfg (restaurante_id, id, horarios) values (v_rid, 0, v_base);
  create trigger _mr16b_validar before insert or update on _mr16b_cfg for each row execute function public.validar_configuracion();

  -- cruzar la medianoche hasta la hora de corte (05:00) vale; un minuto mas, no
  v_item := 'cierre de madrugada igual a la hora de corte';
  v_cod := '';
  begin update _mr16b_cfg set horarios = v_cruza_5; exception when others then v_cod := sqlstate || ' ' || left(sqlerrm, 100); end;
  v_res := v_res || jsonb_build_object('madrugada_hasta_el_corte', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

  v_item := 'cierre de madrugada pasada la hora de corte';
  v_cod := '';
  begin update _mr16b_cfg set horarios = v_base; update _mr16b_cfg set horarios = v_cruza_6; v_cod := 'acepto 06:00 con corte 05:00';
  exception when others then if sqlstate <> '23514' then v_cod := sqlstate; end if; end;
  v_res := v_res || jsonb_build_object('madrugada_pasada_del_corte', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

  -- con otra hora de corte (07:00) ese mismo cierre vale
  v_item := 'misma madrugada con corte 07:00';
  v_cod := '';
  begin update _mr16b_cfg set horarios = v_base, hora_corte_jornada = '07:00'; update _mr16b_cfg set horarios = v_cruza_6; exception when others then v_cod := sqlstate || ' ' || left(sqlerrm, 100); end;
  v_res := v_res || jsonb_build_object('madrugada_con_otro_corte', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

  -- bajar la hora de corte por debajo de un cierre de madrugada existente tambien se rechaza
  v_item := 'bajar la hora de corte';
  v_cod := '';
  begin update _mr16b_cfg set hora_corte_jornada = '04:00'; v_cod := 'acepto bajar el corte a 04:00 con un cierre a las 06:00';
  exception when others then if sqlstate <> '23514' then v_cod := sqlstate; end if; end;
  v_res := v_res || jsonb_build_object('bajar_el_corte', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

  -- cerrar el local (cerrado_temporal) no revisa el horario aunque el guardado sea viejo
  v_item := 'cerrar sin validar';
  v_cod := '';
  begin update _mr16b_cfg set cerrado_temporal = true; exception when others then v_cod := sqlstate || ' ' || left(sqlerrm, 100); end;
  v_res := v_res || jsonb_build_object('cerrar_sin_validar', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

  insert into _mr16b_trigger select e.key, (e.value ->> 'ok')::boolean, left(e.value ->> 'detalle', 300) from jsonb_each(v_res) e;
  drop table _mr16b_cfg;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 2.2 la tabla de comprobaciones
drop table if exists pg_temp._mr16b_verif;
create temp table _mr16b_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr16b_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('el horario actual de Taqueiros cumple la regla nueva',
    (select cardinality(public.configuracion_errores(c.horarios, c.mensaje_cerrado, true, true, left(c.hora_corte_jornada::text, 5))) = 0
     from public.configuracion c where c.restaurante_id = public.restaurante_taqueiros_id()),
    null),

  ('las dos versiones de configuracion_errores existen y la de 4 parametros equivale a la nueva con corte 05:00',
    to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean,text)') is not null
      and to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean)') is not null
      and public.configuracion_errores('[{"dia":"D","abre":"18:00","cierra":"06:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null)
        = public.configuracion_errores('[{"dia":"D","abre":"18:00","cierra":"06:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null, true, true, '05:00'),
    null),

  ('acepta 11:00-22:00, 00:00-24:00 (todo el dia), 11:00-24:00, 18:00-02:00, 18:00-05:00 (hasta el corte), 18:00-00:00 y un dia cerrado con horas iguales',
    (select count(*) = 7 and bool_and(cardinality(public.configuracion_errores(
        ('[{"dia":"D","abre":"' || h.abre || '","cierra":"' || h.cierra || '","activo":' || h.activo || '},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]')::jsonb,
        null, true, true, '05:00')) = 0)
     from (values ('11:00','22:00','true'), ('00:00','24:00','true'), ('11:00','24:00','true'), ('18:00','02:00','true'),
                  ('18:00','05:00','true'), ('18:00','00:00','true'), ('11:00','11:00','false')) as h(abre, cierra, activo)),
    null),

  ('rechaza cierre igual a la apertura en un dia activo (11:00-11:00, 00:00-00:00, 24:00 de apertura), cierre de madrugada pasado el corte (18:00-05:01, 18:00-06:00) y horas mal escritas',
    (select count(*) = 8 and bool_and(cardinality(public.configuracion_errores(
        ('[{"dia":"D","abre":"' || h.abre || '","cierra":"' || h.cierra || '","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]')::jsonb,
        null, true, true, '05:00')) > 0)
     from (values ('11:00','11:00'), ('00:00','00:00'), ('24:00','24:00'), ('18:00','05:01'), ('18:00','06:00'),
                  ('9:30','22:00'), ('11:00','24:30'), ('11:00','25:00')) as h(abre, cierra)),
    null),

  ('el corte se lee como HH:MM o HH:MM:SS (un valor raro cae en 05:00): 18:00-05:00 vale con 05:00:00 y con basura',
    cardinality(public.configuracion_errores('[{"dia":"D","abre":"18:00","cierra":"05:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null, true, true, '05:00:00')) = 0
      and cardinality(public.configuracion_errores('[{"dia":"D","abre":"18:00","cierra":"05:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null, true, true, 'basura')) = 0,
    null),

  ('el trigger acepta un cierre de madrugada hasta la hora de corte',
    (select h.ok from _mr16b_trigger h where h.k = 'madrugada_hasta_el_corte'), (select h.detalle from _mr16b_trigger h where h.k = 'madrugada_hasta_el_corte')),
  ('el trigger rechaza (23514) un cierre de madrugada pasada la hora de corte',
    (select h.ok from _mr16b_trigger h where h.k = 'madrugada_pasada_del_corte'), (select h.detalle from _mr16b_trigger h where h.k = 'madrugada_pasada_del_corte')),
  ('con otra hora de corte (07:00) ese mismo cierre vale',
    (select h.ok from _mr16b_trigger h where h.k = 'madrugada_con_otro_corte'), (select h.detalle from _mr16b_trigger h where h.k = 'madrugada_con_otro_corte')),
  ('bajar la hora de corte por debajo de un cierre de madrugada existente se rechaza (23514)',
    (select h.ok from _mr16b_trigger h where h.k = 'bajar_el_corte'), (select h.detalle from _mr16b_trigger h where h.k = 'bajar_el_corte')),
  ('abrir o cerrar el local (cerrado_temporal) no valida el horario',
    (select h.ok from _mr16b_trigger h where h.k = 'cerrar_sin_validar'), (select h.detalle from _mr16b_trigger h where h.k = 'cerrar_sin_validar')),

  ('el trigger configuracion_validar sigue activo (BEFORE INSERT OR UPDATE por fila) y su funcion usa la hora de corte',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.configuracion'::regclass and t.tgname = 'configuracion_validar'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16 and (t.tgtype & 1) = 1
              and f.prosrc like '%hora_corte_jornada%'),
    null),

  ('las funciones del horario NO son SECURITY DEFINER; anon no ejecuta ninguna; authenticated y service_role si',
    (select count(*) = 3 and bool_and(not p.prosecdef and not has_function_privilege('anon', p.oid, 'execute')
                                     and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('configuracion_errores', 'validar_configuracion')),
    null),

  ('anon: sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('ninguna fila cambio (conteos y huellas de pedidos, categorias, productos, configuracion, salud, restaurantes, miembros y tarifas)',
    not exists (select 1 from _mr16b_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
                      union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
                      union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
                     ) d on d.tabla = a.tabla
                where d.filas <> a.filas or d.huella <> a.huella),
    null),

  ('informativo: restaurantes cuyo horario actual no cumple la regla nueva (no bloquea; se validan cuando cambien su horario o su hora de corte)',
    true,
    coalesce((select string_agg(r.slug, ', ') from public.configuracion c join public.restaurantes r on r.id = c.restaurante_id
              where cardinality(public.configuracion_errores(c.horarios, c.mensaje_cerrado, true, true, left(c.hora_corte_jornada::text, 5))) > 0), 'ninguno'))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr16b_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 16b SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- PostgREST tiene que enterarse de la funcion nueva.
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr16b_verif
order by orden;
