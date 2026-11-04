-- =============================================================
-- TAQUEIROS 2.0 — SUPERADMIN: LECTURAS DE SOLO LECTURA PARA "ENTRAR COMO" Y RECHAZOS DE MFA  (SQL 19)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": el archivo no crea tablas, solo funciones)
--
-- ANTES DE CORRERLO
--   * El SQL 16 ya debe estar aplicado (usa exigir_superadmin, auditar_superadmin, sa_detalle_restaurante y la tabla de
--     auditoria). El 16b NO hace falta (es independiente). El SQL 18 (opciones de producto) es opcional: sin el, sa_ver_menu
--     devuelve la lista de opciones vacia.
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs
--
-- QUE HACE  (paso 3B parte 1: docs seccion 23)
--   Agrega 5 funciones sa_* (y 1 ayuda interna) para que api/superadmin.js deje al superadmin MIRAR un restaurante sin
--   escribir nada ("entrar como" de solo lectura; NO se suplanta la sesion de nadie):
--        sa_ver_pedidos(actor, restaurante, modo, limite, antes_de, ahora)   jornada actual o recientes, paginado, con items y opciones
--        sa_ver_menu(actor, restaurante)                                     categorias, productos y opciones, tambien las inactivas
--        sa_ver_config(actor, restaurante, ahora)                            config, horario, dominios, miembros con rol y correo, tarifas (NUNCA secretos)
--        sa_ver_resumen(actor, restaurante, ahora)                           conteos y ventas de la jornada y del mes
--        sa_registrar_rechazo_mfa(actor, aal, accion)                        deja constancia (acotada) de un superadmin rechazado por no tener MFA
--        auditar_lectura_superadmin(...)                                     ayuda interna: audita sin inundar (ver abajo)
--   Todas:
--        * SECURITY DEFINER con search_path fijo y SIN EXECUTE para anon, authenticated ni PUBLIC: solo el servidor
--          (api/superadmin.js, con la llave de servicio);
--        * LO PRIMERO que hacen es exigir_superadmin(p_actor) (42501 si no esta en public.superadmins);
--        * validan que el restaurante exista (P0002) y limitan las filas; ninguna usa SQL dinamico;
--        * las lecturas NO escriben en ninguna tabla de negocio (la comprobacion final revisa que su codigo no contiene
--          insert, update, delete, truncate, merge, copy ni execute); lo UNICO que escriben es una fila de auditoria;
--        * ninguna devuelve secretos (no leen restaurante_secretos; de ellos solo si/no por campo, via la ayuda del 16)
--          ni tokens de seguimiento.
--
-- AUDITORIA DE LAS LECTURAS (sin datos personales)
--   Cada lectura deja una fila (quien, cuando, restaurante, accion) con un resumen de CONTEOS y parametros: jamas nombres,
--   telefonos, correos de clientes ni direcciones. Para no inundar la auditoria al paginar o refrescar, se registra la
--   PRIMERA lectura de cada (superadmin, accion, restaurante, modo) y no las repetidas dentro de 10 minutos. La
--   constancia dice cuantos registros devolvio esa primera lectura. Riesgo conocido y su razon: docs seccion 23.
--   Si la auditoria falla, la lectura NO se entrega (la constancia va en la misma transaccion).
--
-- QUE NO HACE
--   * No cambia datos (comprueba que ninguna fila cambio), no crea tablas ni da permisos nuevos a anon ni a authenticated.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una transaccion. Si cualquier paso o comprobacion
-- falla, TODO se revierte. Para deshacerlo: supabase/19-revertir.sql (primero el 19, despues el 16 si hiciera falta).
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Para SQL plano, el editor muestra el numero de linea: en VS Code usa Ctrl+G y busca hacia arriba el marcador
--     "-- >>> PASO ..." mas cercano. Lista de marcadores: buscar ">>> PASO".
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 19 SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA (esperadas: 14 filas, todas OK).
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
  foreach t in array array['restaurantes','miembros','superadmins','restaurante_secretos','restaurante_dominios',
                           'configuracion','pedidos','categorias','productos','salud_notificaciones','tarifas_domicilio',
                           'contadores_pedido','auditoria_superadmin'] loop
    v_item := t;
    if to_regclass('public.' || t) is null then faltan := faltan || ('tabla public.' || t); end if;
  end loop;

  foreach f in array array['public.exigir_superadmin(uuid)','public.auditar_superadmin(uuid,text,uuid,jsonb)',
                           'public.sa_detalle_restaurante(uuid,uuid,timestamptz)','public.sa_estado_secretos_interno(uuid)',
                           'public.sa_zona_valida(text)','public.calcular_vigencia(text,date,integer,text,timestamptz)',
                           'public.jornada_de(timestamptz,time)'] loop
    v_item := f;
    if to_regprocedure(f) is null then faltan := faltan || ('funcion ' || f); end if;
  end loop;

  if array_length(faltan, 1) > 0 then
    raise exception 'Faltan cosas del SQL 16. Corre primero supabase/16-superadmin.sql: %', array_to_string(faltan, '; ');
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- Lo que NO debe cambiar: la comprobacion final compara contra esto (solo una huella, nunca se muestra ningun valor).
drop table if exists pg_temp._mr19_antes;
create temp table _mr19_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t
union all select 'auditoria_superadmin', count(*), '' from public.auditoria_superadmin t;


