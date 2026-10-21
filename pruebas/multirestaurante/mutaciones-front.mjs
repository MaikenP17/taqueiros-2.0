/* =============================================================
   REVISION POR MUTACION DEL FRONTEND PUBLICO

     node pruebas/multirestaurante/mutaciones-front.mjs
     node pruebas/multirestaurante/mutaciones-front.mjs --solo=innerHTML      (las que contengan ese texto)

   Rompe A PROPOSITO, una por una, cada defensa de index.html, pedido.html y restaurante-publico.js
   (en una COPIA en una carpeta temporal: el repositorio no se toca) y exige que front.mjs
   (el navegador) lo detecte. Cada mutante corre solo los escenarios de front.mjs que tienen que
   notarlo (SOLO=...), para no tardar una hora.

   DETECTADA: front.mjs termina con error. SOBREVIVE: todo pasa (falta una prueba, o la defensa
   sobra). EQUIVALENTE: la defensa tiene otra capa que cubre lo mismo (se declara con su razon;
   quitar las dos capas juntas SI se detecta).

   Sale con codigo 1 si una mutacion NO equivalente sobrevive.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './sim.mjs';

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const filtro = arg('solo');

/* [nombre, archivo, buscar, reemplazar, escenarios (SOLO), { equivalente }] */
const M = [];
const m = (nombre, archivo, buscar, reemplazar, solo, extra) => M.push({ nombre, archivo, buscar, reemplazar, solo, ...(extra || {}) });

const HTML = 'index.html', PED = 'pedido.html', LIB = 'restaurante-publico.js';

// ---- el navegador nunca pega como HTML lo que viene de la base --------------------------------------------------------------
m('index: el eslogan / tagline / pie se pegan con innerHTML', HTML, 'el.textContent = texto || "";', 'el.innerHTML = texto || "";', '^(3|3b)\\.');
m('index: el titulo del banner se pega con innerHTML (mensaje de cerrado del dueno)', HTML, 'fuerte.textContent = titulo;', 'fuerte.innerHTML = titulo;', '^(3|3b)\\.');
m('index: los dias del horario se pegan con innerHTML', HTML, 'li.textContent = h.activo === false', 'li.innerHTML = h.activo === false', '^3\\.');
m('index: la direccion y el telefono del pie se pegan con innerHTML', HTML, '    li.textContent = t;', '    li.innerHTML = t;', '^(3|3b)\\.');
m('index: la ultima palabra del nombre de la cabecera se pega con innerHTML', HTML, 'resaltado.textContent = partes.resaltado;', 'resaltado.innerHTML = partes.resaltado;', '^3b\\.');
m('index: el nombre del pie se pega con innerHTML', HTML, 'document.getElementById("footerNombre").textContent = mayusculas;', 'document.getElementById("footerNombre").innerHTML = mayusculas;', '^(3|3b)\\.');
m('pedido: las frases del seguimiento se pegan sin escapar', PED, "'<div class=\"estado-frase\">' + escapar(frase) + '</div>'", "'<div class=\"estado-frase\">' + frase + '</div>'", '^3\\.');
m('pedido: los tiempos del seguimiento se pegan sin escapar', PED, "'<div class=\"estado-sub\">' + escapar(sub) + '</div>'", "'<div class=\"estado-sub\">' + sub + '</div>'", '^3\\.');
m('pedido: la direccion de retiro se pega sin escapar', PED, "escapar(R.contacto.direccion_corta || R.contacto.direccion || '') + '</div>';", "(R.contacto.direccion_corta || R.contacto.direccion || '') + '</div>';", '^3\\.');
m('pedido: una clave de seguimiento con caracteres raros llega a la base', PED, 'const CLAVE_VALIDA = /^[A-Za-z0-9_-]{6,80}$/;', 'const CLAVE_VALIDA = /.*/;', '^1b\\.');

// ---- validaciones del navegador (defensa en capas: el servidor ya valida lo mismo) -------------------------------------------
m('lib: los colores no se validan', LIB, 'return typeof v === "string" && COLOR.test(v.trim()) ? v.trim() : null;', 'return typeof v === "string" ? v : null;', '^3b\\.');
m('lib: el color no tiene que ser #RRGGBB completo (regex sin anclas)', LIB, 'var COLOR = /^#[0-9A-Fa-f]{6}$/;', 'var COLOR = /#[0-9A-Fa-f]{6}/;', '^3b\\.');
m('lib: una URL puede ser de cualquier origen', LIB, 'return origenesPermitidos().indexOf(u.origin) >= 0 ? u.href : null;', 'return u.href;', '^3b\\.');
m('lib: una URL puede ser javascript: o data: (solo se quita la comprobacion de protocolo)', LIB, '    if (u.protocol !== "https:" && u.protocol !== "http:") return null;\n', '', '^3b\\.',
  { equivalente: 'el origen de javascript:/data: es "null", que nunca esta en la lista de origenes permitidos (otra capa); con las dos quitadas SI se detecta (mutacion siguiente)' });
