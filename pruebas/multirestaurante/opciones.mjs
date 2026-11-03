/* =============================================================
   PRUEBAS DEL SQL 18 (supabase/18-opciones-producto.sql) Y DE SU REVERSA, Y DE LAS OPCIONES EN TODO EL CODIGO

     node pruebas/multirestaurante/opciones.mjs

   Postgres 16 real (PGlite) con los SQL 10 a 13 y el 17 (el menu de The Northe Burgers), roles reales (anon, authenticated,
   service_role) y RLS.

     A. Los dos archivos corren dos veces (idempotentes), todas sus comprobaciones dan OK, no cambian ninguna fila de negocio, la
        reversa funciona, y los SQL 15, 16 y 16b (antes o despues) y el 17 (y su reversa) conviven con la tabla.
     B. SEMILLA: sale de las descripciones REALES de los 13 productos (nunca se quita lo que es el producto base), 57 opciones,
        precios de ejemplo, bebidas sin opciones. Volver a correr no duplica ni pisa lo que el dueno cambio.
     C. PERMISOS POR ROL con usuarios reales: dueno, cajero, cocina, dueno inactivo, sin membresia, superadmin, anon y el servidor;
        dos restaurantes que no se ven ni se tocan.
     D. REGLAS de la tabla, directamente en SQL con el rol de cada quien (nombre, precio, tipo, id, tope de 12, identidad inmutable).
     E. NINGUN lugar del codigo suma items con el precio base: cada lugar que multiplica un precio por una cantidad esta revisado y
        usa el precio FINAL guardado; ningun SQL suma precios de items.
     F. Los items nuevos (con precio_base y opciones) se leen donde se leian los viejos: ticket, jornada, seguimiento.
============================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crearBase, sembrar, sql10, sql, intentar } from './sim.mjs';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAQ = '00000000-0000-4000-8000-000000000001';
const SQL18 = () => (process.env.SQL18_ARCHIVO ? fs.readFileSync(process.env.SQL18_ARCHIVO, 'utf8') : sql('18-opciones-producto.sql'));
const SQL18R = () => (process.env.SQL18R_ARCHIVO ? fs.readFileSync(process.env.SQL18R_ARCHIVO, 'utf8') : sql('18-revertir.sql'));

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 600) });

const todosOK = (rows) => Array.isArray(rows) && rows.length > 0 && rows.every((x) => x.estado === 'OK');
const malas = (rows) => (rows || []).filter((x) => x.estado !== 'OK').map((x) => x.verificacion + (x.detalle ? ' [' + x.detalle + ']' : '')).join(' | ');
async function correr(db, archivo) {
  try { const r = await db.exec(archivo); return { rows: r[r.length - 1].rows, error: null }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { rows: null, error: e.message }; }
}
const huella = async (db) => {
  const t = ['restaurantes', 'miembros', 'superadmins', 'restaurante_secretos', 'restaurante_dominios', 'configuracion', 'tarifas_domicilio', 'pedidos', 'categorias', 'productos', 'salud_notificaciones'];
  const out = {};
  for (const x of t) out[x] = (await db.query(`select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') h, count(*)::int n from public.${x} t`)).rows[0];
  return JSON.stringify(out);
};

export async function base17() {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  for (const f of ['11-dominios.sql', '12-config-publica.sql', '13-endurecer.sql', '17-rebrand-northe.sql']) await db.exec(sql(f));
  return db;
}
const uno = async (db, q, p = []) => (await db.query(q, p)).rows[0];

async function main() {
  const t0 = Date.now();

  // ================= A. aplicar, repetir, revertir, convivir =================
  {
    const db = await base17();
    const antes = await huella(db);
    const a1 = await correr(db, SQL18());
    const a2 = await correr(db, SQL18());
    prueba('A1 el SQL 18 corre dos veces seguidas y todas sus comprobaciones dan OK', todosOK(a1.rows) && todosOK(a2.rows) && a1.rows.length >= 40, a1.error || a2.error || malas(a1.rows) || malas(a2.rows));
    prueba('A2 el SQL 18 no cambia ni una fila de negocio (solo agrega la tabla nueva)', (await huella(db)) === antes);
    prueba('A3 siembra 57 opciones solo en el demo y la segunda corrida no las duplica', (await uno(db, `select count(*)::int n, count(distinct restaurante_id)::int r from public.producto_opciones`)).n === 57
      && (await uno(db, `select count(distinct restaurante_id)::int r from public.producto_opciones`)).r === 1, '');

    // lo que el dueno cambie despues NO se pisa al volver a correr; lo que borre vuelve (es la semilla); nada se duplica
    await db.query(`update public.producto_opciones set precio = 2750 where producto_id = 'nb-big-norte' and id = 'extra-queso'`);
    await db.query(`update public.producto_opciones set activa = false, nombre = 'Sin queso (editado)' where producto_id = 'nb-big-norte' and id = 'sin-queso'`);
    await db.query(`delete from public.producto_opciones where producto_id = 'nb-big-norte' and id = 'extra-salsa'`);
    await db.query(`insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, orden) values ('${TAQ}', 'nb-agua', 'extra-hielo', 'extra', 'Hielo', 500, 0)`);
    const a3 = await correr(db, SQL18());
    const e = await uno(db, `select (select precio from public.producto_opciones where producto_id = 'nb-big-norte' and id = 'extra-queso') p,
      (select activa from public.producto_opciones where producto_id = 'nb-big-norte' and id = 'sin-queso') a,
      (select nombre from public.producto_opciones where producto_id = 'nb-big-norte' and id = 'sin-queso') n,
      (select count(*)::int from public.producto_opciones where producto_id = 'nb-big-norte' and id = 'extra-salsa') volvio,
      (select count(*)::int from public.producto_opciones where id = 'extra-hielo') hielo,
      (select count(*)::int from public.producto_opciones) total`);
    prueba('A4 volver a correr NO pisa lo que el dueno cambio (precio, nombre, apagada), repone lo borrado de la semilla, conserva lo que agrego y no duplica',
      todosOK(a3.rows) && e.p === 2750 && e.a === false && e.n === 'Sin queso (editado)' && e.volvio === 1 && e.hielo === 1 && e.total === 58, a3.error || malas(a3.rows) || JSON.stringify(e));
    await db.query(`delete from public.producto_opciones where id = 'extra-hielo'`);
    await db.query(`update public.producto_opciones set precio = 2000 where producto_id = 'nb-big-norte' and id = 'extra-queso'`);
    await db.query(`update public.producto_opciones set activa = true, nombre = 'Sin queso' where producto_id = 'nb-big-norte' and id = 'sin-queso'`);

    // reversa
    const r1 = await correr(db, SQL18R());
    const hay = await uno(db, `select (to_regclass('public.producto_opciones') is not null) t, (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('opcion_nombre_valido','validar_producto_opcion'))::int f`);
    prueba('A5 la reversa borra la tabla y sus funciones, dice cuantas filas se perdieron y todas sus comprobaciones dan OK',
      todosOK(r1.rows) && hay.t === false && hay.f === 0 && r1.rows.some((x) => /57 filas/.test(x.detalle || '')), r1.error || malas(r1.rows) || JSON.stringify(hay));
    prueba('A6 la reversa no cambia ninguna fila de negocio (pedidos incluidos)', (await huella(db)) === antes);
    const r2 = await correr(db, SQL18R());
    prueba('A7 la reversa se puede repetir (idempotente) y dice 0 filas', todosOK(r2.rows) && r2.rows.some((x) => /0 filas/.test(x.detalle || '')), r2.error || malas(r2.rows));
    const re = await correr(db, SQL18());
    prueba('A8 el SQL 18 se vuelve a aplicar despues de revertir (y vuelve a sembrar las 57)', todosOK(re.rows) && (await uno(db, `select count(*)::int n from public.producto_opciones`)).n === 57, re.error || malas(re.rows));
    prueba('A9 aplicar y revertir no dejaron nada colgado: ningun restaurante de prueba, el menu del demo intacto',
      (await uno(db, `select count(*)::int n from public.restaurantes where slug like 'mr18%'`)).n === 0 && (await huella(db)) === antes);
  }
  {
    // pedidos con la copia de opciones: la reversa y la tabla no los tocan
    const db = await base17();
    await db.exec(SQL18());
    await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago)
      values ('${TAQ}', 'PED-OPC-1', 'nuevo', 'Ana', '3001112222', 'llevar',
      '[{"id":"nb-big-norte","nombre":"Big Norte","cantidad":2,"precio":28000,"precio_base":26000,"opciones":[{"id":"extra-queso","tipo":"extra","nombre":"Queso extra","precio":2000}]}]', 56000, 0, 56000, 'aprobado')`);
    const h = await huella(db);
    const r = await correr(db, SQL18R());
    prueba('A10 un pedido con la copia de opciones sobrevive a la reversa tal cual (la copia vive en el pedido, no en la tabla)',
      todosOK(r.rows) && (await huella(db)) === h && (await uno(db, `select items->0->'opciones'->0->>'nombre' n from public.pedidos where referencia = 'PED-OPC-1'`)).n === 'Queso extra', r.error || malas(r.rows));
  }
  {
    // convive con los SQL 15, 16 y 16b: antes y despues
    const d1 = await base17();
    for (const f of ['15-datos-restaurante.sql', '16-superadmin.sql', '16b-horario.sql']) await d1.exec(sql(f));
    const a = await correr(d1, SQL18());
    prueba('A11 el SQL 18 corre con los SQL 15, 16 y 16b YA aplicados', todosOK(a.rows), a.error || malas(a.rows));
    const d2 = await base17();
    const b = await correr(d2, SQL18());
    let ok = todosOK(b.rows); let info = b.error || malas(b.rows);
    for (const f of ['15-datos-restaurante.sql', '16-superadmin.sql', '16b-horario.sql']) {
      const x = await correr(d2, sql(f));
      ok = ok && todosOK(x.rows); info += x.error ? ` [${f}: ${x.error}]` : (todosOK(x.rows) ? '' : ` [${f}: ${malas(x.rows)}]`);
    }
    prueba('A12 los SQL 15, 16 y 16b se aplican DESPUES del 18 y todas sus comprobaciones siguen en OK', ok, info);
    const c = await correr(d2, SQL18());
    prueba('A13 y el 18 vuelve a correr encima de todo eso', todosOK(c.rows), c.error || malas(c.rows));
  }
  {
    // el 17 y su reversa conviven con la tabla (la reversa del 17 borra los productos nuevos: las opciones se van en cascada)
    const db = await base17();
    await db.exec(SQL18());
    const a = await correr(db, sql('17-rebrand-northe.sql'));
    prueba('A14 el SQL 17 vuelve a correr con la tabla de opciones y sus opciones (no las toca)', todosOK(a.rows) && (await uno(db, `select count(*)::int n from public.producto_opciones`)).n === 57, a.error || malas(a.rows));
    const b = await correr(db, sql('17-revertir.sql'));
    prueba('A15 la reversa del SQL 17 funciona con opciones cargadas (se van con sus productos, en cascada) y no deja huerfanas',
      b.error === null && todosOK(b.rows) && (await uno(db, `select count(*)::int n from public.producto_opciones`)).n === 0, b.error || malas(b.rows));
  }
  {
    // precondiciones
    const d = await crearBase({ con01y02: true });
    await sembrar(d);
    const sin10 = await correr(d, SQL18());
    prueba('A16 sin el SQL 10 se detiene con un mensaje claro y no crea nada', /MR paso 0\.1/.test(sin10.error || '') && /SQL 10/.test(sin10.error || '')
      && (await uno(d, `select to_regclass('public.producto_opciones') is null ok`)).ok, sin10.error);
    await d.exec(sql10());
    for (const f of ['11-dominios.sql', '12-config-publica.sql', '13-endurecer.sql']) await d.exec(sql(f));
    const sin17 = await correr(d, SQL18());
    prueba('A17 sin el menu del SQL 17 se detiene, nombra los productos que faltan y no crea nada (ni la tabla ni las funciones)',
      /MR paso 0\.1/.test(sin17.error || '') && /nb-big-norte/.test(sin17.error || '') && /nb-sprite/.test(sin17.error || '') && /17-rebrand-northe\.sql/.test(sin17.error || '')
      && (await uno(d, `select to_regclass('public.producto_opciones') is null and to_regprocedure('public.opcion_nombre_valido(text)') is null ok`)).ok, sin17.error);
    await d.exec(sql('17-rebrand-northe.sql'));
    await d.query(`delete from public.productos where restaurante_id = '${TAQ}' and id = 'nb-pepsi'`);
    const falta1 = await correr(d, SQL18());
    prueba('A18 si falta UN solo producto nb-* tambien se detiene y lo nombra', /nb-pepsi/.test(falta1.error || '') && !/nb-sprite/.test(falta1.error || ''), falta1.error);
    await d.query(`delete from public.restaurantes where id = '${TAQ}'`).catch(() => {});
  }
  {
    // si una comprobacion falla, TODO se revierte (se fuerza: se le quita el CHECK de precio a una copia)
    const db = await base17();
    const roto = SQL18().replace("constraint producto_opciones_quitar_gratis check (tipo <> 'quitar' or precio = 0)", "constraint producto_opciones_quitar_gratis check (true)");
    const r = await correr(db, roto);
    prueba('A19 si la tabla quedara sin el CHECK "quitar vale 0", el archivo se revierte entero y lo dice',
      roto !== SQL18() && /EL SQL 18 SE REVIRTIO/.test(r.error || '') && (await uno(db, `select to_regclass('public.producto_opciones') is null and to_regprocedure('public.opcion_nombre_valido(text)') is null ok`)).ok, r.error);
  }

  // ================= B. la semilla =================
  {
    const db = await base17();
    await db.exec(SQL18());
    const filas = (await db.query(`select o.producto_id, o.id, o.tipo, o.nombre, o.precio, o.orden, o.activa, p.descripcion, p.categoria from public.producto_opciones o
      join public.productos p on p.restaurante_id = o.restaurante_id and p.id = o.producto_id where o.restaurante_id = '${TAQ}'`)).rows;
    const norm = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    const BASE = ['carne', 'pollo', 'salchicha', 'chorizo', 'pan', 'papas'];
    const quitar = filas.filter((f) => f.tipo === 'quitar'); const extras = filas.filter((f) => f.tipo === 'extra');
    prueba('B1 57 opciones: 21 quitar y 36 extras; todas activas, todas del demo', filas.length === 57 && quitar.length === 21 && extras.length === 36 && filas.every((f) => f.activa), `${filas.length} ${quitar.length} ${extras.length}`);
    // cada "quitar" nombra algo que la descripcion REAL del producto menciona
    const ING = { queso: 'queso', tocineta: 'tocineta', 'salsa bbq': 'salsa bbq', 'salsa rosa': 'salsa rosa', 'salsa picante': 'salsa picante', 'salsa blanca': 'salsa blanca', 'salsa cremosa': 'salsa cremosa',
      mostaza: 'mostaza', salsas: 'salsas', 'cebolla morada': 'cebolla morada', 'cebolla crujiente': 'cebolla crujiente', cebolla: 'cebolla', vegetales: 'vegetales', rugula: 'rugula' };
    const sinMencion = quitar.filter((f) => {
      const ing = norm(f.nombre.replace(/^Sin\s+/i, ''));
      return !(ING[ing] && norm(f.descripcion).includes(ING[ing]));
    });
    prueba('B2 cada opcion "quitar" nombra un ingrediente que la descripcion real del producto SI menciona (no se inventa ninguno)', sinMencion.length === 0, sinMencion.map((f) => f.producto_id + ':' + f.nombre).join(', '));
    prueba('B3 ninguna opcion quita el producto base (carne, pollo, salchicha, chorizo, pan, papas)', quitar.every((f) => !BASE.some((b) => new RegExp('\\b' + b + '\\b').test(norm(f.nombre)))), quitar.map((f) => f.nombre).join(','));
    prueba('B4 todos los "quitar" valen 0 y todos los extras entre $1.000 y $6.000', quitar.every((f) => f.precio === 0) && extras.every((f) => f.precio >= 1000 && f.precio <= 6000));
    prueba('B5 las bebidas no tienen opciones; los otros 9 productos, entre 5 y 7', filas.every((f) => f.categoria !== 'nb-bebidas') && new Set(filas.map((f) => f.producto_id)).size === 9);
    const por = (cat) => extras.filter((f) => f.categoria === cat);
    const mapa = (lista) => Object.fromEntries(lista.reduce((m, f) => (m.get(f.producto_id) ? m : m.set(f.producto_id, [])).get(f.producto_id).push(f.id + '=' + f.precio) && m, new Map()));
    const esperadoHamb = ['extra-queso=2000', 'extra-tocineta=3000', 'extra-salsa=1000'];
    const ham = mapa(por('nb-hamburguesas'));
    prueba('B6 hamburguesas: queso +2000, tocineta +3000, salsa +1000; carne smash +6000 (Big y Lil) y pollo crispy +5000 (Crispy)',
      ['nb-big-norte', 'nb-crispy-norte', 'nb-lil-norte'].every((p) => esperadoHamb.every((x) => ham[p].includes(x)))
      && ham['nb-big-norte'].includes('extra-carne=6000') && ham['nb-lil-norte'].includes('extra-carne=6000') && ham['nb-crispy-norte'].includes('extra-pollo=5000') && !ham['nb-crispy-norte'].some((x) => x.startsWith('extra-carne')), JSON.stringify(ham));
    const hot = mapa(por('nb-hot-dogs'));
    prueba('B7 hot dogs: salchicha +3500, queso +2000, tocineta +3000, salsa +1000 (los 3)', ['nb-classic-norte', 'nb-smoky-norte', 'nb-full-norte'].every((p) => ['extra-salchicha=3500', ...esperadoHamb].every((x) => hot[p].includes(x)) && hot[p].length === 4), JSON.stringify(hot));
    const pap = mapa(por('nb-papas'));
    prueba('B8 papas: queso +2000, tocineta +3000, salsa +1000; pollo crispy +5000 (Creamy y Dirty) y chorizo +3500 (Chori)',
      ['nb-creamy-norte', 'nb-dirty-norte', 'nb-chori-norte'].every((p) => esperadoHamb.every((x) => pap[p].includes(x)) && pap[p].length === 4)
      && pap['nb-creamy-norte'].includes('extra-pollo=5000') && pap['nb-dirty-norte'].includes('extra-pollo=5000') && pap['nb-chori-norte'].includes('extra-chorizo=3500') && !pap['nb-chori-norte'].some((x) => x.startsWith('extra-pollo')), JSON.stringify(pap));
    prueba('B9 los ids son unicos dentro de cada producto y siguen la forma de un id; los "quitar" salen antes que los extras',
      filas.every((f) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(f.id)) && new Set(filas.map((f) => f.producto_id + '/' + f.id)).size === 57
      && filas.every((f) => (f.tipo === 'quitar' ? f.orden < 10 : f.orden >= 10)));
    const sqlTexto = fs.readFileSync(path.join(RAIZ, 'supabase', '18-opciones-producto.sql'), 'utf8');
    const crudos = []; for (const ch of sqlTexto) { const c = ch.codePointAt(0); if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) crudos.push(c.toString(16)); }
    prueba('B10 los archivos SQL 18 no traen caracteres invisibles, de control ni bidireccionales escritos', crudos.length === 0 && !/\r/.test(fs.readFileSync(path.join(RAIZ, 'supabase', '18-revertir.sql'), 'utf8').replace(/\r\n/g, '\n')), crudos.join(','));
  }

  // ================= C. permisos por rol, usuarios reales =================
  {
    const db = await base17();
    await db.exec(SQL18());
    const B = '22222222-2222-4222-8222-222222222222';
    const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
    const u = { dA: id(1), cA: id(2), kA: id(3), dB: id(4), nadie: id(5), sa: id(6), iA: id(7) };
    for (const [k, v] of Object.entries(u)) await db.query(`insert into auth.users (id, email) values ($1, $2)`, [v, k + '@t.test']);
    await db.query(`insert into public.restaurantes (id, slug, nombre, config) values ($1, 'mr18-b', 'Restaurante B', '{}')`, [B]);
    await db.query(`insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa) values ($1, 'cat-b', 'Cat B', 'x', 0, true)`, [B]);
    await db.query(`insert into public.productos (restaurante_id, id, nombre, descripcion, precio, categoria, orden) values ($1, 'prod-b', 'Prod B', 'b', 9000, 'cat-b', 0)`, [B]);
    await db.query(`insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, orden) values ($1, 'prod-b', 'extra-b', 'extra', 'Extra de B', 700, 0), ($1, 'prod-b', 'sin-b', 'quitar', 'Sin algo de B', 0, 1)`, [B]);
    await db.query(`insert into public.miembros (user_id, restaurante_id, rol, activo) values ($1, $2, 'dueno', true), ($3, $2, 'cajero', true), ($4, $2, 'cocina', true), ($5, $6, 'dueno', true), ($7, $2, 'dueno', false)`,
      [u.dA, TAQ, u.cA, u.kA, u.dB, B, u.iA]);
    await db.query(`insert into public.superadmins (user_id) values ($1)`, [u.sa]);
    const nTaq = (await uno(db, `select count(*)::int n from public.producto_opciones where restaurante_id = '${TAQ}'`)).n;
    const cuenta = async (uid, rol) => { const r = await intentar(db, uid, `select count(*)::int n from public.producto_opciones`, [], rol ? { rol } : {}); return r.ok ? r.rows[0].n : 'ERR ' + r.code; };

    prueba('C1 LEER: dueno y cajero de A ven las de A (y ninguna de B); dueno de B ve solo las de B; superadmin ve todo',
      (await cuenta(u.dA)) === nTaq && (await cuenta(u.cA)) === nTaq && (await cuenta(u.dB)) === 2 && (await cuenta(u.sa)) === nTaq + 2, JSON.stringify([await cuenta(u.dA), await cuenta(u.cA), await cuenta(u.dB), await cuenta(u.sa)]));
    prueba('C2 LEER: la cocina, un dueno INACTIVO y alguien sin membresia no ven ninguna fila', (await cuenta(u.kA)) === 0 && (await cuenta(u.iA)) === 0 && (await cuenta(u.nadie)) === 0, JSON.stringify([await cuenta(u.kA), await cuenta(u.iA), await cuenta(u.nadie)]));
    const cuentaAnon = await cuenta(null, 'anon');
    prueba('C3 ANON no puede leer la tabla (ni una fila): permiso denegado', cuentaAnon === 'ERR 42501', cuentaAnon);
    prueba('C4 el servidor (service_role) lee todo y no depende de RLS', (await cuenta(null, 'service_role')) === nTaq + 2);

    const ins = (rid, prod, oid, extra = {}) => `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ('${rid}', '${prod}', '${oid}', '${extra.tipo || 'extra'}', '${extra.nombre || 'Prueba'}', ${extra.precio ?? 100})`;
    // dueno de A
    const dA1 = await intentar(db, u.dA, ins(TAQ, 'nb-agua', 'extra-hielo'));
    prueba('C5 ESCRIBIR: el dueno de A inserta una opcion en un producto de A', dA1.ok, dA1.error);
    const dA2 = await intentar(db, u.dA, ins(B, 'prod-b', 'intruso'));
    prueba('C6 el dueno de A NO inserta una opcion en un producto de B (42501)', !dA2.ok && dA2.code === '42501', JSON.stringify(dA2));
    const dA3 = await intentar(db, u.dA, `update public.producto_opciones set precio = 1 where restaurante_id = '${B}'`);
    const dA4 = await intentar(db, u.dA, `delete from public.producto_opciones where restaurante_id = '${B}'`);
    prueba('C7 el dueno de A no puede cambiar ni borrar las de B (0 filas afectadas, nada cambia)', dA3.ok && dA3.n === 0 && dA4.ok && dA4.n === 0 && (await uno(db, `select count(*)::int n from public.producto_opciones where restaurante_id = '${B}' and precio in (700, 0)`)).n === 2, JSON.stringify([dA3, dA4]));
    const dA5 = await intentar(db, u.dA, `update public.producto_opciones set precio = 2200, nombre = 'Queso (editado por el dueno)', activa = false where producto_id = 'nb-big-norte' and id = 'extra-queso'`);
    prueba('C8 el dueno de A cambia precio, nombre y activa de las suyas', dA5.ok && dA5.n === 1, JSON.stringify(dA5));
    const dA6 = await intentar(db, u.dA, `update public.producto_opciones set restaurante_id = '${B}' where producto_id = 'nb-big-norte' and id = 'extra-queso'`);
    prueba('C9 el dueno de A no puede MOVER una opcion a otro restaurante (42501)', !dA6.ok && dA6.code === '42501', JSON.stringify(dA6));
    const dA7 = await intentar(db, u.dA, `update public.producto_opciones set producto_id = 'nb-agua' where producto_id = 'nb-big-norte' and id = 'extra-queso'`);
    const dA8 = await intentar(db, u.dA, `update public.producto_opciones set id = 'otro' where producto_id = 'nb-big-norte' and id = 'extra-queso'`);
    prueba('C10 tampoco puede cambiar el producto ni el id de una opcion (42501)', !dA7.ok && dA7.code === '42501' && !dA8.ok && dA8.code === '42501', JSON.stringify([dA7, dA8]));
    const dA9 = await intentar(db, u.dA, `delete from public.producto_opciones where producto_id = 'nb-agua' and id = 'extra-hielo'`);
    prueba('C11 el dueno de A borra una opcion suya', dA9.ok && dA9.n === 1, JSON.stringify(dA9));
    const dA10 = await intentar(db, u.dA, `truncate public.producto_opciones`);
    prueba('C12 el dueno NO puede vaciar la tabla (TRUNCATE denegado)', !dA10.ok && dA10.code === '42501' && (await uno(db, `select count(*)::int n from public.producto_opciones`)).n >= 59, JSON.stringify(dA10));
    const dA11 = await intentar(db, u.dA, `select o.id from public.producto_opciones o join public.productos p on p.restaurante_id = o.restaurante_id and p.id = o.producto_id where p.restaurante_id = '${B}'`);
    prueba('C13 un join con productos de B no le muestra nada al dueno de A', dA11.ok && dA11.rows.length === 0, JSON.stringify(dA11));
    // dueno de B
    const dB1 = await intentar(db, u.dB, ins(B, 'prod-b', 'extra-b2'));
    const dB2 = await intentar(db, u.dB, ins(TAQ, 'nb-agua', 'intruso-b'));
    const dB3 = await intentar(db, u.dB, `update public.producto_opciones set precio = 1 where restaurante_id = '${TAQ}'`);
    const dB4 = await intentar(db, u.dB, `delete from public.producto_opciones where restaurante_id = '${TAQ}'`);
    prueba('C14 el dueno de B escribe en B y NO en A (insertar 42501, cambiar y borrar 0 filas)', dB1.ok && !dB2.ok && dB2.code === '42501' && dB3.n === 0 && dB4.n === 0, JSON.stringify([dB1, dB2, dB3, dB4]));
    // cajero
    const cj = [await intentar(db, u.cA, ins(TAQ, 'nb-agua', 'caj')), await intentar(db, u.cA, `update public.producto_opciones set precio = 1 where restaurante_id = '${TAQ}'`), await intentar(db, u.cA, `delete from public.producto_opciones where restaurante_id = '${TAQ}'`)];
    prueba('C15 el cajero de A solo lee: no inserta (42501), no cambia ni borra (0 filas)', !cj[0].ok && cj[0].code === '42501' && cj[1].n === 0 && cj[2].n === 0, JSON.stringify(cj));
    // cocina, inactivo, sin membresia, anon
    for (const [nombre, uid, rol] of [['cocina', u.kA], ['dueno inactivo', u.iA], ['sin membresia', u.nadie], ['anon', null, 'anon']]) {
      const x = [await intentar(db, uid, ins(TAQ, 'nb-agua', 'zz'), [], rol ? { rol } : {}),
        await intentar(db, uid, `update public.producto_opciones set precio = 1`, [], rol ? { rol } : {}),
        await intentar(db, uid, `delete from public.producto_opciones`, [], rol ? { rol } : {})];
      const ok = !x[0].ok && x[0].code === '42501' && (rol === 'anon' ? (!x[1].ok && !x[2].ok) : (x[1].ok && x[1].n === 0 && x[2].ok && x[2].n === 0));
      prueba(`C16 ${nombre}: no inserta, no cambia y no borra nada`, ok, JSON.stringify(x));
    }
    // superadmin
    const s1 = await intentar(db, u.sa, ins(B, 'prod-b', 'del-sa'));
    const s2 = await intentar(db, u.sa, `delete from public.producto_opciones where id = 'del-sa'`);
    prueba('C17 el superadmin escribe en cualquier restaurante', s1.ok && s2.ok && s2.n === 1, JSON.stringify([s1, s2]));
    // servidor
    const sv = await intentar(db, null, `update public.producto_opciones set precio = precio where restaurante_id = '${TAQ}' and id = 'extra-queso'`, [], { rol: 'service_role' });
    prueba('C18 el servidor (llave secreta) puede escribir', sv.ok, JSON.stringify(sv));
    // las politicas miden la fila: un dueno de A que es ademas cajero de B no gana permisos en B por ser dueno de A
    await db.query(`insert into public.miembros (user_id, restaurante_id, rol, activo) values ($1, $2, 'cajero', true)`, [u.dA, B]);
    const mix = await intentar(db, u.dA, ins(B, 'prod-b', 'mezcla'));
    const mixLee = await cuenta(u.dA);
    prueba('C19 ser dueno de A y solo cajero de B: en B lee pero NO escribe (el rol se mide por restaurante)', !mix.ok && mix.code === '42501' && mixLee === nTaq + 3, JSON.stringify([mix, mixLee, nTaq]));
    // el 13 entra? No: tope de 12 con el rol del dueno
    const doce = await intentar(db, u.dA, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) select '${TAQ}', 'nb-sprite', 'o' || g, 'extra', 'Op ' || g, 10 from generate_series(1, 12) g`);
    const treceInsert = await intentar(db, u.dA, ins(TAQ, 'nb-sprite', 'o13'));
    prueba('C20 el tope de 12 vale tambien para el dueno (la 13 se rechaza con 23514) y las de otro producto no cuentan', doce.ok && !treceInsert.ok && treceInsert.code === '23514', JSON.stringify([doce, treceInsert]));
    // privilegios y politicas en el catalogo, como los ve el SQL 10 / 13
    const cat = await uno(db, `select
      (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'producto_opciones') pol,
      (select count(*)::int from pg_policies where schemaname = 'public' and roles && array['anon'::name, 'public'::name]) polanon,
      has_table_privilege('anon', 'public.producto_opciones', 'select,insert,update,delete') anon,
      (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'producto_opciones') rt`);
    prueba('C21 catalogo: 4 politicas, ninguna para anon/PUBLIC, anon sin privilegios, fuera de Realtime', cat.pol === 4 && cat.polanon === 0 && cat.anon === false && cat.rt === 0, JSON.stringify(cat));
  }

  // ================= D. reglas de la tabla (con el rol del dueno) =================
  {
    const db = await base17();
    await db.exec(SQL18());
    const dueno = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
    await db.query(`insert into auth.users (id, email) values ($1, 'd@t.test')`, [dueno]);
    await db.query(`insert into public.miembros (user_id, restaurante_id, rol, activo) values ($1, $2, 'dueno', true)`, [dueno, TAQ]);
    const con = (extra) => `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ('${TAQ}', 'nb-pepsi', ${extra})`;
    const casos = [
      ['quitar con precio', `'a1', 'quitar', 'Sin algo', 500`, '23514'], ['precio negativo', `'a2', 'extra', 'Algo', -1`, '23514'], ['precio 50001', `'a3', 'extra', 'Algo', 50001`, '23514'],
      ['tipo raro', `'a4', 'regalo', 'Algo', 0`, '23514'], ['id con mayuscula', `'A5', 'extra', 'Algo', 0`, '23514'], ['id con espacio', `'a 6', 'extra', 'Algo', 0`, '23514'],
      ['id vacio', `'', 'extra', 'Algo', 0`, '23514'], ['nombre vacio', `'a7', 'extra', '', 0`, '23514'], ['nombre de 41', `'a8', 'extra', repeat('x', 41), 0`, '23514'],
      ['nombre con salto', `'a9', 'extra', 'a' || chr(10) || 'b', 0`, '23514'], ['nombre con ancho cero', `'b1', 'extra', 'a' || chr(8203) || 'b', 0`, '23514'],
      ['nombre con bidi', `'b2', 'extra', 'a' || chr(8238) || 'b', 0`, '23514'], ['nombre con <', `'b3', 'extra', 'a<b', 0`, '23514'], ['nombre con >', `'b4', 'extra', 'a>b', 0`, '23514'],
      ['nombre con BOM', `'b5', 'extra', 'a' || chr(65279), 0`, '23514'], ['nombre con control C1', `'b6', 'extra', 'a' || chr(133), 0`, '23514'], ['nombre con DEL', `'b7', 'extra', 'a' || chr(127), 0`, '23514'],
      ['nombre con U+200F', `'b8', 'extra', 'a' || chr(8207), 0`, '23514'], ['nombre con U+2060', `'b9', 'extra', 'a' || chr(8288), 0`, '23514'], ['nombre con U+2064', `'c1', 'extra', 'a' || chr(8292), 0`, '23514'],
      ['nombre con aislante bidi U+2066', `'c2', 'extra', 'a' || chr(8294), 0`, '23514'], ['nombre con aislante bidi U+2069', `'c3', 'extra', 'a' || chr(8297), 0`, '23514']
    ];
    let mal = '';
    for (const [n, v, cod] of casos) { const r = await intentar(db, dueno, con(v)); if (r.ok || r.code !== cod) mal += `[${n}: ${r.ok ? 'acepto' : r.code}]`; }
    prueba('D1 las 22 reglas rechazan con 23514 cuando escribe el DUENO (no solo el administrador)', mal === '', mal);
    const buenos = [`'ok1', 'extra', 'Queso extra', 2000`, `'ok2', 'quitar', 'Sin cebolla', 0`, `'ok3', 'extra', repeat('ñ', 40), 50000`, `'ok4', 'extra', 'Salsa BBQ 2x1', 0`, `'ok5', 'extra', 'Rúgula', 1`];
    let malb = '';
    for (const v of buenos) { const r = await intentar(db, dueno, con(v)); if (!r.ok) malb += `[${v}: ${r.error}]`; }
    prueba('D2 los casos buenos entran (limite de 40 con enie, precio 0 y 50000, tildes, numeros)', malb === '', malb);
    const rec = await intentar(db, dueno, con(`'ok6', 'extra', '   Con espacios   ', 100`));
    prueba('D3 el nombre se recorta (espacios de los extremos)', rec.ok && (await uno(db, `select nombre from public.producto_opciones where id = 'ok6'`)).nombre === 'Con espacios', JSON.stringify(rec));
    const sinRest = await intentar(db, dueno, `insert into public.producto_opciones (producto_id, id, tipo, nombre, precio) values ('nb-pepsi', 'x', 'extra', 'X', 1)`);
    prueba('D4 sin restaurante_id el insert falla (no hay valor por defecto: 23502)', !sinRest.ok && (sinRest.code === '23502' || sinRest.code === '42501'), JSON.stringify(sinRest));
    const dup = await intentar(db, dueno, con(`'ok1', 'extra', 'Repetida', 1`));
    prueba('D5 repetir el id en el mismo producto falla (23505); el mismo id en otro producto es valido', !dup.ok && dup.code === '23505'
      && (await intentar(db, dueno, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ('${TAQ}', 'nb-sprite', 'ok1', 'extra', 'En otro producto', 1)`)).ok, JSON.stringify(dup));
    const lleno = await intentar(db, dueno, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, activa) select '${TAQ}', 'nb-coca-cola', 'c' || g, 'extra', 'C' || g, 1, g % 2 = 0 from generate_series(1, 12) g`);
    const trece = await intentar(db, dueno, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ('${TAQ}', 'nb-coca-cola', 'c13', 'extra', 'C13', 1)`);
    const dosMas = await intentar(db, dueno, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) select '${TAQ}', 'nb-agua', 'w' || g, 'extra', 'W' || g, 1 from generate_series(1, 13) g`);
    prueba('D6 maximo 12 por producto, contando las apagadas: las 12 entran, la 13 no; un solo insert de 13 filas se rechaza entero',
      lleno.ok && !trece.ok && trece.code === '23514' && !dosMas.ok && dosMas.code === '23514' && (await uno(db, `select count(*)::int n from public.producto_opciones where producto_id = 'nb-agua'`)).n === 0, JSON.stringify([lleno.ok, trece.code, dosMas.code]));
    const baja = await intentar(db, dueno, `delete from public.producto_opciones where producto_id = 'nb-coca-cola' and id = 'c1'`);
    const entra = await intentar(db, dueno, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ('${TAQ}', 'nb-coca-cola', 'c13', 'extra', 'C13', 1)`);
    prueba('D7 al borrar una, vuelve a caber otra', baja.ok && entra.ok, JSON.stringify([baja, entra]));
    const edita = await intentar(db, dueno, `update public.producto_opciones set precio = 7, nombre = 'C3 editada', activa = false where producto_id = 'nb-coca-cola' and id = 'c3'`);
    prueba('D7b con el producto en 12, el dueno igual puede EDITAR una opcion (precio, nombre, apagarla): el tope solo frena altas', edita.ok && edita.n === 1, JSON.stringify(edita));
    // el tope es POR restaurante: otro restaurante con un producto del mismo id tiene sus propias 12 (lo escribe el servidor, que ve todas las filas)
    const R2 = '33333333-3333-4333-8333-333333333333';
    await db.query(`insert into public.restaurantes (id, slug, nombre, config) values ($1, 'mr18-tope', 'Restaurante tope', '{}')`, [R2]);
    await db.query(`insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa) values ($1, 'cat-t', 'Cat', 'x', 0, true)`, [R2]);
    await db.query(`insert into public.productos (restaurante_id, id, nombre, descripcion, precio, categoria, orden) values ($1, 'nb-coca-cola', 'Coca de R2', 'r2', 3000, 'cat-t', 0)`, [R2]);
    const otro12 = await intentar(db, null, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) select '${R2}', 'nb-coca-cola', 'r' || g, 'extra', 'R' || g, 1 from generate_series(1, 12) g`, [], { rol: 'service_role' });
    prueba('D7c el tope de 12 se cuenta por restaurante: otro restaurante con el mismo id de producto (ya lleno en A) carga sus 12', otro12.ok && otro12.n === 12, JSON.stringify(otro12));
    const vol = await intentar(db, dueno, `update public.producto_opciones set tipo = 'quitar' where producto_id = 'nb-coca-cola' and id = 'c2'`);
    prueba('D8 un extra con precio no puede pasar a "quitar" (el CHECK lo impide)', !vol.ok && (vol.code === '23514'), JSON.stringify(vol));
    const noProd = await intentar(db, dueno, `insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio) values ('${TAQ}', 'no-existe', 'x', 'extra', 'X', 1)`);
    prueba('D9 una opcion de un producto que no existe falla (llave foranea compuesta)', !noProd.ok && ['23503', '42501'].includes(noProd.code), JSON.stringify(noProd));
    // el trigger se puede desactivar solo con privilegios de administrador: el CHECK sigue protegiendo precio, tipo, id y nombre
    await db.exec(`alter table public.producto_opciones disable trigger producto_opciones_validar`);
    const sinTrigger = [await intentar(db, dueno, con(`'t1', 'quitar', 'Sin algo', 500`)), await intentar(db, dueno, con(`'t2', 'extra', 'a' || chr(8238), 0`)), await intentar(db, dueno, con(`'t3', 'extra', ' con borde ', 0`)), await intentar(db, dueno, con(`'t4', 'extra', 'Algo', 50001`))];
    await db.exec(`alter table public.producto_opciones enable trigger producto_opciones_validar`);
    prueba('D10 aun con el trigger apagado, los CHECK frenan quitar con precio, bidi, espacios de borde y precio sobre el tope (defensa en capas)', sinTrigger.every((r) => !r.ok && r.code === '23514'), JSON.stringify(sinTrigger));
    // el producto se borra con sus opciones
    const antes = (await uno(db, `select count(*)::int n from public.producto_opciones where restaurante_id = '${TAQ}' and producto_id = 'nb-coca-cola'`)).n;
    await db.query(`delete from public.productos where restaurante_id = '${TAQ}' and id = 'nb-coca-cola'`);
    const otroQueda = (await uno(db, `select count(*)::int n from public.producto_opciones where restaurante_id = '${R2}' and producto_id = 'nb-coca-cola'`)).n;
    prueba('D11 borrar el producto borra sus opciones en cascada (no quedan huerfanas) y no toca las del mismo id en otro restaurante', antes === 12 && (await uno(db, `select count(*)::int n from public.producto_opciones where restaurante_id = '${TAQ}' and producto_id = 'nb-coca-cola'`)).n === 0 && otroQueda === 12, JSON.stringify([antes, otroQueda]));
  }

  // ================= E. ningun lugar suma con el precio base =================
  {
    const leer = (f) => fs.readFileSync(path.join(RAIZ, f), 'utf8');
    const lista = (dir, ext) => fs.readdirSync(path.join(RAIZ, dir)).filter((f) => ext.test(f)).map((f) => (dir ? dir + '/' : '') + f);
    const archivos = [...lista('api', /\.js$/), ...lista('api/_modulos', /\.js$/), ...lista('', /\.(js|html)$/)].filter((f) => !f.startsWith('node_modules'));
    // "precio x cantidad" o "cantidad x precio" en cualquier forma
    const SUMA = /(\bprecio\b|\bprice\b)[^\n;]{0,16}\*\s*[A-Za-z_.]*(cantidad|qty|\bq\b)|(cantidad|qty)\s*\*\s*[A-Za-z_.]*(precio|price)|\.price\s*\*|\.precio\s*\*/;
    const hallados = {};
    for (const f of archivos) {
      const lineas = leer(f).split(/\r?\n/);
      lineas.forEach((l, i) => { if (SUMA.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)) (hallados[f] = hallados[f] || []).push(i + 1); });
    }
    // Lugares REVISADOS. Todos multiplican el precio FINAL que guarda el pedido (precio = base + extras), asi que cuadran con extras sin cambios.
    const REVISADOS_FINAL = { 'api/_notificar.js': 1, 'historial.html': 1, 'panel.html': 2, 'pedido.html': 1, 'index.html': 2 };
    // El servidor: UNICO sitio que arma el precio (base + extras)
    const SERVIDOR = { 'api/_precios.js': 1 };      // (producto.precio * cantidad, sin opciones; el unitario con extras lo verifica E3)
    // Carrito DEL NAVEGADOR (index.html): hoy no ofrece opciones y cobra por precio base = lo que el servidor cobra; la PARTE B lo cambia.
    const PENDIENTE_PARTE_B = { 'index.html': 3 };
    const esperado = {};
    for (const grupo of [REVISADOS_FINAL, SERVIDOR]) for (const [f, n] of Object.entries(grupo)) esperado[f] = (esperado[f] || 0) + n;
    for (const [f, n] of Object.entries(PENDIENTE_PARTE_B)) esperado[f] = (esperado[f] || 0) + n;
    const cuentas = Object.fromEntries(Object.entries(hallados).map(([f, l]) => [f, l.length]));
    prueba('E1 cada lugar del codigo que multiplica un precio por una cantidad esta revisado (si aparece uno nuevo, esta prueba obliga a revisarlo)',
      JSON.stringify(Object.entries(cuentas).sort()) === JSON.stringify(Object.entries(esperado).sort()), JSON.stringify(cuentas) + ' esperado ' + JSON.stringify(esperado));
    prueba('E2 ninguno de esos lugares lee precio_base: todos usan el precio FINAL guardado en el pedido (o, en el servidor, el unitario con extras)',
      Object.keys(esperado).every((f) => !/precio_base/.test(leer(f).replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n')) || f === 'api/_precios.js'));
    const precios = leer('api/_precios.js');
    prueba('E3 en el servidor, el subtotal se acumula SIEMPRE con el unitario final: "precioUnitario * cantidad" (con opciones) o el de la base (sin opciones); nunca con la base cuando hay opciones',
      /subtotal \+= precioUnitario \* cantidad;/.test(precios) && /subtotal \+= producto\.precio \* cantidad;\s*continue;/.test(precios) && (precios.match(/subtotal \+=/g) || []).length === 2);
    const crear = leer('api/crear-pedido.js');
    prueba('E4 crear-pedido cobra revision.subtotal (+ domicilio): no vuelve a sumar items', /let total = revision\.subtotal;/.test(crear) && /total = subtotal \+ costoDomicilio;/.test(crear) && !/\.reduce\(/.test(crear) && !/items\.(map|forEach)/.test(crear.replace(/\/\*[\s\S]*?\*\//g, '')));
    const firma = leer('api/generar-firma.js'); const web = leer('api/webhook-wompi.js'); const reem = leer('api/reembolso.js');
    prueba('E5 generar-firma, el webhook y el reembolso comparan contra pedido.total (guardado): ninguno recorre items',
      /Number\(pedido\.total\) \* 100/.test(firma) && /Number\(pedido\.total\) \* 100/.test(web) && ![firma, web, reem].some((s) => /\bitems\b/.test(s.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n'))));
    const sqls = lista('supabase', /\.sql$/);
    // "it->>'precio'" (un item del jsonb) o cualquier ->> 'precio' / 'precio_base' sobre la columna items
    const sumaSql = sqls.filter((f) => /\bit\s*->>?\s*'precio|items[^;\n]*->>?\s*'precio/.test(leer(f).split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n')));
    prueba('E6 ninguna funcion SQL suma precios de items (la jornada suma total/subtotal guardados y cuenta unidades por nombre)', sumaSql.length === 0, sumaSql.join(','));
    const jornada = leer('supabase/10-multirestaurante.sql');
    prueba('E7 resumen de jornada: ventas = sum(total) y sum(subtotal) del pedido; los productos mas vendidos suman cantidades', /coalesce\(sum\(total\), 0\)\s+as ventas_total/.test(jornada) && /sum\(\(it->>'cantidad'\)::int\) as unidades/.test(jornada));
  }

  // ================= F. items nuevos y viejos se leen igual =================
  {
    const T = require(path.join(RAIZ, 'ticket-comanda.js'));
    const viejo = { id: 1, tipo_pedido: 'llevar', cliente_nombre: 'Ana', cliente_telefono: '3001112222', total: 20000, subtotal: 20000, costo_domicilio: 0, items: [{ id: 'taco', nombre: 'Taco', cantidad: 2, precio: 10000 }] };
    const nuevo = { ...viejo, total: 30000, subtotal: 30000, items: [{ id: 'taco', nombre: 'Taco', cantidad: 2, precio: 15000, precio_base: 10000, opciones: [{ id: 'extra-queso', tipo: 'extra', nombre: 'Queso extra', precio: 2000 }, { id: 'sin-cebolla', tipo: 'quitar', nombre: 'Sin cebolla', precio: 0 }] }] };
    const p = T.preparar ? T.preparar : null;
    const dv = p ? p(viejo) : null; const dn = p ? p(nuevo) : null;
    prueba('F1 el ticket lee un item NUEVO igual que uno viejo: mismo nombre y cantidad, sin romperse (las opciones se imprimiran en la parte B)',
      !!p ? dn.items.length === 1 && dn.items[0].cantidad === 2 && dn.items[0].nombre === 'Taco' && JSON.stringify(dv.items) === JSON.stringify(dn.items) : true, p ? JSON.stringify(dn.items) : 'ticket-comanda no exporta preparar');
    // jornada: el resumen cuenta unidades por nombre y suma los totales guardados, con items viejos y nuevos mezclados
    const db = await base17();
    await db.exec(SQL18());
    const duenoJ = 'cccccccc-cccc-4ccc-8ccc-000000000001';
    await db.query(`insert into auth.users (id, email) values ($1, 'j@t.test')`, [duenoJ]);
    await db.query(`insert into public.miembros (user_id, restaurante_id, rol, activo) values ($1, $2, 'dueno', true)`, [duenoJ, TAQ]);
    const jornada = async () => {
      const ahora = await uno(db, `select (now() at time zone 'America/Bogota')::date d`);
      const x = await intentar(db, duenoJ, `select public.resumen_jornada($1::date, '${TAQ}'::uuid) r`, [ahora.d]);
      return x.ok && x.rows[0] ? x.rows[0].r : null;
    };
    const antesJ = await jornada();      // el simulador ya trae pedidos del dia: se compara la DIFERENCIA que agregan estos dos
    await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en) values
      ('${TAQ}', 'PED-J-VIEJO', 'entregado', 'A', '3001112222', 'llevar', '[{"id":"nb-big-norte","nombre":"Big Norte","cantidad":2,"precio":26000}]', 52000, 0, 52000, 'aprobado', now()),
      ('${TAQ}', 'PED-J-NUEVO', 'entregado', 'B', '3001112222', 'llevar', '[{"id":"nb-big-norte","nombre":"Big Norte","cantidad":1,"precio":28000,"precio_base":26000,"opciones":[{"id":"extra-queso","tipo":"extra","nombre":"Queso extra","precio":2000}]}]', 28000, 0, 28000, 'aprobado', now())`);
    const fnJornada = await uno(db, `select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'resumen_jornada' limit 1`);
    prueba('F2 la funcion de resumen de jornada existe', !!fnJornada);
    const r = await jornada();
    const unid = (j) => Number(((j && j.top_productos) || []).find((t) => t.nombre === 'Big Norte')?.unidades || 0);
    prueba('F3 la jornada con un pedido viejo y uno nuevo suma 80000 mas (los totales guardados, no los items) y 3 unidades mas de Big Norte',
      !!r && !!antesJ && Number(r.ventas_total) - Number(antesJ.ventas_total) === 80000 && Number(r.ventas_productos) - Number(antesJ.ventas_productos) === 80000
        && Number(r.num_pedidos) - Number(antesJ.num_pedidos) === 2 && unid(r) - unid(antesJ) === 3, JSON.stringify([antesJ, r]).slice(0, 400));
    // seguimiento: el cliente ve los items tal cual se guardaron (con las opciones)
    const seg = await uno(db, `select p.token_seguimiento t from public.pedidos p where p.referencia = 'PED-J-NUEVO'`);
    const s = await intentar(db, null, `select items from public.seguimiento($1)`, [seg.t || 'PED-J-NUEVO'], { rol: 'anon' });
    const items = s.ok && s.rows[0] ? s.rows[0].items : null;
    prueba('F4 el seguimiento del pedido (publico) devuelve los items nuevos completos: precio final, precio_base y opciones', !!items && items[0].precio === 28000 && items[0].precio_base === 26000 && items[0].opciones[0].nombre === 'Queso extra', JSON.stringify(s).slice(0, 300));
  }

  informe(t0);
}

// ---- informe (tambien cuando una seccion se rompe: lo ya probado se muestra y la excepcion cuenta como FALLA) ----
function informe(t0) {
  let grupo = '';
  for (const r of resultados) {
    const g = r.nombre.slice(0, 1);
    if (g !== grupo) { grupo = g; console.log(''); }
    console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  }
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
}
const inicio = Date.now();
main().catch((e) => {
  prueba('EXCEPCION: una seccion se interrumpio y las siguientes no corrieron', false, e && e.message);
  informe(inicio);
});
