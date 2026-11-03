/* =============================================================
   REVISION POR MUTACION DE LAS OPCIONES DE PRODUCTO (precio, validacion, aislamiento)

   Rompe A PROPOSITO, una por una, cada defensa del codigo y del SQL nuevos y exige que alguna prueba lo detecte:

     SERVIDOR (api/_precios.js, api/_menu.js, api/crear-pedido.js): se corre el grupo "opciones" de escenarios-servidor.mjs
       (base falsa con el SQL 18) y pruebas/opciones-precios.test.js. Es DETECTADA si alguna de las dos falla.
     SQL 18 y su reversa: se corre pruebas/multirestaurante/opciones.mjs con el archivo mutado (SQL18_ARCHIVO / SQL18R_ARCHIVO).
       Es DETECTADA si alguna prueba falla (incluido el propio SQL, que se revierte solo si falla una comprobacion).

   SOBREVIVE si todo pasa: falta una prueba, o la defensa sobra. Las EQUIVALENTES (otra capa ya cubre exactamente lo mismo,
   asi que quitar esta no cambia lo que un atacante puede lograr) se declaran con su razon.

     node pruebas/multirestaurante/mutaciones-opciones.mjs                 todo
     node pruebas/multirestaurante/mutaciones-opciones.mjs --solo=servidor | --solo=sql
     node pruebas/multirestaurante/mutaciones-opciones.mjs --paralelo=3     (mutantes de SQL a la vez)

   Sale con codigo 1 si alguna mutacion NO equivalente sobrevive.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { levantar } from './fake-supabase.mjs';
import { correrContraFalso, RAIZ } from './servidor.mjs';

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const SOLO = arg('solo') || '';
const PARALELO = Number(arg('paralelo') || 3);
const API = path.join(RAIZ, 'api');
const lf = (t) => t.replace(/\r\n/g, '\n');
const leer = (f) => lf(fs.readFileSync(path.join(RAIZ, f), 'utf8'));

const SERVIDOR = [];
const SQL = [];
const s = (nombre, archivo, buscar, reemplazar, extra) => SERVIDOR.push({ nombre, archivo, buscar, reemplazar, ...(extra || {}) });
const q = (nombre, archivo, buscar, reemplazar, extra) => SQL.push({ nombre, archivo, buscar, reemplazar, ...(extra || {}) });

/* ================= SERVIDOR: PRECIO ================= */
s('el precio unitario ignora los extras (cobra solo el base)', '_precios.js', 'const precioUnitario = producto.precio + extras;', 'const precioUnitario = producto.precio;');
s('los extras restan en vez de sumar', '_precios.js', 'const precioUnitario = producto.precio + extras;', 'const precioUnitario = producto.precio - extras;');
s('el total con opciones no multiplica por la cantidad', '_precios.js', 'subtotal += precioUnitario * cantidad;', 'subtotal += precioUnitario;');
s('el total con opciones suma el precio BASE por la cantidad', '_precios.js', 'subtotal += precioUnitario * cantidad;', 'subtotal += producto.precio * cantidad;');
s('el item guardado lleva el precio base como "precio" (el ticket, el panel y los reembolsos sumarian sin extras)', '_precios.js', 'precio: precioUnitario,        // FINAL', 'precio: producto.precio,        // FINAL');
s('precio_base guarda el precio final', '_precios.js', 'precio_base: producto.precio,  // el de la base, sin extras', 'precio_base: precioUnitario,');
s('los quitar tambien suman su precio (si la fila trajera uno)', '_precios.js', 'suma + (o.tipo === "extra" ? o.precio : 0)', 'suma + o.precio',
  { equivalente: 'copiaDeOpcion ya rechaza una fila "quitar" con precio distinto de 0, asi que sumarlo no cambia nada' });
