/* =============================================================
   PRUEBA DE supabase/crear-superadmin.mjs  (Supabase falso, sin red)

     node pruebas/multirestaurante/crear-superadmin-test.mjs

   Comprueba: busca el usuario por correo (sin distinguir mayusculas) y lo agrega a public.superadmins; es idempotente;
   --solo-verificar no escribe y avisa con el codigo de salida; --quitar lo saca; un correo que no existe o mal escrito no
   hace nada; una llave pegada dos veces no hace nada; y NUNCA imprime la llave de servicio, un id completo ni una contrasena.
============================================================= */
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { levantar } from './fake-supabase.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LLAVE = 'sb_secret_FAKE_0000';
const falso = await levantar({ puerto: 54343 });
const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info) });

const H = { apikey: LLAVE, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const sfx = crypto.randomBytes(3).toString('hex');
const crearUsuario = async (email) => {
  const r = await fetch(`${falso.url}/auth/v1/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ email, password: 'Pw-' + crypto.randomBytes(8).toString('hex'), email_confirm: true }) });
  return JSON.parse(await r.text());
};
const superadmins = async () => JSON.parse(await (await fetch(`${falso.url}/rest/v1/superadmins?select=user_id`, { headers: H })).text()).map((x) => x.user_id);

function correr(env, ...args) {
  const entorno = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: falso.url, SUPABASE_SERVICE_ROLE_KEY: LLAVE, ...env };
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [path.join(RAIZ, 'supabase', 'crear-superadmin.mjs'), ...args], { cwd: RAIZ, env: entorno });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; });
    h.stderr.on('data', (d) => { salida += d; });
    const t = setTimeout(() => h.kill(), 60000);
    h.on('close', (codigo) => { clearTimeout(t); resolve({ codigo, salida }); });
  });
}

try {
  const correo = `sa-${sfx}@prueba-superadmin.example.com`;
  const u = await crearUsuario(correo);
  const otro = await crearUsuario(`otro-${sfx}@prueba-superadmin.example.com`);

  let r = await correr({}, correo, '--solo-verificar');
  prueba('--solo-verificar de alguien que NO es superadmin: lo dice, sale 1 y no escribe', r.codigo === 1 && /NO es superadmin/.test(r.salida) && (await superadmins()).length === 0, r.salida);

  r = await correr({}, correo.toUpperCase());
  prueba('agrega al usuario (el correo se busca sin distinguir mayusculas) y lo verifica', r.codigo === 0 && /Agregado a superadmins y verificado/.test(r.salida) && (await superadmins()).join() === u.id, r.salida);
  prueba('solo agrega a ESE usuario', !(await superadmins()).includes(otro.id));
  prueba('NUNCA imprime la llave de servicio, el id completo del usuario ni su contrasena', !r.salida.includes(LLAVE) && !r.salida.includes(u.id) && /id [0-9a-f]{8}\.\.\./.test(r.salida) && !/password|contrase/i.test(r.salida.replace('la contrasena', '')), r.salida);

  r = await correr({}, correo);
  prueba('es idempotente: otra vez dice que ya era superadmin, sale 0 y no duplica', r.codigo === 0 && /Ya era superadmin/.test(r.salida) && (await superadmins()).length === 1, r.salida);
  r = await correr({}, correo, '--solo-verificar');
  prueba('--solo-verificar de un superadmin: sale 0', r.codigo === 0 && /Es superadmin/.test(r.salida), r.salida);

  r = await correr({}, `inexistente-${sfx}@prueba-superadmin.example.com`);
  prueba('un correo que no existe en Authentication no hace nada y sale 2 explicando como crearlo', r.codigo === 2 && /No existe ningun usuario/.test(r.salida) && (await superadmins()).length === 1, r.salida);
  r = await correr({}, 'esto-no-es-un-correo');
  prueba('un correo mal escrito (o ninguno) sale 2 sin tocar nada', r.codigo === 2 && (await correr({})).codigo === 2 && (await superadmins()).length === 1, r.salida);
  r = await correr({ SUPABASE_SERVICE_ROLE_KEY: LLAVE + LLAVE }, `otro-${sfx}@prueba-superadmin.example.com`);
  prueba('una llave pegada DOS veces no hace nada y lo dice', r.codigo === 2 && /DOS veces/.test(r.salida) && !(await superadmins()).includes(otro.id) && !r.salida.includes(LLAVE), r.salida);
  r = await correr({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_FAKE_0000' }, correo);
  prueba('una llave publishable se rechaza con un mensaje claro', r.codigo === 2 && /publicable/.test(r.salida), r.salida);
  r = await correr({}, correo, '--solo-verificar', '--quitar');
  prueba('--solo-verificar y --quitar no se combinan', r.codigo === 2, r.salida);

  r = await correr({}, correo, '--quitar');
  prueba('--quitar lo saca de superadmins y lo verifica', r.codigo === 0 && /Quitado de superadmins/.test(r.salida) && (await superadmins()).length === 0, r.salida);
  r = await correr({}, correo, '--quitar');
  prueba('--quitar de alguien que no lo es: nada que quitar, sale 0', r.codigo === 0 && /nada que quitar/.test(r.salida), r.salida);
} finally {
  for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
  process.exitCode = fallas ? 1 : 0;
  await falso.cerrar();
  setTimeout(() => process.exit(), 1500).unref();
}
