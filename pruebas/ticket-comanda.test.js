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

/* ---------- Tamano del texto y margenes de pagina ---------- */

/* Guarda el localStorage del entorno (en Node 24 no existe) y pone uno
   falso solo mientras corre 'fn'. */
function conAlmacen(almacen, fn) {
  const previo = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: almacen });
  try { return fn(); }
  finally {
    if (previo) Object.defineProperty(globalThis, "localStorage", previo);
    else delete globalThis.localStorage;
  }
}
function almacenFalso(inicial) {
  const d = Object.assign({}, inicial);
  return {
    getItem: (k) => (k in d ? d[k] : null),
    setItem: (k, v) => { d[k] = String(v); },
    datos: d
  };
}

test("las tres escalas: Pequeno .75, Normal .85, Grande 1; el defecto es Normal", () => {
  assert.deepEqual(T.ESCALAS, { pequeno: 0.75, normal: 0.85, grande: 1 });
  assert.equal(T.TAMANO_POR_DEFECTO, "normal");
});

test("sin nada guardado, el tamano es Normal", () => {
  conAlmacen(almacenFalso(), () => assert.equal(T.leerTamano(), "normal"));
});

test("guardar y leer el tamano; un valor invalido no se guarda ni se lee", () => {
  const a = almacenFalso();
  conAlmacen(a, () => {
    assert.equal(T.guardarTamano("grande"), true);
    assert.equal(a.datos[T.TAMANO_KEY], "grande");
    assert.equal(T.leerTamano(), "grande");
    assert.equal(T.guardarTamano("enorme"), false);
    assert.equal(T.guardarTamano("__proto__"), false);
    assert.equal(T.leerTamano(), "grande");
  });
  conAlmacen(almacenFalso({ [T.TAMANO_KEY]: "constructor" }), () => {
    assert.equal(T.leerTamano(), "normal");
  });
});

test("si el almacenamiento falla, el tamano es Normal y guardar devuelve false", () => {
  const roto = { getItem() { throw new Error("bloqueado"); }, setItem() { throw new Error("bloqueado"); } };
  conAlmacen(roto, () => {
    assert.equal(T.leerTamano(), "normal");
    assert.equal(T.guardarTamano("pequeno"), false);
  });
});

test("toda fuente del ticket sale de la escala (--escala) y 'Grande' conserva el diseno original", () => {
  const fuentes = T.ESTILOS.match(/font-size:[^;]+;/g);
  assert.ok(fuentes.length >= 15, "se esperaban todas las fuentes del ticket");
  fuentes.forEach(f => assert.match(f, /calc\([\d.]+px \* var\(--escala\)\)/, "fuente sin escalar: " + f));
  // Con --escala = 1 salen los tamanos originales (numero 46, cantidad 28, producto 18)
  assert.match(T.ESTILOS, /\.numero\{[^}]*calc\(46px \* var\(--escala\)\)/);
  assert.match(T.ESTILOS, /\.cant\{[^}]*calc\(28px \* var\(--escala\)\)/);
  assert.match(T.ESTILOS, /\.nom\{[^}]*calc\(18px \* var\(--escala\)\)/);
  assert.match(T.ESTILOS, /:root\{--escala:0\.85;\}/);
});

test("la hoja va sin margen de pagina (sin encabezado ni pie de Chrome) y a 80 mm", () => {
  assert.match(T.PLANTILLA, /@page\{size:80mm \d+mm;margin:0;\}/);
  assert.equal(T.ANCHO_PAGINA_MM, 80);
  assert.equal(T.ANCHO_UTIL_MM, 72);
});

test("el aire del ticket es del contenido: arriba 3 mm y abajo la constante", () => {
  assert.equal(T.MARGEN_SUPERIOR_MM, 3);
  assert.ok(T.MARGEN_INFERIOR_MM > 0 && T.MARGEN_INFERIOR_MM <= 12);
  const re = new RegExp("body\\{width:72mm;margin:0 auto;\\s*padding:3mm 0 " + T.MARGEN_INFERIOR_MM + "mm;");
  assert.match(T.ESTILOS, re);
});

test("con domicilio cobrado separa productos y envio", () => {
  const d = T.preparar({ ...base, costo_domicilio: 5000, subtotal: 18000, total: 23000 });
  assert.equal(d.subtotal, 18000);
  assert.equal(d.costoDomicilio, 5000);
  assert.equal(d.total, 23000);
});