s('un extra que no es extra (tipo desconocido) se acepta', '_precios.js', 'if (tipo !== "quitar" && tipo !== "extra") return null;', '');
s('el precio de la opcion puede pasar el tope de $50.000', '_precios.js', ' || precio > TOPE_PRECIO_OPCION) return null;', ') return null;');
s('el precio de la opcion puede ser negativo', '_precios.js', 'precio < 0 || precio > TOPE_PRECIO_OPCION', 'precio > TOPE_PRECIO_OPCION');
s('un precio nulo o de texto se convierte en numero (Number(null) = 0): un extra gratis', '_precios.js', 'const precio = fila.precio;', 'const precio = Number(fila.precio);');
s('el precio de la opcion puede tener decimales', '_precios.js', '!Number.isInteger(precio) || ', '');
s('un "quitar" con precio se acepta', '_precios.js', 'if (tipo === "quitar" && precio !== 0) return null;', '');
s('el tope del subtotal desaparece (un pedido enorme desborda la columna integer)', '_precios.js', ' || !Number.isSafeInteger(subtotal) || subtotal > TOPE_SUBTOTAL', '');
s('el nombre de la opcion se guarda tal cual vino de la base (sin sanear)', '_precios.js', 'const nombre = nombreSaneado(fila.nombre);', 'const nombre = String(fila.nombre);');
s('el nombre no se recorta a 40 caracteres', '_precios.js', 'return Array.from(limpio).slice(0, 40).join("");', 'return limpio;');
s('el nombre se recorta por unidades UTF-16 (parte un emoji: Postgres rechaza el JSON y el pedido da 500)', '_precios.js', 'return Array.from(limpio).slice(0, 40).join("");', 'return limpio.slice(0, 40);');
s('el saneado deja pasar los controles C1', '_precios.js', '[0x007f, 0x009f], ', '');
s('el saneado deja pasar U+2060-2064', '_precios.js', '[0x2060, 0x2064], ', '');
s('el saneado deja pasar el BOM', '_precios.js', ', [0xfeff, 0xfeff]', '',
  { equivalente: 'U+FEFF es espacio para el \\s de JavaScript: el replace(/\\s+/g, " ") que sigue lo vuelve espacio igual' });
s('el tope del subtotal sube a 2.200.000.000 (ya no cabe en el integer: 500)', '_precios.js', 'const TOPE_SUBTOTAL = 2000000000;', 'const TOPE_SUBTOTAL = 2200000000;');
s('"opciones": false, 0 o "" valen como "sin opciones" (el contrato deja de ser estricto)', '_precios.js', 'if (crudo === undefined || crudo === null) return [];', 'if (!crudo) return [];');
s('la lista in.() de productos no se codifica para la URL (un id con & podria colar otro filtro)', '_menu.js', 'encodeURIComponent(lista)', 'lista');
s('el webhook compara con el SUBTOTAL (se podria pagar sin el domicilio)', 'webhook-wompi.js', 'centavosPagados !== Number(pedido.total) * 100', 'centavosPagados !== Number(pedido.subtotal) * 100');
s('el id de producto no se recorta al buscar sus opciones', '_precios.js', 'const pid = String(item && item.id ? item.id : "").trim().slice(0, 60);', 'const pid = String(item && item.id ? item.id : "");',
  { equivalente: 'solo cambia un id con espacios de borde (ningun navegador lo manda): sus opciones no se encuentran y el pedido se RECHAZA (400), nunca se cobra de menos' });
s('el saneado deja pasar los controles de direccion (bidi)', '_precios.js', '[0x202a, 0x202e],\n', '');
s('la copia sale en el orden en que llegaron, no en el del menu', '_precios.js', 'elegidas.sort((a, b) => (a.orden - b.orden) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));', '');
s('una opcion mala se descarta en silencio y se cobra el resto', '_precios.js', 'if (elegidas.length !== idsOpciones.length) { opcionesInvalidas = true; continue; }', 'if (elegidas.length !== idsOpciones.length) { }');
s('una opcion mala descarta solo la linea (el pedido sale sin esa linea)', '_precios.js', 'if (opcionesInvalidas) {\n    return { ok: false, codigo: 400, error: MENSAJE_OPCIONES };\n  }', 'if (false) {\n    return { ok: false, codigo: 400, error: MENSAJE_OPCIONES };\n  }');
s('con una opcion mala se descarta la opcion y se acepta la linea', '_precios.js', 'if (!copia) { elegidas.length = 0; break; }', 'if (!copia) continue;',
  { equivalente: 'la comparacion elegidas.length !== idsOpciones.length de abajo rechaza igual la linea (defensa en capas)' });

