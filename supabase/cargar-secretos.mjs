/* =============================================================
   CARGAR LOS SECRETOS DE UN RESTAURANTE EN restaurante_secretos

   Hoy las llaves de Wompi y de CallMeBot de Taqueiros viven en las variables
   de entorno de Vercel. En multi-restaurante cada restaurante tiene las suyas en
   la tabla restaurante_secretos (solo el servidor la lee). Este script lee las
   variables de entorno de TU SESION y las guarda en la fila del restaurante que
   indiques por slug.

   NUNCA imprime un valor, ni derivados suyos (tampoco huellas o hashes: una apikey
   corta se podria recuperar a fuerza bruta): solo nombres de campo, cuantos
   caracteres tiene y si se guardo / coincide.

   VARIABLES QUE LEE (todas opcionales: solo se guardan las que tengan valor)
     Wompi (columnas de restaurante_secretos)
       WOMPI_INTEGRITY_SECRET_TEST / _PROD  -> wompi_integridad_test / _prod
       WOMPI_EVENTS_SECRET_TEST    / _PROD  -> wompi_eventos_test    / _prod
       WOMPI_PUBLIC_KEY_TEST       / _PROD  -> wompi_llave_publica_test / _prod
     Avisos (CallMeBot)
       CALLMEBOT_PHONE                      -> callmebot_telefono   (57XXXXXXXXXX)
       CALLMEBOT_APIKEY                     -> callmebot_apikey
     Dentro de la columna "otros" (jsonb):
       WOMPI_PRIVATE_KEY_TEST / _PROD       -> otros.wompi_llave_privada_test / _prod
       WOMPI_MODO                           -> otros.wompi_modo  ("test" o "produccion")
                                               (el modo de cobro lo decide el servidor)

   MAS: SUPABASE_SERVICE_ROLE_KEY (la llave secreta) y, si no estan en
   supabase-publico.js, SUPABASE_URL.

   USO (PowerShell, desde la raiz del repo)
     node supabase/cargar-secretos.mjs --slug=taqueiros                  guarda lo que haya en el entorno
     node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar compara el entorno con la base
     node supabase/cargar-secretos.mjs --slug=lostaqueiros --sobrescribir cambia valores que ya existen

   SEGURIDAD
     * Pega cada llave UNA sola vez. Si el valor parece pegado dos veces
       (se repite a la mitad, o un prefijo conocido aparece dos veces) el
       script no guarda NADA y te lo dice.
     * Sin --sobrescribir no cambia un valor que ya esta en la base y es distinto.
     * Nunca guarda un valor vacio encima de uno existente.
============================================================= */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { cabecerasSupabase, leerLlaveServicio, tipoDeLlave } = require("../api/_llave.js");

