-- =============================================================
-- TAQUEIROS 2.0 — REVERTIR EL SQL 17  (el restaurante demo vuelve a ser "Los Taqueiros")
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo solo crea tablas temporales)
--
-- CUANDO USARLO
--   Solo si despues de correr supabase/17-rebrand-northe.sql quieres volver a la marca anterior.
--
-- QUE HACE
--   1. restaurantes.nombre vuelve a "Los Taqueiros".
--   2. En restaurantes.config.publico vuelven a sus valores originales (los del SQL 12, commit 947b164):
--        marca (logo, iconos, emoji, colores, colores_zonas), textos, contacto.instagram/tiktok y pwa.
--   3. Productos y categorias de Northe (ids que empiezan por nb-):
--        * un producto nb-* SE BORRA solo si NINGUN pedido lo referencia (los pedidos guardan el id y el nombre del
--          producto dentro de su lista "items"; se busca el id ahi, de este restaurante);
--        * un producto nb-* que SI aparece en algun pedido NO se borra: se queda en su categoria;
--        * una categoria nb-* se borra si ya no le queda ningun producto; si le queda alguno, se conserva APAGADA y
--          con " (Northe)" al final del nombre (para no chocar con "Bebidas" de Taqueiros).
--   4. Las categorias viejas de Taqueiros se vuelven a ENCENDER y pierden el " (Taqueiros)" del nombre.
--      Ojo: se encienden TODAS las categorias que no empiezan por nb-, aunque alguna estuviera apagada a proposito
--      antes del SQL 17 (el SQL 17 no guarda cual estaba apagada). Revisalo despues en menu-admin.html.
--
-- QUE NO HACE
--   * NUNCA toca pedidos (ni pagados ni de prueba). No toca ubicacion, domicilio, horarios, Wompi, WhatsApp, telefono,
--     direccion, slug, vigencia, secretos, tarifas ni otros restaurantes (comprobacion final con huellas).
--   * No toca los productos viejos de Taqueiros (ni una columna).
--   * No borra las FOTOS de Northe del Storage (bucket "productos", carpeta del restaurante): quedan huerfanas.
--     Se pueden dejar o limpiar a mano desde Storage; no estorban.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para volver a la marca nueva: supabase/17-rebrand-northe.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>]
-- y, si fallan las comprobaciones finales, "LA REVERSA 17 SE REVIRTIO" con la lista. Todo se revierte.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES, VALORES ORIGINALES Y FOTO DEL "ANTES"
-- =============================================================

-- >>> PASO 0.1 precondiciones
do $do$
declare
  v_paso constant text := '0.1 precondiciones';
  v_item text := '';
  v_nombre text;
  v_cfg jsonb;
begin
  v_item := 'tablas';
  if to_regclass('public.restaurantes') is null or to_regclass('public.categorias') is null
     or to_regclass('public.productos') is null or to_regclass('public.pedidos') is null
     or to_regclass('public.configuracion') is null then
    raise exception 'Faltan tablas (restaurantes, categorias, productos, pedidos o configuracion): este archivo solo revierte el SQL 17';
  end if;

  v_item := 'funciones del SQL 10 y del SQL 01';
  if to_regprocedure('public.restaurante_taqueiros_id()') is null or to_regprocedure('public.norm_texto(text)') is null then
    raise exception 'Faltan restaurante_taqueiros_id() o norm_texto(): este archivo solo revierte el SQL 17';
  end if;

  v_item := 'restaurante demo';
  select r.nombre, r.config into v_nombre, v_cfg
  from public.restaurantes r where r.id = public.restaurante_taqueiros_id() for update;
  if not found then
    raise exception 'No existe el restaurante demo (id 00000000-0000-4000-8000-000000000001). No se cambio nada.';
  end if;
  if v_nombre not in ('Los Taqueiros', 'The Northe Burgers') then
    raise exception 'El restaurante demo se llama "%": esta reversa espera "The Northe Burgers" (rebrand aplicado) o "Los Taqueiros" (ya revertido). No se cambio nada: revisa Table editor -> restaurantes antes de seguir.', v_nombre;
  end if;

  v_item := 'config.publico';
  if jsonb_typeof(v_cfg -> 'publico') is distinct from 'object' then
    raise exception 'restaurantes.config no tiene el objeto "publico". No se cambio nada.';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 0.2 los valores ORIGINALES de Taqueiros (los del SQL 12, tomados del commit 947b164)
drop table if exists pg_temp._mr17r_valores;
create temp table _mr17r_valores (k text primary key, v jsonb not null);

