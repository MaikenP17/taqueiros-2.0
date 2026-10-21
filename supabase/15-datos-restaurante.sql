-- =============================================================
-- TAQUEIROS 2.0 — DATOS DE MI RESTAURANTE  (SQL 15)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo no crea tablas)
--
-- ANTES DE CORRERLO
--   * Los SQL 10, 11, 12 y 13 ya deben estar aplicados (el 14 no importa).
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs
--
-- QUE HACE
--   1. HORARIO Y MENSAJE DE CERRADO VALIDADOS EN LA BASE (el pendiente 16.10-7). Un trigger revisa
--      configuracion.horarios (exactamente 7 dias; cada dia con dia, abre, cierra y activo; horas HH:MM,
--      de 00:00 a 23:59 y "24:00" para cerrar; activo verdadero o falso) y configuracion.mensaje_cerrado
--      (hasta 300 caracteres, sin < ni >, sin caracteres de control; se permite el salto de linea).
--      Aplica a TODOS (dueno, superadmin, servidor, editor SQL). En un INSERT siempre; en un UPDATE solo si
--      cambian el horario o el mensaje (abrir y cerrar el local nunca se frena por un horario viejo).
--      ANTES de activarlo comprueba que los datos actuales de Taqueiros pasan y, si no, SE DETIENE
--      sin cambiar nada, diciendo exactamente que dia y que campo corregir. Los demas restaurantes
--      solo se informan (se validan cuando cambien su horario).
--   2. GUARDAR "DATOS DE MI RESTAURANTE" (la funcion del formulario del panel):
--        public.guardar_datos_restaurante(p_restaurante uuid, p_cambios jsonb)
--      Solo puede tocar el nombre, config.publico.textos y config.publico.contacto (una lista cerrada de
--      32 campos). Recibe SOLO los campos que cambiaron, cada uno con el valor que el usuario vio ("antes")
--      y el nuevo ("despues"):
--        * nunca pierde otras claves de la config (marca, ubicacion, domicilio, llaves...): cambia solo
--          esos campos dentro de la base, no reemplaza la config entera;
--        * dos ediciones a la vez no se pisan: toma el candado de la fila, compara cada campo con lo que
--          el usuario vio y, si alguien ya lo cambio, NO guarda nada y devuelve los campos en conflicto;
--        * es SECURITY INVOKER: corre con los permisos de quien la llama, asi que RLS y el trigger del
--          SQL 13 siguen siendo la defensa de fondo (el dueno no puede cambiar marca, plan, vigencia,
--          modulos ni otro restaurante aunque llame a la funcion con cualquier dato);
--        * ademas exige ser dueno del restaurante (o superadmin / servidor).
--      El formulario valida antes con public.config_restaurante_errores(config) (SQL 13).
--
-- QUE NO HACE
--   * No cambia datos (comprueba que ninguna fila cambio), no borra tablas ni columnas.
--   * No cambia permisos de tablas ni politicas. No agrega ninguna funcion SECURITY DEFINER.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una transaccion. Si cualquier paso o
-- comprobacion falla, TODO se revierte. Para deshacerlo: supabase/15-revertir.sql.
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Para SQL plano, el editor muestra el numero de linea: en VS Code usa Ctrl+G y busca hacia
--     arriba el marcador "-- >>> PASO ..." mas cercano. Lista de marcadores: buscar ">>> PASO".
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 15 SE REVIRTIO" y las lista.
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
  faltan text[] := '{}';
  t text;
  f text;
begin
  foreach t in array array['restaurantes','miembros','superadmins','configuracion','pedidos','categorias','productos',
                           'salud_notificaciones','tarifas_domicilio'] loop
    v_item := t;
    if to_regclass('public.' || t) is null then faltan := faltan || ('tabla public.' || t); end if;
  end loop;

  foreach f in array array['public.es_servidor()','public.es_superadmin()','public.rol_en(uuid)',
                           'public.config_restaurante_errores(jsonb)','public.proteger_campos_restaurante()',
                           'public.restaurante_taqueiros_id()'] loop
    v_item := f;
    if to_regprocedure(f) is null then faltan := faltan || ('funcion ' || f); end if;
  end loop;

  if array_length(faltan, 1) > 0 then
    raise exception 'Faltan cosas de los SQL 10 a 13. Corre primero supabase/13-endurecer.sql: %', array_to_string(faltan, '; ');
  end if;

  v_item := 'proteger_campos_restaurante (version del SQL 13)';
  if not exists (select 1 from pg_proc p where p.oid = 'public.proteger_campos_restaurante()'::regprocedure
                 and p.prosrc like '%publico,textos%' and p.prosrc like '%permitidas%') then
    raise exception 'El trigger proteger_campos_restaurante no es el del SQL 13 (el dueno podria cambiar mas de lo debido). Corre primero supabase/13-endurecer.sql';
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
drop table if exists pg_temp._mr15_antes;
create temp table _mr15_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;


-- =============================================================
-- >>> PASO 1) HORARIO Y MENSAJE DE CERRADO VALIDADOS EN LA BASE
-- =============================================================

-- >>> PASO 1.1 la funcion de reglas (pura: la usan el trigger, las comprobaciones y el panel)
-- Devuelve la lista de problemas (vacia = valido). NO repite en los mensajes el valor recibido.
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

-- >>> PASO 1.2 los datos ACTUALES tienen que cumplir las reglas (si no, no se activa nada)
-- Taqueiros: bloquea. Los demas restaurantes: solo se informan (se validan cuando cambien su horario).
do $do$
declare
  v_paso constant text := '1.2 el horario y el mensaje actuales de Taqueiros cumplen las reglas';
  v_item text := 'configuracion de Taqueiros';
  v_err text[];