-- =============================================================
-- >>> PASO 1) AYUDA INTERNA: auditar una lectura sin inundar
-- =============================================================

-- >>> PASO 1.1 auditar_lectura_superadmin: registra la lectura SOLO si el mismo superadmin no hizo la misma lectura
-- (misma accion, mismo restaurante, mismo "modo") en la ventana. Devuelve true si dejo constancia.
-- Nadie puede ejecutarla desde fuera (ni siquiera el servidor): solo la llaman las funciones sa_ver_*.
create or replace function public.auditar_lectura_superadmin(p_actor uuid, p_accion text, p_restaurante uuid, p_resumen jsonb default '{}'::jsonb,
                                                             p_ventana interval default interval '10 minutes')
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (
    select 1 from public.auditoria_superadmin a
    where a.actor = p_actor
      and a.accion = p_accion
      and a.restaurante_id is not distinct from p_restaurante
      and (a.resumen ->> 'modo') is not distinct from (p_resumen ->> 'modo')
      and a.creado_en > now() - p_ventana
  ) then
    return false;
  end if;
  perform public.auditar_superadmin(p_actor, p_accion, p_restaurante, p_resumen);
  return true;
end;
$fn$;

revoke all on function public.auditar_lectura_superadmin(uuid, text, uuid, jsonb, interval) from public, anon, authenticated, service_role;


-- =============================================================
-- >>> PASO 2) LAS LECTURAS  (solo service_role; LO PRIMERO: exigir_superadmin)
-- =============================================================

