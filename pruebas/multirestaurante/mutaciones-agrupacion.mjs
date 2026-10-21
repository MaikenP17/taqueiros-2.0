/* =============================================================
   REVISION POR MUTACION: DESPACHADORES, REESCRITURAS, VISTA PREVIA DE ENLACES

   Rompe A PROPOSITO, una por una, cada defensa de lo nuevo y exige que agrupacion.mjs o vista-previa.mjs
   lo detecten:

     * api/_despacho.js, api/publico.js y api/cron.js (el despachador: el PATH manda, nombres que son propiedades
       de Object, rutas desconocidas, que modulo atiende cada ruta)
     * vercel.json (cada reescritura, cada redireccion, la lista de rastreadores, includeFiles, el cron)
     * api/_modulos/vista-previa.js (el escape de HTML, la compuerta por User-Agent, las cabeceras de cache, el
       metodo, los anclajes, el fallback neutro)
     * api/_publico.js datosVistaPrevia (titulo, descripcion, imagen https, color, url)

   Cada mutante va en su propia copia (api/, vercel.json, index.html, pedido.html, el logo) y las dos baterias
   corren contra ella (variable AGRUPACION_REPO) en procesos aparte, varios a la vez. Una mutacion es DETECTADA si
   alguna bateria falla; SOBREVIVE si pasan todas (una prueba que falta). Las EQUIVALENTES se declaran con su razon.

     node pruebas/multirestaurante/mutaciones-agrupacion.mjs
     node pruebas/multirestaurante/mutaciones-agrupacion.mjs --solo=vercel     (las que contengan ese texto)
     node pruebas/multirestaurante/mutaciones-agrupacion.mjs --paralelo=3
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO } from './sim.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const solo = arg('solo');
const PARALELO = Number(arg('paralelo') || 3);

const M = [];
/* m(nombre, archivo, buscar, reemplazar, { equivalente, todas }) */
const m = (nombre, archivo, buscar, reemplazar, extra) => M.push({ nombre, archivo, buscar, reemplazar, ...(extra || {}) });

// ---- el despachador ----
const D = 'api/_despacho.js';
m('despacho: el PATH deja de mandar (gana el parametro _ruta)', D, 'if (nombres[porPath]) return nombres[porPath];', '');
m('despacho: los nombres que son propiedades de Object (constructor, __proto__...) cuentan como ruta', D, 'Object.assign(Object.create(null), alias || {})', 'Object.assign({}, alias || {})');
m('despacho: cualquier _ruta se acepta (sin la lista de rutas conocidas)', D, 'if (candidato !== null && conocidas.has(candidato)) return candidato;', 'if (candidato !== null) return candidato;');
m('despacho: el ultimo segmento del path pasa a ser el path entero', D, 'url.pathname.split("/").filter(Boolean).pop() || ""', 'url.pathname');
m('despacho: una ruta desconocida ya no responde 404 (sigue y falla)', D, 'if (!nombre) {', 'if (false) {');
m('despacho: el 404 cambia de cuerpo', D, 'res.status(404).json({ error: "No encontrado" });', 'res.status(404).json({ error: "Nada" });');
m('despacho: el 404 pasa a 200', D, 'res.status(404).json({ error: "No encontrado" });', 'res.status(200).json({ error: "No encontrado" });');
m('despacho: req.query._ruta no se mira', D, 'const deVercel = req && req.query && typeof req.query._ruta === "string" ? req.query._ruta : null;', 'const deVercel = null;',
  { equivalente: 'es una segunda via: la URL (reescrita) ya trae el parametro y el PATH original basta; solo quitarla junto con el alias se detecta (mutacion siguiente)' });
m('despacho: ni req.query ni el alias de manifest.json (/manifest.json original sin el parametro)', D, 'const deVercel = req && req.query && typeof req.query._ruta === "string" ? req.query._ruta : null;', 'const deVercel = null;',
  { tambien: ['api/publico.js', '}, { "manifest.json": "manifest" });', '}, {});'] });
