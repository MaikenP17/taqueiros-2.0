-- =============================================================
-- TAQUEIROS 2.0 — OPCIONES DE PRODUCTO: QUITAR INGREDIENTES Y EXTRAS CON PRECIO  (SQL 18)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo crea una tabla y prueba permisos con roles de prueba)
--
-- ANTES DE CORRERLO
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs   (y copialo FUERA del repositorio)
--   * Los SQL 10 a 13 y el 17 (rebrand a The Northe Burgers) ya deben estar aplicados. Los 15, 16 y 16b NO hacen falta y no
--     importa si estan o no: este archivo no usa funciones sa_*, ni la vigencia, ni la tabla de auditoria.
--   * Las opciones de la semilla (paso 0.2) las propuso el consultor y Carlos debe aprobarlas ANTES de correr esto.
--     Si quieres cambiar alguna, edita la lista del paso 0.2 (una fila por opcion) y despues corre el archivo.
--
-- QUE HACE
--   1. Crea la tabla public.producto_opciones: lo que un cliente puede QUITAR de un producto ("sin cebolla", gratis) o AGREGARLE
--      ("queso extra", con precio). Una fila por opcion:
--        restaurante_id  uuid, obligatorio, SIN valor por defecto
--        producto_id     text         (el producto al que pertenece; llave foranea compuesta a productos, ON DELETE CASCADE)
--        id              text         (minusculas, numeros y guiones, p. ej. "sin-cebolla", "extra-queso"; unico dentro del producto)
--        tipo            text         ('quitar' o 'extra')
--        nombre          text         (1 a 40 caracteres, sin controles, sin invisibles, sin marcas bidireccionales, sin < ni >)
--        precio          integer      (pesos, 0 a 50000; una opcion 'quitar' SIEMPRE vale 0)
--        orden           integer      (como se ordenan al mostrarlas)
--        activa          boolean      (por defecto true; apagarla la saca del menu y el servidor ya no la acepta)
--      Llave primaria (restaurante_id, producto_id, id). Maximo 12 opciones por producto (las apagadas tambien cuentan).
--   2. Seguridad (RLS activada), con la MISMA matriz que productos y categorias (docs seccion 3 y 16.5):
--        dueno del restaurante     lee y escribe SOLO las de su restaurante
--        cajero                    solo lee las de su restaurante
--        cocina, sin membresia     nada
--        superadmin                todo
--        anon                      NADA (ni leer): igual que productos; el menu publico lo entrega el servidor (api/menu), que
--                                  lee con la llave secreta y solo muestra las opciones ACTIVAS. Abrirle esta tabla a anon
--                                  romperia la regla del SQL 10 "anon no toca ninguna tabla de negocio".
--      Triggers: el restaurante de una fila no cambia (el mismo de productos y categorias), el producto y el id tampoco, y se
--      validan nombre, tipo, precio y el tope de 12. NO se agrega a la publicacion de Realtime.
--   3. Siembra las opciones aprobadas SOLO para el restaurante demo (productos nb-*). Es ON CONFLICT DO NOTHING: volver a correr
--      el archivo no duplica nada y NO pisa lo que el dueno haya cambiado despues (un precio, una opcion apagada).
--   4. Verifica todo al final (una fila por comprobacion), incluidas pruebas con inserciones que se deshacen y con los roles
--      anon y authenticated sin membresia.
--
-- QUE NO HACE
--   * NO toca pedidos (los pedidos guardan su propia COPIA de las opciones que se eligieron; ver docs seccion 22), ni productos,
--     ni categorias, ni configuracion, ni restaurantes, ni miembros, ni nada de otros restaurantes (la comprobacion final compara
--     huellas antes y despues y, si algo cambio, SE REVIERTE).
--   * NO borra nada. NO cambia el menu que ve el cliente hasta que el servidor nuevo lea las opciones.
--
-- ABORTA SIN CAMBIAR NADA (con un mensaje claro) si:
--   * faltan tablas o funciones de los SQL 10 a 13, o no existe el restaurante demo;
--   * faltan productos nb-* del menu aprobado (corre primero el SQL 17).
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para deshacerlo: supabase/18-revertir.sql.
-- El servidor funciona ANTES de correr este archivo (un pedido sin opciones no lo necesita; uno con opciones responde un error
-- claro) y despues.
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Si fallan las comprobaciones finales, el error dice "EL SQL 18 SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA (todas deben decir OK).
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES, SEMILLA Y FOTO DEL "ANTES"
-- =============================================================

-- >>> PASO 0.1 precondiciones
do $do$
declare
  v_paso constant text := '0.1 precondiciones';
  v_item text := '';
  v_faltan text;
