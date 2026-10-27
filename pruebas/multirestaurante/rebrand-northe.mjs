/* =============================================================
   PRUEBAS DEL REBRAND A "THE NORTHE BURGERS"
   (supabase/17-rebrand-northe.sql, supabase/17-revertir.sql, supabase/subir-fotos-northe.mjs, docs seccion 20)

     node pruebas/multirestaurante/rebrand-northe.mjs

   Postgres 16 real (PGlite) con los SQL 10 a 13 y 15 (y 16 / 16b en otras corridas) y, para el script de fotos, el
   Supabase falso con Storage; el script corre de verdad, como proceso aparte.

     A. SQL 17: corre dos veces (idempotente) con todas sus comprobaciones OK; el menu visible son las 4 categorias y los 13
        productos nuevos; el sufijo " (Taqueiros)" no se duplica; NO toca pedidos, ubicacion, domicilio, horarios, Wompi, contacto,
        slug, estado, secretos, tarifas, dominios, productos viejos ni otros restaurantes (huellas calculadas AQUI, no solo por el SQL);
        la config final es EXACTAMENTE api/_respaldo-taqueiros.js; cumple las reglas del SQL 13.
     B. Reversa: devuelve la base EXACTAMENTE a como estaba antes del 17 (huellas de restaurantes, categorias y productos) y la config
        al original fijado (commit 947b164); se repite sin dano; el 17 se vuelve a aplicar. Con un pedido que referencia un producto
        nuevo, ese producto y su categoria se conservan (apagados) y NINGUN pedido cambia.
     C. Funciona antes y despues de los SQL 16 y 16b; no usa sa_*, vigencia ni auditoria. Se niega, sin cambiar nada, si el estado no es
        el esperado (nombre distinto, sin config.publico, sin el SQL 10). Los pedidos viejos (TAQ-...) se siguen abriendo por su enlace.
     D. Re-ejecutar el 17 no borra las fotos ya subidas ni el estado "agotado".
     E. subir-fotos-northe.mjs: llaves malas no hacen nada; sin el SQL 17 no hace nada; simula sin escribir; aplica (13 fotos bajo
        {restaurante_id}/, mismos bytes, direcciones exactas); se repite sin escribir; reemplaza con upsert; respeta una foto ajena
        (y --forzar la cambia); archivos locales malos abortan antes de subir; un corte a mitad se reanuda; la llave no sale nunca.
     F. Front y servidor: botones de redes sin salto con REDES_ENLAZAN=false y con enlace real con true (comentada, con su reactivacion);
        referencia PED-; pedido.html acepta PED- y TAQ-; favicon con icono_192; sw.js v12; la documentacion (secciones 20 y 21).
============================================================= */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { levantar } from './fake-supabase.mjs';
import { crearBase, sembrar, sql10, sql, intentar, REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const { CONFIG_TAQUEIROS } = require(`${REPO}/api/_respaldo-taqueiros.js`);
const ORIGINAL = JSON.parse(fs.readFileSync(`${REPO}/pruebas/multirestaurante/config-taqueiros-original.json`, 'utf8'));

const TAQ = '00000000-0000-4000-8000-000000000001';
const LLAVE = 'sb_secret_FAKE_0000';
const PREFIJO_BD = 'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/';
const SCRIPT_FOTOS = `${REPO}/supabase/subir-fotos-northe.mjs`;

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 700) });
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const igual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const leer = (f) => fs.readFileSync(`${REPO}/${f}`, 'utf8');

const NUEVOS = ['nb-big-norte', 'nb-crispy-norte', 'nb-lil-norte', 'nb-classic-norte', 'nb-smoky-norte', 'nb-full-norte', 'nb-creamy-norte',
  'nb-dirty-norte', 'nb-chori-norte', 'nb-agua', 'nb-coca-cola', 'nb-pepsi', 'nb-sprite'];

const todosOK = (rows) => Array.isArray(rows) && rows.length > 0 && rows.every((x) => x.estado === 'OK');
const malas = (rows) => (rows || []).filter((x) => x.estado !== 'OK').map((x) => x.verificacion + (x.detalle ? ' [' + x.detalle + ']' : '')).join(' | ');
async function correr(db, archivo) {
  try { const r = await db.exec(archivo); return { rows: r[r.length - 1].rows, error: null }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { rows: null, error: e.message }; }
}

async function baseCon({ con16 = false } = {}) {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  for (const f of ['11-dominios.sql', '12-config-publica.sql', '13-endurecer.sql', '15-datos-restaurante.sql']) await db.exec(sql(f));
  if (con16) { await db.exec(sql('16-superadmin.sql')); await db.exec(sql('16b-horario.sql')); }
  return db;
}

/* Huellas calculadas por la PRUEBA (independientes de las que calcula el SQL). */
const TABLAS = { restaurantes: 'id', categorias: 'restaurante_id, id', productos: 'restaurante_id, id', pedidos: 'id', configuracion: 'restaurante_id',
  tarifas_domicilio: 'id', miembros: 'user_id, restaurante_id', restaurante_dominios: 'host', restaurante_secretos: 'restaurante_id' };