-- >>> PASO 2.1 pedidos: la jornada actual o los mas recientes, del mas nuevo al mas viejo, con items (y sus opciones), estado,
-- pago y cliente. Paginado por id: la respuesta trae "siguiente" (el id desde el cual pedir la pagina que sigue) y "hay_mas".
-- Maximo 100 por pagina. NO devuelve el token de seguimiento ni las coordenadas.
create or replace function public.sa_ver_pedidos(p_actor uuid, p_restaurante uuid, p_modo text default 'jornada', p_limite integer default 50,
                                                 p_antes_de bigint default null, p_ahora timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_limite integer := greatest(1, least(coalesce(p_limite, 50), 100));
  v_corte time;
  v_jornada date;
  v_inicio timestamptz;
  v_fin timestamptz;
  v_filas jsonb;
  v_n integer;
  v_hay_mas boolean;
  v_sig bigint;
begin
  perform public.exigir_superadmin(p_actor);
  if p_restaurante is null or not exists (select 1 from public.restaurantes r where r.id = p_restaurante) then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;
  if p_modo is null or p_modo not in ('jornada', 'recientes') then
    raise exception 'El modo debe ser jornada o recientes' using errcode = '22023';
  end if;
  if p_antes_de is not null and p_antes_de < 1 then
    raise exception 'antes_de debe ser un id valido' using errcode = '22023';
  end if;

  v_corte := coalesce((select c.hora_corte_jornada from public.configuracion c where c.restaurante_id = p_restaurante), '05:00'::time);
  v_jornada := public.jornada_de(p_ahora, v_corte);
  v_inicio := ((v_jornada + v_corte) at time zone 'America/Bogota');
  v_fin := ((v_jornada + 1 + v_corte) at time zone 'America/Bogota');

  with base as (
    select p.*
    from public.pedidos p
    where p.restaurante_id = p_restaurante
      and (p_modo = 'recientes' or (p.creado_en >= v_inicio and p.creado_en < v_fin))
      and (p_antes_de is null or p.id < p_antes_de)
    order by p.id desc
    limit v_limite + 1
  ), pagina as (
    select b.* from base b order by b.id desc limit v_limite
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', g.id, 'numero', g.numero, 'referencia', g.referencia, 'estado', g.estado, 'estado_pago', g.estado_pago,
           'tipo_pedido', g.tipo_pedido, 'cliente_nombre', g.cliente_nombre, 'cliente_telefono', g.cliente_telefono,
           'cliente_email', g.cliente_email, 'direccion', g.direccion, 'barrio', g.barrio, 'indicaciones', g.indicaciones,
           'items', g.items, 'subtotal', g.subtotal, 'costo_domicilio', g.costo_domicilio, 'total', g.total,
           'distancia_km', g.distancia_km, 'fuera_de_cobertura', g.fuera_de_cobertura,
           'wompi_metodo_pago', g.wompi_metodo_pago, 'wompi_ambiente', g.wompi_ambiente,
           'creado_en', g.creado_en, 'pagado_en', g.pagado_en, 'estado_cambiado_en', g.estado_cambiado_en,
           'reembolsado_en', g.reembolsado_en, 'impreso_en', g.impreso_en, 'reimpresiones', g.reimpresiones
         ) order by g.id desc), '[]'::jsonb),
         count(*)::integer,
         (select count(*) from base) > v_limite,
         min(g.id)
    into v_filas, v_n, v_hay_mas, v_sig
  from pagina g;

  perform public.auditar_lectura_superadmin(p_actor, 'ver_pedidos', p_restaurante,
    jsonb_build_object('modo', p_modo, 'limite', v_limite, 'pagina_inicial', p_antes_de is null, 'devueltos', v_n));

  return jsonb_build_object(
    'modo', p_modo,
    'jornada', case when p_modo = 'jornada' then jsonb_build_object('fecha', v_jornada, 'inicio', v_inicio, 'fin', v_fin, 'hora_corte', v_corte) else null end,
    'pedidos', v_filas,
    'devueltos', v_n,
    'hay_mas', v_hay_mas,
    'siguiente', case when v_hay_mas then v_sig else null end
  );
end;
$fn$;

