/* =============================================================
   PRUEBAS DE NAVEGADOR DE LA PANTALLA DE SUPERADMINISTRACION  (superadmin.html y superadmin*.js)

     node pruebas/multirestaurante/superadmin-pantalla.mjs

   Chrome sin interfaz + el manejador REAL de api/superadmin.js + el Supabase falso (Postgres 16 real en PGlite con los SQL 10 a 19, roles y
   RLS reales, y Auth con MFA TOTP aal1/aal2, renovacion de sesion, cierre de sesion y borrado de factores). Sin red externa.
   Como en produccion, Supabase vive en OTRO origen (supabase.localhost) y la pantalla en el suyo (localhost); las cabeceras de
   seguridad que se le ponen a la pagina son las de vercel.json (con el dominio de Supabase cambiado por el de la prueba).

   Entre el navegador y la API hay un "inyector": permite responder 401/403/429/500/503 a una accion concreta, cortar la red, o dejar
   que pase al servidor real. Todo lo que el navegador manda queda en una bitacora para comprobar QUE se mando (y que NO se mando).

   Variables: CHROME=ruta\chrome.exe   SOLO="^(3|4)\."   (corre solo los escenarios que casen)   CAPTURAS=0 (no guarda imagenes)
   Las capturas van a Recursos/NORTHE-NUEVO/capturas/superadmin-*.png (carpeta ignorada por git).
============================================================= */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { levantar } from './fake-supabase.mjs';
import { REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const totp = require('./totp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const execGit = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 20e6 });

const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const PUERTO_WEB = Number(process.env.PUERTO_WEB) || 8105;
const PUERTO_CDP = Number(process.env.PUERTO_CDP) || 9345;
const PUERTO_FALSO = Number(process.env.PUERTO_FALSO) || 54351;
const HOST_SUPABASE = 'supabase.localhost';
const ORIGEN_SITIO = `http://localhost:${PUERTO_WEB}`;
const ORIGEN_SUPABASE = `http://${HOST_SUPABASE}:${PUERTO_WEB}`;
const URL_PAGINA = ORIGEN_SITIO + '/superadmin.html';
const CARPETA_CAPTURAS = path.join(REPO, 'Recursos', 'NORTHE-NUEVO', 'capturas');
const CAPTURAR = process.env.CAPTURAS !== '0';
const sfx = crypto.randomBytes(3).toString('hex');
const CLAVE = 'Clave-de-prueba-' + sfx;
const SUPABASE_REAL = 'https://pzryobpriyewlxltditw.supabase.co';
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* ---------------- CDP minimo ---------------- */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0; this.pend = new Map(); this.escuchas = [];
    this.abierto = new Promise((ok, mal) => { this.ws.onopen = ok; this.ws.onerror = mal; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { ok, mal } = this.pend.get(m.id); this.pend.delete(m.id);
        if (m.error) mal(new Error(m.error.message)); else ok(m.result);
      } else if (m.method) this.escuchas.forEach((f) => f(m));
    };
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((ok, mal) => this.pend.set(id, { ok, mal }));
  }
  on(f) { this.escuchas.push(f); }
}

/* Antes de que cargue cualquier script de la pagina: el portapapeles queda grabado (para ver QUE se copia) y no hay service worker. */
const SCRIPT_GRABADORA = `
(function(){
  window.__copiado = [];
  try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: function(t){ window.__copiado.push(String(t)); return Promise.resolve(); } } }); } catch(e){}
})();`;

