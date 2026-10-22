/* =============================================================
   PRUEBAS DE NAVEGADOR DE LAS PAGINAS PRIVADAS MULTI-RESTAURANTE
   (panel.html, menu-admin.html, historial.html)

     node pruebas/multirestaurante/panel.mjs

   Chrome sin interfaz + el supabase-js REAL (el UMD de node_modules) + los manejadores REALES de api/
   (restaurante, manifest) + una base falsa con Postgres 16 real (PGlite) con el SQL 10, 11 y 12 y sus
   politicas RLS reales + un Realtime falso que habla el protocolo del supabase-js real (realtime-falso.mjs).
   Sin red externa: fuentes y CDN bloqueados.

   Como en produccion, Supabase vive en OTRO origen (supabase.localhost) y cada restaurante en el suyo
   (alfa.localhost, beta.localhost...): cada uno tiene su propio almacenamiento y su propia sesion.

   Que se prueba
     1. La marca de cada restaurante en las tres paginas (nombre, logo, favicon, colores, tipografias).
     2. Datos HOSTILES en la configuracion (HTML, CSS, javascript:, tipografias fuera de la lista).
     3. Dominio desconocido y servidor caido: mensaje neutro, sin consultar nada.
     4. Membresia: dueno de A, dueno de B, miembro de los dos, sin membresia, inactivo, y un usuario de A
        entrando por el dominio de B. Rol visible. Cierre de sesion SOLO local.
     5. Aislamiento: tablero, historial, resumen y menu-admin no mezclan datos entre restaurantes (con un
        usuario que RLS deja ver los dos).
     6. menu-admin: cada alta lleva su restaurante_id, la foto nueva va a {restaurante_id}/..., editar/borrar
        por id no toca el producto de otro restaurante (mismo id en los dos).
     7. Realtime: los canales piden SOLO su restaurante y el panel descarta lo ajeno aunque llegue.
     8. Alertas de salud del WhatsApp por restaurante.
     9. Impresion: el pie del ticket lleva el nombre del restaurante; nada ajeno se imprime.
    10. Preferencias del navegador: claves por restaurante y migracion de las anteriores.
    11. Taqueiros IDENTICO al commit anterior (estilos calculados en login, tablero, menu, modales, menu-admin,
        historial).
    12. Archivos: nada de Taqueiros escrito a mano.

   Variables: CHROME=ruta\chrome.exe   SOLO="^(4|5)\."   (corre solo los escenarios que casen)
============================================================= */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { levantar } from './fake-supabase.mjs';
import { crearRealtime } from './realtime-falso.mjs';
import { REPO } from './sim.mjs';
import { crearEmulador } from './vercel-emulador.mjs';
const EMULADOR = crearEmulador(REPO);

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const PUERTO_WEB = Number(process.env.PUERTO_WEB) || 8095;          // el sitio nuevo
const PUERTO_ANTIGUO = PUERTO_WEB - 1;     // el sitio como estaba antes (para comparar)
const PUERTO_CDP = Number(process.env.PUERTO_CDP) || 9335;
const PUERTO_FALSO = Number(process.env.PUERTO_FALSO) || 54341;
const COMMIT_ANTERIOR = '1c35320';
const TAQUEIROS_ID = '00000000-0000-4000-8000-000000000001';
const sfx = crypto.randomBytes(3).toString('hex');
const CLAVE = 'Clave-de-prueba-' + sfx;
const HOST_SUPABASE = 'supabase.localhost';
const bidi = String.fromCharCode(0x202e);

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

/* Grabadora de window.print() (como la del e2e de la impresion): guarda el documento que se habria impreso. */
const SCRIPT_GRABADORA = `
(function(){
  window.print = function(){
    try{
      var top = window.top;
      top.__impresos = top.__impresos || [];
      var d = document;
      top.__impresos.push({ t: Date.now(), enMarco: window !== top, texto: d.body ? d.body.innerText : "",
        html: "<!DOCTYPE html>" + d.documentElement.outerHTML });
    }catch(e){}
  };
  // El service worker recarga la pagina una vez al activarse (panel.html): en las pruebas no se registra, para que no haya recargas a mitad de un escenario
  try{ if (navigator.serviceWorker) navigator.serviceWorker.register = function(){ return Promise.reject(new Error("service worker desactivado en la prueba")); }; }catch(e){}
  try{ Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async function(){
    return { release: function(){}, addEventListener: function(){} }; } }}); }catch(e){}
})();`;

class Pagina {
  constructor(cdp, sessionId, nombre) {
    this.cdp = cdp; this.sid = sessionId; this.nombre = nombre;
    this.errores = []; this.dialogos = [];
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errores.push('EXCEPCION: ' + ((d.exception && d.exception.description) || d.text));
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
      await sleep(80);
    }
    let estado = '';
    try {
      estado = await this.eval(`JSON.stringify({url: location.href, telon: (document.getElementById('rp-estado')||{}).className || null, login: (document.getElementById('loginForm')||{dataset:{}}).dataset.estado,
        app: document.getElementById('app') ? !document.getElementById('app').hidden : null, aviso: (document.getElementById('loginAviso')||document.getElementById('loginError')||{}).textContent,
        verif: (document.getElementById('loginVerificando')||{}).textContent})`);
    } catch (e) { estado = '(sin estado: ' + e.message + ')'; }
    const ultimas = log.slice(-14).map((l) => (l.etiqueta || '') + ' ' + (l.host || '') + ' ' + (l.metodo || '') + ' ' + (l.ruta || '').slice(0, 90) + ' -> ' + (l.status || '-')).join(' ; ');
    throw new Error('Tiempo agotado esperando: ' + (etiqueta || fn) + ' | estado: ' + estado + ' | errores: ' + this.errores.join(' ; ') + ' | dialogos: ' + this.dialogos.join(' ; ') + ' | ultimas peticiones: ' + ultimas);
  }
  /* Espera (hasta 6 s) a que el elemento exista: la pagina puede estar a medio pintar justo despues de una navegacion o un clic. */
  async existe(selector) {
    const fin = Date.now() + 6000;
    while (Date.now() < fin) {
      try { if (await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return true; } catch (e) { /* navegando */ }
      await sleep(60);
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
    return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('no existe '+${JSON.stringify(selector)});e.click();return true;})()`);
  }
  async archivo(selector, ruta) {
    const { root } = await this.cdp.send('DOM.getDocument', { depth: 0 }, this.sid);
    const { nodeId } = await this.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, this.sid);
    await this.cdp.send('DOM.setFileInputFiles', { files: [ruta], nodeId }, this.sid);
  }
  impresos() { return this.eval('(window.__impresos || []).map(function(x){return {t:x.t,enMarco:x.enMarco,texto:x.texto};})'); }
  htmlImpresos() { return this.eval('(window.__impresos || []).map(function(x){return x.html;})'); }
}

/* ---------------- el sitio de prueba ---------------- */
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};
const RAIZ_NUEVA = process.env.PANEL_RAIZ ? path.resolve(process.env.PANEL_RAIZ) : REPO;   // PANEL_RAIZ: copia (mutada) de las paginas
const UMD = path.join(REPO, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');

/* log de TODAS las peticiones a Supabase que hace el navegador */
const log = [];
const estadoServidor = { restauranteFalla: 0, miembrosFalla: 0, respuestaRestaurante: null };   // respuestaRestaurante: lo que /api/restaurante devuelve TAL CUAL (simula un servidor o un intermediario que NO valida)

function adaptar(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { res.end(b); return res; };
  return res;
}
/* GET al sitio de un restaurante desde Node (que no resuelve *.localhost): se conecta a 127.0.0.1 con el Host de ese restaurante. */
function pedirConHost(host, puerto, ruta) {
  return new Promise((ok, mal) => {
    const rq = http.request({ host: '127.0.0.1', port: puerto, path: ruta, headers: { Host: host + ':' + puerto } }, (res) => {
      const t = []; res.on('data', (c) => t.push(c)); res.on('end', () => ok({ status: res.statusCode, texto: Buffer.concat(t).toString('utf8') }));
    });
    rq.on('error', mal); rq.end();
  });
}
const uidDeBearer = (auth) => {
  const t = String(auth || '').replace(/^Bearer\s+/i, '');
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')).sub; } catch (e) { return null; }
};

function crearSitio({ raiz, puerto, falsoUrl, rutaApi, globalName, rt, etiqueta }) {
  raiz = path.resolve(raiz);
  const api = {};
  /* La API se llama como la llamaria Vercel: vercel.json decide a que funcion va cada URL (emulador) y la funcion
     recibe la URL reescrita (/api/publico?_ruta=menu...) con su parametro interno. */
  async function llamarApi(req, res, url) {
    const d = EMULADOR.resolver({ metodo: req.method, ruta: url.pathname + url.search, headers: req.headers });
    if (d.tipo !== 'funcion') { res.statusCode = 404; res.end('{}'); return; }
    req.url = d.urlReescrita;
    req.query = Object.fromEntries(new URLSearchParams(d.urlReescrita.split('?')[1] || ''));
    const modulo = api[d.archivo] || (api[d.archivo] = require(path.join(path.dirname(rutaApi), d.archivo)));
    await modulo(req, res);
  }
  const origenSupabase = `http://${HOST_SUPABASE}:${puerto}`;

  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const host = String(req.headers.host || '');
      const esSupabase = host.startsWith(HOST_SUPABASE + ':');

      // ---- "Supabase" (otro origen): CORS + reenvio al falso ----
      if (esSupabase) {
        const origen = req.headers.origin || '*';
        const cors = { 'Access-Control-Allow-Origin': origen, 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'authorization, apikey, content-type',
                       'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '600' };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
        const cuerpo = await new Promise((ok) => { const t = []; req.on('data', (c) => t.push(c)); req.on('end', () => ok(Buffer.concat(t))); });
        if (estadoServidor.miembrosFalla > 0 && url.pathname.startsWith('/rest/v1/miembros')) {   // simula que la base no responde
          estadoServidor.miembrosFalla--;
          log.push({ etiqueta, metodo: req.method, ruta: url.pathname + url.search, uid: uidDeBearer(req.headers.authorization), status: 500, cuerpo: '', t: Date.now() });
          res.writeHead(500, { ...cors, 'Content-Type': 'application/json' }); res.end('{"message":"caido"}');   // (503 lo reintenta supabase-js por su cuenta; un 500 llega a la pagina)
          return;
        }
        const entrada = { etiqueta, origen: req.headers.origin || '', metodo: req.method, ruta: url.pathname + url.search, uid: uidDeBearer(req.headers.authorization),
                          tieneBearer: /^Bearer\s/i.test(req.headers.authorization || ''), cuerpo: cuerpo.length < 4000 ? cuerpo.toString('utf8') : '(grande)', t: Date.now() };
        log.push(entrada);
        const headers = {};
        for (const k of ['apikey', 'authorization', 'content-type', 'accept', 'prefer', 'x-upsert', 'accept-profile', 'content-profile', 'range']) if (req.headers[k]) headers[k] = req.headers[k];
        const r = await fetch(falsoUrl + req.url, { method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo, headers });
        entrada.status = r.status;
        res.writeHead(r.status, { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }

      // ---- el sitio del restaurante ----
      if (url.pathname === '/supabase-publico.js') {
        res.writeHead(200, { 'Content-Type': TIPOS['.js'] });
        res.end(`window.${globalName} = Object.freeze({ url: ${JSON.stringify(origenSupabase)}, publishableKey: "sb_publishable_FAKE_0000" });`);
        return;
      }
      if (url.pathname === '/__vendor/supabase.js') {
        res.writeHead(200, { 'Content-Type': TIPOS['.js'] });
        res.end(fs.readFileSync(UMD));
        return;
      }

      let nombre = null;
      if (url.pathname === '/manifest.json') nombre = 'manifest';
      else if (url.pathname.startsWith('/api/')) nombre = url.pathname.slice(5);
      if (nombre) {
        if (!['restaurante', 'manifest'].includes(nombre)) { res.writeHead(404); res.end('{}'); return; }
        const entradaApi = { etiqueta, host, metodo: req.method, ruta: url.pathname + url.search, api: true, t: Date.now(), dest: req.headers['sec-fetch-dest'], mode: req.headers['sec-fetch-mode'], cc: req.headers['cache-control'], ua: String(req.headers['user-agent']||'').slice(-30), cab: JSON.stringify(req.headers) };
        log.push(entradaApi);
        res.on('finish', () => { entradaApi.status = res.statusCode; });
        if (nombre === 'restaurante' && estadoServidor.restauranteFalla > 0) {
          estadoServidor.restauranteFalla--;
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"Servicio no disponible en este momento"}');
          return;
        }
        if (nombre === 'restaurante' && estadoServidor.respuestaRestaurante) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(estadoServidor.respuestaRestaurante));
          return;
        }
        req.query = Object.fromEntries(url.searchParams);
        await llamarApi(req, adaptar(res), url);
        return;
      }

      let ruta = decodeURIComponent(url.pathname);
      if (ruta === '/') ruta = '/index.html';
      const archivo = path.join(raiz, ruta);
      if (!archivo.startsWith(raiz) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
        const respaldo = path.join(REPO, ruta);
        if (ruta.startsWith('/Recursos/') && fs.existsSync(respaldo)) {
          res.writeHead(200, { 'Content-Type': TIPOS[path.extname(respaldo)] || 'application/octet-stream' });
          res.end(fs.readFileSync(respaldo));
          return;
        }
        res.writeHead(404); res.end('no existe');
        return;
      }
      let cuerpo = fs.readFileSync(archivo);
      if (path.extname(archivo) === '.html') {
        // el supabase-js del CDN (con su SRI) se cambia por el UMD local
        cuerpo = Buffer.from(cuerpo.toString('utf8').replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^>]*><\/script>/, '<script src="/__vendor/supabase.js"></script>'));
      }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
      res.end(cuerpo);
    } catch (e) {
      console.error('[sitio de prueba]', e);
      try { res.writeHead(500); res.end(String(e)); } catch (x) { /* ya respondio */ }
    }
  });
  servidor.on('upgrade', (req, socket) => rt.alUpgrade(req, socket));
  return new Promise((ok) => servidor.listen(puerto, '0.0.0.0', () => ok(servidor)));
}

