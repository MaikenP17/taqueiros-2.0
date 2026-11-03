/* =============================================================
   REVISION POR MUTACION DE LA INTERFAZ DE OPCIONES DE PRODUCTO (parte B, docs 22.18)

     node pruebas/multirestaurante/mutaciones-opciones-ui.mjs
     node pruebas/multirestaurante/mutaciones-opciones-ui.mjs --solo=carrito        (las que contengan ese texto)
     node pruebas/multirestaurante/mutaciones-opciones-ui.mjs --paralelo=3          (mutantes a la vez; por defecto 3)

   Rompe A PROPOSITO, una por una, lo que decide PRECIOS, CLAVES DE LINEA, ESCAPADO, MENSAJES y VALIDACIONES de lo nuevo
   (opciones-texto.js, index.html, pedido.html, panel.html, historial.html, menu-admin.html, ticket-comanda.js,
   api/_notificar.js y api/crear-pedido.js) en una COPIA en una carpeta temporal (el repositorio no se toca) y exige que
   las pruebas lo detecten:
     unit   -> node --test opciones-texto / crear-pedido-limpiar / ticket-comanda (las funciones puras)
     front  -> front.mjs, escenario 11 (el navegador: modal, carrito, mensajes, precio cambiado, seguimiento)
     panel  -> panel.mjs, escenarios 16 y 17 (tablero, historial, texto del ticket y menu-admin)
   (El ticket impreso en el navegador lo cubre ademas el escenario 22 de pruebas/impresion/e2e.js y comparar-tickets.mjs.)

   DETECTADA: la prueba termina con error. SOBREVIVE: todo pasa (falta una prueba, o la defensa sobra). EQUIVALENTE: otra
   capa cubre lo mismo (se declara con su razon).

   Sale con codigo 1 si una mutacion NO equivalente sobrevive.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO } from './sim.mjs';

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const filtro = arg('solo');
const PARALELO = Number(arg('paralelo')) || 3;

const OT = 'opciones-texto.js', IDX = 'index.html', PED = 'pedido.html', PAN = 'panel.html', HIS = 'historial.html', MEN = 'menu-admin.html',
  TIC = 'ticket-comanda.js', NOT = 'api/_notificar.js', CRE = 'api/crear-pedido.js';

/* { nombre, archivo, buscar, reemplazar, via, equivalente?, tambien?: [archivo, buscar, reemplazar] } */
const M = [];
const m = (via, nombre, archivo, buscar, reemplazar, extra) => M.push({ via, nombre, archivo, buscar, reemplazar, ...(extra || {}) });

// =====================================================================================================================
//   opciones-texto.js  (unit)
// =====================================================================================================================
m('unit', 'texto: limpiar corta por unidades UTF-16 (parte un emoji)', OT, 'return Array.from(t).slice(0, tope).join("").trim();', 'return t.slice(0, tope).trim();');
m('unit', 'texto: limpiar no quita invisibles', OT, '.replace(INVISIBLES, " ").replace(/\\s+/g, " ").trim();\n    var tope', '.replace(/\\s+/g, " ").trim();\n    var tope');
m('unit', 'texto: limpiar no junta saltos y espacios en una linea', OT, '.replace(INVISIBLES, " ").replace(/\\s+/g, " ").trim();\n    var tope', '.replace(INVISIBLES, " ").trim();\n    var tope');
m('unit', 'texto: el tope por defecto del nombre ya no es 40', OT, 'var MAX_NOMBRE = 40;', 'var MAX_NOMBRE = 400;');
m('unit', 'texto: los invisibles ya no incluyen los aislantes bidi U+2066-2069 (rango 2060-206F recortado)', OT, '[0x2060, 0x206f]', '[0x2060, 0x2064]');
m('unit', 'texto: los invisibles ya no incluyen el guion suave', OT, '[0x00ad, 0x00ad], ', '');
m('unit', 'texto: los invisibles ya no incluyen la marca bidi arabe', OT, '[0x061c, 0x061c], ', '');
m('unit', 'texto: los invisibles ya no incluyen los rellenos de Hangul', OT, '[0x3164, 0x3164],\n    [0xfeff', '[0xfeff');
m('unit', 'texto: los invisibles ya no incluyen las etiquetas U+E0000', OT, ', [0xe0000, 0xe007f]', '');
m('unit', 'texto: los invisibles ya no incluyen los separadores de linea y las marcas bidi (200B-200F, 2028-202E)', OT, '[0x200b, 0x200f], [0x2028, 0x202e], ', '');
m('unit', 'texto: paraMensaje deja el "$" (CallMeBot lo corrompe)', OT, 'var DE_MENSAJE = /[$*_~`]/g;', 'var DE_MENSAJE = /[*_~`]/g;');
m('unit', 'texto: paraMensaje deja los asteriscos (negrita de WhatsApp)', OT, 'var DE_MENSAJE = /[$*_~`]/g;', 'var DE_MENSAJE = /[$_~`]/g;');
m('unit', 'texto: paraMensaje deja el guion bajo y la tilde de WhatsApp', OT, 'var DE_MENSAJE = /[$*_~`]/g;', 'var DE_MENSAJE = /[$*`]/g;');
m('unit', 'texto: el mensaje no usa paraMensaje (usa limpiar a secas)', OT, 'var p = partes(opciones, o.mensaje ? "mensaje" : "normal");', 'var p = partes(opciones, "normal");');
m('unit', 'texto: los extras van antes que lo que se quita', OT, 'var todas = p.quitar.map(function (q) { return q.nombre; })\n      .concat(p.extras.map(function (e) { return "+ " + e.nombre; }));',
  'var todas = p.extras.map(function (e) { return "+ " + e.nombre; })\n      .concat(p.quitar.map(function (q) { return q.nombre; }));');
