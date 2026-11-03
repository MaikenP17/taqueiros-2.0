/* =============================================================
   PRUEBAS DE LAS OPCIONES DE PRODUCTO EN EL SERVIDOR (sin red, sin base)

   Cubren lo que la bateria con base falsa NO puede provocar porque la base real lo impide (filas
   corruptas: un 'quitar' con precio, un extra negativo, un nombre solo de invisibles...). El servidor
   no debe fiarse de que la base tenga sus CHECK: aqui se le dan filas imposibles y debe rechazarlas.

     * api/_precios.js (validarItems, idsDeOpciones, nombreSaneado) con la lectura de la base SIMULADA.
     * api/_menu.js (leerOpcionesActivas, leerOpcionesParaCobrar, esTablaDeOpcionesAusente) con fetch simulado.

   USO:   node --test pruebas/opciones-precios.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const RID = "11111111-1111-4111-8111-111111111111";
const MENSAJE = "Alguna de las opciones elegidas no es válida o ya no está disponible. Actualiza la página e intenta de nuevo.";
const ch = (...codigos) => String.fromCharCode(...codigos);

/* ---------- validarItems con la lectura de la base simulada ---------- */

function cargarPrecios({ catalogo, opciones, falloOpciones }) {
  const llamadas = { catalogo: 0, opciones: [] };
  const rutaMenu = require.resolve(path.join(API, "_menu.js"));
  const rutaPrecios = require.resolve(path.join(API, "_precios.js"));
  const original = require.cache[rutaMenu];
  const stub = {
    id: rutaMenu, filename: rutaMenu, loaded: true,
    exports: {
      leerCatalogoParaCobrar: async () => { llamadas.catalogo++; return catalogo; },
      leerOpcionesParaCobrar: async (rid, ids) => {
        llamadas.opciones.push({ rid, ids: ids.slice() });
        if (falloOpciones) throw falloOpciones;
        const mapa = new Map();
        for (const f of opciones || []) {
          if (!ids.includes(f.producto_id)) continue;
          if (!mapa.has(f.producto_id)) mapa.set(f.producto_id, new Map());
          mapa.get(f.producto_id).set(f.id, f);
        }
        return mapa;
      },
      esTablaDeOpcionesAusente: (e) => !!e && e.status === 404
    }
  };
  require.cache[rutaMenu] = stub;
  delete require.cache[rutaPrecios];
  const precios = require(rutaPrecios);
  delete require.cache[rutaPrecios];
  if (original) require.cache[rutaMenu] = original; else delete require.cache[rutaMenu];
  return { precios, llamadas };
}

const producto = (nombre, precio, extra) => Object.assign({ nombre, precio, disponible: true, categoriaNombre: "Cat", categoriaActiva: true }, extra);
const catalogoBase = () => new Map([["taco", producto("Taco", 10000)], ["otro", producto("Otro", 7000)], ["agotado", producto("Agotado", 1000, { disponible: false })]]);
const fila = (producto_id, id, tipo, nombre, precio, orden = 0, activa = true) => ({ producto_id, id, tipo, nombre, precio, orden, activa });
const OPC = [
  fila("taco", "sin-cebolla", "quitar", "Sin cebolla", 0, 0),
  fila("taco", "extra-queso", "extra", "Queso extra", 2000, 10),
  fila("taco", "extra-tocineta", "extra", "Tocineta extra", 3000, 11),
  fila("otro", "extra-solo", "extra", "Solo del otro", 500, 0)
];

test("sin opciones: el item queda con las 4 claves de siempre y NUNCA se consulta la tabla de opciones", async () => {
  const { precios, llamadas } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 2, precio: 10000 }, { id: "otro", cantidad: 1, precio: 7000, opciones: [] }, { id: "otro", cantidad: 1, precio: 7000, opciones: null }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [
    { id: "taco", nombre: "Taco", cantidad: 2, precio: 10000 },
    { id: "otro", nombre: "Otro", cantidad: 1, precio: 7000 },
    { id: "otro", nombre: "Otro", cantidad: 1, precio: 7000 }
  ]);
  assert.equal(r.subtotal, 34000);
  assert.equal(llamadas.opciones.length, 0, "no debe leer producto_opciones");
});

