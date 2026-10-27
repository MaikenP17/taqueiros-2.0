-- =============================================================
-- TAQUEIROS 2.0 — REBRAND DEL RESTAURANTE DEMO A "THE NORTHE BURGERS"  (SQL 17)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo solo crea tablas temporales)
--
-- ANTES DE CORRERLO
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs   (y copialo FUERA del repositorio)
--   * Los SQL 10 a 13 ya deben estar aplicados. Los 15, 16 y 16b NO hacen falta y no importa si estan o no:
--     este archivo no usa funciones sa_*, ni la vigencia, ni la tabla de auditoria.
--
-- QUE HACE  (el restaurante demo conserva su id 00000000-0000-4000-8000-000000000001 y su slug "taqueiros")
--   1. restaurantes.nombre pasa a "The Northe Burgers".
--   2. En restaurantes.config.publico SOBRESCRIBE solo estas claves (las demas se conservan como estan):
--        marca     logo, icono_192, icono_512, emoji, colores (las 12) y colores_zonas   (la tipografia, si hay, no se toca)
--        textos    todos los textos del sitio y del seguimiento del pedido
--        contacto  SOLO instagram y tiktok ("thenorthe.burgers")
--        pwa       nombre y nombre_corto del panel instalable
--   3. Si una categoria vieja se llama igual que una nueva (hoy: "Bebidas"), le agrega " (Taqueiros)" al nombre:
--      la base no admite dos categorias con el mismo nombre en el mismo restaurante.
--   4. Crea las 4 categorias (ids nb-hamburguesas, nb-hot-dogs, nb-papas, nb-bebidas) y los 13 productos del menu
--      aprobado (ids nb-big-norte ... nb-sprite), SIN foto: la foto se asigna despues con
--      node supabase/subir-fotos-northe.mjs   (o a mano desde menu-admin.html).
--   5. DESACTIVA (activa = false) todas las categorias viejas de Taqueiros. No borra nada. Asi los productos viejos
--      desaparecen del menu publico y el servidor rechaza pedirlos, sin tocar su estado de agotado.
--
-- QUE VE EL CLIENTE ENTRE ESTE SQL Y LA SUBIDA DE FOTOS
--   El menu nuevo completo, con las tarjetas SIN foto (el sitio ya sabe dibujarlas asi: tarjeta compacta, sin imagen).
--   Nada se rompe; solo faltan las fotos hasta que corras el script. El menu se guarda en cache hasta 5 minutos.
--
-- QUE NO HACE
--   * NO toca pedidos, ubicacion, domicilio, horarios, cerrado_temporal, mensaje_cerrado, llaves publicas de Wompi,
--     WhatsApp, telefono, direccion, slug, estado, plan, vigencia, secretos, tarifas ni ningun otro restaurante.
--     (la comprobacion final compara huellas de todo eso antes y despues y, si algo cambio, SE REVIERTE).
--   * NO borra productos ni categorias de Taqueiros: solo las desactiva.
--   * NO cambia el slug: la resolucion del sitio es por restaurante_dominios y el slug no se ve (ver docs seccion 20.5).
--
-- ABORTA SIN CAMBIAR NADA (con un mensaje claro) si:
--   * falta alguna tabla o columna de los SQL 10 a 13, o no existe el restaurante demo;
--   * el restaurante demo no se llama "Los Taqueiros" ni "The Northe Burgers" (alguien lo renombro a mano);
--   * restaurantes.config no tiene el objeto "publico" (falta el SQL 12).
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para deshacerlo: supabase/17-revertir.sql.
-- Si ya subiste las fotos, volver a correr este archivo NO las borra (no toca productos.imagen) ni cambia si un
-- producto esta agotado.
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Si fallan las comprobaciones finales, el error dice "EL REBRAND 17 SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA (todas deben decir OK).
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES, VALORES NUEVOS Y FOTO DEL "ANTES"
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
    raise exception 'Faltan tablas (restaurantes, categorias, productos, pedidos o configuracion). Corre primero los SQL 10 a 13.';
  end if;

  v_item := 'columna restaurante_id (SQL 10)';
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'categorias' and column_name = 'restaurante_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'productos' and column_name = 'restaurante_id') then
    raise exception 'categorias y productos no tienen restaurante_id. Corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'funciones del SQL 10 y del SQL 01';
  if to_regprocedure('public.restaurante_taqueiros_id()') is null or to_regprocedure('public.norm_texto(text)') is null then
    raise exception 'Faltan restaurante_taqueiros_id() o norm_texto(). Corre primero los SQL 01 y 10.';
  end if;

  v_item := 'restaurante demo';
  select r.nombre, r.config into v_nombre, v_cfg
  from public.restaurantes r where r.id = public.restaurante_taqueiros_id() for update;
  if not found then
    raise exception 'No existe el restaurante demo (id 00000000-0000-4000-8000-000000000001). Este archivo solo sirve para ese restaurante. No se cambio nada.';
  end if;
  if v_nombre not in ('Los Taqueiros', 'The Northe Burgers') then
    raise exception 'El restaurante demo se llama "%": este archivo espera "Los Taqueiros" (todavia sin rebrand) o "The Northe Burgers" (ya con rebrand). Alguien lo renombro a mano. No se cambio nada: revisa Table editor -> restaurantes antes de seguir.', v_nombre;
  end if;

  v_item := 'config.publico (SQL 12)';
  if jsonb_typeof(v_cfg -> 'publico') is distinct from 'object' then
    raise exception 'restaurantes.config no tiene el objeto "publico". Corre primero supabase/12-config-publica.sql. No se cambio nada.';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 0.2 los valores nuevos (UNA sola copia: el UPDATE y las comprobaciones leen de aqui).