m('unit', 'texto: los extras salen sin el "+ " delante', OT, '.concat(p.extras.map(function (e) { return "+ " + e.nombre; }));', '.concat(p.extras.map(function (e) { return e.nombre; }));');
m('unit', 'texto: el corte a "+N mas" empieza una etiqueta tarde (>= en vez de >)', OT, 'if (max > 0 && todas.length > max) {', 'if (max > 0 && todas.length >= max) {');
m('unit', 'texto: el "+N mas" cuenta mal el resto', OT, 'var resto = todas.length - max;', 'var resto = todas.length - max + 1;');
m('unit', 'texto: el mensaje permite 7 etiquetas por linea (S5 dice 6)', OT, 'var MAX_ETIQUETAS = 6;', 'var MAX_ETIQUETAS = 7;');
m('unit', 'texto: se aceptan mas de 12 opciones', OT, 'var lista = Array.isArray(opciones) ? opciones.slice(0, MAX_OPCIONES) : [];', 'var lista = Array.isArray(opciones) ? opciones : [];');
m('unit', 'texto: un "quitar" puede costar', OT, 'else if (o.tipo === "extra") {\n        var p = o.precio;', 'else if (o.tipo === "extra" || true) {\n        var p = o.precio;');
m('unit', 'texto: un tipo desconocido se toma por quitar', OT, 'if (o.tipo === "quitar") quitar.push', 'if (o.tipo !== "extra") quitar.push');
m('unit', 'texto: la clave de la linea no ordena los ids (el mismo conjunto da dos lineas)', OT, 'var unicos = Array.from(new Set(lista)).sort();', 'var unicos = Array.from(new Set(lista));');
m('unit', 'texto: la clave de la linea repite ids iguales', OT, 'var unicos = Array.from(new Set(lista)).sort();', 'var unicos = lista.slice().sort();');
m('unit', 'texto: la clave de la linea ignora las opciones (dos conjuntos distintos se juntan)', OT, 'return unicos.length ? String(productoId) + "|" + unicos.join(",") : String(productoId);', 'return String(productoId);');
m('unit', 'texto: leerClave acepta ids con mayusculas o espacios', OT, 'if (!id || ids.length > MAX_OPCIONES || !ids.every(function (x) { return ID_OPCION.test(x); })) return null;', 'if (!id || ids.length > MAX_OPCIONES) return null;');
m('unit', 'texto: leerClave acepta mas de 12 opciones', OT, 'if (!id || ids.length > MAX_OPCIONES || !ids.every', 'if (!id || !ids.every');
m('unit', 'texto: leerClave acepta ids repetidos', OT, 'if (new Set(ids).size !== ids.length) return null;', '');
m('unit', 'texto: leerClave acepta claves enormes', OT, 'if (clave.length > 60 + 1 + MAX_OPCIONES * 61) return null;', '');
m('unit', 'texto: el nombre del dueno puede llevar emojis', OT, 'if (EMOJIS_Y_SIMBOLOS.test(t)) {', 'if (false) {');
m('unit', 'texto: el nombre del dueno puede llevar < o >', OT, 'if (/[<>]/.test(t)) return', 'if (false) return');
m('unit', 'texto: el nombre del dueno puede pasar de 40 caracteres', OT, 'if (Array.from(t.trim()).length > MAX_NOMBRE) return', 'if (false) return');
m('unit', 'texto: el nombre del dueno puede llevar invisibles', OT, 'if (new RegExp(INVISIBLES.source, "u").test(t)) return', 'if (false) return');
m('unit', 'texto: el nombre del dueno puede quedar vacio (solo espacios duros)', OT, 'if (limpiar(t, 1000) === "") return', 'if (false) return',
  { equivalente: 'es una red de seguridad que hoy no se alcanza: un nombre hecho solo de espacios (incluido el duro U+00A0) ya lo frena el primer chequeo (trim), y uno hecho solo de invisibles, el de invisibles' });
