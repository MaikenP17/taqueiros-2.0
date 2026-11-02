/* =============================================================
   CAPTURAS DEL SITIO PUBLICO (herramienta, NO una prueba: no cuenta ni falla)

     node pruebas/multirestaurante/capturas-tema.mjs [carpeta-de-salida]

   Levanta el sitio como lo haria Vercel (manejadores REALES de api/ sobre el Supabase falso con el SQL 17 aplicado,
   o sea el menu y la marca de The Northe Burgers), abre Chrome sin interfaz y guarda capturas PNG de la portada,
   el menu, el modal de producto, el carrito, el formulario de entrega, el aviso de cerrado, el pie y el
   seguimiento de un pedido, en 390 px (celular) y 1280 px (escritorio).

   Las fotos de los productos salen de Recursos/NORTHE-NUEVO/listas/ (carpeta local, fuera de git); si no existe
   se capturan las tarjetas sin foto. Las fuentes de Google y el mapa usan internet si hay; sin ella se ven con
   la fuente de respaldo.

   Salida por defecto: Recursos/NORTHE-NUEVO/capturas/ (ignorada por git).
   Variables: CHROME=ruta\chrome.exe   TEMA=oscuro (apaga TEMA_CLARO en la copia que se sirve, para comparar)
============================================================= */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { levantar } from './fake-supabase.mjs';
import { REPO, sql } from './sim.mjs';
import { crearEmulador } from './vercel-emulador.mjs';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMULADOR = crearEmulador(REPO);
const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));
const SALIDA = path.resolve(process.argv[2] || path.join(REPO, 'Recursos', 'NORTHE-NUEVO', 'capturas'));
const PUERTO_WEB = 8123, PUERTO_CDP = 9345, PUERTO_FALSO = 54350;
const HOST = 'taq.localhost';
const TAQ = '00000000-0000-4000-8000-000000000001';
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const FOTOS = { 'nb-big-norte': 'big-norte', 'nb-crispy-norte': 'crispy-norte', 'nb-lil-norte': 'lil-norte', 'nb-classic-norte': 'classic-norte', 'nb-smoky-norte': 'smoky-norte',
  'nb-full-norte': 'full-norte', 'nb-creamy-norte': 'creamy-norte', 'nb-dirty-norte': 'dirty-norte', 'nb-chori-norte': 'chori-norte', 'nb-agua': 'agua', 'nb-coca-cola': 'coca-cola', 'nb-pepsi': 'pepsi', 'nb-sprite': 'sprite' };

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url); this.id = 0; this.pend = new Map(); this.escuchas = [];
    this.abierto = new Promise((ok, mal) => { this.ws.onopen = ok; this.ws.onerror = mal; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) { const { ok, mal } = this.pend.get(m.id); this.pend.delete(m.id); if (m.error) mal(new Error(m.error.message)); else ok(m.result); }
      else if (m.method) this.escuchas.forEach((f) => f(m));
    };
  }
  send(method, params, sessionId) {
    const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    return new Promise((ok, mal) => this.pend.set(id, { ok, mal }));
  }
}

function adaptar(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { res.end(b); return res; };
  return res;
}