-- >>> PASO 2.2 menu: categorias, productos y opciones, TAMBIEN las inactivas / agotadas. Con tope por lista; "truncado" dice si
-- alguna lista se corto. Sin el SQL 18, "opciones" sale vacia.
create or replace function public.sa_ver_menu(p_actor uuid, p_restaurante uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c_max_categorias constant integer := 200;
  c_max_productos constant integer := 1000;
  c_max_opciones constant integer := 5000;
  v_cat jsonb;
  v_prod jsonb;
  v_ops jsonb := '[]'::jsonb;
  v_n_cat integer;
  v_n_prod integer;
  v_n_ops integer := 0;
begin
  perform public.exigir_superadmin(p_actor);
  if p_restaurante is null or not exists (select 1 from public.restaurantes r where r.id = p_restaurante) then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;

  v_n_cat := (select count(*) from public.categorias x where x.restaurante_id = p_restaurante);
  v_cat := coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre, 'emoji', c.emoji, 'orden', c.orden, 'activa', c.activa) order by c.orden, c.id)
    from (select x.* from public.categorias x where x.restaurante_id = p_restaurante order by x.orden, x.id limit c_max_categorias) c
  ), '[]'::jsonb);

  v_n_prod := (select count(*) from public.productos x where x.restaurante_id = p_restaurante);
  v_prod := coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'nombre', p.nombre, 'descripcion', p.descripcion, 'precio', p.precio, 'categoria', p.categoria,
                                         'orden', p.orden, 'disponible', p.disponible, 'imagen', p.imagen,
                                         'creado_en', p.creado_en, 'actualizado_en', p.actualizado_en) order by p.categoria, p.orden, p.id)
    from (select x.* from public.productos x where x.restaurante_id = p_restaurante order by x.categoria, x.orden, x.id limit c_max_productos) p
  ), '[]'::jsonb);

  if to_regclass('public.producto_opciones') is not null then
    v_n_ops := (select count(*) from public.producto_opciones x where x.restaurante_id = p_restaurante);
    v_ops := coalesce((
      select jsonb_agg(jsonb_build_object('producto_id', o.producto_id, 'id', o.id, 'tipo', o.tipo, 'nombre', o.nombre, 'precio', o.precio,
                                           'orden', o.orden, 'activa', o.activa) order by o.producto_id, o.orden, o.id)
      from (select x.* from public.producto_opciones x where x.restaurante_id = p_restaurante order by x.producto_id, x.orden, x.id limit c_max_opciones) o
    ), '[]'::jsonb);
  end if;

  perform public.auditar_lectura_superadmin(p_actor, 'ver_menu', p_restaurante,
    jsonb_build_object('categorias', v_n_cat, 'productos', v_n_prod, 'opciones', v_n_ops));

  return jsonb_build_object(
    'categorias', v_cat, 'productos', v_prod, 'opciones', v_ops,
    'totales', jsonb_build_object('categorias', v_n_cat, 'productos', v_n_prod, 'opciones', v_n_ops),
    'truncado', v_n_cat > c_max_categorias or v_n_prod > c_max_productos or v_n_ops > c_max_opciones
  );
end;
$fn$;