m('unit', 'texto: el nombre del dueno puede llevar el simbolo de copyright (los simbolos de la termica)', OT, '[0x20e3, 0x20e3], [0x00a9, 0x00a9], [0x00ae, 0x00ae]', '[0x20e3, 0x20e3]');

// =====================================================================================================================
//   api/_notificar.js y api/crear-pedido.js (unit)
// =====================================================================================================================
m('unit', 'servidor (CallMeBot): el nombre de la opcion deja el "$"', NOT, 'String(valor == null ? "" : valor).replace(/[$*_~`]/g, "");', 'String(valor == null ? "" : valor);');
m('unit', 'servidor (CallMeBot): el nombre de la opcion deja los saltos de linea (fabrica otra linea)', NOT, '.replace(INVISIBLES_OPCION, " ").replace(/\\s+/g, " ").trim();', '.replace(INVISIBLES_OPCION, " ").trim();');
m('unit', 'servidor (CallMeBot): el nombre de la opcion deja los invisibles y bidi', NOT, '.replace(INVISIBLES_OPCION, " ").replace(/\\s+/g, " ")', '.replace(/\\s+/g, " ")');
m('unit', 'servidor (CallMeBot): el nombre se corta por unidades UTF-16', NOT, 'return Array.from(t).slice(0, 40).join("").trim();', 'return t.slice(0, 40).trim();');
m('unit', 'servidor (CallMeBot): sin limite de etiquetas por linea', NOT, 'if (etiquetas.length > MAX_ETIQUETAS_OPCIONES) {', 'if (false) {');
m('unit', 'servidor (CallMeBot): los extras salen sin el "+ "', NOT, 'else if (o.tipo === "extra") extras.push("+ " + nombre);', 'else if (o.tipo === "extra") extras.push(nombre);');
m('unit', 'servidor (CallMeBot): un tipo desconocido sale como quitar', NOT, 'if (o.tipo === "quitar") quitar.push(nombre);', 'if (o.tipo !== "extra") quitar.push(nombre);');
m('unit', 'servidor (CallMeBot): las opciones no salen en la linea del item', NOT, '${it.cantidad}x ${it.nombre}${parentesisOpciones(it.opciones)} ', '${it.cantidad}x ${it.nombre} ');
m('unit', 'servidor (H4): los datos del cliente se cortan por unidades UTF-16', CRE, 'return Array.from(t.trim()).slice(0, maximo).join("");', 'return t.trim().slice(0, maximo);');