/* ================= SERVIDOR: VALIDACION ================= */
s('las opciones repetidas se aceptan', '_precios.js', 'if (new Set(ids).size !== ids.length) return null;', '');
s('el maximo de 12 opciones sube a 99', '_precios.js', 'const MAX_OPCIONES_POR_ITEM = 12;', 'const MAX_OPCIONES_POR_ITEM = 99;');
s('el maximo de 12 no se aplica', '_precios.js', 'crudo.length > MAX_OPCIONES_POR_ITEM', 'false');
s('el id de opcion acepta mayusculas y espacios', '_precios.js', 'const ID_OPCION = /^[a-z0-9][a-z0-9-]{0,59}$/;', 'const ID_OPCION = /^.{1,60}$/;');
s('el id de opcion acepta mas de 60 caracteres', '_precios.js', '{0,59}$/;', '{0,590}$/;');
s('un numero u objeto vale como id', '_precios.js', 'if (typeof o !== "string" || !ID_OPCION.test(o)) return null;', 'if (!ID_OPCION.test(o)) return null;');
s('"opciones" puede no ser una lista (un texto se acepta como una opcion)', '_precios.js', 'if (!Array.isArray(crudo) || crudo.length > MAX_OPCIONES_POR_ITEM) return null;', 'if (!Array.isArray(crudo)) return [String(crudo)];');
s('las opciones mal formadas ya no se rechazan antes de leer la base', '_precios.js', 'if (opcionesPedidas.some((ids) => ids === null)) {', 'if (false) {');
s('una opcion apagada se acepta', '_precios.js', 'if (!fila || fila.activa === false) return null;', 'if (!fila) return null;');
s('la opcion de OTRO producto del mismo restaurante se acepta (se busca entre todas las del pedido)', '_precios.js', 'const delProducto = opcionesDeLaBase.get(id);',
  'const delProducto = new Map(Array.from(opcionesDeLaBase.values()).flatMap((mp) => Array.from(mp)));');
s('las opciones se leen de TODOS los productos del catalogo, aunque no se pidan', '_precios.js', 'if (catalogo.has(pid)) productosConOpciones.push(pid);', 'productosConOpciones.push(pid);',
  { equivalente: 'solo cambia a que productos se les piden las opciones; el resultado es el mismo (un producto desconocido no pasa el catalogo)' });
s('un pedido sin opciones tambien consulta la tabla (rompe el pedido si la tabla no existe)', '_precios.js', 'if (!opcionesPedidas[i].length) return;', '');
s('tabla ausente: el pedido con opciones sigue como si nada (sin opciones)', '_precios.js', 'return { ok: false, codigo: 400, error: MENSAJE_OPCIONES_NO_DISPONIBLES };', 'opcionesDeLaBase = new Map();');
s('fallo de la base al leer opciones: se cobra sin ellas', '_precios.js', 'return { ok: false, codigo: 503, error: MENSAJE_OPCIONES_REINTENTAR };', 'opcionesDeLaBase = new Map();');
s('fallo de la base al leer opciones: responde 400 en vez de 503', '_precios.js', 'return { ok: false, codigo: 503, error: MENSAJE_OPCIONES_REINTENTAR };', 'return { ok: false, codigo: 400, error: MENSAJE_OPCIONES_REINTENTAR };');
s('el mensaje de rechazo por una opcion invalida dice cual opcion fallo', '_precios.js', 'if (opcionesInvalidas) {\n    return { ok: false, codigo: 400, error: MENSAJE_OPCIONES };', 'if (opcionesInvalidas) {\n    return { ok: false, codigo: 400, error: MENSAJE_OPCIONES + " " + JSON.stringify(opcionesPedidas) };');
s('el pedido con opciones malas responde 409 en vez de 400 (crear-pedido ignora el codigo)', 'crear-pedido.js', 'res.status(revision.codigo || 409)', 'res.status(409)');
s('crear-pedido recalcula el total sumando items (con precio base)', 'crear-pedido.js', 'let total = revision.subtotal;', 'let total = revision.items.reduce((a, i) => a + (i.precio_base || i.precio) * i.cantidad, 0);',
  { equivalente: 'el total se pisa mas abajo con subtotal + costoDomicilio (total = subtotal + costoDomicilio), asi que este valor inicial nunca se usa' });
s('el subtotal de crear-pedido deja de ser el del servidor', 'crear-pedido.js', 'const subtotal = revision.subtotal;', 'const subtotal = Number(((req.body || {}).subtotal)) || revision.subtotal;');

/* ================= SERVIDOR: AISLAMIENTO Y MENU ================= */
s('la lectura de opciones para cobrar consulta otro restaurante', '_menu.js', 'const filas = await consultarTabla(rid, "producto_opciones",\n    "select=producto_id,id,tipo,nombre,precio,orden,activa&producto_id=in.("',
  'const filas = await consultarTabla("00000000-0000-4000-8000-000000000001", "producto_opciones",\n    "select=producto_id,id,tipo,nombre,precio,orden,activa&producto_id=in.("');