m('despacho: la URL se lee sin decodificar', D, 'try { porPath = decodeURIComponent(ultimo); } catch (e) { /* se queda sin decodificar */ }', '',
  { equivalente: 'Vercel entrega el path ya normalizado; decodificar solo cubre un nombre escrito con %xx, que no es ninguna URL de las nuestras' });

// ---- las funciones agrupadas ----
const P = 'api/publico.js';
m('publico: menu atiende el modulo de estado', P, 'menu: () => require("./_modulos/menu.js"),', 'menu: () => require("./_modulos/estado.js"),');
m('publico: estado atiende el modulo de disponibilidad', P, 'estado: () => require("./_modulos/estado.js"),', 'estado: () => require("./_modulos/disponibilidad.js"),');
m('publico: disponibilidad atiende el modulo de restaurante', P, 'disponibilidad: () => require("./_modulos/disponibilidad.js"),', 'disponibilidad: () => require("./_modulos/restaurante.js"),');
m('publico: restaurante atiende el modulo de menu', P, 'restaurante: () => require("./_modulos/restaurante.js"),', 'restaurante: () => require("./_modulos/menu.js"),');
m('publico: manifest atiende el modulo de restaurante', P, 'manifest: () => require("./_modulos/manifest.js"),', 'manifest: () => require("./_modulos/restaurante.js"),');
m('publico: se quita la ruta de la vista previa', P, '  "vista-previa": () => require("./_modulos/vista-previa.js")\n', '  "vista-previa-x": () => require("./_modulos/vista-previa.js")\n');
m('publico: se quita el alias manifest.json', P, '}, { "manifest.json": "manifest" });', '}, {});');
const C = 'api/cron.js';
m('cron: alertas atiende el modulo de keep-alive', C, 'alertas: () => require("./_modulos/alertas.js"),', 'alertas: () => require("./_modulos/keep-alive.js"),');
m('cron: keep-alive atiende el modulo de alertas', C, '"keep-alive": () => require("./_modulos/keep-alive.js")', '"keep-alive": () => require("./_modulos/alertas.js")');
m('cron: se quita la ruta keep-alive', C, '"keep-alive": () => require("./_modulos/keep-alive.js")', '"keep-alive-x": () => require("./_modulos/keep-alive.js")');
m('cron: se agrega una ruta que no es de cron (menu)', C, '"keep-alive": () => require("./_modulos/keep-alive.js")', '"keep-alive": () => require("./_modulos/keep-alive.js"),\n  menu: () => require("./_modulos/menu.js")');

