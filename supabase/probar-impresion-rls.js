/* Prueba de intrusion de la impresion (supabase/02-impresion.sql).
   Debe demostrar: un anonimo NO puede reclamar ni reimprimir un pedido,
   ni escribir en las columnas de impresion, ni leerlas.

   Cada intento TIENE QUE FALLAR. Esta prueba no modifica datos: si algo
   se colara, el valor que se intenta escribir es el que la columna ya
   tiene, y la respuesta lo delata sin cambiar nada.

   Sin llave de servicio corre en version basica (usa un id que no
   existe). Con ella elige un pedido real y la prueba es mucho mas
   fuerte. La llave NUNCA va escrita aqui (repositorio publico):
     PowerShell:  $env:SUPABASE_SERVICE_ROLE_KEY = "..." ; node supabase/probar-impresion-rls.js
   Opcional: SUPABASE_PUBLISHABLE_KEY para probar con otra llave publica. */
const fs = require("fs");
const path = require("path");
const { cabecerasSupabase, leerLlaveServicio } = require("../api/_llave.js");

// URL y llave publishable: la misma copia que usan las paginas
const publico = fs.readFileSync(path.join(__dirname, "..", "supabase-publico.js"), "utf8");
const BASE = (publico.match(/url:\s*"([^"]+)"/) || [])[1];
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY
  || (publico.match(/publishableKey:\s*"([^"]+)"/) || [])[1];

if (!BASE || !ANON) {
  console.error("No pude leer la URL y la llave publishable de supabase-publico.js");
  process.exit(1);
}

let SR = null;
try { SR = leerLlaveServicio(); } catch (e) { /* version basica */ }

const Ha = cabecerasSupabase(ANON);
const Hs = SR ? cabecerasSupabase(SR) : null;

async function j(r) { const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }

let fallos = 0;
function resultado(ok, texto) {
  if (!ok) fallos++;
  console.log("  " + (ok ? "✅ BLOQUEADO " : "❌ SE COLO   ") + texto);
}

(async () => {
  console.log("Modo:", SR ? "COMPLETO (con pedido real)" : "BASICO (sin llave de servicio, id inexistente)");

  // ¿Ya se corrio el SQL?
  const sonda = await fetch(BASE + "/rest/v1/rpc/reclamar_impresion", {
    method: "POST", headers: Ha, body: JSON.stringify({ p_id: -1 })
  });
  const cuerpoSonda = await j(sonda);
  const codigo = cuerpoSonda && cuerpoSonda.code;
  if (sonda.status === 404 || codigo === "PGRST202" || codigo === "42883") {
    console.log("\nLa funcion reclamar_impresion todavia no existe: falta ejecutar");
    console.log("supabase/02-impresion.sql en Supabase. Nada que probar aun.");
    return;
  }

  // Pedido real (solo con llave de servicio). Se conserva su valor actual.
  let id = -1;
  let actual = null;
  if (Hs) {
    const filas = await j(await fetch(
      BASE + "/rest/v1/pedidos?select=id,impreso_en,reimpresiones&estado=neq.pendiente_pago&order=id.desc&limit=1",
      { headers: Hs }));
    if (Array.isArray(filas) && filas.length) { id = filas[0].id; actual = filas[0]; }
  }
  console.log("Pedido usado:", id === -1 ? "(inexistente)" : "#" + id, "\n");

  console.log("========== EL ANONIMO NO PUEDE LLAMAR LAS FUNCIONES ==========");
  let r = await fetch(BASE + "/rest/v1/rpc/reclamar_impresion", {
    method: "POST", headers: Ha, body: JSON.stringify({ p_id: id })
  });
  let cuerpo = await j(r);
  resultado(r.status >= 400 && cuerpo !== true,
    "A) reclamar_impresion como anonimo -> HTTP " + r.status + " " + (cuerpo && cuerpo.code || JSON.stringify(cuerpo)));

  r = await fetch(BASE + "/rest/v1/rpc/registrar_reimpresion", {
    method: "POST", headers: Ha, body: JSON.stringify({ p_id: id })
  });
  cuerpo = await j(r);
  resultado(r.status >= 400 && typeof cuerpo !== "number",
    "B) registrar_reimpresion como anonimo -> HTTP " + r.status + " " + (cuerpo && cuerpo.code || JSON.stringify(cuerpo)));

  console.log("\n========== NI ESCRIBIR LAS COLUMNAS DIRECTO ==========");
  // 'return=representation' devuelve las filas tocadas: vacio = no toco nada.
  const valor = actual ? actual.impreso_en : null;   // el mismo que ya tiene
  r = await fetch(BASE + "/rest/v1/pedidos?id=eq." + id, {
    method: "PATCH",
    headers: { ...Ha, Prefer: "return=representation" },
    body: JSON.stringify({ impreso_en: valor })
  });
  cuerpo = await j(r);
  const tocadas = Array.isArray(cuerpo) ? cuerpo.length : null;
  resultado(r.status >= 400 || tocadas === 0,
    "C) PATCH impreso_en como anonimo -> HTTP " + r.status + ", filas tocadas: " + (tocadas === null ? "error" : tocadas));

  r = await fetch(BASE + "/rest/v1/pedidos?id=eq." + id, {
    method: "PATCH",
    headers: { ...Ha, Prefer: "return=representation" },
    body: JSON.stringify({ reimpresiones: actual ? actual.reimpresiones : 0 })
  });
  cuerpo = await j(r);
  const tocadas2 = Array.isArray(cuerpo) ? cuerpo.length : null;
  resultado(r.status >= 400 || tocadas2 === 0,
    "D) PATCH reimpresiones como anonimo -> HTTP " + r.status + ", filas tocadas: " + (tocadas2 === null ? "error" : tocadas2));

  console.log("\n========== NI LEERLAS ==========");
  r = await fetch(BASE + "/rest/v1/pedidos?select=id,impreso_en,reimpresiones&limit=5", { headers: Ha });
  cuerpo = await j(r);
  resultado(r.status >= 400 || (Array.isArray(cuerpo) && cuerpo.length === 0),
    "E) SELECT de las columnas como anonimo -> HTTP " + r.status + ", filas: " + (Array.isArray(cuerpo) ? cuerpo.length : "error"));

  if (Hs && actual) {
    const despues = (await j(await fetch(
      BASE + "/rest/v1/pedidos?select=impreso_en,reimpresiones&id=eq." + id, { headers: Hs })))[0];
    resultado(despues && despues.impreso_en === actual.impreso_en && despues.reimpresiones === actual.reimpresiones,
      "F) el pedido #" + id + " quedo exactamente igual despues de los intentos");
  }

  console.log("\n" + (fallos === 0
    ? "✅ TODO BLOQUEADO: el publico no puede tocar la impresion."
    : "❌ " + fallos + " intento(s) se colaron. REVISA las politicas antes de usar el panel."));
  process.exit(fallos === 0 ? 0 : 1);
})();