async function huellas(db) {
  const out = {};
  for (const [t, orden] of Object.entries(TABLAS)) {
    const r = (await db.query(`select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by ${orden.split(', ').map((c) => 'x.' + c).join(', ')})), '') h from public.${t} x`)).rows[0];
    out[t] = r.n + ':' + r.h;
  }
  return out;
}
async function huellasViejos(db) {   // productos que NO son de Northe, y categorias viejas SIN nombre ni activa
  const p = (await db.query(`select count(*)::int n, md5(string_agg(x::text, '|' order by x.restaurante_id, x.id)) h from public.productos x where x.id not like 'nb-%'`)).rows[0];
  const c = (await db.query(`select count(*)::int n, md5(string_agg(x.restaurante_id || '/' || x.id || '/' || coalesce(x.emoji, '') || '/' || x.orden, '|' order by x.restaurante_id, x.id)) h from public.categorias x where x.id not like 'nb-%'`)).rows[0];
  return { productos: p.n + ':' + p.h, categorias: c.n + ':' + c.h };
}
const menuSinFechas = async (db) => JSON.stringify((await db.query(`select id, nombre, descripcion, precio, categoria, orden, imagen, disponible from public.productos where restaurante_id = '${TAQ}' order by id`)).rows);
const configDemo = async (db) => (await db.query(`select nombre, config from public.restaurantes where id = '${TAQ}'`)).rows[0];
const menuVisible = async (db) => (await db.query(`select p.id from public.productos p join public.categorias c on c.restaurante_id = p.restaurante_id and c.id = p.categoria
                                                    where p.restaurante_id = '${TAQ}' and c.activa order by p.id`)).rows.map((r) => r.id);
const catsActivas = async (db) => (await db.query(`select id, nombre from public.categorias where restaurante_id = '${TAQ}' and activa order by orden, id`)).rows;
const pedidoCon = (db, ref, idProducto) => db.query(`
  insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en)
  values ('${TAQ}', $1, 'nuevo', 'Cliente', '3001230000', 'local', $2::jsonb, 4500, 0, 4500, 'aprobado', now()) returning id`,
  [ref, JSON.stringify([{ id: idProducto, nombre: 'Coca-Cola', cantidad: 1, precio: 4500 }])]);

