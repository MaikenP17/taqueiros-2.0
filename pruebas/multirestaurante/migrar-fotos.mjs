/* =============================================================
   PRUEBAS DE supabase/migrar-fotos-raiz.mjs  (y del SQL 14)

     node pruebas/multirestaurante/migrar-fotos.mjs

   Levanta el Supabase falso (PGlite con los SQL 10 a 13 + Storage con contenido real, copia y borrado) y corre
   el script de verdad (como proceso aparte, igual que lo correra Carlos):

     1. Llave: sin llave, pegada dos veces o publicable, no hace nada.
     2. Simulacion (por defecto): no escribe NADA (ni base, ni Storage, ni registro) y dice que haria.
     3. --aplicar exige una copia de seguridad reciente, de este proyecto y completa.
     4. --aplicar mueve las fotos de Taqueiros: copia > actualiza > verifica > borra; mismos bytes; registro.
     5. No toca: fotos de otro restaurante, archivos sueltos, fotos compartidas con otro restaurante, fotos del
        sitio (Recursos/...), fotos de una carpeta ajena.
     6. Idempotente: la segunda corrida no hace nada.
     7. Reanudable: cortes de conexion y procesos matados en cada punto del recorrido; al volver a correr termina.
     8. Verificacion que falla: devuelve el producto a la direccion antigua y no borra.
     9. Deshacer con el registro.
    10. SQL 14: se detiene mientras haya fotos en la raiz; despues retira la regla (Storage y productos); su reversa.

   El mismo archivo lo usa mutaciones-fotos.mjs (MIGRAR_FOTOS_SCRIPT=<script mutado>).
============================================================= */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { levantar } from './fake-supabase.mjs';
import { REPO, sql, intentar, U } from './sim.mjs';

const SCRIPT = process.env.MIGRAR_FOTOS_SCRIPT || `${REPO}/supabase/migrar-fotos-raiz.mjs`;
const PUERTO = Number(process.env.PUERTO_FOTOS || 54360);
const PREFIJO_BD = 'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/';
const TAQ = '00000000-0000-4000-8000-000000000001';
const OTRO = '44444444-4444-4444-8444-444444444444';
const LLAVE = 'sb_secret_FAKE_0000';

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 700) });

const falso = await levantar({ puerto: PUERTO });
const db = falso.db;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
const RESPALDOS = path.join(tmp, 'respaldos');
const REGISTRO = path.join(RESPALDOS, 'migracion-fotos-taqueiros.json');

await db.query(`insert into public.restaurantes (id, slug, nombre) values ($1, 'otro-rest', 'Otro restaurante') on conflict do nothing`, [OTRO]);
await db.query(`insert into public.categorias (restaurante_id, id, nombre) values ($1, 'cat-otro', 'Categoria otro') on conflict do nothing`, [OTRO]);

/* ---------------- ayudas ---------------- */
const bytesDe = (semilla) => crypto.createHash('sha256').update(semilla).digest().subarray(0, 24).toString('base64').repeat(40) + semilla;
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const urlBD = (ruta) => PREFIJO_BD + ruta;

async function subir(ruta, semilla) {
  await db.query(`insert into storage.objects (bucket_id, name) values ('productos', $1) on conflict do nothing`, [ruta]);
  falso.archivos.set('productos/' + ruta, Buffer.from(bytesDe(semilla)));
}
async function existeFoto(ruta) {
  return falso.archivos.has('productos/' + ruta) && (await db.query(`select 1 from storage.objects where bucket_id = 'productos' and name = $1`, [ruta])).rows.length === 1;
}
const bytesFoto = (ruta) => falso.archivos.get('productos/' + ruta);

async function producto(rid, id, imagen, categoria = 'bandejas') {
  await db.exec('alter table public.productos disable trigger productos_validar');   // para fabricar datos que la base ya no deja crear
  try {
    await db.query(`insert into public.productos (restaurante_id, id, nombre, precio, categoria, imagen) values ($1, $2, $3, 1000, $4, $5)
                    on conflict (restaurante_id, id) do update set imagen = excluded.imagen`, [rid, id, 'Prueba ' + id, categoria, imagen]);
  } finally { await db.exec('alter table public.productos enable trigger productos_validar'); }
}
async function imagenDe(rid, id) {
  const r = await db.query(`select imagen from public.productos where restaurante_id = $1 and id = $2`, [rid, id]);
  return r.rows[0] ? r.rows[0].imagen : undefined;
}
async function limpiarFixtures() {
  await db.exec('alter table public.productos disable trigger productos_validar');
  try { await db.exec(`delete from public.productos where id like 'mf-%'`); } finally { await db.exec('alter table public.productos enable trigger productos_validar'); }
  await db.exec(`delete from storage.objects where bucket_id = 'productos'`);
  falso.archivos.clear();
  fs.rmSync(RESPALDOS, { recursive: true, force: true });
  falso.cortar = null; falso.antes = null;
}
async function correrSql(base, archivo) {
  try { const rs = await base.exec(sql(archivo)); return { filas: rs[rs.length - 1].rows, error: '' }; }
  catch (e) { try { await base.exec('rollback'); } catch { /* ya no habia transaccion */ } return { filas: [], error: e.message }; }
}
async function quitarProblematicos() {   // los productos que a proposito apuntan a la raiz (compartida / rota): el SQL 14 se niega mientras existan
  await db.exec(`delete from public.productos where id in ('mf-p5', 'mf-p6', 'mf-o1', 'mf-o9')`);
}
const huellaBD = async () => JSON.stringify((await db.query(`select restaurante_id, id, imagen, actualizado_en from public.productos order by restaurante_id, id`)).rows);
const huellaStorage = () => JSON.stringify([...falso.archivos.entries()].map(([k, v]) => [k, hash(v)]).sort());
const lecturaMutante = (m) => /^(GET|HEAD)$/.test(m);
const mutaciones = () => falso.peticiones.filter((p) => !/^GET /.test(p) && !/^POST \/storage\/v1\/object\/list\//.test(p));

function respaldo({ horasAtras = 1, proyecto = falso.url, tablas, sinProductos = false, sinArchivo = false } = {}) {
  const t = new Date(Date.now() - horasAtras * 3600000);
  const nombre = t.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dir = path.join(RESPALDOS, nombre);
  fs.mkdirSync(dir, { recursive: true });
  const lista = tablas || [{ tabla: 'pedidos', exportadas: 5, total_base: 5 }, { tabla: 'productos', exportadas: 40, total_base: 40 }];
  fs.writeFileSync(path.join(dir, '_resumen.json'), JSON.stringify({ proyecto, fecha: t.toISOString(), tablas: sinProductos ? lista.filter((x) => x.tabla !== 'productos') : lista }));
  if (!sinArchivo) fs.writeFileSync(path.join(dir, 'productos.json'), '[]');
  return dir;
}

function correr(args = [], { env = {}, matarEn = null, cortarEn = null, antes = null } = {}) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: LLAVE, MIGRAR_FOTOS_PREFIJO: PREFIJO_BD,
        RESPALDOS_DIR: RESPALDOS, MIGRAR_FOTOS_SALIDA_MS: '300', ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    hijo.stdout.on('data', (d) => { out += d; });
    hijo.stderr.on('data', (d) => { out += d; });
    falso.antes = antes ? (req, url) => antes(req, url) : null;
    falso.cortar = (req, url) => {
      if (matarEn && matarEn(req, url)) { hijo.kill('SIGKILL'); return true; }
      return cortarEn ? cortarEn(req, url) : false;
    };
    const tope = setTimeout(() => { hijo.kill('SIGKILL'); out += '\n[TIEMPO AGOTADO]'; }, 60000);
    hijo.on('exit', (code) => { clearTimeout(tope); falso.cortar = null; falso.antes = null; resolve({ code, out }); });
  });
}

