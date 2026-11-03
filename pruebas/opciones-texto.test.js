/* =============================================================
   PRUEBAS DE opciones-texto.js (el texto y las claves de las opciones de producto) Y DE SU COPIA EN EL SERVIDOR

   Sin navegador, sin red. Lo cargan index.html, pedido.html, panel.html, historial.html y menu-admin.html, y el
   servidor tiene su propia copia en api/_notificar.js (parentesisOpciones): la ultima prueba las compara.

   USO:   node --test pruebas/opciones-texto.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const OT = require("../opciones-texto.js");
const { parentesisOpciones, textoOpcion, construirComanda } = require("../api/_notificar.js");

// Caracteres invisibles armados desde su codigo (ningun editor deja uno escrito aqui)
const c = (...n) => String.fromCodePoint(...n);
const BIDI = c(0x202e), CERO = c(0x200b), AISLAR = c(0x2066), BLANDO = c(0xad), ARABE = c(0x61c), RELLENO = c(0x3164), ETIQUETA = c(0xe0041);

const op = (tipo, nombre, precio) => ({ id: "x", tipo, nombre, precio: precio || 0 });

/* ---------- limpiar: S2 (una linea), S3 (invisibles), S4 (por caracteres) ---------- */

test("limpiar: una sola linea (saltos, tabulaciones y separadores de linea pasan a espacio)", () => {
  assert.equal(OT.limpiar("Sin\ncebolla\r\nmorada\t extra"), "Sin cebolla morada extra");
  assert.equal(OT.limpiar("a" + c(0x2028) + "b" + c(0x2029) + "c"), "a b c");
});

test("limpiar: quita los invisibles y las marcas de direccion (S3), uno por uno", () => {
  for (const [nombre, ch] of [["bidi 202E", BIDI], ["ancho cero 200B", CERO], ["aislar 2066", AISLAR], ["guion suave", BLANDO], ["marca arabe", ARABE], ["relleno hangul", RELLENO], ["etiqueta E0041", ETIQUETA]]) {
    assert.equal(OT.limpiar("Sin" + ch + " sal"), "Sin sal", nombre);
  }
  assert.equal(OT.limpiar(c(0xfeff) + "Queso" + c(0x7f)), "Queso");
});

