/* =============================================================
   BORRAR UN RESTAURANTE DE PRUEBA  (herramienta de OPERADOR; docs/multirestaurante.md seccion 24)

   La pantalla de superadmin (y api/superadmin.js) NO pueden borrar un restaurante, a proposito. Para limpiar un restaurante de
   prueba que se creo con el asistente se usa este script. Es lo UNICO que borra un restaurante.

   SE NIEGA A BORRAR (siempre, sin opcion para saltarselo)
     * el restaurante demo (id 00000000-0000-4000-8000-000000000001);
     * un restaurante cuyo nombre corto NO empiece por el prefijo de prueba (por defecto "prueba-"; se cambia con --prefijo=xxx-);
     * un restaurante que tenga CUALQUIER pedido pagado (estado_pago aprobado o con fecha de pago): eso es dinero real;
     * un nombre corto mal formado, o un prefijo demasiado corto o sin guion final.

   QUE HACE (y que no)
     * Por defecto SIMULA: muestra cuantas filas tiene cada tabla de ESE restaurante y no borra nada.
     * Con --aplicar pide ESCRIBIR el nombre corto completo para confirmar (lo lee del teclado; sin eso no borra nada).
     * Solo borra filas con restaurante_id = el de ese restaurante (cada borrado lleva ese filtro) y, al final, su fila de
       restaurantes. Sus secretos, su contador de pedidos y sus dominios caen en cascada por la propia base.
     * NO borra: la auditoria (es de solo agregar y conserva la historia), los usuarios de Authentication (pueden ser de otros
       restaurantes), ni las fotos del almacenamiento (carpeta del restaurante en el bucket "productos").
     * Despues comprueba que el restaurante ya no existe y que el demo sigue ahi.

   USO (PowerShell, desde la raiz del repo)
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/borrar-restaurante-prueba.mjs prueba-casa-rivo                 (simula)
     node supabase/borrar-restaurante-prueba.mjs prueba-casa-rivo --aplicar       (pide escribir el nombre corto)
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
   Variables opcionales: SUPABASE_URL (si no, se lee de supabase-publico.js).
   Nunca imprime la llave. Sale con codigo 0 si todo bien, 1 si algo fallo, 2 si se nego o faltan datos.
============================================================= */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { cabecerasSupabase, leerLlaveServicio, tipoDeLlave } = require("../api/_llave.js");

const ID_DEMO = "00000000-0000-4000-8000-000000000001";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PREFIJO = /^[a-z0-9]+(-[a-z0-9]+)*-$/;
/* Orden de borrado: primero lo que depende de otras tablas. Todas llevan restaurante_id. */
const TABLAS = ["producto_opciones", "pedidos", "productos", "categorias", "tarifas_domicilio", "miembros", "restaurante_dominios", "configuracion", "salud_notificaciones", "intentos_buscar_pedido"];
const EN_CASCADA = ["restaurante_secretos", "contadores_pedido"];