(async () => {
  if (!CHROME) { console.error('No encuentro Chrome. Define CHROME=ruta\\chrome.exe'); process.exit(2); }
  fs.mkdirSync(SALIDA, { recursive: true });
  const falso = await levantar({ puerto: PUERTO_FALSO, validarConfig: false });
  await falso.db.exec('alter table public.configuracion disable trigger configuracion_validar').catch(() => {});
  await falso.db.exec(sql('17-rebrand-northe.sql'));
  const hayFotos = fs.existsSync(path.join(REPO, 'Recursos', 'NORTHE-NUEVO', 'listas'));
  if (hayFotos) for (const [id, f] of Object.entries(FOTOS)) {
    await falso.db.exec(`update public.productos set imagen = 'Recursos/NORTHE-NUEVO/listas/${f}.jpg' where restaurante_id = '${TAQ}' and id = '${id}'`);
  }
  const horarios = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((dia) => ({ dia, abre: '00:00', cierra: '24:00', activo: true }));
  const poner = (cerrado) => falso.db.exec(`update public.configuracion set horarios = '${JSON.stringify(horarios)}'::jsonb, cerrado_temporal = ${cerrado ? 'true' : 'false'}, mensaje_cerrado = ${cerrado ? "'Hoy descansamos. Volvemos mañana desde las 11:00 a.m.'" : 'null'} where restaurante_id = '${TAQ}'`);
  await poner(false);
  await falso.db.exec(`insert into public.restaurante_dominios (host, restaurante_id) values ('${HOST}', '${TAQ}') on conflict do nothing`).catch(() => {});

  process.env.SUPABASE_URL = falso.url; process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_FAKE_0000';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FAKE_0000'; process.env.VERCEL_ENV = 'production';
  process.env.WOMPI_INTEGRITY_SECRET_TEST = 'x';
  const R = require(path.join(REPO, 'api', '_restaurante.js'));
  const api = {};

  // Copia servida de las paginas (TEMA=oscuro apaga el interruptor para comparar)
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-capt-'));
  for (const f of ['index.html', 'pedido.html', 'restaurante-publico.js', 'horario-regla.js']) {
    let t = fs.readFileSync(path.join(REPO, f), 'utf8');
    if (process.env.TEMA === 'oscuro') t = t.replace('const TEMA_CLARO = true;', 'const TEMA_CLARO = false;');
    fs.writeFileSync(path.join(raiz, f), t);
  }
  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/supabase-publico.js') { res.writeHead(200, { 'Content-Type': TIPOS['.js'] }); res.end('window.SUPABASE_PUBLICO = Object.freeze({ url: location.origin, publishableKey: "sb_publishable_FAKE_0000" });'); return; }
      if (url.pathname.startsWith('/rest/v1/')) {
        const cuerpo = await new Promise((ok) => { const t = []; req.on('data', (c) => t.push(c)); req.on('end', () => ok(Buffer.concat(t))); });
        const r = await fetch(falso.url + req.url, { method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo, headers: { apikey: req.headers.apikey || '', 'content-type': req.headers['content-type'] || 'application/json' } });
        res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(Buffer.from(await r.arrayBuffer())); return;
      }
      if (url.pathname === '/manifest.json' || url.pathname.startsWith('/api/')) {
        let cuerpo; if (req.method === 'POST') { const crudo = await new Promise((ok) => { const t = []; req.on('data', (c) => t.push(c)); req.on('end', () => ok(Buffer.concat(t).toString('utf8'))); }); try { cuerpo = JSON.parse(crudo); } catch (e) { /* sin cuerpo */ } }
        req.body = cuerpo; req.query = {};
        const d = EMULADOR.resolver({ metodo: req.method, ruta: url.pathname + url.search, headers: req.headers });
        if (d.tipo !== 'funcion') { res.statusCode = 404; res.end('{}'); return; }
        req.url = d.urlReescrita; req.query = Object.fromEntries(new URLSearchParams(d.urlReescrita.split('?')[1] || ''));
        const m = api[d.archivo] || (api[d.archivo] = require(path.join(REPO, d.archivo)));
        await m(req, adaptar(res)); return;
      }
      let ruta = decodeURIComponent(url.pathname); if (ruta === '/') ruta = '/index.html';
      const archivo = fs.existsSync(path.join(raiz, ruta)) ? path.join(raiz, ruta) : path.join(REPO, ruta);
      if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory() || path.relative(REPO, archivo).startsWith('..') && path.relative(raiz, archivo).startsWith('..')) { res.writeHead(404); res.end('no existe'); return; }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' }); res.end(fs.readFileSync(archivo));
    } catch (e) { console.error('[sitio]', e); try { res.writeHead(500); res.end(String(e)); } catch (x) { /* ya respondio */ } }
  });
  await new Promise((ok) => servidor.listen(PUERTO_WEB, '0.0.0.0', ok));

  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-capt-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PUERTO_CDP, '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) { try { version = await (await fetch('http://127.0.0.1:' + PUERTO_CDP + '/json/version')).json(); } catch (e) { await sleep(150); } }
  const cdp = new Cdp(version.webSocketDebuggerUrl); await cdp.abierto;

  const SCRIPT_WOMPI = 'window.WidgetCheckout = function (o) { this.open = function () {}; };';
  async function abrir(ancho, alto, ruta, listo) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sid = sessionId;
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await cdp.send(m, {}, sid);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://checkout.wompi.co/*'] }, sid);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT_WOMPI }, sid);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: ancho < 600 }, sid);
    const ev = async (e) => { const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description); return r.result.value; };
    await cdp.send('Page.navigate', { url: `http://${HOST}:${PUERTO_WEB}${ruta}` }, sid);
    const fin = Date.now() + 15000;
    while (Date.now() < fin) { try { if (await ev(listo || `document.querySelectorAll('#menu .card').length>0 || !!document.querySelector('.cabecera, .aviso')`)) break; } catch (e) { /* cargando */ } await sleep(100); }
    await ev("document.documentElement.style.scrollBehavior='auto'");
    await sleep(1200);
    return { ev, sid, async foto(nombre, { completa = false } = {}) {
      let clip;
      if (completa) {
        const m = await cdp.send('Page.getLayoutMetrics', {}, sid);
        clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
      }
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: completa, clip }, sid);
      fs.writeFileSync(path.join(SALIDA, nombre + '.png'), Buffer.from(r.data, 'base64')); console.log('  ' + nombre + '.png');
    }, async cerrar() { await cdp.send('Target.closeTarget', { targetId }); } };
  }
  const esperar = (ms) => sleep(ms || 700);

  for (const [etiqueta, ancho, alto] of [['390', 390, 844], ['1280', 1280, 800]]) {
    console.log('\n== ' + etiqueta + ' px');
    let p = await abrir(ancho, alto, '/');
    await p.foto(`${etiqueta}-01-portada`);
    await p.foto(`${etiqueta}-02-pagina-completa`, { completa: true });
    await p.ev(`document.getElementById('menu').scrollIntoView(); window.scrollBy(0,-130);`); await esperar(1000);
    await p.foto(`${etiqueta}-03-menu`);
    await p.ev(`document.querySelectorAll('#menu .card.in-view, #menu .card').forEach(function(c){c.classList.add('in-view')}); var c=document.querySelector('#menu .card'); c.click();`); await esperar(900);
    await p.foto(`${etiqueta}-04-modal-producto`);
    await p.ev(`document.getElementById('modalCloseBtn').click()`); await esperar();
    await p.ev(`var c=document.querySelectorAll('#menu .card .add-btn'); c[0].click(); c[1] && c[1].click(); c[1] && c[1].click(); true`); await esperar();
    await p.foto(`${etiqueta}-05-barra-flotante`);
    await p.ev(`document.getElementById('openCartBtn').click()`); await esperar(900);
    await p.foto(`${etiqueta}-06-carrito`);
    await p.ev(`document.getElementById('payOnlineBtn').disabled=false; document.getElementById('payOnlineBtn').click()`); await esperar(1200);
    await p.foto(`${etiqueta}-07-formulario-entrega`);
    await p.ev(`document.querySelector('#paymentFormModal').scrollTop = 600`); await esperar();
    await p.foto(`${etiqueta}-08-formulario-entrega-abajo`);
    await p.ev(`document.getElementById('paymentFormCloseBtn').click(); document.getElementById('closeCartBtn').click()`); await esperar();
    await p.ev(`document.getElementById('abrirMiPedidoTop').click()`); await esperar(800);
    await p.foto(`${etiqueta}-09-buscar-pedido`);
    await p.ev(`document.getElementById('cerrarBuscarPedido').click(); document.getElementById('footer').scrollIntoView()`); await esperar(900);
    await p.foto(`${etiqueta}-10-pie`);
    await p.cerrar();

    await poner(true); R.invalidarCache();
    p = await abrir(ancho, alto, '/');
    await p.foto(`${etiqueta}-11-cerrado-portada`);
    await p.ev(`document.getElementById('menu').scrollIntoView(); window.scrollBy(0,-130); var c=document.querySelectorAll('#menu .card .add-btn'); c[0] && c[0].click(); document.getElementById('openCartBtn').click()`); await esperar(1000);
    await p.foto(`${etiqueta}-12-cerrado-carrito`);
    await p.cerrar(); await poner(false); R.invalidarCache();

    // Seguimiento: un pedido real creado por SQL (el seguimiento lee la funcion seguimiento(ref))
    p = await abrir(ancho, alto, '/pedido.html?ref=PED-CAPTURA-0001');
    await p.foto(`${etiqueta}-13-seguimiento-no-encontrado`);
    await p.cerrar();
  }

  // Pedido de ejemplo para el seguimiento
  try {
    await falso.db.exec(`insert into public.pedidos (restaurante_id, referencia, token_seguimiento, estado, cliente_nombre, cliente_telefono, cliente_email, tipo_pedido, direccion, barrio, items, subtotal, costo_domicilio, total, estado_pago, pagado_en)
      values ('${TAQ}', 'PED-CAPTURA-0001', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', 'en_preparacion', 'Cliente de ejemplo', '3001234567', 'a@b.co', 'domicilio', 'Calle 1 # 2-3', 'Centro',
      '[{"nombre":"Big Norte","cantidad":2,"precio":26000},{"nombre":"Papas","cantidad":1,"precio":9000}]'::jsonb, 61000, 5000, 66000, 'aprobado', now())`);
    for (const [etiqueta, ancho, alto] of [['390', 390, 844], ['1280', 1280, 800]]) {
      const p = await abrir(ancho, alto, '/pedido.html?ref=a1b2c3d4e5f60718293a4b5c6d7e8f90');
      await p.foto(`${etiqueta}-14-seguimiento`, { completa: true });
      await p.cerrar();
    }
  } catch (e) { console.log('(sin pedido de ejemplo para el seguimiento: ' + String(e.message).slice(0, 200) + ')'); }

  // Paginas del personal (siguen oscuras): la pantalla de entrada, para ver el logo transparente sobre su chip crema
  for (const [etiqueta, ancho, alto] of [['390', 390, 844], ['1280', 1280, 800]]) {
    for (const pag of ['panel', 'menu-admin', 'historial']) {
      try {
        const p = await abrir(ancho, alto, '/' + pag + '.html', `document.querySelector('.login-card img, header img') && document.querySelector('.login-card img, header img').naturalWidth > 0`);
        await p.foto(`${etiqueta}-15-personal-${pag}`);
        await p.cerrar();
      } catch (e) { console.log('(sin captura de ' + pag + ': ' + String(e.message).slice(0, 120) + ')'); }
    }
  }

  console.log('\nCapturas en: ' + SALIDA);
  chrome.kill(); servidor.close(); await falso.cerrar?.(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