-- >>> PASO 2.3 configuracion: todo lo de sa_detalle_restaurante (config publica, vigencia, dominios, miembros con rol y correo,
-- tarifas y SI/NO de cada secreto, nunca su valor) mas el horario y la jornada de la tabla configuracion.
create or replace function public.sa_ver_config(p_actor uuid, p_restaurante uuid, p_ahora timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_det jsonb;
  v_horario jsonb;
begin
  perform public.exigir_superadmin(p_actor);
  v_det := public.sa_detalle_restaurante(p_actor, p_restaurante, p_ahora);

  v_horario := (select jsonb_build_object('horarios', c.horarios, 'cerrado_temporal', c.cerrado_temporal, 'mensaje_cerrado', c.mensaje_cerrado,
                                          'hora_corte_jornada', c.hora_corte_jornada, 'minutos_ocultar_terminados', c.minutos_ocultar_terminados)
                from public.configuracion c where c.restaurante_id = p_restaurante);

  perform public.auditar_lectura_superadmin(p_actor, 'ver_config', p_restaurante,
    jsonb_build_object('miembros', jsonb_array_length(coalesce(v_det -> 'miembros', '[]'::jsonb)), 'dominios', jsonb_array_length(coalesce(v_det -> 'dominios', '[]'::jsonb))));

  return v_det || jsonb_build_object('horario', coalesce(v_horario, '{}'::jsonb));
end;
$fn$;

-- >>> PASO 2.4 resumen: conteos y ventas de la jornada actual (con el corte del restaurante, como el panel) y del mes (en la zona
-- horaria del restaurante). "Vendido" = pago aprobado y no cancelado, la misma definicion del panel (resumen_jornada).
create or replace function public.sa_ver_resumen(p_actor uuid, p_restaurante uuid, p_ahora timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r public.restaurantes%rowtype;
  v_corte time;
  v_jornada date;
  v_inicio timestamptz;
  v_fin timestamptz;
  v_zona text;
  v_mes_ini timestamptz;
  v_mes_fin timestamptz;
  v_j jsonb;
  v_m jsonb;
  v_cat jsonb;
begin
  perform public.exigir_superadmin(p_actor);
  select * into r from public.restaurantes x where x.id = p_restaurante;
  if not found then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;

  v_corte := coalesce((select c.hora_corte_jornada from public.configuracion c where c.restaurante_id = p_restaurante), '05:00'::time);
  v_jornada := public.jornada_de(p_ahora, v_corte);
  v_inicio := ((v_jornada + v_corte) at time zone 'America/Bogota');
  v_fin := ((v_jornada + 1 + v_corte) at time zone 'America/Bogota');

  v_zona := case when public.sa_zona_valida(r.zona_horaria) then r.zona_horaria else 'America/Bogota' end;
  v_mes_ini := (date_trunc('month', p_ahora at time zone v_zona)) at time zone v_zona;
  v_mes_fin := (date_trunc('month', p_ahora at time zone v_zona) + interval '1 month') at time zone v_zona;

  v_j := (select jsonb_build_object(
            'fecha', v_jornada, 'inicio', v_inicio, 'fin', v_fin,
            'pedidos', count(*),
            'vendidos', count(*) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'),
            'ventas', coalesce(sum(p.total) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'), 0),
            'ticket_promedio', coalesce(round(avg(p.total) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado')), 0),
            'cancelados', count(*) filter (where p.estado = 'cancelado'),
            'por_estado', jsonb_build_object(
              'pendiente_pago', count(*) filter (where p.estado = 'pendiente_pago'), 'nuevo', count(*) filter (where p.estado = 'nuevo'),
              'en_preparacion', count(*) filter (where p.estado = 'en_preparacion'), 'listo', count(*) filter (where p.estado = 'listo'),
              'entregado', count(*) filter (where p.estado = 'entregado'), 'cancelado', count(*) filter (where p.estado = 'cancelado')),
            'por_tipo', jsonb_build_object(
              'domicilio', count(*) filter (where p.tipo_pedido = 'domicilio'), 'llevar', count(*) filter (where p.tipo_pedido = 'llevar'),
              'local', count(*) filter (where p.tipo_pedido = 'local')))
          from public.pedidos p
          where p.restaurante_id = p_restaurante and p.creado_en >= v_inicio and p.creado_en < v_fin);

  v_m := (select jsonb_build_object(
            'desde', v_mes_ini, 'hasta', v_mes_fin, 'zona_horaria', v_zona,
            'pedidos', count(*),
            'vendidos', count(*) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'),
            'ventas', coalesce(sum(p.total) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'), 0),
            'cancelados', count(*) filter (where p.estado = 'cancelado'))
          from public.pedidos p
          where p.restaurante_id = p_restaurante and p.creado_en >= v_mes_ini and p.creado_en < v_mes_fin);

  v_cat := jsonb_build_object(
    'categorias', (select count(*) from public.categorias x where x.restaurante_id = p_restaurante),
    'productos', (select count(*) from public.productos x where x.restaurante_id = p_restaurante),
    'productos_disponibles', (select count(*) from public.productos x where x.restaurante_id = p_restaurante and x.disponible),
    'miembros_activos', (select count(*) from public.miembros x where x.restaurante_id = p_restaurante and x.activo));

  perform public.auditar_lectura_superadmin(p_actor, 'ver_resumen', p_restaurante, jsonb_build_object('jornada', v_jornada));

  return jsonb_build_object(
    'restaurante', jsonb_build_object('id', r.id, 'slug', r.slug, 'nombre', r.nombre, 'estado', r.estado, 'plan', r.plan,
                                      'vigencia', public.calcular_vigencia(r.estado, r.vigente_hasta, r.dias_gracia, r.zona_horaria, p_ahora)),
    'jornada', v_j, 'mes', v_m, 'catalogo', v_cat
  );
end;
$fn$;


-- =============================================================
-- >>> PASO 3) RECHAZO POR FALTA DE MFA: constancia acotada
-- =============================================================

-- >>> PASO 3.1 sa_registrar_rechazo_mfa: api/superadmin.js la llama cuando un SUPERADMIN real intenta una accion con una sesion
-- sin segundo factor (aal1). Deja UNA fila 'rechazo_mfa' por superadmin cada 15 minutos (el resto se descarta): suficiente para
-- ver que alguien con la contrasena de un superadmin esta llamando sin MFA, sin llenar la auditoria si una pantalla reintenta.
-- Solo guarda el nivel de la sesion y el NOMBRE de la accion pedida (cuando tiene la forma de un nombre de accion).
create or replace function public.sa_registrar_rechazo_mfa(p_actor uuid, p_aal text default 'aal1', p_accion text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.exigir_superadmin(p_actor);
  if exists (select 1 from public.auditoria_superadmin a
             where a.actor = p_actor and a.accion = 'rechazo_mfa' and a.creado_en > now() - interval '15 minutes') then
    return jsonb_build_object('registrado', false);
  end if;
  perform public.auditar_superadmin(p_actor, 'rechazo_mfa', null, jsonb_build_object(
    'aal', case when p_aal = 'aal2' then 'aal2' else 'aal1' end,
    'accion_intentada', case when p_accion ~ '^[a-z][a-z0-9_]{2,59}$' then p_accion else null end,
    'ventana_minutos', 15));
  return jsonb_build_object('registrado', true);
end;
$fn$;


-- =============================================================
-- >>> PASO 4) PERMISOS: SOLO el servidor (service_role). Ni anon, ni authenticated, ni PUBLIC.
-- =============================================================
do $do$
declare
  v_paso constant text := '4 permisos de las funciones nuevas';
  v_item text := '';
  p record;
begin
  for p in
    select pr.oid, pr.proname, pg_get_function_identity_arguments(pr.oid) as args
    from pg_proc pr
    where pr.pronamespace = 'public'::regnamespace
      and pr.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa')
  loop
    v_item := p.proname || '(' || p.args || ')';
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', p.proname, p.args);
    execute format('grant execute on function public.%I(%s) to service_role', p.proname, p.args);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 5) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================

-- >>> PASO 5.1 pruebas con datos que se deshacen (queda la base igual; solo se gasta un numero de la secuencia de la auditoria)
drop table if exists pg_temp._mr19_func;
create temp table _mr19_func (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '5.1 pruebas de las funciones';
  v_item text := '';
  v_res jsonb := '{}'::jsonb;
  v_cod text;
  v_actor uuid;
  v_taq uuid;
  v_r jsonb;
  v_n_antes bigint;
  v_n_despues bigint;
begin
  begin
    -- (a) alguien que no es superadmin (o un actor nulo) no puede ejecutar NINGUNA funcion nueva (42501)
    v_item := 'no superadmin';
    v_taq := (select r.id from public.restaurantes r order by r.creado_en, r.slug limit 1);
    v_cod := '';
    begin perform public.sa_ver_pedidos(gen_random_uuid(), v_taq); v_cod := v_cod || '[pedidos]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_ver_menu(gen_random_uuid(), v_taq); v_cod := v_cod || '[menu]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_ver_config(gen_random_uuid(), v_taq); v_cod := v_cod || '[config]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_ver_resumen(gen_random_uuid(), v_taq); v_cod := v_cod || '[resumen]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_registrar_rechazo_mfa(gen_random_uuid()); v_cod := v_cod || '[rechazo]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_ver_pedidos(null, v_taq); v_cod := v_cod || '[pedidos actor nulo]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_ver_menu(gen_random_uuid(), null); v_cod := v_cod || '[menu sin restaurante]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    v_res := v_res || jsonb_build_object('no_superadmin', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    -- (b) con un superadmin que YA existe (si hay alguno): cada lectura devuelve su forma, deja a lo sumo una fila de auditoria
    -- y la repetida dentro de la ventana no deja otra; un restaurante inexistente es P0002. Sin superadmins se omite.
    v_item := 'superadmin existente';
    v_actor := (select s.user_id from public.superadmins s order by s.user_id limit 1);
    if v_actor is null then
      v_res := v_res || jsonb_build_object('con_superadmin', jsonb_build_object('ok', true, 'detalle', 'omitido: todavia no hay superadmins'));
    else
      v_cod := '';
      v_n_antes := (select count(*) from public.auditoria_superadmin);
      v_r := public.sa_ver_pedidos(v_actor, v_taq, 'recientes', 5);
      if jsonb_typeof(v_r -> 'pedidos') <> 'array' or jsonb_array_length(v_r -> 'pedidos') > 5 then v_cod := v_cod || '[pedidos]'; end if;
      v_r := public.sa_ver_pedidos(v_actor, v_taq);
      if jsonb_typeof(v_r -> 'pedidos') <> 'array' or (v_r -> 'jornada' ->> 'fecha') is null then v_cod := v_cod || '[pedidos jornada]'; end if;
      v_r := public.sa_ver_menu(v_actor, v_taq);
      if jsonb_typeof(v_r -> 'productos') <> 'array' or jsonb_typeof(v_r -> 'categorias') <> 'array' or jsonb_typeof(v_r -> 'opciones') <> 'array' then v_cod := v_cod || '[menu]'; end if;
      v_r := public.sa_ver_config(v_actor, v_taq);
      if (v_r ->> 'id') is null or jsonb_typeof(v_r -> 'miembros') <> 'array' or jsonb_typeof(v_r -> 'horario') <> 'object' then v_cod := v_cod || '[config]'; end if;
      v_r := public.sa_ver_resumen(v_actor, v_taq);
      if jsonb_typeof(v_r -> 'jornada') <> 'object' or jsonb_typeof(v_r -> 'mes') <> 'object' then v_cod := v_cod || '[resumen]'; end if;
      v_n_despues := (select count(*) from public.auditoria_superadmin);
      -- 5 lecturas distintas (pedidos recientes, pedidos jornada, menu, config, resumen): a lo sumo 5 filas; si ya habia lecturas
      -- recientes iguales, menos. Repetirlas no agrega nada.
      if v_n_despues - v_n_antes > 5 then v_cod := v_cod || '[auditoria de mas]'; end if;
      v_n_antes := v_n_despues;
      perform public.sa_ver_pedidos(v_actor, v_taq, 'recientes', 5);
      perform public.sa_ver_menu(v_actor, v_taq);
      perform public.sa_ver_config(v_actor, v_taq);
      perform public.sa_ver_resumen(v_actor, v_taq);
      if (select count(*) from public.auditoria_superadmin) <> v_n_antes then v_cod := v_cod || '[la repetida audito]'; end if;
      begin perform public.sa_ver_menu(v_actor, gen_random_uuid()); v_cod := v_cod || '[restaurante inexistente]'; exception when others then if sqlstate <> 'P0002' then v_cod := v_cod || sqlstate; end if; end;
      begin perform public.sa_ver_pedidos(v_actor, v_taq, 'otro'); v_cod := v_cod || '[modo]'; exception when others then if sqlstate <> '22023' then v_cod := v_cod || sqlstate; end if; end;
      v_res := v_res || jsonb_build_object('con_superadmin', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));
    end if;

    raise exception 'mr19_fin %', v_res::text using errcode = 'P0001';
  exception when others then
    if sqlerrm like 'mr19_fin %' then
      insert into _mr19_func select e.key, (e.value ->> 'ok')::boolean, left(e.value ->> 'detalle', 300) from jsonb_each(substr(sqlerrm, 10)::jsonb) e;
    else
      raise exception '% (en la prueba "%")', sqlerrm, v_item using errcode = sqlstate;
    end if;
  end;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 5.2 la tabla de comprobaciones
drop table if exists pg_temp._mr19_verif;
create temp table _mr19_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr19_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('existen las 5 funciones nuevas (sa_ver_pedidos, sa_ver_menu, sa_ver_config, sa_ver_resumen, sa_registrar_rechazo_mfa) y la ayuda interna',
    (select count(*) = 5 from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa'))
      and to_regprocedure('public.auditar_lectura_superadmin(uuid,text,uuid,jsonb,interval)') is not null,
    (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa', 'auditar_lectura_superadmin'))),

  ('las 5 son SECURITY DEFINER con search_path fijo; service_role las ejecuta; anon, authenticated y PUBLIC NO',
    (select bool_and(p.prosecdef
                     and p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                     and has_function_privilege('service_role', p.oid, 'execute')
                     and not has_function_privilege('anon', p.oid, 'execute')
                     and not has_function_privilege('authenticated', p.oid, 'execute')
                     and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
     from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa')),
    null),

  ('la ayuda auditar_lectura_superadmin no la puede ejecutar nadie (ni anon, ni authenticated, ni service_role)',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'auditar_lectura_superadmin'
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))),
    null),

  ('lo PRIMERO que hace cada funcion nueva es exigir_superadmin(p_actor)',
    (select count(*) = 5 and bool_and(position('perform public.exigir_superadmin(p_actor);' in p.prosrc) > 0
                     and position('perform public.exigir_superadmin(p_actor);' in p.prosrc) < least(
                           coalesce(nullif(position('select ' in p.prosrc), 0), 1000000), coalesce(nullif(position('insert ' in p.prosrc), 0), 1000000),
                           coalesce(nullif(position('update ' in p.prosrc), 0), 1000000), coalesce(nullif(position('delete ' in p.prosrc), 0), 1000000),
                           coalesce(nullif(position('if ' in p.prosrc), 0), 1000000)))
     from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen', 'sa_registrar_rechazo_mfa')),
    null),

  ('las 4 lecturas NO escriben en ninguna tabla: su codigo no trae insert, update, delete, truncate, merge, copy ni execute (SQL dinamico)',
    (select count(*) = 4 and bool_and(p.prosrc !~* '(^|[^a-z_])(insert|update|delete|truncate|merge|copy|execute|format)([^a-z_]|$)')
     from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen')),
    null),

  ('el rechazo por MFA solo escribe a traves de la auditoria (sin insert, update, delete ni SQL dinamico propios)',
    (select count(*) = 1 and bool_and(p.prosrc !~* '(^|[^a-z_])(insert|update|delete|truncate|merge|copy|execute|format)([^a-z_]|$)' and position('auditar_superadmin' in p.prosrc) > 0)
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'sa_registrar_rechazo_mfa'),
    null),

  ('ninguna lectura toca los secretos ni el token de seguimiento: ni leen restaurante_secretos ni nombran token_seguimiento (solo reutilizan el si/no del SQL 16)',
    (select count(*) = 4 and bool_and(p.prosrc !~* '(restaurante_secretos|token_seguimiento|wompi_integridad|wompi_eventos|callmebot_apikey|llave_privada)')
     from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('sa_ver_pedidos', 'sa_ver_menu', 'sa_ver_config', 'sa_ver_resumen')),
    null),

  ('alguien que no es superadmin (o un actor nulo) no puede ejecutar ninguna funcion nueva (42501)',
    (select h.ok from _mr19_func h where h.k = 'no_superadmin'), (select h.detalle from _mr19_func h where h.k = 'no_superadmin')),

  ('con un superadmin existente: cada lectura devuelve su forma, la repetida no agrega auditoria, el restaurante inexistente es P0002 y el modo malo 22023',
    (select h.ok from _mr19_func h where h.k = 'con_superadmin'), (select h.detalle from _mr19_func h where h.k = 'con_superadmin')),

  ('anon solo puede ejecutar seguimiento y buscar_mis_pedidos (el SQL 19 no le dio nada)',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
                  and p.oid not in ('public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and has_function_privilege('anon', p.oid, 'execute')),
    null),

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

  ('la auditoria sigue cerrada: sin privilegios para anon, authenticated ni service_role y con sus 3 triggers de solo agregar',
    not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(rol)
                where has_table_privilege(r.rol, 'public.auditoria_superadmin', 'select,insert,update,delete,truncate'))
      and (select count(*) = 3 from pg_trigger t where t.tgrelid = 'public.auditoria_superadmin'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
             and t.tgname in ('auditoria_no_actualizar', 'auditoria_no_borrar', 'auditoria_no_vaciar')),
    null),

  ('este archivo no cambio datos (conteos y huellas de pedidos, categorias, productos, configuracion, restaurantes, miembros, superadmins, tarifas, secretos y dominios)',
    not exists (select 1 from _mr19_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
                      union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
                      union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
                      union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
                      union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
                      union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t
                      union all select 'auditoria_superadmin', count(*), '' from public.auditoria_superadmin t
                     ) d on d.tabla = a.tabla
                where d.filas <> a.filas or d.huella <> a.huella),
    null),

  ('informativo: funciones sa_* en total (las 15 del SQL 16 + las 5 de este archivo = 20) y superadmins dados de alta',
    true,
    (select count(*)::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'sa\_%' escape '\'
       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno'))
      || ' funciones sa_*; ' || (select count(*)::text from public.superadmins) || ' superadmins')
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr19_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 19 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
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
from _mr19_verif
order by orden;
