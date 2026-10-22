/* =============================================================
   PRUEBA DE supabase/cargar-secretos.mjs  (Supabase falso, sin red)

     node pruebas/multirestaurante/cargar-secretos-test.mjs

   Comprueba: guarda lo del entorno en la fila del restaurante indicado (y de
   ningun otro), NUNCA imprime un valor, detecta llaves pegadas dos veces, no
   pisa un valor existente sin --sobrescribir, no guarda vacios, y --solo-verificar
   no escribe nada.
============================================================= */
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { levantar } from './fake-supabase.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LLAVE = 'sb_secret_FAKE_0000';
const falso = await levantar({ puerto: 54333 });
const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info) });

const H = { apikey: LLAVE, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const rest = async (m, ruta, cuerpo) => {
  const r = await fetch(`${falso.url}/rest/v1/${ruta}`, { method: m, headers: H, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return JSON.parse((await r.text()) || 'null');
};
const sfx = crypto.randomBytes(3).toString('hex');
const A = (await rest('POST', 'restaurantes', { slug: `test-cs-a-${sfx}`, nombre: 'PRUEBA-CARGAR A' }))[0];
const B = (await rest('POST', 'restaurantes', { slug: `test-cs-b-${sfx}`, nombre: 'PRUEBA-CARGAR B' }))[0];
const secretos = async (r) => (await rest('GET', `restaurante_secretos?restaurante_id=eq.${r.id}&select=*`))[0];

// Asincrono a proposito: el Supabase falso vive en ESTE proceso y no puede responder si lo bloqueamos
function correr(env, ...args) {
  const entorno = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: LLAVE, ...env };
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [path.join(RAIZ, 'supabase', 'cargar-secretos.mjs'), ...args], { cwd: RAIZ, env: entorno });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; });
    h.stderr.on('data', (d) => { salida += d; });
    const t = setTimeout(() => h.kill(), 60000);
    h.on('close', (codigo) => { clearTimeout(t); resolve({ codigo, salida }); });
  });
}
const V = {
  integridad: 'test_integrity_' + crypto.randomBytes(8).toString('hex'),
  eventos: 'test_events_' + crypto.randomBytes(8).toString('hex'),
  eventosProd: 'prod_events_' + crypto.randomBytes(8).toString('hex'),
  apikey: String(100000 + Math.floor(Math.random() * 800000)),
  privada: 'prv_test_' + crypto.randomBytes(6).toString('hex')
};
const ENV = {
  WOMPI_INTEGRITY_SECRET_TEST: V.integridad, WOMPI_EVENTS_SECRET_TEST: V.eventos, WOMPI_EVENTS_SECRET_PROD: V.eventosProd,
  CALLMEBOT_PHONE: '573001112233', CALLMEBOT_APIKEY: V.apikey, WOMPI_PRIVATE_KEY_TEST: V.privada, WOMPI_MODO: 'test'
};