async function main() {
  const t0 = Date.now();
  const SQL17 = sql('17-rebrand-northe.sql');
  const REV17 = sql('17-revertir.sql');

  // ================= A. el SQL 17 =================
  {
    const db = await baseCon();
    const antes = await huellas(db);
    const viejosAntes = await huellasViejos(db);
    const cfgAntes = await configDemo(db);
    const columnasAntes = (await db.query(`select md5((to_jsonb(r) - 'nombre' - 'config')::text) h from public.restaurantes r where r.id = '${TAQ}'`)).rows[0].h;
    const nCatViejas = Number((await db.query(`select count(*) n from public.categorias where restaurante_id = '${TAQ}'`)).rows[0].n);
    const nProdViejos = Number((await db.query(`select count(*) n from public.productos where restaurante_id = '${TAQ}'`)).rows[0].n);

    const a1 = await correr(db, SQL17);
    const despues1 = await huellas(db);
    const menuAntesDeRevertir = await menuSinFechas(db);
    const a2 = await correr(db, SQL17);
    prueba('A1 el SQL 17 corre dos veces seguidas y todas sus comprobaciones dan OK', todosOK(a1.rows) && todosOK(a2.rows) && a1.rows.length >= 20 && a1.rows.length === a2.rows.length,
      a1.error || a2.error || malas(a1.rows) || malas(a2.rows));
    prueba('A2 la segunda corrida no cambia NADA (idempotente: huellas de todas las tablas iguales)', JSON.stringify(await huellas(db)) === JSON.stringify(despues1));

    const d = await configDemo(db);
    prueba('A3 el restaurante se llama "The Northe Burgers", conserva id y slug "taqueiros"', d.nombre === 'The Northe Burgers'
      && (await db.query(`select slug from public.restaurantes where id = '${TAQ}'`)).rows[0].slug === 'taqueiros');
    prueba('A4 la config final es EXACTAMENTE api/_respaldo-taqueiros.js (marca, textos, contacto, wompi, pwa, ubicacion y domicilio)', igual(d.config, CONFIG_TAQUEIROS),
      JSON.stringify(d.config).slice(0, 200));
    prueba('A5 ubicacion, domicilio, llaves de Wompi y contacto (menos las redes) quedan IDENTICOS a como estaban',
      igual({ u: d.config.ubicacion, d: d.config.domicilio, w: d.config.publico.wompi, c: { ...d.config.publico.contacto, instagram: 0, tiktok: 0 } },
            { u: cfgAntes.config.ubicacion, d: cfgAntes.config.domicilio, w: cfgAntes.config.publico.wompi, c: { ...cfgAntes.config.publico.contacto, instagram: 0, tiktok: 0 } }));
    prueba('A6 las redes son "thenorthe.burgers" (Instagram y TikTok)', d.config.publico.contacto.instagram === 'thenorthe.burgers' && d.config.publico.contacto.tiktok === 'thenorthe.burgers');
    prueba('A7 la config cumple las reglas de validacion del SQL 13 (config_restaurante_errores vacia)',
      (await db.query(`select public.config_restaurante_errores(config) e from public.restaurantes where id = '${TAQ}'`)).rows[0].e.length === 0);

    const ids = await menuVisible(db);
    prueba('A8 el menu visible son EXACTAMENTE los 13 productos nuevos', igual(ids, [...NUEVOS].sort()), JSON.stringify(ids));
    const cats = await catsActivas(db);
    prueba('A9 las categorias activas, en orden: Hamburguesas, Hot dogs, Papas, Bebidas (ids nb-*)',
      igual(cats.map((c) => c.nombre), ['Hamburguesas', 'Hot dogs', 'Papas', 'Bebidas']) && cats.every((c) => c.id.startsWith('nb-')), JSON.stringify(cats));
    const menu = (await db.query(`select id, nombre, precio, categoria, orden, descripcion, imagen, disponible from public.productos where restaurante_id = '${TAQ}' and id like 'nb-%' order by categoria, orden`)).rows;
    prueba('A10 precios del menu aprobado (enteros) y ningun producto nuevo con foto todavia',
      igual(Object.fromEntries(menu.map((p) => [p.id, p.precio])), { 'nb-big-norte': 26000, 'nb-crispy-norte': 22000, 'nb-lil-norte': 18000, 'nb-classic-norte': 12000, 'nb-smoky-norte': 15000,
        'nb-full-norte': 18000, 'nb-creamy-norte': 14000, 'nb-dirty-norte': 17000, 'nb-chori-norte': 19000, 'nb-agua': 3000, 'nb-coca-cola': 4500, 'nb-pepsi': 4500, 'nb-sprite': 4500 })
      && menu.every((p) => Number.isInteger(p.precio) && p.imagen === null && p.disponible === true), JSON.stringify(menu).slice(0, 300));
    prueba('A11 las descripciones ajustadas a las fotos (Crispy, hot dogs, papas y bebidas)',
      menu.find((p) => p.id === 'nb-crispy-norte').descripcion === 'Pollo crispy bien dorado, queso, tocineta y salsa BBQ.'
      && menu.find((p) => p.id === 'nb-smoky-norte').descripcion === 'Salchicha ahumada con salsa BBQ, cebolla morada encurtida y cebolla crujiente.'
      && !/desmechada/i.test(JSON.stringify(menu))
      && menu.find((p) => p.id === 'nb-coca-cola').descripcion === 'Lata 350 ml, bien fría.' && menu.find((p) => p.id === 'nb-pepsi').descripcion === 'Lata, bien fría.'
      && menu.find((p) => p.id === 'nb-sprite').descripcion === 'Lata, bien fría.');

    const viejas = (await db.query(`select id, nombre, activa from public.categorias where restaurante_id = '${TAQ}' and id not like 'nb-%' order by id`)).rows;
    prueba('A12 las 6 categorias viejas siguen existiendo, todas apagadas, y solo "Bebidas" lleva " (Taqueiros)" (una sola vez, tambien tras la 2a corrida)',
      viejas.length === nCatViejas && viejas.every((c) => c.activa === false) && viejas.filter((c) => / \(Taqueiros\)$/.test(c.nombre)).map((c) => c.nombre).join() === 'Bebidas (Taqueiros)'
      && !viejas.some((c) => /\(Taqueiros\) \(Taqueiros\)/.test(c.nombre)), JSON.stringify(viejas));
    const prodAhora = Number((await db.query(`select count(*) n from public.productos where restaurante_id = '${TAQ}' and id not like 'nb-%'`)).rows[0].n);
    prueba('A13 los productos viejos NO se borran ni se tocan (ni una columna) y las categorias viejas conservan emoji y orden', prodAhora === nProdViejos && igual(await huellasViejos(db), viejosAntes));

    const post = await huellas(db);
    const intactas = ['pedidos', 'configuracion', 'tarifas_domicilio', 'miembros', 'restaurante_dominios', 'restaurante_secretos'];
    prueba('A14 NO toca pedidos, configuracion (horarios y mensaje de cerrado), tarifas, miembros, dominios ni secretos (huellas de la prueba)',
      intactas.every((t) => post[t] === antes[t]), intactas.filter((t) => post[t] !== antes[t]).join());
    const sinNombreNiConfig = (await db.query(`select md5((to_jsonb(r) - 'nombre' - 'config')::text) h from public.restaurantes r where r.id = '${TAQ}'`)).rows[0].h;
    prueba('A15 slug, estado, plan, vigencia, modulos, zona horaria y hora de corte del demo quedan iguales', sinNombreNiConfig === columnasAntes);

    const seg = await intentar(db, null, `select * from public.seguimiento($1)`, ['TAQ-4-ddd'], { rol: 'anon' });
    prueba('A16 un pedido VIEJO (referencia TAQ-...) se sigue abriendo por su enlace actual despues del rebrand', seg.ok && seg.rows.length === 1, JSON.stringify(seg));

    // ----- B. la reversa -----
    const b1 = await correr(db, REV17);
    const b1h = await huellas(db);
    const cfgB = await configDemo(db);
    prueba('B1 la reversa corre y todas sus comprobaciones dan OK', todosOK(b1.rows) && b1.rows.length >= 15, b1.error || malas(b1.rows));
    prueba('B2 la base queda EXACTAMENTE como antes del SQL 17 (huellas de restaurantes, categorias y productos)',
      b1h.restaurantes === antes.restaurantes && b1h.categorias === antes.categorias && b1h.productos === antes.productos, JSON.stringify([antes.categorias, b1h.categorias]));
    prueba('B3 el nombre vuelve a "Los Taqueiros" y la config es EXACTAMENTE la original fijada (config-taqueiros-original.json)',
      cfgB.nombre === 'Los Taqueiros' && igual(cfgB.config, ORIGINAL) && igual(cfgB.config, cfgAntes.config));
    prueba('B4 la reversa NO toca pedidos, configuracion, tarifas, miembros, dominios ni secretos', intactas.every((t) => b1h[t] === antes[t]));
    const b2 = await correr(db, REV17);
    prueba('B5 la reversa se puede repetir (idempotente) y no cambia nada', todosOK(b2.rows) && JSON.stringify(await huellas(db)) === JSON.stringify(b1h), b2.error || malas(b2.rows));
    const re = await correr(db, SQL17);
    prueba('B6 el SQL 17 se vuelve a aplicar despues de revertir y deja el mismo estado final (mismo menu, categorias y config; los productos se vuelven a crear, asi que se comparan sin fechas)',
      todosOK(re.rows) && (await huellas(db)).categorias === despues1.categorias && (await huellas(db)).restaurantes === despues1.restaurantes && (await menuSinFechas(db)) === menuAntesDeRevertir, re.error || malas(re.rows));
  }

  // ----- B7. la reversa con un pedido que referencia un producto nuevo -----
  {
    const db = await baseCon();
    const antes = await huellas(db);
    await db.exec(SQL17);
    await pedidoCon(db, 'PED-1788325338685-ab12cd', 'nb-coca-cola');
    const pedidosAntes = await huellas(db);
    const r = await correr(db, REV17);
    const pedidosDespues = await huellas(db);
    const prods = (await db.query(`select id, categoria from public.productos where restaurante_id = '${TAQ}' and id like 'nb-%' order by id`)).rows;
    const cats = (await db.query(`select id, nombre, activa from public.categorias where restaurante_id = '${TAQ}' and id like 'nb-%' order by id`)).rows;
    prueba('B7 con un pedido que referencia nb-coca-cola: la reversa conserva ESE producto y su categoria (apagada, "Bebidas (Northe)") y borra los otros 12 productos y 3 categorias',
      todosOK(r.rows) && prods.length === 1 && prods[0].id === 'nb-coca-cola' && cats.length === 1 && cats[0].id === 'nb-bebidas' && cats[0].activa === false && cats[0].nombre === 'Bebidas (Northe)',
      r.error || malas(r.rows) || JSON.stringify([prods, cats]));
    prueba('B8 ...ningun pedido cambia ni se borra (ni el nuevo ni los 5 de antes)', pedidosAntes.pedidos === pedidosDespues.pedidos);
    const old = (await db.query(`select nombre, activa from public.categorias where restaurante_id = '${TAQ}' and id = 'bebidas'`)).rows[0];
    prueba('B9 ...y "Bebidas" de Taqueiros vuelve a llamarse "Bebidas" y a estar encendida, sin chocar con la nueva', old.nombre === 'Bebidas' && old.activa === true, JSON.stringify(old));
    const menu = await menuVisible(db);
    prueba('B10 ...el menu visible es el original de Taqueiros: ningun producto nb-* se ve', !menu.some((x) => x.startsWith('nb-')) && menu.length === 38, menu.length + ' productos visibles');
    const re = await correr(db, SQL17);
    const vis = await menuVisible(db);
    prueba('B11 el SQL 17 se vuelve a aplicar sobre ese estado: nb-bebidas se enciende y recupera su nombre, y el menu vuelve a ser los 13 productos',
      todosOK(re.rows) && igual(vis, [...NUEVOS].sort()) && (await catsActivas(db)).map((c) => c.nombre).join() === 'Hamburguesas,Hot dogs,Papas,Bebidas', re.error || malas(re.rows) || vis.join());
    const rev2 = await correr(db, REV17);
    const h2 = await huellas(db);
    prueba('B12 ...y esa reversa final deja pedidos igual que al inicio y NO deja ningun producto nb-* huerfano de su pedido',
      todosOK(rev2.rows) && h2.pedidos === pedidosAntes.pedidos && (await db.query(`select count(*)::int n from public.productos where id = 'nb-coca-cola'`)).rows[0].n === 1);
  }

  // ================= C. SQL 16 / 16b antes y despues; precondiciones =================
  {
    const db = await baseCon({ con16: true });
    const antes = await huellas(db);
    const r = await correr(db, SQL17);
    prueba('C1 con los SQL 16 y 16b YA aplicados, el 17 corre y todas sus comprobaciones dan OK', todosOK(r.rows), r.error || malas(r.rows));
    const rv = await correr(db, REV17);
    prueba('C2 ...y su reversa tambien, dejando restaurantes, categorias y productos como antes', todosOK(rv.rows) && igual(
      { r: (await huellas(db)).restaurantes, c: (await huellas(db)).categorias, p: (await huellas(db)).productos }, { r: antes.restaurantes, c: antes.categorias, p: antes.productos }), rv.error || malas(rv.rows));
  }
  {
    const db = await baseCon();
    await db.exec(SQL17);
    const s16 = await correr(db, sql('16-superadmin.sql'));
    const s16b = await correr(db, sql('16b-horario.sql'));
    prueba('C3 los SQL 16 y 16b se aplican DESPUES del 17 sin problema (todas sus comprobaciones OK)', todosOK(s16.rows) && todosOK(s16b.rows), s16.error || s16b.error || malas(s16.rows) || malas(s16b.rows));
    const r2 = await correr(db, SQL17);
    prueba('C4 ...y el 17 se puede volver a correr con ellos ya aplicados', todosOK(r2.rows), r2.error || malas(r2.rows));
  }
  for (const [nombre, texto] of [['17-rebrand-northe.sql', SQL17], ['17-revertir.sql', REV17]]) {
    const codigo = texto.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    prueba(`C5 ${nombre} no usa funciones sa_*, vigencia, auditoria ni calcular_vigencia (independiente del 16 y del 16b)`, !/\bsa_[a-z_]+\s*\(|calcular_vigencia|vigencia_restaurante|auditoria_superadmin|exigir_superadmin|auditar_superadmin|es_superadmin|public\.superadmins/i.test(codigo));
    prueba(`C6 ${nombre} es atomico (begin ... commit), usa lock_timeout y no borra pedidos ni toca configuracion`,
      /^begin;/m.test(codigo) && /^commit;/m.test(codigo) && /lock_timeout/.test(codigo) && !/delete\s+from\s+public\.pedidos|update\s+public\.pedidos|truncate|drop\s+table\s+public|update\s+public\.configuracion|insert\s+into\s+public\.pedidos/i.test(codigo));
  }
  {
    // el SQL 17 se niega sin cambiar nada
    const db = await baseCon();
    const h0 = await huellas(db);
    await db.exec(`update public.restaurantes set nombre = 'Pizza Loca' where id = '${TAQ}'`);
    const h1 = await huellas(db);
    const r = await correr(db, SQL17);
    prueba('C7 si el restaurante demo tiene OTRO nombre, el 17 se detiene con un mensaje claro y no cambia nada', r.error && /se llama "Pizza Loca"/.test(r.error) && JSON.stringify(await huellas(db)) === JSON.stringify(h1), r.error || 'corrio');
    const rv = await correr(db, REV17);
    prueba('C8 ...y la reversa tambien', rv.error && /se llama "Pizza Loca"/.test(rv.error) && JSON.stringify(await huellas(db)) === JSON.stringify(h1), rv.error || 'corrio');
    await db.exec(`update public.restaurantes set nombre = 'Los Taqueiros' where id = '${TAQ}'`);
    prueba('C9 ...y con "Los Taqueiros" otra vez corre bien', JSON.stringify(await huellas(db)) === JSON.stringify(h0) && todosOK((await correr(db, SQL17)).rows));

    const db2 = await baseCon();
    await db2.exec(`update public.restaurantes set config = '{}'::jsonb where id = '${TAQ}'`);
    const h2 = await huellas(db2);
    const r2 = await correr(db2, SQL17);
    prueba('C10 si falta config.publico (SQL 12), se detiene explicando que corra el SQL 12 y no cambia nada', r2.error && /SQL 12|12-config-publica/.test(r2.error) && JSON.stringify(await huellas(db2)) === JSON.stringify(h2), r2.error || 'corrio');

    const db3 = await crearBase({ con01y02: true });
    await sembrar(db3);
    const r3 = await correr(db3, SQL17);
    prueba('C11 en una base sin el SQL 10 (sin restaurante_id) se detiene con un mensaje claro', r3.error && /restaurante_id|SQL 10|10-multirestaurante/.test(r3.error), r3.error || 'corrio');
    const r3b = await correr(db3, REV17);
    prueba('C12 ...y la reversa tambien', r3b.error && /restaurantes|SQL 17|funciones/.test(r3b.error), r3b.error || 'corrio');
  }

  // ================= D. re-ejecutar no pisa fotos ni agotados =================
  {
    const db = await baseCon();
    await db.exec(SQL17);
    const url = `${PREFIJO_BD}${TAQ}/big-norte.jpg`;
    await db.query(`update public.productos set imagen = $1 where restaurante_id = '${TAQ}' and id = 'nb-big-norte'`, [url]);
    await db.query(`update public.productos set disponible = false where restaurante_id = '${TAQ}' and id = 'nb-pepsi'`);
    const r = await correr(db, SQL17);
    const p = (await db.query(`select id, imagen, disponible from public.productos where restaurante_id = '${TAQ}' and id in ('nb-big-norte', 'nb-pepsi') order by id`)).rows;
    prueba('D1 volver a correr el 17 NO borra la foto ya subida ni revive un producto agotado', todosOK(r.rows) && p[0].imagen === url && p[1].disponible === false, r.error || JSON.stringify(p));
    prueba('D2 ...y la comprobacion informativa cuenta las fotos que faltan (12 de 13)', (r.rows || []).some((x) => /sin foto/.test(x.detalle || '') && /^12 de 13/.test(x.detalle)), JSON.stringify((r.rows || []).filter((x) => /foto/.test(x.verificacion))));

    // categoria vieja apagada A PROPOSITO antes del 17: la reversa enciende todas las viejas (comportamiento documentado)
    const db2 = await baseCon();
    await db2.exec(`update public.categorias set activa = false where restaurante_id = '${TAQ}' and id = 'especiales'`);
    await db2.exec(SQL17);
    await db2.exec(REV17);
    prueba('D3 (documentado) la reversa enciende TAMBIEN una categoria vieja que estaba apagada antes del 17', (await db2.query(`select activa from public.categorias where restaurante_id = '${TAQ}' and id = 'especiales'`)).rows[0].activa === true);
    prueba('D4 la cabecera de la reversa lo avisa', /aunque alguna estuviera apagada/.test(REV17));
  }

  // ================= E. el script de fotos =================
  const falso = await levantar({ puerto: Number(process.env.PUERTO_FOTOS_NORTHE || 54361) });
  const dbf = falso.db;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-'));
  const carpeta = path.join(tmp, 'listas');
  const ARCHIVOS = ['big-norte', 'crispy-norte', 'lil-norte', 'classic-norte', 'smoky-norte', 'full-norte', 'creamy-norte', 'dirty-norte', 'chori-norte', 'agua', 'coca-cola', 'pepsi', 'sprite'].map((n) => n + '.jpg');
  const jpg = (semilla, extra = 3000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.createHash('sha256').update(semilla).digest(), Buffer.alloc(extra, semilla.length % 251), Buffer.from([0xff, 0xd9])]);
  const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
  function prepararCarpeta() {
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(carpeta, { recursive: true });
    for (const a of ARCHIVOS) fs.writeFileSync(path.join(carpeta, a), jpg(a));
  }
  prepararCarpeta();
  let todaLaSalida = '';
  const fotosPara = (extra = [], env = {}, opciones = {}) => new Promise((resolve) => {
    const hijo = spawn(process.execPath, [SCRIPT_FOTOS, `--carpeta=${carpeta}`, ...extra], {
      cwd: REPO,
      env: { ...process.env, SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: LLAVE, SUBIR_FOTOS_PREFIJO: PREFIJO_BD, SUBIR_FOTOS_SALIDA_MS: '300', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    hijo.stdout.on('data', (d) => { out += d; }); hijo.stderr.on('data', (d) => { out += d; });
    falso.cortar = opciones.cortarEn || null;
    const tope = setTimeout(() => { hijo.kill('SIGKILL'); out += '\n[TIEMPO AGOTADO]'; }, 60000);
    hijo.on('exit', (code) => { clearTimeout(tope); falso.cortar = null; todaLaSalida += out; resolve({ code, out }); });
  });
  const escrituras = () => falso.peticiones.filter((p) => !/^GET /.test(p) && !/^HEAD /.test(p));
  const fotosBD = async () => (await dbf.query(`select id, imagen from public.productos where restaurante_id = '${TAQ}' and id like 'nb-%' order by id`)).rows;
  const nLlamadas = async (fn) => { const antes = falso.peticiones.length; const r = await fn(); return { r, nuevas: falso.peticiones.slice(antes) }; };

  {
    // E1. llaves malas: no hacen nada
    const n0 = falso.peticiones.length;
    const sinLlave = await fotosPara([], { SUPABASE_SERVICE_ROLE_KEY: '' });
    const doble = await fotosPara([], { SUPABASE_SERVICE_ROLE_KEY: LLAVE + LLAVE });
    const publicable = await fotosPara([], { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_FAKE_0000' });
    prueba('E1 sin llave, con la llave pegada dos veces o con una publicable: sale con 2 y no hace NI UNA peticion', sinLlave.code === 2 && doble.code === 2 && publicable.code === 2 && falso.peticiones.length === n0,
      [sinLlave.code, doble.code, publicable.code, falso.peticiones.length - n0].join());

    // E2. sin el SQL 17: no hace nada
    const s = await fotosPara([]); const a = await fotosPara(['--aplicar']);
    prueba('E2 sin el SQL 17 (faltan los productos) no hace nada, ni simulando ni aplicando, y lo explica', s.code === 2 && a.code === 2 && /Faltan 13 de 13 productos/.test(s.out) && /17-rebrand-northe\.sql/.test(a.out)
      && escrituras().length === 0 && falso.archivos.size === 0, s.out.slice(-300) + a.out.slice(-200));
  }

  await dbf.exec(SQL17);
  {
    // E3. simulacion
    const antes = JSON.stringify(await fotosBD());
    const w0 = escrituras().length;
    const s = await fotosPara([]);
    prueba('E3 por defecto SIMULA: lista las 13 fotos, no sube nada y no cambia la base', s.code === 0 && (s.out.match(/\[\d+ KB\]/g) || []).length === 13 && /SIMULACION/.test(s.out) && escrituras().length === w0
      && falso.archivos.size === 0 && JSON.stringify(await fotosBD()) === antes, s.out.slice(-400));

    // E4. aplicar
    const a = await fotosPara(['--aplicar']);
    const bd = await fotosBD();
    const claves = [...falso.archivos.keys()];
    const bytesOK = ARCHIVOS.every((f) => falso.archivos.get(`productos/${TAQ}/${f}`) && hash(falso.archivos.get(`productos/${TAQ}/${f}`)) === hash(fs.readFileSync(path.join(carpeta, f))));
    prueba('E4 --aplicar sube las 13 fotos, SOLO bajo {restaurante_id}/, con los mismos bytes', a.code === 0 && claves.length === 13 && claves.every((k) => k.startsWith(`productos/${TAQ}/`)) && bytesOK, a.out.slice(-500));
    const esperado = Object.fromEntries(ARCHIVOS.map((f, i) => [['nb-big-norte', 'nb-crispy-norte', 'nb-lil-norte', 'nb-classic-norte', 'nb-smoky-norte', 'nb-full-norte', 'nb-creamy-norte', 'nb-dirty-norte', 'nb-chori-norte', 'nb-agua', 'nb-coca-cola', 'nb-pepsi', 'nb-sprite'][i], `${PREFIJO_BD}${TAQ}/${f}`]));
    prueba('E5 cada producto apunta a SU foto, con la direccion publica exacta (la base la acepta: trigger productos_validar)', igual(Object.fromEntries(bd.map((p) => [p.id, p.imagen])), esperado), JSON.stringify(bd).slice(0, 300));
    const respuestas = [];
    for (const f of ARCHIVOS) { const r = await fetch(`${falso.url}/storage/v1/object/public/productos/${TAQ}/${f}`); respuestas.push(r.status); }
    prueba('E6 la lectura publica de cada foto responde 200', respuestas.every((c) => c === 200), respuestas.join());
    prueba('E7 la salida dice OK 13 veces y no menciona la llave', (a.out.match(/^\s+OK /gm) || []).length === 13 && !a.out.includes('FAKE_0000'), a.out.slice(-300));
    prueba('E8 no se escribio NADA fuera de la carpeta del restaurante ni en otras tablas (solo POST de Storage bajo {rid}/ y PATCH de productos)',
      escrituras().every((p) => new RegExp(`^(POST /storage/v1/object/productos/${TAQ}/[a-z-]+\\.jpg|PATCH /rest/v1/productos)$`).test(p)), JSON.stringify(escrituras().filter((p) => !/^POST \/storage\/v1\/object\/productos\/|^PATCH \/rest\/v1\/productos$/.test(p))));
  }
  {
    // E9. idempotente
    const { r, nuevas } = await nLlamadas(() => fotosPara(['--aplicar']));
    prueba('E9 repetir --aplicar: sale 0, dice que las 13 ya estaban y NO escribe nada (ni un POST ni un PATCH)', r.code === 0 && /13 ya estaban/.test(r.out) && nuevas.filter((p) => !/^GET /.test(p)).length === 0, r.out.slice(-300) + nuevas.filter((p) => !/^GET /.test(p)).join());
    // E10. un archivo remoto distinto se reemplaza (upsert)
    falso.archivos.set(`productos/${TAQ}/pepsi.jpg`, Buffer.from('OTRO CONTENIDO'));
    const { r: r2, nuevas: n2 } = await nLlamadas(() => fotosPara(['--aplicar']));
    prueba('E10 si en Storage hay OTRO contenido con ese nombre, lo reemplaza con upsert (sin 409): una sola subida y mismos bytes', r2.code === 0 && n2.filter((p) => /^POST \/storage/.test(p)).length === 1
      && hash(falso.archivos.get(`productos/${TAQ}/pepsi.jpg`)) === hash(fs.readFileSync(path.join(carpeta, 'pepsi.jpg'))), r2.out.slice(-300) + n2.join());
    // E11. una foto ajena se respeta; --forzar la cambia
    await dbf.query(`update public.productos set imagen = 'Recursos/otra/foto.png' where restaurante_id = '${TAQ}' and id = 'nb-lil-norte'`);
    const r3 = await fotosPara(['--aplicar']);
    const lil = (await fotosBD()).find((p) => p.id === 'nb-lil-norte').imagen;
    prueba('E11 un producto que YA tiene otra foto se respeta (SALTA) y el resumen lo cuenta', r3.code === 0 && lil === 'Recursos/otra/foto.png' && /SALTA .*lil-norte\.jpg/.test(r3.out) && /1 saltada/.test(r3.out), r3.out.slice(-300));
    const r4 = await fotosPara(['--aplicar', '--forzar']);
    const lil2 = (await fotosBD()).find((p) => p.id === 'nb-lil-norte').imagen;
    prueba('E12 con --forzar la reemplaza por la de Northe', r4.code === 0 && lil2 === `${PREFIJO_BD}${TAQ}/lil-norte.jpg`, r4.out.slice(-300));
  }
  {
    // E13. archivos locales malos: abortan ANTES de subir nada
    await dbf.query(`update public.productos set imagen = null where restaurante_id = '${TAQ}' and id like 'nb-%'`);
    await dbf.exec(`delete from storage.objects where bucket_id = 'productos'`); falso.archivos.clear();
    fs.unlinkSync(path.join(carpeta, 'sprite.jpg'));
    const a = await fotosPara(['--aplicar']);
    fs.writeFileSync(path.join(carpeta, 'sprite.jpg'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5000, 1)]));
    const b = await fotosPara(['--aplicar']);
    fs.writeFileSync(path.join(carpeta, 'sprite.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2200000, 7)]));
    const c = await fotosPara(['--aplicar']);
    prueba('E13 una foto que falta, que no es JPG o que pesa mas de 2 MB: sale con 2, lo explica y NO sube ninguna (ni escribe en la base)',
      a.code === 2 && b.code === 2 && c.code === 2 && /sprite\.jpg: no existe/.test(a.out) && /no parece un JPG/.test(b.out) && /menos de 2 MB/.test(c.out)
      && falso.archivos.size === 0 && (await fotosBD()).every((p) => p.imagen === null), [a.out, b.out, c.out].join(' | ').slice(0, 400));
    prepararCarpeta();
  }
  {
    // E14. un corte a mitad se reanuda
    const cortarPepsi = (req, url) => req.method === 'POST' && /\/pepsi\.jpg$/.test(url.pathname);
    const a = await fotosPara(['--aplicar'], {}, { cortarEn: cortarPepsi });
    const conFoto = (await fotosBD()).filter((p) => p.imagen).length;
    prueba('E14 si falla la subida de UNA foto: sale con 1, las otras 12 quedan bien y el resumen cuenta el error', a.code === 1 && /ERROR .*pepsi\.jpg/.test(a.out) && /1 con error/.test(a.out) && conFoto === 12, a.out.slice(-400));
    const b = await fotosPara(['--aplicar']);
    prueba('E15 al volver a correr termina lo que faltaba (13 en total) y reconoce las 12 anteriores', b.code === 0 && /12 ya estaban/.test(b.out) && (await fotosBD()).filter((p) => p.imagen).length === 13, b.out.slice(-300));
  }
  prueba('E16 la llave NUNCA aparece en la salida de ninguna corrida (ni la mitad; el texto de ayuda "sb_secret_..." de un mensaje no cuenta)', !/FAKE_0000/.test(todaLaSalida) && !/sb_(secret|publishable)_[A-Za-z0-9]/.test(todaLaSalida));
  {
    const codigo = leer('supabase/subir-fotos-northe.mjs');
    const posts = codigo.match(/method:\s*"POST"/g) || [];
    prueba('E17 el codigo sube con UN solo punto de escritura al Storage y siempre bajo `${rid}/` (nunca una ruta suelta)',
      posts.length === 1 && /const nombre = `\$\{rid\}\/\$\{archivo\}`/.test(codigo) && /storage\/v1\/object\/productos\/\$\{rutaCodificada\(nombre\)\}/.test(codigo)
      && /x-upsert/.test(codigo) && /NOMBRE_VALIDO/.test(codigo) && !/console\.(log|error)\([^)]*\bH\b/.test(codigo) && !/console\.(log|error)\([^)]*LLAVE/.test(codigo));
    prueba('E18 el script de fotos lista los 13 ids del SQL 17 (la tabla fija archivo -> producto coincide con el SQL)',
      NUEVOS.every((id) => codigo.includes(`"${id}"`)) && NUEVOS.every((id) => SQL17.includes(`'${id}'`)));
  }
  await falso.cerrar();
  fs.rmSync(tmp, { recursive: true, force: true });

  // ================= F. front, servidor y documentacion =================
  {
    const html = leer('index.html');
    const ini = html.indexOf('function crearEnlace(');
    const fin = html.indexOf('function ocultarSiVacio(');
    const trozo = html.slice(ini, fin);
    const correrTrozo = (enlazan) => {
      const creados = [];
      const documento = { createElement: () => { const el = { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, textContent: '' }; creados.push(el); return el; } };
      const ctx = vm.createContext({ document: documento });
      vm.runInContext(trozo.replace('const REDES_ENLAZAN = false;', `const REDES_ENLAZAN = ${enlazan};`) + '; this.crearBotonRed = crearBotonRed; this.crearEnlace = crearEnlace;', ctx);
      return { ig: ctx.crearBotonRed('https://instagram.com/thenorthe.burgers', 'Instagram', '📷', 'thenorthe.burgers'), wa: ctx.crearEnlace('https://wa.me/573125249438', 'WhatsApp', '💬') };
    };
    const off = correrTrozo(false), on = correrTrozo(true);
    prueba('F1 con REDES_ENLAZAN=false el boton de Instagram se ve pero NO lleva a ninguna parte (sin href ni target), con el usuario en el tooltip y en el texto para lectores',
      off.ig.attrs.href === undefined && off.ig.attrs.target === undefined && off.ig.textContent === '📷' && off.ig.attrs.title === 'Instagram @thenorthe.burgers' && /@thenorthe\.burgers/.test(off.ig.attrs['aria-label']) && off.ig.style.cursor === 'default', JSON.stringify(off.ig));
    prueba('F2 con REDES_ENLAZAN=true vuelve el enlace real (href, pestana nueva, noopener)', on.ig.attrs.href === 'https://instagram.com/thenorthe.burgers' && on.ig.attrs.target === '_blank' && on.ig.attrs.rel === 'noopener', JSON.stringify(on.ig));
    prueba('F3 el WhatsApp SIEMPRE enlaza (numero real), con la constante en false o en true', off.wa.attrs.href === 'https://wa.me/573125249438' && on.wa.attrs.href === 'https://wa.me/573125249438');
    prueba('F4 la constante es UNA sola, esta en false y esta muy comentada (como reactivarla, obligatorio antes del segundo restaurante, afecta a todos)',
      (html.match(/const REDES_ENLAZAN = /g) || []).length === 1 && /const REDES_ENLAZAN = false;/.test(html) && /COMO REACTIVARLA/.test(trozo) && /OBLIGATORIO ANTES DE VENDER A UN SEGUNDO RESTAURANTE/.test(trozo)
      && /Afecta a TODOS los restaurantes/.test(trozo) && /true/.test(trozo.slice(trozo.indexOf('COMO REACTIVARLA'), trozo.indexOf('COMO REACTIVARLA') + 220)));
    prueba('F5 el pie solo dibuja Instagram y TikTok con crearBotonRed (nunca con crearEnlace) y el WhatsApp con crearEnlace',
      /crearBotonRed\("https:\/\/instagram\.com\/"/.test(html) && /crearBotonRed\("https:\/\/tiktok\.com\/@"/.test(html) && !/crearEnlace\("https:\/\/(instagram|tiktok)/.test(html) && /crearEnlace\("https:\/\/wa\.me\//.test(html));
  }
  {
    const cp = leer('api/crear-pedido.js');
    prueba('F6 la referencia del pedido nuevo empieza por "PED-" y ningun literal "TAQ-" queda en api/ (ni en codigo ni como valor)',
      /const referencia = "PED-" \+ Date\.now\(\)/.test(cp) && !fs.readdirSync(`${REPO}/api`).filter((f) => f.endsWith('.js'))
        .some((f) => leer('api/' + f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).some((l) => /["'`]TAQ-/.test(l))));
    const pedido = leer('pedido.html');
    const re = new RegExp(pedido.match(/const CLAVE_VALIDA = \/(.+)\/;/)[1]);
    prueba('F7 pedido.html acepta tanto la referencia nueva (PED-...) como la vieja (TAQ-...) y su token', re.test('PED-1788325338685-ab12cd') && re.test('TAQ-1788325338685-ab12cd') && re.test('a'.repeat(32)) && !re.test('con espacio') && !re.test('x'));
    const rp = leer('restaurante-publico.js');
    prueba('F8 el favicon prefiere el icono cuadrado (icono_192) y solo cae al logo si no hay', /var url = R\.marca\.icono_192 \|\| R\.marca\.logo;/.test(rp));
    prueba('F9 sw.js sube a v12 y documenta el cambio', /const VERSION = "v12";/.test(leer('sw.js')) && /v12: rebrand/.test(leer('sw.js')));
    const nt = leer('api/_notificar.js');
    prueba('F10 la alerta de CallMeBot ya no trae el emoji de taco', !/1F32E/i.test(nt) && /\\u\{1F354\} \*NUEVO PEDIDO PAGADO\*/.test(nt));
    const { construirComanda } = require(`${REPO}/api/_notificar.js`);
    const texto = construirComanda({ numero: 7, id: 7, referencia: 'PED-1-aaaaaa', cliente_nombre: 'Ana', cliente_telefono: '3001', tipo_pedido: 'local', items: [{ cantidad: 1, nombre: 'Big Norte', precio: 26000 }], total: 26000 });
    prueba('F11 la comanda de WhatsApp de verdad dice 🍔 NUEVO PEDIDO PAGADO y trae la referencia nueva', texto.startsWith('🍔 *NUEVO PEDIDO PAGADO*') && texto.includes('PED-1-aaaaaa'), texto.slice(0, 100));
  }
  {
    const doc = leer('docs/multirestaurante.md');
    const s20 = doc.indexOf('\n## 20.'), s21 = doc.indexOf('\n## 21.');
    prueba('F12 la documentacion tiene la seccion 20 (el rebrand y como repetirlo) y la 21 (propuesta de dominio, sin ejecutar)', s20 > 0 && s21 > s20);
    const t20 = doc.slice(s20, s21), t21 = doc.slice(s21);
    prueba('F13 la seccion 20 cubre: datos que se piden, orden de pasos, SQL, fotos, pruebas, el slug, REDES_ENLAZAN y su reactivacion, la imagen de vista previa pendiente, el prefijo PED-',
      [/Datos que se piden/i, /Orden de pasos/i, /17-rebrand-northe\.sql/, /17-revertir\.sql/, /subir-fotos-northe\.mjs/, /slug/i, /REDES_ENLAZAN/, /20\.7/, /vista previa/i, /PED-/].every((r) => r.test(t20)), '');
    prueba('F14 la seccion 21 cubre: restaurante_dominios, Vercel (dominio y alias), webhook de Wompi, cron-job.org, vistas previas/og, enlaces cacheados, orden seguro con reversa, y dice que NO se ejecuta',
      [/restaurante_dominios/, /Vercel/, /alias/i, /webhook/i, /Wompi/, /cron-job\.org/, /og:image|vistas previas/i, /cache/i, /reversa/i, /NO se ejecut|no se ejecuta|sin ejecutar/i].every((r) => r.test(t21)), '');
  }

  for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}

await main();