begin
  select public.configuracion_errores(c.horarios, c.mensaje_cerrado) into v_err
  from public.configuracion c where c.restaurante_id = public.restaurante_taqueiros_id();

  if v_err is null then
    raise exception 'Taqueiros no tiene fila en public.configuracion: no se puede comprobar su horario';
  end if;
  if cardinality(v_err) > 0 then
    raise exception E'El horario o el mensaje de cerrado ACTUALES de Taqueiros no cumplen las reglas nuevas y por eso no se activo nada. Corrigelos (Table editor -> configuracion -> la fila de Taqueiros; los dias van de horarios.0 = Domingo a horarios.6 = Sabado) o avisame:\n  - %',
      array_to_string(v_err, E'\n  - ');
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 1.3 el trigger
-- En INSERT se revisa todo; en UPDATE solo lo que cambia (el horario si cambia horarios, el mensaje si cambia
-- mensaje_cerrado): cerrar o abrir el local, o cualquier otro cambio, jamas se frena por un dato viejo.
-- Aplica a todos los roles.
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

drop trigger if exists configuracion_validar on public.configuracion;
create trigger configuracion_validar
  before insert or update on public.configuracion
  for each row execute function public.validar_configuracion();


-- =============================================================
-- >>> PASO 2) GUARDAR "DATOS DE MI RESTAURANTE"
-- =============================================================
-- p_cambios: lista JSON de { "campo": "...", "antes": texto|null, "despues": texto|null }, SOLO de los campos que
-- cambiaron. "antes" es lo que el usuario vio al abrir el formulario; "despues", lo que quiere guardar (null o
-- vacio = borrar el campo). Campos permitidos (lista cerrada):
--   nombre
--   textos.<titulo_pagina|descripcion_pagina|eslogan|tagline|descripcion_pie|servicios_linea|pie_final|ejemplo_nota|
--           banner_abierto_icono|banner_abierto_titulo|banner_abierto_texto|banner_cerrado_icono|banner_cerrado_mensaje>
--   textos.seguimiento.<tiempo_|frase_> + <nuevo|preparacion|camino|recoger|entregado>
--   contacto.<whatsapp|telefono|direccion|direccion_corta|ciudad|region|instagram|tiktok>
-- Devuelve { ok, cambios, datos } o, si alguien cambio antes alguno de esos campos,
--          { ok:false, conflictos:[{campo, actual}], datos } SIN guardar nada. "datos" es el estado vigente de lo editable.
-- Errores: 42501 sin permiso; 22023 pedido mal formado o campo no permitido; 23514 valor no valido (lo dice el trigger del SQL 13).
create or replace function public.guardar_datos_restaurante(p_restaurante uuid, p_cambios jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  c_campos constant text[] := array[
    'nombre',
    'textos.titulo_pagina', 'textos.descripcion_pagina', 'textos.eslogan', 'textos.tagline', 'textos.descripcion_pie',
    'textos.servicios_linea', 'textos.pie_final', 'textos.ejemplo_nota',
    'textos.banner_abierto_icono', 'textos.banner_abierto_titulo', 'textos.banner_abierto_texto',
    'textos.banner_cerrado_icono', 'textos.banner_cerrado_mensaje',
    'textos.seguimiento.tiempo_nuevo', 'textos.seguimiento.tiempo_preparacion', 'textos.seguimiento.tiempo_camino',
    'textos.seguimiento.tiempo_recoger', 'textos.seguimiento.tiempo_entregado',
    'textos.seguimiento.frase_nuevo', 'textos.seguimiento.frase_preparacion', 'textos.seguimiento.frase_camino',
    'textos.seguimiento.frase_recoger', 'textos.seguimiento.frase_entregado',
    'contacto.whatsapp', 'contacto.telefono', 'contacto.direccion', 'contacto.direccion_corta',
    'contacto.ciudad', 'contacto.region', 'contacto.instagram', 'contacto.tiktok'];
  v_fila public.restaurantes%rowtype;
  v_config jsonb;
  v_nombre text;
  v_cambio jsonb;
  v_campo text;
  v_ruta text[];
  v_antes text;
  v_despues text;
  v_actual text;
  v_vistos text[] := '{}';
  v_conflictos jsonb := '[]'::jsonb;
  v_pendientes jsonb := '[]'::jsonb;
  v_n integer := 0;
  v_i integer;
  v_k text;
  v_prefijo text[];
  -- las mismas reglas del nombre que el trigger del SQL 13 (que no se las aplica al servidor ni al superadmin)
  c_control constant text := '[\x01-\x1f\x7f-\x9f' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279) || ']';