s('la lectura de opciones para el menu consulta otro restaurante', '_menu.js', 'try {\n    filas = await consultarTabla(rid, "producto_opciones",', 'try {\n    filas = await consultarTabla("00000000-0000-4000-8000-000000000001", "producto_opciones",');
s('el menu muestra tambien las opciones apagadas', '_menu.js', '&activa=is.true&order=orden.asc', '&order=orden.asc');
s('el menu trae todas las columnas de la tabla (restaurante_id, activa...)', '_menu.js', '"select=producto_id,id,tipo,nombre,precio,orden&activa=is.true&order=orden.asc"', '"select=*&activa=is.true&order=orden.asc"',
  { equivalente: 'solo cambia lo que se pide a la base: leerOpcionesActivas arma cada opcion campo por campo (id, tipo, nombre, precio, orden), asi que nada interno llega al menu; la prueba de las claves del menu lo vigila' });
s('el menu falla (503) si no se pueden leer las opciones', '_menu.js', '    return new Map();\n  }\n\n  const porProducto', '    throw err;\n  }\n\n  const porProducto');
s('el menu agrega la clave "opciones" (vacia) a todos los productos', '_menu.js', 'const productos = opciones.size\n    ? filasProductos.map((p) => (opciones.has(p.id) ? Object.assign({}, p, { opciones: opciones.get(p.id) }) : p))\n    : filasProductos;',
  'const productos = filasProductos.map((p) => Object.assign({}, p, { opciones: opciones.get(p.id) || [] }));');
s('el menu pega las opciones por id de producto sin mirar el restaurante (la lectura ya es del restaurante; mismo resultado)', '_menu.js', 'if (!f || typeof f.producto_id !== "string") continue;', 'if (!f) continue;',
  { equivalente: 'solo cambia como se descarta una fila sin producto_id, imposible en la base (la columna es NOT NULL)' });
s('las opciones del menu salen sin ordenar', '_menu.js', 'lista.sort((a, b) => (a.orden - b.orden) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));', '');
s('el menu muestra el precio del extra como texto', '_menu.js', 'precio: Number(f.precio), orden: Number(f.orden)', 'precio: f.precio, orden: f.orden',
  { equivalente: 'PostgREST ya devuelve enteros como numeros; la conversion Number() es solo un seguro' });
s('la tabla ausente se trata como error grave (el menu cae)', '_menu.js', 'return !!err && (err.status === 404 || /PGRST205|42P01/.test(cuerpo));', 'return false;');

/* ================= SQL 18 ================= */
const F18 = 'supabase/18-opciones-producto.sql';
const R18 = 'supabase/18-revertir.sql';
q('la tabla queda sin RLS', F18, 'alter table public.producto_opciones enable row level security;', '-- sin rls');
q('cajero tambien escribe (insert)', F18, "with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');\n  v_item := 'mr_opciones_update';", "with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));\n  v_item := 'mr_opciones_update';");
q('cocina tambien lee', F18, "in ('dueno', 'cajero'));\n  -- escribe SOLO", "in ('dueno', 'cajero', 'cocina'));\n  -- escribe SOLO");
q('cualquier miembro de CUALQUIER restaurante lee (es_personal)', F18, "using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));", "using ((select public.es_superadmin()) or (select public.es_personal()));");
q('el dueno de cualquier restaurante escribe en el update (se pierde la comparacion por restaurante)', F18,
  "using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')\n    with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');\n  v_item := 'mr_opciones_delete';",
  "using ((select public.es_superadmin()) or (select public.restaurante_actual()) is not null)\n    with check ((select public.es_superadmin()) or (select public.restaurante_actual()) is not null);\n  v_item := 'mr_opciones_delete';");
q('el borrado lo puede hacer cualquier miembro', F18, "create policy mr_opciones_delete on public.producto_opciones for delete to authenticated\n    using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');",
  "create policy mr_opciones_delete on public.producto_opciones for delete to authenticated\n    using ((select public.es_superadmin()) or (select public.es_personal()));");