begin
  v_item := 'tablas';
  if to_regclass('public.restaurantes') is null or to_regclass('public.categorias') is null
     or to_regclass('public.productos') is null or to_regclass('public.pedidos') is null
     or to_regclass('public.miembros') is null then
    raise exception 'Faltan tablas (restaurantes, categorias, productos, pedidos o miembros). Corre primero los SQL 10 a 13.';
  end if;

  v_item := 'llave primaria compuesta de productos (SQL 10)';
  if not exists (select 1 from pg_constraint c
                 where c.conrelid = 'public.productos'::regclass and c.contype = 'p' and cardinality(c.conkey) = 2
                   and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
                        where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['id', 'restaurante_id']) then
    raise exception 'productos no tiene la llave primaria (restaurante_id, id). Corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'funciones del SQL 10';
  if to_regprocedure('public.es_superadmin()') is null or to_regprocedure('public.rol_en(uuid)') is null
     or to_regprocedure('public.es_servidor()') is null or to_regprocedure('public.bloquear_cambio_restaurante()') is null
     or to_regprocedure('public.restaurante_taqueiros_id()') is null then
    raise exception 'Faltan funciones del SQL 10 (es_superadmin, rol_en, es_servidor, bloquear_cambio_restaurante...). Corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'restaurante demo';
  if not exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) then
    raise exception 'No existe el restaurante demo (id 00000000-0000-4000-8000-000000000001). Este archivo solo siembra ese restaurante. No se cambio nada.';
  end if;

  v_item := 'productos nb-* (SQL 17)';
  select string_agg(x.id, ', ' order by x.id) into v_faltan
  from unnest(array['nb-big-norte', 'nb-crispy-norte', 'nb-lil-norte', 'nb-classic-norte', 'nb-smoky-norte', 'nb-full-norte',
                    'nb-creamy-norte', 'nb-dirty-norte', 'nb-chori-norte', 'nb-agua', 'nb-coca-cola', 'nb-pepsi', 'nb-sprite']) as x(id)
  where not exists (select 1 from public.productos p where p.restaurante_id = public.restaurante_taqueiros_id() and p.id = x.id);
  if v_faltan is not null then
    raise exception 'Faltan estos productos del menu de The Northe Burgers: %. Corre primero supabase/17-rebrand-northe.sql (o revisa que nadie los haya borrado). No se cambio nada.', v_faltan;
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 0.2 la semilla (UNA sola copia: el INSERT y las comprobaciones leen de aqui).
-- Salen de las descripciones REALES de los productos (supabase/17-rebrand-northe.sql): se puede QUITAR lo que la descripcion
-- menciona y que no es el producto base; nunca la carne, el pollo, la salchicha, el chorizo, el pan ni las papas.
-- Los EXTRAS son de ejemplo (pesos). Las bebidas no llevan opciones.
-- Columnas: producto, id de la opcion, tipo, nombre, precio, orden (los 'quitar' van primero, 0-9; los extras, 10 en adelante).
drop table if exists pg_temp._mr18_semilla;
create temp table _mr18_semilla (
  producto_id text not null, id text not null, tipo text not null, nombre text not null, precio integer not null, orden integer not null,
  primary key (producto_id, id)
);
insert into _mr18_semilla (producto_id, id, tipo, nombre, precio, orden) values
  -- Big Norte: "Triple carne smash, queso derretido y salsa rosa."
  ('nb-big-norte',     'sin-queso',            'quitar', 'Sin queso',            0,    0),
  ('nb-big-norte',     'sin-salsa-rosa',       'quitar', 'Sin salsa rosa',       0,    1),
  ('nb-big-norte',     'extra-queso',          'extra',  'Queso extra',          2000, 10),
  ('nb-big-norte',     'extra-tocineta',       'extra',  'Tocineta extra',       3000, 11),
  ('nb-big-norte',     'extra-carne',          'extra',  'Carne smash extra',    6000, 12),
  ('nb-big-norte',     'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Crispy Norte: "Pollo crispy bien dorado, queso, tocineta y salsa BBQ."
  ('nb-crispy-norte',  'sin-queso',            'quitar', 'Sin queso',            0,    0),
  ('nb-crispy-norte',  'sin-tocineta',         'quitar', 'Sin tocineta',         0,    1),
  ('nb-crispy-norte',  'sin-salsa-bbq',        'quitar', 'Sin salsa BBQ',        0,    2),
  ('nb-crispy-norte',  'extra-queso',          'extra',  'Queso extra',          2000, 10),
  ('nb-crispy-norte',  'extra-tocineta',       'extra',  'Tocineta extra',       3000, 11),
  ('nb-crispy-norte',  'extra-pollo',          'extra',  'Pollo crispy extra',   5000, 12),
  ('nb-crispy-norte',  'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Lil Norte: "Carne smash sencilla con tocineta crocante y salsa picante."
  ('nb-lil-norte',     'sin-tocineta',         'quitar', 'Sin tocineta',         0,    0),
  ('nb-lil-norte',     'sin-salsa-picante',    'quitar', 'Sin salsa picante',    0,    1),
  ('nb-lil-norte',     'extra-queso',          'extra',  'Queso extra',          2000, 10),
  ('nb-lil-norte',     'extra-tocineta',       'extra',  'Tocineta extra',       3000, 11),
  ('nb-lil-norte',     'extra-carne',          'extra',  'Carne smash extra',    6000, 12),
  ('nb-lil-norte',     'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Classic Norte: "Salchicha clasica con mostaza y salsas de la casa."
  ('nb-classic-norte', 'sin-mostaza',          'quitar', 'Sin mostaza',          0,    0),
  ('nb-classic-norte', 'sin-salsas',           'quitar', 'Sin salsas',           0,    1),
  ('nb-classic-norte', 'extra-salchicha',      'extra',  'Salchicha extra',      3500, 10),
  ('nb-classic-norte', 'extra-queso',          'extra',  'Queso extra',          2000, 11),
  ('nb-classic-norte', 'extra-tocineta',       'extra',  'Tocineta extra',       3000, 12),
  ('nb-classic-norte', 'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Smoky Norte: "Salchicha ahumada con salsa BBQ, cebolla morada encurtida y cebolla crujiente."
  ('nb-smoky-norte',   'sin-salsa-bbq',        'quitar', 'Sin salsa BBQ',        0,    0),
  ('nb-smoky-norte',   'sin-cebolla-morada',   'quitar', 'Sin cebolla morada',   0,    1),
  ('nb-smoky-norte',   'sin-cebolla-crujiente','quitar', 'Sin cebolla crujiente',0,   2),
  ('nb-smoky-norte',   'extra-salchicha',      'extra',  'Salchicha extra',      3500, 10),
  ('nb-smoky-norte',   'extra-queso',          'extra',  'Queso extra',          2000, 11),
  ('nb-smoky-norte',   'extra-tocineta',       'extra',  'Tocineta extra',       3000, 12),
  ('nb-smoky-norte',   'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Full Norte: "El mas cargado: salchicha con cebolla crujiente, vegetales picados y todas las salsas."
  ('nb-full-norte',    'sin-cebolla-crujiente','quitar', 'Sin cebolla crujiente',0,   0),
  ('nb-full-norte',    'sin-vegetales',        'quitar', 'Sin vegetales',        0,    1),
  ('nb-full-norte',    'sin-salsas',           'quitar', 'Sin salsas',           0,    2),
  ('nb-full-norte',    'extra-salchicha',      'extra',  'Salchicha extra',      3500, 10),
  ('nb-full-norte',    'extra-queso',          'extra',  'Queso extra',          2000, 11),
  ('nb-full-norte',    'extra-tocineta',       'extra',  'Tocineta extra',       3000, 12),
  ('nb-full-norte',    'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Creamy Norte: "Papas crinkle con pollo, cebolla, rugula y salsa cremosa."
  ('nb-creamy-norte',  'sin-cebolla',          'quitar', 'Sin cebolla',          0,    0),
  ('nb-creamy-norte',  'sin-rugula',           'quitar', 'Sin rúgula',           0,    1),
  ('nb-creamy-norte',  'sin-salsa-cremosa',    'quitar', 'Sin salsa cremosa',    0,    2),
  ('nb-creamy-norte',  'extra-queso',          'extra',  'Queso extra',          2000, 10),
  ('nb-creamy-norte',  'extra-tocineta',       'extra',  'Tocineta extra',       3000, 11),
  ('nb-creamy-norte',  'extra-pollo',          'extra',  'Pollo crispy extra',   5000, 12),
  ('nb-creamy-norte',  'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Dirty Norte: "Papas crinkle con carne en tiras, rugula y salsa blanca."
  ('nb-dirty-norte',   'sin-rugula',           'quitar', 'Sin rúgula',           0,    0),
  ('nb-dirty-norte',   'sin-salsa-blanca',     'quitar', 'Sin salsa blanca',     0,    1),
  ('nb-dirty-norte',   'extra-queso',          'extra',  'Queso extra',          2000, 10),
  ('nb-dirty-norte',   'extra-tocineta',       'extra',  'Tocineta extra',       3000, 11),
  ('nb-dirty-norte',   'extra-pollo',          'extra',  'Pollo crispy extra',   5000, 12),
  ('nb-dirty-norte',   'extra-salsa',          'extra',  'Salsa extra',          1000, 13),
  -- Chori Norte: "Papas crinkle con chorizo, pollo crispy y salsas."
  ('nb-chori-norte',   'sin-salsas',           'quitar', 'Sin salsas',           0,    0),
  ('nb-chori-norte',   'extra-queso',          'extra',  'Queso extra',          2000, 10),
  ('nb-chori-norte',   'extra-tocineta',       'extra',  'Tocineta extra',       3000, 11),
  ('nb-chori-norte',   'extra-chorizo',        'extra',  'Chorizo extra',        3500, 12),
  ('nb-chori-norte',   'extra-salsa',          'extra',  'Salsa extra',          1000, 13);
-- (Agua, Coca-Cola, Pepsi y Sprite: sin opciones.)

-- >>> PASO 0.3 la foto del "antes": huellas de todo lo que NO debe cambiar. La misma funcion se usa despues.
-- Con 'xmin' no se compara nada: se compara el contenido de las filas (texto de cada fila), igual que el SQL 17.
create or replace function pg_temp.mr18_huellas()
returns table (clave text, huella text)
language plpgsql
as $f$
begin
  return query select 'pedidos (todos)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.pedidos t;
  return query select 'productos (todos, ni una columna)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t;
  return query select 'categorias (todas, ni una columna)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t;
  return query select 'restaurantes (fila completa de todos)'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t;
  return query select 'miembros'::text,
    count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t;
  if to_regclass('public.configuracion') is not null then
    return query select 'configuracion'::text,
      count(*)::text || ':' || md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t;
  end if;
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
  return query select 'publicacion supabase_realtime (que tablas emiten eventos)'::text,
    coalesce((select string_agg(pt.schemaname || '.' || pt.tablename, ',' order by pt.schemaname, pt.tablename)
              from pg_publication_tables pt where pt.pubname = 'supabase_realtime'), '(sin publicacion)');
end
$f$;

drop table if exists pg_temp._mr18_antes;
create temp table _mr18_antes as select * from pg_temp.mr18_huellas();

-- Cuantas opciones habia ANTES en restaurantes que no son el demo (0 si la tabla no existia): este archivo no debe tocarlas.
drop table if exists pg_temp._mr18_previo;
create temp table _mr18_previo (k text primary key, v bigint not null);
do $do$
begin
  if to_regclass('public.producto_opciones') is not null then
    execute 'insert into _mr18_previo select ''fuera_del_demo'', count(*) from public.producto_opciones where restaurante_id <> public.restaurante_taqueiros_id()';
    execute 'insert into _mr18_previo select ''fuera_de_la_semilla'', count(*) from public.producto_opciones o where o.restaurante_id = public.restaurante_taqueiros_id() and not exists (select 1 from _mr18_semilla s where s.producto_id = o.producto_id and s.id = o.id)';
  else
    insert into _mr18_previo values ('fuera_del_demo', 0), ('fuera_de_la_semilla', 0);
  end if;
end
$do$;


-- =============================================================
-- >>> PASO 1) FUNCIONES: NOMBRE VALIDO Y VALIDACION DE LA FILA
-- =============================================================

-- >>> PASO 1.1 public.opcion_nombre_valido(texto): la regla del nombre en UN solo lugar (la usan el CHECK y el trigger).
-- Sin espacios en los extremos, 1 a 40 caracteres, sin controles (C0 y C1), sin ancho cero ni invisibles (U+200B-200F,
-- U+2060-2064, U+FEFF), sin controles de direccion bidi (U+202A-202E, U+2066-2069) y sin < ni >. El patron se arma con chr()
-- para que ningun editor deje caracteres invisibles escritos en este archivo.
create or replace function public.opcion_nombre_valido(p_nombre text)
returns boolean
language sql
immutable
set search_path = ''
as $f$
  select p_nombre is not null
     and p_nombre = btrim(p_nombre)
     and char_length(p_nombre) between 1 and 40
     and p_nombre !~ ('[<>' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159)
                      || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238)
                      || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279) || ']');
$f$;

-- >>> PASO 1.2 public.validar_producto_opcion(): trigger BEFORE INSERT OR UPDATE.
-- Mensajes en espanol (los ve el dueno en menu-admin). SQLSTATE 23514 (violacion de regla), 42501 para lo inmutable.
create or replace function public.validar_producto_opcion()
returns trigger
language plpgsql
set search_path = ''
as $f$
declare
  tope_opciones constant integer := 12;
  v_n integer;
begin
  -- El producto y el identificador son la identidad de la opcion (los pedidos guardan una copia con ese id): no se mueven.
  -- Para cambiarlos se borra la opcion y se crea otra. (El restaurante lo protege bloquear_cambio_restaurante.)
  if tg_op = 'UPDATE' and (new.producto_id is distinct from old.producto_id or new.id is distinct from old.id) then
    raise exception 'No se puede cambiar el producto ni el identificador de una opción' using errcode = '42501';
  end if;

  new.nombre := btrim(coalesce(new.nombre, ''));
  if new.nombre = '' then
    raise exception 'El nombre de la opción es obligatorio' using errcode = '23514';
  end if;
  if char_length(new.nombre) > 40 then
    raise exception 'El nombre de la opción no puede pasar de 40 caracteres' using errcode = '23514';
  end if;
  if not public.opcion_nombre_valido(new.nombre) then
    raise exception 'El nombre de la opción tiene caracteres no permitidos' using errcode = '23514';
  end if;

  if new.tipo is not null and new.tipo not in ('quitar', 'extra') then
    raise exception 'El tipo de la opción debe ser quitar o extra' using errcode = '23514';
  end if;
  if new.precio is not null and (new.precio < 0 or new.precio > 50000) then
    raise exception 'El precio de la opción debe estar entre $0 y $50.000' using errcode = '23514';
  end if;
  if new.tipo = 'quitar' and new.precio is not null and new.precio <> 0 then
    raise exception 'Una opción de quitar no puede tener precio' using errcode = '23514';
  end if;

  -- Tope de opciones por producto. El candado serializa dos altas simultaneas del mismo producto (si no, las dos podrian
  -- ver 11 y entrar, y quedarian 13). Cuentan tambien las apagadas.
  if tg_op = 'INSERT' and new.restaurante_id is not null and new.producto_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(new.restaurante_id::text || '/' || new.producto_id, 18));
    select count(*) into v_n from public.producto_opciones o
    where o.restaurante_id = new.restaurante_id and o.producto_id = new.producto_id;
    if v_n >= tope_opciones then
      raise exception 'Un producto no puede tener más de % opciones', tope_opciones using errcode = '23514';
    end if;
  end if;

  return new;
end;
$f$;

-- >>> PASO 1.3 permisos de las dos funciones. El CHECK llama a opcion_nombre_valido con los permisos de QUIEN escribe, asi que
-- authenticated necesita EXECUTE; anon nada (no puede ni tocar la tabla).
do $do$
declare
  v_paso constant text := '1.3 permisos de las funciones';
  v_item text := '';
  f text;
begin
  foreach f in array array['public.opcion_nombre_valido(text)', 'public.validar_producto_opcion()'] loop
    v_item := f;
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) LA TABLA producto_opciones
-- =============================================================
-- Si ya existe (segunda corrida) no se toca: sus restricciones, triggers y politicas se re-afirman y se comprueban abajo.
do $do$
declare
  v_paso constant text := '2 crear producto_opciones';
  v_item text := 'public.producto_opciones';
begin
  if to_regclass('public.producto_opciones') is null then
    create table public.producto_opciones (
      restaurante_id uuid    not null references public.restaurantes (id),
      producto_id    text    not null,
      id             text    not null,
      tipo           text    not null,
      nombre         text    not null,
      precio         integer not null default 0,
      orden          integer not null default 0,
      activa         boolean not null default true,
      constraint producto_opciones_pkey primary key (restaurante_id, producto_id, id),
      constraint producto_opciones_producto_fkey foreign key (restaurante_id, producto_id)
        references public.productos (restaurante_id, id) on delete cascade,
      constraint producto_opciones_id_formato check (id ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
      constraint producto_opciones_tipo_valido check (tipo in ('quitar', 'extra')),
      constraint producto_opciones_nombre_valido check (public.opcion_nombre_valido(nombre)),
      constraint producto_opciones_precio_rango check (precio between 0 and 50000),
      constraint producto_opciones_quitar_gratis check (tipo <> 'quitar' or precio = 0)
    );
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- Para leer "las opciones activas de un producto" y "las de este restaurante" (la llave primaria ya cubre restaurante + producto).
create index if not exists producto_opciones_restaurante_orden_idx
  on public.producto_opciones (restaurante_id, producto_id, orden);


-- =============================================================
-- >>> PASO 3) TRIGGERS (los mismos de productos y categorias, mas la validacion propia)
-- =============================================================
do $do$
declare
  v_paso constant text := '3 triggers de producto_opciones';
  v_item text := '';
begin
  v_item := 'producto_opciones_restaurante_inmutable';
  drop trigger if exists producto_opciones_restaurante_inmutable on public.producto_opciones;
  create trigger producto_opciones_restaurante_inmutable
    before update on public.producto_opciones
    for each row execute function public.bloquear_cambio_restaurante();

  v_item := 'producto_opciones_validar';
  drop trigger if exists producto_opciones_validar on public.producto_opciones;
  create trigger producto_opciones_validar
    before insert or update on public.producto_opciones
    for each row execute function public.validar_producto_opcion();
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 4) SEGURIDAD: RLS, POLITICAS Y PRIVILEGIOS
-- =============================================================
alter table public.producto_opciones enable row level security;