insert into _mr17r_valores (k, v) values
('marca', $j$ {
  "logo": "Recursos/logo/logo.png",
  "icono_192": "Recursos/logo/icono-192.png",
  "icono_512": "Recursos/logo/icono-512.png",
  "emoji": "🌮",
  "colores": {
    "primario": "#C1272D",
    "primario_oscuro": "#8A1B1F",
    "primario_brillo": "#E14A42",
    "claro": "#F7ECD6",
    "claro_suave": "#FFF8EA",
    "oscuro": "#1C1210",
    "oscuro_2": "#241714",
    "acento": "#E3A008",
    "positivo": "#5C7A3B",
    "texto_secundario": "#D9C9A8",
    "texto_tenue": "#B9A88C",
    "positivo_brillo": "#7FA855"
  },
  "colores_zonas": ["#5C7A3B", "#8FA83F", "#E3A008", "#E07B39"]
} $j$::jsonb),
('textos', $j$ {
  "titulo_pagina": "Los Taqueiros | Tacos, Birria y Antojitos en Cúcuta",
  "descripcion_pagina": "Los Taqueiros — tacos, birria, dorilocos y antojitos mexicanos en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp.",
  "eslogan": "Tacos · Birria · Antojitos",
  "tagline": "Del comal directo a tu mesa: tacos jugosos, birria con consomé y dorilocos bien cargados. Pide en dos clics y recíbelo por WhatsApp.",
  "descripcion_pie": "Tacos, birria y antojitos mexicanos hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta.",
  "servicios_linea": "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local",
  "pie_final": "Cúcuta, Colombia. Hecho con antojo 🌶️",
  "ejemplo_nota": "Ej: sin cebolla, extra picante, tocarle el timbre...",
  "banner_abierto_icono": "🔥",
  "banner_abierto_titulo": "¡Estamos que ardemos!",
  "banner_abierto_texto": "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🌮",
  "banner_cerrado_icono": "🌮",
  "banner_cerrado_mensaje": "Por hoy ya cerramos la cocina.",
  "seguimiento": {
    "tiempo_nuevo": "Suele estar listo en 25 – 40 minutos",
    "tiempo_preparacion": "Ya está en el comal, unos 15 – 25 minutos más",
    "tiempo_camino": "El domiciliario va en camino, 10 – 20 minutos",
    "tiempo_recoger": "¡Ya puedes pasar por él!",
    "tiempo_entregado": "¡Buen provecho! 🌮",
    "frase_nuevo": "¡Recibimos tu pedido! 🌮",
    "frase_preparacion": "Lo estamos preparando 🔥",
    "frase_camino": "¡Va en camino! 🛵",
    "frase_recoger": "¡Tu pedido está listo! 🥡",
    "frase_entregado": "¡Entregado! 🎉"
  }
} $j$::jsonb),
('redes', $j$ { "instagram": "lostaqueiros.co", "tiktok": "lostaqueiros_cuc" } $j$::jsonb),
('pwa', $j$ { "nombre": "Panel Taqueiros", "nombre_corto": "Comandas" } $j$::jsonb);