q('anon lee la tabla (privilegio y politica)', F18, '  revoke all on table public.producto_opciones from public, anon;', '  grant select on table public.producto_opciones to anon;');
q('hay una politica para anon que deja leer todo', F18, "  v_item := 'mr_opciones_insert';", "  create policy mr_opciones_anon on public.producto_opciones for select to anon using (true);\n  v_item := 'mr_opciones_insert';");
q('anon conserva los privilegios por defecto de Supabase (no se le quitan)', F18, '  revoke all on table public.producto_opciones from public, anon;\n', '  revoke all on table public.producto_opciones from public;\n');
q('authenticated puede vaciar la tabla (TRUNCATE)', F18, '  revoke all on table public.producto_opciones from authenticated;\n  grant select, insert, update, delete on table public.producto_opciones to authenticated;', '  grant all on table public.producto_opciones to authenticated;');
q('la tabla se agrega a Realtime', F18, "-- (NO se agrega a la publicacion supabase_realtime", "alter publication supabase_realtime add table public.producto_opciones;\n-- (NO se agrega a la publicacion supabase_realtime");
q('restaurante_id vuelve a tener valor por defecto (Taqueiros)', F18, 'restaurante_id uuid    not null references public.restaurantes (id),', 'restaurante_id uuid    not null default public.restaurante_taqueiros_id() references public.restaurantes (id),');
q('la llave foranea compuesta no borra en cascada', F18, '        references public.productos (restaurante_id, id) on delete cascade,', '        references public.productos (restaurante_id, id),');
q('la llave primaria no incluye el restaurante', F18, 'constraint producto_opciones_pkey primary key (restaurante_id, producto_id, id),', 'constraint producto_opciones_pkey primary key (producto_id, id),');
q('el id acepta cualquier cosa', F18, "check (id ~ '^[a-z0-9][a-z0-9-]{0,59}$')", "check (id <> '')");
q('el tipo acepta cualquier cosa', F18, "check (tipo in ('quitar', 'extra'))", 'check (true)');
q('el precio puede pasar de 50000 en el CHECK', F18, 'check (precio between 0 and 50000)', 'check (precio between 0 and 5000000)');
q('el CHECK ya no obliga a que un quitar valga 0', F18, "check (tipo <> 'quitar' or precio = 0)", 'check (true)');
q('el trigger deja pasar un quitar con precio', F18, "if new.tipo = 'quitar' and new.precio is not null and new.precio <> 0 then", 'if false then',
  { equivalente: 'el CHECK producto_opciones_quitar_gratis rechaza lo mismo (defensa en capas); la prueba "CHECK sin trigger" lo comprueba por separado' });
q('el trigger deja pasar un precio fuera de rango', F18, 'if new.precio is not null and (new.precio < 0 or new.precio > 50000) then', 'if false then',
  { equivalente: 'el CHECK producto_opciones_precio_rango rechaza lo mismo (defensa en capas)' });
q('el nombre acepta caracteres bidi', F18, "|| chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238)", "|| chr(8203) || '-' || chr(8207)");
q('el nombre acepta signos de HTML', F18, "('[<>' || chr(1)", "('[' || chr(1)");
q('el nombre acepta controles C0', F18, "|| chr(1) || '-' || chr(31) ||", '||');
q('el nombre acepta espacios en los extremos', F18, 'and p_nombre = btrim(p_nombre)\n', '');
q('el nombre puede pasar de 40 caracteres', F18, 'and char_length(p_nombre) between 1 and 40', 'and char_length(p_nombre) between 1 and 400');
q('el nombre ya no se recorta', F18, 'new.nombre := btrim(coalesce(new.nombre, \'\'));', 'new.nombre := coalesce(new.nombre, \'\');');
q('el tope de opciones sube a 13', F18, 'tope_opciones constant integer := 12;', 'tope_opciones constant integer := 13;');
q('el tope no cuenta las opciones apagadas', F18, "where o.restaurante_id = new.restaurante_id and o.producto_id = new.producto_id;\n    if v_n", "where o.restaurante_id = new.restaurante_id and o.producto_id = new.producto_id and o.activa;\n    if v_n");
q('el tope de opciones desaparece', F18, 'if v_n >= tope_opciones then', 'if false then');
q('el tope de 12 cuenta las opciones de TODOS los restaurantes', F18, 'where o.restaurante_id = new.restaurante_id and o.producto_id = new.producto_id;', 'where o.producto_id = new.producto_id;');
q('el tope de 12 tambien frena las ediciones (UPDATE)', F18, "if tg_op = 'INSERT' and new.restaurante_id is not null", 'if new.restaurante_id is not null');
q('el nombre acepta U+2060-2064', F18, "|| chr(8288) || '-' || chr(8292) ", '');
q('el nombre acepta los aislantes bidi U+2066-2069', F18, "|| chr(8294) || '-' || chr(8297) ", '');
q('el candado del tope se quita (dos altas a la vez podrian pasar de 12)', F18, '    perform pg_advisory_xact_lock(hashtextextended(new.restaurante_id::text || \'/\' || new.producto_id, 18));\n', '',
  { equivalente: 'PGlite (un solo proceso) no puede provocar dos transacciones simultaneas; el candado se revisa por lectura y con probar-opciones.mjs contra la base real' });
