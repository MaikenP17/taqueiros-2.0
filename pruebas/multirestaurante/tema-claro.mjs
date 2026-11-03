/* =============================================================
   ESTILO CLARO DEL SITIO PUBLICO Y LOGO TRANSPARENTE   (docs/multirestaurante.md, seccion 20.14)

     node pruebas/multirestaurante/tema-claro.mjs

   Lo ESTATICO del cambio visual (la parte que se ve en un navegador, con Chrome, esta en front.mjs, escenario 9):
     1. EL INTERRUPTOR: index.html y pedido.html traen UNA sola constante TEMA_CLARO, con el mismo valor, al inicio de <body> (antes de la
        pantalla de carga) y comentada (afecta a todos los restaurantes; docs 20.14).
     2. TODO el CSS nuevo cuelga de la clase tema-claro (si no, apagar el interruptor no devolveria el estilo oscuro) y no escribe colores nuevos
        a mano (salvo el verde oscuro de texto #3f5a24, que ya estaba en la pagina). Que, apagado, el sitio sea IDENTICO al de antes lo prueban
        vista-previa.mjs (2d, byte a byte) y front.mjs (5, estilos calculados).
     3. EL LOGO TRANSPARENTE: el PNG de Recursos/logo/northe-logo.png tiene un canal alfa REAL (esquinas transparentes, bordes limpios: no un
        cuadriculado pintado), esta recortado y pesa poco; los iconos de 192 y 512 son sobre crema SOLIDO con margen seguro del 15 %.
     4. LAS PAGINAS DEL PERSONAL (panel, menu-admin, historial) siguen oscuras y ponen el logo sobre un chip crema; su favicon y las notificaciones
        usan el icono con fondo solido.
     5. LA VISTA PREVIA de WhatsApp usa el icono de 512 (fondo crema), no el logo transparente.
     6. CONTRASTE WCAG AA de las parejas texto/fondo clave, calculado con los colores de la marca (api/_respaldo-taqueiros.js).
     7. sw.js v13 y la documentacion.
============================================================= */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const resultados = [];
const prueba = (nombre, ok, info = '') => { resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 700) }); };
const leer = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const index = leer('index.html'), pedido = leer('pedido.html');
const { CONFIG_TAQUEIROS } = require(path.join(REPO, 'api', '_respaldo-taqueiros.js'));
const marca = CONFIG_TAQUEIROS.publico.marca;

/* ---------------- 1. el interruptor ---------------- */
const interruptores = (t) => t.match(/^const TEMA_CLARO = (true|false);$/gm) || [];
prueba('1a index.html y pedido.html traen UNA sola constante TEMA_CLARO cada una', interruptores(index).length === 1 && interruptores(pedido).length === 1, JSON.stringify([interruptores(index), interruptores(pedido)]));
prueba('1b las dos valen lo mismo (si se apaga una hay que apagar la otra)', interruptores(index)[0] === interruptores(pedido)[0], JSON.stringify([interruptores(index), interruptores(pedido)]));
prueba('1c la constante esta antes de la pantalla de carga (sin parpadeo oscuro al abrir) y pone la clase tema-claro en <body>',
  [index, pedido].every((t) => t.indexOf('const TEMA_CLARO') > t.indexOf('<body>') && t.indexOf('const TEMA_CLARO') < t.indexOf('id="rp-estado"') && /if\(TEMA_CLARO\) document\.body\.classList\.add\("tema-claro"\);/.test(t)), '');
const comentario = index.slice(index.indexOf('INTERRUPTOR DEL ESTILO CLARO'), index.indexOf('const TEMA_CLARO'));
prueba('1d el comentario del interruptor explica que apaga el estilo, que afecta a TODOS los restaurantes y que hay que decidir antes del segundo restaurante (20.14)',
  /true\s+=/.test(comentario) && /false\s+=/.test(comentario) && /TODOS los restaurantes/.test(comentario) && /segundo restaurante/.test(comentario) && /20\.14/.test(comentario), comentario);
const sinComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');
prueba('1e nada mas en el HTML o el JS de las paginas publicas depende de la clase tema-claro (el JS no cambia: solo la hoja de estilos la usa)',
  ![index, pedido].some((t) => /tema-claro/.test(sinComentarios(t.replace(/<style>[\s\S]*?<\/style>/, '')).replace('document.body.classList.add("tema-claro")', ''))), '');

/* ---------------- 2. el CSS cuelga de la clase ---------------- */
const INI = '\n  /* =====================================================================================================\n     TEMA CLARO';
const bloque = (t) => t.slice(t.indexOf(INI), t.indexOf('</style>'));
for (const [nombre, t] of [['index.html', index], ['pedido.html', pedido]]) {
  const css = bloque(t);
  const css2 = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectores = [...css2.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !/^@media/.test(s));
  const sueltos = selectores.flatMap((s) => s.split(/,(?![^(]*\))/).map((x) => x.trim())).filter((s) => !/^(body)?\.tema-claro\b/.test(s));
  prueba(`2a ${nombre}: las ${selectores.length} reglas del bloque nuevo empiezan todas por .tema-claro (nada afecta al estilo oscuro)`, css.length > 500 && selectores.length > 20 && sueltos.length === 0, sueltos.join(' | '));
  const colores = [...new Set((css2.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((c) => c.toLowerCase()))];
  prueba(`2b ${nombre}: el bloque no escribe colores nuevos a mano (usa las variables de la marca); solo el verde oscuro de texto #3f5a24, que ya estaba`, colores.every((c) => c === '#3f5a24'), colores.join(','));
  prueba(`2c ${nombre}: hay UN solo bloque del tema claro y va al final del <style>, despues del CSS oscuro (asi pisa sin !important)`, t.split(INI).length === 2 && t.split('</style>').length === 2 && t.indexOf(INI) > t.indexOf('@keyframes rp-giro'), '');
}
// piezas concretas de la mirada del cambio (estas reglas son el estilo pedido; si alguien las quita, esto avisa)
const reglas = bloque(index).replace(/\/\*[\s\S]*?\*\//g, '');
prueba('2d portada: fondo crema liso (sin degradado ni rayas), logo sin marco ni caja, "Mi pedido" sin borde y subrayado',
  /\.tema-claro \.hero\{background:var\(--crema\);/.test(reglas) && /\.tema-claro \.hero::before\{display:none;\}/.test(reglas) && /\.tema-claro \.noise-bg\{display:none;\}/.test(reglas)
  && /\.tema-claro \.hero-logo-frame\{background:none; border:0;[^}]*box-shadow:none;\}/.test(reglas)
  && /\.tema-claro \.hero-mi-pedido\{[^}]*border:0;[^}]*text-decoration:underline;/.test(reglas), '');
prueba('2e encabezado: solo el logo (sin caja ni fondo; el nombre queda como texto accesible), linea oscura fina y sombra suave',
  /\.tema-claro header\{[^}]*border-bottom:1px solid var\(--carbon\);[^}]*box-shadow:/.test(reglas) && /\.tema-claro \.brand img\{[^}]*background:none; padding:0; border-radius:0;/.test(reglas)
  && /\.brand:has\(img\[src\]:not\(\[style\*="none"\]\)\) \.name\{[^}]*clip/.test(reglas), '');