// ---- vercel.json ----
const V = 'vercel.json';
for (const [ruta, dest] of [['/manifest.json', 'manifest'], ['/api/menu', 'menu'], ['/api/estado', 'estado'], ['/api/disponibilidad', 'disponibilidad'], ['/api/restaurante', 'restaurante'], ['/api/manifest', 'manifest'], ['/api/alertas', 'alertas'], ['/api/keep-alive', 'keep-alive']]) {
  m(`vercel.json: la URL ${ruta} deja de reescribirse (source cambiada)`, V, `"source": "${ruta}", "destination"`, `"source": "${ruta}-x", "destination"`);
  m(`vercel.json: la URL ${ruta} va a otro modulo`, V, `"source": "${ruta}", "destination": "/api/${dest === 'alertas' || dest === 'keep-alive' ? 'cron' : 'publico'}?_ruta=${dest}"`,
    `"source": "${ruta}", "destination": "/api/${dest === 'alertas' || dest === 'keep-alive' ? 'cron' : 'publico'}?_ruta=${dest === 'menu' ? 'estado' : 'menu'}"`);
}
m('vercel.json: las redirecciones dejan de ser temporales (308)', V, '"permanent": false', '"permanent": true', { todas: true });
m('vercel.json: la condicion mira otra cabecera (los rastreadores ya no coinciden)', V, '"key": "user-agent"', '"key": "x-user-agent"', { todas: true });
m('vercel.json: WhatsApp sale de la lista de rastreadores', V, '(WhatsApp|', '(', { todas: true });
m('vercel.json: Instagram (el navegador de las personas) entra en la lista', V, '|Discordbot).*', '|Discordbot|Instagram).*', { todas: true });
m('vercel.json: Googlebot entra en la lista', V, '|Discordbot).*', '|Discordbot|Googlebot).*', { todas: true });
m('vercel.json: la redireccion de /index.html cambia de ruta', V, '"source": "/index.html"', '"source": "/index.htm"');
m('vercel.json: la redireccion de /pedido.html cambia de ruta', V, '"source": "/pedido.html"', '"source": "/pedido.htm"');
m('vercel.json: la redireccion de "/" cambia de ruta', V, '"source": "/",', '"source": "/x",');
m('vercel.json: /pedido.html va a la pagina del menu', V, '_pagina=pedido', '_pagina=index');
m('vercel.json: las redirecciones van a otro modulo', V, '_ruta=vista-previa', '_ruta=menu', { todas: true });
m('vercel.json: includeFiles ya no incluye pedido.html', V, '"includeFiles": "{index,pedido}.html"', '"includeFiles": "{index}.html"');
m('vercel.json: includeFiles se quita (la vista previa no puede leer las paginas)', V, '"includeFiles": "{index,pedido}.html"', '"includeFilesX": "{index,pedido}.html"');
m('vercel.json: el cron apunta a una URL que no existe', V, '"path": "/api/keep-alive"', '"path": "/api/keepalive"');

// ---- la vista previa ----
const W = 'api/_modulos/vista-previa.js';
m('vista previa: el & ya no se escapa', W, '    .replace(/&/g, "&amp;")\n', '');
m('vista previa: el < ya no se escapa', W, '    .replace(/</g, "&lt;")\n', '');
m('vista previa: el > ya no se escapa', W, '    .replace(/>/g, "&gt;")\n', '');
m('vista previa: la comilla doble ya no se escapa', W, '    .replace(/"/g, "&quot;")\n', '');
m('vista previa: la comilla simple ya no se escapa', W, '    .replace(/\'/g, "&#39;")', '',
  { equivalente: 'todos los atributos se escriben entre comillas dobles, asi que una comilla simple no puede cerrarlos' });
