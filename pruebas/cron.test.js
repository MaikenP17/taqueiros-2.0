/* =============================================================
   PRUEBAS DE LA CLAVE DE LOS CRONS (sin red, secretos inventados)

   Desde el paso 3A los crons aceptan el secreto SOLO por la cabecera
   Authorization: Bearer. El parametro ?clave= se retiro: responde 401 aunque
   la clave sea la correcta.

   USO:   node --test pruebas/cron.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SECRETO = "secreto-falso-de-prueba-0123456789";
const { autorizadoCron } = require("../api/_cron.js");

const pedido = (url, authorization) => ({
  url,
  headers: authorization === undefined ? {} : { authorization }
});
const ENV = { CRON_SECRET: SECRETO };

test("Authorization: Bearer <secreto> autoriza", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas", "Bearer " + SECRETO), ENV), true);
});

test("?clave=<secreto> YA NO autoriza, aunque la clave sea la correcta", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas?clave=" + SECRETO), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/keep-alive?clave=" + encodeURIComponent(SECRETO)), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas?CLAVE=" + SECRETO), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas?x=1&clave=" + SECRETO + "&y=2"), ENV), false);
});

test("el esquema Bearer no distingue mayusculas, como pide HTTP", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas", "bearer " + SECRETO), ENV), true);
});

test("secreto equivocado por cabecera: rechaza", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas", "Bearer otro-secreto"), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas?clave=otro-secreto"), ENV), false);
});

test("sin nada, o con una cabecera que no es Bearer: rechaza", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas"), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas", "Basic " + SECRETO), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas", SECRETO), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas?clave="), ENV), false);
});

test("un prefijo o una version mas larga del secreto no pasan", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas", "Bearer " + SECRETO.slice(0, -1)), ENV), false);
  assert.equal(autorizadoCron(pedido("/api/alertas", "Bearer " + SECRETO + "x"), ENV), false);
});

test("sin CRON_SECRET configurado nadie entra, ni siquiera con clave vacia", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas", "Bearer "), {}), false);
  assert.equal(autorizadoCron(pedido("/api/alertas?clave="), {}), false);
  assert.equal(autorizadoCron(pedido("/api/alertas", "Bearer undefined"), {}), false);
});

test("con el Bearer correcto entra aunque la URL traiga una ?clave= mala (la URL no cuenta)", () => {
  assert.equal(autorizadoCron(pedido("/api/alertas?clave=mal", "Bearer " + SECRETO), ENV), true);
});

test("una URL que no se puede leer no rompe la autorizacion", () => {
  assert.equal(autorizadoCron({ url: "http://[", headers: { authorization: "Bearer " + SECRETO } }, ENV), true);
  assert.equal(autorizadoCron({ url: undefined, headers: {} }, ENV), false);
});

/* ---------- las dos rutas, de punta a punta, sin tocar Supabase ---------- */

function respuestaFalsa() {
  const r = { codigo: null, cuerpo: null };
  r.status = (c) => { r.codigo = c; return r; };
  r.json = (b) => { r.cuerpo = b; return r; };
  return r;
}

/* Sustituye _supabase.js por una version que no usa la red */
const rutaSupabase = require.resolve("../api/_supabase.js");
require.cache[rutaSupabase] = {
  id: rutaSupabase, filename: rutaSupabase, loaded: true,
  exports: {
    consultarPedidos: async () => [],
    listarRestaurantes: async () => [],
    pingBase: async () => {},
    limpiarHuerfanos: async () => 0,
    actualizarPedidoPorReferencia: async () => {}
  }
};

/* Los dos endpoints viven en api/_modulos/ y los despacha api/cron.js (vercel.json reescribe /api/alertas y /api/keep-alive
   hacia alla). Se prueban los dos: el modulo solo y a traves del despachador, con la URL de siempre. */
const CARGAS = [
  ["modulo", (ruta) => require(path.join("..", "api", "_modulos", ruta + ".js"))],
  ["despachador cron.js", () => require("../api/cron.js")]
];
for (const [via, cargar] of CARGAS) for (const ruta of ["alertas", "keep-alive"]) {
  const manejador = cargar(ruta);

  test(`[${via}] /api/${ruta}: 401 sin secreto y con ?clave= (aunque sea la correcta), 200 solo con Bearer, y el secreto no se imprime`, async () => {
    process.env.CRON_SECRET = SECRETO;
    const impreso = [];
    const originales = {};
    for (const n of ["log", "warn", "error", "info"]) {
      originales[n] = console[n];
      console[n] = (...a) => impreso.push(a.map(String).join(" "));
    }
    try {
      let r = respuestaFalsa();
      await manejador(pedido(`/api/${ruta}`), r);
      assert.equal(r.codigo, 401);

      r = respuestaFalsa();
      await manejador(pedido(`/api/${ruta}?clave=incorrecta`, "Bearer incorrecto"), r);
      assert.equal(r.codigo, 401);

      r = respuestaFalsa();
      await manejador(pedido(`/api/${ruta}`, "Bearer " + SECRETO), r);
      assert.equal(r.codigo, 200);

      // La clave correcta en la URL ya no sirve: 401
      r = respuestaFalsa();
      await manejador(pedido(`/api/${ruta}?clave=${SECRETO}`), r);
      assert.equal(r.codigo, 401);
    } finally {
      for (const n of Object.keys(originales)) console[n] = originales[n];
      delete process.env.CRON_SECRET;
    }
    assert.equal(impreso.some((l) => l.includes(SECRETO)), false, "el secreto aparecio en un registro");
  });
}
