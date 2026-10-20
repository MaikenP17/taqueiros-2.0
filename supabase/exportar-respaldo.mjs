/* =============================================================
   RESPALDO PREVIO A LA MIGRACION MULTI-RESTAURANTE
   Exporta TODAS las tablas de public a archivos JSON, paginando,
   y guarda ademas la lista de usuarios de Auth y la lista de fotos
   del bucket. SOLO LEE: no modifica nada en la base.

   Sale en  respaldos/<fecha-hora>/   (la carpeta esta en .gitignore:
   los respaldos tienen datos de clientes y NUNCA se suben al repo).

   La llave secreta se lee de la variable de entorno
   SUPABASE_SERVICE_ROLE_KEY (sb_secret_... o service_role legacy).
   No la escribas en ningun archivo. Comando de PowerShell completo en
   docs/multirestaurante.md (seccion "Orden de pasos").

   Que imprime: cuantas filas exporto por tabla, comparadas con el
   total que informa la base. Si alguna no coincide, sale con codigo 1.
============================================================= */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { cabecerasSupabase, leerLlaveServicio, tipoDeLlave } = require("../api/_llave.js");

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.join(aqui, "..");

// URL del proyecto: la misma copia que usan las paginas
const publico = fs.readFileSync(path.join(raiz, "supabase-publico.js"), "utf8");
const URL_BASE = (process.env.SUPABASE_URL || (publico.match(/url:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");
if (!URL_BASE) { console.error("No pude determinar la URL del proyecto (supabase-publico.js o SUPABASE_URL)."); process.exit(2); }

let LLAVE;
try { LLAVE = leerLlaveServicio(); } catch (e) { console.error(e.message); process.exit(2); }

// Un pegado doble (Ctrl+V + clic derecho) deja la llave repetida: se detecta antes de usarla.
if (tipoDeLlave(LLAVE) === "secreta" && LLAVE.split("sb_secret_").length !== 2) {
  console.error("La llave parece pegada DOS veces. Vuelve a correr el comando y pegala una sola vez (clic derecho O Ctrl+V, no ambos).");
  process.exit(2);
}
if (tipoDeLlave(LLAVE) === "legacy" && LLAVE.split(".").length !== 3) {
  console.error("La llave legacy no tiene forma de JWT (3 partes). Si la pegaste dos veces, vuelve a intentarlo con un solo pegado.");
  process.exit(2);
}

const H = cabecerasSupabase(LLAVE);
const PAGINA = 1000;

// Tablas conocidas por el repo, con la columna para ordenar la paginacion
// (sin un orden estable, paginar puede repetir o saltar filas).
const CONOCIDAS = {
  pedidos: "id",
  categorias: "id",
  productos: "id",
  configuracion: "id",
  salud_notificaciones: "id",
  personal: "id",
  // Tablas del SQL 10 (si ya se corrio y se vuelve a respaldar)
  restaurantes: "id",
  miembros: "user_id",
  superadmins: "user_id",
  restaurante_secretos: "restaurante_id",
  contadores_pedido: "restaurante_id",
  tarifas_domicilio: "id"
};

async function json(resp) {
  const t = await resp.text();
  try { return JSON.parse(t); } catch { return t; }
}

/* Descubre las tablas que expone PostgREST (por si hay alguna que el repo no conoce). */
async function descubrirTablas() {
  try {
    const r = await fetch(`${URL_BASE}/rest/v1/`, { headers: { ...H, Accept: "application/openapi+json" } });
    if (!r.ok) return [];
    const doc = await r.json();
    const defs = doc.definitions || (doc.components && doc.components.schemas) || {};
    return Object.keys(defs);
  } catch { return []; }
}

async function exportarTabla(tabla, orden) {
  const filas = [];
  let total = null;
  for (;;) {
    const desde = filas.length;
    const q = `select=*${orden ? `&order=${orden}.asc` : ""}`;
    const r = await fetch(`${URL_BASE}/rest/v1/${encodeURIComponent(tabla)}?${q}`, {
      headers: { ...H, Range: `${desde}-${desde + PAGINA - 1}`, "Range-Unit": "items", Prefer: "count=exact" }
    });
    if (r.status === 404) return { existe: false };
    const cuerpo = await json(r);
    // La tabla no tiene esa columna para ordenar: se reintenta sin orden
    if (r.status === 400 && orden && filas.length === 0) return exportarTabla(tabla, null);
    if (!r.ok && r.status !== 206) throw new Error(`${tabla}: HTTP ${r.status} ${JSON.stringify(cuerpo).slice(0, 200)}`);
    if (!Array.isArray(cuerpo)) throw new Error(`${tabla}: respuesta inesperada`);
    const m = (r.headers.get("content-range") || "").match(/\/(\d+)$/);   // "0-999/1234"
    if (m) total = Number(m[1]);
    filas.push(...cuerpo);
    // El servidor puede entregar menos que PAGINA (limite propio): se sigue hasta completar el total
    if (cuerpo.length === 0 || (total !== null && filas.length >= total) || (total === null && cuerpo.length < PAGINA)) break;
  }
  return { existe: true, filas, total };
}

const marca = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const carpeta = path.join(raiz, "respaldos", marca);
fs.mkdirSync(carpeta, { recursive: true });

console.log(`Respaldo de ${URL_BASE.replace(/^https:\/\//, "")}`);
console.log(`Carpeta: ${carpeta}\n`);

let problemas = 0;
const resumen = [];

const extra = (await descubrirTablas()).filter((t) => !(t in CONOCIDAS));
const lista = [...Object.entries(CONOCIDAS), ...extra.map((t) => [t, "id"])];

for (const [tabla, orden] of lista) {
  try {
    const r = await exportarTabla(tabla, orden);
    if (!r.existe) {
      if (tabla in CONOCIDAS && ["restaurantes", "miembros", "superadmins", "restaurante_secretos", "contadores_pedido", "tarifas_domicilio"].includes(tabla)) continue; // aun no existe: normal
      console.log(`  ${tabla.padEnd(24)} (no existe, se omite)`);
      continue;
    }
    fs.writeFileSync(path.join(carpeta, `${tabla}.json`), JSON.stringify(r.filas, null, 2));
    const coincide = r.total === null || r.total === r.filas.length;
    if (!coincide) problemas++;
    console.log(`  ${tabla.padEnd(24)} ${String(r.filas.length).padStart(7)} filas exportadas` +
      (coincide ? "" : `   <-- LA BASE DICE ${r.total}: NO COINCIDE`));
    resumen.push({ tabla, exportadas: r.filas.length, total_base: r.total });
  } catch (e) {
    problemas++;
    console.log(`  ${tabla.padEnd(24)} ERROR: ${e.message}`);
  }
}

// Usuarios de Auth (sin contrasenas: la API no las entrega)
try {
  const usuarios = [];
  for (let pagina = 1; ; pagina++) {
    const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=${pagina}&per_page=200`, { headers: H });
    const cuerpo = await json(r);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(cuerpo).slice(0, 150)}`);
    const lote = cuerpo.users || [];
    usuarios.push(...lote.map((u) => ({
      id: u.id, email: u.email, creado: u.created_at, ultimo_acceso: u.last_sign_in_at, confirmado: !!u.email_confirmed_at
    })));
    if (lote.length < 200) break;
  }
  fs.writeFileSync(path.join(carpeta, "auth_usuarios.json"), JSON.stringify(usuarios, null, 2));
  console.log(`  ${"auth.users".padEnd(24)} ${String(usuarios.length).padStart(7)} usuarios (id, correo, fechas)`);
} catch (e) {
  console.log(`  auth.users               no se pudo listar: ${e.message}`);
}

// Lista de fotos del bucket 'productos' (los archivos no se descargan)
try {
  const fotos = [];
  for (let off = 0; ; off += 100) {
    const r = await fetch(`${URL_BASE}/storage/v1/object/list/productos`, {
      method: "POST", headers: H,
      body: JSON.stringify({ prefix: "", limit: 100, offset: off, sortBy: { column: "name", order: "asc" } })
    });
    const cuerpo = await json(r);
    if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(cuerpo).slice(0, 150)}`);
    fotos.push(...cuerpo);
    if (cuerpo.length < 100) break;
  }
  fs.writeFileSync(path.join(carpeta, "storage_productos.json"), JSON.stringify(fotos, null, 2));
  console.log(`  ${"storage: productos".padEnd(24)} ${String(fotos.length).padStart(7)} objetos en la raiz (solo la lista)`);
} catch (e) {
  console.log(`  storage: productos       no se pudo listar (si el bucket aun no existe es normal): ${e.message.slice(0, 100)}`);
}

fs.writeFileSync(path.join(carpeta, "_resumen.json"), JSON.stringify({ proyecto: URL_BASE, fecha: new Date().toISOString(), tablas: resumen }, null, 2));

console.log(problemas
  ? `\n${problemas} problema(s). NO corras el SQL de migracion hasta resolverlos.`
  : `\nRespaldo completo en ${carpeta}\nGuarda esa carpeta fuera del repositorio (tiene datos de clientes).`);
process.exitCode = problemas ? 1 : 0;
// Sin process.exit(): en Windows, salir de golpe con conexiones de fetch cerrandose imprime una
// "Assertion failed ... async.c". Se deja drenar y, si algo la retiene, se fuerza a los 4 s.
setTimeout(() => process.exit(), 4000).unref();