begin
  if p_restaurante is null then
    raise exception 'Falta el restaurante' using errcode = '22023';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'array' then
    raise exception 'p_cambios debe ser una lista de cambios' using errcode = '22023';
  end if;
  if jsonb_array_length(p_cambios) > 40 then
    raise exception 'Demasiados cambios en una sola llamada (maximo 40)' using errcode = '22023';
  end if;

  -- Quien: el dueno de ESE restaurante, un superadmin o el servidor. (Ademas RLS y el trigger del SQL 13.)
  if not (public.es_servidor() or (select public.es_superadmin()) or public.rol_en(p_restaurante) = 'dueno') then
    raise exception 'Solo el dueno del restaurante puede editar sus datos' using errcode = '42501';
  end if;

  -- El candado de la fila: otra edicion a la vez espera aqui y despues lee lo que la primera guardo
  select r.* into v_fila from public.restaurantes r where r.id = p_restaurante for update;
  if not found then
    raise exception 'No tienes acceso a ese restaurante' using errcode = '42501';
  end if;
  v_config := coalesce(v_fila.config, '{}'::jsonb);
  v_nombre := v_fila.nombre;

  if v_config ? 'publico' and jsonb_typeof(v_config -> 'publico') <> 'object' then
    raise exception 'config.publico debe ser un objeto' using errcode = '23514';
  end if;

  -- 1) validar la forma del pedido y juntar los conflictos (nada se guarda todavia)
  for v_i in 0 .. jsonb_array_length(p_cambios) - 1 loop
    v_cambio := p_cambios -> v_i;
    if jsonb_typeof(v_cambio) <> 'object' then
      raise exception 'Cada cambio debe ser un objeto { campo, antes, despues }' using errcode = '22023';
    end if;
    for v_k in select jsonb_object_keys(v_cambio) loop
      if v_k not in ('campo', 'antes', 'despues') then
        raise exception 'Clave no permitida en un cambio: %', left(v_k, 40) using errcode = '22023';
      end if;
    end loop;
    if jsonb_typeof(v_cambio -> 'campo') is distinct from 'string' then
      raise exception 'Cada cambio necesita "campo" (texto)' using errcode = '22023';
    end if;
    v_campo := v_cambio ->> 'campo';
    if not (v_campo = any (c_campos)) then
      raise exception 'Campo no permitido: %', left(v_campo, 60) using errcode = '22023';
    end if;
    if v_campo = any (v_vistos) then
      raise exception 'Campo repetido: %', v_campo using errcode = '22023';
    end if;
    v_vistos := v_vistos || v_campo;
    foreach v_k in array array['antes', 'despues'] loop
      if (v_cambio ? v_k) and jsonb_typeof(v_cambio -> v_k) not in ('string', 'null') then
        raise exception '"%" de % debe ser texto o null', v_k, v_campo using errcode = '22023';
      end if;
    end loop;

    v_antes := nullif(btrim(v_cambio ->> 'antes'), '');
    v_despues := nullif(btrim(v_cambio ->> 'despues'), '');
    if v_campo = 'nombre' then
      v_actual := nullif(btrim(v_nombre), '');
    else
      v_actual := nullif(btrim(v_config #>> (array['publico'] || string_to_array(v_campo, '.'))), '');
    end if;

    if v_antes is distinct from v_actual then
      v_conflictos := v_conflictos || jsonb_build_array(jsonb_build_object('campo', v_campo, 'actual', v_actual));
    else
      v_pendientes := v_pendientes || jsonb_build_array(jsonb_build_object('campo', v_campo, 'despues', v_despues));
    end if;
  end loop;

  -- 2) si alguien cambio antes alguno de esos campos: no se guarda NADA
  if jsonb_array_length(v_conflictos) > 0 then
    return jsonb_build_object(
      'ok', false,
      'conflictos', v_conflictos,
      'datos', jsonb_build_object('nombre', v_nombre,
                                  'textos', coalesce(v_config #> '{publico,textos}', '{}'::jsonb),
                                  'contacto', coalesce(v_config #> '{publico,contacto}', '{}'::jsonb)));
  end if;

  -- 3) aplicar SOLO esos campos sobre la config vigente (el resto queda intacto)
  for v_i in 0 .. jsonb_array_length(v_pendientes) - 1 loop
    v_campo := v_pendientes -> v_i ->> 'campo';
    v_despues := v_pendientes -> v_i ->> 'despues';
    if v_campo = 'nombre' then
      if v_despues is null then
        raise exception 'El nombre del restaurante no puede quedar vacio' using errcode = '23514';
      end if;
      if v_despues is distinct from v_nombre then
        if char_length(v_despues) > 120 or v_despues ~ '[<>]' or v_despues ~ c_control then
          raise exception 'Nombre del restaurante no valido (1 a 120 caracteres, sin < ni > ni caracteres de control)' using errcode = '23514';
        end if;
        v_nombre := v_despues;
        v_n := v_n + 1;
      end if;
      continue;
    end if;

    v_ruta := array['publico'] || string_to_array(v_campo, '.');
    if v_despues is null then
      if (v_config #>> v_ruta) is not null then
        v_config := v_config #- v_ruta;
        v_n := v_n + 1;
      end if;
    else
      -- crea los contenedores que falten (publico, publico.textos, ...); si uno existe y no es objeto, se rechaza
      for v_k in select generate_series(1, cardinality(v_ruta) - 1)::text loop
        v_prefijo := v_ruta[1:v_k::integer];
        if (v_config #> v_prefijo) is null then
          v_config := jsonb_set(v_config, v_prefijo, '{}'::jsonb, true);
        elsif jsonb_typeof(v_config #> v_prefijo) <> 'object' then
          raise exception '% debe ser un objeto', array_to_string(v_prefijo, '.') using errcode = '23514';
        end if;
      end loop;
      if (v_config #>> v_ruta) is distinct from v_despues then
        v_config := jsonb_set(v_config, v_ruta, to_jsonb(v_despues), true);
        v_n := v_n + 1;
      end if;
    end if;
  end loop;

  -- 4) guardar (el trigger del SQL 13 valida la config entera y protege lo que el dueno no puede tocar)
  if v_n > 0 then
    update public.restaurantes set nombre = v_nombre, config = v_config where id = p_restaurante;
  end if;

  return jsonb_build_object(
    'ok', true,
    'cambios', v_n,
    'datos', jsonb_build_object('nombre', v_nombre,
                                'textos', coalesce(v_config #> '{publico,textos}', '{}'::jsonb),
                                'contacto', coalesce(v_config #> '{publico,contacto}', '{}'::jsonb)));
end;
$fn$;

revoke all on function public.guardar_datos_restaurante(uuid, jsonb) from public, anon;
grant execute on function public.guardar_datos_restaurante(uuid, jsonb) to authenticated, service_role;


-- =============================================================
-- >>> PASO 3) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================

-- >>> PASO 3.1 pruebas de la funcion sobre un restaurante de prueba (todo se deshace)
-- Las pruebas corren como el editor SQL (servidor). Las de permisos usan SET LOCAL ROLE. Los resultados se
-- empacan en el mensaje de una excepcion final para poder guardarlos despues de deshacer.
drop table if exists pg_temp._mr15_func;
create temp table _mr15_func (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '3.1 pruebas de guardar_datos_restaurante';
  v_item text := '';
  v_id uuid;
  v_res jsonb := '{}'::jsonb;
  v_r jsonb;
  v_cod text;
  v_msg text;
  v_cfg jsonb;
  v_nom text;
  v_base constant jsonb := '{"ubicacion":{"lat":7.9,"lng":-72.5},"domicilio":{"factor_recorrido":1.3},"publico":{"marca":{"logo":"Recursos/x/logo.png","colores":{"primario":"#112233"}},"textos":{"tagline":"Tagline original","seguimiento":{"frase_nuevo":"Recibido"}},"contacto":{"telefono":"123 456"},"wompi":{"llave_publica_test":"pub_test_abcdefghijk"}}}';
begin
  begin
    v_item := 'restaurante de prueba';
    insert into public.restaurantes (slug, nombre, config) values ('mr15-prueba', 'Prueba MR15', v_base) returning id into v_id;

    -- 1) aplica varios campos y NO pierde nada mas
    v_item := 'aplicar';
    v_r := public.guardar_datos_restaurante(v_id, jsonb_build_array(
      jsonb_build_object('campo', 'textos.eslogan', 'antes', null, 'despues', 'Nuevo eslogan'),
      jsonb_build_object('campo', 'contacto.whatsapp', 'antes', null, 'despues', '573001112233'),
      jsonb_build_object('campo', 'textos.seguimiento.frase_camino', 'antes', null, 'despues', 'Ya va en camino'),
      jsonb_build_object('campo', 'nombre', 'antes', 'Prueba MR15', 'despues', 'Prueba MR15 Editada')));
    select r.config, r.nombre into v_cfg, v_nom from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('aplicar', jsonb_build_object('ok',
      (v_r ->> 'ok')::boolean and (v_r ->> 'cambios')::int = 4
      and v_cfg #>> '{publico,textos,eslogan}' = 'Nuevo eslogan' and v_cfg #>> '{publico,contacto,whatsapp}' = '573001112233'
      and v_cfg #>> '{publico,textos,seguimiento,frase_camino}' = 'Ya va en camino' and v_nom = 'Prueba MR15 Editada'
      and v_cfg #>> '{publico,textos,tagline}' = 'Tagline original' and v_cfg #>> '{publico,textos,seguimiento,frase_nuevo}' = 'Recibido'
      and v_cfg #>> '{publico,contacto,telefono}' = '123 456'
      and v_cfg -> 'ubicacion' = v_base -> 'ubicacion' and v_cfg -> 'domicilio' = v_base -> 'domicilio'
      and v_cfg #> '{publico,marca}' = v_base #> '{publico,marca}' and v_cfg #> '{publico,wompi}' = v_base #> '{publico,wompi}',
      'detalle', v_r::text));

    -- 2) conflicto: otro cambio antes ese campo -> no guarda NADA (ni el otro, que estaba bien)
    v_item := 'conflicto';
    v_r := public.guardar_datos_restaurante(v_id, jsonb_build_array(
      jsonb_build_object('campo', 'textos.tagline', 'antes', 'Lo que yo vi', 'despues', 'Mi version'),
      jsonb_build_object('campo', 'textos.ejemplo_nota', 'antes', null, 'despues', 'Sin cebolla')));
    select r.config into v_cfg from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('conflicto', jsonb_build_object('ok',
      (v_r ->> 'ok')::boolean is false and v_r #>> '{conflictos,0,campo}' = 'textos.tagline' and v_r #>> '{conflictos,0,actual}' = 'Tagline original'
      and jsonb_array_length(v_r -> 'conflictos') = 1
      and v_cfg #>> '{publico,textos,tagline}' = 'Tagline original' and v_cfg #>> '{publico,textos,ejemplo_nota}' is null
      and v_r #>> '{datos,textos,tagline}' = 'Tagline original',
      'detalle', v_r::text));

    -- 3) vacio = borrar el campo (y solo ese)
    v_item := 'borrar';
    v_r := public.guardar_datos_restaurante(v_id, jsonb_build_array(
      jsonb_build_object('campo', 'textos.tagline', 'antes', 'Tagline original', 'despues', '   ')));
    select r.config into v_cfg from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('borrar', jsonb_build_object('ok',
      (v_r ->> 'ok')::boolean and not (v_cfg #> '{publico,textos}' ? 'tagline') and v_cfg #>> '{publico,textos,eslogan}' = 'Nuevo eslogan'
      and v_cfg #>> '{publico,marca,logo}' = 'Recursos/x/logo.png',
      'detalle', v_r::text));

    -- 4) sin cambios reales: no escribe
    v_item := 'sin cambios';
    v_r := public.guardar_datos_restaurante(v_id, jsonb_build_array(
      jsonb_build_object('campo', 'textos.eslogan', 'antes', 'Nuevo eslogan', 'despues', 'Nuevo eslogan')));
    v_res := v_res || jsonb_build_object('sin_cambios', jsonb_build_object('ok', (v_r ->> 'ok')::boolean and (v_r ->> 'cambios')::int = 0, 'detalle', v_r::text));

    -- 5) campos que no estan en la lista cerrada: 22023 y nada cambia
    v_item := 'campos no permitidos';
    v_cod := '';
    foreach v_msg in array array['marca.logo', 'textos.otro', 'estado', 'plan', 'publico.textos.eslogan', 'textos', 'textos.seguimiento', 'contacto', '', 'wompi.llave_publica_test', 'ubicacion.lat', 'domicilio.factor_recorrido', 'nombre ', 'Nombre'] loop
      begin
        perform public.guardar_datos_restaurante(v_id, jsonb_build_array(jsonb_build_object('campo', v_msg, 'antes', null, 'despues', 'x')));
        v_cod := v_cod || '[acepto ' || v_msg || ']';
      exception when others then
        if sqlstate <> '22023' then v_cod := v_cod || '[' || v_msg || ' dio ' || sqlstate || ']'; end if;
      end;
    end loop;
    select r.config into v_cfg from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('campos_no_permitidos', jsonb_build_object('ok', v_cod = '' and v_cfg #>> '{publico,marca,logo}' = 'Recursos/x/logo.png', 'detalle', v_cod));

    -- 6) pedidos mal formados
    v_item := 'pedidos mal formados';
    v_cod := '';
    foreach v_msg in array array['null', '{}', '"texto"', '[1]', '[{"campo":"textos.eslogan","antes":null,"despues":5}]', '[{"campo":"textos.eslogan","antes":null,"despues":"a","extra":1}]',
                                 '[{"antes":null,"despues":"a"}]', '[{"campo":"textos.eslogan","antes":null,"despues":"a"},{"campo":"textos.eslogan","antes":null,"despues":"b"}]',
                                 '[{"campo":["textos.eslogan"],"antes":null,"despues":"a"}]'] loop
      begin
        perform public.guardar_datos_restaurante(v_id, v_msg::jsonb);
        v_cod := v_cod || '[acepto ' || v_msg || ']';
      exception when others then
        if sqlstate <> '22023' then v_cod := v_cod || '[' || v_msg || ' dio ' || sqlstate || ']'; end if;
      end;
    end loop;
    begin
      perform public.guardar_datos_restaurante(v_id, (select jsonb_agg(jsonb_build_object('campo', 'textos.eslogan', 'antes', null, 'despues', 'a')) from generate_series(1, 41)));
      v_cod := v_cod || '[acepto 41 cambios]';
    exception when others then
      if sqlstate <> '22023' then v_cod := v_cod || '[41 cambios dio ' || sqlstate || ']'; end if;
    end;
    begin
      perform public.guardar_datos_restaurante(null, '[]'::jsonb);
      v_cod := v_cod || '[acepto restaurante nulo]';
    exception when others then
      if sqlstate <> '22023' then v_cod := v_cod || '[restaurante nulo dio ' || sqlstate || ']'; end if;
    end;
    v_res := v_res || jsonb_build_object('pedidos_mal_formados', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    -- 7) valores que la validacion del SQL 13 rechaza: 23514 y nada cambia (HTML, secreto, largo, whatsapp, usuario, salto de linea)
    v_item := 'valores no validos';
    v_cod := '';
    foreach v_msg in array array['textos.eslogan|<b>hola</b>', 'textos.eslogan|prv_test_abcdefghijk', 'textos.eslogan|' || repeat('a ', 201), 'textos.eslogan|dos' || chr(10) || 'lineas',
                                 'contacto.whatsapp|12', 'contacto.whatsapp|no es un numero', 'contacto.instagram|con espacios', 'contacto.tiktok|@a/b',
                                 'textos.seguimiento.frase_nuevo|' || repeat('x ', 101), 'nombre|<script>', 'nombre|' || repeat('n', 121), 'contacto.ciudad|' || repeat('c', 81)] loop
      select r.config, r.nombre into v_cfg, v_nom from public.restaurantes r where r.id = v_id;
      begin
        perform public.guardar_datos_restaurante(v_id, jsonb_build_array(jsonb_build_object('campo', split_part(v_msg, '|', 1),
          'antes', case split_part(v_msg, '|', 1) when 'nombre' then v_nom else v_cfg #>> (array['publico'] || string_to_array(split_part(v_msg, '|', 1), '.')) end,
          'despues', split_part(v_msg, '|', 2))));
        v_cod := v_cod || '[acepto ' || split_part(v_msg, '|', 1) || ']';
      exception when others then
        if sqlstate <> '23514' then v_cod := v_cod || '[' || split_part(v_msg, '|', 1) || ' dio ' || sqlstate || ': ' || left(sqlerrm, 60) || ']'; end if;
      end;
    end loop;
    select r.config, r.nombre into v_cfg, v_nom from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('valores_no_validos', jsonb_build_object('ok', v_cod = '' and v_nom = 'Prueba MR15 Editada' and v_cfg #>> '{publico,textos,eslogan}' = 'Nuevo eslogan', 'detalle', v_cod));

    -- 8) alguien sin membresia en ese restaurante: 42501 y nada cambia
    v_item := 'sin membresia';
    v_cod := '';
    begin
      set local role authenticated;
      perform set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', true);
      perform public.guardar_datos_restaurante(v_id, jsonb_build_array(jsonb_build_object('campo', 'textos.eslogan', 'antes', 'Nuevo eslogan', 'despues', 'Hackeado')));
      v_cod := 'acepto';
    exception when others then
      v_cod := sqlstate;
    end;
    select r.config into v_cfg from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('sin_membresia', jsonb_build_object('ok', v_cod = '42501' and v_cfg #>> '{publico,textos,eslogan}' = 'Nuevo eslogan', 'detalle', v_cod));

    -- 9) anon no puede ni llamarla
    v_item := 'anon';
    v_cod := '';
    begin
      set local role anon;
      perform public.guardar_datos_restaurante(v_id, '[]'::jsonb);
      v_cod := 'acepto';
    exception when others then
      v_cod := sqlstate;
    end;
    v_res := v_res || jsonb_build_object('anon', jsonb_build_object('ok', v_cod = '42501', 'detalle', v_cod));

    -- 10) un publico que no es objeto no se recorta ni se pisa
    v_item := 'config vacia';
    update public.restaurantes set config = '{}'::jsonb where id = v_id;
    v_r := public.guardar_datos_restaurante(v_id, jsonb_build_array(jsonb_build_object('campo', 'contacto.ciudad', 'antes', null, 'despues', 'Cucuta')));
    select r.config into v_cfg from public.restaurantes r where r.id = v_id;
    v_res := v_res || jsonb_build_object('crea_contenedores', jsonb_build_object('ok', (v_r ->> 'ok')::boolean and v_cfg = '{"publico":{"contacto":{"ciudad":"Cucuta"}}}'::jsonb, 'detalle', v_cfg::text));

    raise exception 'mr15_fin %', v_res::text using errcode = 'P0001';
  exception when others then
    if sqlerrm like 'mr15_fin %' then
      insert into _mr15_func select e.key, (e.value ->> 'ok')::boolean, left(e.value ->> 'detalle', 300) from jsonb_each(substr(sqlerrm, 10)::jsonb) e;
    else
      raise exception '% (en la prueba "%")', sqlerrm, v_item using errcode = sqlstate;
    end if;
  end;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 3.2 pruebas del trigger del horario (sobre un restaurante de prueba, deshechas)
drop table if exists pg_temp._mr15_horario;
create temp table _mr15_horario (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '3.2 pruebas del trigger de horario y mensaje';
  v_item text := '';
  v_id uuid;
  v_res jsonb := '{}'::jsonb;
  v_cod text;
  v_ok_hor constant jsonb := '[{"dia":"Domingo","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Lunes","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Martes","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Miercoles","abre":"11:00","cierra":"24:00","activo":true},{"dia":"Jueves","abre":"00:00","cierra":"23:59","activo":true},{"dia":"Viernes","abre":"18:00","cierra":"02:00","activo":true},{"dia":"Sabado","abre":"11:00","cierra":"22:00","activo":false}]';
begin
  begin
    v_item := 'restaurante de prueba';
    insert into public.restaurantes (slug, nombre, config) values ('mr15-prueba', 'Prueba MR15', '{}') returning id into v_id;

    -- el alta automatica deja un horario valido
    v_res := v_res || jsonb_build_object('alta', jsonb_build_object('ok',
      cardinality(public.configuracion_errores((select c.horarios from public.configuracion c where c.restaurante_id = v_id), null)) = 0, 'detalle', null));

    -- UPDATE valido
    v_item := 'update valido';
    update public.configuracion set horarios = v_ok_hor, mensaje_cerrado = 'Volvemos manana' || chr(10) || 'Gracias' where restaurante_id = v_id;
    v_res := v_res || jsonb_build_object('update_valido', jsonb_build_object('ok', true, 'detalle', null));

    -- UPDATE hostil: 23514 y queda lo anterior
    v_item := 'update hostil';
    v_cod := '';
    begin
      update public.configuracion set horarios = '[]'::jsonb where restaurante_id = v_id;
      v_cod := 'acepto 0 dias';
    exception when others then
      if sqlstate <> '23514' then v_cod := sqlstate; end if;
    end;
    begin
      update public.configuracion set mensaje_cerrado = '<b>cerrado</b>' where restaurante_id = v_id;
      v_cod := v_cod || '[acepto html]';
    exception when others then
      if sqlstate <> '23514' then v_cod := v_cod || sqlstate; end if;
    end;
    v_res := v_res || jsonb_build_object('update_hostil', jsonb_build_object('ok', v_cod = '' and (select c.horarios = v_ok_hor from public.configuracion c where c.restaurante_id = v_id), 'detalle', v_cod));

    -- abrir o cerrar el local NO valida el horario (aunque el guardado fuera viejo e invalido). Se prueba en una copia
    -- temporal de la tabla con el MISMO trigger, para no bloquear la tabla real ni tocar su trigger.
    v_item := 'cerrar sin validar';
    create temp table _mr15_cfg_prueba (like public.configuracion including defaults);
    insert into _mr15_cfg_prueba (restaurante_id, id, horarios, mensaje_cerrado) values (v_id, 0, '[1,2,3]'::jsonb, '<b>viejo</b>');
    create trigger _mr15_validar before insert or update on _mr15_cfg_prueba for each row execute function public.validar_configuracion();
    v_cod := '';
    begin
      update _mr15_cfg_prueba set cerrado_temporal = true;
    exception when others then
      v_cod := sqlstate || ' ' || left(sqlerrm, 100);
    end;
    begin
      update _mr15_cfg_prueba set horarios = '[1,2,3]'::jsonb, mensaje_cerrado = '<i>x</i>';
      v_cod := v_cod || '[acepto cambiar el horario a algo invalido]';
    exception when others then
      if sqlstate <> '23514' then v_cod := v_cod || sqlstate; end if;
    end;
    v_res := v_res || jsonb_build_object('cerrar_sin_validar', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    raise exception 'mr15_fin %', v_res::text using errcode = 'P0001';
  exception when others then
    if sqlerrm like 'mr15_fin %' then
      insert into _mr15_horario select e.key, (e.value ->> 'ok')::boolean, left(e.value ->> 'detalle', 300) from jsonb_each(substr(sqlerrm, 10)::jsonb) e;
    else
      raise exception '% (en la prueba "%")', sqlerrm, v_item using errcode = sqlstate;
    end if;
  end;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 3.3 la tabla de comprobaciones
drop table if exists pg_temp._mr15_verif;
create temp table _mr15_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr15_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  -- ---- 1. horario y mensaje de cerrado ----
  ('el horario y el mensaje actuales de Taqueiros cumplen las reglas',
    (select cardinality(public.configuracion_errores(c.horarios, c.mensaje_cerrado)) = 0 from public.configuracion c where c.restaurante_id = public.restaurante_taqueiros_id()),
    null),

  ('el trigger configuracion_validar esta activo (BEFORE INSERT OR UPDATE por fila)',
    exists (select 1 from pg_trigger t
            where t.tgrelid = 'public.configuracion'::regclass and t.tgname = 'configuracion_validar'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16 and (t.tgtype & 1) = 1),
    null),

  ('el horario normal de un restaurante nuevo (alta automatica) es valido',
    (select h.ok from _mr15_horario h where h.k = 'alta'), null),
  ('un UPDATE con un horario valido (incluye 24:00, un horario que cruza la medianoche y un dia cerrado) y un mensaje con salto de linea se acepta',
    (select h.ok from _mr15_horario h where h.k = 'update_valido'), null),
  ('un UPDATE con 0 dias o con HTML en el mensaje se rechaza con 23514 y queda lo anterior',
    (select h.ok from _mr15_horario h where h.k = 'update_hostil'), (select h.detalle from _mr15_horario h where h.k = 'update_hostil')),
  ('abrir o cerrar el local (cerrado_temporal) no valida el horario: un horario viejo nunca lo frena',
    (select h.ok from _mr15_horario h where h.k = 'cerrar_sin_validar'), (select h.detalle from _mr15_horario h where h.k = 'cerrar_sin_validar')),

  ('la validacion rechaza 23 horarios/mensajes hostiles de prueba (dias de mas o de menos, claves, horas, tipos, largos, HTML, controles)',
    (select count(*) = 23 and bool_and(cardinality(public.configuracion_errores(h.hor, h.msg)) > 0)
     from (values
       ('[]'::jsonb, null::text),
       ('{}'::jsonb, null),
       ('null'::jsonb, null),
       ('"texto"'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[1,2,3,4,5,6,7]'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"25:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"9:30","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"11:60","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"24:30","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"24:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":"si"},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00"},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true,"extra":1},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"<b>","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"un nombre de dia demasiado largo para ser un dia","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":11,"abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":11,"cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, repeat('a', 301)),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, '<script>x</script>'),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, 'con' || chr(7) || 'control'),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"D","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, 'con' || chr(8238) || 'bidi')
     ) as h(hor, msg)),
    null),

  ('la validacion acepta 4 combinaciones validas de prueba (normal, 24:00 y medianoche, mensaje vacio, mensaje de 300 caracteres con salto de linea)',
    (select count(*) = 4 and bool_and(cardinality(public.configuracion_errores(h.hor, h.msg)) = 0)
     from (values
       ('[{"dia":"Domingo","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Lunes","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Martes","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Miércoles","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Jueves","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Viernes","abre":"11:00","cierra":"22:00","activo":true},{"dia":"Sábado","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, null::text),
       ('[{"dia":"D","abre":"00:00","cierra":"24:00","activo":true},{"dia":"L","abre":"18:00","cierra":"02:00","activo":true},{"dia":"M","abre":"11:00","cierra":"22:00","activo":false},{"dia":"X","abre":"11:00","cierra":"22:00","activo":true},{"dia":"J","abre":"11:00","cierra":"22:00","activo":true},{"dia":"V","abre":"11:00","cierra":"22:00","activo":true},{"dia":"S","abre":"23:59","cierra":"23:59","activo":true}]'::jsonb, ''),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"L","abre":"11:00","cierra":"22:00","activo":true},{"dia":"M","abre":"11:00","cierra":"22:00","activo":true},{"dia":"X","abre":"11:00","cierra":"22:00","activo":true},{"dia":"J","abre":"11:00","cierra":"22:00","activo":true},{"dia":"V","abre":"11:00","cierra":"22:00","activo":true},{"dia":"S","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, repeat('a', 299) || chr(10)),
       ('[{"dia":"D","abre":"11:00","cierra":"22:00","activo":true},{"dia":"L","abre":"11:00","cierra":"22:00","activo":true},{"dia":"M","abre":"11:00","cierra":"22:00","activo":true},{"dia":"X","abre":"11:00","cierra":"22:00","activo":true},{"dia":"J","abre":"11:00","cierra":"22:00","activo":true},{"dia":"V","abre":"11:00","cierra":"22:00","activo":true},{"dia":"S","abre":"11:00","cierra":"22:00","activo":true}]'::jsonb, 'Hoy cerramos temprano. ¡Gracias, vuelve pronto!')
     ) as h(hor, msg)),
    null),

  -- ---- 2. guardar_datos_restaurante ----
  ('guardar_datos_restaurante aplica varios campos (nombre, textos, seguimiento, contacto) y NO pierde marca, ubicacion, domicilio, llaves ni otros textos',
    (select f.ok from _mr15_func f where f.k = 'aplicar'), (select f.detalle from _mr15_func f where f.k = 'aplicar')),
  ('si alguien cambio antes un campo, no guarda NADA (ni los demas) y devuelve el campo en conflicto con su valor actual',
    (select f.ok from _mr15_func f where f.k = 'conflicto'), (select f.detalle from _mr15_func f where f.k = 'conflicto')),
  ('un campo vacio se borra (solo ese)',
    (select f.ok from _mr15_func f where f.k = 'borrar'), (select f.detalle from _mr15_func f where f.k = 'borrar')),
  ('un cambio igual al valor actual no escribe nada',
    (select f.ok from _mr15_func f where f.k = 'sin_cambios'), (select f.detalle from _mr15_func f where f.k = 'sin_cambios')),
  ('14 campos fuera de la lista cerrada (marca, wompi, ubicacion, domicilio, estado, plan, contenedores enteros...) se rechazan con 22023',
    (select f.ok from _mr15_func f where f.k = 'campos_no_permitidos'), (select f.detalle from _mr15_func f where f.k = 'campos_no_permitidos')),
  ('10 pedidos mal formados (no es lista, claves de mas, tipos, repetidos, mas de 40, restaurante nulo) se rechazan con 22023',
    (select f.ok from _mr15_func f where f.k = 'pedidos_mal_formados'), (select f.detalle from _mr15_func f where f.k = 'pedidos_mal_formados')),
  ('12 valores no validos (HTML, secretos, largos, saltos de linea, whatsapp, usuarios, nombre) se rechazan con 23514 y no cambian nada',
    (select f.ok from _mr15_func f where f.k = 'valores_no_validos'), (select f.detalle from _mr15_func f where f.k = 'valores_no_validos')),
  ('alguien sin membresia en ese restaurante no puede guardar (42501) ni cambia nada',
    (select f.ok from _mr15_func f where f.k = 'sin_membresia'), (select f.detalle from _mr15_func f where f.k = 'sin_membresia')),
  ('anon no puede ejecutar la funcion',
    (select f.ok from _mr15_func f where f.k = 'anon'), (select f.detalle from _mr15_func f where f.k = 'anon')),
  ('sobre una config vacia crea solo los contenedores necesarios',
    (select f.ok from _mr15_func f where f.k = 'crea_contenedores'), (select f.detalle from _mr15_func f where f.k = 'crea_contenedores')),

  -- ---- 3. seguridad ----
  ('las funciones nuevas NO son SECURITY DEFINER; anon no ejecuta ninguna; authenticated y service_role si',
    (select count(*) = 3 and bool_and(not p.prosecdef and not has_function_privilege('anon', p.oid, 'execute')
                                     and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('guardar_datos_restaurante', 'configuracion_errores', 'validar_configuracion')),
    null),

  ('guardar_datos_restaurante lleva search_path fijo (no hereda el del llamador)',
    (select p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
     from pg_proc p where p.oid = 'public.guardar_datos_restaurante(uuid,jsonb)'::regprocedure),
    null),

  ('guardar_datos_restaurante toma el candado de la fila (FOR UPDATE) antes de comparar y guardar, y exige ser dueno, superadmin o servidor',
    (select p.prosrc ~* 'for update' and p.prosrc like '%rol_en(p_restaurante)%' and p.prosrc like '%es_superadmin%'
     from pg_proc p where p.oid = 'public.guardar_datos_restaurante(uuid,jsonb)'::regprocedure),
    null),

  ('proteger_campos_restaurante (SQL 13) sigue activo: el dueno solo cambia nombre y config.publico.textos / contacto',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_proteger'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc like '%publico,textos%' and f.prosrc like '%publico,contacto%' and f.prosrc like '%permitidas%'),
    null),

  ('anon: sin privilegios sobre ninguna tabla de public',
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

  ('anon solo puede ejecutar seguimiento y buscar_mis_pedidos',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
                  and p.oid not in ('public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and has_function_privilege('anon', p.oid, 'execute')),
    (select string_agg(p.proname, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
       and p.oid not in ('public.seguimiento(text)'::regprocedure,
                         'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('anon', p.oid, 'execute'))),

  ('ninguna funcion SECURITY DEFINER desconocida la pueden llamar anon o authenticated',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
                  and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
                  and p.oid not in ('public.config_jornada(uuid)'::regprocedure,
                                    'public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))),
    null),

  ('triggers de proteccion de los SQL 10 y 13 siguen activos',
    (select count(*) = 12 from pg_trigger
     where not tgisinternal and tgenabled <> 'D' and tgname in (
       'pedidos_proteger_pago', 'pedidos_restaurante_inmutable', 'categorias_restaurante_inmutable',
       'productos_restaurante_inmutable', 'configuracion_restaurante_inmutable', 'pedidos_limitar_rol',
       'productos_validar', 'categorias_validar', 'pedidos_asignar_numero', 'restaurantes_proteger',
       'restaurantes_validar_config', 'configuracion_proteger')),
    null),

  -- ---- 4. este archivo no cambio datos ----
  ('ninguna fila cambio (conteos y huellas de pedidos, categorias, productos, configuracion, salud, restaurantes, miembros y tarifas)',
    not exists (select 1 from _mr15_antes a
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

  ('no quedo ningun restaurante de prueba (mr15-prueba)',
    not exists (select 1 from public.restaurantes r where r.slug = 'mr15-prueba'),
    null),

  ('informativo: restaurantes cuyo horario o mensaje actual no cumple las reglas (no bloquea; se validan cuando cambien su horario)',
    true,
    coalesce((select string_agg(r.slug, ', ') from public.configuracion c join public.restaurantes r on r.id = c.restaurante_id
              where cardinality(public.configuracion_errores(c.horarios, c.mensaje_cerrado)) > 0), 'ninguno'))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr15_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 15 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- PostgREST tiene que enterarse de las funciones nuevas.
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr15_verif
order by orden;