test("con opciones: precio final = base + extras (los quitar no suman) y la copia trae precio_base y opciones saneadas", async () => {
  const { precios, llamadas } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 3, precio: 10000, opciones: ["extra-tocineta", "sin-cebolla", "extra-queso"] }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [{
    id: "taco", nombre: "Taco", cantidad: 3, precio: 15000, precio_base: 10000,
    opciones: [
      { id: "sin-cebolla", tipo: "quitar", nombre: "Sin cebolla", precio: 0 },
      { id: "extra-queso", tipo: "extra", nombre: "Queso extra", precio: 2000 },
      { id: "extra-tocineta", tipo: "extra", nombre: "Tocineta extra", precio: 3000 }
    ]
  }]);
  assert.equal(r.subtotal, 45000);
  assert.deepEqual(llamadas.opciones, [{ rid: RID, ids: ["taco"] }], "una sola lectura, solo del producto que lleva opciones");
});

test("solo se leen las opciones de productos que existen en el catalogo (un producto ajeno no genera consulta)", async () => {
  const { precios, llamadas } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const r = await precios.validarItems(RID, [{ id: "no-hay", cantidad: 1, precio: 1, opciones: ["extra-queso"] }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.desconocidos, ["no-hay"]);
  assert.equal(llamadas.opciones.length, 0);
});

test("la opcion de OTRO producto del mismo restaurante se rechaza con el mensaje generico (400)", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-solo"] }]);
  assert.deepEqual(r, { ok: false, codigo: 400, error: MENSAJE });
});

test("opciones apagadas o que no existen: 400 generico, sin decir cual", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC.concat([fila("taco", "extra-apagada", "extra", "Apagada", 100, 12, false)]) });
  for (const ids of [["extra-apagada"], ["no-existe"], ["extra-queso", "no-existe"]]) {
    const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ids }]);
    assert.deepEqual(r, { ok: false, codigo: 400, error: MENSAJE }, JSON.stringify(ids));
  }
});

test("FILAS IMPOSIBLES en la base (sin sus CHECK): el servidor igual las rechaza", async () => {
  const malas = [
    ["tipo desconocido", fila("taco", "x", "regalo", "Regalo", 0)],
    ["quitar con precio", fila("taco", "x", "quitar", "Sin algo", 500)],
    ["extra negativo", fila("taco", "x", "extra", "Negativo", -1000)],
    ["extra sobre el tope", fila("taco", "x", "extra", "Carisimo", 50001)],
    ["precio con decimales", fila("taco", "x", "extra", "Decimal", 100.5)],
    ["precio no numerico", fila("taco", "x", "extra", "Texto", "mucho")],
    ["precio nulo", fila("taco", "x", "extra", "Nulo", null)],
    ["nombre vacio", fila("taco", "x", "extra", "", 100)],
    ["nombre solo de invisibles", fila("taco", "x", "extra", ch(0x200b, 0x202e, 0xfeff, 7), 100)],
    ["nombre nulo", fila("taco", "x", "extra", null, 100)]
  ];
  for (const [nombre, f] of malas) {
    const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: [f] });
    const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["x"] }]);
    assert.deepEqual(r, { ok: false, codigo: 400, error: MENSAJE }, nombre);
  }
});

test("el nombre de la opcion se SANEA antes de guardarse (controles, ancho cero y bidi se vuelven espacio; maximo 40)", async () => {
  const sucio = "Sin" + ch(0x200b) + "cebolla" + ch(0x202e) + "  " + ch(10) + "morada";
  const largo = "x".repeat(60);
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: [fila("taco", "a", "quitar", sucio, 0, 0), fila("taco", "b", "extra", largo, 100, 1)] });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["a", "b"] }]);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].opciones[0].nombre, "Sin cebolla morada");
  assert.equal(r.items[0].opciones[1].nombre, "x".repeat(40));
  assert.equal(precios.nombreSaneado(null), "");
  assert.equal(precios.nombreSaneado(ch(0x2066) + "a" + ch(0x2069)), "a");
  // Cada rango del saneado, uno por uno (la base ya los rechaza; esto es la segunda capa)
  for (const c of [0x0007, 0x0085, 0x009f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x2064, 0x2066, 0x2069, 0xfeff]) {
    assert.equal(precios.nombreSaneado("a" + ch(c) + "b"), "a b", "U+" + c.toString(16));
  }
});

