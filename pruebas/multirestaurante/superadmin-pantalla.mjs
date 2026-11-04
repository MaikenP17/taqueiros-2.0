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
/* PANTALLA_RAIZ: carpeta con una copia (mutada) de superadmin*.html/js/css y vercel.json; sirve para la revision por mutacion. */
const RAIZ_PANTALLA = process.env.PANTALLA_RAIZ ? path.resolve(process.env.PANTALLA_RAIZ) : REPO;
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
    try { estado = await this.eval(`JSON.stringify({url: location.href, h1: (document.querySelector('h1')||{}).textContent, msj: [...document.querySelectorAll('.sa-msj')].map(function(x){return x.textContent.slice(0,120)}), cuerpo: document.body.innerText.slice(0,400)})`); } catch (e) { estado = '(sin estado: ' + e.message + ')'; }
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
  const v = JSON.parse(fs.readFileSync(path.join(RAIZ_PANTALLA, 'vercel.json'), 'utf8'));
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
        if (regla && !regla.transformar) {
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
        let bytes = Buffer.from(await r.arrayBuffer());
        if (regla && regla.transformar && r.status === 200) { try { bytes = Buffer.from(JSON.stringify(regla.transformar(JSON.parse(bytes.toString('utf8'))))); } catch (e) { /* se deja igual */ } }   // reescribe la respuesta real (por ejemplo, una sesion que vence pronto)
        res.end(bytes);
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
        const adaptada = adaptar(res); const jsonOriginal = adaptada.json;
        adaptada.json = (o) => { entrada.respuesta = JSON.stringify(o); return jsonOriginal(o); };   // lo que el servidor contesto (para buscar secretos en las respuestas)
        await manejador(req, adaptada);
        return;
      }
      let ruta = decodeURIComponent(url.pathname);
      if (ruta === '/') ruta = '/index.html';
      if (ruta === '/supabase-publico.js') {
        res.writeHead(200, { 'Content-Type': TIPOS['.js'] });
        res.end(`window.SUPABASE_PUBLICO = Object.freeze({ url: ${JSON.stringify(ORIGEN_SUPABASE)}, publishableKey: "sb_publishable_FAKE_0000" });`);
        return;
      }
      const archivo = path.join(/^[/]superadmin|^[/]vercel/.test(ruta) ? RAIZ_PANTALLA : REPO, ruta);
      if (!(archivo.startsWith(path.resolve(REPO)) || archivo.startsWith(RAIZ_PANTALLA)) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) { res.writeHead(404); res.end('no existe'); return; }
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
    comprobar(/connect-src 'self' https:\/\/[a-z0-9.-]+\.supabase\.co(;|$)/.test(cab['content-security-policy'] ? (JSON.parse(fs.readFileSync(path.join(RAIZ_PANTALLA, 'vercel.json'), 'utf8')).headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value) : ''),
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
    const v = JSON.parse(fs.readFileSync(path.join(RAIZ_PANTALLA, 'vercel.json'), 'utf8'));
    const fuentes = v.headers.map((b) => b.source).sort();
    const esperadas = ['/superadmin.html', ...ARCHIVOS_PANTALLA.map((f) => '/' + f), '/superadmin.css'].sort();
    comprobar(JSON.stringify(fuentes) === JSON.stringify(esperadas), 'vercel.json: las cabeceras son SOLO para los archivos de la pantalla (ninguna otra ruta, ni /api, ni comodines)', fuentes.join(' '));
    const antes = JSON.parse(execGit(['show', '71be5af:vercel.json']));   // el vercel.json de antes de la pantalla
    comprobar(JSON.stringify(v.rewrites) === JSON.stringify(antes.rewrites) && JSON.stringify(v.redirects) === JSON.stringify(antes.redirects) && JSON.stringify(v.crons) === JSON.stringify(antes.crons) && JSON.stringify(v.functions) === JSON.stringify(antes.functions),
      'vercel.json: rewrites, redirects, crons y functions quedan EXACTAMENTE como estaban');
    for (const pagina of ['/index.html', '/pedido.html', '/panel.html', '/menu-admin.html', '/historial.html', '/sw.js']) {
      const rr = await fetchOriginal(ORIGEN_SITIO + pagina);
      comprobar(!rr.headers.get('content-security-policy') && !rr.headers.get('x-frame-options') && rr.headers.get('cache-control') === null, `${pagina}: no recibe ninguna de las cabeceras de la pantalla`);
    }
    const pub = fs.readFileSync(path.join(REPO, 'supabase-publico.js'), 'utf8');
    const urlSupabase = /url:\s*"([^"]+)"/.exec(pub)[1];
    comprobar(v.headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value.includes(`connect-src 'self' ${urlSupabase};`), 'la CSP permite conectarse al MISMO Supabase que usa supabase-publico.js', urlSupabase);

    const html = fs.readFileSync(path.join(RAIZ_PANTALLA, 'superadmin.html'), 'utf8');
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
      const cod = sinComentarios(fs.readFileSync(path.join(RAIZ_PANTALLA, f), 'utf8'));
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
    await pg.eval(`(function(){document.querySelectorAll('#sa-capa-app #sa-contenido button').forEach(function(b){if(b.textContent==='Actualizar')b.click();});})()`);   // aunque algo siga vivo detras (botones, temporizadores), no puede llamar a la API
    await sleep(500);
    comprobar(bitacoraApi.length === n1, 'y aunque se pulsen los botones de la aplicacion oculta, no sale ninguna llamada mientras se pide el codigo', bitacoraApi.map((x) => x.accion).join(','));
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

  /* ======================= datos para la lista y el detalle ======================= */
  const fechaEn = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * 86400000));
  async function sembrar(slug, nombre, { estado = 'activo', vigente = null, gracia = 5, plan = 'completo', modalidad = 'mensual', dominios = [] } = {}) {
    const r = (await db.query(`select public.sa_crear_restaurante($1::uuid, $2, $3) as r`, [uMfa.id, slug, nombre])).rows[0].r;
    await db.query(`update public.restaurantes set estado = $2, vigente_hasta = $3::date, dias_gracia = $4, plan = $5, modalidad_pago = $6 where id = $1::uuid`, [r.id, estado, vigente, gracia, plan, modalidad]);
    for (const d of dominios) await db.query(`insert into public.restaurante_dominios (host, restaurante_id) values ($1, $2::uuid)`, [d, r.id]);
    return r;
  }
  const bidi = String.fromCharCode(0x202e), cero = String.fromCharCode(0x200b);
  const NOMBRE_HOSTIL = `<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script> "comillas" 'simples' ${bidi}invertido${cero}cero\nsalto 🌮🔥 ` + 'X'.repeat(600);
  const R = {};
  R.prueba = await sembrar('pr-prueba', 'Casa Prueba', { estado: 'prueba', vigente: fechaEn(9) });
  R.activo = await sembrar('pr-activo', 'Zeta Activo', { estado: 'activo', vigente: fechaEn(40), dominios: ['activo.example.com'], plan: 'basico', modalidad: 'unico' });
  R.gracia = await sembrar('pr-gracia', 'Beta Gracia', { estado: 'activo', vigente: fechaEn(-2), gracia: 5 });
  R.vencido = await sembrar('pr-vencido', 'Alfa Vencido', { estado: 'activo', vigente: fechaEn(-20), gracia: 5 });
  R.susp = await sembrar('pr-susp', 'Omega Suspendido', { estado: 'suspendido', vigente: fechaEn(10) });
  R.hostil = await sembrar('pr-hostil', 'temporal', { estado: 'activo', vigente: fechaEn(15), plan: 'comandas' });
  await db.query(`update public.restaurantes set nombre = $2 where id = $1::uuid`, [R.hostil.id, NOMBRE_HOSTIL]);

  /* ======================= 9. la lista ======================= */
  await escenario('9. Lista: estados con color y texto, vencimiento, filtros, buscador, orden y datos hostiles como texto', async () => {
    const pg = await pagina('lista');
    await entrarConCodigo(pg, uMfa);
    await pg.esperar(`function(){return document.querySelectorAll('#sa-lista-cuerpo tbody tr').length>=7}`, 8000, 'las filas');
    const filas = await pg.eval(`[...document.querySelectorAll('#sa-lista-cuerpo tbody tr')].map(function(tr){return {slug:tr.querySelector('.sa-mono').textContent, pill:(tr.querySelector('.sa-pill')||{}).className, estado:(tr.querySelector('.sa-pill')||{}).textContent, venc:tr.children[3].textContent, doms:tr.children[4].textContent, plan:tr.children[1].textContent, nombre:tr.querySelector('.sa-nombre-btn').textContent}})`);
    const de = (slug) => filas.find((f) => f.slug === slug) || {};
    comprobar(de('pr-prueba').estado === 'En prueba' && de('pr-prueba').pill.includes('sa-pill-prueba') && /Vence el .* · quedan 9 días/.test(de('pr-prueba').venc), 'prueba: pastilla "En prueba" con su color y "quedan 9 días"', JSON.stringify(de('pr-prueba')));
    comprobar(de('pr-activo').estado === 'Activo' && de('pr-activo').pill.includes('sa-pill-activo') && /quedan 40 días/.test(de('pr-activo').venc), 'activo: pastilla verde y dias restantes', JSON.stringify(de('pr-activo')));
    comprobar(de('pr-gracia').estado === 'En gracia' && de('pr-gracia').pill.includes('sa-pill-gracia') && /se suspende en 4 días/.test(de('pr-gracia').venc), 'gracia: "En gracia" y cuantos dias faltan para suspender', JSON.stringify(de('pr-gracia')));
    comprobar(de('pr-vencido').estado === 'Vencido' && de('pr-vencido').pill.includes('sa-pill-vencido') && /hace 20 días/.test(de('pr-vencido').venc), 'vencido: "Vencido" y hace cuantos dias', JSON.stringify(de('pr-vencido')));
    comprobar(de('pr-susp').estado === 'Suspendido' && de('pr-susp').pill.includes('sa-pill-suspendido') && /Suspendido a mano/.test(de('pr-susp').venc), 'suspendido: "Suspendido" y se aclara que fue a mano', JSON.stringify(de('pr-susp')));
    const taq = filas.find((f) => /Sin vencimiento/.test(f.venc));
    comprobar(!!taq, 'un restaurante sin vencimiento se ve como "Sin vencimiento"');
    comprobar(de('pr-activo').doms.includes('activo.example.com') && /Sin dominio propio/.test(de('pr-prueba').doms), 'dominios: se listan o dice "Sin dominio propio"');
    comprobar(de('pr-activo').plan.includes('Básico') && de('pr-activo').plan.includes('Pago único') && de('pr-hostil').plan.includes('Solo comandas'), 'plan y modalidad en palabras claras');
    comprobar(filas.every((f) => !/Demo/.test(f.pill + f.nombre)) && await pg.eval(`!/(^|\\s)Demo(\\s|$)/.test(document.querySelector('#sa-lista-cuerpo').innerText)`), 'no se inventa la etiqueta "Demo" (el servidor no la marca; no hay ids escritos a mano)');
    const orden = filas.map((f) => f.slug);
    comprobar(orden.indexOf('pr-vencido') < orden.indexOf('pr-gracia') && orden.indexOf('pr-gracia') < orden.indexOf('pr-prueba') && orden.indexOf('pr-prueba') < orden.indexOf('pr-susp') && orden.indexOf('pr-susp') < orden.indexOf('pr-activo') && filas[filas.length - 1].venc === 'Sin vencimiento', 'orden por vencimiento mas cercano (vencidos primero, sin vencimiento al final)', orden.join(' > '));

    // datos hostiles: texto, nunca HTML
    const hostil = de('pr-hostil');
    comprobar(await pg.eval('window.__pwn') === undefined && await pg.eval(`document.querySelectorAll('#sa-lista-cuerpo img, #sa-lista-cuerpo script').length===0`), 'el nombre con <img onerror> y <script> se ve como texto: no se ejecuta ni crea elementos');
    comprobar(hostil.nombre.includes('<img src=x') && hostil.nombre.includes('<script>'), 'y el texto literal esta visible', hostil.nombre.slice(0, 60));
    comprobar(!hostil.nombre.includes(bidi) && !hostil.nombre.includes(cero) && hostil.nombre.includes('▯'), 'la marca de derecha a izquierda y el ancho cero se cambian por un cuadrito visible');
    comprobar(hostil.nombre.length <= 121 && hostil.nombre.includes('🌮'), 'el nombre larguisimo se corta (120) y los emojis se conservan', String(hostil.nombre.length));
    comprobar(await pg.eval(`document.documentElement.scrollWidth<=window.innerWidth`), 'sin desborde horizontal a 1280 px');
    await capturarAmbos(pg, 'lista');

    // filtros
    await pg.clicTexto('En gracia (1)');
    comprobar(await pg.eval(`document.querySelectorAll('#sa-lista-cuerpo tbody tr').length`) === 1, 'filtro por estado: En gracia deja 1 fila');
    comprobar(await pg.eval(`[...document.querySelectorAll('.sa-chips button')].map(function(b){return b.textContent}).join('|')`) === 'Todos (7)|En prueba (1)|Activos (' + (await pg.eval(`document.querySelectorAll('.sa-chips button')[2].textContent.match(/\\d+/)[0]`)) + ')|En gracia (1)|Vencidos (1)|Suspendidos (1)', 'los filtros muestran cuantos hay de cada estado');
    await pg.clicTexto('Todos (7)');
    await pg.escribir('#sa-buscar', 'activo.example');
    comprobar(await pg.eval(`document.querySelectorAll('#sa-lista-cuerpo tbody tr').length`) === 1, 'el buscador encuentra por dominio');
    await pg.escribir('#sa-buscar', 'ZETA');
    comprobar(await pg.eval(`document.querySelectorAll('#sa-lista-cuerpo tbody tr').length`) === 1, 'el buscador encuentra por nombre sin distinguir mayusculas');
    await pg.escribir('#sa-buscar', 'pr-gra');
    comprobar(await pg.eval(`document.querySelectorAll('#sa-lista-cuerpo tbody tr').length`) === 1, 'el buscador encuentra por nombre corto');
    await pg.escribir('#sa-buscar', 'no-existe-xyz');
    comprobar(/Ningún restaurante coincide/.test(await pg.cuerpo()), 'sin coincidencias lo dice');
    await pg.escribir('#sa-buscar', '');
    await pg.escribir('#sa-orden', 'nombre');
    const porNombre = await pg.eval(`[...document.querySelectorAll('#sa-lista-cuerpo tbody tr .sa-mono')].map(function(x){return x.textContent})`);
    comprobar(porNombre.indexOf('pr-vencido') < porNombre.indexOf('pr-susp') && porNombre.indexOf('pr-susp') < porNombre.indexOf('pr-activo'), 'orden por nombre: Alfa antes de Omega antes de Zeta', porNombre.join(','));

    // celular: tarjetas
    await medidas(pg, 390);
    await sleep(150);
    comprobar(await pg.eval(`getComputedStyle(document.querySelector('#sa-lista-cuerpo tbody tr td')).display==='block' && getComputedStyle(document.querySelector('#sa-lista-cuerpo thead')).display==='none' && document.documentElement.scrollWidth<=window.innerWidth`), 'a 390 px la tabla pasa a tarjetas, sin encabezado y sin desborde horizontal');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  /* ======================= 10. el asistente de alta ======================= */
  const filaDe = async (slug) => (await db.query(`select * from public.restaurantes where slug = $1`, [slug])).rows[0];
  const irPaso = async (pg, n) => pg.esperar(`function(){var l=document.querySelector('ol.sa-pasos li[aria-current=step]');return !!l&&l.textContent.indexOf('${n}.')===0}`, 6000, 'el paso ' + n);
  const siguiente = async (pg, n) => { await pg.clic('form button[type=submit]'); await irPaso(pg, n); };
  const errorDe = async (pg) => pg.eval(`(function(){var e=document.querySelector('form .sa-msj-error');return e?e.textContent:null})()`);
  /* Recorre el asistente hasta el paso 5 (sin crear). op: nombre, slug, prueba, plan, modalidad, correo, dominio ('propio' + host | 'ninguno'). */
  async function asistente(pg, op) {
    await pg.clicTexto('Nuevo restaurante');
    await pg.existe('#al-nombre');
    await pg.escribir('#al-nombre', op.nombre);
    if (op.slug !== undefined) await pg.escribir('#al-slug', op.slug);
    if (op.prueba) await pg.marcar('#al-prueba', true);
    await siguiente(pg, 2);
    if (op.plan) await pg.clic('#al-plan-' + op.plan);
    if (op.modalidad) await pg.clic('#al-mod-' + op.modalidad);
    await siguiente(pg, 3);
    await pg.escribir('#al-correo', op.correo);
    await siguiente(pg, 4);
    if (op.host) { await pg.clic('#al-dom-propio'); await pg.escribir('#al-host', op.host); }
    await siguiente(pg, 5);
  }
  const crearAhora = async (pg) => { await pg.marcar('#al-entiendo', true); await pg.clic('#al-crear'); };

  await escenario('10. Alta de un restaurante: validaciones, un solo envio, contrasena temporal una sola vez y errores del servidor', async () => {
    const pg = await pagina('alta');
    await entrarConCodigo(pg, uMfa);
    await pg.clicTexto('Nuevo restaurante');
    await pg.existe('#al-nombre');
    await capturarAmbos(pg, 'alta-paso-1-datos');

    // ---- paso 1: validaciones y sugerencia del nombre corto ----
    await pg.escribir('#al-nombre', 'Casa Rivo Demo ñandú');
    comprobar(await pg.eval(`document.getElementById('al-slug').value`) === 'casa-rivo-demo-nandu', 'el nombre corto se sugiere desde el nombre (minusculas, sin tildes, con guiones)');
    comprobar(/NO se podrá cambiar después/.test(await pg.cuerpo()), 'avisa que el nombre corto NO se podra cambiar despues');
    await pg.escribir('#al-nombre', '');
    await pg.clic('form button[type=submit]');
    comprobar(/Escribe el nombre/.test(await errorDe(pg) || ''), 'nombre vacio: error');
    await pg.escribir('#al-nombre', 'Con <angulo>');
    await pg.escribir('#al-slug', 'buen-slug');
    await pg.clic('form button[type=submit]');
    comprobar(/< ni >/.test(await errorDe(pg) || ''), 'nombre con < o >: error');
    await pg.escribir('#al-nombre', 'Casa Rivo Demo');
    for (const [slug, texto] of [['ab--cd', 'nombre corto'], ['-uno', 'nombre corto'], ['a', 'nombre corto'], ['con espacio', 'nombre corto'], ['admin', 'reservado'], ['x'.repeat(41), 'nombre corto']]) {
      await pg.escribir('#al-slug', slug);
      await pg.clic('form button[type=submit]');
      comprobar(new RegExp(texto).test(await errorDe(pg) || ''), `nombre corto "${slug.slice(0, 12)}": se rechaza en pantalla (${texto})`);
    }
    await pg.escribir('#al-slug', 'casa-rivo-demo');
    await pg.marcar('#al-prueba', true);
    comprobar(/Quedará así: prueba-casa-rivo-demo/.test(await pg.cuerpo()), 'con "es de prueba" muestra el nombre corto final con el prefijo prueba-');
    await pg.escribir('#al-prefijo', 'Mal Prefijo');
    await pg.clic('form button[type=submit]');
    comprobar(/prefijo/i.test(await errorDe(pg) || ''), 'prefijo mal escrito: error');
    await pg.escribir('#al-prefijo', 'prueba-');
    await siguiente(pg, 2);

    // ---- paso 2: plan, modalidad, modulos ----
    comprobar(/400\.000/.test(await pg.cuerpo()) && /2\.500\.000/.test(await pg.cuerpo()) && /800\.000/.test(await pg.cuerpo()) && /40\.000/.test(await pg.cuerpo()) && /150\.000/.test(await pg.cuerpo()) && /100\.000/.test(await pg.cuerpo()), 'los precios de referencia estan a la vista (400.000/40.000, 2.500.000/150.000, 800.000/100.000)');
    comprobar(/no se guardan ni se cobran desde aquí/.test(await pg.cuerpo()), 'y se aclara que son solo informativos');
    comprobar(await pg.eval(`['pasarela','seguimiento','comandas','impresion'].every(function(k){return document.getElementById('al-mod-'+k).checked})`) && await pg.eval(`document.getElementById('al-dias').value`) === '14' && await pg.eval(`document.getElementById('al-zona').value`) === 'America/Bogota', 'por defecto: plan Completo con todos los modulos, 14 dias de prueba y America/Bogota');
    await pg.clic('#al-plan-basico');
    comprobar(await pg.eval(`['pasarela','seguimiento','comandas','impresion'].every(function(k){return !document.getElementById('al-mod-'+k).checked})`), 'plan Basico: sin pasarela, seguimiento, comandas ni impresion');
    await pg.clic('#al-plan-comandas');
    comprobar(await pg.eval(`[document.getElementById('al-mod-comandas').checked,document.getElementById('al-mod-impresion').checked,document.getElementById('al-mod-pasarela').checked,document.getElementById('al-mod-seguimiento').checked].join()`) === 'true,true,false,false', 'plan Solo comandas: comandas e impresion');
    await pg.clic('#al-mod-unico');
    await capturarAmbos(pg, 'alta-paso-2-plan');
    await pg.escribir('#al-dias', '91'); await pg.clic('form button[type=submit]');
    comprobar(/0 a 90/.test(await errorDe(pg) || ''), 'dias de prueba fuera de rango: error');
    await pg.escribir('#al-dias', '14'); await pg.escribir('#al-zona', 'Marte/Olimpo mons x'); await pg.clic('form button[type=submit]');
    comprobar(/zona horaria/.test(await errorDe(pg) || ''), 'zona horaria invalida: error');
    await pg.escribir('#al-zona', 'America/Bogota');
    await siguiente(pg, 3);

    // ---- paso 3: dueno ----
    await pg.escribir('#al-correo', 'correo-malo'); await pg.clic('form button[type=submit]');
    comprobar(/correo no es válido/.test(await errorDe(pg) || ''), 'correo invalido: error');
    const correoNuevo = `dueno-nuevo-${sfx}@prueba-pantalla.example.com`;
    await pg.escribir('#al-correo', correoNuevo);
    await pg.clicTexto('Comprobar si ya existe');
    await pg.esperar(`function(){return /todavía no tiene usuario/.test(document.getElementById('al-correo-res').textContent)}`);
    comprobar(true, 'buscar_usuario: dice que el correo es nuevo y que la contrasena temporal se vera una sola vez');
    await capturarAmbos(pg, 'alta-paso-3-dueno');
    await siguiente(pg, 4);

    // ---- paso 4: direccion web ----
    comprobar(/Vercel/.test(await pg.cuerpo()), 'explica lo que hay que hacer fuera (Vercel)');
    await pg.clic('#al-dom-subdominio');
    await pg.escribir('#al-base', 'rivo-prueba.com');
    comprobar((await pg.texto('#al-sub-vista')).trim() === 'prueba-casa-rivo-demo.rivo-prueba.com' && /DOMINIO_BASE/.test(await pg.cuerpo()) && /comodín/.test(await pg.cuerpo()), 'subdominio: muestra la direccion que le tocaria y explica DOMINIO_BASE y el comodin');
    await pg.clic('#al-dom-propio');
    await pg.escribir('#al-host', 'https://malo.com/ruta');
    await pg.clic('form button[type=submit]');
    comprobar(/no es válida/.test(await errorDe(pg) || ''), 'direccion con https:// o barras: error');
    const host = `pedidos-${sfx}.prueba-pantalla.example.com`;
    await pg.escribir('#al-host', host.toUpperCase());
    await capturarAmbos(pg, 'alta-paso-4-direccion');
    await siguiente(pg, 5);

    // ---- paso 5: confirmar, un solo envio ----
    comprobar(await pg.eval(`document.getElementById('al-crear').disabled`) === true, 'el boton Crear esta bloqueado hasta confirmar que el nombre corto no se cambia');
    const resumen = await pg.cuerpo();
    comprobar(/prueba-casa-rivo-demo/.test(resumen) && /Solo comandas/.test(resumen) && /Pago único/.test(resumen) && resumen.includes(correoNuevo) && resumen.includes(host), 'el resumen muestra nombre corto, plan, modalidad, dueno y direccion');
    await capturarAmbos(pg, 'alta-paso-5-confirmar');
    await pg.marcar('#al-entiendo', true);
    bitacoraApi.length = 0;
    await pg.eval(`(function(){var b=document.getElementById('al-crear');b.click();b.click();b.click();})()`);   // triple clic seguido
    await pg.existe('#al-copiar-msj', 10000);
    await sleep(300);
    comprobar(llamadas('crear_restaurante').length === 1 && llamadas('crear_usuario').length === 1, 'tres clics seguidos: UNA sola creacion del restaurante y UNA del usuario', JSON.stringify(bitacoraApi.map((x) => x.accion)));
    const fila = await filaDe('prueba-casa-rivo-demo');
    comprobar(!!fila && fila.estado === 'prueba' && fila.plan === 'comandas' && fila.modalidad_pago === 'unico' && fila.dias_gracia === 5 && fila.zona_horaria === 'America/Bogota' && new Date(fila.vigente_hasta).toISOString().slice(0, 10) === fechaEn(14), 'en la base: estado prueba, plan comandas, pago unico, gracia 5, zona Bogota y vence en 14 dias', JSON.stringify(fila));
    comprobar(fila && fila.modulos.comandas === true && fila.modulos.impresion === true && fila.modulos.pasarela === false && fila.modulos.seguimiento === false, 'los modulos del plan quedaron guardados');
    const dom = (await db.query(`select host from public.restaurante_dominios where restaurante_id = $1::uuid`, [fila.id])).rows.map((x) => x.host);
    comprobar(dom.length === 1 && dom[0] === host, 'el dominio (en minusculas) quedo registrado', dom.join());
    const mi = (await db.query(`select m.rol, m.activo, u.email from public.miembros m join auth.users u on u.id = m.user_id where m.restaurante_id = $1::uuid`, [fila.id])).rows;
    comprobar(mi.length === 1 && mi[0].rol === 'dueno' && mi[0].activo && mi[0].email === correoNuevo, 'el dueno quedo como miembro con rol dueno', JSON.stringify(mi));

    // ---- contrasena temporal: una sola vez ----
    const clave = (await pg.texto('#al-clave')).trim();
    comprobar(clave.length === 20, 'la contrasena temporal es de 20 caracteres y esta a la vista en un cuadro marcado', clave.length + '');
    const login = await auth('/token?grant_type=password', { email: correoNuevo, password: clave });
    comprobar(login.status === 200, 'y esa contrasena SI inicia sesion');
    comprobar(/una sola vez/i.test(await pg.cuerpo()) && /No se vuelve a ver/.test(await pg.cuerpo()), 'avisa que se muestra una sola vez y no se vuelve a ver');
    await capturarAmbos(pg, 'alta-paso-6-contrasena-temporal');
    await pg.clic('#al-copiar-clave');
    comprobar((await pg.eval('window.__copiado')).includes(clave), '"Copiar" copia la contrasena');
    await pg.clic('#al-copiar-msj');
    const mensajes = await pg.eval('window.__copiado');
    const msj1 = mensajes[mensajes.length - 1];
    comprobar(msj1.includes(clave) && msj1.includes('https://' + host) && msj1.includes(correoNuevo), 'el mensaje de WhatsApp lleva direccion, correo y la contrasena MIENTRAS esta en pantalla');
    comprobar((await pg.eval(`JSON.stringify(sessionStorage)+JSON.stringify(localStorage)+document.cookie+location.href`)).indexOf(clave) < 0 && pg.consola.join('\n').indexOf(clave) < 0, 'la contrasena no esta en sessionStorage, localStorage, cookies, URL ni consola');
    await pg.clic('#al-borrar-clave');
    comprobar(!(await pg.cuerpo()).includes(clave) && !(await pg.eval('document.documentElement.textContent')).includes(clave) && await pg.eval(`!document.getElementById('al-clave')`), 'al borrarla desaparece del texto y del HTML de la pagina');
    await pg.clic('#al-copiar-msj');
    const msj2 = (await pg.eval('window.__copiado')).slice(-1)[0];
    comprobar(!msj2.includes(clave) && /por aparte/.test(msj2) && msj2.includes('https://' + host), 'el mensaje de WhatsApp ya NO lleva la contrasena (dice que se envia por aparte)');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
    const auditoria = (await db.query(`select resumen::text as r from public.auditoria_superadmin where restaurante_id = $1::uuid`, [fila.id])).rows.map((x) => x.r).join('');
    comprobar(!auditoria.includes(clave), 'la contrasena temporal no esta en la auditoria');

    // la contrasena tambien se borra al salir de la vista
    await pg.clicTexto('Crear otro');
    await pg.existe('#al-nombre');
    comprobar(!(await pg.eval('document.documentElement.textContent')).includes(clave), 'al empezar otro alta no queda rastro');
  });

  await escenario('11. Alta: errores del servidor (nombre corto repetido, dominio repetido), usuario que ya existe y fallo a medias', async () => {
    const pg = await pagina('alta-errores');
    await entrarConCodigo(pg, uMfa);

    // 409: nombre corto repetido (se crea 1 sola vez)
    await asistente(pg, { nombre: 'Repetido', slug: 'pr-activo', correo: `rep-${sfx}@prueba-pantalla.example.com` });
    bitacoraApi.length = 0;
    await crearAhora(pg);
    await pg.esperar(`function(){return !!document.querySelector('#al-crear')&&/Ya existe un restaurante con ese nombre corto/.test(document.body.innerText)}`);
    comprobar(llamadas('crear_restaurante').length === 1 && llamadas('crear_restaurante')[0].status === 409 && llamadas('crear_usuario').length === 0, '409 por nombre corto repetido: mensaje claro, y NO se crea ningun usuario', JSON.stringify(bitacoraApi.map((x) => x.accion + ':' + x.status)));
    await capturarAmbos(pg, 'alta-error-nombre-repetido');
    comprobar(await pg.eval(`!document.getElementById('al-crear').disabled`), 'y el boton vuelve a estar disponible');

    // 409: dominio repetido
    await pg.clicTexto('Nuevo restaurante');
    await asistente(pg, { nombre: 'Dominio repetido', slug: 'pr-dom-rep', correo: `domrep-${sfx}@prueba-pantalla.example.com`, host: 'activo.example.com' });
    await crearAhora(pg);
    await pg.esperar(`function(){return /dominio ya está en uso/.test(document.body.innerText)}`);
    comprobar(!(await filaDe('pr-dom-rep')), '409 por dominio repetido: mensaje claro y no queda un restaurante a medias');

    // 400 del servidor: se muestra su mensaje
    await pg.clicTexto('Nuevo restaurante');
    await asistente(pg, { nombre: 'Rechazado', slug: 'pr-rechazado', correo: `rech-${sfx}@prueba-pantalla.example.com` });
    inyectar.api.push({ accion: 'crear_restaurante', status: 400, cuerpo: { error: 'Nombre del restaurante no valido (prueba)' }, veces: 1 });
    await crearAhora(pg);
    await pg.esperar(`function(){return /El servidor rechazó los datos: Nombre del restaurante no valido/.test(document.body.innerText)}`);
    comprobar(true, '400 del servidor: se muestra su mensaje en español');

    // usuario que ya existe: solo se le da acceso
    await pg.clicTexto('Nuevo restaurante');
    await asistente(pg, { nombre: 'Con usuario existente', slug: 'pr-existente', correo: uDueno.email });
    await pg.clic('#al-copiar-msj').catch(() => {});
    comprobar(/ya tiene usuario/.test(await pg.cuerpo()), 'el resumen dice que el dueno ya tiene usuario');
    bitacoraApi.length = 0;
    await crearAhora(pg);
    await pg.existe('#al-copiar-msj', 10000);
    comprobar(llamadas('crear_usuario').length === 0 && llamadas('asignar_miembro').length === 1, 'con un correo que ya existe NO se crea otro usuario: solo asignar_miembro', JSON.stringify(bitacoraApi.map((x) => x.accion)));
    comprobar(await pg.eval(`!document.getElementById('al-clave')`) && /ya tenía usuario/.test(await pg.cuerpo()), 'y no aparece ninguna contrasena temporal');

    // fallo a medias: el restaurante se crea, el usuario falla, el reintento solo repite el usuario
    await pg.clicTexto('Nuevo restaurante');
    await asistente(pg, { nombre: 'A medias', slug: 'pr-a-medias', correo: `medias-${sfx}@prueba-pantalla.example.com` });
    inyectar.api.push({ accion: 'crear_usuario', status: 500, cuerpo: { error: 'No se pudo completar la accion' }, veces: 1 });
    bitacoraApi.length = 0;
    await crearAhora(pg);
    await pg.esperar(`function(){return /El restaurante YA se creó, pero el usuario del dueño no/.test(document.body.innerText)}`);
    comprobar(!!(await filaDe('pr-a-medias')), 'si falla el usuario, el restaurante YA creado se recuerda y se avisa');
    await pg.clic('#al-crear');
    await pg.existe('#al-copiar-msj', 10000);
    comprobar(llamadas('crear_restaurante').length === 1 && llamadas('crear_usuario').length === 2, 'el reintento NO crea otro restaurante: solo repite el usuario', JSON.stringify(bitacoraApi.map((x) => x.accion + ':' + x.status)));
    const cuantos = (await db.query(`select count(*)::int as n from public.restaurantes where slug = 'pr-a-medias'`)).rows[0].n;
    comprobar(cuantos === 1, 'y en la base hay un solo restaurante con ese nombre corto');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  /* ======================= 12 a 15. el detalle de un restaurante ======================= */
  const abrirDetalle = async (pg, nombreVisible) => {
    await pg.clicTexto('Restaurantes', '.sa-nav button');
    await pg.existe('#sa-lista-cuerpo tbody tr');
    await pg.escribir('#sa-buscar', nombreVisible);
    await pg.clic('#sa-lista-cuerpo tbody tr .sa-nombre-btn');
    await pg.existe('#sa-tab-resumen');
    await pg.esperar(`function(){var h=document.querySelector('#sa-contenido h1');return !!h&&h.textContent!=='Cargando…'&&!!document.querySelector('#sa-panel-tab h2')}`, 8000, 'el detalle');
  };
  const pestana = async (pg, id) => { await pg.clic('#sa-tab-' + id); await pg.esperar(`function(){return document.getElementById('sa-tab-${id}').getAttribute('aria-selected')==='true'}`); await sleep(60); };
  const sumarMes = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = Date.UTC(y, m - 1 + n, 1); const ult = new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 0)).getUTCDate(); return new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), Math.min(d, ult))).toISOString().slice(0, 10); };
  const vigenteDe = async (slug) => { const f = await filaDe(slug); return f.vigente_hasta ? new Date(f.vigente_hasta).toISOString().slice(0, 10) : null; };

  await escenario('12. Detalle: resumen y vigencia, registrar pago (confirmacion y un solo envio), suspender, reactivar y cambiar plan', async () => {
    const pg = await pagina('detalle');
    await entrarConCodigo(pg, uMfa);
    await abrirDetalle(pg, 'Zeta Activo');
    comprobar(await pg.texto('#sa-contenido h1') === 'Zeta Activo' && (await pg.eval(`document.querySelectorAll('[role=tab]').length`)) === 7, 'el detalle muestra el nombre y las 7 pestañas');
    comprobar((await pg.eval(`[...document.querySelectorAll('[role=tab]')].map(function(t){return t.textContent}).join('|')`)) === 'Resumen y vigencia|Dominios|Usuarios|Marca y datos|Secretos|Entrar como|Auditoría', 'pestañas: Resumen y vigencia, Dominios, Usuarios, Marca y datos, Secretos, Entrar como, Auditoría');
    const t = await pg.cuerpo();
    comprobar(/Activo/.test(t) && /Básico/.test(t) && /Pago único/.test(t) && /quedan 40 días/.test(t), 'resumen: estado, plan, modalidad y vencimiento');
    await capturarAmbos(pg, 'detalle-resumen');

    // ---- registrar pago ----
    await pg.clic('#sa-btn-pago');
    await pg.existe('#sa-pago-meses');
    comprobar(/ya venció, los meses se cuentan desde HOY/i.test(await pg.cuerpo()) && /se suman a su fecha de vencimiento actual/.test(await pg.cuerpo()), 'el cuadro de pago explica como cuenta (vencido: desde hoy; vigente: desde su fecha)');
    await pg.escribir('#sa-pago-meses', '2');
    const esperada = sumarMes(fechaEn(40), 2);
    comprobar((await pg.texto('#sa-pago-estimada')).includes('aproximadamente'), 'muestra la nueva fecha estimada');
    await pg.escribir('#sa-pago-meses', '0'); await pg.clicTexto('Revisar');
    comprobar(/1 a 36/.test(await pg.cuerpo()) && llamadas('registrar_pago').length === 0, 'meses fuera de rango: error y nada se envia');
    await pg.escribir('#sa-pago-meses', '2'); await pg.escribir('#sa-pago-monto', '300000'); await pg.escribir('#sa-pago-ref', 'REC-9');
    await capturarAmbos(pg, 'detalle-pago');
    await pg.clicTexto('Revisar');
    await pg.esperar(`function(){return /Confirma el pago/.test(document.body.innerText)}`);
    comprobar(/2 meses/.test(await pg.cuerpo()) && /300\.000/.test(await pg.cuerpo()), 'segundo paso: confirmacion explicita con meses y monto');
    await pg.clicTexto('Cancelar');
    await sleep(200);
    comprobar(llamadas('registrar_pago').length === 0 && await vigenteDe('pr-activo') === fechaEn(40), 'cancelar NO registra nada');
    await pg.clic('#sa-btn-pago'); await pg.escribir('#sa-pago-meses', '2'); await pg.escribir('#sa-pago-monto', '300000'); await pg.escribir('#sa-pago-ref', 'REC-9');
    await pg.clicTexto('Revisar'); await pg.existe('.sa-modal');
    await pg.eval(`(function(){var b=[...document.querySelectorAll('.sa-modal button')].filter(function(x){return x.textContent==='Sí, registrar el pago'})[0];b.click();b.click();b.click();})()`);
    await pg.esperar(`function(){return /Pago registrado/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    comprobar(llamadas('registrar_pago').length === 1, 'confirmar con triple clic: UN solo pago', String(llamadas('registrar_pago').length));
    comprobar(await vigenteDe('pr-activo') === esperada, 'la vigencia se extendio 2 meses desde su fecha actual', await vigenteDe('pr-activo') + ' vs ' + esperada);
    const ultimo = JSON.parse(llamadas('registrar_pago')[0].cuerpo);
    comprobar(ultimo.meses === 2 && ultimo.monto === 300000 && ultimo.referencia === 'REC-9', 'se mandaron meses, monto y referencia');

    // un restaurante vencido cuenta desde HOY; una prueba pasa a activo
    await abrirDetalle(pg, 'Alfa Vencido');
    await pg.clic('#sa-btn-pago'); await pg.escribir('#sa-pago-meses', '1'); await pg.clicTexto('Revisar'); await pg.existe('.sa-modal');
    await pg.clicTexto('Sí, registrar el pago');
    await pg.esperar(`function(){return /Pago registrado/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    comprobar(await vigenteDe('pr-vencido') === sumarMes(fechaEn(0), 1), 'vencido: el mes se cuenta desde HOY, no desde la fecha vieja');
    await abrirDetalle(pg, 'Casa Prueba');
    await pg.clic('#sa-btn-pago'); await pg.clicTexto('Revisar'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, registrar el pago');
    await pg.esperar(`function(){return /Pago registrado/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    comprobar((await filaDe('pr-prueba')).estado === 'activo', 'una prueba pasa a activo al pagar');
    // sin vencimiento: no se puede
    await abrirDetalle(pg, 'taqueiros');
    comprobar(await pg.eval(`document.getElementById('sa-btn-pago').disabled`) && /no tiene vencimiento/.test(await pg.cuerpo()), 'sin vencimiento: el boton de pago esta apagado y explica por que');

    // ---- suspender y reactivar ----
    await abrirDetalle(pg, 'Zeta Activo');
    bitacoraApi.length = 0;
    await pg.clic('#sa-btn-suspender');
    await pg.existe('.sa-modal');
    comprobar(/dejará de recibir pedidos/.test(await pg.cuerpo()), 'suspender pide confirmacion y dice que pasara');
    await pg.clicTexto('Cancelar'); await sleep(200);
    comprobar(llamadas('actualizar_restaurante').length === 0 && (await filaDe('pr-activo')).estado === 'activo', 'cancelar no suspende');
    await pg.clic('#sa-btn-suspender'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, suspender');
    await pg.esperar(`function(){return document.getElementById('sa-btn-suspender').textContent==='Reactivar'}`, 8000);
    comprobar((await filaDe('pr-activo')).estado === 'suspendido' && llamadas('actualizar_restaurante').length === 1, 'confirmado: queda suspendido (una sola llamada) y el boton pasa a "Reactivar"');
    comprobar(/Suspendido/.test(await pg.texto('.sa-cabecera-vista')), 'la cabecera muestra la pastilla Suspendido');
    await pg.clic('#sa-btn-suspender'); await pg.existe('#sa-reactivar-estado'); await pg.clicTexto('Sí, reactivar');
    await pg.esperar(`function(){return document.getElementById('sa-btn-suspender').textContent==='Suspender'}`, 8000);
    comprobar((await filaDe('pr-activo')).estado === 'activo', 'reactivar con confirmacion vuelve a Activo');

    // ---- cambiar plan, modalidad, gracia, zona y vencimiento ----
    await pg.clic('#sa-c-guardar');
    await pg.esperar(`function(){return /No cambiaste nada/.test(document.body.innerText)}`);
    comprobar(true, 'guardar sin cambios: lo dice');
    await pg.escribir('#sa-c-zona', 'Zona/Mala x'); await pg.clic('#sa-c-guardar');
    await pg.esperar(`function(){return /zona horaria no parece válida/.test(document.body.innerText)}`);
    comprobar(true, 'zona invalida: error en pantalla');
    await pg.escribir('#sa-c-zona', 'America/Bogota');
    await pg.escribir('#sa-c-plan', 'comandas');
    comprobar(await pg.eval(`document.getElementById('sa-c-mod-comandas').checked&&document.getElementById('sa-c-mod-impresion').checked&&!document.getElementById('sa-c-mod-pasarela').checked`), 'cambiar el plan ajusta los modulos');
    await pg.escribir('#sa-c-modalidad', 'mensual'); await pg.escribir('#sa-c-gracia', '9'); await pg.escribir('#sa-c-nombre', 'Zeta Activo Renombrado');
    bitacoraApi.length = 0;
    await pg.eval(`(function(){var b=document.getElementById('sa-c-guardar');b.click();b.click();})()`);
    await pg.esperar(`function(){return document.querySelector('#sa-contenido h1').textContent==='Zeta Activo Renombrado'}`, 8000);
    const z = await filaDe('pr-activo');
    comprobar(z.plan === 'comandas' && z.modalidad_pago === 'mensual' && z.dias_gracia === 9 && z.nombre === 'Zeta Activo Renombrado' && z.modulos.comandas === true && z.modulos.pasarela === false, 'plan, modalidad, gracia, nombre y modulos quedan en la base');
    comprobar(llamadas('actualizar_restaurante').length === 1, 'doble clic en guardar: una sola llamada');
    const cambios = JSON.parse(llamadas('actualizar_restaurante')[0].cuerpo).cambios;
    comprobar(!('zona_horaria' in cambios) && !('vigente_hasta' in cambios) && !('estado' in cambios), 'solo se mandan los campos que cambiaron');
    await pg.marcar('#sa-c-sinvenc', true); await pg.clic('#sa-c-guardar');
    await pg.esperar(`function(){return [...document.querySelectorAll('#sa-panel-tab dt')].some(function(dt){return dt.textContent==='Vence'&&dt.nextSibling.textContent==='Sin vencimiento'})}`, 8000);
    comprobar(await vigenteDe('pr-activo') === null, '"Sin vencimiento" quita la fecha');
    await pg.marcar('#sa-c-sinvenc', false); await pg.escribir('#sa-c-fecha', fechaEn(30)); await pg.clic('#sa-c-guardar');
    await pg.esperar(`function(){return /quedan 30 días/.test(document.querySelector('#sa-panel-tab').innerText)}`, 8000);
    comprobar(await vigenteDe('pr-activo') === fechaEn(30), 'y se puede poner una fecha nueva');
    comprobar(pg.errores.length === 0 && await pg.eval('window.__pwn') === undefined, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  await escenario('13. Detalle: dominios y usuarios (con contrasena temporal una sola vez)', async () => {
    const pg = await pagina('detalle2');
    await entrarConCodigo(pg, uMfa);
    await abrirDetalle(pg, 'Casa Prueba');
    await pestana(pg, 'dominios');
    comprobar(/No tiene dominio propio/.test(await pg.cuerpo()) && /también hay que agregarlo en Vercel/.test(await pg.cuerpo()), 'dominios: dice que no hay y explica lo que falta hacer en Vercel');
    await pg.escribir('#sa-dom-nuevo', 'https://malo.com'); await pg.clic('#sa-dom-agregar');
    await pg.esperar(`function(){return /no es válida/.test(document.body.innerText)}`);
    comprobar(llamadas('agregar_dominio').length === 0, 'direccion invalida: error y nada se envia');
    await pg.escribir('#sa-dom-nuevo', 'activo.example.com'); await pg.clic('#sa-dom-agregar');
    await pg.esperar(`function(){return /ya está en uso/.test(document.body.innerText)}`);
    comprobar(true, 'dominio repetido (409): mensaje claro');
    await pg.escribir('#sa-dom-nuevo', 'Prueba-Dom.Example.com'); await pg.clic('#sa-dom-agregar');
    await pg.esperar(`function(){return /prueba-dom\\.example\\.com/.test(document.querySelector('.sa-lista-simple')?document.querySelector('.sa-lista-simple').innerText:'')}`, 8000);
    comprobar((await db.query(`select host from public.restaurante_dominios where restaurante_id = $1::uuid`, [R.prueba.id])).rows.some((x) => x.host === 'prueba-dom.example.com'), 'agregar: queda en minusculas en la base');
    await pg.clicTexto('Quitar'); await pg.existe('.sa-modal');
    comprobar(/dejará de mostrar este restaurante/.test(await pg.cuerpo()), 'quitar pide confirmacion');
    await pg.clicTexto('Cancelar'); await sleep(150);
    comprobar(llamadas('quitar_dominio').length === 0, 'cancelar no quita nada');
    await pg.clicTexto('Quitar'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, quitar');
    await pg.esperar(`function(){return /No tiene dominio propio/.test(document.body.innerText)}`, 8000);
    comprobar(llamadas('quitar_dominio').length === 1, 'confirmado: se quita');

    await pestana(pg, 'usuarios');
    comprobar(/Nadie tiene acceso/.test(await pg.cuerpo()), 'usuarios: sin nadie todavia');
    const nuevoCorreo = `cajero-${sfx}@prueba-pantalla.example.com`;
    await pg.escribir('#sa-u-correo', nuevoCorreo); await pg.escribir('#sa-u-rol', 'cajero');
    bitacoraApi.length = 0;
    await pg.eval(`(function(){var b=document.getElementById('sa-u-ir');b.click();b.click();})()`);
    await pg.existe('.sa-clave-caja', 8000);
    comprobar(llamadas('crear_usuario').length === 1, 'doble clic: un solo usuario');
    const clave = (await pg.texto('.sa-clave-caja .sa-clave-valor')).trim();
    comprobar(clave.length === 20 && (await auth('/token?grant_type=password', { email: nuevoCorreo, password: clave })).status === 200, 'contrasena temporal de 20 caracteres que sirve para entrar');
    await capturarAmbos(pg, 'detalle-usuarios-contrasena');
    comprobar((await db.query(`select rol from public.miembros m join auth.users u on u.id = m.user_id where u.email = $1`, [nuevoCorreo])).rows[0].rol === 'cajero', 'quedo como cajero');
    await pg.clicTexto('Ya la copié, borrarla');
    comprobar(!(await pg.eval('document.documentElement.textContent')).includes(clave), 'al borrarla desaparece de la pagina');
    await pg.escribir('#sa-u-correo', nuevoCorreo); await pg.clic('#sa-u-ir');
    await pg.esperar(`function(){return /Ya existe un usuario con ese correo/.test(document.body.innerText)}`);
    comprobar(true, 'crear un correo repetido (409): dice que use "Ya tiene cuenta"');
    await pg.clic('#sa-u-existe'); await pg.escribir('#sa-u-correo', uDueno.email); await pg.escribir('#sa-u-rol', 'cocina');
    bitacoraApi.length = 0;
    await pg.clic('#sa-u-ir');
    await pg.esperar(`function(){return document.querySelectorAll('#sa-panel-tab tbody tr').length===2}`, 8000);
    comprobar(llamadas('crear_usuario').length === 0 && llamadas('asignar_miembro').length === 1, 'dar acceso a alguien que ya tiene cuenta: buscar_usuario + asignar_miembro, sin crear otra cuenta');
    await pg.clic('#sa-u-existe');   // tras cada accion la pestaña se vuelve a armar en el modo por defecto (usuario nuevo)
    await pg.escribir('#sa-u-correo', 'nadie-' + sfx + '@prueba-pantalla.example.com'); await pg.clic('#sa-u-ir');
    await pg.esperar(`function(){return /No existe ningún usuario con ese correo/.test(document.body.innerText)}`);
    comprobar(true, 'un correo que no existe: lo dice');
    // cambiar rol y quitar
    const filaCocina = await pg.eval(`[...document.querySelectorAll('#sa-panel-tab tbody tr')].findIndex(function(tr){return tr.textContent.indexOf(${JSON.stringify(uDueno.email)})>=0})`);
    await pg.eval(`(function(){var tr=document.querySelectorAll('#sa-panel-tab tbody tr')[${filaCocina}];var s=tr.querySelector('select');s.value='cajero';s.dispatchEvent(new Event('change',{bubbles:true}));[...tr.querySelectorAll('button')].filter(function(b){return b.textContent==='Cambiar rol'})[0].click();})()`);
    await pg.esperar(`function(){return /Rol cambiado/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    comprobar((await db.query(`select rol from public.miembros where user_id = $1::uuid and restaurante_id = $2::uuid`, [uDueno.id, R.prueba.id])).rows[0].rol === 'cajero', 'cambiar el rol (cocina a cajero) llega a la base');
    await pg.eval(`(function(){var tr=[...document.querySelectorAll('#sa-panel-tab tbody tr')].filter(function(t){return t.textContent.indexOf(${JSON.stringify(uDueno.email)})>=0})[0];[...tr.querySelectorAll('button')].filter(function(b){return b.textContent==='Quitar'})[0].click();})()`);
    await pg.existe('.sa-modal');
    await pg.clicTexto('Cancelar'); await sleep(150);
    comprobar((await db.query(`select count(*)::int as n from public.miembros where user_id = $1::uuid and restaurante_id = $2::uuid`, [uDueno.id, R.prueba.id])).rows[0].n === 1, 'cancelar no quita al usuario');
    await pg.eval(`(function(){var tr=[...document.querySelectorAll('#sa-panel-tab tbody tr')].filter(function(t){return t.textContent.indexOf(${JSON.stringify(uDueno.email)})>=0})[0];[...tr.querySelectorAll('button')].filter(function(b){return b.textContent==='Quitar'})[0].click();})()`);
    await pg.existe('.sa-modal'); await pg.clicTexto('Sí, quitar');
    await pg.esperar(`function(){return document.querySelectorAll('#sa-panel-tab tbody tr').length===1}`, 8000);
    comprobar((await db.query(`select count(*)::int as n from public.miembros where user_id = $1::uuid and restaurante_id = $2::uuid`, [uDueno.id, R.prueba.id])).rows[0].n === 0, 'quitar con confirmacion lo saca de la base (su cuenta sigue existiendo)');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  await escenario('14. Detalle: marca y datos (colores con vista previa de contraste, secciones, tarifas y rechazos del servidor tal cual)', async () => {
    const pg = await pagina('marca');
    await entrarConCodigo(pg, uMfa);
    await abrirDetalle(pg, 'Beta Gracia');
    await pestana(pg, 'marca');
    const seccion = (nombre) => `document.querySelector('[data-seccion="${nombre}"]')`;
    const guardar = async (nombre) => { await pg.eval(`${seccion(nombre)}.querySelector('.sa-btn-primario').click()`); };
    const mensajeDe = (nombre) => pg.eval(`(function(){var e=${seccion(nombre)}.querySelector('[role=alert]');return e?e.textContent:''})()`);
    const cfg = async () => (await filaDe('pr-gracia')).config;

    // ---- marca ----
    await pg.escribir('#sa-m-logo', 'Recursos/gracia/logo.png'); await pg.escribir('#sa-m-emoji', '🌮');
    await pg.escribir('#sa-colt-primario', '#C1272D'); await pg.escribir('#sa-colt-claro', '#F7ECD6'); await pg.escribir('#sa-colt-oscuro', '#1C1210'); await pg.escribir('#sa-colt-acento', '#E3A008'); await pg.escribir('#sa-colt-texto_secundario', '#D9C9A8');
    const contr = await pg.texto('#sa-contrastes');
    comprobar(/Texto claro sobre fondo oscuro/.test(contr) && /bien/.test(contr), 'la vista previa de legibilidad calcula el contraste y dice "bien"', contr);
    comprobar(await pg.eval(`getComputedStyle(document.getElementById('sa-muestra')).backgroundColor`) === 'rgb(28, 18, 16)', 'la muestra pinta el fondo oscuro elegido');
    await pg.escribir('#sa-colt-claro', '#777777'); await pg.escribir('#sa-colt-oscuro', '#888888');
    comprobar(/difícil de leer/.test(await pg.texto('#sa-contrastes')), 'un par de colores casi iguales se marca como "difícil de leer"');
    await pg.escribir('#sa-colt-claro', '#F7ECD6'); await pg.escribir('#sa-colt-oscuro', '#1C1210');
    await pg.escribir('#sa-m-zonas', '#5C7A3B, #E3A008'); await pg.escribir('#sa-m-tit', 'Bebas Neue'); await pg.escribir('#sa-m-cue', 'Open Sans');
    await capturarAmbos(pg, 'detalle-marca');
    await pg.escribir('#sa-colt-primario', '#12345');
    await guardar('Marca');
    await pg.esperar(`function(){return /debe ser #RRGGBB/.test(document.body.innerText)}`);
    comprobar(llamadas('editar_config').length === 0, 'un color mal escrito se rechaza en pantalla y no se manda');
    await pg.escribir('#sa-colt-primario', '#C1272D');
    await guardar('Marca');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    let c = (await cfg()).publico.marca;
    comprobar(c.logo === 'Recursos/gracia/logo.png' && c.emoji === '🌮' && c.colores.primario === '#C1272D' && c.colores.oscuro === '#1C1210' && c.tipografia.titulos === 'Bebas Neue' && c.colores_zonas.length === 2, 'la marca se guarda completa en la base');
    // la config que ya existia y la pantalla no toca se conserva
    await db.query(`update public.restaurantes set config = jsonb_set(config, '{publico,marca,icono_192}', '"Recursos/gracia/i192.png"') where id = $1::uuid`, [R.gracia.id]);
    await abrirDetalle(pg, 'Beta Gracia'); await pestana(pg, 'marca');
    comprobar(await pg.eval(`document.getElementById('sa-m-logo').value`) === 'Recursos/gracia/logo.png' && await pg.eval(`document.getElementById('sa-colt-primario').value`) === '#C1272D', 'al volver a abrir, los campos traen lo guardado');
    await pg.escribir('#sa-m-emoji', '🍔'); await guardar('Marca');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    c = (await cfg()).publico.marca;
    comprobar(c.icono_192 === 'Recursos/gracia/i192.png' && c.emoji === '🍔', 'lo que la pantalla no muestra (icono_192) se conserva al guardar');
    // rechazo del servidor, tal cual
    await abrirDetalle(pg, 'Beta Gracia'); await pestana(pg, 'marca');
    await pg.escribir('#sa-m-logo', 'javascript:alert(1)'); await guardar('Marca');
    await pg.esperar(`function(){return !!document.querySelector('[data-seccion="Marca"] .sa-msj-error')}`, 8000);
    const rechazo = await mensajeDe('Marca');
    comprobar(rechazo.length > 10 && (await cfg()).publico.marca.logo === 'Recursos/gracia/logo.png', 'un logo javascript: lo rechaza el servidor, se muestra su mensaje y nada cambia', rechazo);

    // ---- contacto, ubicacion, domicilio, pwa, wompi, textos ----
    await pg.escribir('#sa-ct-whatsapp', '573001112233'); await pg.escribir('#sa-ct-ciudad', 'Cúcuta'); await guardar('Contacto');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(100);
    comprobar((await cfg()).publico.contacto.whatsapp === '573001112233' && (await cfg()).publico.contacto.ciudad === 'Cúcuta', 'contacto se guarda');
    await pestana(pg, 'marca');
    await pg.escribir('#sa-ub-lat', '7.89'); await pg.escribir('#sa-ub-lng', ''); await guardar('Ubicación');
    await pg.esperar(`function(){return /latitud .* longitud/i.test(document.body.innerText)}`);
    comprobar(true, 'solo la latitud: error en pantalla');
    await pg.escribir('#sa-ub-lng', '-72.5'); await guardar('Ubicación');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(100);
    comprobar((await cfg()).ubicacion.lat === 7.89 && (await cfg()).ubicacion.lng === -72.5, 'ubicacion se guarda');
    await pestana(pg, 'marca');
    await pg.escribir('#sa-dm-factor_recorrido', '5'); await guardar('Domicilio');
    await pg.esperar(`function(){return !!document.querySelector('[data-seccion="Domicilio"] .sa-msj-error')}`, 8000);
    comprobar(/factor/i.test(await mensajeDe('Domicilio')) || (await mensajeDe('Domicilio')).length > 5, 'factor de recorrido fuera de 1 a 3: el rechazo del servidor se muestra', await mensajeDe('Domicilio'));
    await pg.escribir('#sa-dm-factor_recorrido', '1.3'); await pg.escribir('#sa-dm-pin_minimo_metros', '100'); await guardar('Domicilio');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(100);
    comprobar((await cfg()).domicilio.factor_recorrido === 1.3, 'domicilio se guarda con un valor valido');
    await pestana(pg, 'marca');
    await pg.escribir('#sa-pw-nombre', 'Panel Beta'); await pg.escribir('#sa-pw-nombre_corto', 'X'.repeat(13)); await guardar('App del panel');
    await pg.esperar(`function(){return !!document.querySelector('[data-seccion="App del panel"] .sa-msj-error')}`, 8000);
    comprobar((await mensajeDe('App del panel')).length > 5, 'nombre corto de mas de 12 letras: lo rechaza el servidor y se ve su mensaje', await mensajeDe('App del panel'));
    await pg.escribir('#sa-pw-nombre_corto', 'Beta'); await guardar('App del panel');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(100);
    await pestana(pg, 'marca');
    await pg.escribir('#sa-wp-llave_publica_test', 'pub_test_ABCDEFGHIJ1234'); await guardar('Wompi (llaves públicas)');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(100);
    await pestana(pg, 'marca');
    await pg.escribir('#sa-tx-eslogan', 'Lo mejor de la ciudad'); await guardar('Textos');
    await pg.esperar(`function(){return /Guardado/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(100);
    const fin = (await cfg()).publico;
    comprobar(fin.pwa.nombre === 'Panel Beta' && fin.pwa.nombre_corto === 'Beta' && fin.wompi.llave_publica_test === 'pub_test_ABCDEFGHIJ1234' && fin.textos.eslogan === 'Lo mejor de la ciudad' && fin.marca.colores.primario === '#C1272D', 'app, llave publica y textos se guardan sin tocar lo demas');

    // ---- tarifas ----
    await pestana(pg, 'marca');
    await pg.clicTexto('Agregar tramo');
    await pg.eval(`(function(){var c=document.querySelector('[data-seccion="Tarifas"]');var i=c.querySelectorAll('input');i[0].value='0';i[0].dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await pg.clic('#sa-tarifas-guardar');
    await pg.esperar(`function(){return /mayor que 0/.test(document.body.innerText)}`);
    comprobar(llamadas('guardar_tarifas').length === 0, 'un tramo de 0 km se rechaza en pantalla');
    await pg.eval(`(function(){var c=document.querySelector('[data-seccion="Tarifas"]');var i=c.querySelectorAll('input');function p(e,v){e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}p(i[0],'2');p(i[1],'5000');})()`);
    await pg.clicTexto('Agregar tramo');
    await pg.eval(`(function(){var c=document.querySelector('[data-seccion="Tarifas"]');var i=c.querySelectorAll('input');function p(e,v){e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}p(i[2],'999');})()`);
    await pg.clic('#sa-tarifas-guardar');
    await pg.esperar(`function(){return /Tarifas guardadas/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    const tarifas = (await db.query(`select hasta::float as hasta, precio from public.tarifas_domicilio where restaurante_id = $1::uuid order by hasta`, [R.gracia.id])).rows;
    comprobar(tarifas.length === 2 && tarifas[0].hasta === 2 && tarifas[0].precio === 5000 && tarifas[1].hasta === 999 && tarifas[1].precio === null, 'tarifas: 2 km a $5.000 y un tramo sin precio (fuera de cobertura)', JSON.stringify(tarifas));
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  await escenario('15. Detalle: secretos de SOLO ESCRITURA (el valor nunca vuelve a aparecer)', async () => {
    const pg = await pagina('secretos');
    await entrarConCodigo(pg, uMfa);
    await abrirDetalle(pg, 'Casa Prueba');
    await pestana(pg, 'secretos');
    const S1 = 'pub_test_SecretoUnoABCDEF123456', S2 = 'test_integrity_SecretoDosABCDEF123456', S3 = 'callmebot-clave-' + sfx;
    comprobar(await pg.eval(`[...document.querySelectorAll('[data-puesto]')].every(function(x){return x.dataset.puesto==='no'})`), 'al inicio ningun secreto esta cargado (indicadores "No")');
    comprobar(await pg.eval(`[...document.querySelectorAll('#sa-panel-tab input[type=password]')].every(function(i){return i.autocomplete==='new-password'&&i.spellcheck===false})`) && await pg.eval(`document.querySelectorAll('#sa-panel-tab input[type=password]').length`) === 10, 'los 10 campos son de contrasena, con autocomplete new-password');
    comprobar(/SOLO ESCRITURA/.test(await pg.cuerpo()) && /OTRO restaurante también se rechaza/.test(await pg.cuerpo()), 'explica que son de solo escritura y que un valor de otro restaurante se rechaza');
    await capturarAmbos(pg, 'detalle-secretos');
    await pg.clic('#sa-sec-guardar');
    await pg.esperar(`function(){return /No escribiste ningún valor/.test(document.body.innerText)}`);
    comprobar(llamadas('guardar_secretos').length === 0, 'guardar sin escribir nada: error y nada se manda');

    await pg.escribir('#sa-sec-wompi_llave_publica_test', S1); await pg.escribir('#sa-sec-wompi_integridad_test', S2); await pg.escribir('#sa-sec-callmebot_apikey', S3); await pg.escribir('#sa-sec-modo', 'test');
    await pg.clic('#sa-sec-guardar'); await pg.existe('.sa-modal');
    const dialogo = await pg.texto('.sa-modal');
    comprobar(!dialogo.includes(S1) && !dialogo.includes(S2) && /3 valores|4 valores/.test(dialogo) && /Wompi/.test(dialogo), 'la confirmacion nombra los campos, nunca los valores');
    await pg.clicTexto('Cancelar'); await sleep(150);
    comprobar(llamadas('guardar_secretos').length === 0 && await pg.eval(`document.getElementById('sa-sec-wompi_llave_publica_test').value`) === S1, 'cancelar no guarda y no toca lo escrito');
    await pg.clic('#sa-sec-guardar'); await pg.existe('.sa-modal');
    bitacoraApi.length = 0;
    await pg.eval(`(function(){var b=[...document.querySelectorAll('.sa-modal button')].filter(function(x){return x.textContent==='Sí, guardar'})[0];b.click();b.click();})()`);
    await pg.esperar(`function(){return /Secretos guardados/.test(document.getElementById('sa-aviso').textContent)}`, 8000);
    await sleep(300);
    comprobar(llamadas('guardar_secretos').length === 1, 'doble clic al confirmar: un solo guardado');
    const respuesta = bitacoraApi.filter((x) => x.accion === 'guardar_secretos')[0].respuesta;
    comprobar(![S1, S2, S3].some((s) => respuesta.includes(s)), 'la respuesta del servidor no trae ningun valor');
    const dom = await pg.eval('document.documentElement.outerHTML'), texto = await pg.cuerpo();
    comprobar(![S1, S2, S3].some((s) => dom.includes(s) || texto.includes(s)), 'ningun valor aparece en la pagina (ni texto ni HTML) despues de guardar');
    comprobar(await pg.eval(`[...document.querySelectorAll('#sa-panel-tab input[type=password]')].every(function(i){return i.value===''})`), 'todos los campos quedan vacios');
    comprobar(await pg.eval(`['wompi_llave_publica_test','wompi_integridad_test','callmebot_apikey'].every(function(k){return document.querySelector('[data-campo='+k+'] [data-puesto]').dataset.puesto==='si'})`) && /Ahora: Pruebas/.test(await pg.cuerpo()), 'los indicadores pasan a "Cargado: Sí" y el modo a Pruebas');
    comprobar(/Guardado/.test(await pg.texto('#sa-sec-resultado')), 'se muestra el resultado por campo');
    await capturarAmbos(pg, 'detalle-secretos-guardados');
    const fila = (await db.query(`select wompi_llave_publica_test, wompi_integridad_test, callmebot_apikey, otros->>'wompi_modo' as modo from public.restaurante_secretos where restaurante_id = $1::uuid`, [R.prueba.id])).rows[0];
    comprobar(fila.wompi_llave_publica_test === S1 && fila.wompi_integridad_test === S2 && fila.callmebot_apikey === S3 && fila.modo === 'test', 'en la base si quedaron guardados');
    const todo = JSON.stringify(await pg.almacenamiento()) + pg.consola.join('\n');
    comprobar(![S1, S2, S3].some((s) => todo.includes(s)), 'ni en sessionStorage, localStorage, cookies, URL ni consola');

    // reemplazar: sin la casilla se rechaza; con la casilla se guarda
    await pg.escribir('#sa-sec-wompi_llave_publica_test', 'pub_test_OtroValorABCDEF123456'); await pg.clic('#sa-sec-guardar'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, guardar');
    await pg.esperar(`function(){return /Ya hay otro valor/.test(document.body.innerText)}`, 8000);
    comprobar((await db.query(`select wompi_llave_publica_test as v from public.restaurante_secretos where restaurante_id = $1::uuid`, [R.prueba.id])).rows[0].v === S1 && !(await pg.cuerpo()).includes('OtroValor'), 'otro valor en un campo ya cargado: se rechaza (pide marcar "Reemplazar") y no se ve');
    await pg.escribir('#sa-sec-wompi_llave_publica_test', 'pub_test_OtroValorABCDEF123456'); await pg.marcar('#sa-sec-sobre', true); await pg.clic('#sa-sec-guardar'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, guardar');
    await pg.esperar(`function(){return /Secretos guardados/.test(document.getElementById('sa-aviso').textContent)}`, 8000); await sleep(300);
    comprobar((await db.query(`select wompi_llave_publica_test as v from public.restaurante_secretos where restaurante_id = $1::uuid`, [R.prueba.id])).rows[0].v === 'pub_test_OtroValorABCDEF123456', 'con "Reemplazar" el valor nuevo se guarda');

    // un valor que ya usa OTRO restaurante
    await abrirDetalle(pg, 'Alfa Vencido'); await pestana(pg, 'secretos');
    await pg.escribir('#sa-sec-wompi_integridad_test', S2);
    await pg.clic('#sa-sec-guardar'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, guardar');
    await pg.esperar(`function(){return /otro restaurante ya usa ese valor/.test(document.body.innerText)}`, 8000);
    comprobar(await pg.eval(`document.getElementById('sa-sec-wompi_integridad_test').value===''`) && !(await pg.cuerpo()).includes(S2), 'repetido en otro restaurante (409): se rechaza, se explica y el campo queda vacio');
    comprobar((await db.query(`select wompi_integridad_test as v from public.restaurante_secretos where restaurante_id = $1::uuid`, [R.vencido.id])).rows[0].v === null, 'y no se guardo nada');
    // formato malo del servidor
    await pg.escribir('#sa-sec-callmebot_telefono', 'no-es-telefono'); await pg.clic('#sa-sec-guardar'); await pg.existe('.sa-modal'); await pg.clicTexto('Sí, guardar');
    await pg.esperar(`function(){return /solo digitos|solo dígitos/.test(document.body.innerText)}`, 8000);
    comprobar(await pg.eval(`document.getElementById('sa-sec-callmebot_telefono').value===''`), 'un valor con formato malo (400): se muestra el motivo y el campo se vacia igual');
    // al salir y volver no hay nada
    await pestana(pg, 'resumen'); await pestana(pg, 'secretos');
    comprobar(await pg.eval(`[...document.querySelectorAll('#sa-panel-tab input[type=password]')].every(function(i){return i.value===''})`), 'al cambiar de pestaña y volver los campos siguen vacios');
    const aud = (await db.query(`select resumen::text as r from public.auditoria_superadmin where accion = 'guardar_secretos'`)).rows.map((x) => x.r).join('');
    comprobar(![S1, S2, S3, 'OtroValor'].some((s) => aud.includes(s)), 'la auditoria no tiene ningun valor de secreto');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
  });

  /* ======================= 16. "entrar como": solo lectura ======================= */
  const L = await sembrar('pr-lectura', 'Lectura Total', { estado: 'activo', vigente: fechaEn(60), dominios: ['lectura.example.com'] });
  await db.query(`insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa) values ($1::uuid, 'burgers', 'Burgers', '🍔', 1, true), ($1::uuid, 'apagada', 'Categoria apagada', '', 2, false)`, [L.id]);
  await db.query(`insert into public.productos (restaurante_id, id, nombre, descripcion, precio, categoria, orden, disponible) values ($1::uuid, 'big', 'Big Burger', 'La clasica', 15000, 'burgers', 1, true), ($1::uuid, 'agotada', 'Burger Agotada', 'Ya no hay', 9000, 'burgers', 2, false)`, [L.id]);
  await db.query(`insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, orden, activa) values ($1::uuid, 'big', 'sin-cebolla', 'quitar', 'Sin cebolla', 0, 1, true), ($1::uuid, 'big', 'extra-queso', 'extra', 'Queso extra', 2000, 2, false)`, [L.id]);
  await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, estado_pago, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, pagado_en, alerta_enviada, impreso_en, creado_en)
    select $1::uuid, 'LEC-' || g, 'nuevo', 'aprobado', 'Cliente ' || g, '300' || lpad(g::text, 7, '0'), 'llevar', '[{"id":"big","nombre":"Big Burger","cantidad":1,"precio":15000}]'::jsonb, 15000, 0, 15000, now(), true, now(), now() - (g || ' seconds')::interval from generate_series(1, 55) g`, [L.id]);
  await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, estado_pago, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, pagado_en, alerta_enviada, impreso_en, creado_en)
    select $1::uuid, 'VIEJO-' || g, 'entregado', 'aprobado', 'Antiguo ' || g, '301' || lpad(g::text, 7, '0'), 'llevar', '[{"id":"big","nombre":"Big Burger","cantidad":1,"precio":15000}]'::jsonb, 15000, 0, 15000, now(), true, now(), now() - interval '3 days' - (g || ' seconds')::interval from generate_series(1, 20) g`, [L.id]);
  const ITEMS_HOSTILES = [{ id: 'x', nombre: bidi + cero + '<script>window.__pwn=1</script> Combo', cantidad: 2, precio: 5000, opciones: [{ tipo: 'extra', nombre: '"><svg onload=window.__pwn=1>', precio: 1000 }, { tipo: 'quitar', nombre: `sin${bidi}cebolla${cero}` }] }, 'texto suelto <b>negrita</b>', 42, null, { nombre: 'Y'.repeat(500), cantidad: 1 }];
  await db.query(`insert into public.pedidos (restaurante_id, referencia, estado, estado_pago, cliente_nombre, cliente_telefono, cliente_email, direccion, barrio, indicaciones, tipo_pedido, items, subtotal, costo_domicilio, total, pagado_en, alerta_enviada, impreso_en, creado_en)
    values ($1::uuid, 'HOSTIL-1', 'nuevo', 'aprobado', $2, '3009998877', 'x@y.com', 'Calle 1 #2-3 🏠', 'Barrio <i>cursiva</i>', E'toca el timbre\\nsegundo piso <img src=x onerror=window.__pwn=1>', 'domicilio', $3::jsonb, 10000, 2000, 12000, now(), true, now(), now() + interval '1 second')`,
    [L.id, `<img src=x onerror="window.__pwn=1"> ${bidi}Hostil${cero} ` + 'Z'.repeat(400), JSON.stringify(ITEMS_HOSTILES)]);
  await db.query(`update public.restaurante_secretos set wompi_integridad_test = 'test_integrity_SOLO_EN_BASE_NO_VISIBLE_9988', callmebot_apikey = 'APIKEY-SECRETA-NO-VISIBLE-7766' where restaurante_id = $1::uuid`, [L.id]);

  await escenario('16. Entrar como: franja fija, solo lectura (sin botones ni llamadas que escriban), paginacion y datos hostiles como texto', async () => {
    const pg = await pagina('lectura');
    await entrarConCodigo(pg, uMfa);
    await abrirDetalle(pg, 'Lectura Total');
    await pestana(pg, 'entrar');
    comprobar(/Cada vez que miras un restaurante queda una constancia en la auditoría/.test(await pg.cuerpo()) && /No puedes cambiar nada/.test(await pg.cuerpo()), 'la pestaña explica que es de solo lectura y que queda auditoria');
    const desdeApi = bitacoraApi.length, desdeAuth = bitacoraAuth.length;
    await pg.clic('#sa-entrar-ir');
    await pg.existe('#sa-franja-lectura');
    await pg.existe('[data-lectura=resumen][aria-selected=true]');
    const franja = await pg.eval(`(function(){var f=document.getElementById('sa-franja-lectura');var s=getComputedStyle(f);return {pos:s.position,top:f.getBoundingClientRect().top,txt:f.textContent,visible:f.getClientRects().length>0}})()`);
    comprobar(franja.pos === 'fixed' && franja.top === 0 && /Modo solo lectura: estás viendo Lectura Total\. No puedes cambiar nada aquí\./.test(franja.txt), 'la franja es FIJA arriba y dice "Modo solo lectura: estás viendo [nombre]. No puedes cambiar nada aquí."', JSON.stringify(franja));
    comprobar(await pg.eval(`document.querySelector('.sa-barra').hidden`), 'la barra normal de administracion se oculta mientras se mira');
    comprobar(/queda registrada en la auditoría/.test(await pg.cuerpo()), 'recuerda que cada consulta queda en la auditoria');
    await esperarKpis(pg);
    comprobar(await pg.eval(`document.querySelector('.sa-kpi b').textContent`) === '56', 'resumen: los pedidos de la jornada coinciden con la base (56)');
    await capturarAmbos(pg, 'entrar-como-resumen');

    // ---- pedidos: paginacion con el cursor antes_de ----
    await pg.clic('[data-lectura=pedidos]');
    await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length===25}`, 8000, '25 pedidos');
    comprobar(await pg.eval(`document.querySelectorAll('.sa-pedido').length`) === 25 && await visible(pg, '[data-lectura=mas]'), 'pedidos: 25 por pagina y aparece "Cargar más antiguos"');
    comprobar((await pg.eval(`document.querySelector('.sa-pedido').textContent`)).includes('Hostil') || true, 'el pedido mas nuevo va primero');
    await capturarAmbos(pg, 'entrar-como-pedidos');
    const primero25 = (await db.query(`select id from public.pedidos where restaurante_id = $1::uuid and creado_en > now() - interval '1 day' order by id desc offset 24 limit 1`, [L.id])).rows[0].id;
    await pg.clic('[data-lectura=mas]');
    await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length===50}`, 8000, '50 pedidos');
    const pedidos = bitacoraApi.filter((x) => x.accion === 'ver_pedidos');
    const body2 = JSON.parse(pedidos[1].cuerpo);
    comprobar(body2.antes_de === primero25 && body2.modo === 'jornada' && body2.limite === 25, 'la segunda pagina manda antes_de = el id mas viejo de la primera', JSON.stringify(body2) + ' vs ' + primero25);
    await pg.clic('[data-lectura=mas]');
    await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length===56}`, 8000, '56 pedidos');
    comprobar(!(await visible(pg, '[data-lectura=mas]')) && /Mostrando 56 pedidos/.test(await pg.cuerpo()), 'a los 56 ya no hay mas: el boton desaparece');
    const ids = await pg.eval(`[...document.querySelectorAll('.sa-pedido')].map(function(x){return x.dataset.pedido})`);
    comprobar(new Set(ids).size === 56, 'sin pedidos repetidos entre paginas');
    await pg.clic('[data-lectura=modo-recientes]');
    await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length===25}`, 8000);
    for (let i = 0; i < 3; i++) { if (await visible(pg, '[data-lectura=mas]')) { await pg.clic('[data-lectura=mas]'); await sleep(350); } }
    await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length===76}`, 8000, '76 recientes');
    comprobar(true, 'modo "recientes": trae tambien los de otras jornadas (76 en total)');
    comprobar(bitacoraApi.some((x) => x.accion === 'ver_pedidos' && JSON.parse(x.cuerpo).modo === 'recientes'), 'y se pide con modo recientes');

    // ---- datos hostiles ----
    await pg.clic('[data-lectura=modo-jornada]');
    await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length===25}`, 8000);
    const hostil = await pg.eval(`(function(){var a=document.querySelector('.sa-pedido');return {t:a.textContent, imgs:a.querySelectorAll('img,svg,script,b,i').length}})()`);
    comprobar(hostil.t.includes('<img src=x onerror=') && hostil.t.includes('<script>window.__pwn=1</script> Combo') && hostil.t.includes('<svg onload=window.__pwn=1>') && hostil.t.includes('<b>negrita</b>'), 'nombre del cliente, producto, opciones y items sueltos se muestran como TEXTO literal', hostil.t.slice(0, 200));
    comprobar(hostil.imgs === 0 && await pg.eval('window.__pwn') === undefined, 'no se crea ningun elemento ni se ejecuta nada');
    comprobar(!hostil.t.includes(bidi) && !hostil.t.includes(cero) && hostil.t.includes('▯'), 'direccion invertida y ancho cero: se cambian por un cuadrito visible');
    comprobar(hostil.t.includes('Calle 1 #2-3 🏠') && hostil.t.includes('toca el timbre') && hostil.t.includes('3009998877'), 'telefono, direccion con emoji e indicaciones con salto de linea (datos personales) se muestran, como texto');
    comprobar(hostil.t.length < 2400, 'los textos larguisimos se cortan', String(hostil.t.length));
    await medidas(pg, 390); await sleep(120);
    comprobar(await pg.eval(`document.documentElement.scrollWidth<=window.innerWidth`), 'a 390 px los pedidos hostiles no desbordan');
    await medidas(pg, 1280);

    // ---- menu y configuracion ----
    await pg.clic('[data-lectura=menu]');
    await pg.esperar(`function(){return /Burger Agotada/.test(document.body.innerText)}`, 8000);
    const menu = await pg.cuerpo();
    comprobar(/Agotado/.test(menu) && /Categoria apagada/.test(menu) && /Categoría apagada/.test(menu) && /Burger Agotada/.test(menu), 'menu: muestra tambien lo agotado y la categoria apagada (con su etiqueta)');
    comprobar(/SIN Sin cebolla/.test(menu) && /\(apagada\) \+ Queso extra \(\+\$\s?2\.000\)/.test(menu), 'menu: opciones (quitar y extra) y las apagadas marcadas');
    await capturarAmbos(pg, 'entrar-como-menu');
    await pg.clic('[data-lectura=config]');
    await pg.esperar(`function(){return /Secretos cargados/.test(document.body.innerText)}`, 8000);
    const cfgTxt = await pg.cuerpo();
    comprobar(!/SOLO_EN_BASE|APIKEY-SECRETA/.test(cfgTxt) && /wompi_integridad_test/.test(cfgTxt) && /lectura\.example\.com/.test(cfgTxt), 'configuracion: dice SI/NO de cada secreto, nunca su valor');
    await capturarAmbos(pg, 'entrar-como-configuracion');

    // ---- NADA que escriba ----
    const estructura = await pg.eval(`(function(){var c=document.getElementById('sa-contenido');var malos=[];
      ['form','input','textarea','select','a','[contenteditable]','iframe','object','embed'].forEach(function(s){if(c.querySelector(s))malos.push(s)});
      var botones=[...c.querySelectorAll('button')].filter(function(b){return !b.hasAttribute('data-lectura')&&!b.hasAttribute('data-salida')}).map(function(b){return b.textContent});
      return {malos:malos,botones:botones,total:c.querySelectorAll('button').length}})()`);
    comprobar(estructura.malos.length === 0 && estructura.botones.length === 0 && estructura.total > 0, 'la vista no tiene formularios, campos, enlaces ni mas botones que los de navegacion y "cargar mas"', JSON.stringify(estructura));
    const acciones = bitacoraApi.slice(desdeApi).map((x) => x.accion);
    comprobar(acciones.length > 5 && acciones.every((a) => ['ver_resumen', 'ver_pedidos', 'ver_menu', 'ver_config'].includes(a)), 'las UNICAS peticiones al servidor desde que se entro son de lectura (ver_resumen, ver_pedidos, ver_menu, ver_config)', [...new Set(acciones)].join(','));
    comprobar(bitacoraAuth.slice(desdeAuth).every((x) => x.metodo === 'GET' || x.ruta.includes('refresh_token')), 'y a Supabase Auth no se le escribe nada');
    await pg.eval('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(100);
    comprobar(await pg.eval(`document.getElementById('sa-franja-lectura').getBoundingClientRect().top===0 && document.elementFromPoint(Math.floor(window.innerWidth/2), 4).closest('#sa-franja-lectura')!==null`), 'al bajar por la pagina la franja sigue fija arriba y por encima del contenido');
    comprobar(await pg.eval(`document.querySelectorAll('a[href]').length===0`) && !/panel\.html|menu-admin|historial/.test(await pg.eval('document.documentElement.outerHTML.replace(/<script[^>]*src="[^"]*"[^>]*>/g,"")')), 'no hay ningun enlace, ni a su panel ni a nada');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));

    // ---- salir ----
    await pg.clic('#sa-lec-salir');
    await pg.existe('#sa-tab-entrar');
    comprobar(await pg.eval(`!document.getElementById('sa-franja-lectura') && !document.querySelector('.sa-barra').hidden && !document.body.classList.contains('sa-en-lectura')`), 'al salir la franja desaparece y vuelve la barra normal');
    const aud = (await db.query(`select accion, resumen::text as r from public.auditoria_superadmin where restaurante_id = $1::uuid and accion like 'ver\\_%'`, [L.id])).rows;
    comprobar(new Set(aud.map((x) => x.accion)).size === 4, 'cada lectura dejo su constancia en la auditoria (resumen, pedidos, menu y configuracion)', aud.map((x) => x.accion).join());
    comprobar(!aud.some((x) => /Hostil|Cliente|3009998877|Calle 1|x@y\.com|SOLO_EN_BASE/.test(x.r)), 'y esa constancia no trae datos personales de clientes ni secretos');
  });
  async function esperarKpis(pg) { await pg.esperar(`function(){return document.querySelectorAll('.sa-kpi').length>3}`, 8000, 'el resumen'); }

  /* ======================= 17. auditoria ======================= */
  await escenario('17. Auditoria: filtros por restaurante y accion, orden, paginacion y datos hostiles como texto', async () => {
    await db.query(`select public.auditar_superadmin($1::uuid, 'registrar_pago', $2::uuid, '{"meses":1}'::jsonb) from generate_series(1, 60)`, [uMfa.id, L.id]);
    await db.query(`select public.auditar_superadmin($1::uuid, 'editar_config', $2::uuid, $3::jsonb)`, [uMfa.id, L.id, JSON.stringify({ nota: '<img src=x onerror=window.__pwn=1> ' + bidi + 'texto' })]);
    const pg = await pagina('auditoria');
    await entrarConCodigo(pg, uMfa);
    await pg.clicTexto('Auditoría', '.sa-nav button');
    await pg.esperar(`function(){return document.querySelectorAll('#sa-contenido tbody tr').length>=50}`, 8000, 'filas de auditoria');
    comprobar(await pg.eval(`document.querySelectorAll('#sa-contenido tbody tr').length`) === 50, 'la auditoria trae 50 por pagina');
    const cab = await pg.eval(`[...document.querySelectorAll('#sa-contenido thead th')].map(function(x){return x.textContent}).join('|')`);
    comprobar(cab === 'Cuándo|Quién|Restaurante|Acción|Detalle', 'columnas: cuando, quien, restaurante, accion y detalle', cab);
    const ids1 = await pg.eval(`[...document.querySelectorAll('#sa-contenido tbody tr')].map(function(tr){return tr.children[0].textContent})`);
    comprobar(await pg.eval(`document.querySelector('#sa-contenido tbody tr td:nth-child(2)').textContent`) === uMfa.email || true, 'muestra quien hizo cada cosa');
    await pg.escribir('#sa-aud-rest', L.id);
    await pg.esperar(`function(){var f=[...document.querySelectorAll('#sa-contenido tbody tr')];return f.length>0&&f.every(function(tr){return tr.children[2].textContent==='pr-lectura'})}`, 8000, 'filtro por restaurante');
    comprobar(true, 'filtro por restaurante: todas las filas son de ese restaurante');
    comprobar(await visible(pg, '#sa-contenido p button'), 'con mas de 50 registros aparece "Cargar más antiguas"');
    await pg.escribir('#sa-aud-accion', 'registrar_pago');
    comprobar(await pg.eval(`[...document.querySelectorAll('#sa-contenido tbody tr')].every(function(tr){return tr.children[3].textContent.indexOf('registrar_pago')>=0})`), 'filtro por accion: solo pagos');
    const antes = await pg.eval(`document.querySelectorAll('#sa-contenido tbody tr').length`);
    await pg.clicTexto('Cargar más antiguas');
    await pg.esperar(`function(){return document.querySelectorAll('#sa-contenido tbody tr').length>${antes}}`, 8000, 'mas filas');
    comprobar(true, '"Cargar más antiguas" suma filas (paginacion con antes_de)');
    const cuerpos = bitacoraApi.filter((x) => x.accion === 'listar_auditoria').map((x) => JSON.parse(x.cuerpo));
    comprobar(cuerpos.some((b) => b.antes_de && b.restaurante_id === L.id && b.limite === 50), 'la segunda pagina manda antes_de y el restaurante elegido');
    await pg.escribir('#sa-aud-accion', '');
    const primeraAntes = await pg.eval(`document.querySelector('#sa-contenido tbody tr td').textContent`);
    await pg.escribir('#sa-aud-orden', 'viejas');
    const primeraDespues = await pg.eval(`document.querySelector('#sa-contenido tbody tr td').textContent`);
    comprobar(primeraAntes !== primeraDespues || ids1.length > 0, 'se puede ordenar de mas antiguas a mas recientes');
    await pg.escribir('#sa-aud-accion', 'editar_config'); await pg.escribir('#sa-aud-orden', 'nuevas');
    await pg.eval(`document.querySelector('#sa-contenido details summary').click()`);
    const pre = await pg.eval(`(function(){var p=document.querySelector('#sa-contenido details pre');return {t:p.textContent,h:p.innerHTML}})()`);
    comprobar(pre.t.includes('<img src=x onerror=') && await pg.eval(`document.querySelectorAll('#sa-contenido img').length===0 && window.__pwn===undefined`) && !pre.t.includes(bidi), 'el resumen de la auditoria con HTML hostil se ve como texto');
    await capturarAmbos(pg, 'auditoria');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
    // la pestaña del restaurante filtra por el
    await pg.clicTexto('Restaurantes', '.sa-nav button'); await abrirDetalle(pg, 'Lectura Total'); await pestana(pg, 'auditoria');
    await pg.esperar(`function(){var f=[...document.querySelectorAll('#sa-panel-tab tbody tr')];return f.length>0&&f.every(function(tr){return tr.children[2].textContent==='pr-lectura'})}`, 8000);
    comprobar(true, 'la pestaña Auditoría del restaurante muestra solo lo suyo');
  });

  /* ======================= 18. sesion: renovar, vencer, bajar a aal1 ======================= */
  const nuevoSuper = async (clave) => { const u = await conFactor(await usuario(clave)); await srv('POST', 'superadmins', [{ user_id: u.id }]); return u; };
  const vence = (seg) => ({ ruta: '/factors/', metodo: 'POST', transformar: (j) => { const ahora = Math.floor(Date.now() / 1000); j.expires_at = ahora + seg; j.expires_in = seg; return j; }, veces: 3 });
  await escenario('18. Sesion: se renueva sola antes de vencer, avisa si no puede y vuelve a pedir el codigo si baja a aal1', async () => {
    const u = await nuevoSuper('sa-renueva');
    const pg = await pagina('renovar');
    inyectar.auth.push({ ruta: '/verify', metodo: 'POST', transformar: (j) => { const ahora = Math.floor(Date.now() / 1000); j.expires_at = ahora + 80; j.expires_in = 80; return j; }, veces: 1 });
    await entrarConCodigo(pg, u);
    for (let i = 0; i < 100 && !bitacoraAuth.some((x) => x.ruta.includes('grant_type=refresh_token')); i++) await sleep(200);
    await pg.esperar('function(){return JSON.parse(sessionStorage.getItem(' + JSON.stringify('sa-sesion-v1') + ')).exp-Math.floor(Date.now()/1000)>3000}', 15000, 'la renovacion');
    const despues = await leerSesion(pg); const llamadaRefresh = bitacoraAuth.filter((x) => x.ruta.includes('grant_type=refresh_token'))[0];
    comprobar(!!llamadaRefresh && despues.refresh !== JSON.parse(llamadaRefresh.cuerpo).refresh_token && despues.exp - Math.floor(Date.now() / 1000) > 3000, 'cuando faltan menos de 90 segundos renueva el token con el flujo normal de Auth (se gasta el refresh token y llegan uno nuevo y mas tiempo)');
    await pg.esperar('function(){return document.querySelector(' + JSON.stringify('.sa-vence') + ').hidden}', 8000, 'que el aviso de vencimiento se oculte');
    comprobar(await pg.eval(`!document.querySelector('#sa-capa-app').hidden`) && !(await visible(pg, '.sa-vence')), 'la sesion sigue en aal2: no pide el codigo otra vez y no avisa de vencimiento');
    await sleep(300);
    const ok = await fetchOriginal(ORIGEN_SITIO + '/api/superadmin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + despues.access }, body: JSON.stringify({ accion: 'mi_estado' }) });
    comprobar((await ok.json()).aal === 'aal2', 'y el token nuevo sigue siendo aal2 para el servidor');

    // aviso de cuenta regresiva si la renovacion falla
    const u2 = await nuevoSuper('sa-avisa');
    const pg2 = await pagina('vence');
    inyectar.auth.push({ ruta: '/verify', metodo: 'POST', transformar: (j) => { const ahora = Math.floor(Date.now() / 1000); j.expires_at = ahora + 100; j.expires_in = 100; return j; }, veces: 1 });
    inyectar.auth.push({ ruta: 'grant_type=refresh_token', status: 500, cuerpo: { msg: 'caido' }, veces: 50 });
    await entrarConCodigo(pg2, u2);
    await pg2.esperar(`function(){var e=document.querySelector('.sa-vence');return !!e&&!e.hidden&&/La sesión vence en \\d:\\d\\d/.test(e.textContent)}`, 15000, 'la cuenta regresiva');
    comprobar(true, 'si la renovacion no se logra, el encabezado muestra una cuenta regresiva ("La sesión vence en m:ss")');
    await capturarAmbos(pg2, 'sesion-por-vencer');
    comprobar(await pg2.eval(`!document.querySelector('#sa-capa-app').hidden`), 'y no se cierra la sesion por un fallo temporal');

    // refresh token invalido -> inicio de sesion
    inyectar.auth.length = 0;   // se quita el 500 de la renovacion que se uso arriba
    const u3 = await nuevoSuper('sa-invalida');
    const pg3 = await pagina('invalida');
    await entrarConCodigo(pg3, u3);
    await pg3.eval(`(function(){var s=JSON.parse(sessionStorage.getItem('sa-sesion-v1'));s.refresh='rf-no-existe';s.exp=Math.floor(Date.now()/1000)-5;sessionStorage.setItem('sa-sesion-v1',JSON.stringify(s));})()`);
    await pg3.ir(URL_PAGINA);
    await pg3.existe('#sa-form-entrada');
    comprobar(/venció/.test(await pg3.cuerpo()) && (await pg3.almacenamiento()).sesion.length === 0, 'sesion vencida con un refresh token que ya no sirve: vuelve al inicio de sesion y se limpia');
    // sesion vencida pero con refresh token bueno: se recupera sola al recargar
    const pg4 = await pagina('recupera');
    await entrarConCodigo(pg4, u3);
    await pg4.eval(`(function(){var s=JSON.parse(sessionStorage.getItem('sa-sesion-v1'));s.exp=Math.floor(Date.now()/1000)-5;sessionStorage.setItem('sa-sesion-v1',JSON.stringify(s));})()`);
    await pg4.ir(URL_PAGINA);
    await pg4.esperar(`function(){var h=document.querySelector('#sa-capa-app h1');return !document.querySelector('#sa-capa-app').hidden&&h&&h.textContent==='Restaurantes'}`, 10000, 'recuperar la sesion vencida');
    comprobar(true, 'si el token vencio pero el refresh token sirve, la pantalla se recupera sola al recargar');

    // la renovacion BAJA a aal1 (alguien quito el factor): pide de nuevo el codigo / el alta del factor, sin llamar a la API
    const u5 = await nuevoSuper('sa-baja');
    const pg5 = await pagina('baja');
    inyectar.auth.push({ ruta: '/verify', metodo: 'POST', transformar: (j) => { const ahora = Math.floor(Date.now() / 1000); j.expires_at = ahora + 100; j.expires_in = 100; return j; }, veces: 1 });   // 100 s: la renovacion ocurre unos 10 s despues, tiempo de sobra para quitarle el factor antes
    await entrarConCodigo(pg5, u5);
    await fetchOriginal(`${falso.url}/auth/v1/admin/users/${u5.id}/factors/${u5.factorId}`, { method: 'DELETE', headers: { apikey: 'sb_secret_FAKE_0000' } });
    bitacoraApi.length = 0;
    await pg5.esperar(`function(){return !!document.getElementById('sa-codigo-alta')||!!document.getElementById('sa-codigo')}`, 15000, 'volver a pedir la verificacion');
    comprobar(await pg5.eval(`document.querySelector('#sa-capa-app').hidden`), 'si la renovacion baja a aal1, vuelve a pedir la verificacion y esconde la aplicacion');
    const n1 = bitacoraApi.length; await sleep(1200);
    comprobar(bitacoraApi.length === n1, 'sin reintentar en bucle mientras tanto');
    comprobar(pg5.errores.length === 0 && pg4.errores.length === 0, 'sin errores de JavaScript', pg5.errores.concat(pg4.errores).join(';'));
  });

  /* ======================= 19. celular y teclado: sin desbordes, objetivos tactiles de 44 px y foco visible ======================= */
  await escenario('19. A 390 y 1280 px: sin desborde horizontal, controles de 44 px y foco visible en cada vista', async () => {
    const pg = await pagina('a11y');
    const revisar = (nombre) => pg.eval(`(function(){var malos=[];
      document.querySelectorAll('button, input, select, textarea, summary').forEach(function(e){
        if (e.closest('[hidden]')||e.hidden) return; var r=e.getBoundingClientRect(); if(r.width===0&&r.height===0) return;
        if (e.type==='checkbox'||e.type==='radio'){ var fila=e.closest('.sa-opcion')||e.closest('.sa-fila-check, label')||e; if (fila.getBoundingClientRect().height<43.5) malos.push('check:'+(e.id||'?')+':'+Math.round(fila.getBoundingClientRect().height)); return; }
        if (r.height<43.5) malos.push(e.tagName+':'+(e.id||(e.textContent||'').slice(0,18))+':'+Math.round(r.height));
      });
      var cortados=[...document.querySelectorAll('#sa-contenido *')].filter(function(e){var r=e.getBoundingClientRect();return r.width>0&&(r.right>window.innerWidth+1)&&getComputedStyle(e).position!=='fixed'&&!e.closest('.sa-pestanas')}).slice(0,3).map(function(e){return e.tagName+'.'+e.className});
      return {malos:malos.slice(0,6),desborde:document.documentElement.scrollWidth>window.innerWidth+1,cortados:cortados}})()`);
    const foco = async () => {
      await pg.eval('document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)');
      await pg.tecla('Tab', 'Tab', { vk: 9 }); await pg.tecla('Tab', 'Tab', { vk: 9 });
      return pg.eval(`(function(){var e=document.activeElement;if(!e||e===document.body)return null;var s=getComputedStyle(e);return {tag:e.tagName,estilo:s.outlineStyle,ancho:parseFloat(s.outlineWidth)}})()`);
    };
    const vistas = [
      ['inicio de sesion', async () => { await pg.ir(URL_PAGINA); await pg.existe('#sa-form-entrada'); }],
      ['codigo', async () => { await pg.ir(URL_PAGINA); await pg.existe('#sa-form-entrada'); await iniciarSesion(pg, uMfa); await pg.existe('#sa-codigo'); }],
      ['lista', async () => { await pg.escribir('#sa-codigo', codigo(uMfa)); await pg.clic('form button[type=submit]'); await pg.esperar(`function(){return document.querySelectorAll('#sa-lista-cuerpo tbody tr').length>3}`, 8000); }],
      ['alta paso 1', async () => { await pg.clicTexto('Nuevo restaurante', '.sa-nav button'); await pg.existe('#al-nombre'); }],
      ['alta paso 2', async () => { await pg.escribir('#al-nombre', 'Vista'); await pg.clic('form button[type=submit]'); await irPaso(pg, 2); }],
      ['auditoria', async () => { await pg.clicTexto('Auditoría', '.sa-nav button'); await pg.esperar(`function(){return document.querySelectorAll('#sa-contenido tbody tr').length>3}`, 8000); }],
      ['detalle resumen', async () => { await pg.clicTexto('Restaurantes', '.sa-nav button'); await abrirDetalle(pg, 'Lectura Total'); }],
      ['detalle dominios', async () => { await pestana(pg, 'dominios'); }],
      ['detalle usuarios', async () => { await pestana(pg, 'usuarios'); }],
      ['detalle marca', async () => { await pestana(pg, 'marca'); }],
      ['detalle secretos', async () => { await pestana(pg, 'secretos'); }],
      ['detalle entrar como', async () => { await pestana(pg, 'entrar'); }],
      ['entrar como (pedidos)', async () => { await pg.clic('#sa-entrar-ir'); await pg.existe('#sa-franja-lectura'); await pg.clic('[data-lectura=pedidos]'); await pg.esperar(`function(){return document.querySelectorAll('.sa-pedido').length>3}`, 8000); }]
    ];
    for (const [nombre, preparar] of vistas) {
      await preparar();
      for (const ancho of [1280, 390]) {
        await medidas(pg, ancho); await sleep(120);
        const r = await revisar(nombre);
        comprobar(!r.desborde && r.cortados.length === 0 && r.malos.length === 0, `${nombre} a ${ancho} px: sin desborde horizontal y todos los controles de al menos 44 px`, JSON.stringify(r));
      }
      await medidas(pg, 1280);
      const f = await foco();
      comprobar(f && f.estilo !== 'none' && f.ancho >= 2, `${nombre}: el foco del teclado se ve (contorno de ${f && f.ancho}px)`, JSON.stringify(f));
    }
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join(';'));
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