// =====================================================================================================================
//   ticket-comanda.js (unit)
// =====================================================================================================================
m('unit', 'ticket: el "Sin " del nombre no se quita ("SIN: Sin queso")', TIC, 'sin.push(recortarCaracteres(limpiarTexto(nombre.replace(/^sin\\s+(?=\\S)/i, "")), MAX_CARACTERES_OPCION) || nombre);', 'sin.push(nombre);');
m('unit', 'ticket: un "quitar" se imprime como extra (se pierde el SIN)', TIC, 'if (o.tipo === "quitar") {', 'if (o.tipo === "extra") {');
m('unit', 'ticket: un tipo desconocido se imprime como extra', TIC, '} else if (o.tipo === "extra") {\n        extras.push(nombre);', '} else {\n        extras.push(nombre);');
m('unit', 'ticket: el nombre de la opcion no pasa por limpiarTexto (emojis y bidi llegan a la termica)', TIC, 'const nombre = recortarCaracteres(limpiarTexto(o.nombre), MAX_CARACTERES_OPCION);', 'const nombre = recortarCaracteres(String(o.nombre == null ? "" : o.nombre), MAX_CARACTERES_OPCION);');
m('unit', 'ticket: el nombre de la opcion se corta por unidades UTF-16', TIC, 'return Array.from(texto).slice(0, maximo).join("").trim();', 'return texto.slice(0, maximo).trim();');
m('unit', 'ticket: el nombre de la opcion se corta a 40 (se come lo que envuelve)', TIC, 'const MAX_CARACTERES_OPCION = 60;', 'const MAX_CARACTERES_OPCION = 20;');
m('unit', 'ticket: sin tope de 12 opciones', TIC, 'opciones.slice(0, MAX_OPCIONES_TICKET)', 'opciones');
m('unit', 'ticket: la hoja de estilos de las opciones se agrega siempre (un ticket sin opciones cambia)', TIC, 'if (d.items.some(it => it.sin || it.extras)) {', 'if (true) {');
m('unit', 'ticket: la hoja de estilos de las opciones nunca se agrega', TIC, 'if (d.items.some(it => it.sin || it.extras)) {', 'if (false) {');
m('unit', 'ticket: un item sin opciones trae claves vacias de mas', TIC, 'if (op.sin.length || op.extras.length) {', 'if (true) {');
m('unit', 'ticket: los extras no llevan sangria francesa', TIC, '".item .extra{padding-left:1.4em;text-indent:-1.4em;}"', '".item .extra{}"');
m('unit', 'ticket: lo que se quita ya no va en negrita', TIC, '.item .sin,.item .extra{font-size:" + esc(15) + ";font-weight:900;', '.item .sin,.item .extra{font-size:" + esc(15) + ";font-weight:400;');
m('unit', 'ticket: la lista de simbolos ya no quita los aislantes bidi (U+2066-2069)', TIC, '\\u{2065}-\\u{206F}', '\\u{2065}');
m('unit', 'ticket: la lista de simbolos ya no quita el guion suave', TIC, '\\u{00AD}', '');
m('unit', 'ticket: el ticket de prueba ya no trae un item con opciones', TIC, 'opciones: [\n            { id: "sin-queso", tipo: "quitar", nombre: "Sin queso", precio: 0 },', 'xopciones: [\n            { id: "sin-queso", tipo: "quitar", nombre: "Sin queso", precio: 0 },');