test("un nombre con emojis que la base acepta (hasta 40 caracteres) se guarda ENTERO: el recorte cuenta caracteres, no mitades de un emoji", async () => {
  const queso = String.fromCodePoint(0x1f9c0);
  const nombre = "Queso doble cheddar madurado extra " + queso.repeat(4);   // 39 caracteres, 43 unidades UTF-16
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: [fila("taco", "e", "extra", nombre, 1000, 0)] });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["e"] }]);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].opciones[0].nombre, nombre);
  // Una fila corrupta de mas de 40 se corta en 40 CARACTERES, sin dejar medio emoji (Postgres rechaza ese JSON y el pedido daba 500)
  const cortado = precios.nombreSaneado("x".repeat(39) + queso.repeat(3));
  assert.equal(cortado, "x".repeat(39) + queso);
  assert.doesNotMatch(JSON.stringify(r.items) + JSON.stringify(cortado), /\\ud[89a-f]/i);
});

test("el orden de la copia es el del menu (orden, luego id), no el que mando el cliente", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: [
    fila("taco", "zeta", "extra", "Z", 100, 5), fila("taco", "alfa", "extra", "A", 100, 5), fila("taco", "primero", "quitar", "P", 0, 1)
  ] });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["zeta", "alfa", "primero"] }]);
  assert.deepEqual(r.items[0].opciones.map((o) => o.id), ["primero", "alfa", "zeta"]);
});

test("idsDeOpciones: la forma del contrato", () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: [] });
  const ids = precios.idsDeOpciones;
  assert.deepEqual(ids({}), []);
  assert.deepEqual(ids({ opciones: undefined }), []);
  assert.deepEqual(ids({ opciones: null }), []);
  assert.deepEqual(ids({ opciones: [] }), []);
  assert.deepEqual(ids({ opciones: ["a", "b-1"] }), ["a", "b-1"]);
  assert.equal(ids(null) instanceof Array, true, "un item nulo no es un error de opciones (lo atrapa el producto desconocido)");
  assert.equal(precios.MAX_OPCIONES_POR_ITEM, 12);
  assert.equal(ids({ opciones: Array.from({ length: 12 }, (_, i) => "o" + i) }).length, 12);
  for (const mal of [
    "a", 5, true, {}, { a: 1 }, [1], [true], [null], [undefined], [[]], [{}], [{ id: "a" }], [""], [" "], ["A"], ["a b"], ["a_b"], ["-a"], ["a/b"],
    ["a\n"], ["a" + ch(0x200b)], ["a".repeat(61)], ["a", "a"], Array.from({ length: 13 }, (_, i) => "o" + i),
    false, 0, ""
  ]) {
    assert.equal(ids({ opciones: mal }), null, JSON.stringify(mal));
  }
});

test("opciones mal formadas se rechazan SIN tocar el catalogo ni la tabla de opciones", async () => {
  const { precios, llamadas } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: "extra-queso" }]);
  assert.deepEqual(r, { ok: false, codigo: 400, error: MENSAJE });
  assert.equal(llamadas.catalogo, 0);
  assert.equal(llamadas.opciones.length, 0);
});

test("precedencia: producto desconocido y agotado van antes que las opciones invalidas", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const a = await precios.validarItems(RID, [{ id: "agotado", cantidad: 1, precio: 1000, opciones: ["x"] }, { id: "taco", cantidad: 1, precio: 10000, opciones: ["no-existe"] }]);
  assert.equal(a.ok, false);
  assert.equal(a.codigo, undefined, "los agotados siguen siendo 409 (sin codigo propio)");
  assert.equal(a.agotados.length, 1);
  const b = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 9999, opciones: ["extra-queso"] }]);
  assert.equal(b.ok, false);
  assert.equal(b.codigo, undefined);
  assert.equal(b.preciosCambiados[0].precioNuevo, 10000, "el precio mostrado sigue siendo el BASE");
});

test("si la lectura de opciones falla: tabla ausente -> 400 claro; cualquier otro fallo -> 503; y un pedido sin opciones ni se entera", async () => {
  const ausente = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC, falloOpciones: Object.assign(new Error("x"), { status: 404, cuerpo: "PGRST205" }) });
  const a = await ausente.precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-queso"] }]);
  assert.equal(a.ok, false); assert.equal(a.codigo, 400);
  assert.match(a.error, /todavía no están disponibles/);
  const roto = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC, falloOpciones: Object.assign(new Error("boom"), { status: 500 }) });
  const b = await roto.precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-queso"] }]);
  assert.equal(b.ok, false); assert.equal(b.codigo, 503);
  const c = await roto.precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000 }]);
  assert.equal(c.ok, true);
});