-- Deben ser IDENTICOS a api/_respaldo-taqueiros.js (la prueba pruebas/multirestaurante/config-publica.mjs lo exige).
drop table if exists pg_temp._mr17_valores;
create temp table _mr17_valores (k text primary key, v jsonb not null);

insert into _mr17_valores (k, v) values
('marca', $j$ {
  "logo": "Recursos/logo/northe-logo.png",
  "icono_192": "Recursos/logo/northe-icono-192.png",
  "icono_512": "Recursos/logo/northe-icono-512.png",
  "emoji": "🍔",
  "colores": {
    "primario": "#C92423",
    "primario_oscuro": "#8E1B1A",
    "primario_brillo": "#E8514A",
    "claro": "#FFEBC6",
    "claro_suave": "#FFF6E3",
    "oscuro": "#220F08",
    "oscuro_2": "#2E160D",
    "acento": "#EEA927",
    "positivo": "#5C7A3B",
    "texto_secundario": "#E6D3AE",
    "texto_tenue": "#BFA987",
    "positivo_brillo": "#7FA855"
  },
  "colores_zonas": ["#5C7A3B", "#8FA83F", "#E3A008", "#E07B39"]
} $j$::jsonb),
('textos', $j$ {
  "titulo_pagina": "The Northe Burgers | Burgers con actitud de calle en Cúcuta",
  "descripcion_pagina": "The Northe Burgers — hamburguesas smash, hot dogs cargados y papas crinkle en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp.",
  "eslogan": "Burgers · Hot Dogs · Papas",
  "tagline": "Street food con actitud: hamburguesas smash, hot dogs cargados y papas que no se olvidan. Pide en dos clics y recíbelo por WhatsApp.",
  "descripcion_pie": "Hamburguesas smash, hot dogs cargados y papas crinkle hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta.",
  "servicios_linea": "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local",
  "pie_final": "Cúcuta, Colombia. Burgers con actitud de calle 🍔",
  "ejemplo_nota": "Ej: sin cebolla, extra salsa, tocarle el timbre...",
  "banner_abierto_icono": "🔥",
  "banner_abierto_titulo": "¡La plancha está prendida!",
  "banner_abierto_texto": "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🍔",
  "banner_cerrado_icono": "🍔",
  "banner_cerrado_mensaje": "Por hoy ya apagamos la plancha.",
  "seguimiento": {
    "tiempo_nuevo": "Suele estar listo en 25 – 40 minutos",
    "tiempo_preparacion": "Ya está en la plancha, unos 15 – 25 minutos más",
    "tiempo_camino": "El domiciliario va en camino, 10 – 20 minutos",
    "tiempo_recoger": "¡Ya puedes pasar por él!",
    "tiempo_entregado": "¡Buen provecho! 🍔",
    "frase_nuevo": "¡Recibimos tu pedido! 🍔",
    "frase_preparacion": "Lo estamos preparando 🔥",
    "frase_camino": "¡Va en camino! 🛵",
    "frase_recoger": "¡Tu pedido está listo! 🥡",
    "frase_entregado": "¡Entregado! 🎉"
  }
} $j$::jsonb),
('redes', $j$ { "instagram": "thenorthe.burgers", "tiktok": "thenorthe.burgers" } $j$::jsonb),
('pwa', $j$ { "nombre": "Panel The Northe Burgers", "nombre_corto": "Comandas" } $j$::jsonb);

