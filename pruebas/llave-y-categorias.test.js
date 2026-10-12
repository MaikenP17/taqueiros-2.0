/* =============================================================
   PRUEBAS (sin red, sin llaves reales)

   Cubren dos cosas:
     1. Que la llave de servicio se envie en el formato correcto
        segun sea la secreta nueva (sb_secret_) o la legacy (JWT).
     2. Que el servidor rechace productos de categorias apagadas.

   Todas las llaves de aqui son inventadas y obviamente falsas. El
   fetch esta simulado: no se toca Supabase.

   USO:   node --test pruebas/llave-y-categorias.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");

const { tipoDeLlave, cabecerasSupabase, leerLlaveServicio } = require("../api/_llave.js");

const SECRETA_FALSA = "sb_secret_FALSA_para_pruebas_0000";
const PUBLICABLE_FALSA = "sb_publishable_FALSA_para_pruebas_0000";
// Armada por partes para que una busqueda de secretos en el repo no la confunda con un JWT real
const LEGACY_FALSA = "ey" + "JFALSA.ey" + "JFALSA.FALSA_para_pruebas";

/* ---------- 1. Encabezados ---------- */

test("tipoDeLlave distingue los tres formatos", () => {
  assert.equal(tipoDeLlave(SECRETA_FALSA), "secreta");
  assert.equal(tipoDeLlave(PUBLICABLE_FALSA), "publicable");
  assert.equal(tipoDeLlave(LEGACY_FALSA), "legacy");
  assert.equal(tipoDeLlave("  " + SECRETA_FALSA + "\n"), "secreta");
});

test("llave secreta: solo apikey, SIN Authorization", () => {
  const h = cabecerasSupabase(SECRETA_FALSA);
  assert.equal(h.apikey, SECRETA_FALSA);
  assert.equal("Authorization" in h, false);
  assert.equal(h["Content-Type"], "application/json");
});

test("llave legacy: apikey y Authorization Bearer (comportamiento de siempre)", () => {
  const h = cabecerasSupabase(LEGACY_FALSA);
  assert.equal(h.apikey, LEGACY_FALSA);
  assert.equal(h.Authorization, "Bearer " + LEGACY_FALSA);
  assert.equal(h["Content-Type"], "application/json");
});

test("los encabezados extra se mezclan y pueden sobrescribir", () => {
  const h = cabecerasSupabase(SECRETA_FALSA, { Prefer: "return=representation" });
  assert.equal(h.Prefer, "return=representation");
  assert.equal(h.apikey, SECRETA_FALSA);
});

test("espacios o salto de linea al pegar la llave en Vercel no la rompen", () => {
  const h = cabecerasSupabase("  " + SECRETA_FALSA + "\n");
  assert.equal(h.apikey, SECRETA_FALSA);
});

test("leerLlaveServicio: acepta ambas, y falla claro sin filtrar el valor", () => {
  const N = "SUPABASE_SERVICE_ROLE_KEY";

  assert.equal(leerLlaveServicio({ [N]: SECRETA_FALSA }), SECRETA_FALSA);
  assert.equal(leerLlaveServicio({ [N]: LEGACY_FALSA }), LEGACY_FALSA);

  assert.throws(() => leerLlaveServicio({}), /Falta SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => leerLlaveServicio({ [N]: "   " }), /Falta SUPABASE_SERVICE_ROLE_KEY/);

  // Una publicable en la variable del servidor es un error de
  // configuracion: se dice claro y el mensaje NO trae la llave.
  try {
    leerLlaveServicio({ [N]: PUBLICABLE_FALSA });
    assert.fail("debio lanzar");
  } catch (e) {
    assert.match(e.message, /publicable/);
    assert.equal(e.message.includes(PUBLICABLE_FALSA), false);
  }
});

/* ---------- 2. El cliente del servidor con fetch simulado ---------- */

const ENTORNO_ORIGINAL = { ...process.env };
const FETCH_ORIGINAL = global.fetch;

function simularFetch(respuestas) {
  const llamadas = [];
  global.fetch = async (url, opciones) => {
    llamadas.push({ url: String(url), headers: (opciones && opciones.headers) || {} });
    for (const [fragmento, cuerpo] of Object.entries(respuestas)) {
      if (String(url).includes(fragmento)) {
        return { ok: true, status: 200, text: async () => JSON.stringify(cuerpo) };
      }
    }
    return { ok: false, status: 404, text: async () => "no simulado: " + url };
  };
  return llamadas;
}

function restaurar() {
  global.fetch = FETCH_ORIGINAL;
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, ENTORNO_ORIGINAL);
}

test("_supabase.js envia la llave nueva solo en apikey", async () => {
  process.env.SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRETA_FALSA;
  const llamadas = simularFetch({ "/rest/v1/configuracion": [{ id: 1 }] });
  try {
    const { leerConfiguracion } = require("../api/_supabase.js");
    await leerConfiguracion();
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].headers.apikey, SECRETA_FALSA);
    assert.equal("Authorization" in llamadas[0].headers, false);
  } finally { restaurar(); }
});