prueba('2f el boton primario es rojo con texto crema, el secundario tiene borde y texto marron oscuro y los dos tienen el mismo ancho',
  /\.tema-claro \.btn-primary\{background:var\(--rojo\); color:var\(--crema-suave\);/.test(reglas) && /\.tema-claro \.btn-secondary\{background:transparent; color:var\(--carbon\); border:2px solid var\(--carbon\);\}/.test(reglas)
  && /\.tema-claro \.btn-primary, \.tema-claro \.btn-secondary\{[^}]*width:100%;/.test(reglas), '');
prueba('2g el pie se queda oscuro como ancla (con texto claro: el del body es oscuro en este tema) y el logo del pie va en un chip (su texto es negro)', /\.tema-claro footer\{background:var\(--carbon\); color:var\(--texto-claro\);/.test(reglas) && /\.tema-claro \.footer-brand img\{[^}]*padding:4px;/.test(reglas), '');
prueba('2h tamanos tactiles de 44 px en lo que se toca (carrito, categorias, mas/menos, cerrar, redes)',
  /\.tema-claro \.cart-btn\{min-height:44px;\}/.test(reglas) && /\.cat-nav button\{\s*min-height:44px;/.test(reglas) && /\.tema-claro \.add-btn\{width:44px; height:44px;/.test(reglas) && /\.tema-claro \.qty-control button\{width:44px; height:44px;\}/.test(reglas)
  && /\.tema-claro \.modal-close\{width:44px; height:44px;/.test(reglas) && /\.tema-claro \.socials a\{width:44px; height:44px;\}/.test(reglas), '');
prueba('2i foco visible en botones, enlaces y campos (aro oscuro; mostaza en el pie)', /\.tema-claro :is\(a,button,input,textarea,select\):focus-visible\{outline:3px solid var\(--carbon\);/.test(reglas) && /\.tema-claro footer :is\(a,button\):focus-visible\{outline-color:var\(--mostaza\);\}/.test(reglas), '');
prueba('2j la sombra del cajon del carrito solo existe con el cajon abierto (cerrado, se asomaba por el borde de la pantalla)', /\.tema-claro \.drawer\{[^}]*box-shadow:none;\}/.test(reglas) && /\.tema-claro \.drawer\.open\{box-shadow:/.test(reglas), '');
prueba('2k pedido.html: el color en linea de mostrarAviso (claro, para fondo oscuro) se pisa con !important en el tema claro', /\.tema-claro \.aviso strong\{color:var\(--carbon\) !important;\}/.test(bloque(pedido)), '');

/* ---------------- 3. el logo y los iconos (PNG sin dependencias) ---------------- */
function leerPng(ruta) {
  const b = fs.readFileSync(ruta);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('no es PNG: ' + ruta);
  let off = 8, ihdr, plte = null, trns = null; const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off), tipo = b.toString('latin1', off + 4, off + 8), d = b.subarray(off + 8, off + 8 + len); off += 12 + len;
    if (tipo === 'IHDR') ihdr = { w: d.readUInt32BE(0), h: d.readUInt32BE(4), prof: d[8], tipo: d[9], entrelazado: d[12] };
    else if (tipo === 'PLTE') plte = d; else if (tipo === 'tRNS') trns = d; else if (tipo === 'IDAT') idat.push(d);
  }
  if (ihdr.entrelazado) throw new Error('PNG entrelazado: no soportado');
  const canales = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.tipo];
  const bitsPx = canales * ihdr.prof, bpp = Math.max(1, bitsPx >> 3), stride = Math.ceil(ihdr.w * bitsPx / 8);
  const crudo = zlib.inflateSync(Buffer.concat(idat)), fil = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const f = crudo[y * (stride + 1)], fila = crudo.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? fil[y * stride + x - bpp] : 0, up = y ? fil[(y - 1) * stride + x] : 0, c = x >= bpp && y ? fil[(y - 1) * stride + x - bpp] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      fil[y * stride + x] = (fila[x] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? ((a + up) >> 1) : (pa <= pb && pa <= pc ? a : pb <= pc ? up : c))) & 255;
    }
  }
  const pixel = (x, y) => {
    const o = y * stride;
    if (ihdr.tipo === 3) {
      const bit = x * ihdr.prof, i = (fil[o + (bit >> 3)] >> (8 - ihdr.prof - (bit & 7))) & ((1 << ihdr.prof) - 1);
      return [plte[i * 3], plte[i * 3 + 1], plte[i * 3 + 2], trns && i < trns.length ? trns[i] : 255];
    }
    if (ihdr.prof !== 8) throw new Error('profundidad no soportada');
    if (ihdr.tipo === 6) return [fil[o + x * 4], fil[o + x * 4 + 1], fil[o + x * 4 + 2], fil[o + x * 4 + 3]];
    if (ihdr.tipo === 2) return [fil[o + x * 3], fil[o + x * 3 + 1], fil[o + x * 3 + 2], 255];
    throw new Error('tipo de PNG no soportado');
  };
  return { w: ihdr.w, h: ihdr.h, tipo: ihdr.tipo, pixel };
}