q('el producto y el id de una opcion se pueden cambiar', F18, "if tg_op = 'UPDATE' and (new.producto_id is distinct from old.producto_id or new.id is distinct from old.id) then", 'if false then');
q('el trigger de restaurante inmutable no se crea', F18, "  create trigger producto_opciones_restaurante_inmutable\n    before update on public.producto_opciones\n    for each row execute function public.bloquear_cambio_restaurante();", '  null;');
q('el trigger de validacion no se crea', F18, "  create trigger producto_opciones_validar\n    before insert or update on public.producto_opciones\n    for each row execute function public.validar_producto_opcion();", '  null;');
q('la funcion de validacion se vuelve SECURITY DEFINER', F18, "create or replace function public.validar_producto_opcion()\nreturns trigger\nlanguage plpgsql\nset search_path = ''", "create or replace function public.validar_producto_opcion()\nreturns trigger\nlanguage plpgsql\nsecurity definer\nset search_path = ''");
q('anon puede ejecutar las funciones nuevas', F18, "execute format('revoke all on function %s from public, anon', f);", "execute format('revoke all on function %s from public', f);");
q('authenticated pierde EXECUTE sobre opcion_nombre_valido (el CHECK fallaria para el dueno)', F18, "execute format('grant execute on function %s to authenticated, service_role', f);", "execute format('revoke execute on function %s from authenticated', f);");
q('se omite el GRANT EXECUTE a authenticated (queda el permiso por defecto de Supabase)', F18, "execute format('grant execute on function %s to authenticated, service_role', f);", "execute format('grant execute on function %s to service_role', f);",
  { equivalente: 'en Supabase (y en el simulador) las funciones nuevas de public nacen con EXECUTE para authenticated por los privilegios por defecto, asi que el GRANT explicito solo lo deja por escrito; si ese permiso se perdiera, la mutacion anterior (que si lo quita) lo detecta' });
q('la semilla pisa lo que el dueno cambio', F18, 'on conflict (restaurante_id, producto_id, id) do nothing;', 'on conflict (restaurante_id, producto_id, id) do update set precio = excluded.precio, nombre = excluded.nombre, activa = true;');
q('la semilla trae un extra con otro precio (Queso extra a $20.000)', F18, "('nb-big-norte',     'extra-queso',          'extra',  'Queso extra',          2000, 10)", "('nb-big-norte',     'extra-queso',          'extra',  'Queso extra',          20000, 10)");
q('la semilla inventa un ingrediente que la descripcion no menciona', F18, "('nb-big-norte',     'sin-salsa-rosa',       'quitar', 'Sin salsa rosa',       0,    1),", "('nb-big-norte',     'sin-salsa-rosa',       'quitar', 'Sin salsa rosa',       0,    1),\n  ('nb-big-norte',     'sin-lechuga',          'quitar', 'Sin lechuga',          0,    2),");
q('la semilla deja quitar el producto base (la carne)', F18, "('nb-lil-norte',     'sin-tocineta',         'quitar', 'Sin tocineta',         0,    0),", "('nb-lil-norte',     'sin-tocineta',         'quitar', 'Sin tocineta',         0,    0),\n  ('nb-lil-norte',     'sin-carne',            'quitar', 'Sin carne',            0,    5),");
q('la semilla le pone opciones a una bebida', F18, "-- (Agua, Coca-Cola, Pepsi y Sprite: sin opciones.)", "insert into _mr18_semilla values ('nb-agua', 'extra-hielo', 'extra', 'Hielo', 1000, 10);");
q('la semilla se aplica tambien si faltan productos nb-* (se omite el aborto)', F18, "  if v_faltan is not null then\n    raise exception 'Faltan estos productos", "  if false then\n    raise exception 'Faltan estos productos");
q('el SQL no comprueba que anon siga sin privilegios (y se los da)', F18, "grant all on table public.producto_opciones to service_role;", "grant all on table public.producto_opciones to service_role;\n  grant select on table public.producto_opciones to anon;");
q('el SQL borra un producto al terminar', F18, "notify pgrst, 'reload schema';\n\ncommit;", "delete from public.productos where id = 'nb-sprite';\nnotify pgrst, 'reload schema';\n\ncommit;");
q('las comprobaciones finales no revierten aunque fallen', F18, "  if malas is not null then\n    raise exception E'EL SQL 18 SE REVIRTIO", "  if false then\n    raise exception E'EL SQL 18 SE REVIRTIO");

