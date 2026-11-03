/* =============================================================
   H4 (docs 22.17): los datos del CLIENTE que recorta api/crear-pedido.js (limpiar) se cortaban por unidades UTF-16.
   Un emoji justo en el borde quedaba partido: media pareja suelta, y la base rechazaba el pedido con un 500.
   Ahora se cuenta por CARACTERES completos (igual que char_length en la base y que api/_precios.js).

   Esta prueba FALLA con el limpiar anterior (t.trim().slice(0, maximo)) y pasa con el de ahora.

   USO:   node --test pruebas/crear-pedido-limpiar.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const crearPedido = require("../api/crear-pedido.js");
const limpiar = crearPedido.limpiar;

const TACO = String.fromCodePoint(0x1f32e);
const SUELTO = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("limpiar se exporta para la prueba y el handler sigue siendo lo que exporta la funcion", () => {
  assert.equal(typeof crearPedido, "function");
  assert.equal(typeof limpiar, "function");
});

test("H4: un emoji justo en el borde no se parte (nombre de 120, direccion de 200, indicaciones de 400)", () => {
  for (const maximo of [120, 200, 400]) {
    const t = "a".repeat(maximo - 1) + TACO + "zz";
    const r = limpiar(t, maximo);
    assert.equal(r, "a".repeat(maximo - 1) + TACO, "mantiene el emoji entero (" + maximo + " caracteres)");
    assert.doesNotMatch(r, SUELTO, "sin media pareja suelta");
    assert.equal(Array.from(r).length, maximo);
  }
});

test("H4: con las indicaciones (que conservan saltos de linea) tambien", () => {
  const t = "linea uno\n" + "b".repeat(389) + TACO + TACO;
  const r = limpiar(t, 400, true);
  assert.doesNotMatch(r, SUELTO);
  assert.equal(Array.from(r).length, 400);
  assert.ok(r.startsWith("linea uno\n"));
});

test("H4: muchos emojis seguidos se cortan exactamente en el limite", () => {
  const r = limpiar(TACO.repeat(500), 120);
  assert.equal(Array.from(r).length, 120);
  assert.doesNotMatch(r, SUELTO);
});

test("lo de siempre no cambia: sin emojis recorta igual, quita invisibles y saltos, y conserva lo corto", () => {
  assert.equal(limpiar("  Juan   Perez  ", 120), "Juan   Perez");
  assert.equal(limpiar("a".repeat(150), 120), "a".repeat(120));
  assert.equal(limpiar("uno\ndos\ttres", 50), "uno dos tres", "sin saltos: un salto pasa a espacio");
  assert.equal(limpiar("uno\n\n\n\ndos", 50, true), "uno\n\ndos", "indicaciones: conserva saltos (maximo una linea vacia)");
  assert.equal(limpiar("a" + String.fromCharCode(0x202e, 0x200b) + "b", 50), "a  b");
  assert.equal(limpiar(null, 10), "");
  assert.equal(limpiar(undefined, 10), "");
  assert.equal(limpiar(12345, 3), "123");
});