-- >>> PASO 4.1 fuera TODA politica anterior (por OID del catalogo) y se recrean las cuatro de abajo
do $do$
declare
  v_paso constant text := '4.1 politicas de producto_opciones';
  v_item text := '';
  r record;
begin
  for r in select p.polname from pg_policy p where p.polrelid = 'public.producto_opciones'::regclass loop
    v_item := r.polname;
    execute format('drop policy %I on public.producto_opciones', r.polname);
  end loop;

  -- leen dueno y cajero (y el superadmin); la cocina y quien no es del restaurante, nada
  v_item := 'mr_opciones_select';
  create policy mr_opciones_select on public.producto_opciones for select to authenticated
    using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
  -- escribe SOLO el dueno de ESE restaurante (rol_en mira la membresia en la fila, no en otro restaurante)
  v_item := 'mr_opciones_insert';
  create policy mr_opciones_insert on public.producto_opciones for insert to authenticated
    with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
  v_item := 'mr_opciones_update';
  create policy mr_opciones_update on public.producto_opciones for update to authenticated
    using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')
    with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
  v_item := 'mr_opciones_delete';
  create policy mr_opciones_delete on public.producto_opciones for delete to authenticated
    using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 4.2 privilegios de tabla. En Supabase las tablas nuevas de public nacen con privilegios para anon y authenticated