const rutaLogo = path.join(REPO, marca.logo);
const logo = leerPng(rutaLogo), pesoLogo = fs.statSync(rutaLogo).size;
let transp = 0, semi = 0, opacos = 0, xs = [1e9, -1], ys = [1e9, -1];
for (let y = 0; y < logo.h; y++) for (let x = 0; x < logo.w; x++) {
  const a = logo.pixel(x, y)[3];
  if (a <= 5) transp++; else if (a < 250) semi++; else opacos++;
  if (a > 8) { xs = [Math.min(xs[0], x), Math.max(xs[1], x)]; ys = [Math.min(ys[0], y), Math.max(ys[1], y)]; }
}
const total = logo.w * logo.h;
const esquinas = [[0, 0], [logo.w - 1, 0], [0, logo.h - 1], [logo.w - 1, logo.h - 1], [logo.w >> 1, 0], [0, logo.h >> 1]].map(([x, y]) => logo.pixel(x, y)[3]);   // (cada una debe ser alfa 0)
prueba('3a el logo del sitio tiene un canal alfa REAL (PNG con transparencia; no un cuadriculado pintado)', logo.tipo === 3 || logo.tipo === 6, 'tipo de PNG ' + logo.tipo);
prueba('3b las 6 esquinas y bordes del logo son transparentes (alfa 0) y entre el 20 % y el 60 % de los pixeles lo son', esquinas.every((a) => a === 0) && transp / total > 0.2 && transp / total < 0.6,
  `esquinas ${esquinas} transparentes ${(100 * transp / total).toFixed(1)} %`);
prueba('3c los bordes son limpios: pocos pixeles semitransparentes (alfa entre 6 y 249: < 3 %; el original de Carlos tiene 0.3 %) y casi todo el resto es opaco (sin halos ni fondo pintado)', semi / total < 0.03 && opacos / total > 0.3, `semi ${(100 * semi / total).toFixed(2)} % opacos ${(100 * opacos / total).toFixed(1)} %`);
prueba('3d recortado al contenido (margen < 4 % por lado), ancho <= 900 px, peso < 250 KB y casi cuadrado (aspecto entre 1.0 y 1.4)',
  xs[0] / logo.w < 0.04 && (logo.w - 1 - xs[1]) / logo.w < 0.04 && ys[0] / logo.h < 0.04 && (logo.h - 1 - ys[1]) / logo.h < 0.04 && logo.w <= 900 && pesoLogo < 250 * 1024 && logo.w / logo.h > 1 && logo.w / logo.h < 1.4,
  `${logo.w}x${logo.h} ${Math.round(pesoLogo / 1024)} KB caja x ${xs} y ${ys}`);