/* ---------------- ejecucion ---------------- */
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
  const URL_FALSO = falso.url;
  process.env.SUPABASE_URL = URL_FALSO;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_FAKE_0000';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FAKE_0000';
  process.env.VERCEL_ENV = 'production';
  delete process.env.DOMINIO_BASE;
  for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_INTEGRITY_SECRET_PROD', 'WOMPI_EVENTS_SECRET_TEST', 'WOMPI_EVENTS_SECRET_PROD', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];
  const fetchOriginal = globalThis.fetch;

  /* El trigger de productos exige que la foto viva en el bucket del proyecto REAL (su URL esta escrita en el
     SQL 10). Aqui "Supabase" es supabase.localhost: se cambia solo ese prefijo en la copia de prueba. */
  {
    const fuente = fs.readFileSync(path.join(REPO, 'supabase', '10-multirestaurante.sql'), 'utf8');
    const ini = fuente.indexOf('create or replace function public.validar_producto()');
    const fin = fuente.indexOf('$$;', fuente.indexOf('as $$', ini)) + 3;
    const fn = fuente.slice(ini, fin).split('https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/')
      .join(`http://${HOST_SUPABASE}:${PUERTO_WEB}/storage/v1/object/public/productos/`);
    await falso.db.exec(fn);
  }

  const H = { apikey: 'sb_secret_FAKE_0000', 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const srv = async (metodo, ruta, cuerpo) => {
    const r = await fetchOriginal(`${URL_FALSO}/rest/v1/${ruta}`, { method: metodo, headers: H, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${metodo} ${ruta.slice(0, 70)} -> ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };
  const insertar = async (tabla, cuerpo) => { const f = await srv('POST', tabla, cuerpo); return Array.isArray(cuerpo) ? f : f[0]; };
  const parchear = (tabla, filtro, cuerpo) => srv('PATCH', `${tabla}?${filtro}`, cuerpo);
  const R = require(path.join(REPO, 'api', '_restaurante.js'));

  const horarios = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((dia) => ({ dia, abre: '00:00', cierra: '24:00', activo: true }));
  async function restaurante(clave, { nombre, config, host }) {
    const fila = await insertar('restaurantes', { slug: `test-p-${clave}-${sfx}`, nombre, estado: 'activo', config });
    await insertar('restaurante_dominios', { host: host || `${clave}.localhost`, restaurante_id: fila.id });
    await parchear('configuracion', `restaurante_id=eq.${fila.id}`, { horarios, cerrado_temporal: false });
    return fila;
  }
  async function usuario(clave) {
    const email = `u-${clave}-${sfx}@example.com`;
    const r = await fetchOriginal(`${URL_FALSO}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: 'sb_secret_FAKE_0000', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: CLAVE }) });
    if (!r.ok) throw new Error('no se pudo crear el usuario ' + clave + ': ' + await r.text());
    const u = await r.json();
    return { id: u.id, email };
  }
  const miembro = (u, r, rol, activo = true) => insertar('miembros', { user_id: u.id, restaurante_id: r.id, rol, activo });

  const configDe = (n, extra = {}) => ({
    ubicacion: { lat: 7.9, lng: -72.5 },
    publico: {
      marca: {
        logo: `Recursos/${n}/logo.png`, icono_192: `Recursos/${n}/i192.png`, emoji: n === 'alfa' ? '🍕' : '🍣',
        colores: n === 'alfa'
          ? { primario: '#112233', primario_oscuro: '#0A1522', primario_brillo: '#223344', claro: '#F0F0E8', claro_suave: '#FAFAF5', oscuro: '#0A0B0C', oscuro_2: '#15161A', acento: '#AA5500', positivo: '#006633', positivo_brillo: '#22AA66', texto_secundario: '#CCCCDD', texto_tenue: '#9999AA' }
          : { primario: '#884400', primario_oscuro: '#552200', primario_brillo: '#AA6622', claro: '#EEF2F5', claro_suave: '#F8FAFB', oscuro: '#101820', oscuro_2: '#18242E', acento: '#00AA88', positivo: '#225588', positivo_brillo: '#3377AA', texto_secundario: '#BBCCDD', texto_tenue: '#8899AA' },
        ...(n === 'alfa' ? { tipografia: { titulos: 'Bebas Neue', cuerpo: 'Open Sans' } } : {})
      }
    },
    ...extra
  });

  // ---- restaurantes y usuarios --------------------------------------------------------------------------------
  const A = await restaurante('alfa', { nombre: `Casa Alfa ${sfx}`, config: configDe('alfa') });
  const B = await restaurante('beta', { nombre: `Sushi Beta ${sfx}`, config: configDe('beta') });
  const hostil = configDe('alfa');
  Object.assign(hostil.publico.marca, {
    logo: 'javascript:window.__pwn=1', icono_192: 'data:text/html,<script>window.__pwn=1</script>', emoji: '<b>x</b>',
    colores: { primario: 'red;background:url(//evil.example/x.png)', oscuro: 'expression(alert(1))', claro: '#12345', acento: '#GGGGGG' },
    tipografia: { titulos: 'Evil;} body{display:none} /*', cuerpo: 'https://evil.example/f.css' }
  });
  const Hs = await restaurante('hostil', { nombre: '<img src=x onerror="window.__pwn=1"> Hostil' + bidi, config: hostil });
  // Taqueiros (su config es la del respaldo del servidor / SQL 12) tambien se alcanza por un dominio de prueba
  await insertar('restaurante_dominios', { host: 'taqueiros.localhost', restaurante_id: TAQUEIROS_ID });
  await parchear('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}`, { horarios, cerrado_temporal: false });

  const uA = await usuario('dueno-a'), uB = await usuario('dueno-b'), uAB = await usuario('cajero-a-dueno-b'), uDos = await usuario('dueno-ambos');
  const uNadie = await usuario('nadie'), uInactivo = await usuario('inactivo'), uCocina = await usuario('cocina-a'), uT = await usuario('dueno-taq'), uH = await usuario('dueno-hostil');
  await miembro(uA, A, 'dueno'); await miembro(uB, B, 'dueno');
  await miembro(uAB, A, 'cajero'); await miembro(uAB, B, 'dueno');
  await miembro(uDos, A, 'dueno'); await miembro(uDos, B, 'dueno');
  await miembro(uInactivo, A, 'dueno', false); await miembro(uCocina, A, 'cocina');
  await miembro(uT, { id: TAQUEIROS_ID }, 'dueno'); await miembro(uH, Hs, 'dueno');

  // ---- menu y pedidos de cada uno (MISMO id de producto y de categoria en A y en B) ------------------------------
  for (const [r, nom, cat] of [[A, 'Taco Alfa', 'Pizzas'], [B, 'Taco Beta', 'Rolls']]) {
    await insertar('categorias', [{ restaurante_id: r.id, id: 'principal', nombre: cat, emoji: '', orden: 1, activa: true }]);
    await insertar('productos', [{ restaurante_id: r.id, id: 'taco', nombre: nom, descripcion: '', precio: 10000, categoria: 'principal', orden: 1, disponible: true }]);
  }
  const ahora = new Date().toISOString();
  const pedido = (r, ref, tel, total, extra = {}) => insertar('pedidos', Object.assign({
    restaurante_id: r.id, referencia: ref, estado: 'nuevo', estado_pago: 'aprobado', cliente_nombre: 'Cliente ' + ref, cliente_telefono: tel,
    tipo_pedido: 'llevar', items: [{ id: 'taco', nombre: 'Producto de ' + ref, cantidad: 2, precio: total / 2 }], subtotal: total, costo_domicilio: 0, total,
    pagado_en: ahora, alerta_enviada: true, impreso_en: ahora
  }, extra));
  await pedido({ id: TAQUEIROS_ID }, 'TAQ-RELLENO-1', '3009999999', 1000, { estado: 'entregado' });   // adelanta el id de la tabla respecto al numero
  await pedido({ id: TAQUEIROS_ID }, 'TAQ-RELLENO-2', '3009999998', 1000, { estado: 'entregado' });
  const pA1 = await pedido(A, `A1-${sfx}`, '3001110001', 9000);
  const pA2 = await pedido(A, `A2-${sfx}`, '3001110002', 7000, { estado: 'en_preparacion' });
  const pB1 = await pedido(B, `B1-${sfx}`, '3002220001', 12000);
  const pB2 = await pedido(B, `B2-${sfx}`, '3002220002', 8000, { estado: 'en_preparacion' });
  const pT1 = await pedido({ id: TAQUEIROS_ID }, `T1-${sfx}`, '3003330001', 15000);
  R.invalidarCache();

  // ---- sitios (nuevo y antiguo), Realtime falso y Chrome ----------------------------------------------------------
  const rt = crearRealtime();
  const raizAntigua = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-panel-antiguo-'));
  let hayAntiguo = true;
  try {
    for (const f of ['panel.html', 'menu-admin.html', 'historial.html', 'marca.js', 'ticket-comanda.js', 'sw.js']) {
      fs.writeFileSync(path.join(raizAntigua, f), execFileSync('git', ['show', `${COMMIT_ANTERIOR}:${f}`], { cwd: REPO, maxBuffer: 20e6 }));
    }
  } catch (e) { hayAntiguo = false; console.log('(sin historial de ' + COMMIT_ANTERIOR + ': se omite la comparacion con la version anterior)'); }

  const sitioNuevo = await crearSitio({ raiz: RAIZ_NUEVA, puerto: PUERTO_WEB, falsoUrl: URL_FALSO, rutaApi: path.join(REPO, 'api'), globalName: 'SUPABASE_PUBLICO', rt, etiqueta: 'nuevo' });
  const sitioAntiguo = hayAntiguo ? await crearSitio({ raiz: raizAntigua, puerto: PUERTO_ANTIGUO, falsoUrl: URL_FALSO, rutaApi: path.join(REPO, 'api'), globalName: 'TAQUEIROS_SUPABASE', rt, etiqueta: 'antiguo' }) : null;
  // (el sitio antiguo tambien apunta a "supabase.localhost" pero en SU puerto; el SQL de fotos solo vale para el nuevo)
  const URL_N = (host) => `http://${host}:${PUERTO_WEB}`;
  const URL_V = (host) => `http://${host}:${PUERTO_ANTIGUO}`;

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-panel-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PUERTO_CDP, '--user-data-dir=' + perfil,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetchOriginal('http://127.0.0.1:' + PUERTO_CDP + '/json/version')).json(); } catch (e) { await sleep(150); }
  }
  if (!version) { chrome.kill(); console.error('Chrome no abrio el puerto de depuracion'); process.exit(2); }
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.abierto;

  const abiertas = [];
  async function pagina(nombre, { ancho = 1280, alto = 900, contexto, grabadora = true } = {}) {
    const ctx = contexto || (await cdp.send('Target.createBrowserContext')).browserContextId;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = new Pagina(cdp, sessionId, nombre);
    pg.targetId = targetId; pg.contexto = ctx;
    abiertas.push(pg);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('DOM.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*', 'https://unpkg.com/*', 'https://*.jsdelivr.net/*', 'https://checkout.wompi.co/*'] }, sessionId);
    if (grabadora) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT_GRABADORA }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: false }, sessionId);
    return pg;
  }
  alIniciar = async () => {
    for (const pg of abiertas) { if (pg.cerrada) continue; pg.cerrada = true; try { await cdp.send('Target.closeTarget', { targetId: pg.targetId }); } catch (e) { /* ya cerrada */ } }
    estadoServidor.restauranteFalla = 0; estadoServidor.miembrosFalla = 0; estadoServidor.respuestaRestaurante = null;
    R.invalidarCache();
    await sleep(120);
  };

  const texto = (pg) => pg.eval('document.body.innerText');
  const variable = (pg, nombre) => pg.eval(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(nombre)}).trim()`);
  const incluyeAlguno = (t, lista) => lista.filter((x) => t.includes(x));
  const peticiones = (desde, re) => log.filter((l) => l.t >= desde && !l.api && re.test(l.metodo + ' ' + l.ruta));
  const marca = () => Date.now() - 1;

  /* Abre una pagina privada en el dominio de un restaurante y espera al login (o al telon neutro). */
  async function abrir(nombre, url, opciones) {
    const pg = await pagina(nombre, opciones);
    await pg.ir(url);
    return pg;
  }
  const loginListo = (pg) => pg.esperar(`function(){var f=document.getElementById('loginForm');return !document.getElementById('rp-estado') && f && f.dataset.estado==='listo' && !document.getElementById('loginScreen').classList.contains('hidden');}`, 15000, 'formulario de login');
  async function iniciarSesion(pg, u) {
    await loginListo(pg);
    await pg.escribir('#loginEmail', u.email); await pg.escribir('#loginPassword', CLAVE);
    await pg.clic('#loginBtn');
  }
  const panelAbierto = (pg) => pg.esperar(`function(){return !document.getElementById('app').hidden && document.getElementById('connTxt').textContent==='En vivo';}`, 15000, 'panel en vivo');
  const appAbierta = (pg) => pg.esperar(`function(){return !document.getElementById('app').hidden;}`, 15000, 'pagina abierta');
  async function panelDe(nombre, host, u, extra = {}) {
    const pg = await abrir(nombre, URL_N(host) + '/panel.html' + (extra.query || ''), extra);
    await iniciarSesion(pg, u);
    await panelAbierto(pg);
    return pg;
  }
  const numerosTablero = (pg) => pg.eval(`Array.from(document.querySelectorAll('#board .pedido .pedido-num')).map(function(e){return e.textContent;}).sort().join(',')`);
  const clientesTablero = (pg) => pg.eval(`Array.from(document.querySelectorAll('#board .pedido .pedido-cliente')).map(function(e){return e.textContent;}).sort().join(' | ')`);

  // ===========================================================================================================
  //   ESCENARIOS
  // ===========================================================================================================

  // ---- ayudas de las pruebas de menu-admin ----
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ARCHIVO_FOTO = path.join(os.tmpdir(), `taq-foto-${sfx}.png`);
  fs.writeFileSync(ARCHIVO_FOTO, Buffer.from(PNG_B64, 'base64'));
  const filaProd = async (r, id) => (await srv('GET', `productos?restaurante_id=eq.${r.id}&id=eq.${id}&select=*`))[0] || null;
  const filaCat = async (r, id) => (await srv('GET', `categorias?restaurante_id=eq.${r.id}&id=eq.${id}&select=*`))[0] || null;
  const objetosFoto = async (patron) => (await falso.db.query(`select name, owner from storage.objects where bucket_id = 'productos' and name like $1`, [patron])).rows;
  const esperarDb = async (fn, etiqueta, ms = 10000) => {
    const fin = Date.now() + ms;
    while (Date.now() < fin) { try { if (await fn()) return true; } catch (e) { /* aun no */ } await sleep(120); }
    throw new Error('Tiempo agotado esperando en la base: ' + etiqueta);
  };
  const toastTexto = (pg) => pg.eval(`document.getElementById('toast').textContent`);


  // ---------------------------------------------------------------------------------------------------------
  await escenario('1. La marca de cada restaurante en las tres paginas (nombre, logo, favicon, colores, tipografias, titulo)', async () => {
    const paginas = [['panel.html', 'Panel de Comandas'], ['menu-admin.html', 'Administrar Menú'], ['historial.html', 'Historial y Resumen']];
    for (const [archivo, titulo] of paginas) {
      const a = await abrir('alfa-' + archivo, URL_N('alfa.localhost') + '/' + archivo);
      const b = await abrir('beta-' + archivo, URL_N('beta.localhost') + '/' + archivo);
      await loginListo(a); await loginListo(b);
      comprobar(await a.eval('document.title') === `${titulo} | Casa Alfa ${sfx}` && await b.eval('document.title') === `${titulo} | Sushi Beta ${sfx}`,
        `${archivo}: el titulo lleva el nombre de cada restaurante`, await a.eval('document.title') + ' // ' + await b.eval('document.title'));
      comprobar(await a.eval(`document.querySelector('#loginForm img').getAttribute('src')`) === 'Recursos/alfa/logo.png'
        && await b.eval(`document.querySelector('#loginForm img').getAttribute('src')`) === 'Recursos/beta/logo.png', `${archivo}: cada uno con su logo`);
      comprobar(await a.eval(`document.querySelector('#loginForm img').getAttribute('alt')`) === `Casa Alfa ${sfx}`, `${archivo}: el logo lleva el nombre como texto alternativo`);
      comprobar(await a.eval(`Array.from(document.querySelectorAll('link[rel=icon],link[rel=apple-touch-icon]')).map(function(l){return l.getAttribute('rel')+':'+l.getAttribute('href');}).sort().join(',')`) === 'apple-touch-icon:/Recursos/alfa/logo.png,icon:/Recursos/alfa/logo.png',
        `${archivo}: favicon y apple-touch-icon son el logo del restaurante (y el icono provisional vacio ya no esta)`, await a.eval(`Array.from(document.querySelectorAll('link[rel=icon],link[rel=apple-touch-icon]')).map(function(l){return l.getAttribute('rel')+':'+l.getAttribute('href');}).join(',')`));
      comprobar(await variable(a, '--rojo') === '#112233' && await variable(b, '--rojo') === '#884400' && await variable(a, '--carbon') === '#0A0B0C' && await variable(b, '--carbon') === '#101820'
        && await variable(a, '--carbon-rgb') === '10,11,12' && await variable(b, '--mostaza') === '#00AA88', `${archivo}: los colores de cada marca se aplican como variables (y sus versiones rgb)`);
      comprobar(await variable(a, '--texto-secundario') === '#9999AA' && await variable(b, '--texto-secundario') === '#8899AA',
        `${archivo}: el texto secundario de estas paginas es el "tenue" de la marca`);
      comprobar(await a.eval(`getComputedStyle(document.querySelector('.login-card button')).backgroundColor`) === 'rgb(17, 34, 51)'
        && await b.eval(`getComputedStyle(document.querySelector('.login-card button')).backgroundColor`) === 'rgb(136, 68, 0)', `${archivo}: el boton de entrar se pinta con el color primario de cada uno`);
      comprobar(await a.eval(`document.querySelector('meta[name=theme-color]').content`) === '#112233' && await b.eval(`document.querySelector('meta[name=theme-color]').content`) === '#884400', `${archivo}: el color de la barra del navegador es el primario`);
      // tipografias: A eligio Bebas Neue + Open Sans; B no eligio y queda con las de siempre
      const fuentesA = await a.eval(`Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(function(l){return l.href;}).join('|')`);
      const fuentesB = await b.eval(`Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(function(l){return l.href;}).join('|')`);
      comprobar(fuentesA === 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Open+Sans:wght@400;500;600;700;800&display=swap', `${archivo}: A carga Bebas Neue y Open Sans (direccion armada con la lista permitida)`, fuentesA);
      comprobar(fuentesB === 'https://fonts.googleapis.com/css2?family=Anton&family=Libre+Franklin:wght@400;500;600;700;800&display=swap', `${archivo}: B (sin eleccion) carga las de siempre: Anton y Libre Franklin`, fuentesB);
      comprobar(await variable(a, '--fuente-titulos') === "'Bebas Neue', sans-serif" && await variable(a, '--fuente-cuerpo') === "'Open Sans', sans-serif"
        && await variable(b, '--fuente-titulos') === "'Anton', sans-serif" && await variable(b, '--fuente-cuerpo') === "'Libre Franklin', sans-serif", `${archivo}: las variables de tipografia`);
      comprobar(/Open Sans/.test(await a.eval('getComputedStyle(document.body).fontFamily')) && /Libre Franklin/.test(await b.eval('getComputedStyle(document.body).fontFamily'))
        && /Bebas Neue/.test(await a.eval(`getComputedStyle(document.querySelector('.login-card h1')).fontFamily`)) && /Anton/.test(await b.eval(`getComputedStyle(document.querySelector('.login-card h1')).fontFamily`)),
        `${archivo}: el cuerpo y los titulos usan la tipografia de cada restaurante`);
      const ta = await texto(a), tb = await texto(b);
      comprobar(incluyeAlguno(ta, ['Taqueiros', 'Beta']).length === 0 && incluyeAlguno(tb, ['Taqueiros', 'Alfa']).length === 0, `${archivo}: ninguno muestra el nombre del otro ni el de Taqueiros`);
      comprobar(a.errores.length === 0 && b.errores.length === 0, `${archivo}: sin errores de JavaScript`, a.errores.concat(b.errores).join(' | '));
    }
    // El manifest de la PWA tambien es por restaurante
    const m = JSON.parse((await pedirConHost('alfa.localhost', PUERTO_WEB, '/manifest.json')).texto);
    const mb = JSON.parse((await pedirConHost('beta.localhost', PUERTO_WEB, '/manifest.json')).texto);
    comprobar(m.name === `Panel Casa Alfa ${sfx}` && mb.name === `Panel Sushi Beta ${sfx}` && m.theme_color === '#112233', 'el manifest de la PWA lleva el nombre y el color de cada restaurante', JSON.stringify([m.name, mb.name, m.theme_color]));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('2. Datos hostiles en la configuracion: no se ejecutan ni se inyectan (tipografias fuera de la lista incluidas)', async () => {
    for (const archivo of ['panel.html', 'menu-admin.html', 'historial.html']) {
      const pg = await abrir('hostil-' + archivo, URL_N('hostil.localhost') + '/' + archivo);
      await loginListo(pg);
      const r = await pg.eval(`(function(){var cs=function(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();};return {
        pwn: typeof window.__pwn, imgs: document.querySelectorAll('img[src=x],[onerror],[onload]').length, svg: document.querySelectorAll('body svg:not(.lupa)').length,
        rojo: cs('--rojo'), carbon: cs('--carbon'), claro: cs('--crema'), acento: cs('--mostaza'), titulos: cs('--fuente-titulos'), cuerpo: cs('--fuente-cuerpo'),
        estilos: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(function(l){return l.href;}).join('|'),
        styleAttr: document.documentElement.getAttribute('style') || '', logoDisplay: getComputedStyle(document.querySelector('#loginForm img')).display,
        logoSrc: document.querySelector('#loginForm img').getAttribute('src'),
        iconos: Array.from(document.querySelectorAll('link[rel=icon],link[rel=apple-touch-icon]')).map(function(l){return l.href;}).join('|'),
        titulo: document.title, tema: document.querySelector('meta[name=theme-color]').content, nombreEls: Array.from(document.querySelectorAll('[data-marca-nombre]')).map(function(e){return e.textContent;})
      };})()`);
      comprobar(r.pwn === 'undefined' && r.imgs === 0 && r.svg === 0, `${archivo}: nada de la configuracion se ejecuto ni se inyecto`, JSON.stringify(r));
      comprobar(r.rojo === '#3B5B8C' && r.carbon === '#16181D' && r.claro === '#F2F2F2' && r.acento === '#D4A72C' && !/evil|url\(|expression/i.test(r.styleAttr),
        `${archivo}: los colores invalidos se descartan (quedan los neutros) y no queda CSS ajeno en el estilo`, JSON.stringify([r.rojo, r.carbon, r.claro, r.acento, r.styleAttr]));
      comprobar(r.titulos === "'Anton', sans-serif" && r.cuerpo === "'Libre Franklin', sans-serif"
        && r.estilos === 'https://fonts.googleapis.com/css2?family=Anton&family=Libre+Franklin:wght@400;500;600;700;800&display=swap' && !/evil/i.test(r.estilos),
        `${archivo}: una tipografia que no esta en la lista (nombre libre o URL) se ignora y quedan las de siempre; no se carga nada de otro origen`, JSON.stringify([r.titulos, r.cuerpo, r.estilos]));
      comprobar(r.logoDisplay === 'none' && !/javascript|data:/.test(r.iconos) && !/javascript|data:/.test(String(r.logoSrc)), `${archivo}: el logo javascript: y el icono data: no se usan`, JSON.stringify([r.logoDisplay, r.logoSrc, r.iconos]));
      comprobar(r.nombreEls.every((n) => n === '<img src=x onerror="window.__pwn=1"> Hostil') && r.titulo.includes('<img src=x onerror="window.__pwn=1"> Hostil'), `${archivo}: el nombre hostil se ve como texto literal (sin el caracter bidi)`, JSON.stringify([r.nombreEls, r.titulo]));
      comprobar(pg.errores.length === 0, `${archivo}: sin errores de JavaScript`, pg.errores.join(' | '));
    }
    // y con la sesion iniciada, el panel del restaurante hostil muestra el nombre como texto
    const p = await panelDe('hostil-panel', 'hostil.localhost', uH);
    const nombre = await p.eval(`document.querySelector('.brand strong').textContent`);
    comprobar(nombre === '<img src=x onerror="window.__pwn=1"> Hostil' && await p.eval('typeof window.__pwn') === 'undefined' && await p.eval(`document.querySelectorAll('.brand img[src=x], #menuLateral img[src=x]').length`) === 0,
      'con sesion: el nombre hostil sale como texto en la barra y en el menu', nombre);

    // el horario tambien viene de la base y se escribe dentro de atributos: una hora hostil no se ejecuta
    // (desde el SQL 15 la base ya no deja guardar un horario asi: se apaga SOLO ese trigger un momento para dejar el dato viejo y hostil que la pagina tiene que resistir)
    await falso.db.exec('alter table public.configuracion disable trigger configuracion_validar');
    await parchear('configuracion', `restaurante_id=eq.${Hs.id}`, { horarios: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((dia, i) => (i === 0
      ? { dia, abre: '"><img src=x onerror=window.__pwn=1>', cierra: 'x" autofocus onfocus="window.__pwn=1', activo: true } : { dia, abre: '08:30', cierra: '24:00', activo: true })) });
    await falso.db.exec('alter table public.configuracion enable trigger configuracion_validar');
    await p.ir(URL_N('hostil.localhost') + '/panel.html');
    await panelAbierto(p);
    await p.clic('#menuBtn'); await sleep(450); await p.clic('#horariosBtn'); await sleep(300);
    const h = await p.eval(`JSON.stringify({ pwn: typeof window.__pwn, imgs: document.querySelectorAll('#filasHorario img, #filasHorario [onfocus], #filasHorario [onerror]').length,
      abre: document.querySelector('#filasHorario .fila-dia .abre').value, cierra: document.querySelector('#filasHorario .fila-dia .cierra').value,
      lunes: document.querySelectorAll('#filasHorario .fila-dia .abre')[1].value })`);
    comprobar(JSON.parse(h).pwn === 'undefined' && JSON.parse(h).imgs === 0 && JSON.parse(h).abre === '11:00' && JSON.parse(h).cierra === '22:00' && JSON.parse(h).lunes === '08:30',
      'un horario hostil en la base no se ejecuta (la hora invalida queda en el valor por defecto) y los horarios validos se ven', h);
    comprobar(p.errores.length === 0, 'sin errores de JavaScript', p.errores.join(' | '));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('2b. Aunque el servidor (o un intermediario) mande datos hostiles SIN validar, el navegador los descarta', async () => {
    // El navegador no confia en el servidor: reconstruye lo que llega campo por campo (restaurante-publico.js) y vuelve a revisar al aplicarlo
    estadoServidor.respuestaRestaurante = {
      id: A.id, slug: 'x', nombre: 'Casa <img/src=x/onerror=window.__pwn=1>' + bidi, zona_horaria: 'America/Bogota', moneda: 'COP',
      modulos: { pasarela: true, seguimiento: true, comandas: true, impresion: true }, servicio: { estado: 'activo', sirve: true, motivo: null },
      marca: { logo: 'javascript:window.__pwn=1', icono_192: 'https://evil.example/i.png', icono_512: 'Recursos/../../x.png', emoji: '<b>x</b>',
        colores: { primario: 'red;background:url(//evil.example/x.png)', oscuro: 'expression(alert(1))', claro: '#12345', acento: '#GGGGGG', positivo: 'rgb(1,2,3)', claro_suave: '#112233 url(//evil.example/y.png)' },
        colores_zonas: ['url(x)', 7], tipografia: { titulos: 'Evil;} body{display:none} /*', cuerpo: 'https://evil.example/f.css' } },
      textos: {}, contacto: { whatsapp: '"><script>' }, ubicacion: null, domicilio: { ofrece: false, tarifas: [] }, pago: { disponible: false }
    };
    for (const archivo of ['panel.html', 'menu-admin.html', 'historial.html']) {
      const pg = await abrir('crudo-' + archivo, URL_N('alfa.localhost') + '/' + archivo);
      await loginListo(pg);
      const r = await pg.eval(`(function(){var cs=function(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();};return {
        pwn: typeof window.__pwn, imgs: document.querySelectorAll('img[src=x],[onerror],[onload]').length,
        rojo: cs('--rojo'), carbon: cs('--carbon'), claro: cs('--crema'), acento: cs('--mostaza'), verde: cs('--verde'), suave: cs('--crema-suave'),
        titulos: cs('--fuente-titulos'), cuerpo: cs('--fuente-cuerpo'), estilos: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(function(l){return l.href;}).join('|'),
        styleAttr: document.documentElement.getAttribute('style') || '', logoDisplay: getComputedStyle(document.querySelector('#loginForm img')).display,
        iconos: Array.from(document.querySelectorAll('link[rel=icon],link[rel=apple-touch-icon]')).map(function(l){return l.href;}).join('|'), titulo: document.title };})()`);
      comprobar(r.pwn === 'undefined' && r.imgs === 0, `${archivo}: datos crudos hostiles: no se ejecuta ni se inyecta nada`, JSON.stringify(r));
      comprobar(r.rojo === '#3B5B8C' && r.carbon === '#16181D' && r.claro === '#F2F2F2' && r.acento === '#D4A72C' && r.verde === '#4F8A5B' && r.suave === '#FAFAFA' && !/evil|url\(|expression/i.test(r.styleAttr),
        `${archivo}: los colores invalidos se descartan en el navegador (un color con CSS pegado detras tambien)`, JSON.stringify([r.rojo, r.carbon, r.claro, r.acento, r.verde, r.suave, r.styleAttr]));
      comprobar(r.titulos === "'Anton', sans-serif" && r.cuerpo === "'Libre Franklin', sans-serif" && !/evil/i.test(r.estilos), `${archivo}: tipografias fuera de la lista: se ignoran en el navegador`, JSON.stringify([r.titulos, r.cuerpo, r.estilos]));
      comprobar(r.logoDisplay === 'none' && !/javascript|evil|data:/.test(r.iconos), `${archivo}: el logo javascript:, los iconos de otro origen y las rutas que suben de carpeta no se usan`, JSON.stringify([r.logoDisplay, r.iconos]));
      comprobar(pg.errores.length === 0, `${archivo}: sin errores de JavaScript`, pg.errores.join(' | '));
    }
    estadoServidor.respuestaRestaurante = null;
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('3. Dominio desconocido y servidor caido: mensaje neutro, sin consultar nada', async () => {
    const t0 = marca();
    for (const archivo of ['panel.html', 'menu-admin.html', 'historial.html']) {
      const pg = await abrir('desconocido-' + archivo, URL_N('desconocido.localhost') + '/' + archivo);
      await pg.esperar(`function(){var e=document.getElementById('rp-estado');return e&&e.className==='rp-neutro';}`, 8000, 'mensaje neutro');
      const t = await pg.eval(`(function(){ var e=document.getElementById('rp-estado'); return e.innerText; })()`);
      comprobar(/Este sitio no está disponible/i.test(t) && !/Reintentar/i.test(t), `${archivo}: dominio desconocido -> "Este sitio no está disponible"`, t);
      comprobar(incluyeAlguno(t + await pg.eval('document.title'), ['Taqueiros', 'Alfa', 'Beta', 'Panel de', 'Menú']).length === 0, `${archivo}: sin ningun dato de ningun restaurante`);
      const cubre = JSON.parse(await pg.eval(`(function(){var e=document.getElementById('rp-estado');var r=e.getBoundingClientRect();
        var el=document.elementFromPoint(innerWidth/2, innerHeight/2); return JSON.stringify({pos:getComputedStyle(e).position,w:r.width,h:r.height,iw:innerWidth,ih:innerHeight,encima:!!el&&!!el.closest('#rp-estado')});})()`));
      comprobar(cubre.pos === 'fixed' && cubre.w >= cubre.iw - 24 && cubre.h >= cubre.ih - 1 && cubre.encima, `${archivo}: el mensaje cubre toda la pantalla (el formulario de entrada no se puede usar)`, JSON.stringify(cubre));
      comprobar(await variable(pg, '--rojo') === '#3B5B8C', `${archivo}: colores neutros`);
      comprobar(pg.errores.length === 0, `${archivo}: sin errores de JavaScript`, pg.errores.join(' | '));
    }
    comprobar(peticiones(t0, /./).length === 0, 'un dominio desconocido NO hizo ninguna peticion a Supabase (ni sesion, ni datos)', JSON.stringify(peticiones(t0, /./).map((l) => l.metodo + ' ' + l.ruta).slice(0, 5)));

    estadoServidor.restauranteFalla = 1;
    const caido = await abrir('caido', URL_N('alfa.localhost') + '/panel.html');
    await caido.esperar(`function(){var e=document.getElementById('rp-estado');return e&&e.className==='rp-neutro';}`, 8000, 'mensaje de error');
    const tc = await caido.eval(`document.getElementById('rp-estado').innerText`);
    comprobar(/No pudimos cargar la página/i.test(tc) && /Reintentar/i.test(tc) && incluyeAlguno(tc, ['Alfa', 'Taqueiros']).length === 0, 'servidor caido: mensaje neutro con "Reintentar" y sin datos', tc);
    await caido.clic('#rp-estado button');
    await loginListo(caido);
    comprobar(await caido.eval('document.title') === `Panel de Comandas | Casa Alfa ${sfx}`, 'al reintentar a mano, la pagina carga con los datos del restaurante');

    // la cocina no puede quedarse en una pantalla de error: se reintenta sola
    estadoServidor.restauranteFalla = 1;
    const sola = await abrir('cae-y-vuelve', URL_N('beta.localhost') + '/panel.html');
    await sola.esperar(`function(){var e=document.getElementById('rp-estado');return e&&e.className==='rp-neutro';}`, 8000, 'mensaje de error');
    await loginListo(sola);   // (a los 8 s)
    comprobar(await sola.eval('document.title') === `Panel de Comandas | Sushi Beta ${sfx}`, 'servidor caido al abrir: la pagina se recupera SOLA (reintento automatico) sin tocar nada');
  });

  // ---------------------------------------------------------------------------------------------------------
  const rolVisible = (pg) => pg.eval(`(function(){var e=document.querySelector('[data-pr-rol]');return e && !e.hidden ? e.textContent : null;})()`);
  const aviso = (pg) => pg.eval(`(function(){var e=document.getElementById('loginAviso')||{};var r=document.getElementById('loginError')||{};return ((e.hidden?'':e.textContent)||'') + ((r.textContent)||'');})()`);
  const tokenDe = (pg) => pg.eval(`(function(){var k=Object.keys(localStorage).filter(function(x){return /^sb-.*-auth-token$/.test(x);})[0];return k ? JSON.parse(localStorage.getItem(k)).access_token : null;})()`);
  const hayToken = (pg) => pg.eval(`Object.keys(localStorage).some(function(x){return /^sb-.*-auth-token$/.test(x);})`);
  const restRaw = async (token, ruta) => {
    const r = await fetchOriginal(`${URL_FALSO}/rest/v1/${ruta}`, { headers: { apikey: 'sb_publishable_FAKE_0000', Authorization: 'Bearer ' + token } });
    return r.ok ? r.json() : { error: r.status };
  };

  await escenario('4. Membresia: quien es miembro entra, quien no recibe un mensaje claro, se cierra su sesion y no ve datos', async () => {
    // --- el dueno de A en A ---
    const t0 = marca();
    const a = await panelDe('uA en A', 'alfa.localhost', uA);
    comprobar(await rolVisible(a) === 'Tu rol: Dueño', 'el dueno ve su rol en el menu lateral: "Tu rol: Dueño"', await rolVisible(a));
    await a.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero');
    comprobar(await clientesTablero(a) === `Cliente A1-${sfx} | Cliente A2-${sfx}`, 'el tablero muestra los pedidos de A', await clientesTablero(a));
    const mias = log.filter((l) => l.t >= t0 && l.uid === uA.id && !l.api);
    const iMiembros = mias.findIndex((l) => /GET \/rest\/v1\/miembros/.test(l.metodo + ' ' + l.ruta));
    const iPedidos = mias.findIndex((l) => /GET \/rest\/v1\/pedidos/.test(l.metodo + ' ' + l.ruta));
    comprobar(iMiembros >= 0 && iPedidos > iMiembros, 'la membresia se comprueba ANTES de pedir un solo pedido', JSON.stringify(mias.map((l) => l.metodo + ' ' + l.ruta.slice(0, 60))));
    const q = mias.find((l) => /miembros/.test(l.ruta));
    comprobar(q && q.ruta.includes(`restaurante_id=eq.${A.id}`) && q.ruta.includes(`user_id=eq.${uA.id}`) && q.ruta.includes('activo=eq.true'), 'se pregunta por SU usuario, SU restaurante y solo membresias activas', q && q.ruta);
    const sinFiltro = mias.filter((l) => /GET \/rest\/v1\/(pedidos|configuracion|salud_notificaciones)/.test(l.metodo + ' ' + l.ruta) && !l.ruta.includes(`restaurante_id=eq.${A.id}`));
    comprobar(sinFiltro.length === 0, 'TODA lectura de pedidos, configuracion y salud lleva restaurante_id=eq.<A>', JSON.stringify(sinFiltro.map((l) => l.ruta)));
    const rj = mias.find((l) => /rpc\/limites_jornada/.test(l.ruta));
    comprobar(rj && JSON.parse(rj.cuerpo).p_restaurante === A.id, 'limites_jornada recibe p_restaurante = A', rj && rj.cuerpo);
    comprobar(!log.some((l) => l.t >= t0 && /\/auth\/v1\/logout/.test(l.ruta)), 'no se cerro ninguna sesion en el servidor');
    comprobar(a.errores.length === 0, 'sin errores de JavaScript', a.errores.join(' | '));

    // la sesion se restaura sin pedir la contrasena, y se vuelve a comprobar la membresia
    const t1 = marca();
    await a.ir(URL_N('alfa.localhost') + '/panel.html');
    await panelAbierto(a);
    comprobar(peticiones(t1, /GET \/rest\/v1\/miembros/).length === 1, 'al recargar (sesion guardada) vuelve a comprobar la membresia una vez');

    // --- el dueno de B en B, y el rol de cocina ---
    const b = await panelDe('uB en B', 'beta.localhost', uB);
    await b.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero B');
    comprobar(await clientesTablero(b) === `Cliente B1-${sfx} | Cliente B2-${sfx}`, 'el tablero de B muestra solo los pedidos de B', await clientesTablero(b));
    comprobar(await rolVisible(b) === 'Tu rol: Dueño', 'rol de B');
    const c = await panelDe('uCocina en A', 'alfa.localhost', uCocina);
    comprobar(await rolVisible(c) === 'Tu rol: Cocina', 'la cocina ve su rol: "Tu rol: Cocina"', await rolVisible(c));
    await c.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero cocina');
    comprobar(await clientesTablero(c) === `Cliente A1-${sfx} | Cliente A2-${sfx}`, 'cocina: el tablero sigue funcionando (lo que RLS le deja ver: pedidos)');
    comprobar(c.errores.length === 0, 'cocina: sin errores de JavaScript', c.errores.join(' | '));

    // --- quien NO tiene acceso: usuario sin membresia, membresia inactiva, y un usuario de A por el dominio de B ---
    const casos = [['sin membresia', 'alfa.localhost', uNadie], ['membresia inactiva', 'alfa.localhost', uInactivo], ['dueno de A por el dominio de B', 'beta.localhost', uA]];
    for (const [etiqueta, host, u] of casos) {
      const ini = marca();
      const pg = await abrir('rechazo ' + etiqueta, URL_N(host) + '/panel.html');
      await iniciarSesion(pg, u);
      await pg.esperar(`function(){var a=document.getElementById('loginAviso');return a && !a.hidden && a.textContent.length>0;}`, 12000, 'mensaje de rechazo');
      comprobar(await aviso(pg) === 'Tu usuario no tiene acceso a este restaurante.', `${etiqueta}: mensaje claro "Tu usuario no tiene acceso a este restaurante."`, await aviso(pg));
      comprobar(await pg.eval(`document.getElementById('app').hidden`) === true && await pg.eval(`document.querySelectorAll('#board .pedido').length`) === 0, `${etiqueta}: no se muestra el panel ni ningun pedido`);
      comprobar(await hayToken(pg) === false, `${etiqueta}: se cerro la sesion de este navegador (sin token guardado)`);
      comprobar(await pg.eval(`document.getElementById('loginForm').dataset.estado`) === 'listo', `${etiqueta}: queda el formulario para entrar con otro usuario`);
      const suyas = log.filter((l) => l.t >= ini && l.uid === u.id && !l.api);
      comprobar(suyas.every((l) => /miembros|logout\?scope=local/.test(l.ruta)) && suyas.some((l) => /miembros/.test(l.ruta)), `${etiqueta}: su sesion solo consulto la membresia (ni un pedido, ni la configuracion, ni la salud)`, JSON.stringify(suyas.map((l) => l.metodo + ' ' + l.ruta.slice(0, 70))));
      const cierres = log.filter((l) => l.t >= ini && /\/auth\/v1\/logout/.test(l.ruta));
      comprobar(cierres.length >= 1 && cierres.every((l) => /scope=local/.test(l.ruta)), `${etiqueta}: el cierre es de alcance LOCAL (solo esta sesion): nunca el global, que cerraria tambien la sesion de la cocina de su restaurante en otros equipos`, JSON.stringify(cierres.map((l) => l.ruta)));
      comprobar(await rolVisible(pg) === null, `${etiqueta}: ningun rol a la vista`);
      comprobar(pg.errores.length === 0, `${etiqueta}: sin errores de JavaScript`, pg.errores.join(' | '));
    }

    // --- lo mismo en las otras dos paginas ---
    for (const archivo of ['menu-admin.html', 'historial.html']) {
      const ini = marca();
      const pg = await abrir('rechazo ' + archivo, URL_N('beta.localhost') + '/' + archivo);
      await iniciarSesion(pg, uA);
      await pg.esperar(`function(){return document.getElementById('loginForm').dataset.estado==='listo' && /acceso/.test(document.getElementById('loginError').textContent);}`, 12000, 'rechazo');
      comprobar(await aviso(pg) === 'Tu usuario no tiene acceso a este restaurante.' && await pg.eval(`document.getElementById('app').hidden`) === true && await hayToken(pg) === false,
        `${archivo}: el dueno de A por el dominio de B recibe el mensaje, no ve nada y su sesion se cierra`, await aviso(pg));
      const suyas = log.filter((l) => l.t >= ini && l.uid === uA.id && !l.api);
      comprobar(suyas.every((l) => /miembros|logout\?scope=local/.test(l.ruta)), `${archivo}: solo consulto la membresia (y cerro su sesion local)`,JSON.stringify(suyas.map((l) => l.ruta.slice(0, 70))));
    }
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('4b. Un usuario miembro de DOS restaurantes entra a cada uno por su dominio y ve solo ese', async () => {
    const a = await panelDe('uAB en A', 'alfa.localhost', uAB);
    const b = await panelDe('uAB en B', 'beta.localhost', uAB);
    comprobar(await rolVisible(a) === 'Tu rol: Cajero' && await rolVisible(b) === 'Tu rol: Dueño', 'el rol es el de CADA restaurante: cajero en A, dueno en B', await rolVisible(a) + ' / ' + await rolVisible(b));
    // PRECONDICION: RLS le deja ver los pedidos de los dos (por eso el filtro explicito importa)
    const token = await tokenDe(b);
    const todo = await restRaw(token, 'pedidos?select=referencia,restaurante_id&referencia=like.*-' + sfx);
    comprobar(Array.isArray(todo) && new Set(todo.map((p) => p.restaurante_id)).size === 2, 'precondicion: con su sesion y SIN filtro la base le entrega los pedidos de los dos restaurantes', JSON.stringify(todo).slice(0, 200));
    await a.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero A');
    await b.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero B');
    comprobar(await clientesTablero(a) === `Cliente A1-${sfx} | Cliente A2-${sfx}`, 'en el dominio de A el tablero solo trae los pedidos de A', await clientesTablero(a));
    comprobar(await clientesTablero(b) === `Cliente B1-${sfx} | Cliente B2-${sfx}`, 'en el dominio de B el tablero solo trae los pedidos de B', await clientesTablero(b));

    // configuracion y salud: A cerrado y con el WhatsApp caido; B abierto y bien
    await parchear('configuracion', `restaurante_id=eq.${A.id}`, { cerrado_temporal: true });
    await parchear('salud_notificaciones', `restaurante_id=eq.${A.id}`, { ultimo_ok: false, fallos_seguidos: 2, ultimo_error: 'HTTP 500 de A', ultimo_intento: new Date().toISOString() });
    const a2 = await panelDe('uAB en A (2)', 'alfa.localhost', uAB);
    const b2 = await panelDe('uAB en B (2)', 'beta.localhost', uAB);
    await a2.esperar(`function(){return document.getElementById('switchTexto').textContent==='Cerrado';}`, 8000, 'A cerrado');
    comprobar(await b2.eval(`document.getElementById('switchTexto').textContent`) === 'Abierto', 'el interruptor Abierto/Cerrado es el de cada restaurante (A cerrado, B abierto)');
    await a2.esperar(`function(){return getComputedStyle(document.getElementById('avisoWhatsapp')).display!=='none';}`, 8000, 'alerta de WhatsApp');
    comprobar(await b2.eval(`getComputedStyle(document.getElementById('avisoWhatsapp')).display`) === 'none', 'la alerta de salud del WhatsApp de A aparece en A y NO en B');
    comprobar(/HTTP 500 de A/.test(await a2.eval(`document.getElementById('avisoWhatsapp').title`)), 'y trae el motivo de A');
    await parchear('configuracion', `restaurante_id=eq.${A.id}`, { cerrado_temporal: false });
    await parchear('salud_notificaciones', `restaurante_id=eq.${A.id}`, { ultimo_ok: true, fallos_seguidos: 0, ultimo_error: null });

    // historial: resumen y busqueda
    const ha = await abrir('hist A', URL_N('alfa.localhost') + '/historial.html'); await iniciarSesion(ha, uAB); await appAbierta(ha);
    const hb = await abrir('hist B', URL_N('beta.localhost') + '/historial.html'); await iniciarSesion(hb, uAB); await appAbierta(hb);
    await ha.esperar(`function(){return document.querySelectorAll('#resumen .cifra-principal').length>0;}`, 10000, 'resumen A');
    await hb.esperar(`function(){return document.querySelectorAll('#resumen .cifra-principal').length>0;}`, 10000, 'resumen B');
    const va = await ha.eval(`document.querySelector('#resumen .cifra-principal .valor').textContent`), vb = await hb.eval(`document.querySelector('#resumen .cifra-principal .valor').textContent`);
    comprobar(va === '$16.000' && vb === '$20.000', 'el resumen del dia suma solo los pedidos de cada restaurante (A $16.000, B $20.000)', va + ' / ' + vb);
    comprobar((await ha.eval(`document.getElementById('selJornada').options.length`)) === 1, 'el selector de dias de A solo trae los dias de A');
    for (const pg of [ha, hb]) { await pg.clic('.pestanas button[data-vista=buscar]'); }
    const buscar = async (pg, tel) => { await pg.escribir('#bTelefono', tel); await pg.clic('#btnBuscar'); await pg.esperar(`function(){return !/Buscando/.test(document.getElementById('resultados').innerText) && document.getElementById('resultados').innerText.length>0;}`, 8000, 'resultados'); return pg.eval(`document.getElementById('resultados').innerText`); };
    const rA = await buscar(ha, '3002220001'), rB = await buscar(hb, '3002220001');
    comprobar(/No encontramos pedidos/.test(rA) && !rA.includes('B1-'), 'en A, buscar el telefono de un cliente de B no encuentra nada', rA.slice(0, 100));
    comprobar(rB.includes(`B1-${sfx}`) && /1 pedido/.test(rB), 'en B ese mismo telefono si encuentra su pedido', rB.slice(0, 100));
    const rA2 = await buscar(ha, '3001110001');
    comprobar(rA2.includes(`A1-${sfx}`), 'y en A se encuentra el suyo');
    for (const pg of [ha, hb]) {
      await pg.escribir('#bTelefono', ''); await pg.escribir('#bReferencia', sfx); await pg.clic('#btnBuscar');
      await pg.esperar(`function(){return /pedido/.test(document.getElementById('resultados').innerText) && !/Buscando/.test(document.getElementById('resultados').innerText);}`, 8000, 'por referencia');
    }
    const refA = await ha.eval(`document.getElementById('resultados').innerText`), refB = await hb.eval(`document.getElementById('resultados').innerText`);
    comprobar(refA.includes('A1-') && refA.includes('A2-') && !refA.includes('B1-') && refB.includes('B1-') && refB.includes('B2-') && !refB.includes('A1-'),
      'buscar por parte de la referencia trae solo los pedidos de cada restaurante');
    const rpcs = log.filter((l) => /rpc\/(jornadas_con_pedidos|resumen_jornada|buscar_historial)/.test(l.ruta) && (l.uid === uAB.id));
    comprobar(rpcs.length >= 4 && rpcs.every((l) => [A.id, B.id].includes(JSON.parse(l.cuerpo).p_restaurante)), 'toda funcion del historial (jornadas, resumen, busqueda) recibe p_restaurante', JSON.stringify(rpcs.map((l) => l.ruta + ' ' + l.cuerpo.slice(0, 80))));

    // menu-admin: cada dominio ve solo su menu (el id del producto es el mismo en los dos)
    const ma = await abrir('menu A', URL_N('alfa.localhost') + '/menu-admin.html'); await iniciarSesion(ma, uAB); await appAbierta(ma);
    const mb = await abrir('menu B', URL_N('beta.localhost') + '/menu-admin.html'); await iniciarSesion(mb, uAB); await appAbierta(mb);
    await ma.esperar(`function(){return document.querySelectorAll('#contenido .producto').length>0;}`, 10000, 'menu A');
    await mb.esperar(`function(){return document.querySelectorAll('#contenido .producto').length>0;}`, 10000, 'menu B');
    const mta = await ma.eval(`document.getElementById('contenido').innerText`), mtb = await mb.eval(`document.getElementById('contenido').innerText`);
    comprobar(mta.includes('Taco Alfa') && /pizzas/i.test(mta) && !mta.includes('Taco Beta') && !/rolls/i.test(mta), 'menu-admin de A: solo la categoria y el producto de A', mta.slice(0, 120));
    comprobar(mtb.includes('Taco Beta') && /rolls/i.test(mtb) && !mtb.includes('Taco Alfa') && !/pizzas/i.test(mtb), 'menu-admin de B: solo la categoria y el producto de B', mtb.slice(0, 120));
    comprobar([a, b, a2, b2, ha, hb, ma, mb].every((p) => p.errores.length === 0), 'sin errores de JavaScript', [a, b, a2, b2, ha, hb, ma, mb].flatMap((p) => p.errores).join(' | '));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('4c. Sin red al comprobar el acceso NO es un rechazo (se reintenta solo); quitarle la membresia a alguien con el panel abierto lo saca', async () => {
    // la base no responde al abrir: no se muestra el rechazo, no se cierra la sesion, y al volver la base entra solo
    const u = await usuario('temporal'); await miembro(u, A, 'cajero');
    const pg = await abrir('sin red', URL_N('alfa.localhost') + '/panel.html');
    await iniciarSesion(pg, u);
    await panelAbierto(pg);
    estadoServidor.miembrosFalla = 1;
    await pg.ir(URL_N('alfa.localhost') + '/panel.html');       // sesion guardada: al abrir, la comprobacion falla una vez
    await pg.esperar(`function(){return /No pudimos verificar tu acceso/.test(document.getElementById('loginVerificando').textContent) && document.getElementById('loginForm').dataset.estado==='verificando';}`, 12000, 'aviso de reintento');
    comprobar(await hayToken(pg) === true && await pg.eval(`document.getElementById('app').hidden`) === true, 'el fallo de red NO cierra la sesion y no se ve el panel todavia');
    comprobar(!/no tiene acceso/.test(await aviso(pg)), 'el fallo de red NO se presenta como "no tienes acceso"');
    await panelAbierto(pg);   // a los 8 s reintenta y entra
    comprobar(await rolVisible(pg) === 'Tu rol: Cajero', 'al volver la base, el panel abre solo con su rol');

    // le quitan la membresia con el panel abierto: la siguiente comprobacion periodica lo saca y borra la pantalla
    await pg.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 8000, 'tablero');
    await parchear('miembros', `user_id=eq.${u.id}&restaurante_id=eq.${A.id}`, { activo: false });
    await pg.eval(`(function(){ var real = Date.now; Date.now = function(){ return real.call(Date) + 6 * 60 * 1000; }; document.dispatchEvent(new Event('visibilitychange')); return true; })()`);
    await pg.esperar(`function(){var a=document.getElementById('loginAviso');return document.getElementById('app').hidden && a && !a.hidden && a.textContent.length>0;}`, 10000, 'sacado del panel');
    comprobar(await aviso(pg) === 'Tu usuario no tiene acceso a este restaurante.' && await pg.eval(`document.querySelectorAll('#board .pedido').length`) === 0 && await hayToken(pg) === false,
      'sin membresia activa: mensaje claro, tablero vacio y sesion cerrada');
    comprobar(await rolVisible(pg) === null, 'y el rol desaparece');
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('5. El interruptor Abierto/Cerrado y el horario escriben SOLO en el restaurante del dominio (usuario dueno de los dos)', async () => {
    const cfgDe = async (r) => (await srv('GET', `configuracion?restaurante_id=eq.${r.id}&select=*`))[0];
    const a = await panelDe('uDos en A', 'alfa.localhost', uDos);
    await a.eval(`window.confirm = function(){ return true; }; true`);
    await a.clic('#switchLocal');
    await esperarDb(async () => (await cfgDe(A)).cerrado_temporal === true, 'A cerrado');
    comprobar((await cfgDe(B)).cerrado_temporal === false, 'cerrar el local en el dominio de A NO cierra el B (aunque el usuario es dueno de los dos)');
    await a.clic('#switchLocal');
    await esperarDb(async () => (await cfgDe(A)).cerrado_temporal === false, 'A abierto otra vez');

    await a.clic('#menuBtn'); await sleep(450); await a.clic('#horariosBtn'); await sleep(300);
    await a.eval(`document.querySelectorAll('#filasHorario .fila-dia').forEach(function(f){ f.querySelector('.abre').value = '09:00'; f.querySelector('.chk-24').checked = false; f.querySelector('.cierra').disabled = false; f.querySelector('.cierra').value = '21:00'; }); document.getElementById('mensajeCerrado').value = 'Volvemos pronto A'; true`);
    await a.clic('#guardarHorarios');
    await esperarDb(async () => (await cfgDe(A)).mensaje_cerrado === 'Volvemos pronto A', 'horario de A guardado');
    const ca = await cfgDe(A), cb = await cfgDe(B);
    comprobar(ca.horarios[0].abre === '09:00' && ca.horarios[0].cierra === '21:00', 'el horario de A cambio');
    comprobar(cb.mensaje_cerrado === null && cb.horarios[0].abre === '00:00' && cb.horarios[0].cierra === '24:00', 'el horario y el mensaje de B quedaron como estaban');
    const escrituras = log.filter((l) => l.uid === uDos.id && /^PATCH \/rest\/v1\/configuracion/.test(l.metodo + ' ' + l.ruta));
    comprobar(escrituras.length >= 3 && escrituras.every((l) => l.ruta.includes(`restaurante_id=eq.${A.id}`) && !/[?&]id=eq/.test(l.ruta)), 'las escrituras de configuracion llevan restaurante_id=eq.<A> (ya no id=eq.1)', JSON.stringify(escrituras.map((l) => l.ruta)));
    await parchear('configuracion', `restaurante_id=eq.${A.id}`, { horarios, mensaje_cerrado: null });

    // R3: un mensaje que la base (SQL 15) rechaza se explica en espanol y no se manda; uno con un caracter de
    // control que solo la base detecta muestra el motivo en vez de "No se pudo guardar el horario"
    const escriturasAntes = log.filter((l) => l.uid === uDos.id && /^PATCH \/rest\/v1\/configuracion/.test(l.metodo + ' ' + l.ruta)).length;
    for (const [valor, etiqueta] of [['Volvemos <pronto>', 'con < y >'], ['x'.repeat(301), 'de 301 caracteres']]) {
      await a.clic('#menuBtn'); await sleep(450); await a.clic('#horariosBtn'); await sleep(300);
      await a.eval(`document.getElementById('mensajeCerrado').value = ${JSON.stringify(valor)}; true`);
      await a.clic('#guardarHorarios'); await sleep(300);
      comprobar((await toastTexto(a)).includes('hasta 300 caracteres') && (await cfgDe(A)).mensaje_cerrado === null,
        `R3. un mensaje de cerrado ${etiqueta} se rechaza en el panel con el motivo y no cambia nada`, await toastTexto(a));
      await a.clic('#cancelarHorarios'); await sleep(200);
    }
    const escriturasDespues = log.filter((l) => l.uid === uDos.id && /^PATCH \/rest\/v1\/configuracion/.test(l.metodo + ' ' + l.ruta)).length;
    comprobar(escriturasDespues === escriturasAntes, 'R3. y no se mando nada a la base', `${escriturasAntes} -> ${escriturasDespues}`);
    await a.clic('#menuBtn'); await sleep(450); await a.clic('#horariosBtn'); await sleep(300);
    await a.eval(`document.getElementById('mensajeCerrado').value = 'Volvemos' + String.fromCharCode(9) + 'pronto'; true`);
    await a.clic('#guardarHorarios');
    await a.esperar(`function(){return document.getElementById('toast').textContent.indexOf('caracteres especiales') >= 0;}`, 8000, 'aviso del 23514');
    comprobar((await cfgDe(A)).mensaje_cerrado === null, 'R3. un mensaje con un tabulador (lo rechaza la base, 23514) muestra el motivo y no cambia nada');
    await a.clic('#cancelarHorarios'); await sleep(200);

    // ---- R7: 24:00 y medianoche en el horario (regla de horario-regla.js, SQL 16b) ----
    // (el panel guarda en memoria la configuracion que cargo: si la prueba la cambia por detras, se vuelve a cargar antes de abrir el horario)
    const abrirHorario = async () => { await a.eval('cargarConfiguracion().then(function(){ return true; })'); await a.clic('#menuBtn'); await sleep(450); await a.clic('#horariosBtn'); await sleep(300); };
    const fila0 = (js) => a.eval(`(function(){ var f = document.querySelector('#filasHorario .fila-dia'); ${js} })()`);
    const guardarHorario = async () => { await a.clic('#guardarHorarios'); await sleep(500); };
    await parchear('configuracion', `restaurante_id=eq.${A.id}`, { horarios: horarios.map((h, i) => (i === 1 ? { ...h, abre: '11:00', cierra: '24:00' } : { ...h, abre: '11:00', cierra: '22:00' })), mensaje_cerrado: null });
    await abrirHorario();
    comprobar(await a.eval(`(function(){ var f = document.querySelectorAll('#filasHorario .fila-dia')[1]; return f.querySelector('.chk-24').checked && f.querySelector('.cierra').disabled; })()`)
      && await a.eval(`(function(){ var f = document.querySelectorAll('#filasHorario .fila-dia')[0]; return !f.querySelector('.chk-24').checked && !f.querySelector('.cierra').disabled && f.querySelector('.cierra').value === '22:00'; })()`),
      'R7. un cierre guardado como 24:00 se ve con su casilla marcada (no como una hora vacia) y los demas dias siguen igual');
    // un cierre de madrugada vale: 18:00 a 02:00
    await fila0(`f.querySelector('.abre').value = '18:00'; f.querySelector('.cierra').value = '02:00';`);
    await guardarHorario();
    let cfg = await cfgDe(A);
    comprobar(cfg.horarios[0].abre === '18:00' && cfg.horarios[0].cierra === '02:00' && cfg.horarios[1].cierra === '24:00',
      'R7. un horario que cruza la medianoche (18:00 a 02:00) se guarda tal cual, y el 24:00 de otro dia no se pierde', JSON.stringify(cfg.horarios.slice(0, 2)));
    // pasado de la hora de corte (05:00): se explica y no se manda nada
    await abrirHorario();
    const antes = log.filter((l) => l.uid === uDos.id && /^PATCH \/rest\/v1\/configuracion/.test(l.metodo + ' ' + l.ruta)).length;
    await fila0(`f.querySelector('.abre').value = '18:00'; f.querySelector('.cierra').value = '06:00';`);
    await guardarHorario();
    comprobar((await toastTexto(a)).includes('no puede pasar de las 05:00') && (await cfgDe(A)).horarios[0].cierra === '02:00'
      && log.filter((l) => l.uid === uDos.id && /^PATCH \/rest\/v1\/configuracion/.test(l.metodo + ' ' + l.ruta)).length === antes,
      'R7. un cierre de madrugada despues de la hora de corte se rechaza con el motivo, sin mandar nada a la base', await toastTexto(a));
    // cierre igual a la apertura: tambien
    await fila0(`f.querySelector('.abre').value = '10:00'; f.querySelector('.cierra').value = '10:00';`);
    await guardarHorario();
    comprobar((await toastTexto(a)).includes('igual a la de apertura') && (await cfgDe(A)).horarios[0].cierra === '02:00', 'R7. un cierre igual a la apertura se rechaza con el motivo', await toastTexto(a));
    // 24:00 desde la casilla
    await fila0(`f.querySelector('.abre').value = '09:00'; var c = f.querySelector('.chk-24'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));`);
    comprobar(await fila0(`return f.querySelector('.cierra').disabled;`), 'R7. con la casilla 24:00 marcada la hora de cierre se apaga');
    await guardarHorario();
    cfg = await cfgDe(A);
    comprobar(cfg.horarios[0].abre === '09:00' && cfg.horarios[0].cierra === '24:00', 'R7. marcar 24:00 guarda el cierre a la medianoche', JSON.stringify(cfg.horarios[0]));
    // un dia desmarcado no se revisa aunque sus horas sean iguales
    await abrirHorario();
    await fila0(`f.querySelector('.chk-24').checked = false; f.querySelector('.chk-24').dispatchEvent(new Event('change', { bubbles: true })); f.querySelector('.abre').value = '10:00'; f.querySelector('.cierra').value = '10:00'; var c = f.querySelector('.chk-activo'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));`);
    await guardarHorario();
    cfg = await cfgDe(A);
    comprobar(cfg.horarios[0].activo === false && cfg.horarios[0].abre === '10:00' && cfg.horarios[0].cierra === '10:00', 'R7. un dia desmarcado se guarda sin revisar sus horas', JSON.stringify(cfg.horarios[0]));
    await parchear('configuracion', `restaurante_id=eq.${A.id}`, { horarios, mensaje_cerrado: null });
    comprobar(a.errores.length === 0, 'sin errores de JavaScript', a.errores.join(' | '));
  });

  // ---------------------------------------------------------------------------------------------------------

  await escenario('6. menu-admin: cada alta lleva su restaurante_id, la foto nueva va a {restaurante_id}/ y editar o borrar por id no toca el producto del otro restaurante', async () => {
    const t0 = marca();
    const ma = await abrir('menu A (dueno de ambos)', URL_N('alfa.localhost') + '/menu-admin.html');
    await iniciarSesion(ma, uDos); await appAbierta(ma);
    await ma.esperar(`function(){return document.querySelector('[data-toggle="taco"]');}`, 10000, 'producto taco');
    comprobar((await filaProd(A, 'taco')).nombre === 'Taco Alfa' && (await filaProd(B, 'taco')).nombre === 'Taco Beta', 'precondicion: A y B tienen un producto con el MISMO id ("taco") y este usuario es dueno de los dos');

    // 1) agotar (un toque)
    await ma.clic('[data-toggle="taco"]');
    await esperarDb(async () => (await filaProd(A, 'taco')).disponible === false, 'taco de A agotado');
    comprobar((await filaProd(B, 'taco')).disponible === true, 'agotar el taco en el dominio de A NO agota el taco de B (mismo id)');
    await ma.clic('[data-toggle="taco"]');
    await esperarDb(async () => (await filaProd(A, 'taco')).disponible === true, 'taco de A disponible');

    // 2) edicion rapida de precio
    await ma.clic('[data-editar="taco"]');
    await ma.escribir('.producto.abierto [data-campo="precio"]', '12000');
    await ma.clic('[data-guardar="taco"]');
    await esperarDb(async () => (await filaProd(A, 'taco')).precio === 12000, 'precio de A');
    comprobar((await filaProd(B, 'taco')).precio === 10000, 'cambiar el precio en A NO cambia el del taco de B');

    // 2b) edicion completa por el formulario (nombre, categoria, foto...)
    await ma.clic('.prod-info[data-abrir="taco"]');
    await ma.esperar(`function(){return !!document.getElementById('fNombre');}`, 5000, 'formulario de edicion');
    await ma.escribir('#fNombre', 'Taco Alfa Editado');
    await ma.clic('#fGuardar');
    await esperarDb(async () => (await filaProd(A, 'taco')).nombre === 'Taco Alfa Editado', 'nombre de A editado por el formulario');
    comprobar((await filaProd(B, 'taco')).nombre === 'Taco Beta', 'editar el producto por el formulario en A NO cambia el taco de B');
    await ma.esperar(`function(){return !document.getElementById('hoja').classList.contains('abierta');}`, 8000, 'formulario cerrado');

    // 3) renombrar y ocultar la categoria (mismo id "principal" en los dos)
    await ma.clic('[data-cat-renombrar="principal"]');
    await ma.esperar(`function(){return !!document.getElementById('cNombre');}`, 5000, 'formulario de categoria');
    await ma.escribir('#cNombre', 'Pizzas Renombradas');
    await ma.eval(`document.getElementById('cForm').requestSubmit(); true`);
    await esperarDb(async () => (await filaCat(A, 'principal')).nombre === 'Pizzas Renombradas', 'categoria de A renombrada');
    comprobar((await filaCat(B, 'principal')).nombre === 'Rolls', 'renombrar la categoria en A NO renombra la de B');
    await ma.clic('[data-cat-toggle="principal"]');
    await esperarDb(async () => (await filaCat(A, 'principal')).activa === false, 'categoria de A oculta');
    comprobar((await filaCat(B, 'principal')).activa === true, 'ocultar la categoria en A NO la oculta en B');
    await ma.clic('[data-cat-toggle="principal"]');
    await esperarDb(async () => (await filaCat(A, 'principal')).activa === true, 'categoria de A visible');

    // 4) producto nuevo + categoria nueva + foto nueva
    await ma.clic('#btnAgregar');
    await ma.esperar(`function(){return !!document.getElementById('fNombre');}`, 5000, 'formulario de producto');
    await ma.escribir('#fNombre', 'Producto nuevo A'); await ma.escribir('#fPrecio', '15000');
    await ma.clic('#fCatToggle'); await ma.escribir('#fCatNueva', 'Entradas ' + sfx);
    await ma.archivo('#fFotoInput', ARCHIVO_FOTO);
    await ma.esperar(`function(){return /Foto lista/.test(document.getElementById('fFotoNota').textContent);}`, 10000, 'foto preparada');
    await ma.clic('#fGuardar');
    await esperarDb(async () => (await srv('GET', `productos?nombre=eq.${encodeURIComponent('Producto nuevo A')}&select=*`)).length === 1, 'producto nuevo');
    const nuevo = (await srv('GET', `productos?nombre=eq.${encodeURIComponent('Producto nuevo A')}&select=*`))[0];
    comprobar(nuevo.restaurante_id === A.id, 'el producto nuevo se guardo con restaurante_id = A', nuevo.restaurante_id);
    const catNueva = (await srv('GET', `categorias?nombre=eq.${encodeURIComponent('Entradas ' + sfx)}&select=*`));
    comprobar(catNueva.length === 1 && catNueva[0].restaurante_id === A.id && nuevo.categoria === catNueva[0].id, 'la categoria nueva tambien lleva restaurante_id = A y el producto apunta a ella', JSON.stringify(catNueva));
    const prefijo = `http://${HOST_SUPABASE}:${PUERTO_WEB}/storage/v1/object/public/productos/${A.id}/p-`;
    comprobar(String(nuevo.imagen).startsWith(prefijo) && /\.(webp|jpg)$/.test(nuevo.imagen), 'la foto nueva se guardo en la carpeta {restaurante_id}/ del bucket', nuevo.imagen);
    const objs = await objetosFoto(`${A.id}/p-%`);
    comprobar(objs.length === 1 && nuevo.imagen.endsWith(objs[0].name), 'el archivo existe en Storage dentro de la carpeta de A', JSON.stringify(objs));
    comprobar((await objetosFoto('p-%')).length === 0, 'nada se escribio en la RAIZ del bucket');
    comprobar((await srv('GET', `productos?restaurante_id=eq.${B.id}&nombre=eq.${encodeURIComponent('Producto nuevo A')}&select=id`)).length === 0, 'B no recibio nada');

    // 5) borrar el producto nuevo: se borra su foto de la carpeta; y borrar el taco de A no toca el de B
    await ma.clic(`.prod-info[data-abrir="${nuevo.id}"]`);
    await ma.esperar(`function(){return !!document.getElementById('fEliminar');}`, 5000, 'formulario de edicion');
    await ma.clic('#fEliminar'); await ma.clic('#fConfSi');
    await esperarDb(async () => (await filaProd(A, nuevo.id)) === null, 'producto nuevo borrado');
    await esperarDb(async () => (await objetosFoto(`${A.id}/p-%`)).length === 0, 'foto borrada de la carpeta');
    comprobar(true, 'al borrar el producto se borra su foto de la carpeta del restaurante');
    await ma.clic('.prod-info[data-abrir="taco"]');
    await ma.esperar(`function(){return !!document.getElementById('fEliminar');}`, 5000, 'formulario del taco');
    await ma.clic('#fEliminar'); await ma.clic('#fConfSi');
    await esperarDb(async () => (await filaProd(A, 'taco')) === null, 'taco de A borrado');
    comprobar((await filaProd(B, 'taco')) !== null && (await filaProd(B, 'taco')).nombre === 'Taco Beta', 'borrar el taco en A NO borra el taco de B');
    // se restaura el taco de A para los demas escenarios
    await insertar('productos', { restaurante_id: A.id, id: 'taco', nombre: 'Taco Alfa', descripcion: '', precio: 10000, categoria: 'principal', orden: 1, disponible: true });
    await parchear('categorias', `restaurante_id=eq.${A.id}&id=eq.principal`, { nombre: 'Pizzas' });

    // 6) en el dominio de B, mismo usuario: su alta va a B y su foto a la carpeta de B
    const mb = await abrir('menu B (dueno de ambos)', URL_N('beta.localhost') + '/menu-admin.html');
    await iniciarSesion(mb, uDos); await appAbierta(mb);
    await mb.esperar(`function(){return document.querySelector('[data-toggle="taco"]');}`, 10000, 'producto taco en B');
    await mb.clic('#btnAgregar');
    await mb.esperar(`function(){return !!document.getElementById('fNombre');}`, 5000, 'formulario');
    await mb.escribir('#fNombre', 'Producto nuevo B'); await mb.escribir('#fPrecio', '9000');
    await mb.eval(`(function(){var s=document.getElementById('fCategoria');s.value='principal';s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await mb.archivo('#fFotoInput', ARCHIVO_FOTO);
    await mb.esperar(`function(){return /Foto lista/.test(document.getElementById('fFotoNota').textContent);}`, 10000, 'foto preparada');
    await mb.clic('#fGuardar');
    await esperarDb(async () => (await srv('GET', `productos?nombre=eq.${encodeURIComponent('Producto nuevo B')}&select=*`)).length === 1, 'producto de B');
    const nb = (await srv('GET', `productos?nombre=eq.${encodeURIComponent('Producto nuevo B')}&select=*`))[0];
    comprobar(nb.restaurante_id === B.id && nb.categoria === 'principal' && String(nb.imagen).includes(`/productos/${B.id}/p-`), 'en el dominio de B el alta lleva restaurante_id = B y la foto va a la carpeta de B', JSON.stringify([nb.restaurante_id, nb.imagen]));
    comprobar((await filaProd(A, nb.id)) === null && (await objetosFoto(`${A.id}/%`)).length === 0, 'A no recibio nada');
    await srv('DELETE', `productos?restaurante_id=eq.${B.id}&id=eq.${nb.id}`);

    // 7) TODA escritura de las dos paginas lleva su restaurante (cuerpo o filtro) y la foto nunca va a la raiz
    const escrituras = log.filter((l) => l.t >= t0 && !l.api && /^(POST|PATCH|DELETE) \/rest\/v1\/(productos|categorias)/.test(l.metodo + ' ' + l.ruta));
    const sinRestaurante = escrituras.filter((l) => {
      const rid = l.uid ? null : null;
      if (l.metodo === 'POST') { try { return !JSON.parse(l.cuerpo).restaurante_id; } catch (e) { return true; } }
      return !/restaurante_id=eq\.[0-9a-f-]{36}/.test(l.ruta);
    });
    comprobar(escrituras.length >= 10 && sinRestaurante.length === 0, `las ${escrituras.length} escrituras a productos y categorias llevan restaurante_id explicito`, JSON.stringify(sinRestaurante.map((l) => l.metodo + ' ' + l.ruta + ' ' + l.cuerpo.slice(0, 80))));
    const subidas = log.filter((l) => l.t >= t0 && !l.api && l.metodo === 'POST' && l.ruta.startsWith('/storage/v1/object/productos/'));
    comprobar(subidas.length === 2 && subidas.every((l) => /^\/storage\/v1\/object\/productos\/[0-9a-f-]{36}\/p-[0-9a-f]+\.(webp|jpg)$/.test(l.ruta)), 'las subidas de fotos van siempre a /{restaurante_id}/p-....webp', JSON.stringify(subidas.map((l) => l.ruta)));
    comprobar(ma.errores.length === 0 && mb.errores.length === 0, 'sin errores de JavaScript', ma.errores.concat(mb.errores).join(' | '));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('6b. Storage: la raiz del bucket y la carpeta de otro restaurante estan cerradas; las fotos que ya existian siguen leyendose y borrandose donde estan', async () => {
    // (1) el dueno de A no puede escribir en la raiz ni en la carpeta de B; si en la suya
    const pa = await panelDe('token A', 'alfa.localhost', uA);
    const token = await tokenDe(pa);
    const subir = async (ruta) => {
      const r = await fetchOriginal(`${URL_FALSO}/storage/v1/object/productos/${ruta}`, { method: 'POST', headers: { apikey: 'sb_publishable_FAKE_0000', Authorization: 'Bearer ' + token, 'Content-Type': 'image/png' }, body: Buffer.from(PNG_B64, 'base64') });
      return r.ok;
    };
    comprobar(await subir(`${A.id}/prueba-propia-${sfx}.png`) === true, 'RLS: el dueno de A SI escribe en la carpeta de A');
    comprobar(await subir(`raiz-prohibida-${sfx}.png`) === false, 'RLS: el dueno de A NO escribe en la RAIZ del bucket');
    comprobar(await subir(`${B.id}/ajena-${sfx}.png`) === false, 'RLS: el dueno de A NO escribe en la carpeta de B');
    await falso.db.query(`delete from storage.objects where bucket_id = 'productos' and name like $1`, [`%${sfx}.png`]);

    // (2) Taqueiros: una foto vieja en la RAIZ se sigue mostrando y al borrar el producto se borra de la raiz; la nueva va a su carpeta
    const rutaVieja = `p-vieja-${sfx}.webp`;
    await falso.db.query(`insert into storage.objects (bucket_id, name) values ('productos', $1)`, [rutaVieja]);
    const urlVieja = `http://${HOST_SUPABASE}:${PUERTO_WEB}/storage/v1/object/public/productos/${rutaVieja}`;
    await insertar('categorias', { restaurante_id: TAQUEIROS_ID, id: 'tacos-' + sfx, nombre: 'Tacos ' + sfx, emoji: '', orden: 1, activa: true });
    await insertar('productos', { restaurante_id: TAQUEIROS_ID, id: 'taco-viejo', nombre: 'Taco con foto vieja', descripcion: '', precio: 8000, categoria: 'tacos-' + sfx, orden: 1, disponible: true, imagen: urlVieja });
    const mt = await abrir('menu Taqueiros', URL_N('taqueiros.localhost') + '/menu-admin.html');
    await iniciarSesion(mt, uT); await appAbierta(mt);
    await mt.esperar(`function(){return document.querySelector('[data-abrir="taco-viejo"]');}`, 10000, 'producto con foto');
    await mt.clic('.prod-info[data-abrir="taco-viejo"]');
    await mt.esperar(`function(){return !!document.getElementById('fFotoPrev') && !!document.querySelector('#fFotoPrev img');}`, 5000, 'vista previa');
    comprobar(await mt.eval(`document.querySelector('#fFotoPrev img').getAttribute('src')`) === urlVieja, 'la foto existente (en la raiz) se sigue leyendo de donde esta');
    // foto nueva para ese producto: va a la carpeta de Taqueiros; la vieja (raiz) se borra
    await mt.archivo('#fFotoInput', ARCHIVO_FOTO);
    await mt.esperar(`function(){return /Foto lista/.test(document.getElementById('fFotoNota').textContent);}`, 10000, 'foto nueva');
    await mt.clic('#fGuardar');
    await esperarDb(async () => String((await filaProd({ id: TAQUEIROS_ID }, 'taco-viejo')).imagen).includes(`/productos/${TAQUEIROS_ID}/p-`), 'foto nueva en la carpeta');
    await esperarDb(async () => (await objetosFoto(rutaVieja)).length === 0, 'foto vieja borrada de la raiz');
    comprobar((await objetosFoto(`${TAQUEIROS_ID}/p-%`)).length === 1, 'Taqueiros: la foto nueva fue a SU carpeta y la vieja de la raiz se borro (como antes se borraba la anterior)');
    comprobar(mt.errores.length === 0, 'sin errores de JavaScript', mt.errores.join(' | '));
    await falso.db.query(`delete from storage.objects where bucket_id = 'productos' and name like $1`, [`${TAQUEIROS_ID}/%`]);
    await srv('DELETE', `productos?restaurante_id=eq.${TAQUEIROS_ID}&id=eq.taco-viejo`);
    await srv('DELETE', `categorias?restaurante_id=eq.${TAQUEIROS_ID}&id=eq.tacos-${sfx}`);
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('6c. Si el alta falla a medias, se deshace SOLO lo creado en este restaurante (la categoria del otro con el mismo id no se toca)', async () => {
    // B ya tiene una categoria con el id que va a tener la categoria nueva de A
    await insertar('categorias', { restaurante_id: B.id, id: 'entradas-prueba', nombre: 'Entradas de B', emoji: '', orden: 2, activa: true });
    const ma = await abrir('menu A (rollback)', URL_N('alfa.localhost') + '/menu-admin.html');
    await iniciarSesion(ma, uDos); await appAbierta(ma);
    await ma.esperar(`function(){return document.querySelector('[data-toggle="taco"]');}`, 10000, 'menu');
    await ma.clic('#btnAgregar');
    await ma.esperar(`function(){return !!document.getElementById('fNombre');}`, 5000, 'formulario');
    // un nombre con un caracter de control: la pagina no lo detecta pero la base lo rechaza DESPUES de crear la categoria
    await ma.escribir('#fNombre', 'Producto' + String.fromCharCode(1) + 'roto'); await ma.escribir('#fPrecio', '9000');
    await ma.clic('#fCatToggle'); await ma.escribir('#fCatNueva', 'Entradas Prueba');
    await ma.clic('#fGuardar');
    await ma.esperar(`function(){var e=document.getElementById('fError');return e && !e.hidden && e.textContent.length>0;}`, 10000, 'error del alta');
    await sleep(600);
    comprobar((await filaCat(A, 'entradas-prueba')) === null, 'la categoria creada a medias en A se deshizo');
    comprobar((await filaCat(B, 'entradas-prueba')) !== null && (await filaCat(B, 'entradas-prueba')).nombre === 'Entradas de B', 'la categoria de B con el mismo id NO se borro');
    comprobar(ma.errores.length === 0, 'sin errores de JavaScript', ma.errores.join(' | '));
    await srv('DELETE', `categorias?restaurante_id=eq.${B.id}&id=eq.entradas-prueba`);
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('7. Realtime: cada canal pide SOLO su restaurante y el panel descarta lo ajeno aunque llegue', async () => {
    const a = await panelDe('uAB en A', 'alfa.localhost', uAB);
    const b = await panelDe('uAB en B', 'beta.localhost', uAB);
    await a.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero A');
    await b.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=2;}`, 10000, 'tablero B');

    // 1) lo que el navegador le pidio a Realtime (visto en el cable)
    const de = (r) => rt.uniones.filter((u) => u.topic.startsWith(`realtime:pedidos-panel-${r.id}-`));
    const ua = de(A), ub = de(B);
    comprobar(ua.length >= 1 && ub.length >= 1, 'cada pagina abrio su canal (el nombre lleva el id del restaurante)', JSON.stringify(rt.uniones.map((u) => u.topic)));
    const filtros = (u) => u.suscripciones.map((s) => `${s.table}:${s.filter}`).sort().join(' | ');
    comprobar(filtros(ua[ua.length - 1]) === `configuracion:restaurante_id=eq.${A.id} | pedidos:restaurante_id=eq.${A.id} | salud_notificaciones:restaurante_id=eq.${A.id}`,
      'el canal de A se suscribe a pedidos, salud_notificaciones y configuracion, las tres con filtro restaurante_id=eq.<A>', filtros(ua[ua.length - 1]));
    comprobar(filtros(ub[ub.length - 1]) === `configuracion:restaurante_id=eq.${B.id} | pedidos:restaurante_id=eq.${B.id} | salud_notificaciones:restaurante_id=eq.${B.id}`, 'el canal de B, igual con el id de B');
    comprobar(rt.uniones.every((u) => u.suscripciones.every((s) => /^restaurante_id=eq\.[0-9a-f-]{36}$/.test(s.filter || ''))), 'NINGUN canal se abrio sin filtro por restaurante');

    const base = (await srv('GET', `pedidos?referencia=eq.A1-${sfx}&select=*`))[0];
    const fila = (r, id, nombre, extra = {}) => ({ ...base, id, numero: id, restaurante_id: r.id, referencia: `RT-${id}-${sfx}`, cliente_nombre: nombre, estado: 'nuevo', ...extra });
    const instalar = (pg) => pg.eval(`window.__sonidos = 0; window.__avisos = []; window.sonar = function(){ window.__sonidos++; }; var av = window.avisar; window.avisar = function(m, e){ window.__avisos.push(m); return av(m, e); }; true`);
    await instalar(a); await instalar(b);
    const clientes = async (pg) => (await clientesTablero(pg)).split(' | ');

    // 2) un pedido nuevo de A llega a A, y solo a A (el filtro del canal)
    const entregasA = rt.emitir('pedidos', 'INSERT', fila(A, 900001, 'Cliente RT-A1'));
    await a.esperar(`function(){return /RT-A1/.test(document.getElementById('board').innerText);}`, 8000, 'pedido en vivo en A');
    comprobar(entregasA === 1, 'Realtime solo entrego el pedido de A a la suscripcion de A', 'entregas: ' + entregasA);
    comprobar(!(await clientes(b)).some((c) => c.includes('RT-A1')) && await b.eval('window.__sonidos') === 0, 'B no vio ni oyo el pedido de A');
    comprobar(await a.eval('window.__sonidos') === 1 && (await a.eval('window.__avisos')).some((m) => m.startsWith('🍕 Nuevo pedido #900001')), 'en A suena una vez y avisa "🍕 Nuevo pedido #900001" (con el emoji del restaurante, no un taco)', JSON.stringify(await a.eval('window.__avisos')));

    // 3) el servidor (o un intermediario) se salta el filtro y entrega a TODOS lo de B: A lo descarta por su cuenta
    const entregasForzadas = rt.emitir('pedidos', 'INSERT', fila(B, 900002, 'Cliente RT-B1'), { respetarFiltro: false });
    await b.esperar(`function(){return /RT-B1/.test(document.getElementById('board').innerText);}`, 8000, 'pedido en vivo en B');
    await sleep(600);
    comprobar(entregasForzadas >= 2, 'precondicion: el evento de B SI llego a las suscripciones de A y de B', 'entregas: ' + entregasForzadas);
    comprobar(!(await clientes(a)).some((c) => c.includes('RT-B1')) && await a.eval('window.__sonidos') === 1 && !(await a.eval('window.__avisos')).some((m) => /900002/.test(m)),
      'A descarta el pedido de B aunque le llegue: ni tarjeta, ni sonido, ni aviso');
    // sin restaurante_id (dato roto u hostil) tampoco entra
    const sinRid = fila(A, 900003, 'Cliente RT-SIN'); delete sinRid.restaurante_id;
    rt.emitir('pedidos', 'INSERT', sinRid, { respetarFiltro: false });
    await sleep(600);
    comprobar(!(await clientes(a)).some((c) => c.includes('RT-SIN')) && !(await clientes(b)).some((c) => c.includes('RT-SIN')), 'un evento sin restaurante_id se descarta en las dos paginas');
    // un cambio de estado de un pedido de B no mueve nada en A (mismo id de fila imposible, pero sí mismo numero)
    rt.emitir('pedidos', 'UPDATE', fila(B, 900002, 'Cliente RT-B1', { estado: 'listo' }), { respetarFiltro: false });
    await sleep(500);
    comprobar(await a.eval(`Array.from(document.querySelectorAll('#body-listo .pedido')).length`) === 0, 'un cambio de estado de B no aparece en el tablero de A');
    // el cambio de estado de un pedido de A SI se ve
    rt.emitir('pedidos', 'UPDATE', fila(A, 900001, 'Cliente RT-A1', { estado: 'listo' }));
    await a.esperar(`function(){return document.querySelectorAll('#body-listo .pedido').length===1;}`, 8000, 'pedido de A en Listo');
    comprobar(true, 'y el cambio de estado de un pedido de A si mueve su tarjeta');

    // 4) la salud del WhatsApp y el interruptor del local: cada uno oye solo lo suyo
    const saludB = { id: 0, restaurante_id: B.id, ultimo_ok: false, fallos_seguidos: 3, ultimo_error: 'HTTP 500 de B', ultimo_intento: new Date().toISOString() };
    rt.emitir('salud_notificaciones', 'UPDATE', saludB, { respetarFiltro: false });
    await b.esperar(`function(){return getComputedStyle(document.getElementById('avisoWhatsapp')).display!=='none';}`, 8000, 'alerta en B');
    comprobar(await a.eval(`getComputedStyle(document.getElementById('avisoWhatsapp')).display`) === 'none', 'la alerta de WhatsApp de B aparece en B y A la descarta (aunque le llegue)');
    rt.emitir('salud_notificaciones', 'UPDATE', { ...saludB, restaurante_id: A.id, ultimo_error: 'HTTP 500 de A' });
    await a.esperar(`function(){return getComputedStyle(document.getElementById('avisoWhatsapp')).display!=='none';}`, 8000, 'alerta en A');
    comprobar(/de A/.test(await a.eval(`document.getElementById('avisoWhatsapp').title`)) && /de B/.test(await b.eval(`document.getElementById('avisoWhatsapp').title`)), 'cada alerta trae el motivo de su restaurante');
    rt.emitir('salud_notificaciones', 'UPDATE', { ...saludB, ultimo_ok: true, fallos_seguidos: 0 }, { respetarFiltro: false });
    await b.esperar(`function(){return getComputedStyle(document.getElementById('avisoWhatsapp')).display==='none';}`, 8000, 'alerta de B resuelta');
    comprobar(getAvisoVisible(await a.eval(`getComputedStyle(document.getElementById('avisoWhatsapp')).display`)), 'resolver la alerta de B no apaga la de A');
    function getAvisoVisible(d) { return d !== 'none'; }

    const cfg = (r, cerrado) => ({ id: 0, restaurante_id: r.id, cerrado_temporal: cerrado, horarios: [], mensaje_cerrado: null });
    rt.emitir('configuracion', 'UPDATE', cfg(B, true), { respetarFiltro: false });
    await b.esperar(`function(){return document.getElementById('switchTexto').textContent==='Cerrado';}`, 8000, 'B cerrado');
    comprobar(await a.eval(`document.getElementById('switchTexto').textContent`) === 'Abierto', 'cerrar el local B desde otro dispositivo no cierra el A');
    comprobar([a, b].every((p) => p.errores.length === 0), 'sin errores de JavaScript', a.errores.concat(b.errores).join(' | '));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('9. Impresion: el pie lleva el nombre del restaurante y nunca se imprime algo de otro restaurante', async () => {
    const punto = String.fromCharCode(0xB7);
    const pieDe = (nombre) => nombre.toUpperCase() + ' ' + punto + ' PEDIDO WEB';
    const a3 = await pedido(A, `A3-${sfx}`, '3001110003', 5000, { impreso_en: null });
    const a4 = await pedido(A, `A4-${sfx}`, '3001110004', 6000, { impreso_en: null });
    const b3 = await pedido(B, `B3-${sfx}`, '3002220003', 7000, { impreso_en: null });
    // La cocina de A ya tiene activada la impresion en su equipo (clave por restaurante)
    const pa = await abrir('cocina A', URL_N('alfa.localhost') + '/panel.html');
    await pa.esperar(`function(){return !!window.PR && !!window.PR.rid;}`, 10000, 'restaurante de A');
    await pa.eval(`localStorage.setItem('panel-imprimir-v2:' + PR.rid, 'on'); true`);
    await pa.ir(URL_N('alfa.localhost') + '/panel.html');
    await iniciarSesion(pa, uDos);
    await panelAbierto(pa);
    await pa.esperar(`function(){return (window.__impresos||[]).length>=2;}`, 20000, 'tickets de A');
    await sleep(3500);
    const impA = await pa.impresos();
    const nombresA = impA.map((x) => (x.texto.match(/#\d{3,}/) || ['?'])[0]).sort().join(',');
    comprobar(impA.length === 2, `en A salieron exactamente 2 tickets (los dos pendientes de A, no el de B): salieron ${impA.length}`);
    comprobar(impA.every((x) => x.texto.replace(/\s+/g, ' ').includes(pieDe(`Casa Alfa ${sfx}`))), `el pie del ticket es "${pieDe('Casa Alfa ' + sfx)}"`, impA.map((x) => x.texto.slice(-80)).join(' // '));
    comprobar(impA.every((x) => !/PEDIDO WEB/.test(x.texto.replace(pieDe(`Casa Alfa ${sfx}`), '')) && !/TAQUEIROS|BETA/i.test(x.texto)), 'ningun otro nombre de restaurante en el ticket');
    const dbA3 = (await srv('GET', `pedidos?id=eq.${a3.id}&select=impreso_en`))[0], dbB3 = (await srv('GET', `pedidos?id=eq.${b3.id}&select=impreso_en`))[0];
    comprobar(dbA3.impreso_en && (await srv('GET', `pedidos?id=eq.${a4.id}&select=impreso_en`))[0].impreso_en, 'los pedidos de A quedaron marcados como impresos');
    comprobar(dbB3.impreso_en === null, 'el pedido pendiente de B NO se reclamo ni se imprimio desde el dominio de A (aunque RLS se lo deja ver a este usuario)');
    const reclamos = log.filter((l) => /rpc\/reclamar_impresion/.test(l.ruta) && l.uid === uDos.id);
    comprobar(reclamos.every((l) => [a3.id, a4.id].includes(JSON.parse(l.cuerpo).p_id)), 'solo se reclamaron los pedidos de A', JSON.stringify(reclamos.map((l) => l.cuerpo)));

    // reimprimir y ticket de prueba: mismo pie
    await pa.clic(`[data-reimprimir="${a3.id}"]`);
    await pa.esperar(`function(){return (window.__impresos||[]).length>=3;}`, 10000, 'reimpresion');
    await pa.clic('#menuBtn'); await sleep(400); await pa.clic('#impresionBtn'); await sleep(300); await pa.clic('#impPruebaBtn');
    await pa.esperar(`function(){return (window.__impresos||[]).length>=4;}`, 15000, 'ticket de prueba');
    const todos = await pa.impresos();
    comprobar(/REIMPRESIÓN/.test(todos[2].texto) && todos[2].texto.replace(/\s+/g, ' ').includes(pieDe(`Casa Alfa ${sfx}`)) && /TICKET DE PRUEBA/.test(todos[3].texto) && todos[3].texto.replace(/\s+/g, ' ').includes(pieDe(`Casa Alfa ${sfx}`)),
      'la reimpresion y el ticket de prueba llevan el mismo pie del restaurante');

    // La cocina de B: su pedido sale con SU pie
    const pb = await abrir('cocina B', URL_N('beta.localhost') + '/panel.html');
    await pb.esperar(`function(){return !!window.PR && !!window.PR.rid;}`, 10000, 'restaurante de B');
    await pb.eval(`localStorage.setItem('panel-imprimir-v2:' + PR.rid, 'on'); true`);
    await pb.ir(URL_N('beta.localhost') + '/panel.html');
    await iniciarSesion(pb, uDos);
    await panelAbierto(pb);
    await pb.esperar(`function(){return (window.__impresos||[]).length>=1;}`, 20000, 'ticket de B');
    await sleep(2500);
    const impB = await pb.impresos();
    comprobar(impB.length === 1 && impB[0].texto.replace(/\s+/g, ' ').includes(pieDe(`Sushi Beta ${sfx}`)) && !/ALFA/.test(impB[0].texto), `en B sale solo el pedido de B con el pie "${pieDe('Sushi Beta ' + sfx)}"`, impB.map((x) => x.texto.slice(-90)).join(' // '));
    comprobar((await srv('GET', `pedidos?id=eq.${b3.id}&select=impreso_en`))[0].impreso_en !== null, 'y el pedido de B quedo marcado como impreso');
    comprobar(pa.errores.length === 0 && pb.errores.length === 0, 'sin errores de JavaScript', pa.errores.concat(pb.errores).join(' | '));
    await parchear('pedidos', `restaurante_id=in.(${A.id},${B.id})&referencia=like.*-${sfx}`, { impreso_en: new Date().toISOString() });
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('10. Preferencias del navegador: una clave por restaurante, y las que ya tenia el equipo pasan a las nuevas', async () => {
    const legado = { 'taqueiros-panel-imprimir-v1': 'on', 'taqueiros-panel-sonido-v1': 'off', 'taqueiros-pedidos-vistos-v1': '[1,2,3]', 'taqueiros-impresos-local-v1': '[1,2]',
                     'taqueiros-panel-ticket-tamano-v1': 'grande', 'taqueiros-panel-ticket-hoja-v1': 'C', 'taqueiros-panel-sesion': 'basura' };
    const sembrar = (pg) => pg.eval(`(function(){ var l = ${JSON.stringify(legado)}; Object.keys(l).forEach(function(k){ localStorage.setItem(k, l[k]); }); return true; })()`);

    // equipo de la cocina de Taqueiros que ya tenia sus preferencias antes de actualizar
    const t = await abrir('equipo Taqueiros', URL_N('taqueiros.localhost') + '/robots-inexistente');
    await sembrar(t);
    await t.ir(URL_N('taqueiros.localhost') + '/panel.html');
    await iniciarSesion(t, uT);
    await panelAbierto(t);
    const k = await t.eval(`(function(){ var o = {}; Object.keys(localStorage).filter(function(x){return !/^sb-/.test(x);}).forEach(function(x){ o[x] = localStorage.getItem(x); }); return o; })()`);
    const rid = TAQUEIROS_ID;
    comprobar(k['panel-imprimir-v2:' + rid] === 'on' && k['panel-sonido-v2:' + rid] === 'off' && k['panel-vistos-v2:' + rid] === '[1,2,3]' && JSON.parse(k['panel-impresos-local-v2:' + rid]).includes(1) && JSON.parse(k['panel-impresos-local-v2:' + rid]).includes(2)
      && k['panel-ticket-tamano-v1'] === 'grande' && k['panel-ticket-hoja-v1'] === 'C', 'las preferencias de siempre (imprimir, sonido, vistos, impresos, tamano y hoja del ticket) pasaron a las claves nuevas', JSON.stringify(k));
    comprobar(!('taqueiros-panel-sesion' in k), 'la clave de la sesion propia que ya no se usa se borro');
    comprobar(await t.eval(`document.getElementById('estadoImpresion').textContent`) === 'ACTIVA' && await t.eval(`document.querySelector('#soundBtn .txt').textContent`) === 'Silenciado',
      'el panel arranca con la impresion ACTIVA y el sonido silenciado, como lo tenia el equipo (no se pierde nada al actualizar)');
    await t.clic('#menuBtn'); await sleep(400); await t.clic('#impresionBtn'); await sleep(300);
    comprobar(await t.eval(`document.getElementById('impTamano').value`) === 'grande' && await t.eval(`document.getElementById('impModoHoja').value`) === 'C', 'el tamano y el modo de hoja del ticket se conservan');
    // lo nuevo se guarda en las claves nuevas
    await t.clic('#impCerrarBtn'); await t.clic('#soundBtn');
    comprobar(await t.eval(`localStorage.getItem('panel-sonido-v2:${rid}')`) === 'on' && await t.eval(`localStorage.getItem('taqueiros-panel-sonido-v1')`) === 'off', 'un cambio nuevo se guarda en la clave nueva (la anterior queda como estaba)');

    // otro restaurante en otro origen: no tiene nada que migrar y nada de Taqueiros
    const ab = await panelDe('equipo A', 'alfa.localhost', uA);
    comprobar(await ab.eval(`Object.keys(localStorage).filter(function(x){return !/^sb-/.test(x);}).every(function(x){return x.indexOf('${A.id}') >= 0 || /^panel-ticket/.test(x);})`), 'en el equipo de A todas las claves llevan el id de A', await ab.eval(`Object.keys(localStorage).join(',')`));

    // con ?r= (un preview) no se heredan las preferencias de otro restaurante
    const p = await abrir('preview', URL_N('alfa.localhost') + '/robots-inexistente');
    await sembrar(p);
    await p.ir(URL_N('alfa.localhost') + '/panel.html?r=test-p-alfa-' + sfx);
    await loginListo(p);
    comprobar(await p.eval(`localStorage.getItem('panel-imprimir-v2:${A.id}')`) === null && await p.eval(`localStorage.getItem('panel-ticket-tamano-v1')`) === null, 'con ?r= en la direccion NO se migran las preferencias de otro restaurante');
    comprobar(t.errores.length === 0 && ab.errores.length === 0, 'sin errores de JavaScript', t.errores.concat(ab.errores).join(' | '));
  });

  // ---------------------------------------------------------------------------------------------------------
  const SNAP = `(function(){
    // (la opcion nueva 'Datos de mi restaurante' del menu lateral, que el dueno ve, no existia en la version anterior: no se compara)
    // las animaciones (el pulso de los pedidos nuevos) cambian el valor calculado con el tiempo: se congelan para comparar lo que la pagina DECLARA
    if (!document.getElementById('snap-quieto')) { var st = document.createElement('style'); st.id = 'snap-quieto'; st.textContent = '*,*::before,*::after{animation:none !important;transition:none !important}'; document.head.appendChild(st); }
    var out = [];
    var els = document.body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.closest('#rp-estado') || e.closest('#datosBtn') || e.closest('#ayudaMedianoche') || e.closest('label.medianoche') || e.closest('#avisoVigencia') || e.hasAttribute('data-pr-rol') || e.tagName === 'SCRIPT' || e.tagName === 'STYLE' || e.tagName === 'IFRAME') continue;
      var cs = getComputedStyle(e);
      var propios = Array.prototype.filter.call(e.childNodes, function(n){return n.nodeType === 3;}).map(function(n){return n.nodeValue.replace(/\\s+/g,' ').trim();}).filter(Boolean).join('|');
      var attrs = [];
      ['class','href','src','alt','placeholder','aria-label','target','rel','type','value','name','for','role','title','data-estado','id'].forEach(function(a){ if (e.hasAttribute(a)) attrs.push(a + '=' + e.getAttribute(a)); });
      // (sin 'opacity' ni transformaciones: las animaciones de entrada las cambian con el tiempo y no son un dato de la pagina)
      out.push([e.tagName, attrs.join(' '), propios, cs.display, cs.visibility, cs.color, cs.backgroundColor, cs.backgroundImage, cs.borderTopColor, cs.borderBottomColor,
        cs.fontSize, cs.fontFamily, cs.fontWeight, cs.textTransform, cs.letterSpacing, cs.boxShadow, cs.outlineColor, String(e.hidden)].join(' ~ '));
    }
    var vars = ['--rojo','--rojo-oscuro','--rojo-brillo','--crema','--crema-suave','--carbon','--carbon-2','--carbon-3','--mostaza','--verde','--texto-claro','--texto-secundario','--verde-brillo']
      .map(function(v){return v + '=' + getComputedStyle(document.documentElement).getPropertyValue(v).trim().toUpperCase();});
    var icono = document.querySelector('link[rel=icon]'), apple = document.querySelector('link[rel=apple-touch-icon]');
    var tema = document.querySelector('meta[name=theme-color]');
    var fuentes = Array.from(document.querySelectorAll('link[rel=stylesheet]')).map(function(l){return l.href;});
    return { filas: out, vars: vars, titulo: document.title, icono: icono ? icono.getAttribute('href') : null, apple: apple ? apple.getAttribute('href') : null,
             tema: tema ? tema.content.toUpperCase() : null, fuentes: fuentes, familiaCuerpo: getComputedStyle(document.body).fontFamily };
  })()`;

  function comparar(etiqueta, antiguo, nuevo) {
    // Cambios a proposito (documentados): los dos ejemplos de busqueda del historial dejan de ser el telefono y el prefijo de Taqueiros
    const norm = (f) => f.replace(/placeholder=(3125249438|Ej: 3001234567)/, 'placeholder=<tel>').replace(/placeholder=(TAQ-...|Código de referencia)/, 'placeholder=<ref>');
    // (y el nombre de la tipografia lleva ahora su respaldo generico, sans-serif, tambien en el unico sitio donde no lo llevaba)
    // Cambio a proposito (paso 3A, R7): la hora de cierre 24:00 ya no se pone en el <input type="time"> (no la puede mostrar: quedaba vacia) sino en la
    // casilla "24:00"; el campo queda en 00:00 y apagado. Solo cambia ese valor.
    const norm2 = (f) => norm(f).split(' ~ "Libre Franklin" ~ ').join(' ~ "Libre Franklin", sans-serif ~ ').split('class=cierra type=time value=24:00').join('class=cierra type=time value=00:00');
    const a = antiguo.filas.map(norm2), n = nuevo.filas.map(norm2);
    const diffs = [];
    if (a.length !== n.length) diffs.push(`elementos: ${a.length} antes, ${n.length} ahora`);
    for (let i = 0; i < Math.max(a.length, n.length); i++) {
      if (a[i] !== n[i] && diffs.length < 6) diffs.push(`#${i}\n      antes: ${a[i]}\n      ahora: ${n[i]}`);
    }
    if (JSON.stringify(antiguo.vars) !== JSON.stringify(nuevo.vars)) diffs.push('variables CSS: ' + JSON.stringify(antiguo.vars) + ' vs ' + JSON.stringify(nuevo.vars));
    if (antiguo.titulo !== nuevo.titulo) diffs.push(`titulo: "${antiguo.titulo}" vs "${nuevo.titulo}"`);
    const ruta = (u) => new URL(u, 'http://x/').pathname;
    // (menu-admin e historial no tenian icono de pantalla de inicio: ahora lo tienen; solo se compara si la version anterior lo traia)
    if (ruta(antiguo.icono) !== ruta(nuevo.icono) || (antiguo.apple && ruta(antiguo.apple) !== ruta(nuevo.apple))) diffs.push(`iconos: ${antiguo.icono}/${antiguo.apple} vs ${nuevo.icono}/${nuevo.apple}`);
    if (antiguo.tema !== nuevo.tema) diffs.push(`theme-color: ${antiguo.tema} vs ${nuevo.tema}`);
    if (antiguo.familiaCuerpo !== nuevo.familiaCuerpo) diffs.push(`fuente del cuerpo: ${antiguo.familiaCuerpo} vs ${nuevo.familiaCuerpo}`);
    comprobar(diffs.length === 0, `Taqueiros identico (${etiqueta}): ${a.length} elementos comparados con estilos calculados`, diffs.join('\n    '));
  }

  await escenario('11. TAQUEIROS SE VE IDENTICO (comparado con el commit ' + COMMIT_ANTERIOR + ')', async () => {
    if (!hayAntiguo) { comprobar(true, '(omitido: no hay historial git)'); return; }
    // datos de Taqueiros para el menu y un pedido recien pagado (para que el cronometro no cambie de minuto entre las dos)
    await insertar('categorias', { restaurante_id: TAQUEIROS_ID, id: 'tacos-' + sfx, nombre: 'Tacos ' + sfx, emoji: '', orden: 1, activa: true });
    await insertar('productos', [{ restaurante_id: TAQUEIROS_ID, id: 'taco-t', nombre: 'Taco de prueba', descripcion: 'Con cebolla', precio: 8000, categoria: 'tacos-' + sfx, orden: 1, disponible: true },
                                 { restaurante_id: TAQUEIROS_ID, id: 'taco-agotado', nombre: 'Taco agotado', descripcion: '', precio: 9000, categoria: 'tacos-' + sfx, orden: 2, disponible: false }]);
    await parchear('pedidos', `restaurante_id=eq.${TAQUEIROS_ID}&referencia=eq.T1-${sfx}`, { pagado_en: new Date().toISOString(), estado: 'nuevo', direccion: 'Calle 1 # 2-3', indicaciones: 'Sin cebolla', tipo_pedido: 'domicilio', distancia_km: 2.5, costo_domicilio: 5000, subtotal: 10000, total: 15000, lat: 7.9, lng: -72.5 });
    const U_N = URL_N('taqueiros.localhost'), U_V = URL_V('taqueiros.localhost');
    const par = async (archivo, alEstar) => {
      const n = await abrir('taq-nuevo ' + archivo, U_N + '/' + archivo);
      const v = await abrir('taq-viejo ' + archivo, U_V + '/' + archivo);
      await loginListo(n);
      await v.esperar(`function(){return document.getElementById('loginForm').dataset.estado==='listo';}`, 15000, 'login antiguo');
      return [v, n];
    };

    // ---- panel: pantalla de entrada ----
    const [pv, pn] = await par('panel.html');
    await sleep(500);
    comparar('panel: pantalla de entrada', await pv.eval(SNAP), await pn.eval(SNAP));
    // ---- panel: tablero con un pedido ----
    for (const pg of [pv, pn]) await iniciarSesion(pg, uT);
    for (const pg of [pv, pn]) await panelAbierto(pg);
    for (const pg of [pv, pn]) await pg.esperar(`function(){return document.querySelectorAll('#board .pedido').length>=1;}`, 10000, 'tablero');
    await sleep(700);
    comparar('panel: tablero con un pedido de domicilio', await pv.eval(SNAP), await pn.eval(SNAP));
    // ---- menu lateral, horario, configuracion de impresion ----
    for (const pg of [pv, pn]) { await pg.clic('#menuBtn'); }
    await sleep(600);
    comparar('panel: menu lateral abierto', await pv.eval(SNAP), await pn.eval(SNAP));
    for (const pg of [pv, pn]) { await pg.clic('#horariosBtn'); }
    await sleep(500);
    comparar('panel: ventana del horario', await pv.eval(SNAP), await pn.eval(SNAP));
    for (const pg of [pv, pn]) { await pg.clic('#cancelarHorarios'); await pg.clic('#menuBtn'); await sleep(450); await pg.clic('#impresionBtn'); }
    await sleep(500);
    comparar('panel: ventana de impresion', await pv.eval(SNAP), await pn.eval(SNAP));
    for (const pg of [pv, pn]) { await pg.clic('#impCerrarBtn'); }
    // el aviso de WhatsApp caido y la desconexion
    for (const pg of [pv, pn]) await pg.eval(`pintarSaludNotificaciones({ ultimo_ok: false, fallos_seguidos: 3, ultimo_intento: '2026-01-01T15:00:00Z', ultimo_error: 'HTTP 500 prueba' }); true`);
    await sleep(300);
    comparar('panel: aviso de WhatsApp caido', await pv.eval(SNAP), await pn.eval(SNAP));
    comprobar(pv.errores.length === 0 && pn.errores.length === 0, 'panel: sin errores de JavaScript en ninguna version', pv.errores.concat(pn.errores).join(' | '));

    // ---- menu-admin ----
    const [mv, mn] = await par('menu-admin.html');
    await sleep(400);
    comparar('menu-admin: pantalla de entrada', await mv.eval(SNAP), await mn.eval(SNAP));
    for (const pg of [mv, mn]) await iniciarSesion(pg, uT);
    for (const pg of [mv, mn]) await pg.esperar(`function(){return document.querySelectorAll('#contenido .producto').length>=2;}`, 12000, 'menu');
    await sleep(500);
    comparar('menu-admin: lista de productos', await mv.eval(SNAP), await mn.eval(SNAP));
    for (const pg of [mv, mn]) { await pg.clic('#btnAgregar'); }
    await sleep(600);
    comparar('menu-admin: formulario de producto nuevo', await mv.eval(SNAP), await mn.eval(SNAP));
    comprobar(mv.errores.length === 0 && mn.errores.length === 0, 'menu-admin: sin errores de JavaScript en ninguna version', mv.errores.concat(mn.errores).join(' | '));

    // ---- historial ----
    const [hv, hn] = await par('historial.html');
    await sleep(400);
    comparar('historial: pantalla de entrada', await hv.eval(SNAP), await hn.eval(SNAP));
    for (const pg of [hv, hn]) await iniciarSesion(pg, uT);
    for (const pg of [hv, hn]) await pg.esperar(`function(){return document.querySelectorAll('#resumen .cifra-principal').length>0;}`, 12000, 'resumen');
    await sleep(400);
    comparar('historial: resumen del dia', await hv.eval(SNAP), await hn.eval(SNAP));
    for (const pg of [hv, hn]) { await pg.clic('.pestanas button[data-vista=buscar]'); await pg.escribir('#bTelefono', '3003330001'); await pg.clic('#btnBuscar'); }
    for (const pg of [hv, hn]) await pg.esperar(`function(){return document.querySelectorAll('#resultados .pedido').length>0;}`, 8000, 'resultados');
    for (const pg of [hv, hn]) { await pg.clic('#resultados .ped-cab'); }
    await sleep(400);
    comparar('historial: busqueda con un pedido abierto', await hv.eval(SNAP), await hn.eval(SNAP));
    comprobar(hv.errores.length === 0 && hn.errores.length === 0, 'historial: sin errores de JavaScript en ninguna version', hv.errores.concat(hn.errores).join(' | '));
    await srv('DELETE', `productos?restaurante_id=eq.${TAQUEIROS_ID}&categoria=eq.tacos-${sfx}`);
    await srv('DELETE', `categorias?restaurante_id=eq.${TAQUEIROS_ID}&id=eq.tacos-${sfx}`);
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('12. Archivos: nada de Taqueiros escrito a mano en las paginas privadas, la libreria, el ticket ni el service worker', async () => {
    const leer = (f) => fs.readFileSync(path.join(f === 'supabase-publico.js' ? REPO : RAIZ_NUEVA, f), 'utf8');   // (en la revision por mutacion, RAIZ_NUEVA es la copia mutada)
    const prohibidos = [/Taqueiros/i, /C[uú]cuta/i, /573125249438/, /312 524/, /1AN/, /La Ceiba/, /lostaqueiros/i, /pub_(test|prod)_[A-Za-z0-9]{20}/, /vercel\.app/, /#C1272D/i, /#F7ECD6/i, /#1C1210/i, /#E3A008/i, /#8A1B1F/i, /#5C7A3B/i,
                        /#B9A88C/i, /#2E1D19/i, /#241714/i, /#FFF8EA/i, /#E14A42/i, /#7FA855/i, /Recursos\/logo/, /Birria|Doriloco|comal/i, /TAQ-/, /🌮/, /rgba\((247,236,214|227,160,8|225,74,66|193,39,45|92,122,59|127,168,85|28,18,16),/];
    for (const f of ['panel.html', 'menu-admin.html', 'historial.html', 'panel-restaurante.js']) {
      const c = leer(f);
      // permitido en la libreria: los nombres de las claves anteriores del navegador (para migrarlas)
      const limpio = f === 'panel-restaurante.js' ? c.replace(/"taqueiros-[a-z0-9-]+"/g, '"<clave-anterior>"') : c;
      const malos = prohibidos.filter((re) => re.test(limpio)).map(String);
      comprobar(malos.length === 0, `${f}: ningun valor propio de Taqueiros escrito`, malos.join(' '));
    }
    const lib = leer('panel-restaurante.js');
    const claves = lib.match(/"taqueiros-[a-z0-9-]+"/g) || [];
    comprobar(claves.length === 8 && new Set(claves).size === 8, 'la libreria solo nombra a Taqueiros en las 8 claves anteriores del navegador que migra o borra', claves.join(' '));
    const tick = leer('ticket-comanda.js').replace(/\/\*[\s\S]*?\*\//g, '');
    comprobar(!/Taqueiros/i.test(tick) && !/Los Taqueiros/i.test(tick), 'ticket-comanda.js: ni el pie ni nada de Taqueiros (fuera de comentarios)');
    const sw = leer('sw.js');
    const swSinComentarios = sw.replace(/\/\*[\s\S]*?\*\//g, '');
    comprobar(/const VERSION = "v11"/.test(sw) && /const CASCARON = \[\]/.test(sw) && (swSinComentarios.match(/taqueiros/gi) || []).length === 1 && /const CACHE_ESTATICO = "panel-estatico-"/.test(sw),
      'sw.js: version v11, sin precache, cache con nombre neutro; "taqueiros" solo aparece en el prefijo de las caches viejas que se borran');
    comprobar(/pathname === "\/manifest\.json"/.test(sw) && /startsWith\("\/api\/"\)/.test(sw) && /supabase\.co/.test(sw) && /Navegaciones|navigate/.test(sw), 'sw.js: manifest, /api/, Supabase y las paginas van siempre por la red (nada de un restaurante se guarda)');
    // el service worker solo guarda archivos estaticos de /Recursos/ y fuentes, y su cache es por origen
    comprobar(/startsWith\("\/Recursos\/"\)/.test(sw) && !/caches\.open\([^)]*\)\.then\(\(cache\) => cache\.addAll\(\[[^\]]/.test(sw), 'sw.js: solo guarda /Recursos/ y fuentes');

    // las paginas ya no cargan marca.js ni el nombre antiguo del objeto global, y todas piden la version nueva de los scripts
    for (const f of ['panel.html', 'menu-admin.html', 'historial.html', 'index.html', 'pedido.html']) {
      const c = leer(f);
      comprobar(!/marca\.js/.test(c) && !/TAQUEIROS_SUPABASE|TAQUEIROS_MARCA/.test(c) && /supabase-publico\.js\?v=2/.test(c) && /restaurante-publico\.js\?v=2/.test(c), `${f}: sin marca.js ni el nombre antiguo del objeto global; pide supabase-publico.js?v=2 y restaurante-publico.js?v=2`);
    }
    comprobar(!fs.existsSync(path.join(REPO, 'marca.js')), 'marca.js ya no existe (su unico trabajo lo hace panel-restaurante.js con los datos del servidor)');
    for (const f of ['panel.html', 'menu-admin.html', 'historial.html']) {
      const c = leer(f);
      comprobar(/<script src="restaurante-publico\.js\?v=2"><\/script>\s*<script src="panel-restaurante\.js\?v=1"><\/script>/.test(c) && /rp-estado/.test(c), `${f}: carga las dos librerias y tiene el telon de carga`);
      // ningun dato de la marca entra por innerHTML
      const peligrosas = c.split('\n').filter((l) => /innerHTML/.test(l) && /\b(PR\.R|R\.nombre|R\.marca|R\.textos|R\.contacto)\b/.test(l));
      comprobar(peligrosas.length === 0, `${f}: ningun dato del restaurante (nombre, marca, textos) se inserta con innerHTML`, peligrosas.join(' | '));
    }
    const lib2 = leer('panel-restaurante.js');
    comprobar(!/innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(lib2), 'panel-restaurante.js: sin innerHTML, insertAdjacentHTML, document.write, eval ni new Function');

    // las dos listas de tipografias (servidor y navegador) son la misma
    const { FUENTES_PERMITIDAS } = require(path.join(REPO, 'api', '_publico.js'));
    const rp = leer('restaurante-publico.js');
    const enNavegador = [...rp.matchAll(/^\s{4}"([^"]+)": \{ familia:/gm)].map((m) => m[1]);
    comprobar(enNavegador.length > 0 && JSON.stringify([...enNavegador].sort()) === JSON.stringify([...FUENTES_PERMITIDAS].sort()), 'la lista de tipografias del navegador y la del servidor son la misma', JSON.stringify([enNavegador, FUENTES_PERMITIDAS]));
    comprobar(['Anton', 'Libre Franklin'].every((n) => FUENTES_PERMITIDAS.includes(n)), 'las tipografias actuales (Anton y Libre Franklin) estan en la lista');
    // el valor por defecto de las paginas privadas es el de siempre
    for (const f of ['panel.html', 'menu-admin.html', 'historial.html']) {
      const c = leer(f);
      comprobar(/--fuente-titulos:'Anton', sans-serif/.test(c) && /--fuente-cuerpo:'Libre Franklin', sans-serif/.test(c) && !/<link[^>]*fonts\.googleapis\.com\/css2/.test(c), `${f}: por defecto Anton y Libre Franklin; ninguna URL de fuentes escrita en el HTML`);
    }
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('13. "Datos de mi restaurante": solo el dueno lo ve y lo usa, valida como la base, no pierde claves ni pisa ediciones, y no se salta fabricando la peticion', async () => {
    // (los escenarios de datos hostiles apagan el trigger de validacion de la config; aqui vale la validacion real de la base)
    await falso.db.exec('alter table public.restaurantes enable trigger restaurantes_validar_config');
    const filaR = async (r) => (await srv('GET', `restaurantes?id=eq.${r.id}&select=*`))[0];
    const sinEditable = (fila) => { const c = JSON.parse(JSON.stringify(fila.config)); if (c.publico) { delete c.publico.textos; delete c.publico.contacto; } const { nombre, ...resto } = fila; return JSON.stringify({ ...resto, config: c }); };
    const abrirMenu = async (pg) => {
      if (!(await pg.eval("document.getElementById('menuLateral').classList.contains('open')"))) await pg.clic('#menuBtn');
      await pg.esperar(`function(){return document.getElementById('menuLateral').classList.contains('open');}`, 5000, 'menu abierto');
    };
    const modalAbierto = `function(){var m=document.getElementById('modalDatos');return !!m && m.classList.contains('open') && !!document.querySelector('#datosCuerpo input');}`;
    const abrirDatos = async (pg) => {
      await abrirMenu(pg);
      await pg.clic('#datosBtn');
      await pg.esperar(modalAbierto, 10000, 'formulario abierto');
    };
    const campo = (c) => `[data-datos-campo="${c}"]`;
    const valorDe = (pg, c) => pg.eval(`document.querySelector(${JSON.stringify(campo(c))}).value`);
    const errorDe = (pg, c) => pg.eval(`(function(){var e=document.querySelector('[data-datos-error="${c}"]');return e && !e.hidden ? e.textContent : '';})()`);
    const avisoDe = (pg) => pg.eval(`(function(){var a=document.getElementById('datosAviso');return a.hidden ? '' : a.textContent;})()`);
    const cerrado = (pg) => pg.eval(`!document.getElementById('modalDatos').classList.contains('open')`);
    const guardar = async (pg) => {
      await pg.clic('#datosGuardar');
      await pg.esperar(`function(){var m=document.getElementById('modalDatos');return !document.getElementById('datosGuardar').disabled && (!m.classList.contains('open') || !document.getElementById('datosAviso').hidden || !!document.querySelector('[data-datos-error]:not([hidden])'));}`, 10000, 'resultado de guardar');
    };
    // CAPTURAS=<carpeta>: guarda imagenes del formulario (1280 y 390 de ancho) para revisarlo a ojo
    const capturar = async (pg, nombre) => {
      if (!process.env.CAPTURAS) return;
      fs.mkdirSync(process.env.CAPTURAS, { recursive: true });
      for (const [ancho, alto] of [[1280, 900], [390, 844]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: ancho < 500 }, pg.sid);
        await sleep(250);
        const img = await cdp.send('Page.captureScreenshot', { format: 'png' }, pg.sid);
        fs.writeFileSync(path.join(process.env.CAPTURAS, `${nombre}-${ancho}.png`), Buffer.from(img.data, 'base64'));
      }
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, pg.sid);
    };
    const rpcGuardar = (rid, cambios) => `db.rpc('guardar_datos_restaurante', { p_restaurante: ${JSON.stringify(rid)}, p_cambios: ${JSON.stringify(cambios)} }).then(function(r){ return { code: r.error ? r.error.code : null, ok: r.data ? r.data.ok : null }; })`;

    const uC = await usuario('dueno-gamma');
    const G = await restaurante('gamma', { nombre: `Gamma ${sfx}`, config: configDe('alfa') });
    await miembro(uC, G, 'dueno');
    R.invalidarCache();

    // ---------------------------------------------------------------------------------- quien lo ve
    const pa = await panelDe('13-dueno-a', 'alfa.localhost', uA);
    await abrirMenu(pa);
    comprobar(await pa.eval(`(function(){var b=document.getElementById('datosBtn');return !!b && !b.hidden && b.offsetParent !== null;})()`), '13a. El dueno ve "Datos de mi restaurante" en el menu lateral');
    comprobar(await pa.eval(`document.getElementById('datosBtn').textContent.indexOf('Datos de mi restaurante') >= 0`), '13a. ...con ese nombre');

    const pcaj = await panelDe('13-cajero-a', 'alfa.localhost', uAB);
    await abrirMenu(pcaj);
    comprobar(await pcaj.eval(`(function(){var b=document.getElementById('datosBtn');return !!b && b.hidden && b.offsetParent === null;})()`), '13b. Un CAJERO no ve la opcion (escondida)');
    const pcoc = await panelDe('13-cocina-a', 'alfa.localhost', uCocina);
    await abrirMenu(pcoc);
    comprobar(await pcoc.eval(`(function(){var b=document.getElementById('datosBtn');return !!b && b.hidden && b.offsetParent === null;})()`), '13b. La COCINA no ve la opcion');
    comprobar(await pcaj.eval(`DatosRestaurante.abrir({ db: db, rid: ${JSON.stringify(A.id)} }).then(function(r){ return r === false && !document.getElementById('modalDatos'); })`),
      '13b. ...y aunque alguien llame al formulario desde la consola, un cajero no lo abre');

    // ---------------------------------------------------------------------------------- fabricar la peticion
    const antesA = await filaR(A);
    const antesB = await filaR(B);
    const r1 = await pcaj.eval(rpcGuardar(A.id, [{ campo: 'textos.eslogan', antes: null, despues: 'Hackeado por el cajero' }]));
    const r2 = await pcoc.eval(rpcGuardar(A.id, [{ campo: 'textos.eslogan', antes: null, despues: 'Hackeado por la cocina' }]));
    comprobar(r1.code === '42501' && r2.code === '42501', '13c. Un cajero y la cocina NO pueden guardar aunque fabriquen la llamada (42501)', JSON.stringify([r1, r2]));
    const u1 = await pcaj.eval(`db.from('restaurantes').update({ nombre: 'Hackeado' }).eq('id', ${JSON.stringify(A.id)}).select().then(function(r){ return { n: r.data ? r.data.length : 0, code: r.error ? r.error.code : null }; })`);
    comprobar(u1.n === 0, '13c. ...ni con un UPDATE directo a la tabla', JSON.stringify(u1));

    const pb = await panelDe('13-dueno-b', 'beta.localhost', uB);
    const cruz = await pb.eval(rpcGuardar(A.id, [{ campo: 'textos.eslogan', antes: null, despues: 'Hackeado por el dueno de B' }]));
    comprobar(cruz.code === '42501', '13d. El dueno de OTRO restaurante no puede editar el de A (42501)', JSON.stringify(cruz));
    const cruzU = await pb.eval(`db.from('restaurantes').update({ nombre: 'Hackeado' }).eq('id', ${JSON.stringify(A.id)}).select().then(function(r){ return { n: r.data ? r.data.length : 0 }; })`);
    comprobar(cruzU.n === 0, '13d. ...ni con un UPDATE directo', JSON.stringify(cruzU));

    const prohibidos = ['marca.logo', 'marca.colores.primario', 'estado', 'plan', 'vigente_hasta', 'modulos', 'slug', 'wompi.llave_publica_test', 'ubicacion.lat', 'domicilio.factor_recorrido', 'textos', 'publico.textos.eslogan'];
    const codigos = [];
    for (const c of prohibidos) codigos.push((await pa.eval(rpcGuardar(A.id, [{ campo: c, antes: null, despues: 'x' }]))).code);
    comprobar(codigos.every((c) => c === '22023'), `13e. El dueno fabrica ${prohibidos.length} campos que no son suyos (marca, plan, estado, vigencia, modulos, slug, llaves, ubicacion, domicilio): todos rechazados (22023)`, codigos.join(','));
    const directos = await pa.eval(`Promise.all([
      db.from('restaurantes').update({ plan: 'regalado' }).eq('id', ${JSON.stringify(A.id)}).select(),
      db.from('restaurantes').update({ vigente_hasta: '2099-12-31' }).eq('id', ${JSON.stringify(A.id)}).select(),
      db.from('restaurantes').update({ modulos: { pasarela: false } }).eq('id', ${JSON.stringify(A.id)}).select(),
      db.from('restaurantes').update({ estado: 'activo', slug: 'otro-slug' }).eq('id', ${JSON.stringify(A.id)}).select(),
      db.from('restaurantes').update({ config: { publico: { marca: { logo: 'Recursos/otro.png' } } } }).eq('id', ${JSON.stringify(A.id)}).select()
    ]).then(function(rs){ return rs.map(function(r){ return { n: r.data ? r.data.length : 0, code: r.error ? r.error.code : null }; }); })`);
    comprobar(directos.every((d) => d.n === 0 && d.code === '42501'), '13e. ...y por UPDATE directo tampoco puede cambiar plan, vigencia, modulos, slug ni la marca (42501)', JSON.stringify(directos));
    const despuesFab = await filaR(A);
    comprobar(JSON.stringify(despuesFab) === JSON.stringify(antesA) && JSON.stringify(await filaR(B)) === JSON.stringify(antesB), '13f. Despues de todos esos intentos, ni A ni B cambiaron en nada');

    // ---------------------------------------------------------------------------------- el dueno edita lo permitido
    await abrirDatos(pa);
    comprobar(await valorDe(pa, 'nombre') === antesA.nombre && await valorDe(pa, 'contacto.whatsapp') === ((antesA.config.publico.contacto || {}).whatsapp || '')
      && await valorDe(pa, 'textos.eslogan') === ((antesA.config.publico.textos || {}).eslogan || ''), '13g. El formulario abre con los datos vigentes de A');
    comprobar(await pa.eval(`document.querySelectorAll('[data-datos-campo]').length`) === 32, '13g. ...con sus 32 campos');
    comprobar(await pa.eval(`document.querySelector('#modalDatos').textContent.indexOf('colores, el logo, la ubicación') >= 0`), '13g. ...y avisa que la marca, la ubicacion y el domicilio los cambia el administrador');
    const marcaAntes = JSON.stringify(antesA.config.publico.marca);
    await capturar(pa, 'datos-1-abierto');
    await pa.escribir(campo('nombre'), `Casa Alfa Editada ${sfx}`);
    await pa.escribir(campo('textos.titulo_pagina'), `Pide en Casa Alfa ${sfx}`);
    await pa.escribir(campo('textos.eslogan'), 'El eslogan nuevo de Alfa');
    await pa.escribir(campo('textos.seguimiento.frase_camino'), 'Tu pedido ya va por la calle');
    await pa.escribir(campo('contacto.telefono'), '+57 300 555 0101');
    const logAntes = log.length;
    await guardar(pa);
    await esperarDb(async () => (await filaR(A)).nombre === `Casa Alfa Editada ${sfx}`, 'el nombre se guardo');
    const despuesA = await filaR(A);
    comprobar(await cerrado(pa) && (await toastTexto(pa)).includes('Datos guardados'), '13h. Guardar cierra el formulario y avisa "Datos guardados"');
    comprobar(despuesA.config.publico.textos.eslogan === 'El eslogan nuevo de Alfa' && despuesA.config.publico.textos.seguimiento.frase_camino === 'Tu pedido ya va por la calle'
      && despuesA.config.publico.contacto.telefono === '+57 300 555 0101' && despuesA.config.publico.textos.titulo_pagina === `Pide en Casa Alfa ${sfx}`, '13h. Lo editado queda en la base (nombre, titulo, eslogan, seguimiento, telefono)');
    comprobar(JSON.stringify(despuesA.config.publico.marca) === marcaAntes && sinEditable(despuesA) === sinEditable(antesA),
      '13i. NO se perdio ninguna otra clave: la marca, la ubicacion, el domicilio y el resto de la config quedan EXACTAMENTE igual', JSON.stringify([despuesA.config, antesA.config]).slice(0, 300));
    comprobar(['plan', 'estado', 'slug', 'modulos', 'vigente_hasta', 'dias_gracia', 'zona_horaria'].every((k) => JSON.stringify(despuesA[k]) === JSON.stringify(antesA[k])), '13i. ...ni el plan, estado, slug, modulos, vigencia ni zona horaria');
    const envio = log.slice(logAntes).filter((l) => /rpc\/guardar_datos_restaurante/.test(l.ruta));
    const cuerpoEnviado = envio.length ? JSON.parse(envio[envio.length - 1].cuerpo) : null;
    comprobar(envio.length === 1 && cuerpoEnviado && cuerpoEnviado.p_restaurante === A.id && cuerpoEnviado.p_cambios.length === 5
      && cuerpoEnviado.p_cambios.every((c) => Object.keys(c).sort().join() === 'antes,campo,despues')
      && cuerpoEnviado.p_cambios.map((c) => c.campo).sort().join() === ['nombre', 'textos.titulo_pagina', 'textos.eslogan', 'textos.seguimiento.frase_camino', 'contacto.telefono'].sort().join(),
      '13j. El formulario manda SOLO los 5 campos que cambiaron (con el valor que vio, "antes"), no la config entera', JSON.stringify(cuerpoEnviado).slice(0, 400));
    comprobar(log.slice(logAntes).some((l) => /rpc\/config_restaurante_errores/.test(l.ruta)), '13j. ...y antes de guardar le pregunto a la base (config_restaurante_errores) si lo aceptaria');
    comprobar(await pa.eval(`Array.from(document.querySelectorAll('[data-marca-nombre]')).every(function(e){return e.textContent === ${JSON.stringify(`Casa Alfa Editada ${sfx}`)};})`), '13k. El nombre nuevo se ve de inmediato en el menu del panel');
    comprobar(await pa.eval('document.title') === `Panel de Comandas | Casa Alfa Editada ${sfx}`, '13k. ...y en el titulo de la pestana');

    // se refleja en el sitio publico (el servidor guarda 30 s en memoria el restaurante de cada host: aqui se vacia para no esperar)
    R.invalidarCache();
    const pub = JSON.parse((await pedirConHost('alfa.localhost', PUERTO_WEB, '/api/restaurante')).texto);
    comprobar(pub.nombre === `Casa Alfa Editada ${sfx}` && pub.textos.eslogan === 'El eslogan nuevo de Alfa' && pub.textos.seguimiento.frase_camino === 'Tu pedido ya va por la calle' && pub.contacto.telefono === '+57 300 555 0101',
      '13l. Lo editado se refleja en /api/restaurante (lo que lee el sitio publico)', JSON.stringify(pub.textos).slice(0, 200));
    const man = JSON.parse((await pedirConHost('alfa.localhost', PUERTO_WEB, '/manifest.json')).texto);
    comprobar(/Casa Alfa Editada/.test(man.description), '13l. ...y en el manifest');
    const sitio = await abrir('13-sitio-alfa', URL_N('alfa.localhost') + '/');
    await sitio.esperar(`function(){return document.title === ${JSON.stringify(`Pide en Casa Alfa ${sfx}`)};}`, 15000, 'titulo de la pagina publica');
    comprobar(true, '13l. ...y en la pagina publica (la pestana dice el titulo nuevo)');

    // otra vez: abrir y guardar sin tocar nada no manda nada
    await abrirDatos(pa);
    const logSin = log.length;
    await guardar(pa);
    comprobar(/No hay cambios/.test(await avisoDe(pa)) && !log.slice(logSin).some((l) => /rpc\/guardar_datos_restaurante/.test(l.ruta)), '13m. Abrir y pulsar Guardar sin tocar nada: "No hay cambios" y no se manda nada');
    await pa.clic('#datosCancelar');
    comprobar(await cerrado(pa), '13m. ...y Cancelar sin cambios cierra de una vez');

    // ---------------------------------------------------------------------------------- valores invalidos
    await abrirDatos(pa);
    const estadoAntes = JSON.stringify(await filaR(A));
    await pa.escribir(campo('contacto.whatsapp'), '12');
    await pa.escribir(campo('textos.eslogan'), '<b>hola</b>');
    await pa.escribir(campo('textos.tagline'), 'palabra '.repeat(51));
    await pa.escribir(campo('contacto.instagram'), 'con espacios');
    await pa.escribir(campo('nombre'), '');
    const logInv = log.length;
    await guardar(pa);
    await capturar(pa, 'datos-2-errores');
    comprobar(/8 a 15 dígitos/.test(await errorDe(pa, 'contacto.whatsapp')), '13n. WhatsApp "12": dice en espanol que hacen falta de 8 a 15 digitos', await errorDe(pa, 'contacto.whatsapp'));
    comprobar(/etiquetas HTML/.test(await errorDe(pa, 'textos.eslogan')), '13n. Eslogan con <b>: dice que no se permite HTML', await errorDe(pa, 'textos.eslogan'));
    comprobar(/máximo 400/.test(await errorDe(pa, 'textos.tagline')), '13n. Frase de portada de 408 caracteres: dice el maximo (400)', await errorDe(pa, 'textos.tagline'));
    comprobar(/Usuario no válido/.test(await errorDe(pa, 'contacto.instagram')), '13n. Instagram con espacios: usuario no valido', await errorDe(pa, 'contacto.instagram'));
    comprobar(/vacío/.test(await errorDe(pa, 'nombre')), '13n. Nombre vacio: no puede quedar vacio', await errorDe(pa, 'nombre'));
    comprobar(/Revisa los campos marcados/.test(await avisoDe(pa)) && !await cerrado(pa), '13n. Avisa "Revisa los campos marcados", deja el formulario abierto y NO guarda nada');
    comprobar(!log.slice(logInv).some((l) => /rpc\/guardar_datos_restaurante/.test(l.ruta)) && JSON.stringify(await filaR(A)) === estadoAntes, '13n. ...y ni siquiera se llamo a la base para guardar');
    comprobar(await pa.eval(`document.querySelector('[data-datos-campo="contacto.whatsapp"]').getAttribute('aria-invalid')`) === 'true', '13n. El campo con problema queda marcado para los lectores de pantalla (aria-invalid)');
    await pa.escribir(campo('contacto.whatsapp'), '573001230000');
    comprobar(await errorDe(pa, 'contacto.whatsapp') === '', '13n. Al corregir el campo, su aviso desaparece');

    // ---------------------------------------------------------------------------------- ajustes que se avisan
    await pa.escribir(campo('nombre'), `Casa Alfa Editada ${sfx}`);
    await pa.escribir(campo('textos.eslogan'), 'El eslogan nuevo de Alfa');
    await pa.escribir(campo('textos.tagline'), '');
    await pa.escribir(campo('contacto.instagram'), '@casa.alfa');
    await pa.escribir(campo('contacto.whatsapp'), '+57 (300) 123-0000');
    await pa.escribir(campo('textos.descripcion_pagina'), 'Primera linea\nSegunda   linea');
    await guardar(pa);
    const ajuste = await avisoDe(pa);
    await capturar(pa, 'datos-3-ajustes');
    comprobar(/Ajustamos/.test(ajuste) && /573001230000/.test(ajuste) && /@/.test(ajuste) && /saltos de línea/.test(ajuste), '13o. Si hay que ajustar algo (WhatsApp solo numeros, @ del usuario, saltos de linea) lo avisa antes de guardar', ajuste);
    comprobar(await valorDe(pa, 'contacto.whatsapp') === '573001230000' && await valorDe(pa, 'contacto.instagram') === 'casa.alfa' && await valorDe(pa, 'textos.descripcion_pagina') === 'Primera linea Segunda linea',
      '13o. ...y deja en el formulario exactamente lo que se guardara', await valorDe(pa, 'textos.descripcion_pagina'));
    comprobar(!await cerrado(pa) && (await filaR(A)).config.publico.contacto.whatsapp !== '573001230000', '13o. ...sin guardar todavia: hay que revisar y pulsar Guardar de nuevo');
    await guardar(pa);
    await esperarDb(async () => (await filaR(A)).config.publico.contacto.whatsapp === '573001230000', 'el segundo Guardar guarda');
    const f3 = await filaR(A);
    comprobar(f3.config.publico.contacto.instagram === 'casa.alfa' && f3.config.publico.textos.descripcion_pagina === 'Primera linea Segunda linea' && !('tagline' in f3.config.publico.textos),
      '13o. Con el segundo Guardar queda como se aviso; el campo que se dejo vacio se borra (solo ese)', JSON.stringify(f3.config.publico.textos));
    comprobar(JSON.stringify(f3.config.publico.marca) === marcaAntes && f3.config.publico.textos.eslogan === 'El eslogan nuevo de Alfa', '13o. ...y nada mas cambio');

    // ---------------------------------------------------------------------------------- dos ediciones a la vez
    const p1 = await panelDe('13-pestana-1', 'alfa.localhost', uA);
    const p2 = await panelDe('13-pestana-2', 'alfa.localhost', uA);
    await abrirDatos(p1); await abrirDatos(p2);
    await p1.escribir(campo('textos.pie_final'), 'Cierre de la pestana 1 &lt;i&gt; "x"');
    await p1.escribir(campo('contacto.ciudad'), 'Ciudad de la pestana 1');
    await guardar(p1);
    await esperarDb(async () => (await filaR(A)).config.publico.textos.pie_final === 'Cierre de la pestana 1 &lt;i&gt; "x"', 'guardo la pestana 1');
    // la pestana 2 (que abrio ANTES) cambia el MISMO campo y otro distinto
    await p2.escribir(campo('textos.pie_final'), 'Cierre de la pestana 2');
    await p2.escribir(campo('textos.ejemplo_nota'), 'Nota de la pestana 2');
    await guardar(p2);
    const conf = await avisoDe(p2);
    await capturar(p2, 'datos-4-conflicto');
    const fC = await filaR(A);
    comprobar(/Otra persona editó/.test(conf) && conf.includes('Cierre de la pestana 1 &lt;i&gt; "x"'), '13p. La pestana 2 recibe el aviso: otra persona edito ese campo, y le dice como quedo (el texto ajeno se muestra TAL CUAL: sin interpretar &lt;i&gt; como HTML)', conf);
    comprobar(await p2.eval(`document.querySelectorAll('#datosAviso i, #datosAviso b, #modalDatos i').length === 0`), '13p. ...y el texto de la otra persona no creo ningun elemento');
    comprobar(fC.config.publico.textos.pie_final === 'Cierre de la pestana 1 &lt;i&gt; "x"' && fC.config.publico.textos.ejemplo_nota !== 'Nota de la pestana 2', '13p. NO se pisa la edicion de la pestana 1 y tampoco se guarda NADA de la pestana 2 (ni su otro campo)', JSON.stringify(fC.config.publico.textos));
    comprobar(/Otra persona cambió/.test(await errorDe(p2, 'textos.pie_final')) && await valorDe(p2, 'textos.pie_final') === 'Cierre de la pestana 2', '13p. El campo en conflicto queda marcado y el texto de la pestana 2 sigue ahi');
    comprobar(await valorDe(p2, 'contacto.ciudad') === 'Ciudad de la pestana 1', '13p. Lo que la pestana 2 NO toco se actualiza con lo vigente (la ciudad de la pestana 1)', await valorDe(p2, 'contacto.ciudad'));
    await guardar(p2);
    await esperarDb(async () => (await filaR(A)).config.publico.textos.pie_final === 'Cierre de la pestana 2', 'guardo la pestana 2 tras revisar');
    const fD = await filaR(A);
    comprobar(fD.config.publico.textos.ejemplo_nota === 'Nota de la pestana 2' && fD.config.publico.contacto.ciudad === 'Ciudad de la pestana 1',
      '13p. Al revisar y guardar otra vez, se guarda lo de la pestana 2 y se conserva lo de la pestana 1 (ciudad)', JSON.stringify([fD.config.publico.textos.ejemplo_nota, fD.config.publico.contacto.ciudad]));
    // campos distintos: se suman sin conflicto
    await abrirDatos(p1);
    await abrirDatos(p2);
    await p1.escribir(campo('contacto.region'), 'Region 1');
    await p2.escribir(campo('contacto.direccion_corta'), 'Direccion corta 2');
    await guardar(p1); await esperarDb(async () => (await filaR(A)).config.publico.contacto.region === 'Region 1', 'region');
    await guardar(p2); await esperarDb(async () => (await filaR(A)).config.publico.contacto.direccion_corta === 'Direccion corta 2', 'direccion corta');
    const fE = await filaR(A);
    comprobar(fE.config.publico.contacto.region === 'Region 1' && fE.config.publico.contacto.direccion_corta === 'Direccion corta 2' && await cerrado(p2),
      '13q. Dos ediciones de campos DISTINTOS se suman: ninguna pisa a la otra y no hay conflicto', JSON.stringify(fE.config.publico.contacto));

    // ---------------------------------------------------------------------------------- una config vieja invalida fuera del formulario
    await falso.db.exec('alter table public.restaurantes disable trigger restaurantes_validar_config');
    await falso.db.query(`update public.restaurantes set config = jsonb_set(config, '{publico,marca,logo}', '"http://evil.example/x.png"') where id = $1`, [G.id]);
    await falso.db.exec('alter table public.restaurantes enable trigger restaurantes_validar_config');
    const pg = await panelDe('13-gamma', 'gamma.localhost', uC);
    await abrirDatos(pg);
    await pg.escribir(campo('textos.eslogan'), 'Eslogan de Gamma');
    const antesG = JSON.stringify(await filaR(G));
    await guardar(pg);
    const av = await avisoDe(pg);
    comprobar(/fuera de este formulario/.test(av) && /publico\.marca\.logo/.test(av) && JSON.stringify(await filaR(G)) === antesG,
      '13r. Si la config tiene un problema viejo FUERA de este formulario (la marca), avisa cual es, que hay que avisar al administrador y no guarda', av);

    // ---------------------------------------------------------------------------------- datos hostiles guardados antes
    const ph = await panelDe('13-hostil', 'hostil.localhost', uH);
    await abrirDatos(ph);
    comprobar(await ph.eval(`document.querySelectorAll('#modalDatos img, #modalDatos script, #modalDatos b').length === 0 && typeof window.__pwn === 'undefined'`), '13s. Un nombre con HTML guardado antes se muestra como texto en el campo: no se ejecuta ni se inyecta nada');
    comprobar((await valorDe(ph, 'nombre')).includes('<img src=x onerror='), '13s. ...el campo muestra el texto tal cual (como valor, no como HTML)');
    await ph.eval(`DatosRestaurante.cerrar()`);

    // ---------------------------------------------------------------------------------- cerrar con cambios sin guardar
    await abrirDatos(pa);
    await pa.escribir(campo('textos.eslogan'), 'Un cambio que no se guarda');
    const estadoX = JSON.stringify(await filaR(A));
    await pa.clic('#datosCancelar');
    comprobar(!await cerrado(pa) && /sin guardar/.test(await avisoDe(pa)) && (await pa.eval(`document.getElementById('datosCancelar').textContent`)) === 'Descartar los cambios',
      '13t. Cancelar con cambios sin guardar NO cierra de una vez: avisa y pide confirmar');
    await pa.clic('#datosCancelar');
    comprobar(await cerrado(pa) && JSON.stringify(await filaR(A)) === estadoX, '13t. ...y al confirmar, descarta y no guarda nada');
    await abrirDatos(pa);
    comprobar(await valorDe(pa, 'textos.eslogan') === 'El eslogan nuevo de Alfa', '13t. Al volver a abrir, el formulario trae lo vigente (no lo descartado)');
    await pa.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    comprobar(await cerrado(pa), '13t. Escape cierra el formulario (sin cambios)');

    // ---------------------------------------------------------------------------------- si pierde el rol con el formulario abierto
    await abrirDatos(pa);
    await pa.eval(`PR.mostrarRol('cajero')`);
    comprobar(await cerrado(pa) && await pa.eval(`document.getElementById('datosBtn').hidden`), '13u. Si el rol deja de ser "dueno" con el formulario abierto, se cierra y la opcion se esconde');
    await pa.eval(`PR.mostrarRol('dueno')`);
    comprobar(await pa.eval(`!document.getElementById('datosBtn').hidden`), '13u. ...y vuelve a aparecer si el rol vuelve a ser dueno');

    // ---------------------------------------------------------------------------------- Taqueiros, el menu: nada mas cambio
    const errs = [pa, pcaj, pcoc, pb, p1, p2, pg, ph].map((p) => p.errores.filter((e) => !/Failed to load resource|favicon/.test(e)));
    comprobar(errs.every((e) => e.length === 0), '13v. Ninguna pagina tuvo errores de JavaScript durante todo el escenario', JSON.stringify(errs));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('14. Aviso de la suscripcion: el dueno ve una barra en gracia, vencida o suspendida; el cajero, la cocina y los demas restaurantes no; sin el SQL 16 no se rompe nada', async () => {
    const hoyBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const dia = (n) => new Date(Date.parse(hoyBogota + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const ponerA = (cols) => parchear('restaurantes', `id=eq.${A.id}`, cols);
    const barra = (pg) => pg.eval(`(function(){var b=document.getElementById('avisoVigencia');return {oculta:b.hidden, texto:b.textContent, grave:b.classList.contains('grave')};})()`);
    const abrirPanel = async (nombre, host, u) => panelDe(nombre, host, u);
    const aviso = async (cols, u = uA, nombre = '14') => { await ponerA(cols); const pg = await abrirPanel(nombre, 'alfa.localhost', u); await sleep(500); const r = await barra(pg); return r; };

    const alDia = await aviso({ estado: 'activo', vigente_hasta: null, dias_gracia: 5 });
    comprobar(alDia.oculta && alDia.texto === '', '14a. Sin vencimiento: la barra no aparece');
    const vigente = await aviso({ estado: 'activo', vigente_hasta: dia(10), dias_gracia: 5 });
    comprobar(vigente.oculta, '14b. Con la suscripcion al dia: la barra no aparece');
    const prueba = await aviso({ estado: 'prueba', vigente_hasta: dia(3), dias_gracia: 5 });
    comprobar(prueba.oculta, '14c. En periodo de prueba vigente: la barra no aparece');

    const gracia = await aviso({ estado: 'activo', vigente_hasta: dia(-2), dias_gracia: 5 });
    comprobar(!gracia.oculta && /venció el/.test(gracia.texto) && /Tienes 4 días para renovarla/.test(gracia.texto) && !gracia.grave, '14d. En gracia (venció hace 2 dias, 5 de gracia): "Tienes 4 dias para renovarla", sin el estilo de alarma', JSON.stringify(gracia));
    const ultimo = await aviso({ estado: 'activo', vigente_hasta: dia(-5), dias_gracia: 5 });
    comprobar(!ultimo.oculta && /Hoy es el último día/.test(ultimo.texto), '14e. El ultimo dia de gracia dice que hoy es el ultimo dia', JSON.stringify(ultimo));
    const vencido = await aviso({ estado: 'activo', vigente_hasta: dia(-9), dias_gracia: 5 });
    comprobar(!vencido.oculta && vencido.grave && /suspendido/.test(vencido.texto) && /no pueden hacer pedidos/.test(vencido.texto), '14f. Vencida (pasada la gracia): avisa que el servicio esta suspendido, con el estilo de alarma', JSON.stringify(vencido));
    const susp = await aviso({ estado: 'suspendido', vigente_hasta: dia(10), dias_gracia: 5 });
    comprobar(!susp.oculta && susp.grave && /está suspendido/.test(susp.texto), '14g. Suspendida a mano: lo dice', JSON.stringify(susp));

    // el dueno sigue entrando al panel y viendo sus pedidos aunque este vencido o suspendido
    const pg = await abrirPanel('14-dueno-suspendido', 'alfa.localhost', uA);
    comprobar(await pg.eval(`!document.getElementById('app').hidden`) && (await numerosTablero(pg)).length > 0, '14h. Suspendido, el dueno sigue entrando al panel y viendo sus pedidos', await numerosTablero(pg));

    // solo el dueno
    const cajero = await aviso({ estado: 'activo', vigente_hasta: dia(-2), dias_gracia: 5 }, uAB, '14-cajero');
    const cocina = await abrirPanel('14-cocina', 'alfa.localhost', uCocina); await sleep(400);
    comprobar(cajero.oculta && (await barra(cocina)).oculta, '14i. Un cajero y la cocina del mismo restaurante NO ven la barra (aunque este en gracia)', JSON.stringify([cajero, await barra(cocina)]));
    // otro restaurante (B, sin vencimiento) y Taqueiros: nada
    const pb = await abrirPanel('14-dueno-b', 'beta.localhost', uB); await sleep(400);
    comprobar((await barra(pb)).oculta, '14j. El dueno de B (que no vence) no ve nada: el estado de A no se le filtra', JSON.stringify(await barra(pb)));
    const pt = await abrirPanel('14-taqueiros', 'taqueiros.localhost', uT); await sleep(400);
    comprobar((await barra(pt)).oculta, '14k. Taqueiros (sin vencimiento): la barra no aparece');

    // sin el SQL 16 (la funcion no existe): sin barra y sin errores
    await falso.db.exec('alter function public.vigencia_restaurante(uuid, timestamptz) rename to vigencia_restaurante_apagada');
    try {
      const sinSql = await aviso({ estado: 'suspendido', vigente_hasta: dia(-30), dias_gracia: 5 }, uA, '14-sin-sql16');
      comprobar(sinSql.oculta, '14l. Sin el SQL 16 (la funcion no existe) la barra no aparece y el panel abre igual');
    } finally {
      await falso.db.exec('alter function public.vigencia_restaurante_apagada(uuid, timestamptz) rename to vigencia_restaurante');
    }
    // sin XSS: el texto nunca se arma con datos de la base (solo con la fecha ya validada)
    comprobar(!await pg.eval(`document.getElementById('avisoVigencia').innerHTML.indexOf('<') >= 0`), '14m. La barra es solo texto (nada de HTML)');
    await ponerA({ estado: 'activo', vigente_hasta: null, dias_gracia: 5 });
    const errs = [pg, pb, pt].map((p) => p.errores.filter((e) => !/Failed to load resource|favicon/.test(e)));
    comprobar(errs.every((e) => e.length === 0), '14n. Sin errores de JavaScript', JSON.stringify(errs));
  });

  // ---------------------------------------------------------------------------------------------------------
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
  try { chrome.kill(); } catch (e) { /* ya cerro */ }
  try { rt.cerrarTodo(); sitioNuevo.close(); if (sitioAntiguo) sitioAntiguo.close(); await falso.cerrar(); } catch (e) { /* ya cerro */ }
  try { fs.rmSync(perfil, { recursive: true, force: true }); fs.rmSync(raizAntigua, { recursive: true, force: true }); } catch (e) { /* en uso */ }
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 800).unref();
})().catch((e) => { console.error(e); process.exit(1); });