test("el total no puede desbordar la columna integer de la base: se rechaza con 'Total invalido' en vez de un 500", async () => {
  const cat = new Map([["caro", producto("Caro", 300000)]]);
  const filas = Array.from({ length: 12 }, (_, i) => fila("caro", "e" + i, "extra", "E" + i, 50000, i));
  const { precios } = cargarPrecios({ catalogo: cat, opciones: filas });
  const ids = filas.map((f) => f.id);
  const items = Array.from({ length: 100 }, () => ({ id: "caro", cantidad: 50, precio: 300000, opciones: ids }));
  const r = await precios.validarItems(RID, items);
  assert.equal(r.ok, false);
  assert.equal(r.error, "Total inválido");
  const sin = await precios.validarItems(RID, Array.from({ length: 100 }, () => ({ id: "caro", cantidad: 50, precio: 300000 })));
  assert.equal(sin.ok, true, "sin opciones el maximo de siempre (1.500.000.000) sigue pasando");
  assert.equal(sin.subtotal, 1500000000);
  // El borde exacto: 2.000.000.000 pasa; un peso mas, o lo que ya no cabe en un integer (2.147.483.648), no
  const borde = (precio, extra) => cargarPrecios({ catalogo: new Map([["a", producto("A", precio)]]), opciones: [fila("a", "e", "extra", "E", extra, 0)] })
    .precios.validarItems(RID, [{ id: "a", cantidad: 1, precio, opciones: ["e"] }]);
  assert.equal((await borde(1999999000, 1000)).subtotal, 2000000000);
  assert.equal((await borde(1999999000, 1001)).error, "Total inválido");
  assert.equal((await borde(2147483000, 648)).error, "Total inválido");
});

/* ---------- api/_menu.js con fetch simulado ---------- */