const CREMA = marca.colores.claro;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
for (const [lado, ruta] of [[192, marca.icono_192], [512, marca.icono_512]]) {
  const ic = leerPng(path.join(REPO, ruta));
  const cercaDeCrema = (p) => Math.abs(p[0] - hex(CREMA)[0]) <= 4 && Math.abs(p[1] - hex(CREMA)[1]) <= 4 && Math.abs(p[2] - hex(CREMA)[2]) <= 4 && p[3] === 255;
  let ix = [1e9, -1], iy = [1e9, -1], opaco = true;
  for (let y = 0; y < ic.h; y++) for (let x = 0; x < ic.w; x++) {
    const p = ic.pixel(x, y); if (p[3] !== 255) opaco = false;
    if (!cercaDeCrema(p)) { ix = [Math.min(ix[0], x), Math.max(ix[1], x)]; iy = [Math.min(iy[0], y), Math.max(iy[1], y)]; }
  }
  const m = Math.min(ix[0], ic.w - 1 - ix[1], iy[0], ic.h - 1 - iy[1]) / lado;
  prueba(`3e el icono de ${lado} px es cuadrado, totalmente opaco, con fondo crema solido (${CREMA}) y el logo con un margen seguro de al menos el 15 %`,
    ic.w === lado && ic.h === lado && opaco && [[0, 0], [lado - 1, 0], [0, lado - 1], [lado - 1, lado - 1]].every(([x, y]) => cercaDeCrema(ic.pixel(x, y))) && m >= 0.145,
    `${ic.w}x${ic.h} opaco ${opaco} margen ${(100 * m).toFixed(1)} %`);
}
prueba('3f el logo anterior (caja crema) quedo guardado fuera de las rutas servidas (Recursos/NORTHE-NUEVO/anterior/, ignorada por git) y el .gitignore la cubre',
  /^Recursos\/NORTHE-NUEVO\/$/m.test(fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8')), '');
prueba('3g los nombres no cambian (la base y el respaldo apuntan a los mismos archivos: no hizo falta SQL)', marca.logo === 'Recursos/logo/northe-logo.png' && marca.icono_192 === 'Recursos/logo/northe-icono-192.png' && marca.icono_512 === 'Recursos/logo/northe-icono-512.png', JSON.stringify([marca.logo, marca.icono_192, marca.icono_512]));
// (Desde las opciones de producto existe el SQL 18, pero es de OTRO cambio: el estilo claro sigue sin traer SQL propio.)
prueba('3h no hay SQL nuevo de este cambio (el estilo claro no trajo SQL; el unico 18-* es el de opciones de producto)', fs.readdirSync(path.join(REPO, 'supabase')).filter((f) => /^18-/.test(f)).every((f) => /^18-(opciones-producto|revertir)\.sql$/.test(f)), fs.readdirSync(path.join(REPO, 'supabase')).filter((f) => /^18-/.test(f)).join(','));

/* ---------------- 4. paginas del personal ---------------- */
for (const f of ['panel.html', 'menu-admin.html', 'historial.html']) {
  const t = leer(f);
  const css = t.slice(t.indexOf('<style>'), t.indexOf('</style>'));
  const body = css.match(/\n\s*body\{[^}]*\}/);
  prueba(`4a ${f}: sigue oscura (fondo var(--carbon)), sin interruptor ni clase del tema claro`, body && /background:var\(--carbon\)/.test(body[0]) && !/tema-claro|TEMA_CLARO/.test(t), body && body[0]);
  const imgs = [...css.matchAll(/([^{}\n]*\bimg)\s*\{([^}]*)\}/g)].filter((m) => /brand|header|menu-cabecera|login-card/.test(m[1]));
  const sels = [...new Set(imgs.map((m) => m[1].trim()))];
  const sinChip = sels.filter((sel) => !imgs.some((m) => m[1].trim() === sel && /background:var\(--crema\)/.test(m[2])));
  prueba(`4b ${f}: el logo (transparente, texto negro) va sobre un chip crema en todos los sitios donde sale (${sels.join(', ')})`, sels.length >= 2 && sinChip.length === 0, sinChip.join(' | '));
}
const prJs = leer('panel-restaurante.js');
prueba('4c el favicon y el apple-touch-icon del panel prefieren el icono con fondo solido (icono_192) y solo caen al logo si no hay', /var url = R\.marca\.icono_192 \|\| R\.marca\.logo;/.test(prJs), '');
prueba('4d la notificacion de pedido nuevo usa el icono con fondo solido', /icon: PR\.R\.marca\.icono_192 \|\| PR\.R\.marca\.logo \|\| undefined/.test(leer('panel.html')), '');