m('vista previa: una persona (sin User-Agent de rastreador) recibe la vista previa', W, 'if (!ES_RASTREADOR.test(ua)) {', 'if (false) {');
m('vista previa: la comparacion de rastreadores distingue mayusculas', W, 'new RegExp("(" + RASTREADORES.join("|") + ")", "i")', 'new RegExp("(" + RASTREADORES.join("|") + ")")');
m('vista previa: WhatsApp sale de la lista del modulo', W, '  "WhatsApp", "facebookexternalhit",', '  "facebookexternalhit",');
m('vista previa: Cache-Control publico', W, 'res.setHeader("Content-Type", "text/html; charset=utf-8");\n  res.setHeader("Cache-Control", "private, no-store");', 'res.setHeader("Content-Type", "text/html; charset=utf-8");\n  res.setHeader("Cache-Control", "public, s-maxage=60");');
m('vista previa: sin Vary de User-Agent', W, 'res.setHeader("Vary", "Host, User-Agent");\n  for', 'res.setHeader("Vary", "Host");\n  for');
m('vista previa: Content-Type distinto', W, 'res.setHeader("Content-Type", "text/html; charset=utf-8");\n  res.setHeader("Cache-Control", "private, no-store");', 'res.setHeader("Content-Type", "text/plain");\n  res.setHeader("Cache-Control", "private, no-store");');
m('vista previa: acepta POST', W, 'if (req.method !== "GET" && req.method !== "HEAD") {', 'if (false) {');
m('vista previa: la persona es devuelta siempre a "/"', W, 'res.setHeader("Location", ruta);', 'res.setHeader("Location", "/");');
m('vista previa: la persona recibe 200 en vez de 302', W, 'res.status(302).send("");', 'res.status(200).send("");');
m('vista previa: la ruta del seguimiento pierde .html', W, 'ruta: "/pedido.html" }', 'ruta: "/pedido" }');
m('vista previa: _pagina=pedido siempre cae en index', W, 'return q === "pedido" ? "pedido" : "index";', 'return "index";');
m('vista previa: sin pagina neutra del archivo (usa siempre la minima)', W, 'responder(res, 200, inyectada || html || paginaMinima(pagina),', 'responder(res, 200, inyectada || paginaMinima(pagina),');
m('vista previa: la cabecera X-Vista-Previa miente', W, '{ "X-Vista-Previa": inyectada ? "restaurante" : "neutra" }', '{ "X-Vista-Previa": inyectada ? "neutra" : "restaurante" }');
m('vista previa: el titulo ya no se reemplaza (queda el neutro)', W, 'let salida = html.slice(0, abre) + "<title>" + esc(d.titulo) + "</title>" + html.slice(cierra + "</title>".length);', 'let salida = html;');
m('vista previa: el titulo se inserta sin escapar', W, '"<title>" + esc(d.titulo) + "</title>"', '"<title>" + d.titulo + "</title>"');
m('vista previa: la descripcion se inserta sin escapar', W, "'<meta name=\"description\" content=\"' + esc(d.descripcion) + '\">'\n  ];", "'<meta name=\"description\" content=\"' + d.descripcion + '\">'\n  ];");
m('vista previa: og:title sin escapar', W, "'<meta property=\"og:title\" content=\"' + esc(d.titulo) + '\">'", "'<meta property=\"og:title\" content=\"' + d.titulo + '\">'");
m('vista previa: og:image sin escapar', W, "'<meta property=\"og:image\" content=\"' + esc(d.imagen) + '\">'", "'<meta property=\"og:image\" content=\"' + d.imagen + '\">'");
m('vista previa: og:site_name sin escapar', W, "'<meta property=\"og:site_name\" content=\"' + esc(d.nombre) + '\">'", "'<meta property=\"og:site_name\" content=\"' + d.nombre + '\">'");
m('vista previa: no se agrega theme-color', W, "if (d.colorTema) filas.push('<meta name=\"theme-color\" content=\"' + esc(d.colorTema) + '\">');", '');
m('vista previa: og:locale distinto', W, 'content="es_CO"', 'content="es_ES"');
m('vista previa: og:type distinto', W, '<meta property="og:type" content="website">', '<meta property="og:type" content="article">');
m('vista previa: no se agrega la imagen', W, "if (d.imagen) {\n    filas.push(", "if (false) {\n    filas.push(");
m('vista previa: sin twitter:card', W, "    '<meta name=\"twitter:card\" content=\"summary\">',\n", '');
m('vista previa: theme-color sin escapar', W, "filas.push('<meta name=\"theme-color\" content=\"' + esc(d.colorTema) + '\">')", "filas.push('<meta name=\"theme-color\" content=\"' + d.colorTema + '\">')");
m('vista previa: og:url sin escapar', W, "'<meta property=\"og:url\" content=\"' + esc(d.url) + '\">'", "'<meta property=\"og:url\" content=\"' + d.url + '\">'");
m('vista previa: se acepta una pagina con DOS <title>', W, 'if (abre < 0 || html.lastIndexOf("<title>") !== abre) return null;', 'if (abre < 0) return null;');
m('vista previa: se acepta una pagina con DOS descripciones vacias', W, 'if (desc < 0 || html.lastIndexOf(DESCRIPCION_VACIA) !== desc) return null;', 'if (desc < 0) return null;');
m('vista previa: se acepta una pagina que ya trae etiquetas og:', W, 'if (html.includes(\'property="og:\')) return null;', '');
m('vista previa: un host sin restaurante tambien inyecta (el modulo no mira el resultado de la resolucion)', W, 'if (encontrado && host && html) {', 'if (html) {',
  { equivalente: 'sin restaurante, encontrado.restaurante lanza un TypeError que el try/catch convierte en la pagina neutra: mismo resultado por otro camino' });