// =====================================================================================================================
//   index.html  (front, escenario 11)
// =====================================================================================================================
const SIN_CARRITO = 'front';
m('front', 'carrito: el total ignora los extras', IDX, 'return lineasDelCarrito().reduce((sum, l) => sum + l.unit*l.qty, 0);', 'return lineasDelCarrito().reduce((sum, l) => sum + l.p.price*l.qty, 0);');
m('front', 'carrito: el precio unitario de la linea ignora los extras', IDX, 'unit:p.price + extras };', 'unit:p.price };');
m('front', 'carrito: los extras no se suman al multiplicar por la cantidad (unit * 1)', IDX, '<span class="subtotal">${formatCOP(linea.unit*qty)}</span>', '<span class="subtotal">${formatCOP(linea.unit)}</span>');
m('front', 'modal: el boton ignora los extras marcados', IDX, 'formatCOP(p.price + extras);', 'formatCOP(p.price);');
m('front', 'modal: el boton suma tambien los extras sin marcar', IDX, '(o.tipo === "extra" && marcadas.has(o.id) ? o.precio : 0)', '(o.tipo === "extra" ? o.precio : 0)');
m('front', 'modal: lo marcado no se recuerda al cerrar por accidente', IDX, 'borradorOpciones.set(p.id, new Set(opcionesMarcadasDelModal()));', '/* sin borrador */');
m('front', 'modal: lo marcado no se borra al agregar al carrito', IDX, '  borradorOpciones.delete(p.id);\n', '');
m('front', 'modal: agregar no suma a la linea que ya existe (siempre 1)', IDX, 'cart[clave] = Math.min(999, (cart[clave] || 0) + 1);', 'cart[clave] = 1;');
m('front', 'modal: el "+" de un producto con opciones suma directo en vez de abrir el modal', IDX, 'btn.addEventListener("click", (e) => { e.stopPropagation(); openProductModal(id); });', 'btn.addEventListener("click", (e) => { e.stopPropagation(); changeQty(id, 1); });');
m('front', 'modal: las opciones apagadas se muestran igual (no se filtra por activas)', IDX, 'const nombre = OT.limpiar(o.nombre, OT.MAX_NOMBRE);\n    if(!nombre) return;', 'const nombre = OT.limpiar(o.nombre, OT.MAX_NOMBRE) || "?";', { equivalente: 'las apagadas ni llegan en el menu (el servidor solo manda las activas); este filtro es solo para nombres vacios' });
m('front', 'pedido: no se mandan las opciones al servidor', IDX, '    if(k.ids.length) item.opciones = k.ids.slice();\n', '');
m('front', 'pedido: se manda el precio con extras como "precio mostrado" (rompe la comparacion con la base)', IDX, 'const item = { id: k.id, cantidad: cart[clave], precio: pr ? pr.price : undefined };', 'const item = { id: k.id, cantidad: cart[clave], precio: pr ? pr.price + 1 : undefined };');
m('front', 'pedido: se mandan objetos en vez de ids de opcion', IDX, 'item.opciones = k.ids.slice();', 'item.opciones = k.ids.map(function(i){ return { id: i }; });');
m('front', 'C2: el total del servidor nunca se compara con el del carrito', IDX, 'if(Number.isFinite(Number(total)) && (Number(total) !== totalMostrado || Number(datos.subtotal) !== subtotalMostrado)){', 'if(false){');
m('front', 'C2: solo se compara el subtotal (un cambio solo en el total pasa en silencio)', IDX, '(Number(total) !== totalMostrado || Number(datos.subtotal) !== subtotalMostrado)', '(Number(datos.subtotal) !== subtotalMostrado)', { equivalente: 'el total es subtotal + domicilio y el domicilio lo calcula el servidor con la misma regla; solo un cambio de domicilio sin cambio de subtotal difiere, y eso no es de las opciones (se mira con el total en la mutacion anterior)' });
m('front', 'C2: "Revisar mi pedido" paga igual', IDX, 'botonRevisar.onclick = () => { botonPagar.disabled = true; botonRevisar.disabled = true; terminar("revisar"); };', 'botonRevisar.onclick = () => { botonPagar.disabled = true; botonRevisar.disabled = true; terminar("pagar"); };');
m('front', 'C2: Escape no cuenta como "revisar" (el aviso se queda colgado)', IDX, '    document.addEventListener("keydown", alTeclear, true);\n', '');
m('front', 'C2: el aviso queda tapado por el formulario de entrega (sin z-index propio)', IDX, '  #precioCambioOverlay{z-index:600;}\n', '');
m('front', 'C2: el boton "Pagar" muestra el monto viejo', IDX, 'botonPagar.textContent = "Pagar " + formatCOP(ahora);', 'botonPagar.textContent = "Pagar " + formatCOP(antes);');
m('front', 'C2: Wompi se abre con el total del carrito y no con el del servidor', IDX, '      cliente,\n      total,\n      subtotal: datos.subtotal,', '      cliente,\n      total: totalMostrado,\n      subtotal: datos.subtotal,');
m('front', 'C2: revisar no avisa el total confirmado', IDX, 'avisarEnCarrito("El total confirmado por el restaurante es " + formatCOP(Number(total)) +', 'avisarEnCarrito("" +');
m('front', 'C4: la confirmacion no deja ver la diferencia aceptada', IDX, 'if(Number(pedido.ajuste)){\n    document.getElementById("confirmSummary")', 'if(false){\n    document.getElementById("confirmSummary")');
m('front', 'C4: el ajuste se calcula al reves', IDX, 'ajuste = Number(datos.subtotal) - subtotalMostrado;', 'ajuste = subtotalMostrado - Number(datos.subtotal);');
m('front', 'C3: una opcion rechazada (400) no se atiende (cae en el aviso generico)', IDX, 'if((resp.status === 400 || resp.status === 503) && Array.isArray(detalle.agotados)){', 'if(false){');
m('front', 'C3: tras el 400 no se vuelve a pedir el menu (la linea mala se queda)', IDX, '          await cargarMenu({ forzar: true });\n', '');
m('front', 'carrito: una linea con una opcion que ya no existe no se retira', IDX, 'if(!l || !l.faltan.length) return;', 'return;');
m('front', 'carrito: un carrito antiguo (lineas sin opciones) se descarta', IDX, 'if(!k || !Number.isInteger(q) || q <= 0 || q > 999) return;', 'if(!k || k.ids.length === 0 || !Number.isInteger(q) || q <= 0 || q > 999) return;');
m('front', 'carrito: las claves rotas se aceptan', IDX, 'const k = OT.leerClave(clave);\n      if(!k ||', 'const k = OT.leerClave(clave) || { id: clave, ids: [] };\n      if(!k ||',
  { equivalente: 'una clave rota entra al carrito como si fuera el id de un producto que no existe, y purgarCarritoHuerfano() la retira con su aviso (otra capa); el resultado visible es el mismo' });