function conFetch(respuestas, fn) {
  const guardado = { fetch: globalThis.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, warn: console.warn, error: console.error };
  const urls = [];
  process.env.SUPABASE_URL = "https://falso.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_FALSA_para_pruebas_0000";
  console.warn = () => {}; console.error = () => {};
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    const r = respuestas(String(u));
    return new Response(r.cuerpo, { status: r.status || 200 });
  };
  const restaurar = () => {
    globalThis.fetch = guardado.fetch; console.warn = guardado.warn; console.error = guardado.error;
    if (guardado.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = guardado.url;
    if (guardado.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = guardado.key;
  };
  return Promise.resolve().then(() => fn(urls)).finally(restaurar);
}
const cargarMenu = () => { delete require.cache[require.resolve(path.join(API, "_menu.js"))]; return require(path.join(API, "_menu.js")); };

test("leerOpcionesParaCobrar: la URL lleva el restaurante y los ids entre comillas, escapados y codificados", async () => {
  const M = cargarMenu();
  await conFetch(() => ({ cuerpo: "[]" }), async (urls) => {
    await M.leerOpcionesParaCobrar(RID, ["a", 'b"c', "d,e", "f\\g", "a", "h&restaurante_id=eq.x#i %+"]);
    assert.equal(urls.length, 1);
    const u = new URL(urls[0]);
    assert.equal(u.pathname, "/rest/v1/producto_opciones");
    assert.equal(u.searchParams.get("restaurante_id"), "eq." + RID);
    assert.deepEqual(u.searchParams.getAll("restaurante_id"), ["eq." + RID], "un id no puede colar otro filtro");
    assert.equal(u.searchParams.get("producto_id"), 'in.("a","b\\"c","d,e","f\\\\g","h&restaurante_id=eq.x#i %+")');
    assert.match(u.searchParams.get("select"), /producto_id,id,tipo,nombre,precio,orden,activa/);
  });
  await conFetch(() => ({ cuerpo: "[]" }), async (urls) => {
    const m = await M.leerOpcionesParaCobrar(RID, []);
    assert.equal(m.size, 0); assert.equal(urls.length, 0, "sin productos no hay consulta");
  });
});

test("leerOpcionesParaCobrar: agrupa por producto y por id; leerOpcionesActivas ordena y quita lo interno", async () => {
  const M = cargarMenu();
  const filas = [fila("a", "z", "extra", "Z", 100, 2), fila("a", "y", "extra", "Y", 100, 2), fila("a", "x", "quitar", "X", 0, 1), fila("b", "w", "extra", "W", 5, 0)];
  await conFetch(() => ({ cuerpo: JSON.stringify(filas) }), async () => {
    const m = await M.leerOpcionesParaCobrar(RID, ["a", "b"]);
    assert.deepEqual(Array.from(m.keys()), ["a", "b"]);
    assert.equal(m.get("a").get("y").nombre, "Y");
    const v = await M.leerOpcionesActivas(RID);
    assert.deepEqual(v.get("a").map((o) => o.id), ["x", "y", "z"]);
    assert.deepEqual(Object.keys(v.get("a")[0]).sort(), ["id", "nombre", "orden", "precio", "tipo"]);
  });
});

test("leerOpcionesActivas: sin tabla (404) o con un fallo, el menu sigue: devuelve vacio y no lanza", async () => {
  const M = cargarMenu();
  await conFetch(() => ({ status: 404, cuerpo: JSON.stringify({ code: "PGRST205" }) }), async () => {
    assert.equal((await M.leerOpcionesActivas(RID)).size, 0);
  });
  await conFetch(() => ({ status: 500, cuerpo: "{}" }), async () => {
    assert.equal((await M.leerOpcionesActivas(RID)).size, 0);
  });
  assert.equal(M.esTablaDeOpcionesAusente({ status: 404 }), true);
  assert.equal(M.esTablaDeOpcionesAusente({ status: 400, cuerpo: '{"code":"42P01"}' }), true);
  assert.equal(M.esTablaDeOpcionesAusente({ status: 500, cuerpo: "{}" }), false);
  assert.equal(M.esTablaDeOpcionesAusente(null), false);
});

test("un NUMERO o un objeto no vale como id aunque se parezca a uno que existe (la forma del contrato es estricta)", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: [fila("taco", "7", "extra", "Siete", 700, 0), fila("taco", "ab", "extra", "Ab", 100, 1)] });
  const bueno = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["7"] }]);
  assert.equal(bueno.ok, true, "el texto '7' si");
  for (const mal of [[7], [{ toString() { return "7"; } }], [["7"]], [new String("7")], [Number("7")]]) {
    const r = await precios.validarItems(RID, [{ id: "taco", cantidad: 1, precio: 10000, opciones: mal }]);
    assert.deepEqual(r, { ok: false, codigo: 400, error: MENSAJE }, String(mal));
  }
});

test("las opciones de una linea no se mezclan con las de otra linea del mismo producto ni con las del pedido entero", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const r = await precios.validarItems(RID, [
    { id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-queso"] },
    { id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-tocineta"] },
    { id: "taco", cantidad: 1, precio: 10000 }
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.precio), [12000, 13000, 10000]);
  assert.equal(r.subtotal, 35000);
  assert.deepEqual(r.items[0].opciones.map((o) => o.id), ["extra-queso"]);
  assert.equal("opciones" in r.items[2], false);
});

test("la opcion de un producto pedida en la linea de OTRO producto del mismo pedido se rechaza (cada linea solo ve las suyas)", async () => {
  const { precios } = cargarPrecios({ catalogo: catalogoBase(), opciones: OPC });
  const mal = await precios.validarItems(RID, [
    { id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-queso"] },
    { id: "otro", cantidad: 1, precio: 7000, opciones: ["extra-queso"] }
  ]);
  assert.deepEqual(mal, { ok: false, codigo: 400, error: MENSAJE });
  const mal2 = await precios.validarItems(RID, [
    { id: "otro", cantidad: 1, precio: 7000, opciones: ["extra-solo"] },
    { id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-solo"] }
  ]);
  assert.deepEqual(mal2, { ok: false, codigo: 400, error: MENSAJE });
  const bien = await precios.validarItems(RID, [
    { id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-queso"] },
    { id: "otro", cantidad: 1, precio: 7000, opciones: ["extra-solo"] }
  ]);
  assert.equal(bien.ok, true);
  assert.equal(bien.subtotal, 12000 + 7500);
});