class Pagina {
  constructor(cdp, sessionId, nombre) {
    this.cdp = cdp; this.sid = sessionId; this.nombre = nombre;
    this.errores = []; this.consola = []; this.dialogos = [];
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errores.push('EXCEPCION: ' + ((d.exception && d.exception.description) || d.text));
      } else if (m.method === 'Runtime.consoleAPICalled') {
        this.consola.push(m.params.type + ': ' + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(' '));
      } else if (m.method === 'Log.entryAdded') {
        this.consola.push('log-' + m.params.entry.level + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
      } else if (m.method === 'Page.javascriptDialogOpening') {
        this.dialogos.push(m.params.message);
        cdp.send('Page.handleJavaScriptDialog', { accept: true }, sessionId).catch(() => {});
      }
    });
  }
  async eval(expr) {
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, this.sid);
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async ir(url) { await this.cdp.send('Page.navigate', { url }, this.sid); }
  async esperar(fn, ms, etiqueta) {
    const fin = Date.now() + (ms || 8000);
    while (Date.now() < fin) {
      try { if (await this.eval('(' + fn + ')()')) return true; } catch (e) { /* aun cargando */ }
      await sleep(60);
    }
    let estado = '';
    try { estado = await this.eval(`JSON.stringify({url: location.href, h1: (document.querySelector('h1')||{}).textContent, msj: [...document.querySelectorAll('.sa-msj')].map(function(x){return x.textContent.slice(0,120)})})`); } catch (e) { estado = '(sin estado: ' + e.message + ')'; }
    throw new Error('Tiempo agotado esperando: ' + (etiqueta || fn) + ' | estado: ' + estado + ' | errores: ' + this.errores.join(' ; ') + ' | consola: ' + this.consola.slice(-4).join(' ; '));
  }
  async existe(selector, ms = 6000) {
    const fin = Date.now() + ms;
    while (Date.now() < fin) {
      try { if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true; } catch (e) { /* navegando */ }
      await sleep(50);
    }
    throw new Error('no existe ' + selector);
  }
  async escribir(selector, valor) {
    await this.existe(selector);
    return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(valor)};
      e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  }
  async clic(selector) {
    await this.existe(selector);
    return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('no existe');e.click();return true;})()`);
  }
  async marcar(selector, valor = true) {
    await this.existe(selector);
    return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(e.checked!==${valor}){e.click();}return e.checked;})()`);
  }
  async clicTexto(texto, selector = 'button') {
    return this.eval(`(function(){var b=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(function(x){return x.textContent.trim()===${JSON.stringify(texto)}&&!x.hidden})[0];if(!b)throw new Error('no hay boton ${texto.replace(/'/g, '')}');b.click();return true;})()`);
  }
  async texto(selector) { return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});return e?e.textContent:null;})()`); }
  async cuerpo() { return this.eval('document.body.innerText'); }
  async tecla(key, code, extra = {}) {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: extra.vk || 0, modifiers: extra.mod || 0 }, this.sid);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: extra.vk || 0, modifiers: extra.mod || 0 }, this.sid);
  }
  async almacenamiento() {
    return this.eval(`JSON.stringify({ local: Object.keys(localStorage).map(function(k){return [k, localStorage.getItem(k)];}), sesion: Object.keys(sessionStorage).map(function(k){return [k, sessionStorage.getItem(k)];}), cookie: document.cookie, url: location.href })`).then(JSON.parse);
  }
}

/* ---------------- bitacoras e inyector ---------------- */
const bitacoraApi = [];     // { accion, tieneBearer, status, ms, cuerpo }
const bitacoraAuth = [];    // { metodo, ruta, status }
const inyectar = { api: [], auth: [] };
const estadoSitio = { sinCabeceras: false };

function leerCuerpo(req) { return new Promise((ok) => { const t = []; req.on('data', (c) => t.push(c)); req.on('end', () => ok(Buffer.concat(t))); }); }
function adaptar(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { res.end(b); return res; };
  return res;
}
/* Busca una regla de inyeccion que case y la gasta (veces). */
function tomarRegla(lista, pred) {
  const i = lista.findIndex((r) => (r.veces === undefined || r.veces > 0) && pred(r));
  if (i < 0) return null;
  const r = lista[i];
  if (r.veces !== undefined) r.veces--;
  return r;
}

/* Cabeceras de vercel.json para una ruta exacta, con el dominio de Supabase cambiado por el de la prueba. */
function cabecerasDeVercel(ruta) {
  const v = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
  const salida = {};
  for (const bloque of v.headers || []) {
    if (bloque.source !== ruta) continue;
    for (const h of bloque.headers) salida[h.key] = h.value.split(SUPABASE_REAL).join(ORIGEN_SUPABASE);
  }
  return salida;
}

async function crearSitio({ falso, manejador }) {
  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const host = String(req.headers.host || '');
      // ---- "Supabase" (otro origen): CORS + reenvio al falso, con inyector ----
      if (host.startsWith(HOST_SUPABASE + ':')) {
        const cors = { 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, apikey, content-type',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        const cuerpo = await leerCuerpo(req);
        const ruta = url.pathname + url.search;
        const regla = tomarRegla(inyectar.auth, (r) => (!r.ruta || ruta.includes(r.ruta)) && (!r.metodo || r.metodo === req.method));
        const entrada = { metodo: req.method, ruta, tieneBearer: /^Bearer\s/i.test(req.headers.authorization || ''), apikey: String(req.headers.apikey || ''), cuerpo: cuerpo.toString('utf8').slice(0, 2000) };
        bitacoraAuth.push(entrada);
        if (regla) {
          if (regla.cortar) { entrada.status = 0; req.socket.destroy(); return; }
          entrada.status = regla.status;
          res.writeHead(regla.status, { ...cors, 'Content-Type': 'application/json', ...(regla.headers || {}) }); res.end(JSON.stringify(regla.cuerpo || {}));
          return;
        }
        const headers = {};
        for (const k of ['apikey', 'authorization', 'content-type']) if (req.headers[k]) headers[k] = req.headers[k];
        const r = await fetch(falso.url + req.url, { method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo, headers });
        entrada.status = r.status;
        res.writeHead(r.status, { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }

      // ---- el sitio ----
      if (url.pathname === '/api/superadmin') {
        const cuerpoBytes = await leerCuerpo(req);
        let accion = '';
        try { accion = JSON.parse(cuerpoBytes.toString('utf8')).accion || ''; } catch (e) { /* no es JSON */ }
        const entrada = { metodo: req.method, accion, tieneBearer: /^Bearer\s/i.test(req.headers.authorization || ''), cuerpo: cuerpoBytes.toString('utf8') };
        bitacoraApi.push(entrada);
        const regla = tomarRegla(inyectar.api, (r) => (!r.accion || r.accion === '*' || r.accion === accion));
        if (regla) {
          if (regla.demora) await sleep(regla.demora);
          if (regla.cortar) { entrada.status = 0; req.socket.destroy(); return; }
          entrada.status = regla.status; entrada.inyectada = true;
          res.writeHead(regla.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(regla.headers || {}) }); res.end(JSON.stringify(regla.cuerpo || {}));
          return;
        }
        // al manejador REAL: el cuerpo ya leido se entrega como texto (Vercel lo entrega ya interpretado)
        req.body = cuerpoBytes.length ? cuerpoBytes.toString('utf8') : undefined;
        res.on('finish', () => { entrada.status = res.statusCode; });
        await manejador(req, adaptar(res));
        return;
      }
      let ruta = decodeURIComponent(url.pathname);
      if (ruta === '/') ruta = '/index.html';
      if (ruta === '/supabase-publico.js') {
        res.writeHead(200, { 'Content-Type': TIPOS['.js'] });
        res.end(`window.SUPABASE_PUBLICO = Object.freeze({ url: ${JSON.stringify(ORIGEN_SUPABASE)}, publishableKey: "sb_publishable_FAKE_0000" });`);
        return;
      }
      const archivo = path.join(REPO, ruta);
      if (!archivo.startsWith(path.resolve(REPO)) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) { res.writeHead(404); res.end('no existe'); return; }
      const cab = { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' };
      if (!estadoSitio.sinCabeceras) Object.assign(cab, cabecerasDeVercel(ruta));
      res.writeHead(200, cab);
      res.end(fs.readFileSync(archivo));
    } catch (e) {
      console.error('[sitio de prueba]', e);
      try { res.writeHead(500); res.end(String(e)); } catch (x) { /* ya respondio */ }
    }
  });
  return new Promise((ok) => servidor.listen(PUERTO_WEB, '0.0.0.0', () => ok(servidor)));
}

/* ---------------- resultados ---------------- */
const resultados = [];
function comprobar(ok, texto, info) {
  resultados.push({ ok: !!ok, texto });
  console.log('   ' + (ok ? 'PASA ' : 'FALLA') + ' ' + texto + (ok || !info ? '' : '\n          -> ' + String(info).slice(0, 900)));
}
let alIniciar = async () => {};
async function escenario(nombre, fn) {
  if (process.env.SOLO && !new RegExp(process.env.SOLO).test(nombre)) return;
  console.log('\n> ' + nombre);
  try { await alIniciar(); await fn(); } catch (e) { comprobar(false, 'ERROR en el escenario: ' + e.message, e.stack); }
}

(async () => {
  if (!CHROME) { console.error('No encuentro Chrome. Define CHROME=ruta\\chrome.exe'); process.exit(2); }

  // ---- base falsa y entorno del servidor ------------------------------------------------------------------
  const falso = await levantar({ puerto: PUERTO_FALSO, validarConfig: false });
  process.env.SUPABASE_URL = falso.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_FAKE_0000';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FAKE_0000';
  process.env.VERCEL_ENV = 'production';
  delete process.env.DOMINIO_BASE;
  const fetchOriginal = globalThis.fetch;
  const manejadorSuperadmin = require(path.join(REPO, 'api', 'superadmin.js'));
  const db = falso.db;
  const H = { apikey: 'sb_secret_FAKE_0000', 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const srv = async (metodo, ruta, cuerpo) => {
    const r = await fetchOriginal(`${falso.url}/rest/v1/${ruta}`, { method: metodo, headers: H, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${metodo} ${ruta.slice(0, 70)} -> ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const auth = async (ruta, cuerpo, token, metodo = 'POST') => {
    const r = await fetchOriginal(`${falso.url}/auth/v1${ruta}`, { method: metodo, headers: { apikey: 'sb_publishable_FAKE_0000', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* vacio */ }
    return { status: r.status, json: j };
  };
  async function usuario(clave) {
    const email = `${clave}-${sfx}@prueba-pantalla.example.com`;
    const r = await fetchOriginal(`${falso.url}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: 'sb_secret_FAKE_0000', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: CLAVE }) });
    if (!r.ok) throw new Error('no se pudo crear el usuario ' + clave + ': ' + await r.text());
    const u = await r.json();
    return { id: u.id, email };
  }
  /* Deja a un usuario con un factor TOTP ya verificado (por las rutas de Auth) y devuelve su secreto. */
  async function conFactor(u) {
    const l = await auth('/token?grant_type=password', { email: u.email, password: CLAVE });
    const f = await auth('/factors', { factor_type: 'totp', friendly_name: 'prueba' }, l.json.access_token);
    const c = await auth(`/factors/${f.json.id}/challenge`, {}, l.json.access_token);
    const v = await auth(`/factors/${f.json.id}/verify`, { challenge_id: c.json.id, code: totp.codigoTotp(f.json.totp.secret, Date.now()) }, l.json.access_token);
    if (v.status !== 200) throw new Error('no se pudo dejar el factor: ' + JSON.stringify(v.json));
    u.secreto = f.json.totp.secret; u.factorId = f.json.id;
    return u;
  }
  const codigo = (u) => totp.codigoTotp(u.secreto, Date.now());

  const uSinFactor = await usuario('sa-sin-factor');
  const uMfa = await conFactor(await usuario('sa-con-mfa'));
  const uMfa2 = await conFactor(await usuario('sa-con-mfa-2'));
  const uDueno = await usuario('dueno-normal');
  await srv('POST', 'superadmins', [{ user_id: uSinFactor.id }, { user_id: uMfa.id }, { user_id: uMfa2.id }]);

  const sitio = await crearSitio({ falso, manejador: manejadorSuperadmin });

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-superadmin-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PUERTO_CDP, '--user-data-dir=' + perfil,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) { try { version = await (await fetchOriginal('http://127.0.0.1:' + PUERTO_CDP + '/json/version')).json(); } catch (e) { await sleep(150); } }
  if (!version) { chrome.kill(); console.error('Chrome no abrio el puerto de depuracion'); process.exit(2); }
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.abierto;

  const abiertas = [];
  async function pagina(nombre, { ancho = 1280, alto = 900 } = {}) {
    const ctx = (await cdp.send('Target.createBrowserContext')).browserContextId;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = new Pagina(cdp, sessionId, nombre);
    pg.targetId = targetId; pg.contexto = ctx; pg.ancho = ancho;
    abiertas.push(pg);
    for (const d of ['Page', 'Runtime', 'DOM', 'Network', 'Log']) await cdp.send(d + '.enable', {}, sessionId);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*', 'https://*.jsdelivr.net/*'] }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT_GRABADORA }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: ancho < 500 }, sessionId);
    return pg;
  }
  async function medidas(pg, ancho, alto) {
    pg.ancho = ancho;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto || 900, deviceScaleFactor: 1, mobile: ancho < 500 }, pg.sid);
  }
  /* Captura de pantalla completa (la altura de la pagina) en el ancho actual. */
  async function capturar(pg, nombre) {
    if (!CAPTURAR) return;
    fs.mkdirSync(CARPETA_CAPTURAS, { recursive: true });
    const alto = await pg.eval('Math.min(Math.max(document.documentElement.scrollHeight, 600), 3200)');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: pg.ancho, height: alto, deviceScaleFactor: 1, mobile: pg.ancho < 500 }, pg.sid);
    await sleep(120);
    const img = await cdp.send('Page.captureScreenshot', { format: 'png' }, pg.sid);
    fs.writeFileSync(path.join(CARPETA_CAPTURAS, `superadmin-${nombre}-${pg.ancho}.png`), Buffer.from(img.data, 'base64'));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: pg.ancho, height: 900, deviceScaleFactor: 1, mobile: pg.ancho < 500 }, pg.sid);
  }
  async function capturarAmbos(pg, nombre) {
    const a = pg.ancho;
    for (const ancho of [390, 1280]) { await medidas(pg, ancho); await sleep(80); await capturar(pg, nombre); }
    await medidas(pg, a);
  }
  alIniciar = async () => {
    for (const pg of abiertas) { if (pg.cerrada) continue; pg.cerrada = true; try { await cdp.send('Target.closeTarget', { targetId: pg.targetId }); } catch (e) { /* ya cerrada */ } }
    inyectar.api.length = 0; inyectar.auth.length = 0; estadoSitio.sinCabeceras = false;
    bitacoraApi.length = 0; bitacoraAuth.length = 0;
    manejadorSuperadmin.reiniciarLimite();
    await sleep(100);
  };

  /* ---------- ayudas de flujo ---------- */
  const llamadas = (accion) => bitacoraApi.filter((x) => x.accion === accion);
  const visible = (pg, sel) => pg.eval(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return !!e&&!e.hidden&&e.getClientRects().length>0;})()`);
  async function iniciarSesion(pg, u, clave = CLAVE) {
    await pg.escribir('#sa-correo', u.email);
    await pg.escribir('#sa-clave', clave);
    await pg.clic('#sa-form-entrada button[type=submit]');
  }
  /* Entra con contrasena + codigo de la app (el usuario ya tiene su factor) y espera la lista. */
  async function entrarConCodigo(pg, u) {
    await pg.ir(URL_PAGINA);
    await pg.existe('#sa-form-entrada');
    await iniciarSesion(pg, u);
    await pg.existe('#sa-codigo');
    await pg.escribir('#sa-codigo', codigo(u));
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){return !!document.querySelector('#sa-capa-app:not([hidden]) h1')&&!document.querySelector('#sa-capa-app').hidden&&document.querySelector('#sa-capa-app h1').textContent==='Restaurantes'}`, 8000, 'la lista tras el codigo');
  }
  const tick = async (ms) => sleep(ms);

  /*FIN-INFRA*/
  const MSJ_GENERICO = 'No pudimos iniciar sesión con esos datos. Revisa el correo y la contraseña.';
  const leerSesion = async (pg) => { const a = await pg.almacenamiento(); const s = a.sesion.find((x) => x[0] === 'sa-sesion-v1'); return s ? JSON.parse(s[1]) : null; };
  const sinComentarios = (txt) => txt.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const ARCHIVOS_PANTALLA = ['superadmin.js', 'superadmin-alta.js', 'superadmin-detalle.js', 'superadmin-lectura.js', 'superadmin-inicio.js'];

  /* ======================= 1. archivos, cabeceras y aislamiento ======================= */
  await escenario('1. Cabeceras de seguridad, CSP, archivos y que nada enlace a la pantalla', async () => {
    const r = await fetchOriginal(URL_PAGINA);
    const cab = Object.fromEntries([...r.headers.entries()]);
    const csp = cab['content-security-policy'] || '';
    comprobar(r.status === 200, '/superadmin.html responde 200');
    comprobar(/script-src 'self'(;|$)/.test(csp) && !/unsafe-inline|unsafe-eval|\*/.test(csp), 'CSP: script-src solo \'self\', sin unsafe-inline ni unsafe-eval ni comodines', csp);
    comprobar(/style-src 'self'(;|$)/.test(csp), 'CSP: style-src solo \'self\' (sin estilos en linea)', csp);
    comprobar(/img-src 'self' data:(;|$)/.test(csp), 'CSP: img-src \'self\' data:', csp);
    comprobar(/connect-src 'self' https:\/\/[a-z0-9.-]+\.supabase\.co(;|$)/.test(cab['content-security-policy'] ? (JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value) : ''),
      'CSP (la de vercel.json): connect-src es el propio sitio y el dominio de Supabase, nada mas');
    comprobar(/frame-ancestors 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /form-action 'self'/.test(csp) && /object-src 'none'/.test(csp) && /default-src 'none'/.test(csp), 'CSP: frame-ancestors, base-uri, object-src y default-src en \'none\'; form-action \'self\'', csp);
    comprobar(cab['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY');
    comprobar(cab['referrer-policy'] === 'no-referrer', 'Referrer-Policy: no-referrer');
    comprobar(cab['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
    comprobar(cab['cache-control'] === 'no-store', 'Cache-Control: no-store');
    comprobar(/noindex/.test(cab['x-robots-tag'] || ''), 'X-Robots-Tag: noindex');
    for (const f of [...ARCHIVOS_PANTALLA, 'superadmin.css']) {
      const rr = await fetchOriginal(ORIGEN_SITIO + '/' + f);
      comprobar(rr.headers.get('cache-control') === 'no-store' && rr.headers.get('x-content-type-options') === 'nosniff' && /noindex/.test(rr.headers.get('x-robots-tag') || ''), `${f}: no-store, nosniff y noindex`);
    }
    const v = JSON.parse(fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
    const fuentes = v.headers.map((b) => b.source).sort();
    const esperadas = ['/superadmin.html', ...ARCHIVOS_PANTALLA.map((f) => '/' + f), '/superadmin.css'].sort();
    comprobar(JSON.stringify(fuentes) === JSON.stringify(esperadas), 'vercel.json: las cabeceras son SOLO para los archivos de la pantalla (ninguna otra ruta, ni /api, ni comodines)', fuentes.join(' '));
    const antes = JSON.parse(execGit(['show', 'HEAD:vercel.json']));
    comprobar(JSON.stringify(v.rewrites) === JSON.stringify(antes.rewrites) && JSON.stringify(v.redirects) === JSON.stringify(antes.redirects) && JSON.stringify(v.crons) === JSON.stringify(antes.crons) && JSON.stringify(v.functions) === JSON.stringify(antes.functions),
      'vercel.json: rewrites, redirects, crons y functions quedan EXACTAMENTE como estaban');
    for (const pagina of ['/index.html', '/pedido.html', '/panel.html', '/menu-admin.html', '/historial.html', '/sw.js']) {
      const rr = await fetchOriginal(ORIGEN_SITIO + pagina);
      comprobar(!rr.headers.get('content-security-policy') && !rr.headers.get('x-frame-options') && rr.headers.get('cache-control') === null, `${pagina}: no recibe ninguna de las cabeceras de la pantalla`);
    }
    const pub = fs.readFileSync(path.join(REPO, 'supabase-publico.js'), 'utf8');
    const urlSupabase = /url:\s*"([^"]+)"/.exec(pub)[1];
    comprobar(v.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value.includes(`connect-src 'self' ${urlSupabase};`), 'la CSP permite conectarse al MISMO Supabase que usa supabase-publico.js', urlSupabase);

    const html = fs.readFileSync(path.join(REPO, 'superadmin.html'), 'utf8');
    comprobar(/<meta name="robots" content="[^"]*noindex/.test(html), 'superadmin.html lleva la etiqueta noindex');
    comprobar(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html) && !/\sstyle\s*=/.test(html) && !/\son[a-z]+\s*=/i.test(html) && !/<style/i.test(html), 'superadmin.html: sin scripts, estilos ni manejadores en linea (la CSP los prohibe)');
    comprobar(!/<a\s/i.test(html) && !/<link[^>]+href="https?:/i.test(html) && !/<script[^>]+src="https?:/i.test(html), 'superadmin.html: sin enlaces ni recursos externos');

    // ningun otro archivo del sitio menciona la pantalla (ni paginas publicas, ni paneles, ni el service worker, ni los scripts comunes)
    const raiz = fs.readdirSync(REPO).filter((f) => /\.(html|js|json|css|webmanifest)$/.test(f) && fs.statSync(path.join(REPO, f)).isFile() && !f.startsWith('superadmin') && f !== 'vercel.json' && f !== 'package.json' && f !== 'package-lock.json');
    const menciones = raiz.filter((f) => /superadmin[.-](html|js|css|alta|detalle|lectura|inicio)|[/]superadmin(?![a-z])/i.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
    comprobar(menciones.length === 0, 'ninguna pagina publica, panel, script comun ni sw.js menciona a superadmin (sin enlaces desde afuera)', menciones.join(', '));
    const apis = fs.readdirSync(path.join(REPO, 'api')).filter((f) => f !== 'superadmin.js' && fs.statSync(path.join(REPO, 'api', f)).isFile() && /superadmin/i.test(fs.readFileSync(path.join(REPO, 'api', f), 'utf8')));
    const apisPantalla = fs.readdirSync(path.join(REPO, 'api')).filter((f) => fs.statSync(path.join(REPO, 'api', f)).isFile() && /superadmin[.]html|superadmin-(alta|detalle|lectura|inicio)|superadmin[.]css/.test(fs.readFileSync(path.join(REPO, 'api', f), 'utf8')));
    comprobar(apisPantalla.length === 0 && apis.every((f) => ['reembolso.js', '_auth-admin.js', '_sesion.js', '_supabase.js'].includes(f)), 'en api/ nadie nombra la pantalla; solo el servidor del superadmin y sus ayudas conocidas hablan de superadmin', apis.join(', ') + ' | ' + apisPantalla.join(', '));

    // reglas de codigo de la pantalla
    for (const f of ARCHIVOS_PANTALLA) {
      const cod = sinComentarios(fs.readFileSync(path.join(REPO, f), 'utf8'));
      const mal = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function/, /localStorage/, /document\.cookie/, /console\./, /sb_secret_/, /service_role(?!_key)/i, /\.setAttribute\(\s*["']style/, /\bstyle\s*=\s*["']/, /\$\{/, /["']srcdoc["']\s*:/, /createContextualFragment/, /DOMParser/, /\.html\s*=/]
        .filter((re) => re.test(cod)).map(String);
      comprobar(mal.length === 0, `${f}: sin innerHTML, eval, localStorage, cookies, console, plantillas ni la llave secreta`, mal.join(' '));
    }
  });

  /* ======================= 2. inicio de sesion ======================= */
  await escenario('2. Inicio de sesion: mensaje identico para contrasena mala, correo inexistente y usuario que no es superadmin', async () => {
    const pg = await pagina('login');
    await pg.ir(URL_PAGINA);
    await pg.existe('#sa-form-entrada');
    comprobar((await pg.eval(`document.title`)) === 'Administración · Rivo' && (await pg.eval(`document.querySelector('meta[name=robots]').content`)).includes('noindex'), 'la pagina se llama Administración · Rivo y lleva noindex');
    comprobar(await pg.eval(`document.getElementById('sa-clave').autocomplete==='current-password' && document.getElementById('sa-correo').type==='email'`), 'el formulario pide correo (type=email) y contrasena con autocomplete current-password');
    await capturarAmbos(pg, 'inicio-de-sesion');

    await iniciarSesion(pg, uSinFactor, 'una-clave-equivocada');
    await pg.esperar(`function(){return /No pudimos iniciar/.test(document.body.innerText)}`);
    const malaClave = (await pg.texto('#sa-entrada-msj')).trim();
    comprobar(malaClave === MSJ_GENERICO, 'contrasena equivocada: mensaje generico', malaClave);

    await pg.escribir('#sa-clave', ''); await pg.escribir('#sa-correo', 'no-existe-' + sfx + '@prueba-pantalla.example.com'); await pg.escribir('#sa-clave', CLAVE);
    await pg.clic('#sa-form-entrada button[type=submit]');
    await pg.esperar(`function(){return /No pudimos iniciar/.test(document.getElementById('sa-entrada-msj').textContent)}`);
    comprobar((await pg.texto('#sa-entrada-msj')).trim() === malaClave, 'correo inexistente: EXACTAMENTE el mismo mensaje');

    bitacoraApi.length = 0; bitacoraAuth.length = 0;
    await pg.escribir('#sa-correo', uDueno.email); await pg.escribir('#sa-clave', CLAVE);
    await pg.eval(`document.getElementById('sa-entrada-msj').textContent=''`);
    await pg.clic('#sa-form-entrada button[type=submit]');
    await pg.esperar(`function(){return /No pudimos iniciar/.test(document.getElementById('sa-entrada-msj').textContent)}`);
    comprobar((await pg.texto('#sa-entrada-msj')).trim() === malaClave, 'usuario valido que NO es superadmin (con la contrasena correcta): EXACTAMENTE el mismo mensaje, sin pistas');
    const a = await pg.almacenamiento();
    comprobar(a.sesion.length === 0 && a.local.length === 0, 'y no queda ninguna sesion guardada');
    comprobar(bitacoraAuth.some((x) => x.metodo === 'POST' && x.ruta.startsWith('/auth/v1/logout')), 'la sesion se cierra en Supabase (logout)');
    comprobar(llamadas('mi_estado').length === 1 && llamadas('mi_estado')[0].status === 403 && bitacoraApi.length === 1, 'solo se pidio mi_estado (403) y nada mas al servidor', JSON.stringify(bitacoraApi.map((x) => x.accion + ':' + x.status)));
    comprobar((await pg.eval('document.querySelector("#sa-capa-app").hidden')) && !(await pg.cuerpo()).includes('Restaurantes'), 'la capa de la aplicacion sigue oculta y vacia');

    inyectar.auth.push({ ruta: '/token?grant_type=password', status: 429, cuerpo: { code: 429, error_code: 'over_request_rate_limit', msg: 'rate' }, veces: 1 });
    await pg.escribir('#sa-correo', uSinFactor.email); await pg.escribir('#sa-clave', CLAVE);
    await pg.clic('#sa-form-entrada button[type=submit]');
    await pg.esperar(`function(){return /Demasiados intentos/.test(document.getElementById('sa-entrada-msj').textContent)}`);
    comprobar(true, '429 de Auth: aviso de demasiados intentos');

    inyectar.auth.push({ ruta: '/token?grant_type=password', cortar: true, veces: 4 });
    await pg.escribir('#sa-correo', uSinFactor.email); await pg.escribir('#sa-clave', CLAVE);
    await pg.clic('#sa-form-entrada button[type=submit]');
    await pg.esperar(`function(){return /No hay conexión/.test(document.getElementById('sa-entrada-msj').textContent)}`);
    comprobar(true, 'sin conexion con Auth: aviso claro');
    comprobar(await pg.eval(`document.getElementById('sa-clave').value===''`), 'la contrasena se borra del campo despues de cada intento');
    comprobar(await pg.eval('window.__pwn') === undefined && pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  /* ======================= 3. activar la verificacion en dos pasos ======================= */
  await escenario('3. Activar la MFA: QR (como imagen), clave en texto, codigo de 6 digitos', async () => {
    const pg = await pagina('mfa-alta');
    await pg.ir(URL_PAGINA);
    await pg.existe('#sa-form-entrada');
    await iniciarSesion(pg, uSinFactor);
    await pg.existe('#sa-codigo-alta');
    const cuerpo = await pg.cuerpo();
    comprobar(/Google Authenticator/.test(cuerpo) && /Microsoft Authenticator/.test(cuerpo) && /Authy/.test(cuerpo), 'explica que app instalar (Google Authenticator, Microsoft Authenticator o Authy) y por que');
    comprobar(/puede ver y cambiar todos los restaurantes/.test(cuerpo), 'explica por que hace falta el segundo paso');
    const img = await pg.eval(`(function(){var i=document.querySelector('img.sa-qr');return i?{src:i.getAttribute('src').slice(0,40),alt:i.alt}:null})()`);
    comprobar(img && /^data:image\/svg\+xml/.test(img.src) && img.alt, 'el QR es un <img> con el SVG de Supabase en un data URI (con texto alternativo)', JSON.stringify(img));
    comprobar(await pg.eval(`document.querySelectorAll('svg').length===0`), 'el SVG NUNCA se inyecta como HTML en la pagina');
    const clave = (await pg.texto('#sa-clave-texto')).trim();
    comprobar(/^[A-Z2-7]{16,64}$/.test(clave), 'la clave para copiar a mano esta en texto (base32)', clave);
    const cod = await pg.eval(`(function(){var c=document.getElementById('sa-codigo-alta');return {a:c.autocomplete,m:c.inputMode,max:c.maxLength}})()`);
    comprobar(cod.a === 'one-time-code' && cod.m === 'numeric' && cod.max === 6, 'campo del codigo: autocomplete one-time-code, teclado numerico, 6 digitos', JSON.stringify(cod));
    await pg.clic('.sa-btn:not(.sa-btn-primario)');
    comprobar((await pg.eval('window.__copiado')).includes(clave), '"Copiar clave" copia la clave');
    await capturarAmbos(pg, 'mfa-activar-con-qr');
    uSinFactor.secreto = clave;

    await pg.escribir('#sa-codigo-alta', '12ab');
    comprobar(await pg.eval(`document.getElementById('sa-codigo-alta').value`) === '12', 'el campo solo acepta numeros');
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){return /6 números/.test(document.body.innerText)}`);
    comprobar(true, 'un codigo corto se rechaza en la pantalla (sin llamar a Auth)');
    comprobar(llamadas('listar_restaurantes').length === 0, 'mientras tanto el servidor no recibio ninguna accion de administracion');

    await pg.escribir('#sa-codigo-alta', clave === uSinFactor.secreto ? (codigo(uSinFactor) === '000000' ? '111111' : '000000') : '000000');
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){return /no es correcto/.test(document.body.innerText)}`);
    comprobar(await pg.eval(`document.getElementById('sa-codigo-alta').value===''`), 'un codigo malo se rechaza con un mensaje claro y el campo se limpia');

    await pg.escribir('#sa-codigo-alta', codigo(uSinFactor));
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){var h=document.querySelector('#sa-capa-app h1');return !document.querySelector('#sa-capa-app').hidden&&h&&h.textContent==='Restaurantes'}`, 8000, 'la lista tras activar la MFA');
    comprobar(true, 'con el codigo correcto se activa la MFA y se carga la lista');
    const cuerpo2 = await pg.cuerpo(); const dom = await pg.eval('document.documentElement.outerHTML');
    comprobar(!dom.includes(clave) && !cuerpo2.includes(clave), 'la clave del QR desaparece del DOM al terminar');
    comprobar(await pg.eval(`document.querySelectorAll('img.sa-qr').length===0`), 'y el QR tambien');
    const a = await pg.almacenamiento();
    comprobar(a.local.length === 0 && a.sesion.length === 1 && a.sesion[0][0] === 'sa-sesion-v1' && a.cookie === '' && !/token|access|eyJ/.test(a.url), 'la sesion solo vive en sessionStorage (nada en localStorage, cookies ni URL)', JSON.stringify({ l: a.local.length, s: a.sesion.map((x) => x[0]), c: a.cookie, u: a.url }));
    const todo = JSON.stringify(a) + dom + pg.consola.join('\n');
    comprobar(!todo.includes(clave) && !todo.includes(CLAVE), 'ni la clave del QR ni la contrasena aparecen en ningun almacenamiento, en el DOM ni en la consola');
    const consolaReal = pg.consola.filter((c) => !c.startsWith('log-verbose') && !(c.includes('status of 400') && c.endsWith('verify')));   // el 400 del codigo malo que se mando a proposito
    comprobar(consolaReal.length === 0 && pg.errores.length === 0, 'la consola esta vacia (sin errores, ni avisos, ni CSP bloqueando algo; salvo el 400 del codigo malo que mandamos a proposito)', consolaReal.concat(pg.errores).join(' ; '));
    const s = await leerSesion(pg);
    const factores = await auth('/user', undefined, s.access, 'GET');
    comprobar(factores.json.factors && factores.json.factors.some((f) => f.status === 'verified'), 'en Auth el usuario ya tiene un factor verificado');
    comprobar(factores.json.factors.length === 1, "los factores a medio activar de intentos anteriores se borran antes de enrolar: queda uno solo", JSON.stringify(factores.json.factors));

  });

  /* ======================= 4. entrar con el codigo (el usuario ya tiene su app) ======================= */
  await escenario('4. Pedir el codigo de la app: campo numerico, rechazo de malos y nada de administracion antes de aal2', async () => {
    const pg = await pagina('mfa-codigo');
    await pg.ir(URL_PAGINA);
    await pg.existe('#sa-form-entrada');
    await iniciarSesion(pg, uMfa);
    await pg.existe('#sa-codigo');
    const c = await pg.eval(`(function(){var c=document.getElementById('sa-codigo');return {a:c.autocomplete,m:c.inputMode,max:c.maxLength,p:c.pattern}})()`);
    comprobar(c.a === 'one-time-code' && c.m === 'numeric' && c.max === 6 && c.p === '[0-9]{6}', 'campo del codigo: one-time-code, numerico, 6 digitos', JSON.stringify(c));
    comprobar(/Perdí mi celular/.test(await pg.cuerpo()), 'ofrece "Perdí mi celular"');
    await capturarAmbos(pg, 'codigo');
    await pg.escribir('#sa-codigo', '123456');
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){return /no es correcto o ya venció/.test(document.body.innerText)}`);
    comprobar(true, 'un codigo malo se rechaza y el campo queda vacio: ' + (await pg.eval(`document.getElementById('sa-codigo').value===''`)));
    comprobar(bitacoraApi.every((x) => x.accion === 'mi_estado'), 'antes de aal2 solo se le pregunto mi_estado al servidor', bitacoraApi.map((x) => x.accion).join(','));
    await pg.escribir('#sa-codigo', codigo(uMfa));
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){var h=document.querySelector('#sa-capa-app h1');return !document.querySelector('#sa-capa-app').hidden&&h&&h.textContent==='Restaurantes'}`, 8000, 'la lista');
    comprobar(llamadas('mi_estado').length >= 2 && llamadas('mi_estado').some((x) => x.status === 200), 'con el codigo bueno entra (mi_estado confirma aal2)');
    comprobar(llamadas('listar_restaurantes').length >= 1 && llamadas('listar_restaurantes').every((x) => x.status === 200), 'la lista solo se pide DESPUES de aal2 y responde 200');
    // Pantalla de perdida del celular
    const pg2 = await pagina('perdida');
    await pg2.ir(URL_PAGINA); await pg2.existe('#sa-form-entrada'); await iniciarSesion(pg2, uMfa2); await pg2.existe('#sa-codigo');
    await pg2.clicTexto('Perdí mi celular');
    await pg2.esperar(`function(){return /quitar-mfa\\.mjs/.test(document.body.innerText)}`);
    const t = await pg2.cuerpo();
    comprobar(/no se puede hacer desde esta pantalla/i.test(t) && /--confirmar/.test(t) && /Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY/.test(t) && /Read-Host/.test(t), 'pantalla de perdida del celular: explica el script de operador con los pasos de la seccion 23');
    await capturarAmbos(pg2, 'perdi-mi-celular');
    await pg2.clicTexto('Volver');
    await pg2.existe('#sa-codigo');
    comprobar(true, '"Volver" regresa a la pantalla del codigo');
  });

  /* ======================= 5. a mitad de sesion ======================= */
  await escenario('5. mfa_requerida a mitad de sesion: vuelve al codigo SIN reintentar en bucle', async () => {
    const pg = await pagina('mid-mfa');
    await entrarConCodigo(pg, uMfa);
    bitacoraApi.length = 0;
    inyectar.api.push({ accion: 'listar_restaurantes', status: 403, cuerpo: { error: 'Activa o confirma la verificación en dos pasos', codigo: 'mfa_requerida', aal: 'aal1' }, veces: 1 });
    await pg.clicTexto('Actualizar');
    await pg.existe('#sa-codigo');
    comprobar(/código de tu app/.test(await pg.cuerpo()), 'aparece la pantalla del codigo con una explicacion');
    const n1 = bitacoraApi.length;
    await sleep(1500);
    comprobar(bitacoraApi.length === n1 && n1 === 1, 'no se vuelve a llamar a la API mientras se pide el codigo (1 sola llamada, sin bucle)', 'llamadas: ' + bitacoraApi.map((x) => x.accion + ':' + x.status).join(','));
    comprobar(await pg.eval(`document.querySelector('#sa-capa-app').hidden`), 'la aplicacion queda oculta mientras tanto');
    await pg.escribir('#sa-codigo', codigo(uMfa));
    await pg.clic('form button[type=submit]');
    await pg.esperar(`function(){return !document.querySelector('#sa-capa-app').hidden&&document.querySelector('#sa-capa-app h1').textContent==='Restaurantes'}`, 8000);
    comprobar(true, 'con el codigo vuelve a la aplicacion');
    comprobar(llamadas('listar_restaurantes').some((x) => x.status === 200), 'y la lista se vuelve a cargar');
  });

  await escenario('6. 401 a mitad de sesion: al inicio de sesion, y todo se limpia', async () => {
    const pg = await pagina('mid-401');
    await entrarConCodigo(pg, uMfa);
    inyectar.api.push({ accion: 'listar_restaurantes', status: 401, cuerpo: { error: 'Inicia sesión para continuar' }, veces: 1 });
    await pg.clicTexto('Actualizar');
    await pg.existe('#sa-form-entrada');
    comprobar(/venció/.test(await pg.cuerpo()), 'vuelve al inicio de sesion con el aviso "tu sesión venció"');
    const a = await pg.almacenamiento();
    comprobar(a.sesion.length === 0 && a.local.length === 0, 'sessionStorage queda vacio');
    comprobar(await pg.eval(`document.getElementById('sa-contenido').children.length===0`), 'la lista se borra de la pantalla');
    comprobar(bitacoraAuth.some((x) => x.ruta.startsWith('/auth/v1/logout')), 'y se pide a Supabase cerrar esa sesion');
  });

  await escenario('7. 429: aviso, no se insiste y se reanuda al pasar la espera', async () => {
    const pg = await pagina('mid-429');
    await entrarConCodigo(pg, uMfa);
    bitacoraApi.length = 0;
    inyectar.api.push({ accion: 'listar_restaurantes', status: 429, cuerpo: { error: 'Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.' }, headers: { 'Retry-After': '3' }, veces: 1 });
    await pg.clicTexto('Actualizar');
    await pg.esperar(`function(){return /Demasiados intentos/.test(document.getElementById('sa-aviso').textContent)&&!document.getElementById('sa-aviso').hidden}`);
    comprobar(true, 'se muestra el aviso de espera');
    await sleep(200);
    await pg.clicTexto('Actualizar');
    await sleep(300);
    comprobar(bitacoraApi.length === 1, 'mientras dura la espera NO se vuelve a llamar al servidor', bitacoraApi.length + ' llamadas');
    comprobar(/Espera \d+ segundos/.test(await pg.cuerpo()), 'y se le dice cuantos segundos esperar');
    await sleep(3200);
    await pg.clicTexto('Actualizar');
    await sleep(500);
    comprobar(bitacoraApi.length === 2 && bitacoraApi[1].status === 200, 'pasada la espera vuelve a funcionar');
  });

  await escenario('8. Sesion: recarga la pagina, cerrar sesion limpia todo y el token deja de servir', async () => {
    const pg = await pagina('sesion');
    await entrarConCodigo(pg, uMfa);
    const antes = await leerSesion(pg);
    await pg.ir(URL_PAGINA);
    await pg.esperar(`function(){var h=document.querySelector('#sa-capa-app h1');return !document.querySelector('#sa-capa-app').hidden&&h&&h.textContent==='Restaurantes'}`, 8000, 'recuperar la sesion');
    comprobar(true, 'al recargar recupera la sesion de sessionStorage sin pedir contrasena (mi_estado confirma aal2)');
    comprobar(!(await pg.cuerpo()).includes('Entrar'), 'no muestra el formulario de acceso');
    await pg.clicTexto('Cerrar sesión');
    await pg.existe('#sa-form-entrada');
    const a = await pg.almacenamiento();
    comprobar(a.sesion.length === 0 && a.local.length === 0 && a.cookie === '', 'cerrar sesion: sessionStorage, localStorage y cookies quedan vacios');
    comprobar(await pg.eval(`document.getElementById('sa-contenido').children.length===0 && document.getElementById('sa-capa-app').hidden`), 'la aplicacion se vacia y se oculta');
    const viejo = await auth('/user', undefined, antes.access, 'GET');
    comprobar(viejo.status === 401, 'el token anterior ya no sirve en Supabase (logout real)', 'status ' + viejo.status);
    const r = await fetchOriginal(ORIGEN_SITIO + '/api/superadmin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + antes.access }, body: JSON.stringify({ accion: 'mi_estado' }) });
    comprobar(r.status === 401, 'y el servidor del superadmin tambien lo rechaza (401)');
    comprobar(/Cerraste sesión/.test(await pg.cuerpo()), 'avisa que cerraste sesion');
  });

  /*FIN-ESCENARIOS*/

  // ---- resumen ----
  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length} PASAN, ${fallas.length} FALLAN.`);
  try { await cdp.send('Browser.close'); } catch (e) { /* ya cerrado */ }
  chrome.kill(); sitio.close(); await falso.cerrar();
  try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) { /* en uso */ }
  process.exitCode = fallas.length ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
})().catch((e) => { console.error(e); process.exit(2); });
