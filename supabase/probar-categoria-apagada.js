/* =============================================================
   PRUEBA CONTRA LA BASE REAL: categoria apagada

   Demuestra que el servidor NO deja pedir productos de una
   categoria desactivada, y que despues de la prueba el menu queda
   exactamente igual que antes.

   QUE HACE
     1. Fotografia el menu (todas las categorias y productos) y
        cuenta los pedidos de prueba (debe haber cero).
     2. Crea UNA categoria apagada y UN producto de prueba dentro.
     3. Pregunta a api/_precios.js (y a api/crear-pedido.js) si ese
        producto se puede pedir: debe decir que NO.
     4. Prende la categoria y vuelve a preguntar: debe decir que SI
        (asi se sabe que el rechazo era por la categoria).
     5. Borra lo creado (siempre, aunque algo falle).
     6. Compara con la foto del paso 1: ni una fila distinta, mismos
        pedidos.

   NO crea pedidos: el rechazo ocurre antes de insertar. Si algo se
   rompe a medio camino, el bloque final igual intenta borrar lo
   creado; los ids empiezan por 'zz-prueba-' para encontrarlos a mano.
   Los pedidos reales que lleguen durante la prueba no cuentan: solo
   se vigilan los del cliente "Prueba Automatica".

   USO (la llave NO se guarda en ningun archivo):
     PowerShell:
       $env:SUPABASE_URL = "https://<proyecto>.supabase.co"
       $env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."   # o la legacy
       node supabase/probar-categoria-apagada.js
============================================================= */
const assert = require("assert");
const { cabecerasSupabase, leerLlaveServicio } = require("../api/_llave.js");

const BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.error("Falta SUPABASE_URL en el entorno. Ver el comentario de arriba.");
  process.exit(1);
}
let SR;
try { SR = leerLlaveServicio(); } catch (e) {
  console.error(e.message + ". Ver el comentario de arriba.");
  process.exit(1);
}