const aqui = path.dirname(fileURLToPath(import.meta.url));
const publico = fs.readFileSync(path.join(aqui, "..", "supabase-publico.js"), "utf8");
const URL_BASE = (process.env.SUPABASE_URL || (publico.match(/url:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const bandera = (n) => process.argv.includes(`--${n}`);
const slug = (arg("slug") || process.env.RESTAURANTE_SLUG || "").trim().toLowerCase();
const soloVerificar = bandera("solo-verificar");
const sobrescribir = bandera("sobrescribir");

if (!URL_BASE) { console.error("No pude leer SUPABASE_URL (ni de supabase-publico.js)."); process.exit(2); }
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { console.error("Falta --slug=<slug del restaurante> (minusculas, numeros y guiones). Ej: --slug=taqueiros"); process.exit(2); }

let SRV;
try { SRV = leerLlaveServicio(); } catch (e) { console.error(e.message); process.exit(2); }
if (tipoDeLlave(SRV) === "secreta" && SRV.split("sb_secret_").length !== 2) {
  console.error("La llave secreta de Supabase parece pegada DOS veces. Vuelve a pegarla una sola vez (clic derecho O Ctrl+V, no ambos).");
  process.exit(2);
}
const H = cabecerasSupabase(SRV);

/* ---- Campos: variable de entorno -> destino ------------------------------------------------------------------- */
const CAMPOS = [
  { env: "WOMPI_INTEGRITY_SECRET_TEST", col: "wompi_integridad_test", prefijo: "test_integrity_" },
  { env: "WOMPI_INTEGRITY_SECRET_PROD", col: "wompi_integridad_prod", prefijo: "prod_integrity_" },
  { env: "WOMPI_EVENTS_SECRET_TEST", col: "wompi_eventos_test", prefijo: "test_events_" },
  { env: "WOMPI_EVENTS_SECRET_PROD", col: "wompi_eventos_prod", prefijo: "prod_events_" },
  { env: "WOMPI_PUBLIC_KEY_TEST", col: "wompi_llave_publica_test", prefijo: "pub_test_" },
  { env: "WOMPI_PUBLIC_KEY_PROD", col: "wompi_llave_publica_prod", prefijo: "pub_prod_" },
  { env: "CALLMEBOT_PHONE", col: "callmebot_telefono", solo_digitos: true },
  { env: "CALLMEBOT_APIKEY", col: "callmebot_apikey" },
  { env: "WOMPI_PRIVATE_KEY_TEST", otros: "wompi_llave_privada_test", prefijo: "prv_test_" },
  { env: "WOMPI_PRIVATE_KEY_PROD", otros: "wompi_llave_privada_prod", prefijo: "prv_prod_" },
  { env: "WOMPI_MODO", otros: "wompi_modo", enumerado: ["test", "produccion"] }
];

/* true si el valor parece pegado dos veces: se repite exacto a la mitad, o su prefijo aparece dos veces */
function pegadoDoble(valor, prefijo) {
  const v = String(valor);
  if (v.length >= 8 && v.length % 2 === 0 && v.slice(0, v.length / 2) === v.slice(v.length / 2)) return true;
  if (prefijo && v.split(prefijo).length > 2) return true;
  return false;
}

/* ---- 1. Leer y validar el entorno (sin imprimir valores) ---------------------------------------------------- */
const propuestos = [];
const problemas = [];
for (const c of CAMPOS) {
  const crudo = process.env[c.env];
  if (crudo === undefined || String(crudo).trim() === "") continue;
  const valor = String(crudo).trim();
  if (pegadoDoble(valor, c.prefijo)) { problemas.push(`${c.env}: parece pegado DOS veces (no se guarda nada). Vuelve a pegarlo una sola vez.`); continue; }
  if (/\s/.test(valor)) { problemas.push(`${c.env}: trae espacios o saltos de linea en medio (no se guarda nada).`); continue; }
  if (c.solo_digitos && !/^\d{10,15}$/.test(valor)) { problemas.push(`${c.env}: debe ser solo digitos con el indicativo (57XXXXXXXXXX).`); continue; }
  if (c.enumerado && !c.enumerado.includes(valor)) { problemas.push(`${c.env}: debe ser uno de: ${c.enumerado.join(", ")}.`); continue; }
  propuestos.push({ ...c, valor });
}
if (problemas.length) {
  console.error("No se guardo NADA. Corrige esto y vuelve a correr:\n  - " + problemas.join("\n  - "));
  process.exit(2);
}
if (!propuestos.length) {
  console.error("No hay ninguna variable de secretos en tu sesion (WOMPI_*, CALLMEBOT_*). Pidelas primero, por ejemplo:\n" +
    "  $s = Read-Host \"Secreto de integridad (test)\" -AsSecureString\n" +
    "  $env:WOMPI_INTEGRITY_SECRET_TEST = [System.Net.NetworkCredential]::new('', $s).Password\n" +
    "Ver docs/multirestaurante.md (seccion 'Pasos en Windows').");
  process.exit(2);
}

/* ---- 2. Buscar el restaurante y su fila de secretos -------------------------------------------------------------- */

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, {
    method: metodo, headers: { ...H, ...(metodo === "GET" ? {} : { Prefer: "return=representation" }) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(`${metodo} ${ruta.split("?")[0]} -> HTTP ${r.status} ${t.slice(0, 160)}`);
  return j;
}

async function principal() {
  const restaurantes = await api("GET", `restaurantes?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nombre,estado`);
  if (!restaurantes.length) { console.error(`No existe un restaurante con slug "${slug}".`); return 2; }
  const rest = restaurantes[0];
  const filas = await api("GET", `restaurante_secretos?restaurante_id=eq.${rest.id}&select=*`);
  if (!filas.length) { console.error(`El restaurante "${slug}" no tiene fila en restaurante_secretos (la crea el alta del restaurante, SQL 10).`); return 2; }
  const fila = filas[0];
  const otros = (fila.otros && typeof fila.otros === "object") ? fila.otros : {};

  console.log(`Restaurante: ${rest.nombre} (${rest.slug}, estado ${rest.estado})`);
  console.log(soloVerificar ? "Modo: SOLO VERIFICAR (no se escribe nada)\n" : "Modo: GUARDAR\n");

  /* ---- 3. Comparar / guardar ---------------------------------------------------------------------------------------------------- */
  const actual = (c) => (c.col ? fila[c.col] : otros[c.otros]);
  const cambios = {};
  const nuevosOtros = { ...otros };
  let hayOtros = false;
  let conflictos = 0;

  for (const c of propuestos) {
    const destino = c.col || `otros.${c.otros}`;
    const enBase = actual(c);
    const hay = enBase !== null && enBase !== undefined && String(enBase) !== "";
    const igual = hay && String(enBase) === c.valor;
    const estado = igual ? "ya coincide con la base"
      : hay ? (sobrescribir && !soloVerificar ? "DIFERENTE a la base: se sobrescribe" : "DIFERENTE a la base")
        : (soloVerificar ? "falta en la base" : "se guarda (estaba vacio)");
    console.log(`  ${c.env.padEnd(30)} -> ${destino.padEnd(28)} ${String(c.valor.length).padStart(4)} caracteres  ${estado}`);

    if (soloVerificar || igual) continue;
    if (hay && !sobrescribir) { conflictos++; continue; }
    if (c.col) cambios[c.col] = c.valor; else { nuevosOtros[c.otros] = c.valor; hayOtros = true; }
  }

  if (soloVerificar) {
    console.log("\n(Solo se compara: \"ya coincide\" = el valor de tu sesion es igual al de la base; nunca se muestra ninguno.)");
    return 0;
  }
  if (conflictos) {
    console.log(`\n${conflictos} valor(es) ya existen en la base y son distintos: NO se tocaron. Usa --sobrescribir si de verdad quieres cambiarlos.`);
  }
  if (hayOtros) cambios.otros = nuevosOtros;

  if (!Object.keys(cambios).length) {
    console.log("\nNada que guardar.");
    return conflictos ? 1 : 0;
  }

  cambios.actualizado_en = new Date().toISOString();
  await api("PATCH", `restaurante_secretos?restaurante_id=eq.${rest.id}`, cambios);

  /* ---- 4. Releer y comprobar (sin mostrar valores) ----------------------------------------------------------------- */
  const despues = (await api("GET", `restaurante_secretos?restaurante_id=eq.${rest.id}&select=*`))[0];
  const otrosDespues = (despues.otros && typeof despues.otros === "object") ? despues.otros : {};
  let mal = 0;
  for (const c of propuestos) {
    const v = c.col ? despues[c.col] : otrosDespues[c.otros];
    const debia = (c.col ? cambios[c.col] : (cambios.otros && cambios.otros[c.otros])) !== undefined;
    if (debia && String(v) !== c.valor) { mal++; console.error(`  ${c.env}: lo guardado NO coincide con lo enviado`); }
  }
  if (mal) return 1;

  console.log(`\nGuardado y verificado en restaurante_secretos de "${slug}".`);
  console.log("Siguiente: node supabase/cargar-secretos.mjs --slug=" + slug + " --solo-verificar");
  return conflictos ? 1 : 0;
}

// Sin process.exit() inmediato: en Windows, salir de golpe con conexiones de fetch cerrandose imprime una
// "Assertion failed ... async.c" y cambia el codigo de salida. Se deja drenar y, si algo la retiene, se fuerza a los 4 s.
process.exitCode = await principal();
setTimeout(() => process.exit(), 4000).unref();