/* Fixture principal: 3 fotos de Taqueiros en la raiz (una con dos productos), mas cosas que NO se deben tocar */
async function armar() {
  await limpiarFixtures();
  await subir('mf-a1.webp', 'a1'); await producto(TAQ, 'mf-p1', urlBD('mf-a1.webp'));
  await subir('mf-a2.png', 'a2'); await producto(TAQ, 'mf-p2', urlBD('mf-a2.png')); await producto(TAQ, 'mf-p3', urlBD('mf-a2.png'));
  await subir('mf-a3.jpeg', 'a3'); await producto(TAQ, 'mf-p4', urlBD('mf-a3.jpeg'));
  // NO se tocan:
  await subir('mf-compartida.webp', 'comp'); await producto(TAQ, 'mf-p5', urlBD('mf-compartida.webp')); await producto(OTRO, 'mf-o1', urlBD('mf-compartida.webp'), 'cat-otro');
  await subir('mf-suelta.webp', 'suelta');                                       // nadie la usa
  await subir(`${OTRO}/mf-o2.webp`, 'o2'); await producto(OTRO, 'mf-o2', urlBD(`${OTRO}/mf-o2.webp`), 'cat-otro');
  await producto(TAQ, 'mf-p6', urlBD('mf-rota.webp'));                           // la foto no existe en Storage
}
const NOMBRES_MOVIDOS = ['mf-a1.webp', 'mf-a2.png', 'mf-a3.jpeg'];

