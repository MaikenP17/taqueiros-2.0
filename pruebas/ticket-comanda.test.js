/* =============================================================
   PRUEBAS DEL TICKET DE COMANDA (sin navegador, sin red)

   Cubre la parte pura de ticket-comanda.js: limpieza del texto y
   datos del ticket. El dibujo y la impresion real se prueban en el
   navegador: ver pruebas/impresion/e2e.js

   USO:   node --test pruebas/ticket-comanda.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../ticket-comanda.js");

test("quita emojis y simbolos que una termica no imprime", () => {
  assert.equal(T.limpiarTexto("Taco 🌮 picante 🔥 ✅ ⚠️"), "Taco picante");
  assert.equal(T.limpiarTexto("a\u200Bb\u202Ec\uFEFF"), "abc");
});

test("conserva ñ, tildes, signos de apertura y comillas", () => {
  const t = "¿Cuánto demora, señor Núñez? Piña \"grande\" 'ya' — ¡súper!";
  assert.equal(T.limpiarTexto(t), t);
});

test("el texto con etiquetas HTML pasa como texto literal", () => {
  const t = "<img src=x onerror=alert(1)> & </div>";
  assert.equal(T.limpiarTexto(t), t);
});

test("colapsa espacios y quita caracteres de control en una sola linea", () => {
  assert.equal(T.limpiarTexto("  Juan \t\n  Pérez\u0007  "), "Juan Pérez");
});

test("con saltos:true conserva las lineas y colapsa las vacias de mas", () => {
  assert.equal(T.limpiarTexto("uno  \r\n\r\n\r\n\r\ndos", { saltos: true }), "uno\n\ndos");
});

test("null y undefined dan cadena vacia", () => {
  assert.equal(T.limpiarTexto(null), "");
  assert.equal(T.limpiarTexto(undefined), "");
});

const base = {
  id: 7, tipo_pedido: "domicilio", cliente_nombre: "Ana", cliente_telefono: "3001234567",
  direccion: "Calle 1", barrio: "Centro", indicaciones: "sin cebolla",
  items: [{ nombre: "Taco 🌮", cantidad: 2, precio: 9000 }],
  subtotal: 18000, costo_domicilio: 0, total: 18000, wompi_metodo_pago: "NEQUI",
  pagado_en: "2026-10-11T23:30:00Z"
};

test("la franja se adapta al tipo de pedido (con espacios duros)", () => {
  const plano = (p) => T.preparar(p).franja.replace(/\u00A0/g, " ");
  assert.equal(plano(base), "DOMICILIO · WEB · PAGADO");
  assert.equal(plano({ ...base, tipo_pedido: "llevar" }), "PARA LLEVAR · WEB · PAGADO");
  assert.equal(plano({ ...base, tipo_pedido: "local" }), "EN EL LOCAL · WEB · PAGADO");
});

test("numero con ceros, telefono con espacios, hora de Colombia", () => {
  const d = T.preparar(base);
  assert.equal(d.numero, "#007");
  assert.equal(d.telefono, "300 123 4567");
  assert.match(d.fecha, /6:30 p\. m\./);   // 23:30 UTC = 6:30 p. m. en Bogota
});

test("la cantidad nunca es negativa ni decimal, y el nombre se limpia", () => {
  const d = T.preparar({ ...base, items: [{ nombre: "Taco 🌮", cantidad: -3 }, { nombre: "X", cantidad: 2.9 }] });
  assert.deepEqual(d.items.map(i => i.cantidad), [0, 2]);
  assert.equal(d.items[0].nombre, "Taco");
});

test("reimpresion y prueba llevan su marca; el pedido normal, ninguna", () => {
  assert.equal(T.preparar(base).marca, "");
  assert.equal(T.preparar(base, { reimpresion: true, numeroReimpresion: 2 }).marca, "REIMPRESIÓN");
  assert.equal(T.preparar(base, { prueba: true }).marca, "TICKET DE PRUEBA");
});

test("metodo de pago conocido en espanol, desconocido tal cual, vacio generico", () => {
  assert.equal(T.preparar({ ...base, wompi_metodo_pago: "CARD" }).metodoPago, "Tarjeta");
  assert.equal(T.preparar({ ...base, wompi_metodo_pago: "RARO" }).metodoPago, "RARO");
  assert.equal(T.preparar({ ...base, wompi_metodo_pago: null }).metodoPago, "Pago en línea");
});

test("con domicilio cobrado separa productos y envio", () => {
  const d = T.preparar({ ...base, costo_domicilio: 5000, subtotal: 18000, total: 23000 });
  assert.equal(d.subtotal, 18000);
  assert.equal(d.costoDomicilio, 5000);
  assert.equal(d.total, 23000);
});