/* ---------------- 5. vista previa de WhatsApp ---------------- */
const PUB = require(path.join(REPO, 'api', '_publico.js'));
const TAQ = '00000000-0000-4000-8000-000000000001';
const vp = PUB.datosVistaPrevia({ id: TAQ, slug: 'taqueiros', nombre: 'The Northe Burgers', config: {} }, 'ejemplo.test', 'index', {});
prueba('5a la vista previa del restaurante demo usa el icono de 512 (fondo crema), no el logo transparente', vp.imagen === 'https://ejemplo.test/' + marca.icono_512, vp.imagen);
const conIconos = (m) => PUB.datosVistaPrevia({ id: '00000000-0000-4000-8000-0000000000aa', slug: 'otro', nombre: 'Otro', config: { publico: { marca: m } } }, 'ejemplo.test', 'index', { SUPABASE_URL: 'https://abc.supabase.co' }).imagen;
prueba('5b el orden es icono de 512, luego logo, luego icono de 192 (y nada si no hay ninguno)',
  conIconos({ logo: 'Recursos/l.png', icono_512: 'Recursos/i.png', icono_192: 'Recursos/s.png' }) === 'https://ejemplo.test/Recursos/i.png' && conIconos({ logo: 'Recursos/l.png' }) === 'https://ejemplo.test/Recursos/l.png'
  && conIconos({ icono_192: 'Recursos/s.png' }) === 'https://ejemplo.test/Recursos/s.png' && conIconos({}) === null, '');