m('front', 'mensaje: el WhatsApp del cliente no lleva las opciones', IDX, '${l.p.name}${OT.parentesis(l.opciones)} - ', '${l.p.name} - ');
m('front', 'mensaje: el WhatsApp del pedido pagado no lleva las opciones', IDX, '${OT.parentesis(it.opciones)} \u2014', ' \u2014');
m('front', 'aviso de abierto: queda el doble punto ("p.m..")', IDX, '    if(cierreTexto.endsWith(".")) textoAbierto = textoAbierto.split(cierreTexto + ".").join(cierreTexto);\n', '');
m('front', 'aviso de abierto: siempre se quita el punto de la plantilla', IDX, 'if(cierreTexto.endsWith(".")) textoAbierto', 'if(cierreTexto) textoAbierto');
m('front', 'S1: la confirmacion pega las opciones como HTML', IDX, '<small class="line-opc">${esc(detalle)}</small>', '<small class="line-opc">${detalle}</small>');
m('front', 'S1: el carrito pinta las opciones con innerHTML', IDX, 'op.textContent = detalle + (linea.faltan.length', 'op.innerHTML = detalle + (linea.faltan.length');
m('front', 'S1: el modal pinta el nombre de la opcion con innerHTML', IDX, 'nombre.textContent = o.nombre;', 'nombre.innerHTML = o.nombre;');
m('front', 'S1: el seguimiento pega las opciones como HTML', PED, "'<small class=\"it-opc\">' + escapar(opcionesTexto) + '</small>'", "'<small class=\"it-opc\">' + opcionesTexto + '</small>'");
m('front', 'seguimiento: las opciones no se muestran', PED, "(opcionesTexto ? '<small class=\"it-opc\">'", "(false ? '<small class=\"it-opc\">'");

// =====================================================================================================================
//   panel.html, historial.html, menu-admin.html  (panel, escenarios 16 y 17)
// =====================================================================================================================
m('panel', 'panel: las opciones se pegan como HTML en el tablero', PAN, "'<small class=\"it-opc\">' + escapar(texto) + '</small>'", "'<small class=\"it-opc\">' + texto + '</small>'");
m('panel', 'panel: el tablero no muestra las opciones', PAN, "escapar(it.nombre) + opcionesDeItem(it) + '</span>'", "escapar(it.nombre) + '</span>'");
m('panel', 'panel: el ticket de texto no lleva las opciones', PAN, 'if(opc) lineas.push("      " + opc);', '');
m('panel', 'historial: las opciones se pegan como HTML', HIS, "'<small class=\"it-opc\">' + escapar(opc) + '</small>'", "'<small class=\"it-opc\">' + opc + '</small>'");
m('panel', 'historial: no muestra las opciones', HIS, "(opc ? '<small class=\"it-opc\">'", "(false ? '<small class=\"it-opc\">'");
m('panel', 'menu-admin: el nombre no se valida en el formulario (la base es la unica barrera)', MEN, 'if(motivo) return falla(motivo, "oNombre");', '');
m('panel', 'menu-admin: se aceptan nombres repetidos', MEN, 'if(repetida) return falla(', 'if(false) return falla(');
m('panel', 'menu-admin: no se avisa del tope de 12 antes de enviar (decide solo la base)', MEN, 'if(!op.editando && op.lista.length >= OPC_MAX){', 'if(false){');
m('panel', 'menu-admin: un extra puede costar $0', MEN, 'if(!Number.isInteger(precio) || precio < 1 || precio > OPC_PRECIO_MAX){', 'if(!Number.isInteger(precio) || precio < 0 || precio > OPC_PRECIO_MAX){');
m('panel', 'menu-admin: un extra puede costar mas de $50.000', MEN, 'precio < 1 || precio > OPC_PRECIO_MAX', 'precio < 1 || precio > 99999999');
m('panel', 'menu-admin: el precio acepta decimales o comas (se vuelve otro numero)', MEN, 'if(!/^\\d+$/.test(texto.replace(/\\./g, "")) || (texto.includes(".") && !/^\\d{1,3}(\\.\\d{3})+$/.test(texto))){', 'if(false){');
m('panel', 'menu-admin: el nombre de la lista se pinta con innerHTML', MEN, 'nombre.textContent = o.nombre;', 'nombre.innerHTML = o.nombre;');
m('panel', 'menu-admin: los rechazos de la base ya no se dicen en espanol (mensaje generico)', MEN, 'if(msg && !esCheckSuelto) return msg;', '');
m('panel', 'menu-admin: editar no cambia el precio de un extra', MEN, 'if(o.tipo === "extra") cambios.precio = datos.precio;', '');
m('panel', 'menu-admin: subir/bajar no reasigna el orden', MEN, 'const fila = await escribirOpcion(grupo[k].id, { orden: base + k });', 'const fila = grupo[k];');
m('panel', 'menu-admin: las escrituras no llevan el restaurante (escribirOpcion)', MEN, '.eq("restaurante_id", RID).eq("producto_id", op.pid).eq("id", id).select();', '.eq("producto_id", op.pid).eq("id", id).select();');
m('panel', 'menu-admin: eliminar no lleva el restaurante', MEN, '.eq("restaurante_id", RID).eq("producto_id", op.pid).eq("id", o.id).select("id");', '.eq("producto_id", op.pid).eq("id", o.id).select("id");');
m('panel', 'menu-admin: el alta no lleva el restaurante del dominio (usa otro)', MEN, '.insert({ restaurante_id: RID, producto_id: op.pid,', '.insert({ restaurante_id: "00000000-0000-4000-8000-000000000001", producto_id: op.pid,');
m('panel', 'menu-admin: la lista se lee de todos los restaurantes', MEN, '.eq("restaurante_id", RID).eq("producto_id", mio.pid).order("orden")', '.eq("producto_id", mio.pid).order("orden")');
m('panel', 'menu-admin: un "quitar" se guarda con el precio del formulario', MEN, 'precio: datos.tipo === "extra" ? datos.precio : 0, orden, activa: true', 'precio: datos.precio, orden, activa: true');