m('lib: una URL puede ser javascript: (se quitan las dos capas: protocolo y origen)', LIB, '    if (u.protocol !== "https:" && u.protocol !== "http:") return null;\n', '    // sin comprobacion de protocolo\n', '^3b\\.',
  { tambien: [LIB, 'return origenesPermitidos().indexOf(u.origin) >= 0 ? u.href : null;', 'return u.href;'] });
m('lib: una ruta relativa puede subir de carpeta o empezar con //', LIB, 'if (RUTA.test(s) && s.indexOf("..") < 0 && s.indexOf("//") < 0) return s;', 'if (RUTA.test(s)) return s;', '^3b\\.');
m('lib: los textos conservan caracteres de control, ancho cero y bidi', LIB, 'v.replace(CONTROLES, " ").replace(BLANCOS, " ")', 'v.replace(BLANCOS, " ")', '^3b\\.');
m('lib: el WhatsApp no se valida', LIB, 'if (typeof ct.whatsapp === "string" && WHATSAPP.test(ct.whatsapp)) contacto.whatsapp = ct.whatsapp;', 'if (typeof ct.whatsapp === "string") contacto.whatsapp = ct.whatsapp;', '^3b\\.');
m('lib: el usuario de la red social no se valida', LIB, 'if (typeof ct[k] === "string" && USUARIO_RED.test(ct[k])) contacto[k] = ct[k];', 'if (typeof ct[k] === "string") contacto[k] = ct[k];', '^3b\\.');
m('lib: la llave de pago no tiene que ser del modo (la de prueba en produccion)', LIB, '      && pg.llave_publica.indexOf(modo === "produccion" ? "pub_prod_" : "pub_test_") === 0 ? pg.llave_publica : null;', '      ? pg.llave_publica : null;', '^3b\\.');
m('lib: las tarifas no se validan', LIB, 'var hasta = numero(t.hasta, 0, 100000);', 'var hasta = t.hasta;', '^3b\\.');
m('lib: el servicio suspendido se ignora (solo en /api/restaurante)', LIB, 'servicio: { sirve: serv.sirve !== false },', 'servicio: { sirve: true },', '^4[.]',
  { equivalente: 'la pagina vuelve a leer el servicio en /api/estado al cargar y en cada sondeo (otra capa); si ademas ignorara /api/estado, la prueba "suspendido: no se puede pedir" SI lo detecta' });
m('lib: el modulo de seguimiento apagado se ignora', LIB, 'seguimiento: mod.seguimiento !== false,', 'seguimiento: true,', '^4\\.');
m('lib: el almacenamiento no distingue restaurantes', LIB, 'if (e && e.rid === R.id) return e.v;', 'if (e) return e.v;', '^8\\.');

// ---- lo que decide que se ofrece ------------------------------------------------------------------------------------------------
m('index: el seguimiento apagado no esconde "Mi pedido"', HTML, 'document.getElementById("abrirMiPedidoTop").style.display = conSeguimiento ? "" : "none";', 'document.getElementById("abrirMiPedidoTop").style.display = "";', '^4\\.');
m('index: con el servicio suspendido se sigue pudiendo pagar', HTML, 'const hayPago = R.pago.disponible && !suspendido;', 'const hayPago = R.pago.disponible;', '^4\\.');
m('index: con el servicio suspendido se sigue pudiendo pedir por WhatsApp', HTML, 'const hayWhatsapp = !!R.contacto.whatsapp && !suspendido;', 'const hayWhatsapp = !!R.contacto.whatsapp;', '^4\\.');
m('index: se ofrece domicilio aunque el restaurante no lo tenga configurado', HTML, 'if(!R.domicilio.ofrece){', 'if(false){', '^(4|3b)\\.');
m('index: el modo de cobro lo elige la pagina (siempre produccion)', HTML, 'body: JSON.stringify({ cliente, items, modo: MODO_COBRO })', 'body: JSON.stringify({ cliente, items, modo: "produccion" })', '^6\\.');
m('index: la busqueda de pedidos no se acota al restaurante', HTML, 'body: JSON.stringify({ telefono: telefono, total_pagado: total, p_restaurante: R.id })', 'body: JSON.stringify({ telefono: telefono, total_pagado: total })', '^1b\\.');
m('index: el enlace de un resultado de busqueda usa la referencia y no el token', HTML, 'urlSeguimientoDe(String(p.token_seguimiento || p.referencia))', 'urlSeguimientoDe(String(p.referencia))', '^1b\\.');
m('index: el enlace de seguimiento de la confirmacion usa la referencia y no el token', HTML, 'enlace: (typeof datos.tokenSeguimiento === "string" && datos.tokenSeguimiento) ? datos.tokenSeguimiento : referencia,', 'enlace: referencia,', '^6\\.');
m('index: el banner de pedido en curso guarda la referencia como enlace', HTML, 'guardarSeguimiento(pedido.referencia, pedido.enlace || pedido.referencia);', 'guardarSeguimiento(pedido.referencia, pedido.referencia);', '^6\\.');
m('index: la redireccion de Wompi es un dominio fijo', HTML, 'WOMPI_REDIRECT_URL = location.origin + RP.api("/?pago=exitoso");', 'WOMPI_REDIRECT_URL = "https://otro.example/?pago=exitoso";', '^1\\.');
m('index: la llave publica de pago es fija', HTML, 'WOMPI_PUBLIC_KEY = R.pago.llave || "";', 'WOMPI_PUBLIC_KEY = "pub_test_FIJAFIJAFIJAFIJAFIJA";', '^(1|3b)\\.');
m('index: el factor de recorrido es fijo', HTML, 'FACTOR_RECORRIDO = R.domicilio.factor;', 'FACTOR_RECORRIDO = 1.3;', '^1\\.');
m('index: las tarifas de domicilio no vienen del servidor', HTML, 'TARIFAS_DOMICILIO = R.domicilio.tarifas;', 'TARIFAS_DOMICILIO = [{ hasta: 2, precio: 5000 }, { hasta: 999, precio: null }];', '^1\\.');
m('index: el menu de respaldo no distingue restaurantes (no usa RP.leer)', HTML, 'const guardado = RP.leer(MENU_CACHE_KEY);', 'const guardado = (function(){ try { var x = JSON.parse(localStorage.getItem(MENU_CACHE_KEY) || "null"); return x && x.v; } catch (e) { return null; } })();', '^8[.]');

