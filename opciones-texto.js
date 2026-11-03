/* =============================================================
   OPCIONES DE PRODUCTO: TEXTO Y CLAVES (una sola copia para el navegador)

   Lo cargan index.html, pedido.html, panel.html, historial.html y menu-admin.html, y lo usa
   ticket-comanda.js. Se carga como script comun (window.OpcionesTexto) y con require() en Node.
   api/_notificar.js tiene su propia copia de las pocas funciones que necesita (el servidor no
   puede cargar archivos de la raiz sin riesgo en Vercel); una prueba compara las dos.

   Por que existe: el nombre de una opcion ("Sin queso", "Queso extra") lo escribe el DUENO y llega a
   muchos sitios (menu, carrito, WhatsApp, seguimiento, panel, historial, ticket impreso). Y la copia
   que guarda cada pedido (pedidos.items) NO es de fiar (docs 22.17, H10). Reglas de salida:
     S1  siempre texto, nunca HTML (este archivo no arma HTML: devuelve texto)
     S2  una sola linea: saltos y separadores (CR, LF, U+2028, U+2029) pasan a ser espacio
     S3  se quitan los invisibles (ancho cero, bidi, controles, guion suave, rellenos, etiquetas...)
     S4  el largo se corta por CARACTERES (Array.from), nunca por unidades UTF-16
     S5  para WhatsApp / CallMeBot: sin "$" (CallMeBot lo corrompe) ni "*", "_", "~" ni comilla
         invertida (son formato de WhatsApp), y como maximo 6 etiquetas por linea con "+N mas"
============================================================= */
(function (raiz, fabrica) {
  var api = fabrica();
  if (typeof module === "object" && module.exports) module.exports = api;
  else raiz.OpcionesTexto = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* Todo lo que no debe llegar a un texto: controles C0 y C1, guion suave (U+00AD), marca bidi arabe
     (U+061C), rellenos de Hangul (U+115F-1160, U+3164, U+FFA0), U+180E, ancho cero y marcas de
     direccion (U+200B-200F), separadores de linea y parrafo (U+2028-2029), controles bidi
     (U+202A-202E, U+2066-2069), U+2060-206F, BOM (U+FEFF), anotaciones (U+FFF9-FFFB) y etiquetas
     (U+E0000-E007F). Se arma desde numeros para que ningun editor deje caracteres invisibles
     escritos en este archivo. */
  var RANGOS_INVISIBLES = [
    [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c], [0x115f, 0x1160],
    [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164],
    [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe007f]
  ];
  var INVISIBLES = (function () {
    var barra = String.fromCharCode(92);
    var u = function (n) { return barra + "u{" + n.toString(16) + "}"; };
    return new RegExp("[" + RANGOS_INVISIBLES.map(function (r) { return u(r[0]) + "-" + u(r[1]); }).join("") + "]", "gu");
  })();

  /* Los que WhatsApp interpreta como formato, y el "$" que CallMeBot se come junto con el digito siguiente. */
  var DE_MENSAJE = /[$*_~`]/g;

  var MAX_NOMBRE = 40;       // igual que la base (char_length <= 40)
  var MAX_OPCIONES = 12;     // tope por producto
  var MAX_ETIQUETAS = 6;     // por linea de mensaje (S5)
  var ID_OPCION = /^[a-z0-9][a-z0-9-]{0,59}$/;

  /* S2 + S3 + S4: texto de una linea, sin invisibles, cortado por caracteres. */
  function limpiar(valor, maximo) {
    var t = String(valor == null ? "" : valor).replace(INVISIBLES, " ").replace(/\s+/g, " ").trim();
    var tope = maximo === undefined ? MAX_NOMBRE : maximo;
    return Array.from(t).slice(0, tope).join("").trim();
  }

  /* S5: ademas, sin los caracteres que rompen WhatsApp o CallMeBot. */
  function paraMensaje(valor, maximo) {
    return limpiar(String(valor == null ? "" : valor).replace(DE_MENSAJE, ""), maximo);
  }

  /* "Sin queso" -> "queso" (para el ticket: "SIN: queso, salsa rosa"). Si no empieza por "sin " se deja igual. */
  function sinPrefijoSin(nombre) {
    var m = /^sin\s+(.+)$/i.exec(nombre);
    return m ? m[1] : nombre;
  }

  /* Las opciones de un item (la copia de pedidos.items, o las del menu) en dos listas ya limpias.
     Lo que no sea un objeto con tipo 'quitar'/'extra' y nombre se ignora; un quitar nunca cuesta. */
  function partes(opciones, modo) {
    var limpio = modo === "mensaje" ? paraMensaje : limpiar;
    var quitar = [], extras = [];
    var lista = Array.isArray(opciones) ? opciones.slice(0, MAX_OPCIONES) : [];
    lista.forEach(function (o) {
      if (!o || typeof o !== "object") return;
      var nombre = limpio(o.nombre, MAX_NOMBRE);
      if (!nombre) return;
      if (o.tipo === "quitar") quitar.push({ nombre: nombre, ingrediente: limpio(sinPrefijoSin(nombre), MAX_NOMBRE) || nombre });
      else if (o.tipo === "extra") {
        var p = o.precio;
        extras.push({ nombre: nombre, precio: (typeof p === "number" && Number.isInteger(p) && p > 0) ? p : 0 });
      }
    });
    return { quitar: quitar, extras: extras };
  }

  /* Etiquetas en orden: primero lo que se quita (tal como lo escribio el dueno: "Sin queso") y luego los
     extras con "+ " ("+ Tocineta extra"). Con opts.max se corta y la ultima etiqueta dice "+N mas". */
  function etiquetas(opciones, opts) {
    var o = opts || {};
    var p = partes(opciones, o.mensaje ? "mensaje" : "normal");
    var todas = p.quitar.map(function (q) { return q.nombre; })
      .concat(p.extras.map(function (e) { return "+ " + e.nombre; }));
    var max = o.max === undefined ? 0 : o.max;
    if (max > 0 && todas.length > max) {
      var resto = todas.length - max;
      todas = todas.slice(0, max);
      todas.push("+" + resto + " más");
    }
    return todas;
  }

  /* "Sin queso · + Tocineta extra" (cualquier separador). "" si no hay opciones. */
  function resumen(opciones, opts) {
    var o = opts || {};
    return etiquetas(opciones, o).join(o.separador === undefined ? " · " : o.separador);
  }

  /* Para los mensajes (WhatsApp del cliente y del restaurante): " (Sin queso, + Tocineta extra)" o "". */
  function parentesis(opciones) {
    var t = resumen(opciones, { mensaje: true, max: MAX_ETIQUETAS, separador: ", " });
    return t ? " (" + t + ")" : "";
  }

  /* ---- Claves de las lineas del carrito (C1) ----
     Una linea es producto + conjunto de opciones: "nb-big-norte" (sin opciones, igual que el carrito de antes)
     o "nb-big-norte|extra-queso,sin-cebolla" (ids ORDENADOS: el mismo conjunto da siempre la misma clave). */
  function claveLinea(productoId, ids) {
    var lista = Array.isArray(ids) ? ids.filter(function (x) { return typeof x === "string" && x; }) : [];
    var unicos = Array.from(new Set(lista)).sort();
    return unicos.length ? String(productoId) + "|" + unicos.join(",") : String(productoId);
  }

  /* El camino contrario. 'esProducto' (opcional) dice si un texto es un id de producto conocido: si la clave
     entera lo es, es una linea sin opciones (aunque el id tuviera una barra). Devuelve null si la clave no sirve. */
  function leerClave(clave, esProducto) {
    if (typeof clave !== "string" || !clave) return null;
    if (clave.length > 60 + 1 + MAX_OPCIONES * 61) return null;
    if (typeof esProducto === "function" && esProducto(clave)) return { id: clave, ids: [] };
    var i = clave.lastIndexOf("|");
    if (i < 0) return { id: clave, ids: [] };
    var id = clave.slice(0, i);
    var ids = clave.slice(i + 1).split(",");
    if (!id || ids.length > MAX_OPCIONES || !ids.every(function (x) { return ID_OPCION.test(x); })) return null;
    if (new Set(ids).size !== ids.length) return null;
    return { id: id, ids: ids };
  }

  /* Validacion del NOMBRE que escribe el dueno en menu-admin (S6), IGUAL O MAS ESTRICTA que la base
     (opcion_nombre_valido) y que lo que imprime la termica. Devuelve null si esta bien, o el motivo en espanol. */
  var EMOJIS_Y_SIMBOLOS = (function () {
    var barra = String.fromCharCode(92);
    var u = function (n) { return barra + "u{" + n.toString(16) + "}"; };
    var r = [[0x1f000, 0x1faff], [0x2190, 0x21ff], [0x2300, 0x23ff], [0x2460, 0x27bf], [0x2900, 0x297f],
             [0x2b00, 0x2bff], [0xfe00, 0xfe0f], [0x20e3, 0x20e3], [0x00a9, 0x00a9], [0x00ae, 0x00ae]];
    return new RegExp("[" + r.map(function (x) { return u(x[0]) + "-" + u(x[1]); }).join("") + "]", "u");
  })();

  function motivoNombreInvalido(texto) {
    var t = String(texto == null ? "" : texto);
    if (!t.trim()) return "Escribe el nombre de la opción.";
    if (Array.from(t.trim()).length > MAX_NOMBRE) return "El nombre no puede pasar de " + MAX_NOMBRE + " caracteres.";
    if (/[<>]/.test(t)) return "El nombre no puede llevar los signos < ni >.";
    if (EMOJIS_Y_SIMBOLOS.test(t)) {
      return "El nombre no puede llevar emojis ni símbolos: la impresora de la cocina no los imprime y la opción saldría mal en el papel.";
    }
    if (new RegExp(INVISIBLES.source, "u").test(t)) return "El nombre tiene caracteres invisibles o raros. Escríbelo de nuevo a mano.";
    // El espacio duro (U+00A0) y los demas espacios raros no son invisibles para la base, pero un nombre hecho solo de ellos queda vacio
    if (limpiar(t, 1000) === "") return "Escribe el nombre de la opción con letras.";
    return null;
  }

  return {
    MAX_NOMBRE: MAX_NOMBRE, MAX_OPCIONES: MAX_OPCIONES, MAX_ETIQUETAS: MAX_ETIQUETAS, ID_OPCION: ID_OPCION,
    limpiar: limpiar, paraMensaje: paraMensaje, sinPrefijoSin: sinPrefijoSin,
    partes: partes, etiquetas: etiquetas, resumen: resumen, parentesis: parentesis,
    claveLinea: claveLinea, leerClave: leerClave, motivoNombreInvalido: motivoNombreInvalido
  };
});