m('vista previa: la pagina se lee solo del directorio de trabajo', W, '    path.join(__dirname, "..", "..", archivo),\n', '',
  { equivalente: 'la segunda ruta (el directorio de trabajo) cubre el mismo archivo; el orden es solo preferencia' });
m('vista previa: la pagina no se lee de ninguna ruta', W, '    path.join(__dirname, "..", "..", archivo),\n    path.join(process.cwd(), archivo)\n', '    path.join(__dirname, "..", "..", archivo + ".x"),\n    path.join(process.cwd(), archivo + ".x")\n');
m('vista previa: la pagina minima trae otro titulo', W, 'const titulo = pagina === "pedido" ? "Sigue tu pedido" : "Pedidos en línea";', 'const titulo = "Taqueiros";');

// ---- datosVistaPrevia ----
const Q = 'api/_publico.js';
m('datos: el titulo ignora titulo_pagina (usa solo el nombre)', Q, 'const titulo = esPedido ? "Sigue tu pedido | " + nombre : (textos.titulo_pagina || nombre);', 'const titulo = esPedido ? "Sigue tu pedido | " + nombre : nombre;');
m('datos: el titulo del seguimiento pierde el nombre', Q, '"Sigue tu pedido | " + nombre : (textos', '"Sigue tu pedido" : (textos');
m('datos: la descripcion ignora descripcion_pagina', Q, ': (textos.descripcion_pagina || ("Pide en línea en " + nombre + "."));', ': ("Pide en línea en " + nombre + ".");');
m('datos: la descripcion por omision cambia', Q, '("Pide en línea en " + nombre + ".")', '("Pide en " + nombre + ".")');
m('datos: la descripcion del seguimiento cambia', Q, '"Sigue el estado de tu pedido en " + nombre + "."', '"Pedido de " + nombre + "."');
m('datos: la imagen sale con http', Q, 'imagen = "https://" + host + "/" + (candidata', 'imagen = "http://" + host + "/" + (candidata');
m('datos: una ruta con barra inicial queda con doble barra', Q, '(candidata.startsWith("/") ? candidata.slice(1) : candidata)', 'candidata');
m('datos: se acepta una imagen absoluta http', Q, 'if (u.protocol === "https:") imagen = u.href;', 'imagen = u.href;');
m('datos: se acepta una imagen absoluta de cualquier protocolo', Q, 'if (u.protocol === "https:") imagen = u.href;', 'if (true) imagen = u.href;');
m('datos: el logo pierde prioridad frente a los iconos', Q, 'const candidata = marca.logo || marca.icono_512 || marca.icono_192;', 'const candidata = marca.icono_192 || marca.icono_512 || marca.logo;');
m('datos: el icono grande pierde prioridad frente al pequeno', Q, 'const candidata = marca.logo || marca.icono_512 || marca.icono_192;', 'const candidata = marca.logo || marca.icono_192 || marca.icono_512;');
m('datos: sin color del tema', Q, 'colorTema: marca.colores.primario || null', 'colorTema: null');
m('datos: el og:url del seguimiento es el del menu', Q, 'url: "https://" + host + (esPedido ? "/pedido.html" : "/"),', 'url: "https://" + host + "/",');
m('datos: la imagen sale sin validar (la ruta relativa se arma con el valor crudo)', Q, 'const candidata = marca.logo || marca.icono_512 || marca.icono_192;', 'const candidata = (restaurante.config && restaurante.config.publico && restaurante.config.publico.marca && restaurante.config.publico.marca.logo) || marca.logo;');

// ---- ejecucion ----------------------------------------------------------------------------------------------
function copiar(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const e of fs.readdirSync(origen, { withFileTypes: true })) {
    const o = path.join(origen, e.name), d = path.join(destino, e.name);
    if (e.isDirectory()) copiar(o, d); else fs.copyFileSync(o, d);
  }
}