-- (ALTER DEFAULT PRIVILEGES): se quitan. anon no toca nada; authenticated lee y escribe (lo limitan las politicas) pero no
-- trunca ni crea referencias ni triggers.
do $do$
declare
  v_paso constant text := '4.2 privilegios de producto_opciones';
  v_item text := 'public.producto_opciones';
begin
  revoke all on table public.producto_opciones from public, anon;
  revoke all on table public.producto_opciones from authenticated;
  grant select, insert, update, delete on table public.producto_opciones to authenticated;
  grant all on table public.producto_opciones to service_role;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;
-- (NO se agrega a la publicacion supabase_realtime: nadie se suscribe a esta tabla. El panel la lee cuando la necesita.)


-- =============================================================
-- >>> PASO 5) SEMILLA: las opciones aprobadas, SOLO para el restaurante demo
-- =============================================================
-- ON CONFLICT DO NOTHING: no duplica y no pisa lo que se haya cambiado despues de la primera corrida.
do $do$
declare
  v_paso constant text := '5 sembrar las opciones del demo';
  v_item text := '';
  v_rid constant uuid := public.restaurante_taqueiros_id();
begin
  insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, orden, activa)
  select v_rid, s.producto_id, s.id, s.tipo, s.nombre, s.precio, s.orden, true
  from _mr18_semilla s
  order by s.producto_id, s.orden
  on conflict (restaurante_id, producto_id, id) do nothing;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 6) PRUEBAS CON INSERCIONES QUE SE DESHACEN (no queda ningun dato de prueba)