/* ================= REVERSA ================= */
q('la reversa no borra la tabla', R18, '  drop table if exists public.producto_opciones;', '  null;');
q('la reversa no borra las funciones', R18, "  drop function if exists public.validar_producto_opcion();\n  v_item := 'function opcion_nombre_valido(text)';\n  drop function if exists public.opcion_nombre_valido(text);", '  null;', { reversa: true });
q('la reversa borra tambien la funcion compartida bloquear_cambio_restaurante', R18, "  drop function if exists public.opcion_nombre_valido(text);", "  drop function if exists public.opcion_nombre_valido(text);\n  drop function if exists public.bloquear_cambio_restaurante() cascade;");
q('la reversa borra los pedidos de prueba... o cualquier pedido', R18, "  drop table if exists public.producto_opciones;", "  drop table if exists public.producto_opciones;\n  delete from public.pedidos where referencia = 'PED-OPC-1';");
q('la reversa no puede repetirse (usa el cast de regclass)', R18, "d.refobjid = to_regclass('public.producto_opciones')", "d.refobjid = 'public.producto_opciones'::regclass");
q('la reversa no dice cuantas filas se perdieron', R18, "(select i.v::text || ' filas' from _mr18r_info i where i.k = 'filas')", "'?'");

/* ================= motor ================= */
const aplicar = (texto, b, r, nombre) => {
  const n = texto.split(b).length - 1;
  if (n !== 1) throw new Error(`mutacion mal definida (${nombre.slice(0, 50)}): el texto aparece ${n} veces`);
  return texto.split(b).join(r);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mutop-'));
let contador = 0;
const resumen = { detectadas: 0, sobreviven: [], equivalentes: [], errores: [], total: 0 };
const corto = (t, n = 105) => String(t).replace(/\s+/g, ' ').slice(0, n);

async function servidor() {
  console.log(`\n== SERVIDOR (${SERVIDOR.length} mutaciones: precio, validacion, aislamiento y menu) ==`);
  const falso = await levantar({ puerto: 54332, validarConfig: false });
  const correr = async (dir) => {
    const fallas = [];
    try {
      const { resultados } = await correrContraFalso(falso, path.join(dir, 'api'), { soloGrupos: ['opciones'], sinInvariante: false });
      resultados.filter((r) => !r.ok).forEach((r) => fallas.push('[escenarios] ' + r.nombre));
    } catch (e) { fallas.push('[escenarios] EXCEPCION ' + e.message); }
    const u = spawnSync(process.execPath, ['--test', path.join(dir, 'pruebas', 'opciones-precios.test.js')], { encoding: 'utf8' });
    if (u.status !== 0) fallas.push('[unitarias] ' + ((u.stdout.match(/✖ [^\n]+/) || ['fallo'])[0]));
    return fallas;
  };
  // linea base: el original no debe fallar
  const base0 = path.join(tmp, 'base');
  fs.mkdirSync(path.join(base0, 'pruebas'), { recursive: true });
  fs.cpSync(API, path.join(base0, 'api'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'pruebas', 'opciones-precios.test.js'), path.join(base0, 'pruebas', 'opciones-precios.test.js'));
  const lb = await correr(base0);
  console.log(`LINEA BASE (servidor original): ${lb.length ? 'FALLAN ' + lb.length : 'todo pasa'}`);
  if (lb.length) { lb.slice(0, 5).forEach((x) => console.log('  ', x)); process.exit(2); }
  for (const mu of SERVIDOR) {
    resumen.total++;
    const dir = path.join(tmp, 'm' + (++contador));
    fs.mkdirSync(path.join(dir, 'pruebas'), { recursive: true });
    fs.cpSync(API, path.join(dir, 'api'), { recursive: true });
    fs.copyFileSync(path.join(RAIZ, 'pruebas', 'opciones-precios.test.js'), path.join(dir, 'pruebas', 'opciones-precios.test.js'));
    const arch = mu.archivo.includes('/') ? mu.archivo : mu.archivo;
    const rutaArch = path.join(dir, 'api', arch);
    try {
      fs.writeFileSync(rutaArch, aplicar(lf(fs.readFileSync(rutaArch, 'utf8')), mu.buscar, mu.reemplazar, mu.nombre));
    } catch (e) { resumen.errores.push(mu.nombre + ': ' + e.message); console.log(`  ERROR   ${mu.nombre}\n      ${e.message}`); continue; }
    const f = await correr(dir);
    if (f.length) { resumen.detectadas++; console.log(`  DETECTADA (${f.length})  ${mu.nombre}\n      p.ej.: ${corto(f[0])}`); }
    else if (mu.equivalente) { resumen.equivalentes.push(`${mu.nombre}  [${mu.equivalente}]`); console.log(`  EQUIVALENTE  ${mu.nombre}\n      ${mu.equivalente}`); }
    else { resumen.sobreviven.push(mu.nombre); console.log(`  SOBREVIVE  ${mu.nombre}`); }
  }
  await falso.cerrar();
}

async function sqlMutantes() {
  console.log(`\n== SQL 18 Y SU REVERSA (${SQL.length} mutaciones; ${PARALELO} a la vez) ==`);
  const correrUno = (env) => new Promise((res) => {
    const p = spawn(process.execPath, [path.join(RAIZ, 'pruebas', 'multirestaurante', 'opciones.mjs')], { cwd: RAIZ, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
  const lb = await correrUno({});
  console.log(`LINEA BASE (SQL original): ${lb.code === 0 ? 'todo pasa' : 'FALLA'}`);
  if (lb.code !== 0) { console.log(lb.out.split('\n').filter((l) => /FALLA|->/.test(l)).slice(0, 6).join('\n')); process.exit(2); }
  const cola = SQL.map((mu, i) => ({ mu, i }));
  const trabajador = async () => {
    while (cola.length) {
      const { mu, i } = cola.shift();
      resumen.total++;
      const orig = lf(fs.readFileSync(path.join(RAIZ, mu.archivo), 'utf8'));
      let mutado;
      try { mutado = aplicar(orig, mu.buscar, mu.reemplazar, mu.nombre); }
      catch (e) { resumen.errores.push(mu.nombre + ': ' + e.message); console.log(`  ERROR   ${mu.nombre}\n      ${e.message}`); continue; }
      const f = path.join(tmp, `q${i}.sql`);
      fs.writeFileSync(f, mutado);
      const env = mu.archivo === F18 ? { SQL18_ARCHIVO: f } : { SQL18R_ARCHIVO: f };
      const r = await correrUno(env);
      const falla = r.code !== 0 ? (r.out.split('\n').find((l) => /FALLA/.test(l)) || r.out.split('\n').find((l) => /Error|error/.test(l)) || 'fallo') : null;
      if (falla) { resumen.detectadas++; console.log(`  DETECTADA  ${mu.nombre}\n      p.ej.: ${corto(falla.trim())}`); }
      else if (mu.equivalente) { resumen.equivalentes.push(`${mu.nombre}  [${mu.equivalente}]`); console.log(`  EQUIVALENTE  ${mu.nombre}\n      ${mu.equivalente}`); }
      else { resumen.sobreviven.push(mu.nombre); console.log(`  SOBREVIVE  ${mu.nombre}`); }
    }
  };
  await Promise.all(Array.from({ length: PARALELO }, trabajador));
}

if (!SOLO || SOLO === 'servidor') await servidor();
if (!SOLO || SOLO === 'sql') await sqlMutantes();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n=============================================================');
console.log(`MUTACIONES: ${resumen.total}   DETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes.length}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
if (resumen.sobreviven.length) { console.log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((x) => console.log('  - ' + x)); }
if (resumen.equivalentes.length) { console.log('\nEQUIVALENTES:'); resumen.equivalentes.forEach((x) => console.log('  - ' + x)); }
if (resumen.errores.length) { console.log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((x) => console.log('  - ' + x)); }
process.exitCode = resumen.sobreviven.length || resumen.errores.length ? 1 : 0;
setTimeout(() => process.exit(), 1500).unref();
