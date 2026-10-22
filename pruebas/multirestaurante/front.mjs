/* =============================================================
   PRUEBAS DE NAVEGADOR DEL FRONTEND PUBLICO MULTI-RESTAURANTE

     node pruebas/multirestaurante/front.mjs

   Chrome sin interfaz + los manejadores REALES de api/ (restaurante, menu, estado, disponibilidad,
   crear-pedido, manifest) sobre el Supabase falso (PGlite con el SQL 10, 11 y 12). Sin red externa:
   fuentes, Leaflet y el widget de Wompi estan bloqueados (el widget se sustituye por una grabadora).

   Cada restaurante vive en SU dominio (alfa.localhost, beta.localhost... y Taqueiros en su dominio
   real, que Chrome resuelve a 127.0.0.1), asi que cada uno tiene su propio origen y su propio
   almacenamiento, como en produccion.

   Que se prueba
     1. Dos restaurantes: cada uno ve su nombre, colores, logo, textos, contacto, menu, tarifas, llave de
        pago y numero de pedido; ninguno ve datos del otro.
     2. Un dominio desconocido o un servidor caido muestran un mensaje neutro (sin datos de nadie).
     3. Datos HOSTILES en la configuracion (HTML, CSS, javascript:) no se ejecutan ni se inyectan.
     4. Servicio suspendido, modulos apagados y restaurante sin datos.
     5. TAQUEIROS SE VE IDENTICO a como estaba (commit debc1c5): mismos textos, colores, enlaces y
        valores, comparando el DOM y los estilos calculados de ambas versiones, en seis estados de la pagina.
     6. Flujo de pago con un Wompi simulado: llave, monto, redireccion y enlace de seguimiento por token.
     7. El seguimiento (pedido.html) y "¿Buscas tu pedido?" muestran el numero del restaurante.
     8. El almacenamiento del navegador no mezcla restaurantes.

   Variables: CHROME=ruta\chrome.exe   SOLO="^(3|5)\."   (corre solo los escenarios que casen)
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
import { crearEmulador } from './vercel-emulador.mjs';
const EMULADOR = crearEmulador(REPO);

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = process.env.CHROME || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

const PUERTO_WEB = 8097;       // el sitio nuevo
const PUERTO_ANTIGUO = 8096;   // el sitio como estaba antes (para comparar)
const PUERTO_CDP = 9334;
const PUERTO_FALSO = 54340;
const COMMIT_ANTERIOR = 'debc1c5';
const HOST_TAQUEIROS = 'taqueiros-2-0.vercel.app';
const TAQUEIROS_ID = '00000000-0000-4000-8000-000000000001';
const sfx = crypto.randomBytes(3).toString('hex');
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

/* Sustituye el widget de Wompi (la pagina lo espera como WidgetCheckout) por una grabadora. */
const SCRIPT_WOMPI = `
window.__wompi = [];
window.WidgetCheckout = function (opciones) {
  window.__wompi.push(opciones);
  this.open = function (cb) { window.__wompiCb = cb; };
};`;

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
      estado = await this.eval(`JSON.stringify({clase: document.documentElement.className, estado: (document.getElementById('rp-estado')||{}).innerText, cards: document.querySelectorAll('#menu .card').length,
        banner: (document.getElementById('statusBanner')||{}).textContent, horas: document.querySelectorAll('#footerHours li').length, url: location.href})`);
    } catch (e) { estado = '(sin estado: ' + e.message + ')'; }
    throw new Error('Tiempo agotado esperando: ' + (etiqueta || fn) + ' | estado: ' + estado + ' | errores: ' + this.errores.join(' ; ') + ' | dialogos: ' + this.dialogos.join(' ; '));
  }
  /* Escribe en un campo y avisa a la pagina como lo haria el teclado. */
  escribir(selector, valor) {
    return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(valor)};
      e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  }
  clic(selector) {
    return this.eval(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('no existe '+${JSON.stringify(selector)});e.click();return true;})()`);
  }
}

/* ---------------- servidor de prueba ---------------- */
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};
// FRONT_RAIZ: carpeta con una COPIA (posiblemente mutada) de las paginas, para la revision por mutacion (mutaciones-front.mjs)
const RAIZ_NUEVA = process.env.FRONT_RAIZ ? path.resolve(process.env.FRONT_RAIZ) : REPO;
// respuestaRestaurante: lo que /api/restaurante devuelve TAL CUAL (simula un servidor o un intermediario que NO valida)
const estadoServidor = { restauranteFalla: 0, menuFalla: false, respuestaRestaurante: null, ultimoPedido: null, peticiones: [] };

function adaptar(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { res.end(b); return res; };
  return res;
}

function crearSitio({ raiz, puerto, falsoUrl, rutaApi, globalName = 'SUPABASE_PUBLICO' }) {
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
  const manejadores = ['restaurante', 'menu', 'estado', 'disponibilidad', 'crear-pedido', 'manifest'];

  const servidor = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      estadoServidor.peticiones.push(`${req.headers.host} ${req.method} ${url.pathname}`);

      // El sitio apunta su "Supabase publico" al propio origen; aqui se reenvia al falso
      if (url.pathname === '/supabase-publico.js') {
        res.writeHead(200, { 'Content-Type': TIPOS['.js'] });
        res.end(`window.${globalName} = Object.freeze({ url: location.origin, publishableKey: "sb_publishable_FAKE_0000" });`);   // (el sitio ANTERIOR usa el nombre antiguo del objeto)
        return;
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const cuerpo = await new Promise((ok) => { const t = []; req.on('data', (c) => t.push(c)); req.on('end', () => ok(Buffer.concat(t))); });
        const r = await fetch(falsoUrl + req.url, {
          method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : cuerpo,
          headers: { apikey: req.headers.apikey || '', 'content-type': req.headers['content-type'] || 'application/json' }
        });
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }

      let nombre = null;
      if (url.pathname === '/manifest.json') nombre = 'manifest';
      else if (url.pathname.startsWith('/api/')) nombre = url.pathname.slice(5);
      if (nombre) {
        if (!manejadores.includes(nombre)) { res.writeHead(404); res.end('{}'); return; }
        if (nombre === 'restaurante' && estadoServidor.restauranteFalla > 0) {
          estadoServidor.restauranteFalla--;
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"Servicio no disponible en este momento"}');
          return;
        }
        if (nombre === 'restaurante' && estadoServidor.respuestaRestaurante) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(estadoServidor.respuestaRestaurante));
          return;
        }
        if (nombre === 'menu' && estadoServidor.menuFalla) {
          res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"x"}');
          return;
        }
        let cuerpo;
        if (req.method === 'POST') {
          const crudo = await new Promise((ok) => { const t = []; req.on('data', (c) => t.push(c)); req.on('end', () => ok(Buffer.concat(t).toString('utf8'))); });
          try { cuerpo = crudo ? JSON.parse(crudo) : undefined; } catch (e) { cuerpo = undefined; }
        }
        req.body = cuerpo; req.query = {};
        if (nombre === 'crear-pedido') estadoServidor.ultimoPedido = cuerpo;
        await llamarApi(req, adaptar(res), url);
        return;
      }

      // archivos del sitio
      let ruta = decodeURIComponent(url.pathname);
      if (ruta === '/') ruta = '/index.html';
      const archivo = path.join(raiz, ruta);
      if (!archivo.startsWith(raiz) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
        // Recursos/ del sitio nuevo tambien sirve al antiguo
        const respaldo = path.join(REPO, ruta);
        if (ruta.startsWith('/Recursos/') && fs.existsSync(respaldo)) {
          res.writeHead(200, { 'Content-Type': TIPOS[path.extname(respaldo)] || 'application/octet-stream' });
          res.end(fs.readFileSync(respaldo));
          return;
        }
        res.writeHead(404); res.end('no existe');
        return;
      }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
      res.end(fs.readFileSync(archivo));
    } catch (e) {
      console.error('[sitio de prueba]', e);
      try { res.writeHead(500); res.end(String(e)); } catch (x) { /* ya respondio */ }
    }
  });
  return new Promise((ok) => servidor.listen(puerto, '0.0.0.0', () => ok(servidor)));
}

/* ---------------- ejecucion ---------------- */
const resultados = [];
function comprobar(ok, texto, info) {
  resultados.push({ ok: !!ok, texto });
  console.log('   ' + (ok ? 'PASA ' : 'FALLA') + ' ' + texto + (ok || !info ? '' : '\n          -> ' + String(info).slice(0, 700)));
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
  // Estas pruebas guardan a proposito un mensaje de cerrado hostil (con HTML) para ver que la pagina publica no lo ejecuta aunque llegara: desde el SQL 15 la base lo rechazaria, asi que se apaga SOLO ese trigger
  await falso.db.exec('alter table public.configuracion disable trigger configuracion_validar');
  const URL_FALSO = falso.url;
  process.env.SUPABASE_URL = URL_FALSO;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_FAKE_0000';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_FAKE_0000';
  process.env.VERCEL_ENV = 'production';
  delete process.env.DOMINIO_BASE;
  for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_INTEGRITY_SECRET_PROD', 'WOMPI_EVENTS_SECRET_TEST', 'WOMPI_EVENTS_SECRET_PROD', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];
  process.env.WOMPI_INTEGRITY_SECRET_TEST = 'ENV-integridad-' + sfx;   // Taqueiros (respaldo de entorno, como hoy)
  const fetchOriginal = globalThis.fetch;
  // El servidor nunca sale a internet en estas pruebas (Nominatim)
  globalThis.fetch = async (u, o) => {
    if (String(u).includes('nominatim.openstreetmap.org')) return new Response(JSON.stringify({ address: { neighbourhood: 'Barrio Prueba' } }), { status: 200 });
    return fetchOriginal(u, o);
  };

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

  async function restaurante(clave, { nombre, config, secretos = true, modulos, estado, menu, tarifas, mensajeCerrado, host }) {
    const fila = await insertar('restaurantes', Object.assign({ slug: `test-f-${clave}-${sfx}`, nombre, estado: estado || 'activo', config }, modulos ? { modulos } : {}));
    await insertar('restaurante_dominios', { host: host || `${clave}.localhost`, restaurante_id: fila.id });
    await parchear('configuracion', `restaurante_id=eq.${fila.id}`, Object.assign({ horarios, cerrado_temporal: false }, mensajeCerrado ? { cerrado_temporal: true, mensaje_cerrado: mensajeCerrado } : {}));
    if (secretos) await parchear('restaurante_secretos', `restaurante_id=eq.${fila.id}`, { wompi_integridad_test: `SECRETO-${clave}-${sfx}`, wompi_eventos_test: `EV-${clave}-${sfx}`, otros: { wompi_modo: 'test' } });
    if (menu) {
      await insertar('categorias', [{ restaurante_id: fila.id, id: 'principal', nombre: menu.categoria, emoji: menu.emoji || '', orden: 1, activa: true }]);
      await insertar('productos', menu.productos.map((p, i) => ({ restaurante_id: fila.id, id: p[0], nombre: p[1], descripcion: p[3] || '', precio: p[2], categoria: 'principal', orden: i + 1, disponible: true })));
    }
    if (tarifas) await insertar('tarifas_domicilio', tarifas.map(([hasta, precio]) => ({ restaurante_id: fila.id, hasta, precio })));
    return fila;
  }

  const llaveA = 'pub_test_' + 'A'.repeat(20) + sfx, llaveB = 'pub_test_' + 'B'.repeat(20) + sfx;
  const configDe = (n, extra = {}) => ({
    ubicacion: { lat: 7.9, lng: -72.5 }, domicilio: { factor_recorrido: n === 'beta' ? 1.0 : 1.3 },
    publico: {
      marca: {
        logo: `Recursos/${n}/logo.png`, icono_192: `Recursos/${n}/i192.png`, emoji: n === 'alfa' ? '🍕' : '🍣',
        colores: n === 'alfa'
          ? { primario: '#112233', primario_brillo: '#223344', oscuro: '#0A0B0C', oscuro_2: '#15161A', claro: '#F0F0E8', claro_suave: '#FAFAF5', acento: '#AA5500', positivo: '#006633', texto_secundario: '#CCCCDD' }
          : { primario: '#884400', primario_brillo: '#AA6622', oscuro: '#101820', oscuro_2: '#18242E', claro: '#EEF2F5', claro_suave: '#F8FAFB', acento: '#00AA88', positivo: '#225588', texto_secundario: '#BBCCDD' },
        colores_zonas: n === 'alfa' ? ['#111111', '#222222'] : ['#333333', '#444444']
      },
      textos: {
        titulo_pagina: `Pagina de ${n}`, descripcion_pagina: `Descripcion de ${n}`, eslogan: `Eslogan ${n}`, tagline: `Tagline ${n}`,
        descripcion_pie: `Pie ${n}`, servicios_linea: `Servicios ${n}`, pie_final: `Final ${n}`, ejemplo_nota: `Nota ${n}`,
        banner_abierto_icono: '🟢', banner_abierto_titulo: `Abierto ${n}`, banner_abierto_texto: `Atendiendo ${n}{cierre}.`,
        seguimiento: { frase_nuevo: `Recibido en ${n}`, tiempo_nuevo: `Tiempo ${n}` }
      },
      contacto: { whatsapp: n === 'alfa' ? '573100000001' : '573100000002', telefono: `Tel ${n}`, direccion: `Calle de ${n}`, direccion_corta: `Corta ${n}`,
                  ciudad: `Ciudad ${n}`, region: `Region ${n}`, instagram: `ig_${n}`, tiktok: `tk_${n}` },
      wompi: { llave_publica_test: n === 'alfa' ? llaveA : llaveB }
    },
    ...extra
  });

  const A = await restaurante('alfa', { nombre: `Casa Alfa ${sfx}`, config: configDe('alfa'), tarifas: [[2, 3000], [5, 6000], [999, null]],
    menu: { categoria: 'Pizzas', emoji: '🍕', productos: [['pizza', 'Pizza Alfa', 30000, 'Con queso alfa'], ['alfa-solo', 'Exclusivo Alfa', 7000]] } });
  const B = await restaurante('beta', { nombre: `Sushi Beta ${sfx}`, config: configDe('beta'), tarifas: [[2, 4500], [999, null]],
    menu: { categoria: 'Rolls', emoji: '🍣', productos: [['roll', 'Roll Beta', 25000, 'Con alga beta'], ['beta-solo', 'Exclusivo Beta', 9000]] } });
  const hostil = configDe('alfa');
  Object.assign(hostil.publico.marca, {
    logo: 'javascript:window.__pwn=1', icono_192: 'data:text/html,<script>window.__pwn=1</script>', emoji: '<b>x</b>',
    colores: { primario: 'red;background:url(//evil.example/x.png)', oscuro: 'expression(alert(1))', claro: '#12345', acento: '#GGGGGG' }, colores_zonas: ['url(x)']
  });
  Object.assign(hostil.publico.textos, {
    eslogan: '<img src=x onerror="window.__pwn=1">', tagline: '<script>window.__pwn=1</script>', descripcion_pie: '"><svg onload=window.__pwn=1>',
    servicios_linea: `Servicios ${bidi}<u>x</u>`, ejemplo_nota: '"><img src=x onerror=window.__pwn=1>',
    banner_abierto_titulo: '<img src=x onerror="window.__pwn=1">',
    seguimiento: { frase_nuevo: '<img src=x onerror="window.__pwn=1">', frase_preparacion: '<img src=x onerror="window.__pwn=1">', tiempo_preparacion: '<img src=x onerror="window.__pwn=1">' }
  });
  Object.assign(hostil.publico.contacto, { whatsapp: '"><script>', instagram: '"><b>', telefono: '<img src=x onerror="window.__pwn=1">', direccion: '</li><li><img src=x onerror=window.__pwn=1>', direccion_corta: '<img src=x onerror="window.__pwn=1">' });
  const H1 = await restaurante('hostil', { nombre: '<img src=x onerror="window.__pwn=1"> Hostil', config: hostil, tarifas: [[2, 3000], [999, null]],
    menu: { categoria: '<b>Cat</b>', emoji: '<i>', productos: [['p1', '<img src=x onerror=window.__pwn=1>', 5000, '<script>window.__pwn=1</script>']] },
    mensajeCerrado: '<img src=x onerror="window.__pwn=1"> cerrado' });
  await parchear('configuracion', `restaurante_id=eq.${H1.id}`, { horarios: [{ dia: '<img src=x onerror=window.__pwn=1>', abre: '00:00', cierra: '24:00', activo: true }] });
  const FILA_H1 = { id: H1.id };
  const S = await restaurante('susp', { nombre: `Suspendido ${sfx}`, config: configDe('alfa'), estado: 'suspendido', tarifas: [[2, 3000], [999, null]],
    menu: { categoria: 'Cat', productos: [['s1', 'Producto de suspendido', 5000]] } });
  const M = await restaurante('modulos', { nombre: `Sin Modulos ${sfx}`, tarifas: [[2, 3000], [999, null]],
    config: { ubicacion: { lat: 7.9, lng: -72.5 }, publico: { marca: { colores: { primario: '#445566' } }, wompi: { llave_publica_test: llaveA } } },
    modulos: { pasarela: false, seguimiento: false, comandas: true, impresion: true },
    menu: { categoria: 'Cat', productos: [['m1', 'Producto sin modulos', 5000]] } });
  const V = await restaurante('vacio', { nombre: `Sin Datos ${sfx}`, config: {}, secretos: false,
    menu: { categoria: 'Cat', productos: [['v1', 'Producto sin datos', 5000]] } });

  // Taqueiros tambien se alcanza por un dominio de prueba: su dominio real (.app) esta en la lista HSTS de Chrome y
  // no se puede abrir por http. Para el servidor es otro host del MISMO restaurante.
  await insertar('restaurante_dominios', { host: 'taqueiros.localhost', restaurante_id: TAQUEIROS_ID });
  // Taqueiros: abierto todo el dia (el resto de su configuracion es la del SQL 12)
  await parchear('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}`, { horarios, cerrado_temporal: false });

  // pedidos pagados de cada uno (el numero del restaurante NO es el id de la tabla)
  const pedido = (r, ref, tel, total, extra = {}) => insertar('pedidos', Object.assign({
    restaurante_id: r.id, referencia: ref, estado: 'en_preparacion', estado_pago: 'aprobado', cliente_nombre: 'Cliente', cliente_telefono: tel,
    tipo_pedido: 'llevar', items: [{ id: 'x', nombre: 'Producto', cantidad: 2, precio: total / 2 }], subtotal: total, costo_domicilio: 0, total,
    pagado_en: new Date().toISOString(), alerta_enviada: true
  }, extra));
  await pedido({ id: TAQUEIROS_ID }, 'TAQ-RELLENO-1', '3009999999', 1000);   // para que el id de la tabla se adelante al numero
  await pedido({ id: TAQUEIROS_ID }, 'TAQ-RELLENO-2', '3009999998', 1000);
  const pA = await pedido(A, `TAQ-ALFA-${sfx}`, '3001110001', 9000);
  const pB = await pedido(B, `TAQ-BETA-${sfx}`, '3002220002', 12000);
  // Un pedido de Taqueiros "de antes del SQL 12": su enlace sigue siendo la referencia (el servidor puede fijarlo)
  const pT = await pedido({ id: TAQUEIROS_ID }, `TAQ-TAQ-${sfx}`, '3003330003', 15000, { enlace_por_referencia: true });
  const pH = await pedido(FILA_H1, `TAQ-HOSTIL-${sfx}`, '3004440004', 5000);
  R.invalidarCache();

  // ---- sitio nuevo y sitio antiguo (para comparar) ----------------------------------------------------------------------
  const raizAntigua = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-antiguo-'));
  let hayAntiguo = true;
  try {
    for (const f of ['index.html', 'pedido.html']) fs.writeFileSync(path.join(raizAntigua, f), execFileSync('git', ['show', `${COMMIT_ANTERIOR}:${f}`], { cwd: REPO, maxBuffer: 20e6 }));
  } catch (e) { hayAntiguo = false; console.log('(sin historial de ' + COMMIT_ANTERIOR + ': se omite la comparacion con la version anterior)'); }

  const sitioNuevo = await crearSitio({ raiz: RAIZ_NUEVA, puerto: PUERTO_WEB, falsoUrl: URL_FALSO, rutaApi: path.join(REPO, 'api') });
  const sitioAntiguo = hayAntiguo ? await crearSitio({ raiz: raizAntigua, puerto: PUERTO_ANTIGUO, falsoUrl: URL_FALSO, rutaApi: path.join(REPO, 'api'), globalName: 'TAQUEIROS_SUPABASE' }) : null;
  const URL_N = (host) => `http://${host}:${PUERTO_WEB}`;

  // ---- Chrome ---------------------------------------------------------------------------------------------------------------
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-front-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PUERTO_CDP, '--user-data-dir=' + perfil,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--window-size=1280,900',
    'about:blank'
  ], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetchOriginal('http://127.0.0.1:' + PUERTO_CDP + '/json/version')).json(); } catch (e) { await sleep(150); }
  }
  if (!version) { chrome.kill(); console.error('Chrome no abrio el puerto de depuracion'); process.exit(2); }
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.abierto;

  const abiertas = [];
  async function pagina(nombre, { ancho = 1280, alto = 900, contexto } = {}) {
    const ctx = contexto || (await cdp.send('Target.createBrowserContext')).browserContextId;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = new Pagina(cdp, sessionId, nombre);
    pg.targetId = targetId; pg.contexto = ctx;
    abiertas.push(pg);
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Network.setBlockedURLs', { urls: ['https://fonts.googleapis.com/*', 'https://fonts.gstatic.com/*', 'https://unpkg.com/*', 'https://*.jsdelivr.net/*', 'https://checkout.wompi.co/*', 'https://*.tile.openstreetmap.org/*'] }, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SCRIPT_WOMPI }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: ancho, height: alto, deviceScaleFactor: 1, mobile: false }, sessionId);
    return pg;
  }
  alIniciar = async () => {
    for (const pg of abiertas) { if (pg.cerrada) continue; pg.cerrada = true; try { await cdp.send('Target.closeTarget', { targetId: pg.targetId }); } catch (e) { /* ya cerrada */ } }
    estadoServidor.restauranteFalla = 0; estadoServidor.menuFalla = false;
    R.invalidarCache();
    await sleep(100);
  };

  /* Abre el sitio de un restaurante y espera a que quede pintado (menu, estado y datos aplicados). */
  async function abrir(nombre, url, opciones) {
    const pg = await pagina(nombre, opciones);
    await pg.ir(url);
    await pg.esperar(`function(){return (document.documentElement.classList.contains('rp-listo') || !window.RP) && document.querySelectorAll('#menu .card').length>0 && document.getElementById('statusBanner').textContent.length>0 && document.querySelectorAll('#footerHours li').length>0;}`, 12000, 'pagina lista ' + url);
    await sleep(500);   // que terminen las transiciones de CSS (los colores acaban de aplicarse) antes de medir estilos
    return pg;
  }
  const texto = (pg) => pg.eval('document.body.innerText');
  const visible = (pg) => pg.eval(`(function(){ // texto que ve la persona (sin el que esta oculto)
    var t=[]; var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(w.nextNode()){var n=w.currentNode; var e=n.parentElement; if(!e||e.closest('script,style'))continue;
      var cs=getComputedStyle(e); if(cs.display==='none'||cs.visibility==='hidden')continue; var s=n.nodeValue.replace(/\\s+/g,' ').trim(); if(s)t.push(s);} return t.join(' | ');})()`);
  const variable = (pg, nombre) => pg.eval(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(nombre)}).trim()`);
  const incluyeAlguno = (t, lista) => lista.filter((x) => t.includes(x));

  // ---------------------------------------------------------------------------------------------------------
  await escenario('1. Dos restaurantes: cada uno con SU marca, textos, menu, tarifas y numero', async () => {
    const a = await abrir('alfa', URL_N('alfa.localhost') + '/');
    const b = await abrir('beta', URL_N('beta.localhost') + '/');
    const ta = await texto(a), tb = await texto(b);
    comprobar(await a.eval('document.title') === 'Pagina de alfa' && await b.eval('document.title') === 'Pagina de beta', 'cada pagina lleva el titulo de su restaurante');
    comprobar(await a.eval(`document.querySelector('meta[name=description]').content`) === 'Descripcion de alfa', 'la descripcion de la pagina es la de su restaurante');
    comprobar(await a.eval(`document.getElementById('marcaNombre').textContent`) === `CASA ALFA ${sfx.toUpperCase()}`
      && await a.eval(`document.querySelector('#marcaNombre span').textContent`) === sfx.toUpperCase(), 'el nombre de la cabecera sale de la base (ultima palabra resaltada)', await a.eval(`document.getElementById('marcaNombre').textContent`));
    comprobar(await variable(a, '--rojo') === '#112233' && await variable(b, '--rojo') === '#884400'
      && await variable(a, '--carbon') === '#0A0B0C' && await variable(b, '--carbon') === '#101820'
      && await variable(a, '--carbon-rgb') === '10,11,12' && await variable(b, '--mostaza') === '#00AA88', 'los colores de cada marca se aplican como variables CSS (y sus versiones rgb)');
    comprobar(await a.eval(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`) === 'rgb(17, 34, 51)'
      && await b.eval(`getComputedStyle(document.querySelector('.btn-primary')).backgroundColor`) === 'rgb(136, 68, 0)', 'el boton principal se pinta con el color primario de cada uno');
    comprobar(await a.eval(`document.querySelector('.brand img').getAttribute('src')`) === 'Recursos/alfa/logo.png'
      && await b.eval(`document.querySelector('.brand img').getAttribute('src')`) === 'Recursos/beta/logo.png', 'cada uno con su logo');
    const esperadosA = ['Eslogan alfa', 'Tagline alfa', 'Pie alfa', 'Calle de alfa', 'Tel alfa', '@ig_alfa', 'Servicios alfa', 'Final alfa', 'Ver el menú 🍕'];
    const minus = ta.toLowerCase();   // (algunos textos se muestran en mayusculas por CSS)
    comprobar(esperadosA.every((x) => minus.includes(x.toLowerCase())), 'A: eslogan, tagline, pie, direccion, telefono, redes, servicios y emoji propios', 'faltan: ' + esperadosA.filter((x) => !minus.includes(x.toLowerCase())).join(' | '));
    comprobar(incluyeAlguno(ta, ['beta', 'Beta', 'Sushi', '🍣']).length === 0 && incluyeAlguno(tb, ['alfa', 'Alfa', 'Pizza', '🍕']).length === 0, 'ninguno ve texto del otro', incluyeAlguno(ta, ['beta', 'Beta', 'Sushi']).concat(incluyeAlguno(tb, ['alfa', 'Alfa', 'Pizza'])).join(','));
    comprobar(ta.includes('Pizza Alfa') && ta.includes('Exclusivo Alfa') && !ta.includes('Roll Beta') && tb.includes('Roll Beta') && !tb.includes('Pizza Alfa'), 'cada uno ve solo su menu');
    const redesA = await a.eval(`document.getElementById('footerSocials').innerHTML`), redesB = await b.eval(`document.getElementById('footerSocials').innerHTML`);
    comprobar(redesA.includes('instagram.com/ig_alfa') && redesA.includes('wa.me/573100000001') && redesB.includes('wa.me/573100000002') && redesB.includes('tiktok.com/@tk_beta'),
      'las redes y el WhatsApp del pie son los de cada uno', redesA + ' // ' + redesB);
    const domA = await a.eval(`JSON.stringify([calcularDomicilio(7.909,-72.5), calcularDomicilio(7.92,-72.5), calcularDomicilio(8.5,-72.5)])`);
    const domB = await b.eval(`JSON.stringify([calcularDomicilio(7.909,-72.5), calcularDomicilio(7.92,-72.5), calcularDomicilio(8.5,-72.5)])`);
    comprobar(domA === '[{"km":1.3,"precio":3000,"fueraDeCobertura":false},{"km":2.9,"precio":6000,"fueraDeCobertura":false},{"km":86.7,"precio":0,"fueraDeCobertura":true}]'
      && domB === '[{"km":1,"precio":4500,"fueraDeCobertura":false},{"km":2.2,"precio":0,"fueraDeCobertura":true},{"km":66.7,"precio":0,"fueraDeCobertura":true}]', 'las tarifas, el origen y el factor de recorrido de cada uno', domA + ' // ' + domB);
    comprobar(await a.eval('WOMPI_PUBLIC_KEY') === llaveA && await b.eval('WOMPI_PUBLIC_KEY') === llaveB
      && await a.eval('WOMPI_REDIRECT_URL') === URL_N('alfa.localhost') + '/?pago=exitoso' && await b.eval('WOMPI_REDIRECT_URL') === URL_N('beta.localhost') + '/?pago=exitoso'
      && await a.eval('WOMPI_TRANSACTION_API') === 'https://sandbox.wompi.co/v1/transactions/', 'llave publica de cada uno y redireccion al origen actual (sin dominio escrito)');
    comprobar(await a.eval(`document.getElementById('orderNote').placeholder`) === 'Nota alfa', 'el ejemplo de la nota es el del restaurante');
    const bannerA = await a.eval(`document.getElementById('statusBanner').textContent`);
    comprobar(/^🟢 Abierto alfa Atendiendo alfa — hoy hasta las /.test(bannerA), 'el banner de abierto es el del restaurante (icono, titulo y texto con la hora de cierre)', bannerA);
    comprobar(a.errores.length === 0 && b.errores.length === 0, 'sin errores de JavaScript', a.errores.concat(b.errores).join(' | '));
  });

  await escenario('1b. El numero de pedido es el del restaurante en "¿Buscas tu pedido?" y en el seguimiento', async () => {
    const idA = (await srv('GET', `pedidos?referencia=eq.${pA.referencia}&select=id,numero,token_seguimiento`))[0];
    comprobar(Number(idA.numero) === 1 && Number(idA.id) > 3 && !!idA.token_seguimiento, `precondicion: el pedido de A es el #1 del restaurante y el id de la tabla es ${idA.id}`);
    const a = await abrir('alfa', URL_N('alfa.localhost') + '/');
    await a.clic('#abrirBuscarPedido');
    await a.escribir('#bp-telefono', '3001110001'); await a.escribir('#bp-total', '9000');
    await a.clic('#btnBuscarPedido');
    await a.esperar(`function(){return document.querySelectorAll('#resultadosBusqueda .resultado-pedido').length>0;}`, 8000, 'resultado de busqueda');
    const r = await a.eval(`(function(){var e=document.querySelector('#resultadosBusqueda .resultado-pedido');return {t:e.innerText.replace(/\\s+/g,' '),h:e.getAttribute('href')};})()`);
    comprobar(r.t.startsWith('Pedido #001 · $9.000') && !r.t.includes('#' + String(idA.id).padStart(3, '0') + ' '), 'muestra "Pedido #001" (el numero) y no el id de la tabla', r.t);
    comprobar(r.h === `pedido.html?ref=${idA.token_seguimiento}`, 'el enlace usa el token (no la referencia ni el id)', r.h);
    // busca en el OTRO restaurante con los datos de A: no aparece (acotado por restaurante)
    const b = await abrir('beta', URL_N('beta.localhost') + '/');
    await b.clic('#abrirBuscarPedido');
    await b.escribir('#bp-telefono', '3001110001'); await b.escribir('#bp-total', '9000');
    await b.clic('#btnBuscarPedido');
    await b.esperar(`function(){return document.querySelectorAll('#resultadosBusqueda .buscar-vacio').length>0;}`, 8000, 'sin resultados en B');
    comprobar((await b.eval(`document.getElementById('resultadosBusqueda').innerText`)).includes('No encontramos pedidos'), 'el pedido de A no aparece en la busqueda de B');
    // ...y B SI encuentra el suyo (la busqueda va acotada al restaurante de la pagina: p_restaurante)
    await b.escribir('#bp-telefono', '3002220002'); await b.escribir('#bp-total', '12000');
    await b.clic('#btnBuscarPedido');
    await b.esperar(`function(){return document.querySelectorAll('#resultadosBusqueda .resultado-pedido').length>0;}`, 8000, 'resultado en B');
    const rb = await b.eval(`(function(){var e=document.querySelector('#resultadosBusqueda .resultado-pedido');return {t:e.innerText.replace(/\\s+/g,' '),h:e.getAttribute('href')};})()`);
    const idB = (await srv('GET', `pedidos?referencia=eq.${pB.referencia}&select=token_seguimiento`))[0];
    comprobar(rb.t.startsWith('Pedido #001 · $12.000') && rb.h === `pedido.html?ref=${idB.token_seguimiento}`, 'B encuentra SU pedido (#001 del restaurante B) con su enlace de token', JSON.stringify(rb));

    const s = await abrir2(a, URL_N('alfa.localhost') + '/' + r.h);
    const t = await s.eval('document.body.innerText');
    comprobar(/Pedido #001/i.test(t) && t.includes(pA.referencia) && /Lo estamos preparando/.test(t), 'el seguimiento por token muestra el pedido #001 del restaurante', t.slice(0, 200));
    comprobar(!(await s.eval('document.body.innerText')).includes('Cl 1AN'), 'el seguimiento no tiene la direccion de Taqueiros');
    comprobar((await s.eval(`document.querySelector('.cabecera img').getAttribute('src')`)) === 'Recursos/alfa/logo.png' && (await s.eval('document.title')) === `Sigue tu pedido | Casa Alfa ${sfx}`, 'el seguimiento lleva el logo y el nombre de ese restaurante');
    comprobar(await variable(s, '--rojo') === '#112233', 'el seguimiento usa los colores de ese restaurante');
    // el enlace viejo (referencia) NO abre un pedido nuevo
    // una clave con caracteres raros ni siquiera se consulta
    const malo = await abrir2(a, URL_N('alfa.localhost') + '/pedido.html?ref=' + encodeURIComponent('<img src=x onerror=window.__pwn=1>'));
    comprobar((await malo.eval('document.body.innerText')).toLowerCase().includes('falta la referencia') && (await malo.eval('typeof window.__pwn')) === 'undefined'
      && !estadoServidor.peticiones.some((p) => /rpc\/seguimiento/.test(p) && false), 'pedido.html con una clave rara: "Falta la referencia" y no ejecuta nada');
    const v = await abrir2(a, URL_N('alfa.localhost') + `/pedido.html?ref=${encodeURIComponent(pA.referencia)}`);
    comprobar((await v.eval('document.body.innerText')).includes('No encontramos ese pedido'), 'la referencia sola ya no abre el seguimiento de un pedido nuevo');
    // y el token de A en el dominio de B tampoco rompe ni mezcla marcas: ve el pedido pero con SU marca (B)
    const x = await abrir2(b, URL_N('beta.localhost') + '/' + r.h);
    comprobar(await variable(x, '--rojo') === '#884400', 'el seguimiento se pinta con la marca del dominio en que se abre');
  });
  async function abrir2(pg, url) {   // nueva pestana en el mismo contexto
    const n = await pagina('seg', { contexto: pg.contexto });
    await n.ir(url);
    await n.esperar(`function(){return document.documentElement.classList.contains('rp-listo') && document.getElementById('contenido').children.length>0 && !/Buscando tu pedido/.test(document.getElementById('contenido').innerText);}`, 12000, 'seguimiento ' + url);
    return n;
  }

  await escenario('2. Dominio desconocido o servidor caido: mensaje neutro, sin datos de nadie', async () => {
    const desconocido = await pagina('desconocido');
    await desconocido.ir(URL_N('desconocido.localhost') + '/');
    await desconocido.esperar(`function(){var e=document.getElementById('rp-estado');return e&&e.className==='rp-neutro';}`, 8000, 'mensaje neutro');
    const t = await visible(desconocido);
    comprobar(/Este sitio no está disponible/.test(t) && !/Reintentar/.test(t), 'dominio desconocido: "Este sitio no está disponible", sin boton de reintentar', t);
    comprobar(incluyeAlguno(t, ['Taqueiros', 'Alfa', 'Beta', 'Sushi', 'Pizza', 'Cúcuta', 'Tacos']).length === 0
      && (await desconocido.eval('document.title')) === 'Sitio no disponible' && (await desconocido.eval(`document.querySelectorAll('#menu .card').length`)) === 0, 'sin ningun dato de ningun restaurante (ni titulo ni menu)');
    const cubre = await desconocido.eval(`(function(){var e=document.getElementById('rp-estado');var r=e.getBoundingClientRect();return JSON.stringify({pos:getComputedStyle(e).position,w:r.width,h:r.height,iw:innerWidth,ih:innerHeight,z:getComputedStyle(e).zIndex});})()`);
    const cj = JSON.parse(cubre);
    comprobar(cj.pos === 'fixed' && cj.w >= cj.iw - 24 && cj.h >= cj.ih - 1 && Number(cj.z) >= 9999, 'el mensaje cubre toda la pantalla (la pagina vacia no se ve detras)', cubre);
    comprobar(await variable(desconocido, '--rojo') === '#3B5B8C' && await variable(desconocido, '--rojo') !== '#C1272D', 'colores neutros (no los de Taqueiros)');
    comprobar(desconocido.errores.length === 0, 'sin errores de JavaScript', desconocido.errores.join('|'));

    estadoServidor.restauranteFalla = 1;
    const caido = await pagina('caido');
    await caido.ir(URL_N('alfa.localhost') + '/');
    await caido.esperar(`function(){var e=document.getElementById('rp-estado');return e&&e.className==='rp-neutro';}`, 8000, 'mensaje de error');
    const tc = await visible(caido);
    comprobar(/No pudimos cargar la página/.test(tc) && /Reintentar/.test(tc) && incluyeAlguno(tc, ['Taqueiros', 'Alfa', 'Pizza']).length === 0, 'servidor caido: mensaje neutro con "Reintentar" y sin datos', tc);
    await caido.clic('#rp-estado button');
    await caido.esperar(`function(){return document.documentElement.classList.contains('rp-listo') && document.querySelectorAll('#menu .card').length>0;}`, 12000, 'carga tras reintentar');
    comprobar((await texto(caido)).includes('Pizza Alfa'), 'al reintentar, la pagina carga normal con los datos del restaurante');

    // pedido.html igual
    const pdesc = await pagina('pedido-desconocido');
    await pdesc.ir(URL_N('desconocido.localhost') + '/pedido.html?ref=abcdef123456');
    await pdesc.esperar(`function(){var e=document.getElementById('rp-estado');return e&&e.className==='rp-neutro';}`, 8000, 'pedido.html neutro');
    comprobar(incluyeAlguno(await visible(pdesc), ['Taqueiros', 'Cúcuta', '1AN']).length === 0, 'pedido.html en un dominio desconocido tambien es neutro');
  });

  await escenario('3. Datos hostiles en la configuracion: no se ejecutan ni se inyectan', async () => {
    const pg = await abrir('hostil', URL_N('hostil.localhost') + '/');
    await pg.esperar(`function(){return /cerrado/.test(document.getElementById('statusBanner').textContent) || document.getElementById('statusBanner').textContent.length>0;}`, 8000, 'banner');
    const r = await pg.eval(`(function(){return {
      pwn: typeof window.__pwn, imgs: document.querySelectorAll('img[src=x]').length, onerror: document.querySelectorAll('[onerror],[onload],[onmouseover]').length,
      svg: document.querySelectorAll('body svg').length, scripts: document.querySelectorAll('script').length,
      rojo: getComputedStyle(document.documentElement).getPropertyValue('--rojo').trim(), carbon: getComputedStyle(document.documentElement).getPropertyValue('--carbon').trim(),
      claro: getComputedStyle(document.documentElement).getPropertyValue('--crema').trim(), mostaza: getComputedStyle(document.documentElement).getPropertyValue('--mostaza').trim(),
      styleAttr: document.documentElement.getAttribute('style'),
      logoSrc: document.querySelector('.brand img').getAttribute('src'), logoDisplay: getComputedStyle(document.querySelector('.brand img')).display,
      icono: (document.querySelector('link[rel=icon]')||{}).href || null,
      nombre: document.getElementById('marcaNombre').textContent, eslogan: document.getElementById('heroEslogan').textContent,
      banner: document.getElementById('statusBanner').textContent, horas: document.getElementById('footerHours').textContent,
      contacto: document.getElementById('footerContacto').textContent, social: document.getElementById('footerSocials').innerHTML,
      placeholder: document.getElementById('orderNote').placeholder, menu: document.getElementById('menu').textContent
    };})()`);
    comprobar(r.pwn === 'undefined', 'ningun codigo de la configuracion se ejecuto (window.__pwn sin definir)', r.pwn);
    comprobar(r.imgs === 0 && r.onerror === 0 && r.svg === 0, 'no aparecio ningun <img src=x>, <svg> ni atributo on* inyectado', JSON.stringify(r));
    comprobar(r.scripts === await pg.eval(`document.querySelectorAll('script').length`) && r.scripts <= 6, 'no se agrego ningun <script>', r.scripts);
    comprobar(r.rojo === '#3B5B8C' && r.carbon === '#16181D' && r.claro === '#F2F2F2' && r.mostaza === '#D4A72C', 'los colores invalidos se descartan: quedan los neutros (ninguna cadena de CSS se aplico)', JSON.stringify([r.rojo, r.carbon, r.claro, r.mostaza]));
    comprobar(!/evil|url\(|expression/i.test(String(r.styleAttr)), 'el estilo de la pagina no trae nada del CSS hostil', r.styleAttr);
    comprobar(r.logoDisplay === 'none' && !String(r.icono || '').includes('javascript') && !/javascript|data:/.test(String(r.icono)), 'el logo javascript:/data: no se usa (no hay imagen ni icono peligroso)', JSON.stringify([r.logoSrc, r.logoDisplay, r.icono]));
    comprobar(r.nombre.includes('<IMG SRC=X') || r.nombre.includes('<img src=x'.toUpperCase()), 'el nombre hostil se ve como TEXTO literal', r.nombre);
    comprobar(r.eslogan.includes('<img src=x onerror="window.__pwn=1">') && r.contacto.includes('<img src=x onerror="window.__pwn=1">') && r.banner.includes('<img src=x onerror="window.__pwn=1">'),
      'el eslogan, el contacto y el mensaje de cerrado hostiles se ven como texto literal', JSON.stringify([r.eslogan, r.contacto, r.banner]));
    comprobar(r.horas.includes('<img src=x onerror=window.__pwn=1>') && r.menu.includes('<img src=x onerror=window.__pwn=1>') && r.placeholder.includes('onerror'), 'los dias del horario, el menu y el ejemplo de nota hostiles tambien quedan como texto');
    comprobar(!r.social.includes('<script') && !r.social.includes('"><b>') && !r.social.includes('wa.me/"'), 'un WhatsApp o usuario de red hostil no genera enlaces', r.social);
    await pg.clic('#openCartBtn');
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join('|'));

    // el seguimiento de un pedido de ese restaurante hostil: frases, direccion y nombre salen como texto
    const tokenH = (await srv('GET', `pedidos?referencia=eq.${pH.referencia}&select=token_seguimiento`))[0].token_seguimiento;
    const seg = await abrir2(pg, URL_N('hostil.localhost') + `/pedido.html?ref=${tokenH}`);
    const rs = await seg.eval(`(function(){return {pwn: typeof window.__pwn, imgs: document.querySelectorAll('img[src=x],[onerror],[onload]').length, texto: document.body.innerText,
      logo: getComputedStyle(document.querySelector('.cabecera img')).display, rojo: getComputedStyle(document.documentElement).getPropertyValue('--rojo').trim()};})()`);
    comprobar(rs.pwn === 'undefined' && rs.imgs === 0 && rs.logo === 'none' && rs.rojo === '#3B5B8C', 'pedido.html: nada del restaurante hostil se ejecuta, el logo peligroso no se usa y los colores invalidos se descartan', JSON.stringify([rs.pwn, rs.imgs, rs.logo, rs.rojo]));
    comprobar(rs.texto.toLowerCase().includes('<img src=x onerror="window.__pwn=1">'), 'pedido.html: las frases y la direccion hostiles se ven como texto literal', rs.texto.slice(0, 300));
    comprobar(seg.errores.length === 0, 'pedido.html: sin errores de JavaScript', seg.errores.join('|'));
  });

  await escenario('3b. Aunque el servidor (o un intermediario) mande datos hostiles SIN validar, el navegador los descarta', async () => {
    // El navegador no confia en el servidor: reconstruye lo que llega campo por campo (restaurante-publico.js)
    estadoServidor.respuestaRestaurante = {
      id: A.id, slug: 'x', nombre: 'Casa <img/src=x/onerror=window.__pwn=1>' + bidi, zona_horaria: 'America/Bogota', moneda: 'COP',
      modulos: { pasarela: true, seguimiento: true, comandas: true, impresion: true }, servicio: { estado: 'activo', sirve: true, motivo: null },
      marca: { logo: 'javascript:window.__pwn=1', icono_192: 'https://evil.example/i.png', icono_512: 'Recursos/../../x.png', emoji: '<b>x</b>',
        colores: { primario: 'red;background:url(//evil.example/x.png)', oscuro: 'expression(alert(1))', claro: '#12345', acento: '#GGGGGG', positivo: 'rgb(1,2,3)',
                   claro_suave: '#112233 url(//evil.example/y.png)' }, colores_zonas: ['url(x)', 7] },
      textos: { eslogan: '<img src=x onerror="window.__pwn=1">', tagline: '<script>window.__pwn=1</script>', ejemplo_nota: '"><img src=x onerror=window.__pwn=1>',
        banner_abierto_titulo: '<svg onload=window.__pwn=1>', seguimiento: { frase_nuevo: '<img src=x onerror="window.__pwn=1">' }, script: 'x' },
      contacto: { whatsapp: '"><script>', telefono: '<img src=x onerror="window.__pwn=1">', instagram: '"><b>', tiktok: 'a b', direccion: '<u>x</u>' },
      ubicacion: { lat: 'x', lng: 999 }, domicilio: { ofrece: true, factor_recorrido: -4, tarifas: [{ hasta: 'x', precio: 1 }, { hasta: 2, precio: '1' }] },
      pago: { disponible: true, pasarela: 'wompi', modo: 'produccion', llave_publica: 'pub_test_' + 'A'.repeat(20) }
    };
    const pg = await pagina('crudo');
    await pg.ir(URL_N('alfa.localhost') + '/');
    await pg.esperar(`function(){return document.documentElement.classList.contains('rp-listo') && document.querySelectorAll('#menu .card').length>0;}`, 12000, 'pagina con datos crudos');
    await sleep(300);
    const r = await pg.eval(`(function(){var cs=function(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();};return {
      pwn: typeof window.__pwn, imgs: document.querySelectorAll('img[src=x],[onerror],[onload]').length, svg: document.querySelectorAll('body svg').length,
      rojo: cs('--rojo'), carbon: cs('--carbon'), claro: cs('--crema'), mostaza: cs('--mostaza'), verde: cs('--verde'),
      suave: cs('--crema-suave'), icono512: JSON.stringify(window.RP.datos.marca.icono_512), icono192: JSON.stringify(window.RP.datos.marca.icono_192),
      styleAttr: document.documentElement.getAttribute('style') || '', logoDisplay: getComputedStyle(document.querySelector('.brand img')).display,
      icono: (document.querySelector('link[rel=icon]')||{}).href || '', html: document.body.innerHTML, nombre: document.getElementById('marcaNombre').textContent,
      social: document.getElementById('footerSocials').innerHTML, llave: WOMPI_PUBLIC_KEY, modo: MODO_COBRO, pagoVisible: getComputedStyle(document.getElementById('payOnlineBtn')).display,
      zonas: JSON.stringify(COLORES_ZONA), tarifas: JSON.stringify(TARIFAS_DOMICILIO), ub: JSON.stringify(RESTAURANTE), domicilio: getComputedStyle(document.querySelector('input[value=domicilio]').closest('label')).display
    };})()`);
    comprobar(r.pwn === 'undefined' && r.imgs === 0 && r.svg === 0, 'datos crudos hostiles: no se ejecuta ni se inyecta nada', JSON.stringify([r.pwn, r.imgs, r.svg]));
    comprobar(r.rojo === '#3B5B8C' && r.carbon === '#16181D' && r.claro === '#F2F2F2' && r.mostaza === '#D4A72C' && r.verde === '#4F8A5B' && r.suave === '#FAFAFA' && !/evil|url\(|expression/i.test(r.styleAttr), 'los colores invalidos se descartan en el navegador (quedan los neutros; un color con CSS pegado detras tambien)', JSON.stringify([r.rojo, r.carbon, r.claro, r.mostaza, r.verde, r.suave, r.styleAttr]));
    comprobar(r.logoDisplay === 'none' && !/javascript|evil|data:/.test(r.icono) && r.icono512 === 'null' && r.icono192 === 'null', 'el logo javascript:, los iconos de otro origen y las rutas que suben de carpeta no se usan', JSON.stringify([r.logoDisplay, r.icono, r.icono512, r.icono192]));
    comprobar(!r.html.includes(bidi) && r.nombre === 'CASA <IMG/SRC=X/ONERROR=WINDOW.__PWN=1>' && !r.html.includes('<script>window'), 'el nombre se ve como texto literal (la ultima palabra tambien) y sin el caracter bidi', r.nombre);
    comprobar(!r.social.includes('wa.me') && !r.social.includes('instagram.com') && !r.social.includes('tiktok.com') && !r.social.includes('<b>'), 'WhatsApp y redes con formato invalido no generan enlaces', r.social);
    comprobar(r.llave === '' && r.pagoVisible === 'none', 'una llave de pago que no es del modo (pub_test_ con modo produccion) se descarta y no se ofrece el pago', JSON.stringify([r.llave, r.pagoVisible, r.modo]));
    comprobar(r.zonas.includes('4F8A5B') && r.tarifas === '[]' && r.ub === 'null' && r.domicilio === 'none', 'ubicacion, tarifas y zonas invalidas se descartan (sin domicilio)', JSON.stringify([r.zonas, r.tarifas, r.ub, r.domicilio]));
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join('|'));
    estadoServidor.respuestaRestaurante = null;
  });

  await escenario('4. Servicio suspendido, modulos apagados y restaurante sin datos', async () => {
    const s = await abrir('susp', URL_N('susp.localhost') + '/');
    const ts = await texto(s);
    comprobar(ts.includes('Producto de suspendido'), 'suspendido: el menu se sigue viendo');
    comprobar(await s.eval(`getComputedStyle(document.getElementById('payOnlineBtn')).display`) === 'none' && await s.eval(`getComputedStyle(document.getElementById('whatsappBtn')).display`) === 'none',
      'suspendido: no se puede pedir (ni pagar ni WhatsApp)');
    comprobar((await s.eval(`document.getElementById('avisoCerrado').textContent`)) === 'Servicio no disponible por el momento.'
      && (await s.eval(`document.getElementById('statusBanner').textContent`)).includes('Servicio no disponible por el momento')
      && !/mensualidad|vence|gracia|suspend/i.test(await s.eval(`document.getElementById('statusBanner').textContent + ' ' + document.getElementById('avisoCerrado').textContent`)),
      'suspendido: mensaje neutro "Servicio no disponible por el momento" (sin hablar de mensualidad)');
    const m = await abrir('modulos', URL_N('modulos.localhost') + '/');
    comprobar(await m.eval(`getComputedStyle(document.getElementById('payOnlineBtn')).display`) === 'none', 'pasarela apagada: no se ofrece "Pagar en linea"');
    comprobar(await m.eval(`getComputedStyle(document.getElementById('whatsappBtn')).display`) === 'none' && (await m.eval(`document.getElementById('avisoCerrado').textContent`)).includes('no recibe pedidos'),
      'sin pasarela ni WhatsApp: no se puede pedir y se avisa');
    comprobar(await m.eval(`getComputedStyle(document.getElementById('abrirMiPedidoTop')).display`) === 'none' && await m.eval(`getComputedStyle(document.getElementById('abrirBuscarPedido')).display`) === 'none',
      'seguimiento apagado: se esconden "Mi pedido" y "¿Buscas tu pedido?"');
    // el seguimiento de un restaurante sin ese modulo avisa que no esta disponible
    const sm = await pagina('seg-modulos');
    await sm.ir(URL_N('modulos.localhost') + '/pedido.html?ref=abcdef123456');
    await sm.esperar(`function(){return document.documentElement.classList.contains('rp-listo') && document.getElementById('contenido').innerText.length>0 && !/Buscando/.test(document.getElementById('contenido').innerText);}`, 10000, 'seguimiento sin modulo');
    comprobar(/seguimiento en l[ií]nea no est[aá] disponible/i.test(await sm.eval(`document.getElementById('contenido').innerText`)), 'seguimiento apagado: pedido.html avisa que no esta disponible');
    const v = await abrir('vacio', URL_N('vacio.localhost') + '/');
    const tv = await visible(v);
    comprobar(incluyeAlguno(tv, ['Taqueiros', 'Cúcuta', 'Tacos', 'Birria', '312 524', '🌮']).length === 0, 'sin datos: la pagina funciona y no muestra nada de Taqueiros', incluyeAlguno(tv, ['Taqueiros', 'Cúcuta', 'Tacos']).join(','));
    comprobar(await variable(v, '--rojo') === '#3B5B8C' && (await v.eval('document.title')) === `Sin Datos ${sfx}`
      && await v.eval(`getComputedStyle(document.getElementById('payOnlineBtn')).display`) === 'none', 'sin datos: colores neutros, titulo = nombre y sin pasarela');
    comprobar(await v.eval(`getComputedStyle(document.querySelector('input[value=domicilio]').closest('label')).display`) === 'none', 'sin domicilio configurado no se ofrece domicilio');
    comprobar(s.errores.length + m.errores.length + v.errores.length === 0, 'sin errores de JavaScript', s.errores.concat(m.errores, v.errores).join('|'));
  });

  await escenario('6. Flujo de pago con Wompi simulado: llave, monto, redireccion y enlace por token', async () => {
    const a = await abrir('alfa', URL_N('alfa.localhost') + '/');
    await a.clic('.card[data-id="pizza"] .add-btn');
    await a.clic('#openCartBtn');
    await a.clic('#payOnlineBtn');
    await a.esperar(`function(){return document.getElementById('paymentFormOverlay').classList.contains('open');}`, 5000, 'formulario');
    await a.escribir('#pf-nombre', 'Cliente de Prueba'); await a.escribir('#pf-telefono', '3001234567'); await a.escribir('#pf-email', 'prueba@example.com');
    await a.eval(`(function(){var r=document.querySelector('input[name=tipoPedido][value=llevar]');r.checked=true;r.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
    await a.esperar(`function(){return !document.getElementById('paymentFormSubmitBtn').disabled;}`, 5000, 'boton habilitado');
    await a.clic('#paymentFormSubmitBtn');
    await a.esperar(`function(){return window.__wompi && window.__wompi.length===1;}`, 8000, 'widget de Wompi');
    comprobar(estadoServidor.ultimoPedido && estadoServidor.ultimoPedido.modo === 'pruebas', 'la pagina manda a crear-pedido el modo que dijo el servidor (pruebas), no uno elegido por ella', JSON.stringify(estadoServidor.ultimoPedido && estadoServidor.ultimoPedido.modo));
    const w = await a.eval('JSON.stringify(window.__wompi[0])');
    const op = JSON.parse(w);
    const fila = (await srv('GET', `pedidos?referencia=eq.${op.reference}&select=*`))[0];
    comprobar(op.publicKey === llaveA && op.amountInCents === 3000000 && op.currency === 'COP' && op.redirectUrl === URL_N('alfa.localhost') + '/?pago=exitoso'
      && /^[0-9a-f]{64}$/.test(op.signature.integrity), 'el widget recibe la llave publica de A, el monto del servidor y la redireccion al origen actual', w.slice(0, 300));
    comprobar(fila && fila.restaurante_id === A.id && fila.wompi_ambiente === 'test' && Number(fila.numero) === 2, 'el pedido se crea en el restaurante A, en modo prueba (lo decidio el servidor) y con su numero (#2)', JSON.stringify(fila && [fila.restaurante_id, fila.wompi_ambiente, fila.numero]));
    const firmaEsperada = crypto.createHash('sha256').update(`${op.reference}${op.amountInCents}COP${'SECRETO-alfa-' + sfx}`).digest('hex');
    comprobar(op.signature.integrity === firmaEsperada, 'la firma se hizo con el secreto de A');
    // aprobado
    await a.eval(`window.__wompiCb({ transaction: { status: 'APPROVED', id: 'tx-1' } }); true`);
    await a.esperar(`function(){return document.getElementById('confirmOverlay').classList.contains('open');}`, 5000, 'confirmacion');
    const c = await a.eval(`(function(){return {titulo:document.getElementById('confirmTitulo').textContent, ref:document.getElementById('confirmRef').textContent,
      href:document.getElementById('confirmSeguirBtn').getAttribute('href'), link:document.getElementById('confirmLinkTexto').textContent,
      banner: localStorage.getItem('seguimiento-v2')};})()`);
    comprobar(c.titulo === '¡Pedido confirmado! 🍕', 'la confirmacion lleva el emoji del restaurante', c.titulo);
    comprobar(c.href === `pedido.html?ref=${fila.token_seguimiento}` && c.link === `${URL_N('alfa.localhost')}/pedido.html?ref=${fila.token_seguimiento}` && !c.href.includes(op.reference),
      'el enlace de seguimiento usa el TOKEN (no la referencia) y el link visible usa el origen actual', JSON.stringify(c));
    comprobar(JSON.parse(c.banner).rid === A.id && JSON.parse(c.banner).v.enlace === fila.token_seguimiento && JSON.parse(c.banner).v.referencia === op.reference, 'el banner de pedido en curso se guarda con el id del restaurante y el token');
    // WhatsApp del pedido pagado: usa el numero del restaurante
    await a.eval(`window.__aperturas=[]; window.open=function(u){window.__aperturas.push(u);}; true`);
    await a.clic('#confirmWhatsappBtn');
    const ap = await a.eval('window.__aperturas[0]');
    comprobar(ap && ap.startsWith('https://wa.me/573100000001?text=') && decodeURIComponent(ap).includes('🍕 *PEDIDO PAGADO EN LÍNEA*') && decodeURIComponent(ap).includes(`Ref: ${op.reference}`), 'el WhatsApp de "enviar copia" va al numero del restaurante y lleva su emoji', ap);
    comprobar(a.errores.length === 0, 'sin errores de JavaScript', a.errores.join('|'));

    // el mismo flujo en B no toca A
    const b = await abrir('beta', URL_N('beta.localhost') + '/');
    comprobar(await b.eval(`localStorage.getItem('seguimiento-v2')`) === null && (await b.eval(`document.getElementById('bannerPedido').classList.contains('show')`)) === false, 'el banner de seguimiento de A no aparece en B (otro origen)');
  });

  await escenario('8. El almacenamiento del navegador no mezcla restaurantes', async () => {
    // Mismo origen (un solo dominio), pero con datos guardados por OTRO restaurante: se descartan.
    const pg = await pagina('almacen');
    await pg.ir(URL_N('alfa.localhost') + '/robots-inexistente');   // solo para fijar el origen
    await pg.eval(`localStorage.setItem('menu-v2', JSON.stringify({rid:'${B.id}', v:{ok:true, categorias:[{id:'principal',nombre:'Rolls',emoji:'',orden:1}], productos:[{id:'roll',nombre:'Roll Beta',precio:25000,categoria:'principal',disponible:true}]}}));
      localStorage.setItem('carrito-v2', JSON.stringify({rid:'${B.id}', v:{roll:3}}));
      localStorage.setItem('seguimiento-v2', JSON.stringify({rid:'${B.id}', v:{referencia:'TAQ-X', enlace:'tokenajeno123456', guardadoEn:Date.now()}})); true`);
    estadoServidor.menuFalla = true;
    await pg.ir(URL_N('alfa.localhost') + '/');
    await pg.esperar(`function(){return document.documentElement.classList.contains('rp-listo') && document.querySelectorAll('#menu .menu-caido').length>0;}`, 12000, 'menu caido');
    const t = await texto(pg);
    comprobar(!t.includes('Roll Beta') && /no pudimos cargar el men/i.test(t), 'con el servidor del menu caido, NO se muestra la copia guardada por otro restaurante', t.slice(0, 300));
    comprobar((await pg.eval(`document.getElementById('cartBadge').hidden`)) === true && await pg.eval(`localStorage.getItem('carrito-v2')`) === null, 'el carrito de otro restaurante se descarta');
    comprobar((await pg.eval(`document.getElementById('bannerPedido').classList.contains('show')`)) === false && await pg.eval(`localStorage.getItem('seguimiento-v2')`) === null, 'el seguimiento de otro restaurante se descarta');
    // y la copia propia SI se usa
    estadoServidor.menuFalla = false;
    await pg.ir(URL_N('alfa.localhost') + '/');
    await pg.esperar(`function(){return document.querySelectorAll('#menu .card').length>0;}`, 12000, 'menu');
    estadoServidor.menuFalla = true;
    await pg.ir(URL_N('alfa.localhost') + '/');
    await pg.esperar(`function(){return document.documentElement.classList.contains('rp-listo') && document.querySelectorAll('#menu .card').length>0;}`, 12000, 'menu desde la copia propia');
    comprobar((await texto(pg)).includes('Pizza Alfa') && (await pg.eval(`document.getElementById('menuAviso').hidden`)) === false, 'con el servidor del menu caido, la copia guardada del PROPIO restaurante si se muestra (con aviso)');
    estadoServidor.menuFalla = false;
    comprobar(pg.errores.length === 0, 'sin errores de JavaScript', pg.errores.join('|'));
  });

  // ---------------------------------------------------------------------------------------------------------
  const SNAP = `(function(){
    var out = [];
    var els = document.body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.closest('#rp-estado') || e.tagName === 'SCRIPT' || e.tagName === 'STYLE' || e.closest('#mapaDomicilio') || e.closest('#mapaConfirmacion')) continue;
      var cs = getComputedStyle(e);
      var propios = Array.prototype.filter.call(e.childNodes, function(n){return n.nodeType === 3;}).map(function(n){return n.nodeValue.replace(/\\s+/g,' ').trim();}).filter(Boolean).join('|');
      var attrs = [];
      ['class','href','src','alt','placeholder','aria-label','target','rel','type','value','name','for','role'].forEach(function(a){ if (e.hasAttribute(a)) attrs.push(a + '=' + e.getAttribute(a)); });
      // (sin 'opacity': las animaciones de entrada la cambian con el tiempo y no es un dato de la pagina)
      out.push([e.tagName, attrs.join(' '), propios, cs.display, cs.visibility, cs.color, cs.backgroundColor, cs.borderTopColor, cs.fontSize, String(e.hidden)].join(' ~ '));
    }
    var vars = ['--rojo','--rojo-oscuro','--rojo-brillo','--crema','--crema-suave','--carbon','--carbon-2','--mostaza','--verde','--texto-claro','--texto-secundario','--texto-tenue','--verde-brillo']
      .map(function(v){return v + '=' + getComputedStyle(document.documentElement).getPropertyValue(v).trim().toUpperCase();});
    var icono = document.querySelector('link[rel=icon]');
    return { filas: out, vars: vars, titulo: document.title, desc: (document.querySelector('meta[name=description]')||{}).content, icono: icono ? icono.getAttribute('href') : null };
  })()`;

  function comparar(etiqueta, antiguo, nuevo) {
    // Cambio a proposito (paso 3A, R7): el horario de la prueba es 00:00 a 24:00 y la pagina de antes mostraba el cierre 24:00 como
    // "12:00 p.m." (el mediodia, un error); ahora dice "12:00 a.m. (medianoche)". Solo cambia ese texto.
    const aMedianoche = (fila) => fila.split(' hasta las 12:00 p.m.').join(' hasta las 12:00 a.m. (medianoche)').split('– 12:00 p.m.').join('– 12:00 a.m. (medianoche)');
    const a = antiguo.filas.map(aMedianoche), n = nuevo.filas;
    const diffs = [];
    if (a.length !== n.length) diffs.push(`elementos: ${a.length} antes, ${n.length} ahora`);
    for (let i = 0; i < Math.max(a.length, n.length); i++) {
      if (a[i] !== n[i] && diffs.length < 6) diffs.push(`#${i}\n      antes: ${a[i]}\n      ahora: ${n[i]}`);
    }
    // las variables del tema pueden diferir de mayusculas; el resto debe ser identico
    // (--texto-secundario y --texto-tenue cambian de papel entre index y pedido; sus efectos ya estan en los colores calculados de cada elemento)
    const sinTextos = (v) => !/texto-secundario|texto-tenue|verde-brillo/.test(v);
    const varsOk = JSON.stringify(antiguo.vars.filter(sinTextos)) === JSON.stringify(nuevo.vars.filter(sinTextos));
    if (!varsOk) diffs.push('variables CSS: ' + JSON.stringify(antiguo.vars) + ' vs ' + JSON.stringify(nuevo.vars));
    if (antiguo.titulo !== nuevo.titulo) diffs.push(`titulo: "${antiguo.titulo}" vs "${nuevo.titulo}"`);
    if (antiguo.desc !== nuevo.desc) diffs.push(`descripcion: "${antiguo.desc}" vs "${nuevo.desc}"`);
    if (new URL(antiguo.icono, 'http://x/').pathname !== new URL(nuevo.icono, 'http://x/').pathname) diffs.push(`icono: ${antiguo.icono} vs ${nuevo.icono}`);
    comprobar(diffs.length === 0, `Taqueiros identico (${etiqueta}): ${a.length} elementos comparados con estilos calculados`, diffs.join('\n    '));
  }

  await escenario('5. TAQUEIROS SE VE IDENTICO (comparado con el commit ' + COMMIT_ANTERIOR + ')', async () => {
    if (!hayAntiguo) { comprobar(true, '(omitido: no hay historial git)'); return; }
    const URL_A = `http://taqueiros.localhost:${PUERTO_ANTIGUO}`, URL_NU = `http://taqueiros.localhost:${PUERTO_WEB}`;
    const nuevoSitio = await abrir('taq-nuevo', URL_NU + '/');
    const viejoSitio = await abrir('taq-viejo', URL_A + '/');
    comparar('portada', await viejoSitio.eval(SNAP), await nuevoSitio.eval(SNAP));
    const rn = await nuevoSitio.eval('JSON.stringify(window.RP.datos.pago)');
    comprobar(JSON.parse(rn).llave === 'pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz' && JSON.parse(rn).modo === 'test'
      && await nuevoSitio.eval('WOMPI_PUBLIC_KEY') === 'pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz'
      && await viejoSitio.eval('WOMPI_PUBLIC_KEY') === 'pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz', 'la llave publica y el modo de Taqueiros son los de siempre (pruebas)');
    comprobar(await nuevoSitio.eval('WOMPI_REDIRECT_URL') === `${URL_NU}/?pago=exitoso` && await viejoSitio.eval('WOMPI_REDIRECT_URL') === 'https://taqueiros-2-0.vercel.app/?pago=exitoso',
      'la redireccion de Wompi usa el origen actual (en produccion el origen ES https://taqueiros-2-0.vercel.app: la misma URL de siempre)');
    const calc = (pg) => pg.eval(`JSON.stringify([calcularDomicilio(7.8997382,-72.4968525), calcularDomicilio(7.909,-72.4968525), calcularDomicilio(7.93,-72.45), calcularDomicilio(7.96,-72.40), calcularDomicilio(8.05,-72.35), calcularDomicilio(8.2,-72.3)])`);
    const cn = await calc(nuevoSitio), cv = await calc(viejoSitio);
    comprobar(cn === cv, 'tarifas, coordenadas y factor de recorrido: el mismo calculo en 6 puntos', cv + ' // ' + cn);
    comprobar((await nuevoSitio.eval('JSON.stringify(TARIFAS_DOMICILIO)')) === (await viejoSitio.eval('JSON.stringify(TARIFAS_DOMICILIO)')) && (await nuevoSitio.eval('JSON.stringify(RESTAURANTE)')) === (await viejoSitio.eval('JSON.stringify(RESTAURANTE)'))
      && (await nuevoSitio.eval('FACTOR_RECORRIDO')) === (await viejoSitio.eval('FACTOR_RECORRIDO')) && (await nuevoSitio.eval('JSON.stringify(COLORES_ZONA)')) === (await viejoSitio.eval('JSON.stringify(COLORES_ZONA)')), 'TARIFAS_DOMICILIO, RESTAURANTE, FACTOR_RECORRIDO y COLORES_ZONA identicos');

    // carrito abierto con un producto
    for (const pg of [nuevoSitio, viejoSitio]) { await pg.clic('.card:nth-of-type(1) .add-btn'); await pg.clic('#openCartBtn'); }
    await sleep(300);
    comparar('carrito con un producto', await viejoSitio.eval(SNAP), await nuevoSitio.eval(SNAP));
    // formulario de pago
    for (const pg of [nuevoSitio, viejoSitio]) { await pg.clic('#payOnlineBtn'); }
    await sleep(300);
    comparar('formulario de pago (domicilio)', await viejoSitio.eval(SNAP), await nuevoSitio.eval(SNAP));
    for (const pg of [nuevoSitio, viejoSitio]) await pg.eval(`document.getElementById('paymentFormOverlay').classList.remove('open'); document.getElementById('overlay').classList.remove('open'); document.getElementById('drawer').classList.remove('open'); true`);
    // buscar mi pedido con resultados
    for (const pg of [nuevoSitio, viejoSitio]) {
      await pg.clic('#abrirBuscarPedido');
      await pg.escribir('#bp-telefono', '3003330003'); await pg.escribir('#bp-total', '15000');
      await pg.clic('#btnBuscarPedido');
      await pg.esperar(`function(){return document.querySelectorAll('#resultadosBusqueda .resultado-pedido').length>0;}`, 8000, 'busqueda');
    }
    const snapBuscar = await Promise.all([viejoSitio.eval(SNAP), nuevoSitio.eval(SNAP)]);
    // el enlace del resultado cambia a propósito (token en lugar de referencia): se compara aparte
    const sinHref = (s) => ({ ...s, filas: s.filas.map((f) => f.replace(/href=pedido\.html\?ref=\S+/, 'href=<enlace>')) });
    comparar('buscar mi pedido con resultados', sinHref(snapBuscar[0]), sinHref(snapBuscar[1]));
    const hrefV = await viejoSitio.eval(`document.querySelector('.resultado-pedido').getAttribute('href')`);
    const hrefN = await nuevoSitio.eval(`document.querySelector('.resultado-pedido').getAttribute('href')`);
    const fT = (await srv('GET', `pedidos?referencia=eq.${pT.referencia}&select=token_seguimiento,numero,id`))[0];
    comprobar(hrefV === `pedido.html?ref=${pT.referencia}` && hrefN === `pedido.html?ref=${fT.token_seguimiento}`, 'unica diferencia a proposito: el enlace usa el token en vez de la referencia', hrefV + ' // ' + hrefN);
    // (la pagina vieja tambien muestra el numero: lo que cambio es la funcion de la base, SQL 12. Aqui el id y el numero SI difieren.)
    comprobar(Number(fT.id) !== Number(fT.numero)
      && (await viejoSitio.eval(`document.querySelector('.resultado-pedido .num').textContent`)).startsWith(`Pedido #${String(fT.numero).padStart(3, '0')}`)
      && (await nuevoSitio.eval(`document.querySelector('.resultado-pedido .num').textContent`)).startsWith(`Pedido #${String(fT.numero).padStart(3, '0')}`), 'el numero que se ve es el del restaurante, no el id (aqui difieren: id ' + fT.id + ', numero ' + fT.numero + ')', `${fT.id} vs ${fT.numero}`);
    // seguimiento (pedido.html) con el mismo pedido: antiguo por referencia, nuevo por token
    const segV = await pagina('seg-viejo'); await segV.ir(`${URL_A}/pedido.html?ref=${pT.referencia}`);
    const segN = await pagina('seg-nuevo'); await segN.ir(`${URL_NU}/pedido.html?ref=${fT.token_seguimiento}`);
    await segV.esperar(`function(){return document.querySelectorAll('.progreso').length>0;}`, 10000, 'seguimiento antiguo');
    await segN.esperar(`function(){return document.querySelectorAll('.progreso').length>0 && document.documentElement.classList.contains('rp-listo');}`, 10000, 'seguimiento nuevo');
    const snapSeg = await Promise.all([segV.eval(SNAP), segN.eval(SNAP)]);
    const ajusta = (s) => ({ ...s, filas: s.filas.map((f) => f.replace(/Pedido #\d+/, 'Pedido #N')) });
    comparar('seguimiento del pedido (pedido.html)', ajusta(snapSeg[0]), ajusta(snapSeg[1]));
    // cerrado: el banner con el mensaje del servidor
    await parchear('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}`, { cerrado_temporal: true, mensaje_cerrado: 'Cerrado por inventario' });
    // el banner se actualiza en el siguiente sondeo: se recarga
    const cierraN = await abrir('taq-cerrado-n', URL_NU + '/'); const cierraV = await abrir('taq-cerrado-v', URL_A + '/');
    comprobar(await variable(cierraN, '--rojo') === '#C1272D', 'cerrado: la pagina nueva se pinta con los colores de Taqueiros', JSON.stringify(await cierraN.eval('JSON.stringify([RP.datos && RP.datos.marca, document.documentElement.getAttribute("style"), document.getElementById("rp-estado") && document.getElementById("rp-estado").className])')));
    comparar('restaurante cerrado (mensaje del dueno)', await cierraV.eval(SNAP), await cierraN.eval(SNAP));
    await parchear('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}`, { cerrado_temporal: false, mensaje_cerrado: null });
    comprobar(nuevoSitio.errores.length === 0 && segN.errores.length === 0, 'sin errores de JavaScript en el sitio nuevo', nuevoSitio.errores.concat(segN.errores).join('|'));
  });

  // ---------------------------------------------------------------------------------------------------------
  await escenario('9. Archivos: nada de Taqueiros escrito a mano en las paginas publicas, el service worker y el manifest', async () => {
    const leer = (f) => fs.readFileSync(path.join(f === 'vercel.json' || f === 'sw.js' ? REPO : RAIZ_NUEVA, f), 'utf8');
    const html = leer('index.html'), ped = leer('pedido.html'), lib = leer('restaurante-publico.js'), sw = leer('sw.js');
    const prohibidos = [/Taqueiros/i, /C[uú]cuta/i, /573125249438/, /312 524/, /1AN/, /La Ceiba/, /lostaqueiros/i, /pub_(test|prod)_[A-Za-z0-9]{20}/, /vercel\.app/, /\bWOMPI_MODE\b/, /#C1272D/i, /#F7ECD6/i, /#1C1210/i, /#E3A008/i, /#8A1B1F/i, /#5C7A3B/i, /Birria|Tacos|dorilocos|comal/i];
    // permitido: el nombre del objeto global compartido (window.SUPABASE_PUBLICO, definido en supabase-publico.js)
    const limpio = (s) => s.split('SUPABASE_PUBLICO').join('');
    for (const [n, c] of [['index.html', html], ['pedido.html', ped], ['restaurante-publico.js', lib]]) {
      const malos = prohibidos.filter((re) => re.test(limpio(c))).map(String);
      comprobar(malos.length === 0, `${n}: ningun valor propio de Taqueiros escrito`, malos.join(' '));
    }
    comprobar(!fs.existsSync(path.join(REPO, 'manifest.json')), 'ya no existe manifest.json estatico (lo sirve /api/manifest por restaurante)');
    const rutaManifest = EMULADOR.resolver({ ruta: '/manifest.json' });
    comprobar(rutaManifest.tipo === 'funcion' && rutaManifest.archivo === 'api/publico.js' && /_ruta=manifest/.test(rutaManifest.urlReescrita), 'vercel.json lleva /manifest.json a la funcion agrupada (modulo manifest)');
    comprobar(/const VERSION = "v11"/.test(sw) && /const CASCARON = \[\]/.test(sw) && /pathname === "\/manifest\.json"/.test(sw) && !/manifest\.json"\s*\n?\s*\]/.test(sw), 'sw.js: version v11, sin precache y el manifest siempre por la red');
    comprobar(/startsWith\("\/api\/"\)/.test(sw), 'sw.js: /api/ (incluido /api/restaurante) y el menu siempre por la red');
  });

  // ---------------------------------------------------------------------------------------------------------
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
  try { chrome.kill(); } catch (e) { /* ya cerro */ }
  try { sitioNuevo.close(); if (sitioAntiguo) sitioAntiguo.close(); await falso.cerrar(); } catch (e) { /* ya cerro */ }
  try { fs.rmSync(perfil, { recursive: true, force: true }); fs.rmSync(raizAntigua, { recursive: true, force: true }); } catch (e) { /* en uso */ }
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 800).unref();
})().catch((e) => { console.error(e); process.exit(1); });