/* ============================================================
   1. LLAVE
============================================================ */
await armar();
const base0 = await huellaBD(), sto0 = huellaStorage();
{
  const sin = await correr([], { env: { SUPABASE_SERVICE_ROLE_KEY: '' } });
  prueba('sin llave: se detiene (codigo 2) sin tocar nada', sin.code === 2 && /Falta SUPABASE_SERVICE_ROLE_KEY/.test(sin.out), sin.out);
  const doble = await correr(['--aplicar'], { env: { SUPABASE_SERVICE_ROLE_KEY: LLAVE + LLAVE } });
  prueba('llave pegada DOS veces: se detiene (codigo 2), lo dice y no manda ninguna peticion', doble.code === 2 && /DOS veces/.test(doble.out), doble.out);
  prueba('... y la llave pegada no aparece en lo que imprime', !doble.out.includes('FAKE_0000'), doble.out);
  const pub = await correr([], { env: { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_FAKE_0000' } });
  prueba('llave publicable: se detiene (codigo 2)', pub.code === 2, pub.out);
  prueba('ninguna de esas corridas toco la base ni Storage', (await huellaBD()) === base0 && huellaStorage() === sto0, '');
}

/* ============================================================
   2. SIMULACION (por defecto)
============================================================ */
{
  falso.peticiones.length = 0;
  const r = await correr([]);
  prueba('simulacion: sale con 0 y se anuncia como SIMULACION', r.code === 0 && /SIMULACION/.test(r.out), r.out);
  prueba('simulacion: lista las 3 fotos que moveria, con su destino {restaurante_id}/archivo',
    NOMBRES_MOVIDOS.every((n) => r.out.includes(`${n}  ->  ${TAQ}/${n}`)), r.out);
  prueba('simulacion: avisa de la foto compartida con otro restaurante y de la rota', /SALTA\s+mf-compartida\.webp/.test(r.out) && /ROTA\s+mf-rota\.webp/.test(r.out), r.out);
  prueba('simulacion: NO escribe nada: la base, Storage y el registro quedan intactos',
    (await huellaBD()) === base0 && huellaStorage() === sto0 && !fs.existsSync(REGISTRO), '');
  prueba('simulacion: no manda ninguna peticion que modifique (solo lecturas)', mutaciones().length === 0, mutaciones().join(' | '));
  prueba('simulacion: no exige copia de seguridad (solo la recuerda)', /respaldo/i.test(r.out), r.out);
  prueba('simulacion: no imprime la llave', !r.out.includes('FAKE_0000'), r.out);
}

/* ============================================================
   3. --aplicar EXIGE una copia de seguridad reciente
============================================================ */
{
  const intento = async (nombre, crear) => {
    fs.rmSync(RESPALDOS, { recursive: true, force: true });
    crear();
    falso.peticiones.length = 0;
    const r = await correr(['--aplicar']);
    prueba(`--aplicar sin respaldo valido (${nombre}): no hace nada (codigo 2) y explica que hacer`,
      r.code === 2 && /NO SE HIZO NADA/.test(r.out) && /exportar-respaldo/.test(r.out) && (await huellaBD()) === base0 && huellaStorage() === sto0 && mutaciones().length === 0, r.out);
  };
  await intento('no hay ninguno', () => {});
  await intento('de hace 30 horas', () => respaldo({ horasAtras: 30 }));
  await intento('de otro proyecto', () => respaldo({ proyecto: 'https://otro-proyecto.supabase.co' }));
  await intento('una tabla no coincide con la base', () => respaldo({ tablas: [{ tabla: 'productos', exportadas: 10, total_base: 40 }] }));
  await intento('sin la tabla productos', () => respaldo({ sinProductos: true }));
  await intento('sin productos.json', () => respaldo({ sinArchivo: true }));
  await intento('con fecha en el futuro', () => respaldo({ horasAtras: -5 }));
}

/* ============================================================
   4. --aplicar
============================================================ */
let registroPrimero;
{
  fs.rmSync(RESPALDOS, { recursive: true, force: true });
  respaldo();
  const intactas = { sueltaHash: hash(bytesFoto('mf-suelta.webp')), compHash: hash(bytesFoto('mf-compartida.webp')), o2Hash: hash(bytesFoto(`${OTRO}/mf-o2.webp`)) };
  const originales = Object.fromEntries(NOMBRES_MOVIDOS.map((n) => [n, hash(bytesFoto(n))]));
  const sitio = (await db.query(`select id, imagen from public.productos where restaurante_id = $1 and imagen like 'Recursos/%' order by id`, [TAQ])).rows;
  const tProd = (await db.query(`select id, actualizado_en from public.productos where id in ('mf-p5','mf-p6','mf-o1','mf-o2')`)).rows;

  const r = await correr(['--aplicar']);
  prueba('--aplicar con respaldo valido: sale con 0 y lo dice', r.code === 0 && /APLICANDO/.test(r.out) && /Copia de seguridad reciente: encontrada/.test(r.out), r.out);
  prueba('--aplicar: las 3 fotos nuevas existen en {restaurante_id}/ con EXACTAMENTE los mismos bytes',
    (await Promise.all(NOMBRES_MOVIDOS.map(async (n) => (await existeFoto(`${TAQ}/${n}`)) && hash(bytesFoto(`${TAQ}/${n}`)) === originales[n]))).every(Boolean), r.out);
  prueba('--aplicar: las 3 antiguas ya no estan en la raiz', (await Promise.all(NOMBRES_MOVIDOS.map(async (n) => !(await existeFoto(n))))).every(Boolean), r.out);
  prueba('--aplicar: los 4 productos apuntan a la direccion nueva (los dos que compartian una foto, tambien)',
    (await imagenDe(TAQ, 'mf-p1')) === urlBD(`${TAQ}/mf-a1.webp`) && (await imagenDe(TAQ, 'mf-p2')) === urlBD(`${TAQ}/mf-a2.png`)
    && (await imagenDe(TAQ, 'mf-p3')) === urlBD(`${TAQ}/mf-a2.png`) && (await imagenDe(TAQ, 'mf-p4')) === urlBD(`${TAQ}/mf-a3.jpeg`), r.out);
  prueba('--aplicar: dos productos con la misma foto comparten UNA sola copia nueva',
    [...falso.archivos.keys()].filter((k) => k.startsWith(`productos/${TAQ}/mf-a2`)).length === 1, '');
  prueba('--aplicar NO toca la foto que tambien usa otro restaurante (ni la de ninguno de los dos)',
    (await existeFoto('mf-compartida.webp')) && hash(bytesFoto('mf-compartida.webp')) === intactas.compHash
    && (await imagenDe(TAQ, 'mf-p5')) === urlBD('mf-compartida.webp') && (await imagenDe(OTRO, 'mf-o1')) === urlBD('mf-compartida.webp'), r.out);
  prueba('--aplicar NO toca un archivo que ningun producto usa', (await existeFoto('mf-suelta.webp')) && hash(bytesFoto('mf-suelta.webp')) === intactas.sueltaHash, '');
  prueba('--aplicar NO toca la carpeta de otro restaurante ni su producto',
    (await existeFoto(`${OTRO}/mf-o2.webp`)) && hash(bytesFoto(`${OTRO}/mf-o2.webp`)) === intactas.o2Hash && (await imagenDe(OTRO, 'mf-o2')) === urlBD(`${OTRO}/mf-o2.webp`), '');
  prueba('--aplicar NO toca los productos con foto del sitio (Recursos/...)',
    JSON.stringify((await db.query(`select id, imagen from public.productos where restaurante_id = $1 and imagen like 'Recursos/%' order by id`, [TAQ])).rows) === JSON.stringify(sitio) && sitio.length > 10, '');
  prueba('--aplicar NO cambia el producto de la foto rota ni los de la foto compartida',
    (await imagenDe(TAQ, 'mf-p6')) === urlBD('mf-rota.webp'), '');
  const tProd2 = (await db.query(`select id, actualizado_en from public.productos where id in ('mf-p5','mf-p6','mf-o1','mf-o2')`)).rows;
  prueba('--aplicar solo actualiza los productos movidos: los demas conservan su fecha de actualizacion', JSON.stringify(tProd) === JSON.stringify(tProd2), '');
  prueba('--aplicar avisa de la foto rota y de la compartida', /ROTA\s+mf-rota/.test(r.out) && /SALTA\s+mf-compartida/.test(r.out), r.out);

  registroPrimero = fs.existsSync(REGISTRO) ? JSON.parse(fs.readFileSync(REGISTRO, 'utf8')) : null;
  prueba('registro JSON: existe, con el mapa antiguo -> nuevo de las 3 fotos, el restaurante y los productos afectados',
    registroPrimero && registroPrimero.restaurante_id === TAQ && registroPrimero.fotos.length === 3
    && NOMBRES_MOVIDOS.every((n) => registroPrimero.fotos.some((e) => e.viejo === n && e.nuevo === `${TAQ}/${n}` && e.estado === 'borrada' && e.hash === originales[n]))
    && registroPrimero.fotos.find((e) => e.viejo === 'mf-a2.png').productos.map((p) => p.id).sort().join() === 'mf-p2,mf-p3'
    && registroPrimero.fotos.find((e) => e.viejo === 'mf-a1.webp').productos[0].imagen_antigua === urlBD('mf-a1.webp'), JSON.stringify(registroPrimero).slice(0, 400));
  prueba('registro JSON: no contiene la llave', !JSON.stringify(registroPrimero).includes('FAKE_0000'), '');
  prueba('--aplicar: todo se hizo en orden: la copia antes de cambiar al producto, y el borrado al final',
    (() => { const p = falso.peticiones; const i = (re, desde = 0) => p.findIndex((x, k) => k >= desde && re.test(x));
      const c = i(/POST \/storage\/v1\/object\/copy/), pa = i(/PATCH \/rest\/v1\/productos/), d = i(/DELETE \/storage\/v1\/object\/productos/);
      return c >= 0 && pa > c && d > pa; })(), falso.peticiones.filter((x) => !/^GET/.test(x)).join(' | '));
}

/* ============================================================
   5. IDEMPOTENTE
============================================================ */
{
  const baseDespues = await huellaBD(), stoDespues = huellaStorage();
  falso.peticiones.length = 0;
  const r = await correr(['--aplicar']);
  prueba('segunda corrida: "Nada que hacer" y sale con 0', r.code === 0 && /Nada que hacer/.test(r.out), r.out);
  prueba('segunda corrida: no menciona las fotos que ya estan en su carpeta (no las toma por fotos de la raiz)', !r.out.includes(TAQ), r.out);
  prueba('segunda corrida: no cambia nada ni manda ninguna peticion que modifique', (await huellaBD()) === baseDespues && huellaStorage() === stoDespues && mutaciones().length === 0, mutaciones().join(' | '));
  const sim = await correr([]);
  prueba('la simulacion despues de migrar tambien dice "Nada que hacer"', sim.code === 0 && /Nada que hacer/.test(sim.out), sim.out);
  prueba('el registro no cambio de contenido (mismas 3 fotos, todas borradas)', JSON.parse(fs.readFileSync(REGISTRO, 'utf8')).fotos.every((e) => e.estado === 'borrada'), '');
}

/* ============================================================
   6. SQL 14 con las fotos ya movidas
============================================================ */
async function sql14ok() {
  const rs = await db.exec(sql('14-retirar-regla-bucket.sql'));
  return rs[rs.length - 1].rows;
}
{
  // Lo que todavia dice el SQL 10: el dueno de Taqueiros escribe en la raiz
  const subeRaiz0 = await intentar(db, U.dueno_taq, `insert into storage.objects (bucket_id, name) values ('productos', 'mf-nueva-raiz.webp')`, [], { rol: 'authenticated' });
  prueba('antes del SQL 14 el dueno de Taqueiros escribe en la raiz (regla transitoria)', subeRaiz0.ok, JSON.stringify(subeRaiz0));
  await db.exec(`delete from storage.objects where name = 'mf-nueva-raiz.webp'`);

  const quedan = await correrSql(db, '14-retirar-regla-bucket.sql');
  prueba('SQL 14: mientras otros productos sigan apuntando a la raiz (la foto compartida, la rota) se detiene y los nombra',
    /Todavia hay 3 producto/.test(quedan.error) && ['otro-rest/mf-o1', 'taqueiros/mf-p5', 'taqueiros/mf-p6'].every((x) => quedan.error.includes(x)), quedan.error);
  await quitarProblematicos();
  const filas = await sql14ok();
  prueba('SQL 14: con las fotos movidas y sin productos en la raiz pasa con todas las comprobaciones OK', filas.length >= 7 && filas.every((x) => x.estado === 'OK'), JSON.stringify(filas.filter((x) => x.estado !== 'OK')));
  const filas2 = await sql14ok();
  prueba('SQL 14: es idempotente (segunda corrida, todo OK)', filas2.length === filas.length && filas2.every((x) => x.estado === 'OK'), JSON.stringify(filas2.filter((x) => x.estado !== 'OK')));

  const raiz = await intentar(db, U.dueno_taq, `insert into storage.objects (bucket_id, name) values ('productos', 'mf-nueva-raiz.webp')`, [], { rol: 'authenticated' });
  prueba('despues del SQL 14 el dueno de Taqueiros YA NO escribe en la raiz del bucket', raiz.ok === false, JSON.stringify(raiz));
  const carpeta = await intentar(db, U.dueno_taq, `insert into storage.objects (bucket_id, name) values ('productos', '${TAQ}/mf-nueva.webp')`, [], { rol: 'authenticated' });
  prueba('... pero SI en su carpeta {restaurante_id}/', carpeta.ok === true, JSON.stringify(carpeta));
  await db.exec(`delete from storage.objects where name = '${TAQ}/mf-nueva.webp'`);
  const borraRaiz = await intentar(db, U.dueno_taq, `delete from storage.objects where bucket_id = 'productos' and name = 'mf-suelta.webp'`, [], { rol: 'authenticated' });
  prueba('... ni borra ni reemplaza archivos de la raiz (la foto suelta sigue ahi)', (await existeFoto('mf-suelta.webp')) && !(borraRaiz.ok && borraRaiz.n > 0), JSON.stringify(borraRaiz));

  const trig = async (rid, id, imagen) => {
    try { await db.query(`insert into public.productos (restaurante_id, id, nombre, precio, categoria, imagen) values ($1, $2, 'T', 1000, 'bandejas', $3)`, [rid, id, imagen]); await db.query(`delete from public.productos where id = $1`, [id]); return 'ok'; }
    catch (e) { return e.message; }
  };
  prueba('el trigger de productos ya no acepta una foto plana (ni para Taqueiros)', /no es v/.test(await trig(TAQ, 'mf-t1', urlBD('mf-plana.webp'))), '');
  prueba('... y sigue aceptando la de la carpeta propia y las del sitio (Recursos/...)',
    (await trig(TAQ, 'mf-t2', urlBD(`${TAQ}/mf-ok.webp`))) === 'ok' && (await trig(TAQ, 'mf-t3', 'Recursos/tacos/x.webp')) === 'ok', '');
  prueba('... y rechaza la carpeta de otro restaurante', /no es v/.test(await trig(TAQ, 'mf-t4', urlBD(`${OTRO}/mf-ok.webp`))), '');
  const prodDespues = await intentar(db, U.dueno_taq, `update public.productos set disponible = false where id = 'mf-p1' and restaurante_id = '${TAQ}' returning id`, [], { rol: 'authenticated' });
  prueba('el panel sigue editando un producto con foto ya movida (el trigger solo revisa la foto cuando cambia)', prodDespues.ok && prodDespues.rows.length === 1, JSON.stringify(prodDespues));

  // reversa del 14
  const rev = await db.exec(sql('14-revertir.sql'));
  const filasRev = rev[rev.length - 1].rows;
  prueba('14-revertir.sql: todas OK y vuelve la regla de la raiz', filasRev.length >= 4 && filasRev.every((x) => x.estado === 'OK'), JSON.stringify(filasRev.filter((x) => x.estado !== 'OK')));
  const raiz2 = await intentar(db, U.dueno_taq, `insert into storage.objects (bucket_id, name) values ('productos', 'mf-nueva-raiz.webp')`, [], { rol: 'authenticated' });
  prueba('... despues de revertir, el dueno de Taqueiros vuelve a escribir en la raiz', raiz2.ok === true, JSON.stringify(raiz2));
  await db.exec(`delete from storage.objects where name = 'mf-nueva-raiz.webp'`);
  const rev2 = await db.exec(sql('14-revertir.sql'));
  prueba('14-revertir.sql es idempotente', rev2[rev2.length - 1].rows.every((x) => x.estado === 'OK'), '');
  await db.exec(sql('14-retirar-regla-bucket.sql'));   // lo deja puesto otra vez
}

/* El SQL 14 se detiene mientras haya fotos en la raiz: se prueba en una base aparte (antes de mover) */
{
  const aparte = await levantar({ puerto: PUERTO + 1 });
  try {
    await aparte.db.exec(`alter table public.productos disable trigger productos_validar`);
    await aparte.db.query(`update public.productos set imagen = $1 where id = 'bandeja-mixta' and restaurante_id = $2`, [urlBD('mf-pendiente.webp'), TAQ]);
    await aparte.db.exec(`alter table public.productos enable trigger productos_validar`);
    let msg = (await correrSql(aparte.db, '14-retirar-regla-bucket.sql')).error;
    prueba('SQL 14: con un producto apuntando a la raiz se DETIENE con un mensaje claro que nombra al producto', /MR paso 0 precondiciones/.test(msg) && /Todavia hay 1 producto/.test(msg) && /taqueiros\/bandeja-mixta/.test(msg) && /migrar-fotos-raiz/.test(msg), msg);
    const raiz = await intentar(aparte.db, U.dueno_taq, `insert into storage.objects (bucket_id, name) values ('productos', 'mf-x.webp')`, [], { rol: 'authenticated' });
    prueba('... y no cambio nada: el dueno sigue escribiendo en la raiz', raiz.ok === true, JSON.stringify(raiz));
    // con una URL con parametro ?t= tambien cuenta como raiz
    await aparte.db.exec(`alter table public.productos disable trigger productos_validar`);
    await aparte.db.query(`update public.productos set imagen = $1 where id = 'bandeja-mixta' and restaurante_id = $2`, [urlBD('mf-pendiente.webp') + '?t=123', TAQ]);
    await aparte.db.exec(`alter table public.productos enable trigger productos_validar`);
    msg = (await correrSql(aparte.db, '14-retirar-regla-bucket.sql')).error;
    prueba('SQL 14: una direccion de la raiz con ?t=... tambien la detecta', /Todavia hay 1 producto/.test(msg), msg);
    // una foto en carpeta o del sitio no estorba
    await aparte.db.exec(`alter table public.productos disable trigger productos_validar`);
    await aparte.db.query(`update public.productos set imagen = $1 where id = 'bandeja-mixta' and restaurante_id = $2`, [urlBD(`${TAQ}/a.webp`), TAQ]);
    await aparte.db.exec(`alter table public.productos enable trigger productos_validar`);
    msg = (await correrSql(aparte.db, '14-retirar-regla-bucket.sql')).error;
    prueba('SQL 14: con las fotos en su carpeta o del sitio pasa', msg === '', msg);
  } finally { await aparte.cerrar(); }
}

/* ============================================================
   7. REANUDABLE: cortes en cada punto
============================================================ */
await db.exec(sql('14-revertir.sql'));   // la reversa del 14: la raiz vuelve a ser de Taqueiros (para poder armar de nuevo)
async function estadoFinalCorrecto(nombres = NOMBRES_MOVIDOS) {
  const nuevas = await Promise.all(nombres.map(async (n) => await existeFoto(`${TAQ}/${n}`)));
  const viejas = await Promise.all(nombres.map(async (n) => await existeFoto(n)));
  return nuevas.every(Boolean) && viejas.every((x) => !x);
}
async function escenarioCorte(titulo, opciones, extra = async () => true) {
  await armar(); respaldo();
  const orig = Object.fromEntries(NOMBRES_MOVIDOS.map((n) => [n, hash(bytesFoto(n))]));
  const corte = await correr(['--aplicar'], opciones);
  const intermedio = { codigo: corte.code, salida: corte.out };
  const parcial = !(await estadoFinalCorrecto());
  const r = await correr(['--aplicar']);
  const final = await estadoFinalCorrecto();
  const productosOk = (await imagenDe(TAQ, 'mf-p1')) === urlBD(`${TAQ}/mf-a1.webp`) && (await imagenDe(TAQ, 'mf-p2')) === urlBD(`${TAQ}/mf-a2.png`)
    && (await imagenDe(TAQ, 'mf-p3')) === urlBD(`${TAQ}/mf-a2.png`) && (await imagenDe(TAQ, 'mf-p4')) === urlBD(`${TAQ}/mf-a3.jpeg`);
  const bytesOk = NOMBRES_MOVIDOS.every((n) => falso.archivos.has(`productos/${TAQ}/${n}`) && hash(bytesFoto(`${TAQ}/${n}`)) === orig[n]);
  const copias = [...falso.archivos.keys()].filter((k) => k.startsWith(`productos/${TAQ}/mf-`)).length;
  const reg = JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
  prueba(`${titulo}: el corte deja la migracion a medias (de verdad se interrumpio)`, parcial, JSON.stringify(intermedio).slice(0, 400));
  prueba(`${titulo}: al volver a correr termina (codigo 0)`, r.code === 0 && final, r.out);
  prueba(`${titulo}: los 4 productos quedan en la direccion nueva, con los mismos bytes y sin copias de mas`, productosOk && bytesOk && copias === 3, `${productosOk} ${bytesOk} ${copias}`);
  prueba(`${titulo}: las fotos que NO son de este restaurante siguen intactas`, (await existeFoto('mf-compartida.webp')) && (await existeFoto('mf-suelta.webp')) && (await existeFoto(`${OTRO}/mf-o2.webp`)), '');
  prueba(`${titulo}: el registro queda completo (3 fotos, todas borradas)`, reg.fotos.length === 3 && reg.fotos.every((e) => e.estado === 'borrada'), JSON.stringify(reg.fotos.map((e) => e.estado)));
  prueba(`${titulo}: una tercera corrida ya no hace nada`, /Nada que hacer/.test((await correr(['--aplicar'])).out), '');
  prueba(`${titulo}: comprobacion adicional`, await extra(), '');
}

// a) se corta la conexion al copiar la 2.a foto
{
  let n = 0;
  await escenarioCorte('corte al copiar', { cortarEn: (req, url) => url.pathname === '/storage/v1/object/copy' && ++n === 2 });
}
// b) se mata el proceso justo despues de copiar y antes de cambiar el producto (la 1.a)
{
  let n = 0;
  await escenarioCorte('proceso matado entre copiar y cambiar al producto', { matarEn: (req) => req.method === 'PATCH' && /\/rest\/v1\/productos/.test(req.url) && ++n === 1 });
}
// c) se corta la conexion al cambiar al 2.o producto (el de la foto compartida por dos)
{
  let n = 0;
  await escenarioCorte('corte al cambiar al producto', { cortarEn: (req) => req.method === 'PATCH' && /\/rest\/v1\/productos/.test(req.url) && ++n === 3 });
}
// d) se mata el proceso despues de cambiar y verificar, justo antes de borrar la antigua (la 2.a)
{
  let n = 0;
  await escenarioCorte('proceso matado antes de borrar la antigua', { matarEn: (req, url) => req.method === 'DELETE' && url.pathname === '/storage/v1/object/productos' && ++n === 2 });
}
// e) falla la verificacion de lectura de la nueva (la red cae al leerla despues de cambiar al producto)
{
  let leyendo = 0;
  await escenarioCorte('corte al leer la copia nueva', { cortarEn: (req, url) => req.method === 'GET' && url.pathname.includes(`/object/public/productos/${TAQ}/mf-a3`) && ++leyendo === 2 });
}
// f) se pierde la conexion con el listado de productos justo antes de borrar (comprobacion de usos)
{
  let n = 0;
  await escenarioCorte('corte al comprobar los usos antes de borrar', { cortarEn: (req) => req.method === 'GET' && /\/rest\/v1\/productos/.test(req.url) && ++n === 3 });
}
// g) kill del proceso en cada peticion que modifica (barrido completo)
{
  await armar(); respaldo();
  // cuenta cuantas peticiones que modifican hace una corrida limpia
  falso.peticiones.length = 0;
  await correr(['--aplicar']);
  const total = mutaciones().length;
  prueba('barrido de cortes: una corrida limpia hace varias peticiones que modifican', total >= 9, String(total));
  let malos = [];
  for (let k = 1; k <= total; k++) {
    await armar(); respaldo();
    let visto = 0;
    const primera = await correr(['--aplicar'], {
      matarEn: (req, url) => {
        const modifica = req.method !== 'GET' && !(req.method === 'POST' && url.pathname.startsWith('/storage/v1/object/list/'));
        return modifica && ++visto === k;
      }
    });
    const segunda = await correr(['--aplicar']);
    const tercera = await correr(['--aplicar']);
    const okFinal = (await estadoFinalCorrecto()) && segunda.code === 0 && /Nada que hacer/.test(tercera.out)
      && (await imagenDe(TAQ, 'mf-p3')) === urlBD(`${TAQ}/mf-a2.png`) && (await imagenDe(TAQ, 'mf-p1')) === urlBD(`${TAQ}/mf-a1.webp`)
      && (await existeFoto('mf-compartida.webp')) && (await imagenDe(OTRO, 'mf-o1')) === urlBD('mf-compartida.webp');
    if (!okFinal) malos.push(`corte #${k}: ${segunda.out.slice(-200)}`);
  }
  prueba(`barrido de cortes: matar el proceso en CADA una de las ${total} peticiones que modifican y volver a correr siempre termina bien`, malos.length === 0, malos.join('\n'));
}

/* ============================================================
   8. LA VERIFICACION FALLA: se devuelve al producto y no se borra
============================================================ */
{
  await armar(); respaldo();
  // justo despues de cambiar al 1.er producto, el archivo nuevo "se corrompe"
  let n = 0;
  const r = await correr(['--aplicar'], { antes: (req, url) => {
    if (req.method === 'GET' && url.pathname.includes(`/object/public/productos/${TAQ}/mf-a1`) && ++n === 3) falso.archivos.set(`productos/${TAQ}/mf-a1.webp`, Buffer.from('CORRUPTO'));
  } });
  prueba('verificacion que falla: sale con codigo 1 y lo dice', r.code === 1 && /mf-a1\.webp: la direccion nueva no responde con el mismo contenido/.test(r.out), r.out);
  prueba('... el producto vuelve a la direccion ANTIGUA y la foto antigua NO se borra', (await imagenDe(TAQ, 'mf-p1')) === urlBD('mf-a1.webp') && (await existeFoto('mf-a1.webp')), r.out);
  prueba('... las otras fotos si se movieron', (await existeFoto(`${TAQ}/mf-a2.png`)) && !(await existeFoto('mf-a2.png')), r.out);
  const reg = JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
  prueba('... el registro marca esa foto con error', reg.fotos.find((e) => e.viejo === 'mf-a1.webp').estado === 'error', JSON.stringify(reg.fotos.map((e) => e.estado)));
}
{
  // la copia sale distinta del original (se corrompe justo despues de copiar): no se cambia ningun producto ni se borra nada
  await armar(); respaldo();
  let n = 0;
  const r = await correr(['--aplicar'], { antes: (req, url) => {
    if (req.method === 'GET' && url.pathname.includes(`/object/public/productos/${TAQ}/mf-a1`) && ++n === 2) falso.archivos.set(`productos/${TAQ}/mf-a1.webp`, Buffer.from('CORRUPTO'));
  } });
  prueba('si la copia no coincide con el original: error, el producto sigue en la direccion antigua y la antigua NO se borra',
    r.code === 1 && /mf-a1.webp: la copia no aparece o no coincide/.test(r.out) && (await imagenDe(TAQ, 'mf-p1')) === urlBD('mf-a1.webp') && (await existeFoto('mf-a1.webp')), r.out);
}
{
  // --no-borrar: copia y cambia, pero deja las antiguas; una corrida normal despues termina
  await armar(); respaldo();
  const r = await correr(['--aplicar', '--no-borrar']);
  const antiguas = await Promise.all(NOMBRES_MOVIDOS.map((n) => existeFoto(n)));
  const nuevas = await Promise.all(NOMBRES_MOVIDOS.map((n) => existeFoto(`${TAQ}/${n}`)));
  prueba('--no-borrar: copia y cambia los productos pero NO borra las antiguas', r.code === 0 && antiguas.every(Boolean) && nuevas.every(Boolean) && (await imagenDe(TAQ, 'mf-p1')) === urlBD(`${TAQ}/mf-a1.webp`), r.out);
  const r2 = await correr(['--aplicar']);
  prueba('... y una corrida normal despues termina de borrar las antiguas', r2.code === 0 && (await estadoFinalCorrecto()), r2.out);
}
{
  // el borrado responde OK pero el archivo sigue ahi: se detecta y se avisa
  await armar(); respaldo();
  falso.ignorarBorrados = true;
  const r = await correr(['--aplicar']);
  falso.ignorarBorrados = false;
  const reg = JSON.parse(fs.readFileSync(REGISTRO, 'utf8'));
  prueba('si el borrado de la antigua dice OK pero el archivo sigue en Storage: error (codigo 1) y el registro lo marca', r.code === 1 && /sigue en Storage despues de borrarla/.test(r.out) && reg.fotos.every((e) => e.estado === 'error'), r.out);
}
{
  // una foto quedo a medias segun el registro, pero la copia nueva NO esta: no se borra la antigua
  await armar(); respaldo();
  await db.exec("delete from public.productos where id = 'mf-p1'");   // ya nadie usa mf-a1.webp
  fs.mkdirSync(RESPALDOS, { recursive: true });
  fs.writeFileSync(REGISTRO, JSON.stringify({ version: 1, proyecto: falso.url, slug: 'taqueiros', restaurante_id: TAQ, creado: new Date().toISOString(),
    fotos: [{ viejo: 'mf-a1.webp', nuevo: TAQ + '/mf-a1.webp', estado: 'actualizada', bytes: 1, hash: 'x', productos: [] }] }));
  const r = await correr(['--aplicar']);
  prueba('un pendiente del registro sin copia nueva completa NO borra la antigua (la avisa)', (await existeFoto('mf-a1.webp')) && /PEND\s+mf-a1\.webp/.test(r.out), r.out);
}
{
  // destino con OTRO archivo: no se pisa
  await armar(); respaldo();
  await subir(`${TAQ}/mf-a1.webp`, 'distinto');
  const b0 = await huellaBD();
  const r = await correr(['--aplicar']);
  prueba('si la ruta nueva ya tiene OTRO archivo: error, no se pisa ni se cambia el producto de esa foto',
    r.code === 1 && /ERROR\s+mf-a1\.webp: en .* ya hay OTRO archivo distinto/.test(r.out)
    && hash(bytesFoto(`${TAQ}/mf-a1.webp`)) === hash(Buffer.from(bytesDe('distinto'))) && (await imagenDe(TAQ, 'mf-p1')) === urlBD('mf-a1.webp') && (await existeFoto('mf-a1.webp')), r.out);
  prueba('... y las demas fotos si se movieron', (await existeFoto(`${TAQ}/mf-a2.png`)) && (await existeFoto(`${TAQ}/mf-a3.jpeg`)), '');
}
{
  // el destino ya esta bien (de una corrida cortada antes de registrar nada): se reutiliza
  await armar(); respaldo();
  await subir(`${TAQ}/mf-a1.webp`, 'a1');   // mismos bytes que la antigua
  const r = await correr(['--aplicar']);
  prueba('si la ruta nueva ya tiene EL MISMO archivo, se reutiliza (no se vuelve a copiar) y termina', r.code === 0 && (await estadoFinalCorrecto()) && (await imagenDe(TAQ, 'mf-p1')) === urlBD(`${TAQ}/mf-a1.webp`), r.out);
}
{
  // un producto cambio de foto mientras corria: no se pisa
  await armar(); respaldo();
  let n = 0;
  const r = await correr(['--aplicar'], { antes: async (req, url) => {
    if (req.method === 'PATCH' && /\/rest\/v1\/productos/.test(req.url) && ++n === 1) {
      await producto(TAQ, 'mf-p1', urlBD(`${TAQ}/mf-cambiada-por-el-dueno.webp`));   // el dueno cambia la foto de ese producto
    }
  } });
  prueba('un producto que cambio de foto mientras corria el script no se pisa', (await imagenDe(TAQ, 'mf-p1')) === urlBD(`${TAQ}/mf-cambiada-por-el-dueno.webp`) && /cambio de foto mientras corria/.test(r.out), r.out);
}
{
  // un producto de OTRO restaurante se pone a usar la antigua justo antes de borrar: no se borra
  await armar(); respaldo();
  let lecturas = 0;
  const r = await correr(['--aplicar'], { antes: async (req, url) => {
    if (req.method === 'GET' && /\/rest\/v1\/productos/.test(req.url) && ++lecturas === 2) await producto(OTRO, 'mf-o9', urlBD('mf-a1.webp'), 'cat-otro');
  } });
  prueba('si otro producto empieza a usar la antigua justo antes de borrarla, no se borra', (await existeFoto('mf-a1.webp')) && /todavia la usan 1 producto/.test(r.out) && r.code === 1, r.out);
}
{
  // un nombre de archivo que la base no acepta se salta
  await armar(); respaldo();
  const raro = 'mf rara (1).webp';
  await subir(raro, 'rara'); await producto(TAQ, 'mf-p7', urlBD(encodeURIComponent(raro)));
  const r = await correr(['--aplicar']);
  prueba('un archivo con nombre que la base no acepta se salta sin tocarlo', /SALTA\s+mf rara \(1\)\.webp/.test(r.out) && (await existeFoto(raro)), r.out);
}

/* ============================================================
   9. DESHACER
============================================================ */
{
  await armar(); respaldo();
  const orig = Object.fromEntries(NOMBRES_MOVIDOS.map((n) => [n, hash(bytesFoto(n))]));
  await correr(['--aplicar']);
  const migrado = await huellaBD(), stoMigrado = huellaStorage();
  const sim = await correr([`--deshacer=${REGISTRO}`]);
  prueba('deshacer en simulacion: lista lo que haria y no cambia nada', sim.code === 0 && /simulacion/i.test(sim.out) && NOMBRES_MOVIDOS.every((n) => sim.out.includes(`${TAQ}/${n}  ->  ${n}`)) && (await huellaBD()) === migrado && huellaStorage() === stoMigrado, sim.out);
  const r = await correr([`--deshacer=${REGISTRO}`, '--aplicar']);
  prueba('deshacer --aplicar: sale con 0 y las fotos vuelven a la raiz con los mismos bytes',
    r.code === 0 && (await Promise.all(NOMBRES_MOVIDOS.map(async (n) => (await existeFoto(n)) && hash(bytesFoto(n)) === orig[n] && !(await existeFoto(`${TAQ}/${n}`))))).every(Boolean), r.out);
  prueba('deshacer: los productos vuelven a su direccion de siempre (los 4)',
    (await imagenDe(TAQ, 'mf-p1')) === urlBD('mf-a1.webp') && (await imagenDe(TAQ, 'mf-p2')) === urlBD('mf-a2.png') && (await imagenDe(TAQ, 'mf-p3')) === urlBD('mf-a2.png') && (await imagenDe(TAQ, 'mf-p4')) === urlBD('mf-a3.jpeg'), r.out);
  prueba('deshacer: no toca las fotos ajenas ni la suelta', (await existeFoto('mf-compartida.webp')) && (await existeFoto('mf-suelta.webp')) && (await existeFoto(`${OTRO}/mf-o2.webp`)), '');
  // y se puede volver a migrar
  const otra = await correr(['--aplicar']);
  prueba('despues de deshacer se puede volver a migrar', otra.code === 0 && (await estadoFinalCorrecto()), otra.out);
  // con el SQL 14 puesto, deshacer explica que hay que revertirlo
  await quitarProblematicos();
  await db.exec(sql('14-retirar-regla-bucket.sql'));
  const bloqueado = await correr([`--deshacer=${REGISTRO}`, '--aplicar']);
  prueba('deshacer con el SQL 14 puesto: falla explicando que se corra 14-revertir.sql, sin dejar nada a medias',
    bloqueado.code === 1 && /14-revertir\.sql/.test(bloqueado.out) && (await estadoFinalCorrecto()), bloqueado.out);
  await db.exec(sql('14-revertir.sql'));
  const ajeno = await correr([`--deshacer=${path.join(tmp, 'no-existe.json')}`]);
  prueba('deshacer con un registro que no existe: se detiene (codigo 2)', ajeno.code === 2, ajeno.out);
  const otroProyecto = path.join(tmp, 'otro.json');
  fs.writeFileSync(otroProyecto, JSON.stringify({ proyecto: 'https://otro.supabase.co', fotos: [] }));
  prueba('deshacer con el registro de OTRO proyecto: se detiene (codigo 2)', (await correr([`--deshacer=${otroProyecto}`])).code === 2, '');
}

/* ============================================================
   10. SLUG
============================================================ */
{
  const r = await correr(['--slug=no-existe']);
  prueba('un slug que no existe: se detiene con un mensaje claro', r.code === 1 && /No existe el restaurante/.test(r.out), r.out);
  const r2 = await correr(['--slug=Mal Slug!']);
  prueba('un slug mal formado: se detiene (codigo 2)', r2.code === 2, r2.out);
}

/* ============================================================ */
await falso.cerrar();
fs.rmSync(tmp, { recursive: true, force: true });
let fallas = 0;
for (const r of resultados) {
  if (!r.ok) fallas++;
  console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
}
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
setTimeout(() => process.exit(), 1000).unref();