-- >>> PASO 0.3 la foto del "antes" (la misma funcion se usa despues)
create or replace function pg_temp.mr17_huellas()
returns table (clave text, huella text)
language plpgsql
as $f$
declare
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  return query select 'pedidos (todos)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.pedidos t;
  return query select 'configuracion (horarios, cerrado_temporal, mensaje_cerrado...)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t;
  return query select 'demo: config SIN marca, textos, pwa y redes (ubicacion, domicilio, wompi, whatsapp, direccion...)'::text,
    md5((r.config #- '{publico,marca}' #- '{publico,textos}' #- '{publico,pwa}'
               #- '{publico,contacto,instagram}' #- '{publico,contacto,tiktok}')::text)
    from public.restaurantes r where r.id = v_rid;
  return query select 'demo: slug, estado, plan, vigencia, modulos, zona horaria, hora de corte'::text,
    md5((to_jsonb(r) - 'nombre' - 'config')::text) from public.restaurantes r where r.id = v_rid;
  return query select 'demo: productos VIEJOS (ni una columna)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.id), ''))
    from public.productos t where t.restaurante_id = v_rid and t.id not like 'nb-%';
  return query select 'otros restaurantes (fila completa)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t where t.id <> v_rid;
  return query select 'categorias y productos de OTROS restaurantes'::text,
    (select count(*) from public.categorias c where c.restaurante_id <> v_rid)::text || ':'
    || md5(coalesce((select string_agg(c::text, '|' order by c.restaurante_id, c.id) from public.categorias c where c.restaurante_id <> v_rid), ''))
    || ':' || (select count(*) from public.productos p where p.restaurante_id <> v_rid)::text || ':'
    || md5(coalesce((select string_agg(p::text, '|' order by p.restaurante_id, p.id) from public.productos p where p.restaurante_id <> v_rid), ''));
  if to_regclass('public.tarifas_domicilio') is not null then
    return query select 'tarifas_domicilio'::text,
      count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;
  end if;
  if to_regclass('public.restaurante_secretos') is not null then
    return query select 'restaurante_secretos (solo huella, no se muestra nada)'::text,
      count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t;
  end if;
  if to_regclass('public.restaurante_dominios') is not null then
    return query select 'restaurante_dominios'::text,
      count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t;
  end if;
end
$f$;

drop table if exists pg_temp._mr17r_antes;
create temp table _mr17r_antes as select * from pg_temp.mr17_huellas();


-- =============================================================
-- >>> PASO 1) PRODUCTOS Y CATEGORIAS DE NORTHE (ids nb-*)
-- =============================================================
-- >>> PASO 1.1 productos nb-*: se borran SOLO los que ningun pedido de este restaurante referencia
do $do$
declare
  v_paso constant text := '1.1 productos nb-* sin pedidos';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  delete from public.productos p
  where p.restaurante_id = v_rid and p.id like 'nb-%'
    and not exists (select 1 from public.pedidos o
                    where o.restaurante_id = v_rid
                      and o.items @> jsonb_build_array(jsonb_build_object('id', p.id)));
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 1.2 categorias nb-*: se borran las que quedaron vacias; las que conservan productos (con pedidos) se apagan
do $do$
declare
  v_paso constant text := '1.2 categorias nb-*';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  delete from public.categorias c
  where c.restaurante_id = v_rid and c.id like 'nb-%'
    and not exists (select 1 from public.productos p where p.restaurante_id = c.restaurante_id and p.categoria = c.id);

  update public.categorias c
     set activa = false,
         nombre = case when c.nombre ~ ' \(Northe\)$' then c.nombre else left(c.nombre, 28) || ' (Northe)' end
   where c.restaurante_id = v_rid and c.id like 'nb-%'
     and (c.activa is distinct from false or c.nombre !~ ' \(Northe\)$');
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 1.3 categorias viejas: se encienden y pierden el " (Taqueiros)"
do $do$
declare
  v_paso constant text := '1.3 categorias viejas de Taqueiros';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  update public.categorias c
     set activa = true,
         nombre = regexp_replace(c.nombre, ' \(Taqueiros\)$', '')
   where c.restaurante_id = v_rid and c.id not like 'nb-%'
     and (c.activa is distinct from true or c.nombre ~ ' \(Taqueiros\)$');
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) NOMBRE Y CONFIG PUBLICA ORIGINALES
-- =============================================================
do $do$
declare
  v_paso constant text := '2 nombre y config publica';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
  v_cfg jsonb;
