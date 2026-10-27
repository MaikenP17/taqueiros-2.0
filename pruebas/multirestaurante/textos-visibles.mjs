/* =============================================================
   NINGUN TEXTO VISIBLE DICE YA "TAQUEIROS", TACOS, BIRRIA NI LO MEXICANO   (rebrand a "The Northe Burgers", docs seccion 20)

     node pruebas/multirestaurante/textos-visibles.mjs

   Lo que ve un cliente, el dueno o el personal sale de tres lugares; los tres se revisan:
     1. LAS PAGINAS Y EL CODIGO DEL FRONT Y DEL SERVIDOR: se extraen las CADENAS DE TEXTO de cada archivo (sin comentarios, con un
        analizador pequeno que entiende comillas, plantillas, expresiones regulares y comentarios) y los textos y atributos de los HTML.
        Solo se aceptan, con su razon escrita abajo, los IDENTIFICADORES TECNICOS que siguen diciendo "taqueiros" a proposito (llaves del
        navegador, host de produccion, User-Agent, registros del servidor).
     2. LA CONFIG DEL RESTAURANTE: todo valor de api/_respaldo-taqueiros.js, y lo que de verdad llega a las paginas (construirPublico,
        datosManifest, datosVistaPrevia) para el restaurante demo cuando su config en la base esta VACIA (cae al respaldo).
     3. LO QUE SE IMPRIME Y SE ENVIA: el ticket de prueba, la comanda de CallMeBot y el mensaje de WhatsApp del pedido.
   Si algun dia aparece una palabra prohibida en un texto visible, esta prueba falla con el archivo y la cadena.
============================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 900) });
const leer = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

// Lo que NO puede aparecer en un texto visible
const PROHIBIDO = /taqueiro|taquer[ií]a|taquero|\btacos?\b|birria|\bcomal\b|mexican|dorilocos?|consom[eé]|🌮|🌯|🌶/i;

/* Identificadores tecnicos que siguen diciendo "taqueiros" A PROPOSITO (docs seccion 20.5). Cada entrada: [expresion, razon]. */
const PERMITIDO = [
  [/^taqueiros-(panel|pedidos|impresos|depurar)[a-z0-9-]*$/i, 'llaves del navegador (localStorage): renombrarlas borraria las preferencias de los equipos ya instalados'],
  [/^taqueiros-2-0\.vercel\.app$/i, 'host de produccion en HOSTS_TRANSITORIOS_TAQUEIROS (no se renombra el proyecto de Vercel)'],
  [/^Taqueiros\/1\.0 \(/, 'User-Agent tecnico de api/_ubicacion.js (solo anotado, no se cambia)'],
  [/^taqueiros-panel-$/, 'prefijo de las caches viejas de sw.js (para borrarlas)'],
  [/^taqueiros$/, 'slug por defecto'],
  [/^Falta la tabla restaurante_dominios|^\[(Publico|Restaurante|Secretos|Notificar|Alertas|Cron|Webhook|Pedido|Domicilio|Ubicacion)\]/, 'registros (logs) del servidor para quien opera el sistema: no los ve ningun cliente'],
  [/^ se resuelve a Taqueiros de forma transitoria\. Corre supabase\/11-dominios\.sql\.$/, 'segunda mitad de un registro (log) del servidor de api/_restaurante.js: nadie que no opere el sistema lo ve'],
  [/^\.\/_respaldo-taqueiros\.js$/, 'ruta del archivo de respaldo en un require (el archivo no se renombra, docs seccion 20.5)'],
];
const permitido = (s) => PERMITIDO.find(([re]) => re.test(s));

/* ---- extractor de cadenas de texto de un archivo JS (sin comentarios, con regex literales y plantillas) ---- */
function cadenas(codigo) {
  const out = [];
  let i = 0;
  const n = codigo.length;
  let ultimoSignificativo = '';   // para decidir si una "/" abre una expresion regular
  const puedeSerRegex = () => !ultimoSignificativo || /[(,=:\[!&|?{};+\-*%<>~^]/.test(ultimoSignificativo) || /(^|[^\w$])(return|typeof|case|in|of|else|do|void|delete|throw|new)$/.test(acum);
  let acum = '';
  while (i < n) {
    const c = codigo[i], d = codigo[i + 1];
    if (c === '/' && d === '/') { while (i < n && codigo[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const f = codigo.indexOf('*/', i + 2); i = f < 0 ? n : f + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < n && codigo[j] !== c) { if (codigo[j] === '\\') { s += codigo[j] + (codigo[j + 1] || ''); j += 2; } else { if (codigo[j] === '\n') break; s += codigo[j++]; } }
      out.push({ texto: s, linea: codigo.slice(0, i).split('\n').length });
      i = j + 1; ultimoSignificativo = c; acum += 'S'; continue;
    }
    if (c === '`') {
      let j = i + 1, s = '', prof = 0;
      while (j < n) {
        if (codigo[j] === '\\') { s += codigo[j] + (codigo[j + 1] || ''); j += 2; continue; }
        if (prof === 0 && codigo[j] === '`') break;
        if (codigo[j] === '$' && codigo[j + 1] === '{') { prof++; s += ' '; j += 2; continue; }
        if (prof > 0 && codigo[j] === '{') prof++;
        if (prof > 0 && codigo[j] === '}') { prof--; j++; continue; }
        if (prof === 0) s += codigo[j];
        j++;
      }
      out.push({ texto: s, linea: codigo.slice(0, i).split('\n').length });
      i = j + 1; ultimoSignificativo = '`'; acum += 'S'; continue;
    }
    if (c === '/' && puedeSerRegex()) {   // expresion regular: se salta entera (puede traer comillas)
      let j = i + 1, clase = false;
      while (j < n && codigo[j] !== '\n') {
        if (codigo[j] === '\\') { j += 2; continue; }
        if (codigo[j] === '[') clase = true; else if (codigo[j] === ']') clase = false;
        else if (codigo[j] === '/' && !clase) break;
        j++;
      }
      i = j + 1; while (/[a-z]/i.test(codigo[i] || '')) i++;
      ultimoSignificativo = ')'; acum += 'R'; continue;
    }
    if (!/\s/.test(c)) { ultimoSignificativo = c; acum = (acum + c).slice(-12); }
    i++;
  }
  return out;
}

/* ---- HTML: textos visibles, atributos visibles, y los <script> como JS ---- */
function deHtml(html) {
  const scripts = [];
  const sinScripts = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (m, js) => { scripts.push(js); return ' '; })
                         .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const textos = [];
  for (const m of sinScripts.matchAll(/(?:title|placeholder|alt|aria-label|content|value|label)\s*=\s*"([^"]*)"/gi)) textos.push({ texto: m[1], linea: 0 });
  textos.push({ texto: sinScripts.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), linea: 0 });
  return { textos, scripts };
}

const archivos = [
  'index.html', 'pedido.html', 'panel.html', 'menu-admin.html', 'historial.html',
  'ticket-comanda.js', 'restaurante-publico.js', 'panel-restaurante.js', 'datos-restaurante.js', 'horario-regla.js', 'supabase-publico.js', 'sw.js',
  ...fs.readdirSync(path.join(REPO, 'api')).filter((f) => f.endsWith('.js') && f !== '_respaldo-taqueiros.js').map((f) => 'api/' + f),
  ...fs.readdirSync(path.join(REPO, 'api', '_modulos')).filter((f) => f.endsWith('.js')).map((f) => 'api/_modulos/' + f),
];

let revisadas = 0, aceptadas = new Map();
const malos = [];
for (const f of archivos) {
  const src = leer(f);
  let lista;
  if (f.endsWith('.html')) { const h = deHtml(src); lista = [...h.textos, ...h.scripts.flatMap((s) => cadenas(s))]; }
  else lista = cadenas(src);
  for (const { texto, linea } of lista) {
    revisadas++;
    if (!PROHIBIDO.test(texto)) continue;
    const ok = permitido(texto);
    if (ok) { aceptadas.set(ok[1], (aceptadas.get(ok[1]) || 0) + 1); continue; }
    malos.push(`${f}${linea ? ':' + linea : ''}  "${texto.slice(0, 90)}"`);
  }
}
prueba(`1. ${archivos.length} archivos (paginas, front, servidor): ${revisadas} cadenas de texto revisadas y ninguna dice Taqueiros, tacos, birria, comal ni lo mexicano (salvo los identificadores tecnicos permitidos)`, malos.length === 0, malos.join('\n          '));
prueba('1b. los identificadores tecnicos permitidos son pocos y cada uno tiene su razon (se muestran abajo)', aceptadas.size <= PERMITIDO.length);

/* ---- 2. la config: respaldo y lo que llega a las paginas ---- */
const { CONFIG_TAQUEIROS } = require(`${REPO}/api/_respaldo-taqueiros.js`);
const valores = [];
(function recorrer(v, ruta) { if (typeof v === 'string') valores.push([ruta, v]); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) recorrer(x, ruta + '.' + k); })(CONFIG_TAQUEIROS, 'config');
const malosCfg = valores.filter(([, s]) => PROHIBIDO.test(s)).map(([r, s]) => `${r} = "${s.slice(0, 80)}"`);
prueba(`2a. los ${valores.length} valores de api/_respaldo-taqueiros.js (marca, textos, contacto, PWA) no dicen Taqueiros, tacos, birria, comal ni lo mexicano`, malosCfg.length === 0, malosCfg.join(' | '));

const { construirPublico, datosManifest, datosVistaPrevia } = require(`${REPO}/api/_publico.js`);
const demo = { id: '00000000-0000-4000-8000-000000000001', slug: 'taqueiros', nombre: 'The Northe Burgers', estado: 'activo', plan: 'completo', modalidad_pago: 'mensual',
  vigente_hasta: null, dias_gracia: 5, modulos: { pasarela: true, seguimiento: true, comandas: true, impresion: true }, config: {} };
const llega = JSON.stringify({ publico: construirPublico(demo, { env: {} }, new Date('2026-11-01T12:00:00Z')), manifest: datosManifest(demo, {}), index: datosVistaPrevia(demo, 'demo.example.com', 'index', {}), pedido: datosVistaPrevia(demo, 'demo.example.com', 'pedido', {}) });
/* El campo "slug" es un identificador tecnico (docs seccion 20.5): viaja en el JSON pero ninguna pagina lo dibuja. Se quita SOLO esa clave. */
const hallados = [...llega.replace(/"slug":"taqueiros",?/g, '').matchAll(new RegExp(PROHIBIDO.source, 'gi'))].map((m) => m[0]);
prueba('2b. con la config del demo VACIA en la base (cae al respaldo), lo que llega a las paginas (/api/restaurante, manifest y vistas previas) no dice nada de Taqueiros ni de lo mexicano', hallados.length === 0, hallados.join(','));
prueba('2c. ...y dice "The Northe Burgers" por todas partes (nombre, titulo, PWA, vista previa)', /The Northe Burgers/.test(llega) && /Panel The Northe Burgers/.test(llega) && /northe-logo\.png/.test(llega) && /northe-icono-512\.png/.test(llega), llega.slice(0, 300));

/* ---- 3. lo que se imprime y se envia ---- */
const T = require(`${REPO}/ticket-comanda.js`);
T.fijarRestaurante && T.fijarRestaurante('The Northe Burgers');
const ticket = JSON.stringify(T.preparar(T.pedidoDePrueba()));
const enTicket = [...ticket.matchAll(new RegExp(PROHIBIDO.source, 'gi'))].map((m) => m[0]);
prueba('3a. el ticket de prueba (el que se imprime desde el panel) no dice nada de Taqueiros ni de lo mexicano, e incluye Big Norte', enTicket.length === 0 && /Big Norte/.test(ticket), enTicket.join(',') + ' ' + ticket.slice(0, 200));
prueba('3b. el pie del ticket sale del nombre: "THE NORTHE BURGERS · PEDIDO WEB"', T.textoPie() === 'THE NORTHE BURGERS · PEDIDO WEB' || /THE NORTHE BURGERS · PEDIDO WEB/.test(ticket), String(T.textoPie()));

const { construirComanda } = require(`${REPO}/api/_notificar.js`);
const comanda = construirComanda({ numero: 12, id: 12, referencia: 'PED-1788325338685-ab12cd', cliente_nombre: 'Ana', cliente_telefono: '3001230000', tipo_pedido: 'domicilio', direccion: 'Cra 1', barrio: 'Centro',
  items: [{ cantidad: 2, nombre: 'Big Norte', precio: 26000 }, { cantidad: 1, nombre: 'Coca-Cola', precio: 4500 }], total: 56500 });
prueba('3c. la comanda de WhatsApp/CallMeBot (nuevo pedido) no dice nada de Taqueiros ni de lo mexicano y abre con 🍔', !PROHIBIDO.test(comanda) && comanda.startsWith('🍔 *NUEVO PEDIDO PAGADO*'), comanda.slice(0, 200));
const alerta = construirComanda({ numero: 12, id: 12, referencia: 'PED-1-aaaaaa', cliente_nombre: 'Ana', cliente_telefono: '3001', tipo_pedido: 'local', items: [], total: 1000 }, { encabezado: '⚠️ *PEDIDO #012 SIN ATENDER*', subtitulo: '12 min' });
prueba('3d. la alerta de pedido sin atender tampoco', !PROHIBIDO.test(alerta), alerta.slice(0, 200));

const html = leer('index.html');
const ini = html.indexOf('function enviarPedidoPagadoPorWhatsApp');
const msg = html.slice(ini, ini + 1400);
prueba('3e. el mensaje de WhatsApp del pedido pagado (index.html) lee el emoji del restaurante (RP.emoji) y no trae nada fijo de otra marca', /RP\.emoji\(R\)/.test(msg) && !PROHIBIDO.test(msg.replace(/\/\/.*$/gm, '')), msg.slice(0, 200));

console.log('Identificadores tecnicos aceptados a proposito:');
for (const [razon, cuantos] of aceptadas) console.log(`  ${String(cuantos).padStart(3)}  ${razon}`);
for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