const aqui = path.dirname(fileURLToPath(import.meta.url));
const publico = fs.readFileSync(path.join(aqui, "..", "supabase-publico.js"), "utf8");
const URL_BASE = (process.env.SUPABASE_URL || (publico.match(/url:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");

const args = process.argv.slice(2);
const aplicar = args.includes("--aplicar");
const slug = (args.find((a) => !a.startsWith("--")) || "").trim();
const prefijoArg = args.find((a) => a.startsWith("--prefijo="));
const prefijo = prefijoArg ? prefijoArg.slice("--prefijo=".length) : "prueba-";

/* Termina SIN process.exit (en Windows, cerrar con la entrada estandar abierta puede abortar el proceso): se lanza un aviso
   que el final del archivo recoge y se deja el codigo de salida en process.exitCode. */
class Salida extends Error {}
function salir(codigo, texto) { if (texto) (codigo === 0 ? console.log : console.error)(texto); process.exitCode = codigo; throw new Salida("salida"); }

function validarArranque() {
if (!URL_BASE) salir(2, "No pude leer SUPABASE_URL (ni de supabase-publico.js).");
if (!slug) salir(2, "Falta el nombre corto del restaurante. Ej: node supabase/borrar-restaurante-prueba.mjs prueba-casa-rivo");
if (!SLUG.test(slug) || slug.length < 2 || slug.length > 40) salir(2, "El nombre corto no tiene un formato valido (minusculas, numeros y guiones, de 2 a 40 caracteres).");
if (!PREFIJO.test(prefijo) || prefijo.length < 4 || prefijo.length > 20) salir(2, "El prefijo de prueba debe tener de 4 a 20 caracteres, ser minusculas/numeros/guiones y terminar en guion (ejemplo: prueba-).");
if (slug.indexOf(prefijo) !== 0 || slug === prefijo) salir(2, `NO se borra: el nombre corto "${slug}" no empieza por el prefijo de prueba "${prefijo}". Este script solo borra restaurantes de prueba.`);
}

let H = null;
function prepararLlave() {
  let SRV;
  try { SRV = leerLlaveServicio(); } catch (e) { salir(2, e.message); }
  if (tipoDeLlave(SRV) === "secreta" && SRV.split("sb_secret_").length !== 2) salir(2, "La llave secreta parece pegada DOS veces. Vuelve a pegarla una sola vez.");
  H = cabecerasSupabase(SRV);
}

async function rest(metodo, ruta, extra) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { method: metodo, headers: { ...H, ...(extra || {}) } });
  const texto = await r.text();
  return { status: r.status, texto, cabeceras: r.headers };
}
const TOPE = 5000;
/* Cuenta las filas de una tabla para ese restaurante con un filtro simple (sin depender de cabeceras de conteo). */
async function contar(tabla, id) {
  const r = await rest("GET", `${tabla}?restaurante_id=eq.${id}&select=restaurante_id&limit=${TOPE}`);
  if (r.status >= 300) return { error: `HTTP ${r.status}` };
  const n = JSON.parse(r.texto || "[]").length;
  return { n, tope: n >= TOPE };
}

async function principal() {
  const rr = await rest("GET", `restaurantes?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nombre,estado`);
  if (rr.status >= 300) return salir(1, `No pude consultar la base (HTTP ${rr.status}).`);
  const filas = JSON.parse(rr.texto || "[]");
  if (!filas.length) return salir(2, `No existe ningun restaurante con el nombre corto "${slug}".`);
  const r = filas[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.id)) return salir(1, "La base devolvio un id raro. No se hace nada.");
  if (r.id === ID_DEMO) return salir(2, "NO se borra: ese es el restaurante demo.");
  if (r.slug !== slug || r.slug.indexOf(prefijo) !== 0) return salir(2, "NO se borra: el nombre corto no coincide con el prefijo de prueba.");

  const pedidos = await rest("GET", `pedidos?restaurante_id=eq.${r.id}&select=estado_pago,pagado_en&limit=${TOPE}`);
  if (pedidos.status >= 300) return salir(1, `No pude comprobar si tiene pedidos pagados (HTTP ${pedidos.status}). No se borra nada.`);
  const listaPedidos = JSON.parse(pedidos.texto || "[]");
  if (listaPedidos.length >= TOPE) return salir(2, `NO se borra: tiene ${TOPE} pedidos o mas; un restaurante de prueba no deberia.`);
  if (listaPedidos.some((p) => p.estado_pago === "aprobado" || p.pagado_en)) return salir(2, "NO se borra: este restaurante tiene pedidos PAGADOS (dinero real). Este script no los toca.");

  console.log(`Restaurante: ${r.nombre} (${r.slug}), estado ${r.estado}, id ${r.id.slice(0, 8)}...`);
  const cuentas = [];
  for (const t of TABLAS.concat(EN_CASCADA)) { const c = await contar(t, r.id); cuentas.push([t, c]); console.log(`  ${t.padEnd(24)} ${c.error ? "(no se pudo contar: " + c.error + ")" : c.n + " fila(s)"}${EN_CASCADA.includes(t) ? "  (cae en cascada)" : ""}`); }
  if (!aplicar) { console.log("\nSimulacion: no se borro nada. Para borrar de verdad vuelve a correr con --aplicar."); return 0; }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const escrito = await new Promise((ok) => { rl.on("close", () => ok("")); rl.question(`\nPara confirmar escribe el nombre corto completo (${slug}): `, (x) => { ok(String(x || "").trim()); rl.close(); }); });
  if (escrito !== slug) return salir(2, "No coincide: no se borro nada.");

  for (const t of TABLAS) {
    const d = await rest("DELETE", `${t}?restaurante_id=eq.${r.id}`, { Prefer: "return=minimal" });
    if (d.status >= 300) return salir(1, `Fallo al borrar ${t} (HTTP ${d.status}). Se detuvo; el restaurante sigue existiendo (algo ya borrado no se recupera). Mira el mensaje: ${d.texto.slice(0, 200)}`);
    console.log(`  borrado ${t}`);
  }
  const f = await rest("DELETE", `restaurantes?id=eq.${r.id}&slug=eq.${encodeURIComponent(slug)}`, { Prefer: "return=minimal" });
  if (f.status >= 300) return salir(1, `Fallo al borrar el restaurante (HTTP ${f.status}): ${f.texto.slice(0, 200)}`);

  const sigue = JSON.parse((await rest("GET", `restaurantes?id=eq.${r.id}&select=id`)).texto || "[]").length;
  const demo = JSON.parse((await rest("GET", `restaurantes?id=eq.${ID_DEMO}&select=id`)).texto || "[]").length;
  if (sigue) return salir(1, "El restaurante todavia aparece despues de borrarlo. Revisa en Supabase.");
  if (!demo) return salir(1, "ATENCION: el restaurante demo no aparece. Revisa de inmediato en Supabase.");
  return salir(0, `\nListo: "${slug}" se borro. El restaurante demo sigue intacto. La auditoria conserva la historia; los usuarios de Authentication y las fotos no se tocaron.`);
}

try {
  validarArranque();
  prepararLlave();
  await principal();
} catch (e) {
  if (!(e instanceof Salida)) { console.error("Error inesperado: " + (e && e.message)); process.exitCode = 1; }
}
