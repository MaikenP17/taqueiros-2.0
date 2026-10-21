/* =============================================================
   PRUEBA DE LA VISTA PREVIA DE ENLACES POR RESTAURANTE  (docs seccion 17)

   Los rastreadores de WhatsApp, Instagram, Facebook, Telegram, X, Slack, LinkedIn y Discord no ejecutan
   JavaScript: leen las etiquetas del HTML. api/_modulos/vista-previa.js sirve a ESOS (y solo a esos, por
   User-Agent, via una redireccion de vercel.json) la misma pagina con las etiquetas del restaurante del host.

   Se prueba con los manejadores reales, el enrutador de vercel.json (vercel-emulador.mjs) y Postgres real
   (PGlite con los SQL 10 a 13):

     1. dos restaurantes con host distinto reciben SU titulo, descripcion e imagen (y nada del otro, tambien en paralelo)
     2. cada rastreador (10 User-Agent) entra por "/", "/index.html" y "/pedido.html"; las personas, Googlebot, el
        navegador de Instagram y un User-Agent vacio reciben el archivo estatico, que NO cambio (bytes iguales a antes)
     3. datos hostiles (HTML, comillas, javascript:, //, http:, otros origenes, <title> de cierre) quedan escapados o descartados
     4. host desconocido, base caida, pagina ilegible o un fallo del modulo: la pagina neutra de siempre, jamas datos ajenos
     5. cabeceras: sin cache compartida, Vary, metodo; una persona que llega a la funcion es devuelta a la pagina
     6. la lista de rastreadores es la MISMA en vercel.json y en el modulo
     7. la pagina inyectada es la estatica con SOLO el titulo y la descripcion cambiados y las etiquetas agregadas

     node pruebas/multirestaurante/vista-previa.mjs
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { levantar } from './fake-supabase.mjs';
import { crearEmulador } from './vercel-emulador.mjs';
import { ejecutar, extraerAntes } from './agrupacion.mjs';
import { REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const RAIZ = process.env.AGRUPACION_REPO ? path.resolve(process.env.AGRUPACION_REPO) : REPO;
const LLAVE = 'sb_secret_FAKE_0000';
const PUBLICABLE = 'sb_publishable_FAKE_0000';

const resultados = [];
const comprobar = (cond, nombre, info) => resultados.push({ nombre, ok: !!cond, info: cond ? '' : String(info === undefined ? '' : info).slice(0, 400) });

const UA_RASTREADORES = {
  WhatsApp: 'WhatsApp/2.23.20.0',
  'WhatsApp (iOS)': 'WhatsApp/2.23.20.76 i',
  Facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Facebook (Facebot)': 'Facebot',
  'Meta (Instagram y Facebook)': 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  Telegram: 'TelegramBot (like TwitterBot)',
  'X / Twitter': 'Twitterbot/1.0',
  Slack: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Slack (imagenes)': 'Slack-ImgProxy (+https://api.slack.com/robots)',
  LinkedIn: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
  Discord: 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
};
const UA_PERSONAS = {
  Chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Safari iPhone': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Navegador de Instagram (personas, enlace de la biografia)': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0.0.0 (iPhone14,2)',
  'Navegador de Facebook (personas)': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/430.0.0.0;]',
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  curl: 'curl/8.4.0',
  vacio: ''
};

function horariosTodoElDia() {
  return ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((dia) => ({ dia, abre: '00:00', cierra: '24:00', activo: true }));
}

function etiquetaMeta(html, atributo, nombre) {
  const re = new RegExp('<meta ' + atributo + '="' + nombre.replace(/[:.]/g, (c) => '[' + c + ']') + '" content="([^"]*)">', 'g');
  const todas = []; let m;
  while ((m = re.exec(html))) todas.push(m[1]);
  return todas;
}
const titulo = (html) => (/<title>([^<]*)<[/]title>/.exec(html) || [])[1];

async function main() {
  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-vp-'));
  const consolaReal = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const entorno = { ...process.env };
  const fetchReal = globalThis.fetch;
  let falso = null;
  try {
    falso = await levantar({ puerto: 54351 + Number(process.env.PUERTO_OFFSET || 0), validarConfig: false });
    const { cabecerasSupabase } = require(path.join(REPO, 'api', '_llave.js'));
    const rest = async (metodo, ruta, cuerpo) => {
      const r = await fetchReal(`${falso.url}/rest/v1/${ruta}`, { method: metodo, headers: cabecerasSupabase(LLAVE, metodo === 'GET' ? undefined : { Prefer: 'return=representation' }), body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
      const t = await r.text();
      if (!r.ok) throw new Error(`${metodo} ${ruta.slice(0, 50)} -> ${r.status} ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    };

    process.env.SUPABASE_URL = falso.url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = LLAVE;
    process.env.SUPABASE_PUBLISHABLE_KEY = PUBLICABLE;
    process.env.VERCEL_ENV = 'production';
    delete process.env.DOMINIO_BASE; delete process.env.RESTAURANTE_POR_PARAMETRO;
    for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_INTEGRITY_SECRET_PROD', 'WOMPI_EVENTS_SECRET_TEST', 'WOMPI_EVENTS_SECRET_PROD', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];
    for (const n of ['log', 'warn', 'error', 'info']) console[n] = () => {};

    // ---- restaurantes ----
    const HOST = { A: 'alfa.vp-prueba.test', B: 'beta.vp-prueba.test', H: 'hostil.vp-prueba.test', V: 'vacio.vp-prueba.test', X: 'desconocido.vp-prueba.test', TAQ: 'taqueiros-2-0.vercel.app' };
    const IDS = { A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', H: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', V: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    const base = (n, nombre, extra = {}) => ({
      ubicacion: { lat: 7.9, lng: -72.5 },
      publico: { marca: { logo: `Recursos/${n}/logo.png`, colores: { primario: n === 'a' ? '#AA1122' : '#1122AA' } },
        textos: { titulo_pagina: `Pide en ${nombre}`, descripcion_pagina: `Los mejores platos de ${nombre}, hechos hoy.` }, contacto: { whatsapp: '573001112233' }, ...extra }
    });
    await rest('POST', 'restaurantes', { id: IDS.A, slug: 'vp-alfa', nombre: 'Alfa Tacos', estado: 'activo', config: base('a', 'Alfa Tacos') });
    await rest('POST', 'restaurantes', { id: IDS.B, slug: 'vp-beta', nombre: 'Beta Pizzas', estado: 'activo', config: base('b', 'Beta Pizzas') });
    await rest('POST', 'restaurantes', { id: IDS.V, slug: 'vp-vacio', nombre: 'Casa Vacia', estado: 'activo', config: {} });
    // Hostil: cada campo lleva un intento de inyeccion (la base lo habria rechazado: aqui el trigger esta apagado a proposito)
    const ataque = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    await rest('POST', 'restaurantes', {
      id: IDS.H, slug: 'vp-hostil', nombre: 'Hostil </title><script>alert(3)</script> "x" & \'y\'',
      config: { publico: { marca: { logo: 'javascript:alert(1)', icono_512: '//evil.example/x.png', icono_192: 'http://evil.example/x.png', colores: { primario: 'red;background:url(x)' } },
        textos: { titulo_pagina: ataque + ' Titulo', descripcion_pagina: 'x" onload="alert(4)" y=\'<b>z</b>\' &amp; &lt;' } } }, estado: 'activo'
    });
    for (const [k, h] of [['A', HOST.A], ['B', HOST.B], ['H', HOST.H], ['V', HOST.V]]) await rest('POST', 'restaurante_dominios', { host: h, restaurante_id: IDS[k] });

    const emu = crearEmulador(RAIZ);
    const dispatcher = require(path.join(RAIZ, 'api', 'publico.js'));

    // Pide una pagina como la pediria un rastreador/persona: pasa por el enrutador, sigue una redireccion y ejecuta la funcion
    async function pedir({ host, ruta = '/', ua, metodo = 'GET', headers = {}, funcion = dispatcher, enrutador = emu }) {
      const cab = { host, ...headers }; if (ua !== undefined) cab['user-agent'] = ua;
      let r = enrutador.resolver({ metodo, ruta, headers: cab });
      const pasos = [r.tipo];
      let location = null;
      if (r.tipo === 'redireccion') { location = r.location; r = enrutador.resolver({ metodo, ruta: r.location, headers: cab }); pasos.push(r.tipo); }
      if (r.tipo === 'estatico') return { pasos, estatico: r.archivo, location };
      if (r.tipo !== 'funcion') return { pasos, error: JSON.stringify(r), location };
      const q = Object.fromEntries(new URLSearchParams(r.urlReescrita.split('?')[1] || ''));
      const salida = await ejecutar(funcion, { method: metodo, url: r.urlReescrita, headers: cab, query: q });
      return { pasos, location, ...salida, html: typeof salida.cuerpo === 'string' ? salida.cuerpo : null };
    }

    const indexEstatico = fs.readFileSync(path.join(RAIZ, 'index.html'), 'utf8');
    const pedidoEstatico = fs.readFileSync(path.join(RAIZ, 'pedido.html'), 'utf8');

    /* ---------------- 1. dos restaurantes, cada uno lo suyo ---------------- */
    const wa = UA_RASTREADORES.WhatsApp;
    const pa = await pedir({ host: HOST.A, ua: wa }), pb = await pedir({ host: HOST.B, ua: wa });
    comprobar(pa.pasos.join('>') === 'redireccion>funcion' && pa.status === 200, '1a un rastreador pasa de "/" a la funcion (307 -> funcion) y recibe 200', JSON.stringify(pa.pasos) + pa.status);
    const checa = (p, h, nombre, tit, desc, logoRuta, color, url) => {
      const html = p.html || '';
      const fallas = [];
      if (titulo(html) !== tit) fallas.push('title=' + titulo(html));
      const un = (a, n) => etiquetaMeta(html, a, n);
      if (JSON.stringify(un('property', 'og:title')) !== JSON.stringify([tit])) fallas.push('og:title');
      if (JSON.stringify(un('property', 'og:description')) !== JSON.stringify([desc])) fallas.push('og:description');
      if (JSON.stringify(un('name', 'description')) !== JSON.stringify([desc])) fallas.push('description');
      if (JSON.stringify(un('property', 'og:image')) !== JSON.stringify([`https://${h}/${logoRuta}`])) fallas.push('og:image=' + un('property', 'og:image'));
      if (JSON.stringify(un('property', 'og:url')) !== JSON.stringify([url])) fallas.push('og:url=' + un('property', 'og:url'));
      if (JSON.stringify(un('property', 'og:type')) !== JSON.stringify(['website'])) fallas.push('og:type');
      if (JSON.stringify(un('property', 'og:locale')) !== JSON.stringify(['es_CO'])) fallas.push('og:locale');
      if (JSON.stringify(un('name', 'theme-color')) !== JSON.stringify([color])) fallas.push('theme-color');
      if (JSON.stringify(un('property', 'og:site_name')) !== JSON.stringify([nombre])) fallas.push('og:site_name');
      if (JSON.stringify(un('name', 'twitter:card')) !== JSON.stringify(['summary'])) fallas.push('twitter:card');
      if (JSON.stringify(un('name', 'twitter:image')) !== JSON.stringify([`https://${h}/${logoRuta}`])) fallas.push('twitter:image');
      if (JSON.stringify(un('property', 'og:image:alt')) !== JSON.stringify([nombre])) fallas.push('og:image:alt');
      if (JSON.stringify(un('name', 'twitter:title')) !== JSON.stringify([tit]) || JSON.stringify(un('name', 'twitter:description')) !== JSON.stringify([desc])) fallas.push('twitter:title/description');
      return fallas;
    };
    let f = checa(pa, HOST.A, 'Alfa Tacos', 'Pide en Alfa Tacos', 'Los mejores platos de Alfa Tacos, hechos hoy.', 'Recursos/a/logo.png', '#AA1122', `https://${HOST.A}/`);
    comprobar(f.length === 0, '1b Alfa: title, description, og:title, og:description, og:image (https absoluta), og:url, og:type, og:locale, theme-color, og:site_name y twitter', f.join(','));
    f = checa(pb, HOST.B, 'Beta Pizzas', 'Pide en Beta Pizzas', 'Los mejores platos de Beta Pizzas, hechos hoy.', 'Recursos/b/logo.png', '#1122AA', `https://${HOST.B}/`);
    comprobar(f.length === 0, '1c Beta: lo mismo, con SUS datos', f.join(','));
    comprobar(!/Alfa/.test(pb.html) && !/Beta/.test(pa.html) && !pa.html.includes('/b/logo') && !pb.html.includes('/a/logo') && !pa.html.includes('#1122AA') && !pb.html.includes('#AA1122'),
      '1d la pagina de Alfa no trae nada de Beta y la de Beta nada de Alfa', '');
    const mezcla = await Promise.all(Array.from({ length: 40 }, (_, i) => pedir({ host: i % 2 ? HOST.A : HOST.B, ua: UA_RASTREADORES[Object.keys(UA_RASTREADORES)[i % 11]] })));
    comprobar(mezcla.every((p, i) => p.status === 200 && p.html.includes(i % 2 ? 'Pide en Alfa Tacos' : 'Pide en Beta Pizzas') && !p.html.includes(i % 2 ? 'Beta Pizzas' : 'Alfa Tacos')),
      '1e 40 peticiones en paralelo de los dos restaurantes: cada una recibe solo lo suyo', mezcla.findIndex((p, i) => !(p.html || '').includes(i % 2 ? 'Alfa' : 'Beta')));

    // una descripcion y titulo por omision (restaurante sin textos)
    const pv = await pedir({ host: HOST.V, ua: wa });
    comprobar(titulo(pv.html) === 'Casa Vacia' && etiquetaMeta(pv.html, 'property', 'og:description')[0] === 'Pide en línea en Casa Vacia.' && etiquetaMeta(pv.html, 'property', 'og:image').length === 0 && etiquetaMeta(pv.html, 'name', 'theme-color').length === 0,
      '1f sin textos ni logo: el titulo es el nombre, la descripcion la de siempre, y no hay og:image ni theme-color inventados', JSON.stringify([titulo(pv.html), etiquetaMeta(pv.html, 'property', 'og:description')]));

    // Taqueiros (host real de produccion)
    const pt = await pedir({ host: HOST.TAQ, ua: wa });
    const respaldo = require(path.join(RAIZ, 'api', '_respaldo-taqueiros.js')).CONFIG_TAQUEIROS.publico;
    comprobar(pt.status === 200 && titulo(pt.html) === respaldo.textos.titulo_pagina && etiquetaMeta(pt.html, 'property', 'og:image')[0] === `https://${HOST.TAQ}/${respaldo.marca.logo}`
      && fs.existsSync(path.join(RAIZ, respaldo.marca.logo)) , '1g Taqueiros: su titulo, su descripcion y su logo (el archivo existe en el sitio)', JSON.stringify([titulo(pt.html), etiquetaMeta(pt.html, 'property', 'og:image')]));

    // pedido.html: seguimiento
    const pp = await pedir({ host: HOST.A, ruta: '/pedido.html?ref=TAQ-123-abcdef&t=0123456789abcdef0123456789abcdef', ua: wa });
    comprobar(pp.pasos.join('>') === 'redireccion>funcion' && titulo(pp.html) === 'Sigue tu pedido | Alfa Tacos' && etiquetaMeta(pp.html, 'property', 'og:url')[0] === `https://${HOST.A}/pedido.html`
      && etiquetaMeta(pp.html, 'property', 'og:description')[0] === 'Sigue el estado de tu pedido en Alfa Tacos.', '1h pedido.html: titulo de seguimiento con el nombre y og:url sin la consulta', JSON.stringify([pp.pasos, titulo(pp.html)]));
    comprobar(!pp.html.includes('TAQ-123') && !pp.html.includes('0123456789abcdef0123456789abcdef') && !(pp.location || '').includes('TAQ-123'),
      '1i el enlace de seguimiento (referencia y token) no se copia a la vista previa ni a la redireccion', pp.location);
    comprobar(pp.html.includes('<meta name="robots" content="noindex, nofollow">'), '1j pedido.html conserva su noindex', '');

    /* ---------------- 2. rastreadores vs personas ---------------- */
    let fallas = [];
    for (const [nombre, ua] of Object.entries(UA_RASTREADORES)) {
      for (const ruta of ['/', '/index.html', '/pedido.html']) {
        const p = await pedir({ host: HOST.A, ruta, ua });
        const esPedido = ruta === '/pedido.html';
        if (!(p.pasos.join('>') === 'redireccion>funcion' && p.status === 200 && p.cab['x-vista-previa'] === 'restaurante' && titulo(p.html) === (esPedido ? 'Sigue tu pedido | Alfa Tacos' : 'Pide en Alfa Tacos'))) fallas.push(`${nombre} ${ruta}: ${p.pasos} ${p.status}`);
      }
    }
    comprobar(fallas.length === 0, `2a los ${Object.keys(UA_RASTREADORES).length} User-Agent de rastreadores reciben la vista previa en "/", "/index.html" y "/pedido.html"`, fallas.slice(0, 3).join(' | '));
    fallas = [];
    for (const [nombre, ua] of Object.entries(UA_PERSONAS)) {
      for (const [ruta, archivo] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/pedido.html', 'pedido.html'], ['/pedido.html?ref=TAQ-1-abc', 'pedido.html']]) {
        const p = await pedir({ host: HOST.A, ruta, ua });
        if (!(p.pasos.length === 1 && p.pasos[0] === 'estatico' && p.estatico === archivo)) fallas.push(`${nombre} ${ruta}: ${JSON.stringify(p.pasos)}`);
      }
    }
    comprobar(fallas.length === 0, `2b ${Object.keys(UA_PERSONAS).length} tipos de personas/herramientas (Chrome, Safari, navegador de Instagram y de Facebook, Googlebot, curl, sin User-Agent) reciben el archivo estatico, sin pasar por la funcion`, fallas.slice(0, 3).join(' | '));
    const sinUA = emu.resolver({ ruta: '/', headers: { host: HOST.A } });
    comprobar(sinUA.tipo === 'estatico', '2c una peticion sin cabecera User-Agent recibe el archivo estatico', JSON.stringify(sinUA));

    // las paginas estaticas no cambiaron: son las del commit anterior, byte a byte
    const antes = path.join(tmp, 'antes'); fs.mkdirSync(antes);
    const { execFileSync } = await import('node:child_process');
    const deGit = (archivo) => execFileSync('git', ['-C', REPO, 'show', `d689d4d:${archivo}`], { maxBuffer: 20 * 1024 * 1024 }).toString('utf8').replace(/\r\n/g, '\n');
    comprobar(indexEstatico.replace(/\r\n/g, '\n') === deGit('index.html') && pedidoEstatico.replace(/\r\n/g, '\n') === deGit('pedido.html'),
      '2d index.html y pedido.html son EXACTAMENTE los de antes (las personas reciben el mismo HTML de siempre)', '');
    void antes; void extraerAntes;

    // una persona que llegue a la funcion directamente es devuelta a la pagina de siempre, sin datos
    const dir = await pedir({ host: HOST.A, ruta: '/api/publico?_ruta=vista-previa&_pagina=index', ua: UA_PERSONAS.Chrome });
    comprobar(dir.status === 302 && dir.cab.location === '/' && !dir.cuerpo, '2e una persona que abre la URL de la funcion recibe 302 a "/" y ningun dato', JSON.stringify([dir.status, dir.cab, dir.cuerpo]));
    const dir2 = await pedir({ host: HOST.A, ruta: '/api/publico?_ruta=vista-previa&_pagina=pedido', ua: '' });
    comprobar(dir2.status === 302 && dir2.cab.location === '/pedido.html', '2f lo mismo para el seguimiento, y sin User-Agent', JSON.stringify([dir2.status, dir2.cab]));

    /* ---------------- 3. datos hostiles ---------------- */
    const ph = await pedir({ host: HOST.H, ua: wa });
    const h = ph.html;
    const cabeza = h.slice(0, h.indexOf('<link rel="preconnect"'));
    const malos = ['<script>alert', '<img src=x', '<b>z</b>', '</title><script>', 'javascript:', 'red;background', 'evil.example'];   // (el texto 'onerror=alert' queda como TEXTO escapado: sin < ni comillas no es un atributo)
    comprobar(ph.status === 200 && malos.every((m) => !h.includes(m)), '3a titulo, descripcion y nombre con HTML/comillas/script: nada de eso aparece sin escapar, y las imagenes (javascript:, //, http:, otro origen) y el color hostil se descartan', malos.filter((m) => h.includes(m)).join(' | '));
    comprobar(titulo(h) !== undefined && !/<title>[^<]*<[a-z]/i.test(h) && (h.match(/<title>/g) || []).length === 1, '3b sigue habiendo UN solo <title> bien cerrado', titulo(h));
    comprobar(etiquetaMeta(h, 'property', 'og:image').length === 0 && etiquetaMeta(h, 'name', 'theme-color').length === 0 && etiquetaMeta(h, 'name', 'twitter:image').length === 0,
      '3c sin imagen valida no hay og:image ni twitter:image, y un color invalido no sale como theme-color', '');
    comprobar(/&lt;script&gt;alert[(]1[)]&lt;[/]script&gt;/.test(cabeza) && cabeza.includes('&quot;') && !/content="[^"]*"[^>]*onerror/i.test(cabeza),
      '3d los caracteres peligrosos salen como entidades (&lt; &gt; &quot;), no como etiquetas ni como atributos nuevos', cabeza.slice(0, 600));
    comprobar(cabeza.includes('&amp;amp;') && cabeza.includes('&amp;lt;'),
      '3d2 un "&amp;" o "&lt;" escrito en un texto sale como &amp;amp; / &amp;lt; (el & se escapa primero: no se doble-decodifica)', cabeza.slice(0, 500));
    // cada valor entre comillas de la cabeza termina donde debe: ningun atributo extra aparece en los <meta> inyectados
    const metas = cabeza.match(/<meta [^>]*>/g) || [];
    comprobar(metas.every((m) => /^<meta (name|property|charset|http-equiv)="[^"]*"( content="[^"]*")?>$/.test(m) || /^<meta charset="UTF-8">$/.test(m) || /^<meta name="viewport" content="[^"]*">$/.test(m)),
      '3e todos los <meta> de la cabeza tienen exactamente la forma esperada (sin atributos colados)', metas.find((m) => !/^<meta (name|property|charset|http-equiv)="[^"]*"( content="[^"]*")?>$/.test(m)));

    // cada valor que el modulo escribe en una etiqueta se escapa, aunque llegara hostil por cualquier campo (defensa en capas:
    // aunque la validacion de _publico.js dejara pasar algo, el escape lo contiene)
    const moduloEsc = require(path.join(RAIZ, 'api', '_modulos', 'vista-previa.js'));
    const dHostil = { nombre: 'N"<b>&', titulo: 'T"<b>&', descripcion: 'D"<b>&', imagen: 'https://a.supabase.co/x.png?a=1&b="2"<c>', url: 'https://h.test/?q="<d>&', colorTema: '#112233"><e>' };
    const lineasHostiles = moduloEsc.etiquetas(dHostil).split('\n');
    comprobar(lineasHostiles.length >= 12 && lineasHostiles.every((l) => /^<meta (name|property)="[a-z:_-]+" content="[^"<>]*">$/.test(l)) && !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(moduloEsc.etiquetas(dHostil)),
      '3j con un valor hostil en CADA campo (nombre, titulo, descripcion, imagen, url, color), las ' + lineasHostiles.length + ' etiquetas conservan su forma: nada de <, >, comillas ni & sin escapar',
      lineasHostiles.filter((l) => !/^<meta (name|property)="[a-z:_-]+" content="[^"<>]*">$/.test(l)).join(' | '));
    comprobar(moduloEsc.etiquetas(dHostil).includes('content="https://a.supabase.co/x.png?a=1&amp;b=&quot;2&quot;&lt;c&gt;"') && moduloEsc.etiquetas(dHostil).includes('content="https://h.test/?q=&quot;&lt;d&gt;&amp;"'),
      '3k ...y la imagen y la url salen escapadas exactamente asi', moduloEsc.etiquetas(dHostil).split('\n').filter((l) => /og:image"|og:url/.test(l)).join(' | '));
    // unitario: URL de Storage https y variantes de imagen
    const PUB = require(path.join(RAIZ, 'api', '_publico.js'));
    const rest0 = { id: IDS.A, slug: 'vp-alfa', nombre: 'Alfa', config: {} };
    const conLogo = (logo, env) => PUB.datosVistaPrevia({ ...rest0, config: { publico: { marca: { logo } } } }, 'alfa.test', 'index', env || { SUPABASE_URL: 'https://abc.supabase.co' }).imagen;
    const casos = [
      ['https://abc.supabase.co/storage/v1/object/public/logos/a.png', 'https://abc.supabase.co/storage/v1/object/public/logos/a.png', 'URL https del Storage esperado: se deja tal cual'],
      ['Recursos/a/logo.png', 'https://alfa.test/Recursos/a/logo.png', 'ruta del sitio: se completa con el host y https'],
      ['/Recursos/a/logo.png', 'https://alfa.test/Recursos/a/logo.png', 'ruta con barra inicial'],
      ['http://abc.supabase.co/storage/v1/x.png', null, 'http (no https) no sale'],
      ['https://otro.supabase.co/storage/v1/x.png', null, 'otro proyecto de Supabase no sale'],
      ['https://evil.example/x.png', null, 'otro origen no sale'],
      ['https://user:pass@abc.supabase.co/x.png', null, 'URL con usuario y clave no sale'],
      ['javascript:alert(1)', null, 'javascript:'], ['data:image/png;base64,AAAA', null, 'data:'], ['//evil.example/x.png', null, '//'],
      ['../../etc/passwd', null, '..'], ['Recursos/a b.png', null, 'espacio'], ['', null, 'vacio'], [42, null, 'numero']
    ];
    const malasImg = casos.filter(([entrada, esperado]) => conLogo(entrada) !== esperado);
    comprobar(malasImg.length === 0, `3f la imagen de la vista previa solo puede ser una ruta propia o https del Storage esperado (${casos.length} casos)`, malasImg.map((c) => c[2] + ' -> ' + conLogo(c[0])).join(' | '));
    const conIconos = (marca) => PUB.datosVistaPrevia({ ...rest0, config: { publico: { marca } } }, 'alfa.test', 'index', { SUPABASE_URL: 'https://abc.supabase.co' }).imagen;
    comprobar(conIconos({ logo: 'Recursos/l.png', icono_512: 'Recursos/i512.png', icono_192: 'Recursos/i192.png' }) === 'https://alfa.test/Recursos/l.png'
      && conIconos({ icono_512: 'Recursos/i512.png', icono_192: 'Recursos/i192.png' }) === 'https://alfa.test/Recursos/i512.png'
      && conIconos({ icono_192: 'Recursos/i192.png' }) === 'https://alfa.test/Recursos/i192.png' && conIconos({}) === null,
      '3h la imagen es el logo; sin logo, el icono de 512; sin ese, el de 192; sin ninguno, nada', JSON.stringify([conIconos({ logo: 'Recursos/l.png', icono_512: 'Recursos/i512.png' }), conIconos({ icono_512: 'Recursos/i512.png' }), conIconos({})]));
    const conHttp = PUB.datosVistaPrevia({ ...rest0, config: { publico: { marca: { logo: 'http://abc.supabase.co/storage/v1/x.png' } } } }, 'alfa.test', 'index', { SUPABASE_URL: 'http://abc.supabase.co' }).imagen;
    comprobar(conHttp === null, '3i aunque el Supabase del proyecto fuera http, una imagen http no sale (solo https)', conHttp);
    const sinEnv = PUB.datosVistaPrevia({ ...rest0, config: { publico: { marca: { logo: 'https://abc.supabase.co/x.png' } } } }, 'alfa.test', 'index', {}).imagen;
    comprobar(sinEnv === null, '3g sin SUPABASE_URL ninguna URL absoluta es de confianza', sinEnv);

    /* ---------------- 4. fallos: siempre la pagina neutra ---------------- */
    const px = await pedir({ host: HOST.X, ua: wa });
    comprobar(px.status === 200 && px.html === indexEstatico && px.cab['x-vista-previa'] === 'neutra', '4a host desconocido: la pagina neutra de siempre, identica al archivo estatico, 200, sin datos de nadie', JSON.stringify([px.status, px.cab['x-vista-previa'], (px.html || '').length, indexEstatico.length]));
    const pxp = await pedir({ host: HOST.X, ruta: '/pedido.html', ua: wa });
    comprobar(pxp.html === pedidoEstatico, '4b lo mismo para el seguimiento', '');
    const raro = await pedir({ host: 'rar o;host', ua: wa });
    comprobar(raro.status === 200 && raro.html === indexEstatico, '4c un Host con formato raro: la pagina neutra', raro.status);
    const sinHost = await ejecutar(dispatcher, { method: 'GET', url: '/api/publico?_ruta=vista-previa&_pagina=index', headers: { 'user-agent': wa }, query: {} });
    comprobar(sinHost.status === 200 && sinHost.cuerpo === indexEstatico, '4d sin cabecera Host: la pagina neutra', sinHost.status);
    comprobar(!/Alfa|Beta|Taqueiros/.test(px.html), '4e la pagina neutra no nombra a ningun restaurante', '');

    // base caida: un host que nunca se resolvio antes
    const hostNuevo = 'nuevo-sin-cache.vp-prueba.test';
    await rest('POST', 'restaurante_dominios', { host: hostNuevo, restaurante_id: IDS.B });
    falso.cortar = () => true;
    let caida = await pedir({ host: hostNuevo, ua: wa });
    falso.cortar = null;
    comprobar(caida.status === 200 && caida.html === indexEstatico && caida.cab['x-vista-previa'] === 'neutra', '4f la base caida: la pagina neutra (no un error, no datos de otro restaurante)', JSON.stringify([caida.status, caida.cab['x-vista-previa']]));
    const recuperada = await pedir({ host: hostNuevo, ua: wa });
    comprobar(recuperada.cab['x-vista-previa'] === 'restaurante' && recuperada.html.includes('Beta Pizzas'), '4g cuando la base vuelve, vuelve la vista previa del restaurante', recuperada.cab['x-vista-previa']);

    // un fallo del modulo (datosVistaPrevia lanza) y una pagina ilegible: copias de api/ modificadas a proposito
    const copia = (nombre, cambio, sinPaginas) => {
      const raiz = path.join(tmp, nombre);
      fs.mkdirSync(raiz, { recursive: true });
      const cp = (o, d) => { fs.mkdirSync(d, { recursive: true }); for (const e of fs.readdirSync(o, { withFileTypes: true })) { const a = path.join(o, e.name), b = path.join(d, e.name); e.isDirectory() ? cp(a, b) : fs.copyFileSync(a, b); } };
      cp(path.join(RAIZ, 'api'), path.join(raiz, 'api'));
      fs.copyFileSync(path.join(RAIZ, 'vercel.json'), path.join(raiz, 'vercel.json'));
      if (!sinPaginas) { fs.copyFileSync(path.join(RAIZ, 'index.html'), path.join(raiz, 'index.html')); fs.copyFileSync(path.join(RAIZ, 'pedido.html'), path.join(raiz, 'pedido.html')); }
      if (cambio) { const f = path.join(raiz, cambio[0]); const t = fs.readFileSync(f, 'utf8'); if (t.split(cambio[1]).length !== 2) throw new Error('cambio mal definido ' + cambio[1]); fs.writeFileSync(f, t.replace(cambio[1], () => cambio[2])); }
      return raiz;
    };
    const rotoRaiz = copia('roto', ['api/_publico.js', 'function datosVistaPrevia(restaurante, host, pagina, env) {', 'function datosVistaPrevia(restaurante, host, pagina, env) {\n  throw new Error("boom");']);
    const roto = await pedir({ host: HOST.A, ua: wa, funcion: require(path.join(rotoRaiz, 'api', 'publico.js')), enrutador: crearEmulador(rotoRaiz) });
    comprobar(roto.status === 200 && roto.html === indexEstatico && roto.cab['x-vista-previa'] === 'neutra', '4h si el modulo falla por dentro: la pagina neutra de siempre (200), nunca un error ni datos', JSON.stringify([roto.status, roto.cab['x-vista-previa']]));
    const sinPagRaiz = copia('sinpaginas', null, true);
    const cwdAntes = process.cwd();
    process.chdir(tmp);
    const sinPag = await pedir({ host: HOST.A, ua: wa, funcion: require(path.join(sinPagRaiz, 'api', 'publico.js')), enrutador: crearEmulador(RAIZ) });
    process.chdir(cwdAntes);
    comprobar(sinPag.status === 200 && /<title>Pedidos en línea<[/]title>/.test(sinPag.html) && !/Alfa/.test(sinPag.html) && sinPag.cab['x-vista-previa'] === 'neutra',
      '4i si la pagina no se puede leer (includeFiles mal puesto): una pagina minima neutra con el titulo de siempre, nunca datos del restaurante', JSON.stringify([sinPag.status, (sinPag.html || '').slice(0, 120)]));
    const cambiada = copia('cambiada', ['index.html', '<meta name="description" content="">', '<meta name="description" content="algo">']);
    const camb = await pedir({ host: HOST.A, ua: wa, funcion: require(path.join(cambiada, 'api', 'publico.js')), enrutador: crearEmulador(cambiada) });
    comprobar(camb.status === 200 && camb.cab['x-vista-previa'] === 'neutra' && !/Alfa/.test(camb.html), '4j si index.html deja de tener la forma esperada no se inyecta nada (se sirve tal cual)', camb.cab['x-vista-previa']);

    /* ---------------- 5. cabeceras y metodos ---------------- */
    comprobar(pa.cab['cache-control'] === 'private, no-store' && /Host/.test(pa.cab.vary) && /User-Agent/.test(pa.cab.vary), '5a Cache-Control: private, no-store y Vary: Host, User-Agent (ninguna cache compartida guarda la variante)', JSON.stringify(pa.cab));
    comprobar(/^text\/html; charset=utf-8$/.test(pa.cab['content-type']) && pa.cab['x-vista-previa'] === 'restaurante', '5b Content-Type text/html; charset=utf-8 y X-Vista-Previa para poder verificarlo con curl', JSON.stringify(pa.cab));
    const post = await pedir({ host: HOST.A, ruta: '/api/publico?_ruta=vista-previa&_pagina=index', ua: wa, metodo: 'POST' });
    comprobar(post.status === 405 && post.cab.allow === 'GET, HEAD', '5c POST responde 405 con Allow', JSON.stringify([post.status, post.cab]));
    const head = await pedir({ host: HOST.A, ruta: '/', ua: wa, metodo: 'HEAD' });
    comprobar(head.status === 200 && head.cab['x-vista-previa'] === 'restaurante', '5d HEAD responde 200 con las mismas cabeceras', head.status);
    const pag = await pedir({ host: HOST.A, ruta: '/api/publico?_ruta=vista-previa&_pagina=%27%22%3Cscript%3E', ua: wa });
    comprobar(pag.status === 200 && titulo(pag.html) === 'Pide en Alfa Tacos', '5e un _pagina desconocido o hostil cae en "index"', titulo(pag.html));
    const q = await pedir({ host: HOST.A, ruta: '/?x=%3Cscript%3Ealert(1)%3C/script%3E&utm_source=wa', ua: wa });
    comprobar(!q.html.includes('alert(1)') && !(q.location || '').includes('alert'), '5f la consulta de la URL no se copia a la respuesta ni a la redireccion', q.location);

    /* ---------------- 6. una sola lista de rastreadores ---------------- */
    const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));
    const reglas = cfg.redirects || [];
    const valores = reglas.map((r) => r.has[0].value);
    comprobar(reglas.length === 3 && valores.every((v) => v === valores[0]) && reglas.every((r) => r.has.length === 1 && r.has[0].type === 'header' && r.has[0].key === 'user-agent' && r.permanent === false),
      '6a vercel.json: 3 redirecciones temporales (307) por User-Agent, con la misma condicion', JSON.stringify(valores));
    comprobar(JSON.stringify(reglas.map((r) => [r.source, r.destination])) === JSON.stringify([['/', '/api/publico?_ruta=vista-previa&_pagina=index'], ['/index.html', '/api/publico?_ruta=vista-previa&_pagina=index'], ['/pedido.html', '/api/publico?_ruta=vista-previa&_pagina=pedido']]),
      '6b las redirecciones son de "/", "/index.html" y "/pedido.html" a la vista previa (solo esas)', '');
    const modulo = require(path.join(RAIZ, 'api', '_modulos', 'vista-previa.js'));
    const enJson = (valores[0].match(/[(]([^()]*)[)]/) || [])[1].split('|');
    comprobar(JSON.stringify(enJson) === JSON.stringify(modulo.RASTREADORES), '6c la lista de rastreadores de vercel.json es la MISMA que la del modulo (mismo orden)', JSON.stringify([enJson, modulo.RASTREADORES]));
    const reJson = new RegExp('^(?:' + valores[0] + ')$');
    const mal = [];
    for (const [n, ua] of Object.entries(UA_RASTREADORES)) if (!reJson.test(ua) || !modulo.ES_RASTREADOR.test(ua)) mal.push('rastreador no detectado: ' + n);
    for (const [n, ua] of Object.entries(UA_PERSONAS)) if (reJson.test(ua) || modulo.ES_RASTREADOR.test(ua)) mal.push('persona tomada por rastreador: ' + n);
    comprobar(mal.length === 0, '6d la condicion de vercel.json y la del modulo aceptan a todos los rastreadores y a ninguna persona de la muestra', mal.join(' | '));
    comprobar(modulo.RASTREADORES.every((x) => modulo.ES_RASTREADOR.test(x.toLowerCase()) && modulo.ES_RASTREADOR.test(x.toUpperCase())), '6e el modulo compara sin distinguir mayusculas (todo lo que Vercel manda aqui es un rastreador tambien para el)', '');
    comprobar(!modulo.RASTREADORES.some((x) => /instagram|googlebot|bot$/i.test(x) && /^(instagram|googlebot)$/i.test(x)), '6f "Instagram" y Googlebot NO estan en la lista (el navegador de Instagram son personas; Google ejecuta JavaScript)', '');

    /* ---------------- 7. la pagina inyectada es la estatica con solo lo agregado ---------------- */
    const d = PUB.datosVistaPrevia({ id: IDS.A, slug: 'vp-alfa', nombre: 'Alfa Tacos', config: base('a', 'Alfa Tacos') }, HOST.A, 'index', {});
    const inyectada = modulo.inyectar(indexEstatico, d);
    const restaurada = inyectada.replace('<title>' + modulo.esc(d.titulo) + '</title>', '<title>Pedidos en línea</title>').replace(modulo.etiquetas(d), '<meta name="description" content="">');
    comprobar(inyectada !== null && restaurada === indexEstatico, '7a quitando el <title> y las etiquetas agregadas, queda EXACTAMENTE index.html (nada mas cambio)', inyectada === null ? 'no inyecto' : 'difiere');
    const dp = PUB.datosVistaPrevia({ id: IDS.A, slug: 'vp-alfa', nombre: 'Alfa Tacos', config: base('a', 'Alfa Tacos') }, HOST.A, 'pedido', {});
    const ip = modulo.inyectar(pedidoEstatico, dp);
    comprobar(ip !== null && ip.replace('<title>' + modulo.esc(dp.titulo) + '</title>', '<title>Sigue tu pedido</title>').replace(modulo.etiquetas(dp), '<meta name="description" content="">') === pedidoEstatico, '7b lo mismo con pedido.html', '');
    comprobar((indexEstatico.match(/<title>/g) || []).length === 1 && (indexEstatico.match(/<meta name="description" content="">/g) || []).length === 1 && !indexEstatico.includes('property="og:')
      && (pedidoEstatico.match(/<title>/g) || []).length === 1 && (pedidoEstatico.match(/<meta name="description" content="">/g) || []).length === 1 && !pedidoEstatico.includes('property="og:'),
      '7c las paginas tienen un solo <title>, la descripcion vacia de siempre y ninguna etiqueta og: previa (los anclajes que el modulo necesita)', '');
    comprobar(modulo.inyectar(indexEstatico.replace('</head>', '<meta name="description" content=""></head>'), d) === null, '7d2 una pagina con DOS descripciones vacias no se inyecta (no se sabe cual reemplazar)', '');
    comprobar(modulo.inyectar('<html><head><title>a</title></head></html>', d) === null && modulo.inyectar(indexEstatico.replace('<title>', '<title>x</title><title>'), d) === null && modulo.inyectar(indexEstatico.replace('</head>', '<meta property="og:title" content="x"></head>'), d) === null,
      '7d una pagina que no tiene la forma esperada no se inyecta (devuelve null)', '');
    const respuestaLarga = pa.html.length;
    comprobar(respuestaLarga > indexEstatico.length && respuestaLarga < indexEstatico.length + 3000, `7e la vista previa agrega menos de 3 KB a la pagina (${respuestaLarga - indexEstatico.length} bytes)`, respuestaLarga - indexEstatico.length);
    // las etiquetas quedan al principio de la cabeza, donde los rastreadores que solo leen el comienzo del documento las ven
    comprobar(pa.html.indexOf('og:image') < 2000, '7f las etiquetas og: estan en los primeros 2000 bytes del documento (algunos rastreadores solo leen el comienzo)', pa.html.indexOf('og:image'));
  } catch (e) {
    Object.assign(console, consolaReal);
    comprobar(false, 'la bateria no pudo terminar', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e);
  } finally {
    Object.assign(console, consolaReal);
    globalThis.fetch = fetchReal;
    for (const k of Object.keys(process.env)) if (!(k in entorno)) delete process.env[k];
    Object.assign(process.env, entorno);
    if (falso) await falso.cerrar();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