const H = cabecerasSupabase(SR, { Prefer: "return=representation" });
const CAT = "zz-prueba-cat";
const PROD = "zz-prueba-prod";
const CLIENTE_PRUEBA = "Prueba Automatica";
let RID = null;   // restaurante de las pruebas (Taqueiros): se lee al empezar; todo lo que se crea o se borra lo lleva explicito

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(BASE + "/rest/v1/" + ruta, {
    method: metodo, headers: H, body: cuerpo ? JSON.stringify(cuerpo) : undefined
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta} -> ${r.status}: ${t}`);
  return t ? JSON.parse(t) : [];
}

async function foto() {
  const [categorias, productos, falsos] = await Promise.all([
    api("GET", `categorias?restaurante_id=eq.${RID}&select=*&order=id.asc`),
    api("GET", `productos?restaurante_id=eq.${RID}&select=*&order=id.asc`),
    api("GET", `pedidos?restaurante_id=eq.${RID}&select=id&cliente_nombre=eq.${encodeURIComponent(CLIENTE_PRUEBA)}`)
  ]);
  return { categorias, productos, pedidosDePrueba: falsos.length };
}

async function limpiar() {
  // Un pedido de prueba pendiente de pago, si alguna vez llegara a existir
  await api("DELETE", `pedidos?restaurante_id=eq.${RID}&cliente_nombre=eq.${encodeURIComponent(CLIENTE_PRUEBA)}&estado_pago=eq.pendiente`);
  // Primero el producto (referencia a la categoria), luego la categoria
  await api("DELETE", `productos?restaurante_id=eq.${RID}&id=eq.${PROD}`);
  await api("DELETE", `categorias?restaurante_id=eq.${RID}&id=eq.${CAT}`);
}

function simularRes() {
  const r = { codigo: null, cuerpo: null, setHeader() {} };
  r.status = (c) => { r.codigo = c; return r; };
  r.json = (b) => { r.cuerpo = b; return r; };
  return r;
}

(async () => {
  const rest = await api("GET", "restaurantes?slug=eq.taqueiros&select=id");
  if (rest.length !== 1) { console.error("No encontre el restaurante taqueiros: corre antes supabase/10-multirestaurante.sql"); process.exit(1); }
  RID = rest[0].id;
  let fallo = null;
  const antes = await foto();
  console.log("Antes:", antes.categorias.length, "categorias,", antes.productos.length, "productos,", antes.pedidosDePrueba, "pedidos de prueba");

  // Por si una corrida anterior se corto a la mitad
  await limpiar();

  try {
    await api("POST", "categorias", { restaurante_id: RID, id: CAT, nombre: "ZZ Prueba Temporal", emoji: "🧪", orden: 999, activa: false });
    await api("POST", "productos", { restaurante_id: RID, id: PROD, nombre: "ZZ Producto de prueba", precio: 1000, categoria: CAT, orden: 999, disponible: true });

    const { validarItems } = require("../api/_precios.js");
    const item = [{ id: PROD, cantidad: 1, precio: 1000 }];

    // --- Categoria APAGADA: debe rechazar ---
    let r = await validarItems(RID, item);
    assert.strictEqual(r.ok, false, "debio rechazar el producto de la categoria apagada");
    assert.strictEqual(r.agotados.length, 1);
    assert.strictEqual(r.agotados[0].motivo, "categoria_apagada");
    console.log("✅ validarItems rechaza (categoria apagada):", r.error);

    // --- Por el endpoint real, si el restaurante esta abierto ---
    const crear = require("../api/crear-pedido.js");
    const res = simularRes();
    await crear({
      method: "POST",
      headers: { host: process.env.PRUEBA_HOST || "taqueiros-2-0.vercel.app" },   // el servidor decide el restaurante por el dominio
      body: {
        modo: "test",
        items: item,
        cliente: { nombre: CLIENTE_PRUEBA, telefono: "3000000000", email: "prueba@example.com", tipoPedido: "llevar" }
      }
    }, res);
    if (res.cuerpo && res.cuerpo.cerrado) {
      console.log("ℹ️  El restaurante esta cerrado ahora: el endpoint respondio 'cerrado' antes de revisar productos.");
      console.log("   (la comprobacion de arriba, hecha directo sobre la validacion, sigue siendo valida)");
    } else {
      assert.strictEqual(res.codigo, 409, "el endpoint debio responder 409");
      assert.ok(res.cuerpo.agotados.some((a) => a.id === PROD));
      console.log("✅ /api/crear-pedido responde 409 y lista el producto");
    }

    // --- Categoria ENCENDIDA: ya no debe rechazar ---
    await api("PATCH", `categorias?restaurante_id=eq.${RID}&id=eq.${CAT}`, { activa: true });
    r = await validarItems(RID, item);
    assert.strictEqual(r.ok, true, "con la categoria activa debio aceptar: " + JSON.stringify(r));
    console.log("✅ validarItems acepta cuando la categoria esta activa (el rechazo era por la categoria)");
  } catch (e) {
    fallo = e;
  } finally {
    try { await limpiar(); } catch (e) {
      console.error("⚠️  NO se pudo limpiar. Borra a mano en Supabase:", CAT, "y", PROD, "->", e.message);
      fallo = fallo || e;
    }
  }

  const despues = await foto();
  const igual = JSON.stringify(antes) === JSON.stringify(despues);
  console.log("\nDespués:", despues.categorias.length, "categorias,", despues.productos.length, "productos,", despues.pedidosDePrueba, "pedidos de prueba");
  console.log(igual
    ? "✅ Categorías y productos quedaron IDÉNTICOS a antes de la prueba, sin pedidos falsos."
    : "❌ La base NO quedó igual que antes. Revisa categorias/productos que empiecen por 'zz-prueba-'.");

  if (fallo) { console.error("\n❌ La prueba falló:", fallo.message); process.exit(1); }
  if (!igual) process.exit(1);
  console.log("\nTodo en orden.");
})();