/* ---- ejecucion ------------------------------------------------------------------------------------------------------------------------ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-mut-front-'));
const leer = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');
const original = { [HTML]: leer(HTML), [PED]: leer(PED), [LIB]: leer(LIB) };

function correr(carpeta, solo) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'pruebas', 'multirestaurante', 'front.mjs')], {
    cwd: REPO, env: { ...process.env, FRONT_RAIZ: carpeta, SOLO: solo }, encoding: 'utf8', timeout: 600000
  });
  return { codigo: r.status, salida: (r.stdout || '') + (r.stderr || '') };
}

function carpetaConMutacion(mu) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  const archivos = { ...original };
  const aplicar = (archivo, buscar, reemplazar) => {
    const n = archivos[archivo].split(buscar).length - 1;
    if (n !== 1) throw new Error(`mutacion mal definida: "${buscar.slice(0, 70)}" aparece ${n} veces en ${archivo}`);
    archivos[archivo] = archivos[archivo].split(buscar).join(reemplazar);
  };
  aplicar(mu.archivo, mu.buscar, mu.reemplazar);
  if (mu.tambien) aplicar(...mu.tambien);
  for (const [f, c] of Object.entries(archivos)) fs.writeFileSync(path.join(dir, f), c);
  return dir;
}

const resumen = { detectadas: 0, equivalentes: [], sobreviven: [], errores: [] };

console.log('Linea base: el frontend sin tocar debe pasar todos los escenarios...');
const base = correr(carpetaConMutacion({ archivo: HTML, buscar: '<title>Pedidos en línea</title>', reemplazar: '<title>Pedidos en línea</title>' }), '^(1|1b|3|3b|4|6|8|9)\\.');
if (base.codigo !== 0) {
  console.log(base.salida.split('\n').filter((l) => /FALLA|ERROR/.test(l)).slice(0, 10).join('\n'));
  console.log('La linea base falla: no se puede hacer la revision por mutacion.');
  process.exit(2);
}
console.log('  linea base OK\n');

for (const mu of M) {
  if (filtro && !mu.nombre.includes(filtro)) continue;
  let dir;
  try { dir = carpetaConMutacion(mu); } catch (e) { resumen.errores.push(`${mu.nombre}: ${e.message}`); console.log(`  ERROR      ${mu.nombre}\n             ${e.message}`); continue; }
  const r = correr(dir, mu.solo);
  const detectada = r.codigo !== 0;
  if (mu.equivalente) {
    if (detectada) { resumen.detectadas++; console.log(`  DETECTADA  ${mu.nombre}  (declarada equivalente, pero SI se detecta: quitar de las equivalentes)`); }
    else { resumen.equivalentes.push(`${mu.nombre} -> ${mu.equivalente}`); console.log(`  EQUIVALENTE ${mu.nombre}`); }
  } else if (detectada) {
    resumen.detectadas++;
    console.log(`  DETECTADA  ${mu.nombre}`);
  } else {
    resumen.sobreviven.push(mu.nombre);
    console.log(`  SOBREVIVE  ${mu.nombre}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n=============================================================');
console.log(`DETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes.length}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
if (resumen.sobreviven.length) { console.log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((s) => console.log('  - ' + s)); }
if (resumen.equivalentes.length) { console.log('\nEQUIVALENTES:'); resumen.equivalentes.forEach((s) => console.log('  - ' + s)); }
if (resumen.errores.length) { console.log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((s) => console.log('  - ' + s)); }
process.exitCode = resumen.sobreviven.length || resumen.errores.length ? 1 : 0;