try {
  // --- guardar ---
  let r = await correr(ENV, `--slug=${A.slug}`);
  let a = await secretos(A), b = await secretos(B);
  prueba('guarda las variables de entorno en la fila del restaurante indicado (columnas y "otros")', r.codigo === 0
    && a.wompi_integridad_test === V.integridad && a.wompi_eventos_test === V.eventos && a.wompi_eventos_prod === V.eventosProd
    && a.callmebot_telefono === '573001112233' && a.callmebot_apikey === V.apikey
    && a.otros.wompi_llave_privada_test === V.privada && a.otros.wompi_modo === 'test', r.salida);
  prueba('no toca la fila de OTRO restaurante', b.wompi_integridad_test === null && b.callmebot_apikey === null && igual(b.otros, {}), JSON.stringify(b).slice(0, 200));
  prueba('NUNCA imprime un valor (ni completo ni la mitad)', !Object.values(V).some((v) => r.salida.includes(v) || r.salida.includes(v.slice(0, Math.ceil(v.length / 2)))) && !r.salida.includes('573001112233') && !r.salida.includes(LLAVE), r.salida);
  prueba('informa de cada campo con su largo, sin nada derivado del valor (ni huellas ni hashes)',
    /WOMPI_INTEGRITY_SECRET_TEST\s+-> wompi_integridad_test\s+\d+ caracteres\s+se guarda/.test(r.salida) && /Guardado y verificado/.test(r.salida)
    && !/huella|[0-9a-f]{12,}/.test(r.salida.replace(/test-cs-[a-z]-[0-9a-f]+/g, '')), r.salida);

  // --- verificar ---
  r = await correr(ENV, `--slug=${A.slug}`, '--solo-verificar');
  prueba('--solo-verificar: todo coincide, sale 0 y no imprime valores', r.codigo === 0 && (r.salida.match(/ya coincide con la base/g) || []).length === 7 && !Object.values(V).some((v) => r.salida.includes(v)), r.salida);
  r = await correr({ ...ENV, WOMPI_EVENTS_SECRET_TEST: 'test_events_otro' }, `--slug=${A.slug}`, '--solo-verificar');
  a = await secretos(A);
  prueba('--solo-verificar: marca lo DIFERENTE y no escribe nada', /DIFERENTE a la base/.test(r.salida) && a.wompi_eventos_test === V.eventos, r.salida);
  r = await correr(ENV, `--slug=${B.slug}`, '--solo-verificar');
  prueba('--solo-verificar contra otro restaurante: dice que falta en la base', /falta en la base/.test(r.salida) && (await secretos(B)).wompi_integridad_test === null, r.salida);
  prueba('R4. --solo-verificar: avisa que esos valores ya los tiene OTRO restaurante y sale 1', r.codigo === 1 && /AVISO: WOMPI_EVENTS_SECRET_TEST tiene el MISMO valor que otro restaurante/.test(r.salida) && !Object.values(V).some((v) => r.salida.includes(v)), r.salida);

  // --- R4: las variables de OTRO restaurante quedaron en la sesion ---
  const antesB = JSON.stringify(await secretos(B));
  r = await correr(ENV, `--slug=${B.slug}`);
  prueba('R4. con las variables de A en la sesion, cargar B no guarda NADA, sale 2, lo explica y no imprime valores',
    r.codigo === 2 && JSON.stringify(await secretos(B)) === antesB && /OTRO restaurante/.test(r.salida) && !Object.values(V).some((v) => r.salida.includes(v)), r.salida);
  r = await correr({ WOMPI_EVENTS_SECRET_TEST: V.eventos, CALLMEBOT_APIKEY: '987654' }, `--slug=${B.slug}`, '--permitir-repetidos');
  prueba('R4. el secreto de eventos de Wompi de otro restaurante no se acepta ni con --permitir-repetidos (y no guarda lo demas)', r.codigo === 2 && JSON.stringify(await secretos(B)) === antesB, r.salida);
  const mismoTelefono = { CALLMEBOT_PHONE: '573001112233', CALLMEBOT_APIKEY: V.apikey };
  r = await correr(mismoTelefono, `--slug=${B.slug}`);
  prueba('R4. el CallMeBot de otro restaurante tampoco se guarda sin decirlo a proposito', r.codigo === 2 && JSON.stringify(await secretos(B)) === antesB && /--permitir-repetidos/.test(r.salida), r.salida);
  r = await correr(mismoTelefono, `--slug=${B.slug}`, '--permitir-repetidos');
  b = await secretos(B);
  prueba('R4. ...y con --permitir-repetidos (mismo dueno, mismo telefono) si se guarda', r.codigo === 0 && b.callmebot_apikey === V.apikey && b.callmebot_telefono === '573001112233' && b.wompi_eventos_test === null, r.salida);

  // --- no pisar ---
  r = await correr({ WOMPI_EVENTS_SECRET_TEST: 'test_events_NUEVO' }, `--slug=${A.slug}`);
  a = await secretos(A);
  prueba('sin --sobrescribir NO cambia un valor existente distinto (sale 1 y lo avisa)', r.codigo === 1 && a.wompi_eventos_test === V.eventos && /--sobrescribir/.test(r.salida), r.salida);
  r = await correr({ WOMPI_EVENTS_SECRET_TEST: 'test_events_NUEVO' }, `--slug=${A.slug}`, '--sobrescribir');
  a = await secretos(A);
  prueba('con --sobrescribir si lo cambia, y deja intactos los demas', r.codigo === 0 && a.wompi_eventos_test === 'test_events_NUEVO' && a.wompi_integridad_test === V.integridad && a.callmebot_apikey === V.apikey, r.salida);

  // --- vacios y "otros" sin perder lo anterior ---
  r = await correr({ WOMPI_EVENTS_SECRET_TEST: '   ', CALLMEBOT_APIKEY: '' , WOMPI_PRIVATE_KEY_PROD: 'prv_prod_' + 'a1b2c3d4e5f6'}, `--slug=${A.slug}`);
  a = await secretos(A);
  prueba('un valor vacio no pisa uno existente, y agregar a "otros" conserva lo anterior', a.callmebot_apikey === V.apikey && a.wompi_eventos_test === 'test_events_NUEVO'
    && a.otros.wompi_llave_privada_prod === 'prv_prod_a1b2c3d4e5f6' && a.otros.wompi_modo === 'test' && a.otros.wompi_llave_privada_test === V.privada, JSON.stringify(a.otros));

  // --- pegado doble ---
  const antes = JSON.stringify(await secretos(B));
  const doble = 'test_integrity_' + 'abcdef0123456789';
  for (const [nombre, env] of [
    ['el valor repetido dos veces', { WOMPI_INTEGRITY_SECRET_TEST: doble + doble }],
    ['dos prefijos conocidos pegados', { WOMPI_EVENTS_SECRET_TEST: 'test_events_abc123test_events_def456' }],
    ['una llave numerica repetida', { CALLMEBOT_APIKEY: '123456123456' }]
  ]) {
    r = await correr({ ...ENV, ...env }, `--slug=${B.slug}`);
    prueba(`pegado doble (${nombre}): no guarda NADA de nada, sale 2 y no imprime el valor`, r.codigo === 2 && JSON.stringify(await secretos(B)) === antes && /DOS veces/.test(r.salida) && !r.salida.includes(Object.values(env)[0]), r.salida);
  }
  r = await correr({ SUPABASE_SERVICE_ROLE_KEY: LLAVE + LLAVE, WOMPI_INTEGRITY_SECRET_TEST: V.integridad }, `--slug=${B.slug}`);
  prueba('la llave secreta de Supabase pegada dos veces: se detiene', r.codigo === 2 && /DOS veces/.test(r.salida) && !r.salida.includes(LLAVE + LLAVE), r.salida);

  // --- validaciones ---
  prueba('con espacios en medio del valor: se detiene', (await correr({ WOMPI_INTEGRITY_SECRET_TEST: 'test_integrity_ab cd' }, `--slug=${B.slug}`)).codigo === 2, '');
  prueba('telefono que no es solo digitos: se detiene', (await correr({ CALLMEBOT_PHONE: '+57 300' }, `--slug=${B.slug}`)).codigo === 2, '');
  prueba('WOMPI_MODO distinto de test/produccion: se detiene', (await correr({ WOMPI_MODO: 'prod' }, `--slug=${B.slug}`)).codigo === 2, '');
  prueba('slug inexistente: se detiene', (await correr(ENV, '--slug=no-existe-' + sfx)).codigo === 2, '');
  prueba('sin --slug: se detiene', (await correr(ENV)).codigo === 2, '');
  prueba('sin ninguna variable de secretos: se detiene explicando como pedirlas', /Read-Host/.test((await correr({}, `--slug=${B.slug}`)).salida), '');
} finally {
  for (const r of [A, B]) {
    await fetch(`${falso.url}/rest/v1/configuracion?restaurante_id=eq.${r.id}`, { method: 'DELETE', headers: H });
    await fetch(`${falso.url}/rest/v1/salud_notificaciones?restaurante_id=eq.${r.id}`, { method: 'DELETE', headers: H });
    await fetch(`${falso.url}/rest/v1/restaurantes?id=eq.${r.id}`, { method: 'DELETE', headers: H });
  }
  await falso.cerrar();
}

function igual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
setTimeout(() => process.exit(), 1500).unref();