/* ---------------- 6. contraste WCAG AA ---------------- */
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mezcla = (fg, bg, a) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const C = Object.fromEntries(Object.entries(marca.colores).filter(([k, v]) => typeof v === 'string').map(([k, v]) => [k, hex(v)]));
const { primario: rojo, primario_oscuro: rojoO, claro: crema, claro_suave: suave, oscuro: carbon, acento: mostaza, positivo: verde } = C;
const pardo = hex('#5a4a3a'), verdeO = hex('#3f5a24'), errorRojo = hex('#c0392b'), errorOscuro = hex('#8a2820'), ambar = hex('#8a6205'), blanco = [255, 255, 255];
const PAREJAS = [
  // [nombre, texto, fondo, minimo]
  ['eslogan rojo sobre el crema de la portada', rojo, crema, 4.5],
  ['boton primario: texto crema suave sobre rojo', suave, rojo, 4.5],
  ['boton primario al pasar el mouse: crema suave sobre rojo oscuro', suave, rojoO, 4.5],
  ['texto oscuro sobre el crema (titulos, encabezado, botones de borde)', carbon, crema, 4.5],
  ['texto oscuro sobre las tarjetas (crema suave)', carbon, suave, 4.5],
  ['precio: rojo oscuro sobre crema suave', rojoO, suave, 4.5],
  ['descripcion y etiquetas (#5a4a3a) sobre las tarjetas', pardo, suave, 4.5],
  ['descripcion y etiquetas (#5a4a3a) sobre el crema', pardo, crema, 4.5],
  ['frase de la portada: oscuro al 78 % sobre el crema', mezcla(carbon, crema, 0.78), crema, 4.5],
  ['textos secundarios: oscuro al 68 % sobre las tarjetas', mezcla(carbon, suave, 0.68), suave, 4.5],
  ['textos secundarios: oscuro al 70 % sobre el crema (cantidad de opciones)', mezcla(carbon, crema, 0.70), crema, 4.5],
  ['verde oscuro de texto (total del seguimiento, pedido confirmado) sobre crema suave', verdeO, suave, 4.5],
  ['verde oscuro de texto sobre el crema', verdeO, crema, 4.5],
  ['aviso de abierto: texto oscuro sobre crema suave', carbon, suave, 4.5],
  ['aviso de cerrado: texto oscuro sobre el mostaza', carbon, mostaza, 4.5],
  ['aviso de cerrado del carrito: ambar oscuro sobre mostaza al 14 %', ambar, mezcla(mostaza, suave, 0.14), 4.5],
  ['error de un campo: rojo sobre crema suave', errorRojo, suave, 4.5],
  ['pago rechazado: rojo oscuro sobre rojo al 9 %', errorOscuro, mezcla(errorRojo, suave, 0.09), 4.5],
  ['pie (oscuro): crema suave sobre carbon', suave, carbon, 4.5],
  ['pie (oscuro): mostaza sobre carbon (titulos de columna)', mostaza, carbon, 4.5],
  ['pie (oscuro): texto secundario sobre carbon', hex(marca.colores.texto_secundario), carbon, 4.5],
  ['pie (oscuro): texto tenue sobre carbon (derechos)', hex(marca.colores.texto_tenue), carbon, 4.5],
  // componentes (no texto): minimo 3:1
  ['borde de los campos (oscuro al 55 %) sobre blanco', mezcla(carbon, blanco, 0.55), blanco, 3],
  ['borde de los botones de borde (oscuro) sobre el crema', carbon, crema, 3],
  ['borde de las categorias y del selector de cantidad (oscuro al 50 %) sobre el crema', mezcla(carbon, crema, 0.5), crema, 3],
  ['aro de foco (oscuro) sobre el crema', carbon, crema, 3],
  ['aro de foco del pie (mostaza) sobre carbon', mostaza, carbon, 3],
  ['globo del paso activo: crema suave sobre rojo (seguimiento)', suave, rojo, 3],
  ['linea del paso hecho: verde contra el crema', verde, crema, 3]
];
const malas = PAREJAS.filter(([, a, b, min]) => ratio(a, b) < min).map(([n, a, b, min]) => `${n}: ${ratio(a, b).toFixed(2)} < ${min}`);
prueba(`6a las ${PAREJAS.length} parejas texto/fondo y componentes clave cumplen WCAG AA (4.5:1 en texto, 3:1 en componentes) con la paleta de la marca`, malas.length === 0, malas.join(' | '));
// el hover con --rojo-brillo (que en este tema daria ~3.5:1) no se usa en ningun boton del tema claro
prueba('6b ningun boton del tema claro pasa a --rojo-brillo (daria menos de 4.5:1 con texto crema): los hover usan --rojo-oscuro', ratio(suave, C.primario_brillo) < 4.5 && !/hover[^{]*\{[^}]*var\(--rojo-brillo\)/.test(reglas), ratio(suave, C.primario_brillo).toFixed(2));

/* ---------------- 7. sw.js y documentacion ---------------- */
const sw = leer('sw.js');
prueba('7a sw.js documenta el cambio de la v13 (hoy va en la v14 de las opciones de producto) (mismos archivos de logo con otro contenido: hay que invalidar la cache de /Recursos)', /const VERSION = "v14";/.test(sw) && /v13: estilo claro/.test(sw) && /Recursos\/logo\/northe-logo\.png/.test(sw), '');
const vj = fs.readFileSync(path.join(REPO, 'vercel.json'), 'utf8');
prueba('7b ni vercel.json ni el sitio publico ponen cache larga ni "immutable" a /Recursos (el logo con el mismo nombre no se queda pegado) y el sitio publico no registra el service worker',
  !/Cache-Control|immutable|max-age/i.test(vj) && !/serviceWorker/.test(index + pedido + leer('restaurante-publico.js')), '');
const doc = leer('docs/multirestaurante.md');
const d14 = doc.slice(doc.indexOf('### 20.14'), doc.indexOf('## 21.'));
prueba('7c docs 20.14 documenta el estilo, el interruptor TEMA_CLARO y como apagarlo, los archivos tocados, como se genero el logo y los iconos, como repetirlo y el riesgo del segundo restaurante',
  d14.length > 1500 && [/TEMA_CLARO/, /apag/i, /northe-logo\.png/, /preparar-logo-transparente\.py/, /icono/i, /segundo restaurante/i, /sw\.js/, /capturas/i, /vista previa/i, /mockup/i].every((r) => r.test(d14)), d14.length + ' caracteres');

/* ---------------- resultado ---------------- */
let ok = 0;
for (const r of resultados) { if (r.ok) ok++; console.log(`  ${r.ok ? 'PASA ' : 'FALLA'} ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`); }
console.log(`\n${ok} PASAN, ${resultados.length - ok} FALLAN.`);
process.exit(ok === resultados.length ? 0 : 1);