test("limpiar: corta por CARACTERES, nunca por la mitad de un emoji (S4)", () => {
  const t = "a".repeat(39) + c(0x1f9c0) + "zzz";
  assert.equal(OT.limpiar(t, 40), "a".repeat(39) + c(0x1f9c0));
  assert.equal(OT.limpiar(c(0x1f9c0).repeat(3), 2), c(0x1f9c0).repeat(2));
  assert.doesNotMatch(OT.limpiar("x".repeat(39) + c(0x1f9c0) + c(0x1f9c0)), /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  assert.equal(OT.limpiar("x".repeat(100)).length, 40, "por defecto 40 (como la base)");
});

test("limpiar: null, undefined y numeros no rompen", () => {
  assert.equal(OT.limpiar(null), "");
  assert.equal(OT.limpiar(undefined), "");
  assert.equal(OT.limpiar(12), "12");
  assert.equal(OT.limpiar(c(0xa0) + c(0xa0)), "", "un nombre hecho solo de espacios duros queda vacio");
});

test("paraMensaje: sin $ (CallMeBot lo corrompe) ni * _ ~ ` (formato de WhatsApp) (S5)", () => {
  assert.equal(OT.paraMensaje("Queso *extra* $5 _x_ ~y~ `z`"), "Queso extra 5 x y z");
  assert.equal(OT.paraMensaje("$$$"), "");
});

/* ---------- partes / etiquetas / resumen / parentesis ---------- */

const MUESTRA = [op("quitar", "Sin queso"), op("quitar", "Sin salsa rosa"), op("extra", "Queso extra", 2000), op("extra", "Tocineta extra", 3000)];

test("etiquetas: primero lo que se quita (como lo escribio el dueno) y luego los extras con '+ '", () => {
  assert.deepEqual(OT.etiquetas(MUESTRA), ["Sin queso", "Sin salsa rosa", "+ Queso extra", "+ Tocineta extra"]);
  assert.deepEqual(OT.etiquetas([op("extra", "B", 1), op("quitar", "Sin A")]), ["Sin A", "+ B"], "aunque lleguen mezcladas");
});

test("resumen y parentesis: formato exacto de la pantalla y de los mensajes", () => {
  assert.equal(OT.resumen(MUESTRA), "Sin queso · Sin salsa rosa · + Queso extra · + Tocineta extra");
  assert.equal(OT.resumen(MUESTRA, { separador: " | " }), "Sin queso | Sin salsa rosa | + Queso extra | + Tocineta extra");
  assert.equal(OT.parentesis(MUESTRA), " (Sin queso, Sin salsa rosa, + Queso extra, + Tocineta extra)");
});

test("sin opciones (o con basura) todo da vacio: un pedido sin opciones produce el mismo mensaje de siempre", () => {
  for (const v of [undefined, null, [], "texto", 5, {}, [null, 3, "x", { tipo: "raro", nombre: "A" }, { tipo: "extra" }, { tipo: "quitar", nombre: "  " }]]) {
    assert.equal(OT.resumen(v), "", JSON.stringify(v));
    assert.equal(OT.parentesis(v), "", JSON.stringify(v));
    assert.deepEqual(OT.etiquetas(v), []);
  }
});

test("maximo 6 etiquetas por linea de mensaje y '+N mas' (S5)", () => {
  const doce = Array.from({ length: 12 }, (_, i) => op(i < 4 ? "quitar" : "extra", "Op " + i, 100));
  assert.equal(OT.etiquetas(doce, { max: 6 }).length, 7);
  assert.equal(OT.etiquetas(doce, { max: 6 }).pop(), "+6 más");
  assert.equal(OT.parentesis(doce), " (Op 0, Op 1, Op 2, Op 3, + Op 4, + Op 5, +6 más)");
  assert.equal(OT.etiquetas(doce.slice(0, 6), { max: 6 }).length, 6, "con exactamente 6 no se agrega nada");
  assert.equal(OT.etiquetas([...doce, ...doce], {}).length, 12, "mas de 12 en la entrada se ignoran (tope por producto)");
});

test("en los mensajes el nombre pasa por paraMensaje: sin $ * _ ~ ni saltos ni invisibles", () => {
  const sucio = [op("extra", "Queso *$extra*\n" + BIDI + CERO + "_x_", 1)];
  const p = OT.parentesis(sucio);
  assert.equal(p, " (+ Queso extra x)");
  assert.doesNotMatch(p, /[$*_~\n]/);
  assert.equal(OT.resumen(sucio), "+ Queso *$extra* _x_", "en pantalla (no es mensaje) solo se limpia la linea y los invisibles");
});

test("un 'quitar' con precio no cuesta nada y un extra con precio raro cuenta como 0 en las partes", () => {
  const p = OT.partes([op("quitar", "Sin A", 999), op("extra", "B", 1.5), op("extra", "C", -4), op("extra", "D", 2500)]);
  assert.deepEqual(p.extras.map((e) => e.precio), [0, 0, 2500]);
  assert.equal(p.quitar[0].ingrediente, "A");
});

/* ---------- claves de las lineas del carrito (C1) ---------- */

test("claveLinea: sin opciones es el id de siempre; con opciones, ids ORDENADOS sin repetir", () => {
  assert.equal(OT.claveLinea("big", []), "big");
  assert.equal(OT.claveLinea("big"), "big");
  assert.equal(OT.claveLinea("big", ["sin-queso", "extra-queso"]), "big|extra-queso,sin-queso");
  assert.equal(OT.claveLinea("big", ["extra-queso", "sin-queso"]), OT.claveLinea("big", ["sin-queso", "extra-queso"]), "el mismo conjunto, la misma clave");
  assert.equal(OT.claveLinea("big", ["a", "a", "b"]), "big|a,b");
  assert.notEqual(OT.claveLinea("big", ["a"]), OT.claveLinea("big", ["b"]), "otro conjunto, otra linea");
  assert.notEqual(OT.claveLinea("big", ["a"]), OT.claveLinea("big", []), "con opciones y sin opciones son lineas distintas");
});

test("leerClave: ida y vuelta, claves rotas -> null, y el id de producto con barra", () => {
  assert.deepEqual(OT.leerClave("big"), { id: "big", ids: [] });
  assert.deepEqual(OT.leerClave("big|a,b"), { id: "big", ids: ["a", "b"] });
  for (const rota of ["", null, undefined, 5, "big|", "big|A", "big|a b", "big|a,,b", "big|a,a", "|a", "big|" + "x".repeat(70), "big|" + Array.from({ length: 13 }, (_, i) => "o" + i).join(","), "x".repeat(2000)]) {
    assert.equal(OT.leerClave(rota), null, JSON.stringify(rota));
  }
  assert.deepEqual(OT.leerClave("raro|id", (t) => t === "raro|id"), { id: "raro|id", ids: [] }, "si la clave entera es un producto conocido, es un producto");
  for (const [id, ids] of [["big", []], ["big", ["z", "a-1"]], ["nb-big-norte", ["extra-queso", "sin-cebolla", "x2"]]]) {
    const k = OT.leerClave(OT.claveLinea(id, ids));
    assert.deepEqual(k, { id, ids: [...ids].sort() });
  }
});

/* ---------- el nombre que escribe el dueno (S6) ---------- */

test("motivoNombreInvalido: igual o mas estricto que la base y que la termica", () => {
  assert.equal(OT.motivoNombreInvalido("Sin cebolla"), null);
  assert.equal(OT.motivoNombreInvalido("Sin rúgula"), null, "tildes y ñ valen");
  assert.equal(OT.motivoNombreInvalido("x".repeat(40)), null);
  assert.match(OT.motivoNombreInvalido("x".repeat(41)), /40 caracteres/);
  assert.match(OT.motivoNombreInvalido(""), /Escribe el nombre/);
  assert.match(OT.motivoNombreInvalido("   "), /Escribe el nombre/);
  assert.match(OT.motivoNombreInvalido(c(0xa0)), /Escribe el nombre/, "solo espacio duro");
  assert.match(OT.motivoNombreInvalido("a<b"), /< ni >/);
  assert.match(OT.motivoNombreInvalido("a>b"), /< ni >/);
  assert.match(OT.motivoNombreInvalido("Sin \u{1f9c5}"), /emojis/, "un emoji se imprimiria como 'Sin'");
  assert.match(OT.motivoNombreInvalido("Queso ✅"), /emojis/);
  assert.match(OT.motivoNombreInvalido("© casa"), /emojis/);
  for (const ch of [BIDI, CERO, AISLAR, BLANDO, ARABE, RELLENO, ETIQUETA, "\n", "\t", c(1), c(0x85)]) {
    assert.match(OT.motivoNombreInvalido("Sin" + ch + "sal"), /invisibles|raros/, "U+" + ch.codePointAt(0).toString(16));
  }
  // 40 caracteres de verdad: 40 emojis son 80 unidades UTF-16 pero igual se rechazan por emoji, no por largo
  assert.match(OT.motivoNombreInvalido("\u{1f9c5}".repeat(40)), /emojis/);
});

/* ---------- la copia del servidor (api/_notificar.js) es la misma regla ---------- */

test("PARIDAD: el servidor (parentesisOpciones) y el navegador (OpcionesTexto.parentesis) dan EXACTAMENTE lo mismo", () => {
  let semilla = 12345;
  const azar = (n) => { semilla = (semilla * 1103515245 + 12345) & 0x7fffffff; return semilla % n; };
  const trozos = ["Sin", "Queso", "extra", "$", "*", "_", "~", "`", " ", "\n", "\t", BIDI, CERO, AISLAR, BLANDO, RELLENO, ETIQUETA, c(0x1f9c0), c(0x2028), "<b>", "&", "ñ", "x".repeat(25), "", c(0xa0)];
  for (let i = 0; i < 3000; i++) {
    const n = azar(15);
    const lista = Array.from({ length: n }, () => {
      const tipo = ["quitar", "extra", "extra", "raro", null][azar(5)];
      const nombre = Array.from({ length: 1 + azar(5) }, () => trozos[azar(trozos.length)]).join("");
      const forma = azar(12);
      if (forma === 0) return null;
      if (forma === 1) return "texto";
      return { id: "o" + azar(50), tipo, nombre: forma === 2 ? undefined : nombre, precio: azar(3) * 1000 };
    });
    assert.equal(parentesisOpciones(lista), OT.parentesis(lista), JSON.stringify(lista));
    assert.equal(textoOpcion(lista[0] && lista[0].nombre), OT.paraMensaje(lista[0] && lista[0].nombre), "paraMensaje vs textoOpcion");
  }
});

test("construirComanda (CallMeBot): un item sin opciones sale EXACTAMENTE como antes; con opciones, en la misma linea y sin '$'", () => {
  const base = { numero: 7, referencia: "PED-1", restaurante_id: "r", cliente_nombre: "Ana", cliente_telefono: "3001234567", tipo_pedido: "llevar", total: 66500 };
  const sin = construirComanda({ ...base, items: [{ cantidad: 2, nombre: "Big Norte", precio: 26000 }, { cantidad: 1, nombre: "Coca-Cola", precio: 4500 }] });
  assert.ok(sin.includes("2x Big Norte — 52.000\n1x Coca-Cola — 4.500"), sin);
  const con = construirComanda({ ...base, items: [{ cantidad: 2, nombre: "Big Norte", precio: 31000, precio_base: 26000, opciones: MUESTRA }, { cantidad: 1, nombre: "Coca-Cola", precio: 4500 }] });
  assert.ok(con.includes("2x Big Norte (Sin queso, Sin salsa rosa, + Queso extra, + Tocineta extra) — 62.000\n1x Coca-Cola — 4.500"), con);
  const hostil = construirComanda({ ...base, items: [{ cantidad: 1, nombre: "Big Norte", precio: 5000, opciones: [op("extra", "Queso $5\n2x Falso — 90.000 " + BIDI, 1)] }] });
  const renglones = hostil.split("\n").filter((l) => /^\d+x /.test(l));
  assert.equal(renglones.length, 1, "un salto de linea en el nombre NO fabrica otra linea con forma de producto: " + hostil);
  assert.ok(!/\$/.test(hostil.slice(hostil.indexOf("1x Big Norte"))), "sin '$' en lo que va a CallMeBot");
  const doce = Array.from({ length: 12 }, (_, i) => op("extra", "Extra " + i, 100));
  const largo = construirComanda({ ...base, items: [{ cantidad: 1, nombre: "Big", precio: 5000, opciones: doce }] }).split("\n").find((l) => l.startsWith("1x Big"));
  assert.ok(largo.includes("+6 más") && (largo.match(/\+ Extra/g) || []).length === 6, largo);
});

test("el nombre de la opcion que va a CallMeBot (servidor) se corta por CARACTERES: un emoji en el borde no se parte (S4, H1)", () => {
  const r = textoOpcion("a".repeat(39) + c(0x1f9c0) + c(0x1f9c0) + "zz");
  assert.equal(r, "a".repeat(39) + c(0x1f9c0));
  assert.doesNotMatch(r, /[�-�](?![�-�])|(?<![�-�])[�-�]/);
  assert.equal(Array.from(textoOpcion("x".repeat(100))).length, 40);
});