-- El menu aprobado: id, categoria, orden, nombre, descripcion, precio (pesos colombianos, enteros).
-- Las descripciones de hot dogs, papas, Crispy y bebidas se ajustaron mirando cada foto (docs seccion 20.3).
drop table if exists pg_temp._mr17_menu;
create temp table _mr17_menu (id text primary key, categoria text not null, orden integer not null, nombre text not null, descripcion text not null, precio integer not null);
insert into _mr17_menu (id, categoria, orden, nombre, descripcion, precio) values
  ('nb-big-norte',     'nb-hamburguesas', 0, 'Big Norte',     'Triple carne smash, queso derretido y salsa rosa.', 26000),
  ('nb-crispy-norte',  'nb-hamburguesas', 1, 'Crispy Norte',  'Pollo crispy bien dorado, queso, tocineta y salsa BBQ.', 22000),
  ('nb-lil-norte',     'nb-hamburguesas', 2, 'Lil Norte',     'Carne smash sencilla con tocineta crocante y salsa picante.', 18000),
  ('nb-classic-norte', 'nb-hot-dogs',     0, 'Classic Norte', 'Salchicha clásica con mostaza y salsas de la casa.', 12000),
  ('nb-smoky-norte',   'nb-hot-dogs',     1, 'Smoky Norte',   'Salchicha ahumada con salsa BBQ, cebolla morada encurtida y cebolla crujiente.', 15000),
  ('nb-full-norte',    'nb-hot-dogs',     2, 'Full Norte',    'El más cargado: salchicha con cebolla crujiente, vegetales picados y todas las salsas.', 18000),
  ('nb-creamy-norte',  'nb-papas',        0, 'Creamy Norte',  'Papas crinkle con pollo, cebolla, rúgula y salsa cremosa.', 14000),
  ('nb-dirty-norte',   'nb-papas',        1, 'Dirty Norte',   'Papas crinkle con carne en tiras, rúgula y salsa blanca.', 17000),
  ('nb-chori-norte',   'nb-papas',        2, 'Chori Norte',   'Papas crinkle con chorizo, pollo crispy y salsas.', 19000),
  ('nb-agua',          'nb-bebidas',      0, 'Agua',          'Botella de agua, 600 ml.', 3000),
  ('nb-coca-cola',     'nb-bebidas',      1, 'Coca-Cola',     'Lata 350 ml, bien fría.', 4500),
  ('nb-pepsi',         'nb-bebidas',      2, 'Pepsi',         'Lata, bien fría.', 4500),
  ('nb-sprite',        'nb-bebidas',      3, 'Sprite',        'Lata, bien fría.', 4500);

drop table if exists pg_temp._mr17_categorias;
create temp table _mr17_categorias (id text primary key, nombre text not null, emoji text not null, orden integer not null);
insert into _mr17_categorias (id, nombre, emoji, orden) values
  ('nb-hamburguesas', 'Hamburguesas', '🍔', 0),
  ('nb-hot-dogs',     'Hot dogs',     '🌭', 1),
  ('nb-papas',        'Papas',        '🍟', 2),
  ('nb-bebidas',      'Bebidas',      '🥤', 3);

-- >>> PASO 0.3 la foto del "antes": huellas de todo lo que NO debe cambiar. La misma funcion se usa despues.
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

drop table if exists pg_temp._mr17_antes;
create temp table _mr17_antes as select * from pg_temp.mr17_huellas();


-- =============================================================
-- >>> PASO 1) CATEGORIAS VIEJAS CON EL MISMO NOMBRE QUE UNA NUEVA
-- =============================================================
-- La base no admite dos categorias con el mismo nombre (sin mayusculas ni tildes) en un restaurante. A la vieja se le
-- agrega " (Taqueiros)" al final; la reversa lo quita. Si ya lo tiene (segunda corrida), no se repite.
do $do$
declare
  v_paso constant text := '1 renombrar categorias viejas que chocan';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
  r record;