/* ---- ejecucion --------------------------------------------------------------------------------------------------------------------------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'taq-mut-opc-'));
const leer = (f) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\r\n/g, '\n');

function copiarRaiz(destino) {
  for (const f of fs.readdirSync(REPO, { withFileTypes: true })) {
    if (f.isFile()) fs.copyFileSync(path.join(REPO, f.name), path.join(destino, f.name));
  }
}
function copiarCarpeta(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const f of fs.readdirSync(origen, { withFileTypes: true })) {
    if (f.isDirectory()) copiarCarpeta(path.join(origen, f.name), path.join(destino, f.name));
    else fs.copyFileSync(path.join(origen, f.name), path.join(destino, f.name));
  }
}

function armar(mu) {
  const dir = fs.mkdtempSync(path.join(tmp, 'm-'));
  copiarRaiz(dir);
  if (mu.via === 'unit') {
    copiarCarpeta(path.join(REPO, 'api'), path.join(dir, 'api'));
    fs.mkdirSync(path.join(dir, 'pruebas'), { recursive: true });
    for (const t of ['opciones-texto.test.js', 'crear-pedido-limpiar.test.js', 'ticket-comanda.test.js']) fs.copyFileSync(path.join(REPO, 'pruebas', t), path.join(dir, 'pruebas', t));
  }
  const aplicar = (archivo, buscar, reemplazar) => {
    const ruta = path.join(dir, archivo);
    const crlf = /\r\n/.test(fs.readFileSync(ruta, 'utf8'));
    const t = fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
    const n = t.split(buscar).length - 1;
    if (n !== 1) throw new Error(`mutacion mal definida: "${buscar.slice(0, 80)}" aparece ${n} veces en ${archivo}`);
    const nuevo = t.split(buscar).join(reemplazar);
    fs.writeFileSync(ruta, crlf ? nuevo.replace(/\n/g, '\r\n') : nuevo);
  };
  aplicar(mu.archivo, mu.buscar, mu.reemplazar);
  if (mu.tambien) aplicar(...mu.tambien);
  return dir;
}

function correr(mu, dir, i) {
  const off = i % PARALELO;
  const env = { ...process.env };
  let args, extra = {};
  if (mu.via === 'unit') {
    args = ['--test', 'pruebas/opciones-texto.test.js', 'pruebas/crear-pedido-limpiar.test.js', 'pruebas/ticket-comanda.test.js'];
    return lanzar(args, dir, env);
  }
  if (mu.via === 'front') {
    extra = { FRONT_RAIZ: dir, SOLO: '^11\\.', PUERTO_WEB: String(8200 + off * 10), PUERTO_ANTIGUO: String(8201 + off * 10), PUERTO_SIN_TEMA: String(8202 + off * 10), PUERTO_CDP: String(9440 + off), PUERTO_FALSO: String(54460 + off) };
    return lanzar([path.join(REPO, 'pruebas', 'multirestaurante', 'front.mjs')], REPO, { ...env, ...extra });
  }
  extra = { PANEL_RAIZ: dir, SOLO: '^1[67]\\.', PUERTO_WEB: String(8300 + off), PUERTO_CDP: String(9450 + off), PUERTO_FALSO: String(54470 + off) };
  return lanzar([path.join(REPO, 'pruebas', 'multirestaurante', 'panel.mjs')], REPO, { ...env, ...extra });
}
function lanzar(args, cwd, env) {
  return new Promise((ok) => {
    const h = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; }); h.stderr.on('data', (d) => { salida += d; });
    const t = setTimeout(() => { try { h.kill(); } catch (e) { /* ya cerro */ } }, 900000);
    h.on('exit', (codigo) => { clearTimeout(t); ok({ codigo, salida }); });
  });
}

