/* =============================================================
   PRUEBA DE supabase/quitar-mfa.mjs (recuperacion si se pierde el celular)  -  Supabase falso, sin red

     node pruebas/multirestaurante/quitar-mfa-test.mjs

   De punta a punta: un superadmin enrola y verifica un TOTP real (aal2), pierde el factor (el script lo borra) y vuelve a entrar:
   sin --confirmar no se borra nada; con --confirmar se borran los factores y se cierran las sesiones aal2; la contrasena sigue
   valiendo (aal1) y el servidor lo trata como superadmin SIN MFA (403 mfa_requerida) hasta que enrole uno nuevo. Nunca imprime
   llaves, contrasenas ni secretos.
============================================================= */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { levantar } from './fake-supabase.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const totp = require('./totp.js');
const LLAVE = 'sb_secret_FAKE_0000', PUB = 'sb_publishable_FAKE_0000';

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 400) });
const correr = (args, env = {}) => new Promise((resolve) => {
  const h = spawn(process.execPath, [path.join(RAIZ, 'supabase', 'quitar-mfa.mjs'), ...args], { cwd: RAIZ, env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: LLAVE, ...env } });
  let salida = ''; h.stdout.on('data', (d) => { salida += d; }); h.stderr.on('data', (d) => { salida += d; });
  h.on('close', (codigo) => resolve({ codigo, salida }));
});

const falso = await levantar({ puerto: 54343, validarConfig: false });
const URL_BASE = falso.url;
const post = async (ruta, token, cuerpo, apikey = PUB) => {
  const r = await fetch(`${URL_BASE}${ruta}`, { method: 'POST', headers: { apikey, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await r.json().catch(() => null) };
};
const H = { apikey: LLAVE, 'Content-Type': 'application/json' };
const email = 'olvido-celular@prueba-superadmin.example.com', clave = 'Pw-' + 'x'.repeat(10) + 'aA1!';
const u = await (await fetch(`${URL_BASE}/auth/v1/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ email, password: clave, email_confirm: true }) })).json();
await falso.db.query('insert into public.superadmins (user_id) values ($1)', [u.id]);
const entrar = async () => (await post('/auth/v1/token?grant_type=password', null, { email, password: clave })).cuerpo.access_token;
const elevar = async () => {
  const t1 = await entrar();
  const f = (await post('/auth/v1/factors', t1, { factor_type: 'totp', friendly_name: 'celular' })).cuerpo;
  const c = (await post(`/auth/v1/factors/${f.id}/challenge`, t1, {})).cuerpo;
  const v = await post(`/auth/v1/factors/${f.id}/verify`, t1, { challenge_id: c.id, code: totp.codigoTotp(f.totp.secret, Date.now()) });
  return { token: v.cuerpo.access_token, secreto: f.totp.secret };
};

// el servidor real contra el falso
process.env.SUPABASE_URL = URL_BASE; process.env.SUPABASE_SERVICE_ROLE_KEY = LLAVE; process.env.SUPABASE_PUBLISHABLE_KEY = PUB;
const SA = require(path.join(RAIZ, 'api', 'superadmin.js'));
const llamar = (token, accion) => new Promise((resolve) => {
  const req = { method: 'POST', url: '/api/superadmin', headers: { authorization: 'Bearer ' + token, 'x-forwarded-for': '10.1.1.' + Math.floor(Math.random() * 200) }, body: { accion } };
  const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ status: this.code, cuerpo: o }); return this; } };
  SA(req, res);
});

const { token: tAal2, secreto } = await elevar();
const antes = await llamar(tAal2, 'yo');
prueba('con el celular, el superadmin entra (aal2)', antes.status === 200, JSON.stringify(antes));

const seco = await correr([email]);
prueba('sin --confirmar solo MUESTRA los factores: no borra nada', seco.codigo === 0 && /tipo totp/.test(seco.salida) && /verified/.test(seco.salida) && /No se borro nada/.test(seco.salida)
  && (await llamar(tAal2, 'yo')).status === 200, seco.salida);
prueba('no imprime llaves, contrasenas, secretos TOTP ni tokens', ![LLAVE, clave, secreto, tAal2].some((s) => seco.salida.includes(s)), seco.salida);
const mal = await correr(['no-es-correo']);
const noExiste = await correr(['nadie@prueba-superadmin.example.com']);
prueba('un correo mal escrito o que no existe termina con error y sin tocar nada', mal.codigo === 2 && noExiste.codigo === 2 && /No existe/.test(noExiste.salida), mal.salida + noExiste.salida);
const sinLlave = await correr([email], { SUPABASE_SERVICE_ROLE_KEY: '' });
prueba('sin la llave de servicio no hace nada', sinLlave.codigo === 2, sinLlave.salida);
const doble = await correr([email], { SUPABASE_SERVICE_ROLE_KEY: LLAVE + LLAVE });
prueba('una llave pegada dos veces se rechaza', doble.codigo === 2 && /DOS veces/.test(doble.salida), doble.salida);

const hecho = await correr([email, '--confirmar']);
prueba('con --confirmar borra el factor, lo dice, y sin datos sensibles', hecho.codigo === 0 && /borrado/.test(hecho.salida) && /Listo/.test(hecho.salida) && ![LLAVE, clave, secreto, tAal2].some((s) => hecho.salida.includes(s)), hecho.salida);
const tras = await llamar(tAal2, 'yo');
prueba('la sesion aal2 anterior se cierra (Supabase cierra las sesiones al borrar un factor verificado)', tras.status === 401, JSON.stringify(tras));
const t1 = await entrar();
const sinMfa = await llamar(t1, 'listar_restaurantes');
const estado = await llamar(t1, 'mi_estado');
prueba('la contrasena sigue valiendo (aal1): el servidor lo trata como superadmin SIN MFA hasta que enrole uno nuevo', sinMfa.status === 403 && sinMfa.cuerpo.codigo === 'mfa_requerida' && estado.status === 200 && estado.cuerpo.aal === 'aal1', JSON.stringify([sinMfa, estado]));
const otra = await correr([email, '--confirmar']);
prueba('repetirlo no falla: dice que no hay nada que quitar', otra.codigo === 0 && /nada que quitar/.test(otra.salida), otra.salida);
const nuevo = await elevar();
const vuelve = await llamar(nuevo.token, 'yo');
prueba('con un factor nuevo vuelve a entrar con MFA', vuelve.status === 200, JSON.stringify(vuelve));

for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
await falso.cerrar();
process.exitCode = fallas ? 1 : 0;
setTimeout(() => process.exit(), 1500).unref();