function prepararMutante(dir, mu) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  copiar(path.join(REPO, 'api'), path.join(dir, 'api'));
  for (const f of ['vercel.json', 'index.html', 'pedido.html']) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'Recursos', 'logo'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'Recursos', 'logo', 'logo.png'), path.join(dir, 'Recursos', 'logo', 'logo.png'));
  const aplicar = (archivo, buscar, reemplazar, todas) => {
    const ruta = path.join(dir, archivo);
    const t = fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
    const n = t.split(buscar).length - 1;
    if (todas ? n < 1 : n !== 1) throw new Error(`mutacion mal definida: "${buscar.slice(0, 70)}" aparece ${n} veces en ${archivo}`);
    fs.writeFileSync(ruta, t.split(buscar).join(reemplazar));
  };
  aplicar(mu.archivo, mu.buscar, mu.reemplazar, mu.todas);
  if (mu.tambien) aplicar(mu.tambien[0], mu.tambien[1], mu.tambien[2], false);
}

function correr(script, dir, offset) {
  return new Promise((resolve) => {
    const hijo = spawn(process.execPath, [path.join(AQUI, script)], { env: { ...process.env, AGRUPACION_REPO: dir, PUERTO_OFFSET: String(offset) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    hijo.stdout.on('data', (d) => { salida += d; });
    hijo.stderr.on('data', (d) => { salida += d; });
    const reloj = setTimeout(() => hijo.kill(), 120000);
    hijo.on('close', (codigo) => { clearTimeout(reloj); resolve({ codigo, salida }); });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mutagr-'));
const lista = M.filter((x) => !solo || x.nombre.includes(solo));
const resumen = { detectadas: 0, sobreviven: [], equivalentes: [], errores: [] };
let siguiente = 0;

async function trabajador(id) {
  while (siguiente < lista.length) {
    const mu = lista[siguiente++];
    const dir = path.join(tmp, 'm' + siguiente);
    try { prepararMutante(dir, mu); } catch (e) { resumen.errores.push(`${mu.nombre}: ${e.message}`); console.log(`  ERROR   ${mu.nombre}\n      ${e.message}`); continue; }
    const offset = id * 10;
    let r = await correr('agrupacion.mjs', dir, offset);
    let donde = 'agrupacion';
    if (r.codigo === 0) { r = await correr('vista-previa.mjs', dir, offset); donde = 'vista-previa'; }
    const fallo = r.codigo !== 0;
    const primera = (r.salida.match(/FALLA\s+(.*)/) || [])[1] || (fallo ? r.salida.split('\n').filter(Boolean).slice(-1)[0] : '');
    if (fallo) {
      resumen.detectadas++;
      console.log(`  DETECTADA (${donde})  ${mu.nombre}\n      p.ej.: ${String(primera).slice(0, 110)}`);
    } else if (mu.equivalente) {
      resumen.equivalentes.push(`${mu.nombre}  [${mu.equivalente}]`);
      console.log(`  EQUIVALENTE  ${mu.nombre}\n      ${mu.equivalente}`);
    } else {
      resumen.sobreviven.push(mu.nombre);
      console.log(`  SOBREVIVE  ${mu.nombre}`);
    }
  }
}

console.log(`REVISION POR MUTACION de despachadores, reescrituras y vista previa: ${lista.length} mutaciones, ${PARALELO} a la vez`);
await Promise.all(Array.from({ length: PARALELO }, (_, i) => trabajador(i)));
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n=============================================================');
console.log(`DETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes.length}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
if (resumen.sobreviven.length) { console.log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((s) => console.log('  - ' + s)); }
if (resumen.equivalentes.length) { console.log('\nEQUIVALENTES:'); resumen.equivalentes.forEach((s) => console.log('  - ' + s)); }
if (resumen.errores.length) { console.log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((s) => console.log('  - ' + s)); }
process.exitCode = resumen.sobreviven.length || resumen.errores.length ? 1 : 0;
setTimeout(() => process.exit(), 1500).unref();