const resumen = { detectadas: 0, equivalentes: [], sobreviven: [], errores: [] };
const lista = M.filter((mu) => !filtro || mu.nombre.includes(filtro));

if (arg('validar')) {
  // Solo comprueba que cada mutacion este bien definida (el texto a cambiar aparece UNA vez); no corre pruebas
  let malas = 0;
  for (const mu of lista) { try { fs.rmSync(armar(mu), { recursive: true, force: true }); } catch (e) { malas++; console.log(`  ERROR  [${mu.via}] ${mu.nombre}\n         ${e.message}`); } }
  console.log(`${lista.length - malas} bien definidas, ${malas} con error.`);
  process.exit(malas ? 1 : 0);
}
console.log(`Mutaciones: ${lista.length} (unit ${lista.filter((x) => x.via === 'unit').length}, front ${lista.filter((x) => x.via === 'front').length}, panel ${lista.filter((x) => x.via === 'panel').length}). En paralelo: ${PARALELO}.`);
console.log('Linea base: lo que esta en el repositorio debe pasar todo antes de empezar...');
const bases = [];
for (const via of ['unit', 'front', 'panel']) {
  if (!lista.some((x) => x.via === via)) continue;
  const mu = { via, archivo: via === 'unit' ? OT : via === 'front' ? IDX : PAN, buscar: via === 'unit' ? 'var MAX_OPCIONES = 12;' : via === 'front' ? '<title>' : '<title>', reemplazar: via === 'unit' ? 'var MAX_OPCIONES = 12;' : '<title>' };
  const dir = armar(mu);
  const r = await correr(mu, dir, 0);
  bases.push([via, r]);
  if (r.codigo !== 0) {
    console.log(r.salida.split('\n').filter((l) => /FALLA|ERROR|not ok|✖/.test(l)).slice(0, 8).join('\n'));
    console.log(`La linea base (${via}) falla: no se puede hacer la revision por mutacion.`);
    process.exit(2);
  }
  console.log(`  linea base ${via} OK`);
}
console.log('');

let siguiente = 0;
async function trabajador(w) {
  while (true) {
    const i = siguiente++;
    if (i >= lista.length) return;
    const mu = lista[i];
    let dir;
    try { dir = armar(mu); } catch (e) { resumen.errores.push(`${mu.nombre}: ${e.message}`); console.log(`  ERROR       [${mu.via}] ${mu.nombre}\n              ${e.message}`); continue; }
    const r = await correr(mu, dir, w);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* en uso */ }
    const detectada = r.codigo !== 0;
    if (mu.equivalente) {
      if (detectada) { resumen.detectadas++; console.log(`  DETECTADA   [${mu.via}] ${mu.nombre}  (declarada equivalente, pero SI se detecta: quitar de las equivalentes)`); }
      else { resumen.equivalentes.push(`[${mu.via}] ${mu.nombre} -> ${mu.equivalente}`); console.log(`  EQUIVALENTE [${mu.via}] ${mu.nombre}`); }
    } else if (detectada) { resumen.detectadas++; console.log(`  DETECTADA   [${mu.via}] ${mu.nombre}`); }
    else { resumen.sobreviven.push(`[${mu.via}] ${mu.nombre}`); console.log(`  SOBREVIVE   [${mu.via}] ${mu.nombre}`); }
  }
}
await Promise.all(Array.from({ length: PARALELO }, (_, w) => trabajador(w)));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* en uso */ }
console.log('\n=============================================================');
console.log(`TOTAL: ${lista.length}   DETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes.length}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
if (resumen.sobreviven.length) { console.log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((s) => console.log('  - ' + s)); }
if (resumen.equivalentes.length) { console.log('\nEQUIVALENTES:'); resumen.equivalentes.forEach((s) => console.log('  - ' + s)); }
if (resumen.errores.length) { console.log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((s) => console.log('  - ' + s)); }
process.exitCode = resumen.sobreviven.length || resumen.errores.length ? 1 : 0;