begin
  select r.config into v_cfg from public.restaurantes r where r.id = v_rid;

  v_item := 'publico.marca';
  v_cfg := jsonb_set(v_cfg, '{publico,marca}',
             coalesce(v_cfg #> '{publico,marca}', '{}'::jsonb) || (select v.v from _mr17r_valores v where v.k = 'marca'));
  v_item := 'publico.textos';
  v_cfg := jsonb_set(v_cfg, '{publico,textos}',
             coalesce(v_cfg #> '{publico,textos}', '{}'::jsonb) || (select v.v from _mr17r_valores v where v.k = 'textos'));
  v_item := 'publico.contacto (solo redes)';
  v_cfg := jsonb_set(v_cfg, '{publico,contacto}',
             coalesce(v_cfg #> '{publico,contacto}', '{}'::jsonb) || (select v.v from _mr17r_valores v where v.k = 'redes'));
  v_item := 'publico.pwa';
  v_cfg := jsonb_set(v_cfg, '{publico,pwa}',
             coalesce(v_cfg #> '{publico,pwa}', '{}'::jsonb) || (select v.v from _mr17r_valores v where v.k = 'pwa'));

  v_item := 'restaurantes';
  update public.restaurantes set nombre = 'Los Taqueiros', config = v_cfg where id = v_rid;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 3) COMPROBACIONES (si alguna falla, TODO se revierte)
-- =============================================================
-- La validacion de la config es del SQL 13: si no esta, no se llama (SQL dinamico: asi esta consulta ni siquiera
-- se analiza cuando la funcion no existe). errores_config = [] (valida), [..problemas..] o null (no hay validador).
do $do$
declare
  v_errores text[];
  v_valor jsonb := 'null'::jsonb;
begin
  if to_regprocedure('public.config_restaurante_errores(jsonb)') is not null then
    execute 'select public.config_restaurante_errores(r.config) from public.restaurantes r where r.id = public.restaurante_taqueiros_id()' into v_errores;
    v_valor := to_jsonb(coalesce(v_errores, '{}'::text[]));
  end if;
  insert into _mr17r_valores (k, v) values ('errores_config', v_valor) on conflict (k) do update set v = excluded.v;
end
$do$;

drop table if exists pg_temp._mr17r_verif;
create temp table _mr17r_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr17r_verif (verificacion, ok, detalle)
select * from (values
  ('el restaurante demo vuelve a llamarse "Los Taqueiros" y conserva id y slug "taqueiros"',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id() and r.nombre = 'Los Taqueiros' and r.slug = 'taqueiros'),
    null),

  ('publico.marca, textos, redes y pwa son los originales de Taqueiros (SQL 12)',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()
            and r.config #> '{publico,marca}' @> (select v.v from _mr17r_valores v where v.k = 'marca')
            and r.config #> '{publico,textos}' @> (select v.v from _mr17r_valores v where v.k = 'textos')
            and r.config #> '{publico,contacto}' @> (select v.v from _mr17r_valores v where v.k = 'redes')
            and r.config #> '{publico,pwa}' @> (select v.v from _mr17r_valores v where v.k = 'pwa')
            and jsonb_array_length(r.config #> '{publico,marca,colores_zonas}') = 4
            and (select count(*) from jsonb_object_keys(r.config #> '{publico,marca,colores}')) = 12),
    null),

  ('ningun texto de la config dice ya Northe',
    not exists (select 1 from public.restaurantes r
                where r.id = public.restaurante_taqueiros_id()
                  and (r.nombre || ' ' || (r.config #> '{publico}')::text) ~* 'northe'),
    null),

  ('la config entera cumple las reglas de validacion de la base (SQL 13)',
    (select v.v = '[]'::jsonb or v.v = 'null'::jsonb from _mr17r_valores v where v.k = 'errores_config'),
    (select case when v.v = 'null'::jsonb then 'SQL 13 no aplicado: sin validador (el trigger no existe)' when v.v <> '[]'::jsonb then left(v.v::text, 300) end
       from _mr17r_valores v where v.k = 'errores_config')),

  ('todas las categorias viejas de Taqueiros estan encendidas y sin " (Taqueiros)" en el nombre',
    not exists (select 1 from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.id not like 'nb-%'
                and (not c.activa or c.nombre ~ ' \(Taqueiros\)$')),
    (select count(*)::text || ' categorias viejas' from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.id not like 'nb-%')),

  ('ninguna categoria nb-* queda encendida y ningun producto nb-* queda dentro de una categoria encendida',
    not exists (select 1 from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.id like 'nb-%' and c.activa)
    and not exists (select 1 from public.productos p join public.categorias c on c.restaurante_id = p.restaurante_id and c.id = p.categoria
                    where p.restaurante_id = public.restaurante_taqueiros_id() and p.id like 'nb-%' and c.activa),
    null),

  ('no hay dos categorias con el mismo nombre en el menu encendido',
    not exists (select 1 from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.activa
                group by public.norm_texto(c.nombre) having count(*) > 1),
    null),

  ('ningun producto nb-* referenciado por un pedido fue borrado',
    not exists (select 1 from public.pedidos o,
                  lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) it
                where o.restaurante_id = public.restaurante_taqueiros_id() and (it ->> 'id') like 'nb-%'
                  and not exists (select 1 from public.productos p where p.restaurante_id = o.restaurante_id and p.id = (it ->> 'id'))),
    (select count(*)::text || ' productos nb-* conservados, ' || (select count(*) from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.id like 'nb-%')::text || ' categorias nb-* conservadas (apagadas)'
       from public.productos p where p.restaurante_id = public.restaurante_taqueiros_id() and p.id like 'nb-%'))
) as v(verificacion, ok, detalle);

-- Lo que NO debia cambiar: cada huella tiene que ser igual a la del "antes".
insert into _mr17r_verif (verificacion, ok, detalle)
select 'sin cambios: ' || a.clave,
       d.huella is not distinct from a.huella,
       case when d.huella is distinct from a.huella then 'CAMBIO' end
from _mr17r_antes a
left join pg_temp.mr17_huellas() d on d.clave = a.clave
order by a.clave;

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr17r_verif where not ok;

  if malas is not null then
    raise exception E'LA REVERSA 17 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr17r_verif
order by orden;