test("_supabase.js con la legacy sigue enviando apikey + Bearer", async () => {
  process.env.SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = LEGACY_FALSA;
  const llamadas = simularFetch({ "/rest/v1/configuracion": [{ id: 1 }] });
  try {
    const { leerConfiguracion } = require("../api/_supabase.js");
    await leerConfiguracion();
    assert.equal(llamadas[0].headers.apikey, LEGACY_FALSA);
    assert.equal(llamadas[0].headers.Authorization, "Bearer " + LEGACY_FALSA);
  } finally { restaurar(); }
});

test("el error de Supabase no incluye la llave", async () => {
  process.env.SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRETA_FALSA;
  simularFetch({});   // todo da 404
  try {
    const { consultarTabla } = require("../api/_supabase.js");
    await assert.rejects(
      () => consultarTabla("productos", "select=id"),
      (e) => !e.message.includes(SECRETA_FALSA)
    );
  } finally { restaurar(); }
});

/* ---------- 3. Categorias apagadas ---------- */

const CATEGORIAS = [
  { id: "tacos",  nombre: "Tacos",  activa: true  },
  { id: "bebidas", nombre: "Bebidas", activa: false }
];
const PRODUCTOS = [
  { id: "taco-uno",   nombre: "Taco uno",   precio: 10000, disponible: true,  categoria: "tacos"   },
  { id: "taco-agota", nombre: "Taco agota", precio: 9000,  disponible: false, categoria: "tacos"   },
  { id: "cola",       nombre: "Cola",       precio: 4000,  disponible: true,  categoria: "bebidas" },
  { id: "suelto",     nombre: "Suelto",     precio: 5000,  disponible: true,  categoria: "no-existe" }
];

async function validarConCatalogo(items, categorias, productos) {
  process.env.SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRETA_FALSA;
  simularFetch({ "/rest/v1/productos": productos, "/rest/v1/categorias": categorias });
  try {
    const { validarItems } = require("../api/_precios.js");
    return await validarItems(items);
  } finally { restaurar(); }
}

test("producto de categoria apagada: rechazado con mensaje claro", async () => {
  const r = await validarConCatalogo([{ id: "cola", cantidad: 1, precio: 4000 }], CATEGORIAS, PRODUCTOS);
  assert.equal(r.ok, false);
  assert.equal(r.agotados.length, 1);
  assert.equal(r.agotados[0].id, "cola");
  assert.equal(r.agotados[0].motivo, "categoria_apagada");
  assert.match(r.error, /Cola/);
  assert.match(r.error, /categoría "Bebidas" está desactivada/);
});

test("categoria apagada con producto marcado disponible NO se cobra aunque el precio coincida", async () => {
  const r = await validarConCatalogo(
    [{ id: "taco-uno", cantidad: 1, precio: 10000 }, { id: "cola", cantidad: 2, precio: 4000 }],
    CATEGORIAS, PRODUCTOS);
  assert.equal(r.ok, false);
  assert.deepEqual(r.agotados.map((a) => a.id), ["cola"]);
});

test("producto agotado sigue rechazandose como antes", async () => {
  const r = await validarConCatalogo([{ id: "taco-agota", cantidad: 1, precio: 9000 }], CATEGORIAS, PRODUCTOS);
  assert.equal(r.ok, false);
  assert.equal(r.agotados[0].id, "taco-agota");
  assert.equal(r.agotados[0].motivo, "agotado");
  assert.match(r.error, /agotado/);
});

test("categoria activa y producto disponible: pasa y cobra el precio de la base", async () => {
  const r = await validarConCatalogo([{ id: "taco-uno", cantidad: 3, precio: 10000 }], CATEGORIAS, PRODUCTOS);
  assert.equal(r.ok, true);
  assert.equal(r.subtotal, 30000);
});

test("producto cuya categoria no aparece: no se bloquea (solo se rechaza una categoria que exista y este apagada)", async () => {
  const r = await validarConCatalogo([{ id: "suelto", cantidad: 1, precio: 5000 }], CATEGORIAS, PRODUCTOS);
  assert.equal(r.ok, true);
});

test("si no se puede leer categorias, no se cobra", async () => {
  process.env.SUPABASE_URL = "https://ejemplo.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SECRETA_FALSA;
  simularFetch({ "/rest/v1/productos": PRODUCTOS });   // categorias -> 404
  try {
    const { validarItems } = require("../api/_precios.js");
    const r = await validarItems([{ id: "taco-uno", cantidad: 1, precio: 10000 }]);
    assert.equal(r.ok, false);
    assert.match(r.error, /No pudimos confirmar los precios/);
  } finally { restaurar(); }
});