begin
  for r in
    select c.id, c.nombre from public.categorias c
    where c.restaurante_id = v_rid and c.id not like 'nb-%'
      and c.nombre !~ ' \(Taqueiros\)$'
      and public.norm_texto(c.nombre) in (select public.norm_texto(n.nombre) from _mr17_categorias n)
  loop
    v_item := r.id;
    if char_length(r.nombre) + 12 > 40 then
      raise exception 'La categoria vieja "%" es demasiado larga para agregarle " (Taqueiros)" (maximo 40 caracteres). Renombrala a mano y vuelve a correr este archivo.', r.nombre;
    end if;
    update public.categorias set nombre = r.nombre || ' (Taqueiros)' where restaurante_id = v_rid and id = r.id;
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) NOMBRE Y CONFIG PUBLICA DEL RESTAURANTE
-- =============================================================
-- Se sobrescriben SOLO marca (sin tipografia), textos, contacto.instagram/tiktok y pwa. El trigger
-- restaurantes_validar_config (SQL 13) revisa el resultado completo.
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
             coalesce(v_cfg #> '{publico,marca}', '{}'::jsonb) || (select v.v from _mr17_valores v where v.k = 'marca'));
  v_item := 'publico.textos';
  v_cfg := jsonb_set(v_cfg, '{publico,textos}',
             coalesce(v_cfg #> '{publico,textos}', '{}'::jsonb) || (select v.v from _mr17_valores v where v.k = 'textos'));
  v_item := 'publico.contacto (solo redes)';
  v_cfg := jsonb_set(v_cfg, '{publico,contacto}',
             coalesce(v_cfg #> '{publico,contacto}', '{}'::jsonb) || (select v.v from _mr17_valores v where v.k = 'redes'));
  v_item := 'publico.pwa';
  v_cfg := jsonb_set(v_cfg, '{publico,pwa}',
             coalesce(v_cfg #> '{publico,pwa}', '{}'::jsonb) || (select v.v from _mr17_valores v where v.k = 'pwa'));

  v_item := 'restaurantes';
  update public.restaurantes set nombre = 'The Northe Burgers', config = v_cfg where id = v_rid;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 3) CATEGORIAS Y PRODUCTOS NUEVOS
-- =============================================================
-- >>> PASO 3.1 categorias (siempre quedan activas; el orden y el nombre son los del menu aprobado)
do $do$
declare
  v_paso constant text := '3.1 categorias nuevas';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa)
  select v_rid, n.id, n.nombre, n.emoji, n.orden, true from _mr17_categorias n
  on conflict (restaurante_id, id) do update
    set nombre = excluded.nombre, emoji = excluded.emoji, orden = excluded.orden, activa = true
  -- solo si algo cambia: una corrida repetida no toca ninguna fila (ni dispara eventos de Realtime)
  where (categorias.nombre, categorias.emoji, categorias.orden, categorias.activa)
        is distinct from (excluded.nombre, excluded.emoji, excluded.orden, true);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 3.2 productos. Al re-ejecutar NO se tocan 'imagen' (la foto ya subida) ni 'disponible' (agotado).
do $do$
declare
  v_paso constant text := '3.2 productos nuevos';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  insert into public.productos (restaurante_id, id, nombre, descripcion, precio, categoria, orden)
  select v_rid, m.id, m.nombre, m.descripcion, m.precio, m.categoria, m.orden from _mr17_menu m
  on conflict (restaurante_id, id) do update
    set nombre = excluded.nombre, descripcion = excluded.descripcion, precio = excluded.precio,
        categoria = excluded.categoria, orden = excluded.orden
  -- solo si algo cambia: una corrida repetida no toca ninguna fila (ni mueve actualizado_en ni dispara Realtime)
  where (productos.nombre, productos.descripcion, productos.precio, productos.categoria, productos.orden)
        is distinct from (excluded.nombre, excluded.descripcion, excluded.precio, excluded.categoria, excluded.orden);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 4) DESACTIVAR (no borrar) LAS CATEGORIAS VIEJAS DE TAQUEIROS
-- =============================================================
-- Sus productos no se tocan: quedan en la base, fuera del menu publico y sin poder pedirse (la categoria apagada
-- los bloquea en el sitio y en el servidor). La reversa solo vuelve a encender las categorias.
do $do$
declare
  v_paso constant text := '4 desactivar categorias viejas';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  update public.categorias set activa = false
  where restaurante_id = v_rid and id not like 'nb-%' and activa is distinct from false;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 5) COMPROBACIONES (si alguna falla, TODO se revierte)
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
  insert into _mr17_valores (k, v) values ('errores_config', v_valor) on conflict (k) do update set v = excluded.v;
end
$do$;

drop table if exists pg_temp._mr17_verif;
create temp table _mr17_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr17_verif (verificacion, ok, detalle)
select * from (values
  ('el restaurante demo se llama "The Northe Burgers" y conserva id y slug "taqueiros"',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id() and r.nombre = 'The Northe Burgers' and r.slug = 'taqueiros'),
    null),

  ('publico.marca: logo, iconos, emoji, las 12 colores y colores_zonas son los de la marca nueva',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()
            and r.config #> '{publico,marca}' @> (select v.v from _mr17_valores v where v.k = 'marca')
            and jsonb_array_length(r.config #> '{publico,marca,colores_zonas}') = 4
            and (select count(*) from jsonb_object_keys(r.config #> '{publico,marca,colores}')) = 12),
    null),

  ('publico.textos: todos los textos y el seguimiento son los de la marca nueva',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()
            and r.config #> '{publico,textos}' @> (select v.v from _mr17_valores v where v.k = 'textos')),
    null),

  ('publico.contacto: redes nuevas (thenorthe.burgers) y WhatsApp, telefono y direccion intactos',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()
            and r.config #> '{publico,contacto}' @> (select v.v from _mr17_valores v where v.k = 'redes')),
    null),

  ('publico.pwa: "Panel The Northe Burgers" / "Comandas"',
    exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()
            and r.config #> '{publico,pwa}' @> (select v.v from _mr17_valores v where v.k = 'pwa')),
    null),

  ('ningun texto visible de la config dice ya Taqueiros, taco, birria, comal ni lo mexicano',
    not exists (select 1 from public.restaurantes r
                where r.id = public.restaurante_taqueiros_id()
                  and (r.nombre || ' ' || (r.config #> '{publico,marca}')::text || ' ' || (r.config #> '{publico,textos}')::text
                       || ' ' || (r.config #> '{publico,pwa}')::text || ' ' || coalesce((r.config #> '{publico,contacto,instagram}')::text, '')
                       || ' ' || coalesce((r.config #> '{publico,contacto,tiktok}')::text, ''))
                      ~* '(taqueiro|taquer|tacos?\y|birria|comal|doriloco|mexican|🌮|🌶)'),
    null),

  ('la config entera cumple las reglas de validacion de la base (SQL 13)',
    (select v.v = '[]'::jsonb or v.v = 'null'::jsonb from _mr17_valores v where v.k = 'errores_config'),
    (select case when v.v = 'null'::jsonb then 'SQL 13 no aplicado: sin validador (el trigger no existe)' when v.v <> '[]'::jsonb then left(v.v::text, 300) end
       from _mr17_valores v where v.k = 'errores_config')),

  ('4 categorias nuevas, activas, con su nombre, emoji y orden',
    (select count(*) = 4 and bool_and(c.activa) from public.categorias c join _mr17_categorias n on n.id = c.id and n.nombre = c.nombre and n.emoji = c.emoji and n.orden = c.orden
       where c.restaurante_id = public.restaurante_taqueiros_id()),
    null),

  ('13 productos nuevos con el precio, la categoria, el orden y la descripcion del menu aprobado (total 177500)',
    (select count(*) = 13 and sum(p.precio) = 177500 from public.productos p join _mr17_menu m on m.id = p.id
       and m.precio = p.precio and m.categoria = p.categoria and m.orden = p.orden and m.nombre = p.nombre and m.descripcion = p.descripcion
       where p.restaurante_id = public.restaurante_taqueiros_id()),
    null),

  ('ninguna categoria vieja de Taqueiros queda activa',
    not exists (select 1 from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.id not like 'nb-%' and c.activa),
    (select count(*)::text || ' categorias viejas desactivadas' from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.id not like 'nb-%')),

  ('no hay dos categorias activas con el mismo nombre en el menu',
    not exists (select 1 from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() and c.activa
                group by public.norm_texto(c.nombre) having count(*) > 1),
    null),

  ('el menu visible son EXACTAMENTE las 4 categorias y los 13 productos nuevos',
    (select count(*) = 13 from public.productos p join public.categorias c on c.restaurante_id = p.restaurante_id and c.id = p.categoria
       where p.restaurante_id = public.restaurante_taqueiros_id() and c.activa),
    null),

  ('informativo: productos nuevos que todavia no tienen foto (se asignan con subir-fotos-northe.mjs)',
    true,
    (select count(*) filter (where p.imagen is null)::text || ' de ' || count(*)::text || ' sin foto' from public.productos p
       where p.restaurante_id = public.restaurante_taqueiros_id() and p.id like 'nb-%'))
) as v(verificacion, ok, detalle);

-- Lo que NO debia cambiar: cada huella tiene que ser igual a la del "antes".
insert into _mr17_verif (verificacion, ok, detalle)
select 'sin cambios: ' || a.clave,
       d.huella is not distinct from a.huella,
       case when d.huella is distinct from a.huella then 'CAMBIO' end
from _mr17_antes a
left join pg_temp.mr17_huellas() d on d.clave = a.clave
order by a.clave;

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr17_verif where not ok;

  if malas is not null then
    raise exception E'EL REBRAND 17 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr17_verif
order by orden;