-- =============================================================
-- Se crean dos restaurantes de prueba (con una categoria y un producto cada uno), se prueban las reglas y los permisos de
-- anon y de un usuario sin membresia, y al final se provoca un error a proposito para deshacerlo todo.
drop table if exists pg_temp._mr18_func;
create temp table _mr18_func (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '6 pruebas de reglas y permisos';
  v_item text := '';
  v_a uuid;
  v_b uuid;
  v_res jsonb := '{}'::jsonb;
  v_cod text;
  v_n bigint;
  v_t text;
begin
  begin
    v_item := 'restaurantes de prueba';
    insert into public.restaurantes (slug, nombre, config) values ('mr18-prueba-a', 'Prueba MR18 A', '{}') returning id into v_a;
    insert into public.restaurantes (slug, nombre, config) values ('mr18-prueba-b', 'Prueba MR18 B', '{}') returning id into v_b;
    insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa) values (v_a, 'cat-a', 'Cat A', 'x', 0, true), (v_b, 'cat-b', 'Cat B', 'x', 0, true);
    insert into public.productos (restaurante_id, id, nombre, descripcion, precio, categoria, orden) values
      (v_a, 'prod-a', 'Prod A', 'a', 10000, 'cat-a', 0), (v_a, 'prod-a2', 'Prod A2', 'a', 10000, 'cat-a', 1), (v_b, 'prod-b', 'Prod B', 'b', 10000, 'cat-b', 0);

    -- 1) una opcion valida de cada tipo entra, y el nombre se recorta (espacios de los extremos)
    v_item := 'opciones validas';
    insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values
      (v_a, 'prod-a', 'sin-cebolla', 'quitar', '  Sin cebolla  ', 0), (v_a, 'prod-a', 'extra-queso', 'extra', 'Queso extra', 2000);
    v_res := v_res || jsonb_build_object('validas', jsonb_build_object('ok',
      (select count(*) = 2 and bool_and(nombre = btrim(nombre)) and bool_and(activa) and bool_and(orden = 0) from public.producto_opciones where restaurante_id = v_a), 'detalle', null));

    -- 2) cada regla rechaza con 23514 (violacion de regla) y no deja nada
    v_item := 'reglas';
    v_cod := '';
    foreach v_t in array array[
      'quitar con precio#insert into public.producto_opciones values (''%A%'',''prod-a'',''x1'',''quitar'',''Sin algo'',500,0,true)',
      'precio negativo#insert into public.producto_opciones values (''%A%'',''prod-a'',''x2'',''extra'',''Algo'',-1,0,true)',
      'precio sobre el tope#insert into public.producto_opciones values (''%A%'',''prod-a'',''x3'',''extra'',''Algo'',50001,0,true)',
      'tipo desconocido#insert into public.producto_opciones values (''%A%'',''prod-a'',''x4'',''otro'',''Algo'',0,0,true)',
      'id con mayusculas#insert into public.producto_opciones values (''%A%'',''prod-a'',''Sin-Cebolla'',''quitar'',''Algo'',0,0,true)',
      'id con espacio#insert into public.producto_opciones values (''%A%'',''prod-a'',''sin cebolla'',''quitar'',''Algo'',0,0,true)',
      'id vacio#insert into public.producto_opciones values (''%A%'',''prod-a'','''',''quitar'',''Algo'',0,0,true)',
      'id que empieza con guion#insert into public.producto_opciones values (''%A%'',''prod-a'',''-x'',''quitar'',''Algo'',0,0,true)',
      'id de 61 caracteres#insert into public.producto_opciones values (''%A%'',''prod-a'',repeat(''a'',61),''quitar'',''Algo'',0,0,true)',
      'nombre vacio#insert into public.producto_opciones values (''%A%'',''prod-a'',''x5'',''quitar'','''',0,0,true)',
      'nombre solo espacios#insert into public.producto_opciones values (''%A%'',''prod-a'',''x6'',''quitar'',''   '',0,0,true)',
      'nombre de 41 caracteres#insert into public.producto_opciones values (''%A%'',''prod-a'',''x7'',''quitar'',repeat(''a'',41),0,0,true)',
      'nombre con salto de linea#insert into public.producto_opciones values (''%A%'',''prod-a'',''x8'',''quitar'',''Sin'' || chr(10) || ''algo'',0,0,true)',
      'nombre con tabulador#insert into public.producto_opciones values (''%A%'',''prod-a'',''x9'',''quitar'',''Sin'' || chr(9) || ''algo'',0,0,true)',
      'nombre con control C1#insert into public.producto_opciones values (''%A%'',''prod-a'',''xa'',''quitar'',''Sin'' || chr(133) || ''algo'',0,0,true)',
      'nombre con ancho cero#insert into public.producto_opciones values (''%A%'',''prod-a'',''xb'',''quitar'',''Sin'' || chr(8203) || ''algo'',0,0,true)',
      'nombre con bidi#insert into public.producto_opciones values (''%A%'',''prod-a'',''xc'',''quitar'',''Sin'' || chr(8238) || ''algo'',0,0,true)',
      'nombre con BOM#insert into public.producto_opciones values (''%A%'',''prod-a'',''xd'',''quitar'',''Sin'' || chr(65279) || ''algo'',0,0,true)',
      'nombre con signos de HTML#insert into public.producto_opciones values (''%A%'',''prod-a'',''xe'',''quitar'',''Sin <b>algo</b>'',0,0,true)'
    ] loop
      begin
        execute replace(split_part(v_t, '#', 2), '%A%', v_a::text);
        v_cod := v_cod || '[acepto ' || split_part(v_t, '#', 1) || ']';
      exception when others then
        if sqlstate <> '23514' then v_cod := v_cod || '[' || split_part(v_t, '#', 1) || ' dio ' || sqlstate || ']'; end if;
      end;
    end loop;
    v_res := v_res || jsonb_build_object('reglas', jsonb_build_object('ok', v_cod = '' and (select count(*) = 2 from public.producto_opciones where restaurante_id = v_a), 'detalle', v_cod));

    -- 3) un nombre con el tope exacto (40) y con tildes y enie entra
    v_item := 'nombre limite';
    insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values
      (v_a, 'prod-a2', 'largo', 'extra', repeat('ñ', 40), 50000);
    v_res := v_res || jsonb_build_object('nombre_limite', jsonb_build_object('ok',
      (select nombre = repeat('ñ', 40) and precio = 50000 from public.producto_opciones where restaurante_id = v_a and producto_id = 'prod-a2' and id = 'largo'), 'detalle', null));

    -- 4) el tope de 12 opciones por producto (cuentan las apagadas): la 13 se rechaza con 23514
    v_item := 'tope de 12';
    insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, activa)
    select v_a, 'prod-a2', 'op-' || g, 'extra', 'Op ' || g, 100, g % 2 = 0 from generate_series(1, 11) g;
    v_cod := '';
    begin
      insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (v_a, 'prod-a2', 'op-13', 'extra', 'Op 13', 100);
      v_cod := 'acepto la 13';
    exception when others then
      if sqlstate <> '23514' then v_cod := sqlstate; end if;
    end;
    -- pero otro producto del mismo restaurante y el de otro restaurante siguen aceptando las suyas
    insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (v_a, 'prod-a', 'otra', 'extra', 'Otra', 100), (v_b, 'prod-b', 'b1', 'extra', 'B uno', 100);
    v_res := v_res || jsonb_build_object('tope_12', jsonb_build_object('ok', v_cod = '' and (select count(*) = 12 from public.producto_opciones where restaurante_id = v_a and producto_id = 'prod-a2'), 'detalle', v_cod));

    -- 5) producto de otro restaurante: la llave foranea compuesta lo rechaza (23503); sin restaurante: 23502
    v_item := 'cruce de restaurantes';
    v_cod := '';
    begin
      insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (v_b, 'prod-a', 'cruce', 'extra', 'Cruce', 100);
      v_cod := '[acepto producto de otro restaurante]';
    exception when others then
      if sqlstate <> '23503' then v_cod := '[cruce dio ' || sqlstate || ']'; end if;
    end;
    begin
      insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (null, 'prod-a', 'sin-rest', 'extra', 'Sin restaurante', 100);
      v_cod := v_cod || '[acepto sin restaurante]';
    exception when others then
      if sqlstate <> '23502' then v_cod := v_cod || '[sin restaurante dio ' || sqlstate || ']'; end if;
    end;
    begin
      insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (v_a, 'no-existe', 'x', 'extra', 'Algo', 100);
      v_cod := v_cod || '[acepto un producto que no existe]';
    exception when others then
      if sqlstate <> '23503' then v_cod := v_cod || '[producto inexistente dio ' || sqlstate || ']'; end if;
    end;
    v_res := v_res || jsonb_build_object('cruce_restaurantes', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    -- 6) la identidad no se mueve: restaurante, producto e id (42501); el precio y el nombre si se pueden cambiar
    v_item := 'identidad inmutable';
    v_cod := '';
    begin
      update public.producto_opciones set restaurante_id = v_b where restaurante_id = v_a and producto_id = 'prod-a' and id = 'extra-queso';
      v_cod := '[cambio el restaurante]';
    exception when others then
      if sqlstate not in ('42501', '23503') then v_cod := v_cod || '[restaurante dio ' || sqlstate || ']'; end if;
    end;
    begin
      update public.producto_opciones set producto_id = 'prod-a2' where restaurante_id = v_a and producto_id = 'prod-a' and id = 'extra-queso';
      v_cod := v_cod || '[cambio el producto]';
    exception when others then
      if sqlstate <> '42501' then v_cod := v_cod || '[producto dio ' || sqlstate || ']'; end if;
    end;
    begin
      update public.producto_opciones set id = 'otro-id' where restaurante_id = v_a and producto_id = 'prod-a' and id = 'extra-queso';
      v_cod := v_cod || '[cambio el id]';
    exception when others then
      if sqlstate <> '42501' then v_cod := v_cod || '[id dio ' || sqlstate || ']'; end if;
    end;
    update public.producto_opciones set precio = 2500, nombre = 'Queso doble', activa = false where restaurante_id = v_a and producto_id = 'prod-a' and id = 'extra-queso';
    -- un quitar no puede volverse de pago con un UPDATE
    begin
      update public.producto_opciones set precio = 100 where restaurante_id = v_a and producto_id = 'prod-a' and id = 'sin-cebolla';
      v_cod := v_cod || '[un quitar acepto precio]';
    exception when others then
      if sqlstate <> '23514' then v_cod := v_cod || '[quitar con precio dio ' || sqlstate || ']'; end if;
    end;
    v_res := v_res || jsonb_build_object('identidad', jsonb_build_object('ok', v_cod = ''
      and (select precio = 2500 and nombre = 'Queso doble' and not activa from public.producto_opciones where restaurante_id = v_a and producto_id = 'prod-a' and id = 'extra-queso'), 'detalle', v_cod));

    -- 7) anon no puede ni leer ni escribir (ni siquiera hay politica: no tiene privilegios sobre la tabla)
    v_item := 'anon';
    v_cod := '';
    begin
      set local role anon;
      perform 1 from public.producto_opciones limit 1;
      v_cod := '[anon leyo]';
    exception when others then
      if sqlstate <> '42501' then v_cod := v_cod || '[anon leer dio ' || sqlstate || ']'; end if;
    end;
    reset role;
    begin
      set local role anon;
      insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (v_a, 'prod-a', 'anon', 'extra', 'Anon', 0);
      v_cod := v_cod || '[anon inserto]';
    exception when others then
      if sqlstate <> '42501' then v_cod := v_cod || '[anon insertar dio ' || sqlstate || ']'; end if;
    end;
    reset role;
    begin
      set local role anon;
      update public.producto_opciones set precio = 0;
      v_cod := v_cod || '[anon actualizo]';
    exception when others then
      if sqlstate <> '42501' then v_cod := v_cod || '[anon actualizar dio ' || sqlstate || ']'; end if;
    end;
    reset role;
    begin
      set local role anon;
      delete from public.producto_opciones;
      v_cod := v_cod || '[anon borro]';
    exception when others then
      if sqlstate <> '42501' then v_cod := v_cod || '[anon borrar dio ' || sqlstate || ']'; end if;
    end;
    reset role;
    v_res := v_res || jsonb_build_object('anon', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    -- 8) un usuario autenticado SIN membresia: no ve ninguna fila y no puede escribir ni cambiar ni borrar
    v_item := 'autenticado sin membresia';
    v_cod := '';
    select count(*) into v_n from public.producto_opciones where restaurante_id in (v_a, v_b);
    begin
      set local role authenticated;
      perform set_config('request.jwt.claims', '{"sub":"99999999-9999-4999-8999-999999999999","role":"authenticated"}', true);
      select count(*) into v_n from public.producto_opciones;
      if v_n <> 0 then v_cod := v_cod || '[vio ' || v_n || ' filas]'; end if;
      begin
        insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values (v_a, 'prod-a', 'intruso', 'extra', 'Intruso', 0);
        v_cod := v_cod || '[inserto]';
      exception when others then
        if sqlstate <> '42501' then v_cod := v_cod || '[insertar dio ' || sqlstate || ']'; end if;
      end;
      update public.producto_opciones set precio = 0;
      get diagnostics v_n = row_count;
      if v_n <> 0 then v_cod := v_cod || '[actualizo ' || v_n || ']'; end if;
      delete from public.producto_opciones;
      get diagnostics v_n = row_count;
      if v_n <> 0 then v_cod := v_cod || '[borro ' || v_n || ']'; end if;
    exception when others then
      v_cod := v_cod || '[error ' || sqlstate || ']';
    end;
    reset role;
    v_res := v_res || jsonb_build_object('sin_membresia', jsonb_build_object('ok', v_cod = '' and (select count(*) from public.producto_opciones where restaurante_id in (v_a, v_b)) = 16, 'detalle', v_cod));

    -- 9) borrar un producto borra sus opciones (cascada); las de otros productos quedan
    v_item := 'cascada';
    delete from public.productos where restaurante_id = v_a and id = 'prod-a2';
    v_res := v_res || jsonb_build_object('cascada', jsonb_build_object('ok',
      not exists (select 1 from public.producto_opciones where restaurante_id = v_a and producto_id = 'prod-a2')
      and (select count(*) from public.producto_opciones where restaurante_id = v_a and producto_id = 'prod-a') = 3
      and (select count(*) from public.producto_opciones where restaurante_id = v_b) = 1, 'detalle', null));

    -- 10) defensa en capas: con el trigger APAGADO, los CHECK de la tabla solos frenan lo grave (23514)
    v_item := 'CHECK sin trigger';
    alter table public.producto_opciones disable trigger producto_opciones_validar;
    v_cod := '';
    foreach v_t in array array[
      'quitar con precio#insert into public.producto_opciones values (''%A%'',''prod-a'',''k1'',''quitar'',''Sin algo'',500,0,true)',
      'precio negativo#insert into public.producto_opciones values (''%A%'',''prod-a'',''k2'',''extra'',''Algo'',-1,0,true)',
      'precio sobre el tope#insert into public.producto_opciones values (''%A%'',''prod-a'',''k3'',''extra'',''Algo'',50001,0,true)',
      'tipo desconocido#insert into public.producto_opciones values (''%A%'',''prod-a'',''k4'',''otro'',''Algo'',0,0,true)',
      'id con mayusculas#insert into public.producto_opciones values (''%A%'',''prod-a'',''K5'',''extra'',''Algo'',0,0,true)',
      'nombre con bidi#insert into public.producto_opciones values (''%A%'',''prod-a'',''k6'',''extra'',''a'' || chr(8238) || ''b'',0,0,true)',
      'nombre con espacios de borde#insert into public.producto_opciones values (''%A%'',''prod-a'',''k7'',''extra'','' con borde '',0,0,true)',
      'nombre vacio#insert into public.producto_opciones values (''%A%'',''prod-a'',''k8'',''extra'','''',0,0,true)',
      'nombre de 41#insert into public.producto_opciones values (''%A%'',''prod-a'',''k9'',''extra'',repeat(''a'',41),0,0,true)',
      'nombre con signos de HTML#insert into public.producto_opciones values (''%A%'',''prod-a'',''ka'',''extra'',''a<b'',0,0,true)'
    ] loop
      begin
        execute replace(split_part(v_t, '#', 2), '%A%', v_a::text);
        v_cod := v_cod || '[acepto ' || split_part(v_t, '#', 1) || ']';
      exception when others then
        if sqlstate <> '23514' then v_cod := v_cod || '[' || split_part(v_t, '#', 1) || ' dio ' || sqlstate || ']'; end if;
      end;
    end loop;
    alter table public.producto_opciones enable trigger producto_opciones_validar;
    v_res := v_res || jsonb_build_object('checks_solos', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    raise exception 'mr18_fin %', v_res::text using errcode = 'P0001';
  exception when others then
    if sqlerrm like 'mr18_fin %' then
      insert into _mr18_func select e.key, (e.value ->> 'ok')::boolean, left(e.value ->> 'detalle', 300) from jsonb_each(substr(sqlerrm, 10)::jsonb) e;
    else
      raise exception '% (en la prueba "%")', sqlerrm, v_item using errcode = sqlstate;
    end if;
  end;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 7) COMPROBACIONES  (una fila por verificacion: OK o FALLA; si alguna falla, TODO se revierte)
-- =============================================================
drop table if exists pg_temp._mr18_verif;
create temp table _mr18_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr18_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  -- ---------- la tabla ----------
  ('la tabla existe, tiene RLS activada y es de public',
    exists (select 1 from pg_class c where c.oid = 'public.producto_opciones'::regclass and c.relkind = 'r' and c.relrowsecurity),
    null),

  ('columnas exactas: restaurante_id uuid, producto_id, id, tipo, nombre text, precio y orden integer, activa boolean (8, sin otras)',
    (select array_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || case when a.attnotnull then 'nn' else 'null' end order by a.attnum)
       = array['restaurante_id:uuid:nn', 'producto_id:text:nn', 'id:text:nn', 'tipo:text:nn', 'nombre:text:nn', 'precio:integer:nn', 'orden:integer:nn', 'activa:boolean:nn']
     from pg_attribute a where a.attrelid = 'public.producto_opciones'::regclass and a.attnum > 0 and not a.attisdropped),
    null),

  ('restaurante_id NO tiene valor por defecto (un insert que lo olvide falla, no cae en otro restaurante)',
    not exists (select 1 from pg_attribute a where a.attrelid = 'public.producto_opciones'::regclass and a.attname = 'restaurante_id' and a.atthasdef),
    null),

  ('valores por defecto: precio 0, orden 0 y activa true (y ninguna otra columna tiene)',
    (select array_agg(a.attname::text || '=' || pg_get_expr(d.adbin, d.adrelid) order by a.attname)
       = array['activa=true', 'orden=0', 'precio=0']
     from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.producto_opciones'::regclass and not a.attisdropped),
    null),

  ('llave primaria (restaurante_id, producto_id, id)',
    exists (select 1 from pg_constraint c
            where c.conrelid = 'public.producto_opciones'::regclass and c.contype = 'p'
              and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = array['restaurante_id', 'producto_id', 'id']),
    null),

  ('llave foranea compuesta (restaurante_id, producto_id) -> productos (restaurante_id, id) con ON DELETE CASCADE',
    exists (select 1 from pg_constraint c
            where c.conrelid = 'public.producto_opciones'::regclass and c.contype = 'f' and c.confrelid = 'public.productos'::regclass
              and c.confdeltype = 'c' and cardinality(c.conkey) = 2
              and (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = array['restaurante_id', 'producto_id']
              and (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) = array['restaurante_id', 'id']),
    null),

  ('llave foranea de restaurante_id a restaurantes (como en el resto de las tablas de negocio)',
    exists (select 1 from pg_constraint c
            where c.conrelid = 'public.producto_opciones'::regclass and c.contype = 'f' and c.confrelid = 'public.restaurantes'::regclass),
    null),

  ('las 5 restricciones CHECK existen: id, tipo, nombre, precio (0 a 50000) y "quitar vale 0"',
    (select count(*) = 5 from pg_constraint c
     where c.conrelid = 'public.producto_opciones'::regclass and c.contype = 'c'
       and c.conname in ('producto_opciones_id_formato', 'producto_opciones_tipo_valido', 'producto_opciones_nombre_valido',
                         'producto_opciones_precio_rango', 'producto_opciones_quitar_gratis')
       and c.convalidated),
    null),

  -- ---------- triggers y funciones ----------
  ('triggers activos: producto_opciones_restaurante_inmutable (update) y producto_opciones_validar (insert, update)',
    (select count(*) = 2 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
     where t.tgrelid = 'public.producto_opciones'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
       and ((t.tgname = 'producto_opciones_restaurante_inmutable' and f.proname = 'bloquear_cambio_restaurante' and (t.tgtype & 16) = 16 and (t.tgtype & 4) = 0)
         or (t.tgname = 'producto_opciones_validar' and f.proname = 'validar_producto_opcion' and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16))),
    null),

  ('el trigger de restaurante inmutable es el mismo que usan productos y categorias',
    (select count(distinct t.tgfoid) = 1 from pg_trigger t
     where not t.tgisinternal and t.tgname in ('producto_opciones_restaurante_inmutable', 'productos_restaurante_inmutable', 'categorias_restaurante_inmutable')),
    null),

  ('las funciones nuevas no son SECURITY DEFINER, tienen search_path fijo, authenticated puede ejecutarlas y anon no',
    (select count(*) = 2 from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('opcion_nombre_valido', 'validar_producto_opcion')
       and not p.prosecdef and p.proconfig is not null and exists (select 1 from unnest(p.proconfig) x where x like 'search_path=%')
       and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')),
    null),

  -- ---------- seguridad ----------
  ('exactamente 4 politicas, todas solo para authenticated (ninguna para anon ni PUBLIC)',
    (select count(*) = 4 and bool_and(pg_policies.roles = array['authenticated']::name[]) and count(distinct cmd) = 4
     from pg_policies where schemaname = 'public' and tablename = 'producto_opciones'),
    (select string_agg(policyname || ':' || cmd, ', ' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'producto_opciones')),

  ('leer: superadmin, dueno y cajero; nadie mas (ni cocina)',
    (select count(*) = 1 from pg_policies where schemaname = 'public' and tablename = 'producto_opciones' and cmd = 'SELECT'
       and qual like '%es_superadmin%' and qual like '%rol_en%' and qual like '%dueno%' and qual like '%cajero%' and qual not like '%cocina%'),
    null),

  ('escribir (insertar, cambiar, borrar): superadmin y SOLO el dueno; ni cajero ni cocina',
    (select count(*) = 3 from pg_policies where schemaname = 'public' and tablename = 'producto_opciones' and cmd in ('INSERT', 'UPDATE', 'DELETE')
       and coalesce(qual, '') || coalesce(with_check, '') like '%es_superadmin%' and coalesce(qual, '') || coalesce(with_check, '') like '%rol_en%'
       and coalesce(qual, '') || coalesce(with_check, '') like '%dueno%'
       and coalesce(qual, '') || coalesce(with_check, '') not like '%cajero%' and coalesce(qual, '') || coalesce(with_check, '') not like '%cocina%'),
    null),

  ('cada politica mide la membresia en la PROPIA fila (rol_en(restaurante_id)): ningun cruce entre restaurantes',
    (select bool_and(coalesce(qual, '') || coalesce(with_check, '') ~ 'rol_en\(([a-z_]+\.)*restaurante_id\)')
     from pg_policies where schemaname = 'public' and tablename = 'producto_opciones'),
    null),

  ('anon: sin ningun privilegio sobre la tabla ni sobre sus columnas',
    not has_table_privilege('anon', 'public.producto_opciones', 'select,insert,update,delete,truncate,references,trigger')
      and not exists (select 1 from pg_attribute a where a.attrelid = 'public.producto_opciones'::regclass and a.attnum > 0 and not a.attisdropped
                      and (has_column_privilege('anon', a.attrelid, a.attnum, 'select') or has_column_privilege('anon', a.attrelid, a.attnum, 'insert')
                           or has_column_privilege('anon', a.attrelid, a.attnum, 'update') or has_column_privilege('anon', a.attrelid, a.attnum, 'references'))),
    null),

  ('authenticated: leer y escribir (las politicas deciden) pero no truncar, ni referencias, ni triggers',
    has_table_privilege('authenticated', 'public.producto_opciones', 'select')
      and has_table_privilege('authenticated', 'public.producto_opciones', 'insert')
      and has_table_privilege('authenticated', 'public.producto_opciones', 'update')
      and has_table_privilege('authenticated', 'public.producto_opciones', 'delete')
      and not has_table_privilege('authenticated', 'public.producto_opciones', 'truncate')
      and not has_table_privilege('authenticated', 'public.producto_opciones', 'references')
      and not has_table_privilege('authenticated', 'public.producto_opciones', 'trigger'),
    null),

  ('no esta en la publicacion de Realtime (supabase_realtime)',
    not exists (select 1 from pg_publication_tables pt where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' and pt.tablename = 'producto_opciones'),
    null),

  ('anon sigue sin privilegios sobre NINGUNA tabla de public (la regla del SQL 10 se mantiene)',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('ninguna politica de public alcanza a anon ni a PUBLIC',
    not exists (select 1 from pg_policies where schemaname = 'public' and roles && array['anon'::name, 'public'::name]),
    null),

  -- ---------- las pruebas con inserciones deshechas ----------
  ('opciones validas entran (el nombre se recorta, activa por defecto, orden 0)', (select f.ok from _mr18_func f where f.k = 'validas'), (select f.detalle from _mr18_func f where f.k = 'validas')),
  ('19 reglas rechazan con 23514: quitar con precio, precio negativo o sobre 50000, tipo, id mal formado, nombre vacio / largo / con controles / invisibles / bidi / HTML',
    (select f.ok from _mr18_func f where f.k = 'reglas'), (select f.detalle from _mr18_func f where f.k = 'reglas')),
  ('un nombre de exactamente 40 caracteres (con enie) y precio 50000 entran', (select f.ok from _mr18_func f where f.k = 'nombre_limite'), (select f.detalle from _mr18_func f where f.k = 'nombre_limite')),
  ('maximo 12 opciones por producto (la 13 se rechaza; otros productos siguen aceptando)', (select f.ok from _mr18_func f where f.k = 'tope_12'), (select f.detalle from _mr18_func f where f.k = 'tope_12')),
  ('un producto de otro restaurante, uno inexistente o ningun restaurante: rechazados (23503 / 23502)', (select f.ok from _mr18_func f where f.k = 'cruce_restaurantes'), (select f.detalle from _mr18_func f where f.k = 'cruce_restaurantes')),
  ('restaurante, producto e id no se pueden mover; precio, nombre y activa si; un quitar no se vuelve de pago', (select f.ok from _mr18_func f where f.k = 'identidad'), (select f.detalle from _mr18_func f where f.k = 'identidad')),
  ('anon no puede leer, insertar, cambiar ni borrar (42501)', (select f.ok from _mr18_func f where f.k = 'anon'), (select f.detalle from _mr18_func f where f.k = 'anon')),
  ('un usuario autenticado sin membresia no ve ninguna fila y no puede insertar, cambiar ni borrar', (select f.ok from _mr18_func f where f.k = 'sin_membresia'), (select f.detalle from _mr18_func f where f.k = 'sin_membresia')),
  ('borrar un producto borra sus opciones (cascada) y deja las de los demas', (select f.ok from _mr18_func f where f.k = 'cascada'), (select f.detalle from _mr18_func f where f.k = 'cascada')),
  ('defensa en capas: con el trigger apagado, los CHECK solos frenan quitar con precio, precio fuera de 0-50000, tipo, id, nombre con bidi / vacio / largo / HTML / espacios de borde',
    (select f.ok from _mr18_func f where f.k = 'checks_solos'), (select f.detalle from _mr18_func f where f.k = 'checks_solos')),
  ('las pruebas no dejaron restaurantes de prueba',
    not exists (select 1 from public.restaurantes r where r.slug like 'mr18-prueba%'), null),

  -- ---------- la semilla ----------
  ('la semilla esta completa: las 57 opciones aprobadas existen en el demo (21 quitar y 36 extras)',
    (select count(*) = 57 and count(*) filter (where o.tipo = 'quitar') = 21 and count(*) filter (where o.tipo = 'extra') = 36
     from _mr18_semilla s join public.producto_opciones o
       on o.restaurante_id = public.restaurante_taqueiros_id() and o.producto_id = s.producto_id and o.id = s.id and o.tipo = s.tipo),
    null),

  ('la semilla cubre 9 productos (hamburguesas, hot dogs y papas), de 5 a 7 opciones cada uno, y ninguna de las 4 bebidas',
    (select count(*) = 9 and min(n) >= 5 and max(n) <= 7 from (select count(*) n from _mr18_semilla s group by s.producto_id) x)
      and not exists (select 1 from _mr18_semilla s where s.producto_id in ('nb-agua', 'nb-coca-cola', 'nb-pepsi', 'nb-sprite')),
    (select string_agg(x.producto_id || '=' || x.n, ', ' order by x.producto_id) from
      (select o.producto_id, count(*) n from public.producto_opciones o where o.restaurante_id = public.restaurante_taqueiros_id() group by o.producto_id) x)),

  ('este archivo no sembro ni cambio nada fuera de la semilla del demo (las opciones de otros restaurantes y las extra del demo siguen igual)',
    (select count(*) from public.producto_opciones o where o.restaurante_id <> public.restaurante_taqueiros_id()) = (select p.v from _mr18_previo p where p.k = 'fuera_del_demo')
      and (select count(*) from public.producto_opciones o where o.restaurante_id = public.restaurante_taqueiros_id() and not exists
             (select 1 from _mr18_semilla s where s.producto_id = o.producto_id and s.id = o.id)) = (select p.v from _mr18_previo p where p.k = 'fuera_de_la_semilla'),
    null),

  ('toda opcion "quitar" del demo vale 0 y todo extra esta entre $1.000 y $6.000 (la semilla)',
    (select bool_and(case when s.tipo = 'quitar' then s.precio = 0 else s.precio between 1000 and 6000 end) from _mr18_semilla s),
    null),

  ('informativo: opciones activas / apagadas del demo ahora mismo',
    true,
    (select count(*) filter (where o.activa)::text || ' activas, ' || count(*) filter (where not o.activa)::text || ' apagadas' from public.producto_opciones o where o.restaurante_id = public.restaurante_taqueiros_id()))
) as v(verificacion, ok, detalle);

-- Lo que NO debia cambiar: cada huella tiene que ser igual a la del "antes".
insert into _mr18_verif (verificacion, ok, detalle)
select 'sin cambios: ' || a.clave,
       d.huella is not distinct from a.huella,
       case when d.huella is distinct from a.huella then 'CAMBIO' end
from _mr18_antes a
left join pg_temp.mr18_huellas() d on d.clave = a.clave
order by a.clave;

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr18_verif where not ok;

  if malas is not null then
    raise exception E'EL SQL 18 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- Que la API REST (PostgREST) vea la tabla nueva de inmediato
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr18_verif
order by orden;
