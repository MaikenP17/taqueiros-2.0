/* =============================================================
   SUBIR LAS FOTOS DE THE NORTHE BURGERS Y ASIGNARLAS A SUS PRODUCTOS

   El SQL 17 (supabase/17-rebrand-northe.sql) crea los 13 productos nuevos SIN foto. Este script sube las 13
   fotos ya preparadas (JPG 1200x900, menos de 300 KB cada una) al bucket "productos" y guarda la direccion de
   cada una en productos.imagen.

   POR DEFECTO ES UNA SIMULACION: solo lee y dice que haria. No escribe nada, ni archivos ni base.

   USO (PowerShell, desde la raiz del repo; la llave se pega UNA sola vez con Read-Host)
     node supabase/subir-fotos-northe.mjs                 simulacion (no cambia nada)
     node supabase/subir-fotos-northe.mjs --aplicar       sube las fotos y las asigna
   Opciones: --slug=taqueiros (por defecto: el slug NO cambio con el rebrand)
             --carpeta=<ruta>   (por defecto Recursos/NORTHE-NUEVO/listas)
             --forzar           reemplaza tambien un producto que YA tiene otra foto (por defecto lo respeta)

   QUE HACE CON CADA FOTO (en este orden, y solo si la anterior salio bien)
     1. SUBE   <carpeta>/<archivo>  ->  bucket productos, SOLO bajo  <restaurante_id>/<archivo>  (con upsert: si ya
               esta, la reemplaza por la misma; nunca escribe fuera de la carpeta del restaurante).
     2. VERIFICA por la direccion publica que responde 200 y trae EXACTAMENTE los mismos bytes.
     3. ASIGNA productos.imagen = esa direccion publica, solo en el producto de este restaurante y solo si todavia
        esta como se leyo (sin foto, o ya con esta misma). Si alguien le puso otra foto mientras tanto, no se toca.
     4. Comprueba el resultado: el producto apunta a la foto y la foto responde 200.

   GARANTIAS
     * Idempotente: se puede repetir cuantas veces haga falta; lo que ya esta bien lo reconoce y no lo toca.
     * Si el SQL 17 todavia no se aplico (faltan productos nb-*), NO HACE NADA y lo dice.
     * Solo toca los 13 productos nb-* de ESE restaurante y solo escribe en <restaurante_id>/ del bucket.
     * Valida cada archivo antes de empezar (existe, es JPG de verdad, pesa menos de 2 MB que es el limite del
       bucket); si alguno falla no sube ninguno.
     * La llave de servicio se lee de SUPABASE_SERVICE_ROLE_KEY y NUNCA se imprime. Si parece pegada dos veces, no
       hace nada.
   Camino alternativo si algo diera problemas: subir cada foto a mano desde menu-admin.html (docs seccion 20.8).
============================================================= */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { cabecerasSupabase, leerLlaveServicio, tipoDeLlave } = require("../api/_llave.js");

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.join(aqui, "..");

const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
const bandera = (n) => process.argv.includes(`--${n}`);

const APLICAR = bandera("aplicar");
const FORZAR = bandera("forzar");
const SLUG = (arg("slug") || "taqueiros").trim().toLowerCase();
const CARPETA = path.resolve(arg("carpeta") || path.join(raiz, "Recursos", "NORTHE-NUEVO", "listas"));
const SALIDA_MS = Number(process.env.SUBIR_FOTOS_SALIDA_MS ?? 4000);   // solo las pruebas lo acortan

if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(SLUG)) { console.error("--slug no es valido (minusculas, numeros y guiones)."); process.exit(2); }

/* La tabla fija: archivo -> id del producto (los mismos ids que crea el SQL 17). */
const FOTOS = [
  ["big-norte.jpg", "nb-big-norte"],
  ["crispy-norte.jpg", "nb-crispy-norte"],
  ["lil-norte.jpg", "nb-lil-norte"],
  ["classic-norte.jpg", "nb-classic-norte"],
  ["smoky-norte.jpg", "nb-smoky-norte"],
  ["full-norte.jpg", "nb-full-norte"],
  ["creamy-norte.jpg", "nb-creamy-norte"],
  ["dirty-norte.jpg", "nb-dirty-norte"],
  ["chori-norte.jpg", "nb-chori-norte"],
  ["agua.jpg", "nb-agua"],
  ["coca-cola.jpg", "nb-coca-cola"],
  ["pepsi.jpg", "nb-pepsi"],
  ["sprite.jpg", "nb-sprite"]
];
const LIMITE_BYTES = 2097152;                       // el limite del bucket (SQL 01)
const NOMBRE_VALIDO = /^[A-Za-z0-9._-]{1,100}$/;    // el mismo patron que validar_producto() en la base

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

// Direccion publica tal como se guarda en productos.imagen (la misma que exige validar_producto en la base).
// SUBIR_FOTOS_PREFIJO solo lo usan las pruebas locales, donde el servidor falso no tiene la direccion real.
const PREFIJO = process.env.SUBIR_FOTOS_PREFIJO || `${URL_BASE}/storage/v1/object/public/productos/`;

/* ---- red: nunca se imprime la llave ni las cabeceras ----------------------------------------------------- */
async function pedir(metodo, ruta, { cuerpo, extra, crudo } = {}) {
  let r;
  try {
    r = await fetch(`${URL_BASE}${ruta}`, {
      method: metodo,
      headers: { ...H, ...(extra || {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
  } catch (e) {
    throw new Error(`sin conexion con ${metodo} ${ruta.slice(0, 60)} (${String(e.cause?.code || e.message).slice(0, 60)})`);
  }
  if (crudo) return r;
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, ok: r.ok, json: j, texto: t, headers: r.headers };
}
const falla = (r, que) => new Error(`${que}: HTTP ${r.status} ${String(r.texto || "").slice(0, 160)}`);
const rutaCodificada = (nombre) => nombre.split("/").map(encodeURIComponent).join("/");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const linea = (s) => console.log("  " + s);
const kb = (n) => `${Math.round(n / 1024)} KB`;

/* Lee un archivo del bucket por su direccion publica: { existe, bytes, hash } */
async function leerFoto(nombre) {
  const r = await pedir("GET", `/storage/v1/object/public/productos/${rutaCodificada(nombre)}`, { crudo: true });
  if (r.status === 404 || r.status === 400) {
    const t = await r.text();
    if (r.status === 404 || /not.?found|Object not found/i.test(t)) return { existe: false };
    throw new Error(`leer ${nombre}: HTTP ${r.status} ${t.slice(0, 120)}`);
  }
  if (!r.ok) throw new Error(`leer ${nombre}: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length === 0) throw new Error(`leer ${nombre}: la respuesta viene vacia`);
  return { existe: true, bytes: bytes.length, hash: sha(bytes), tipo: r.headers.get("content-type") || "" };
}

/* ---- trabajo ---------------------------------------------------------------------------------------------- */
const resumen = { subidas: 0, yaEstaban: 0, saltadas: 0, errores: 0 };

async function buscarRestaurante(slug) {
  const r = await pedir("GET", `/rest/v1/restaurantes?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nombre`);
  if (!r.ok) throw falla(r, "no pude leer restaurantes");
  if (!Array.isArray(r.json) || r.json.length !== 1) throw new Error(`No existe el restaurante con slug "${slug}".`);
  const f = r.json[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(f.id)) throw new Error("El id del restaurante no es un UUID.");
  return f;
}

async function leerProductos(rid) {
  const ids = FOTOS.map((f) => f[1]).join(",");
  const r = await pedir("GET", `/rest/v1/productos?restaurante_id=eq.${rid}&id=in.(${ids})&select=id,nombre,imagen`);
  if (!r.ok) throw falla(r, "no pude leer los productos");
  if (!Array.isArray(r.json)) throw new Error("productos: respuesta inesperada");
  return new Map(r.json.map((p) => [p.id, p]));
}

/* Revisa los archivos locales ANTES de tocar nada. Devuelve { archivos: Map(nombre -> {bytes, hash}), problemas: [] } */
function revisarArchivos() {
  const archivos = new Map();
  const problemas = [];
  for (const [archivo] of FOTOS) {
    if (!NOMBRE_VALIDO.test(archivo)) { problemas.push(`${archivo}: el nombre no es de los que acepta la base`); continue; }
    const ruta = path.join(CARPETA, archivo);
    let b;
    try { b = fs.readFileSync(ruta); } catch { problemas.push(`${archivo}: no existe en ${CARPETA}`); continue; }
    if (b.length < 1000 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) { problemas.push(`${archivo}: no parece un JPG de verdad`); continue; }
    if (b.length >= LIMITE_BYTES) { problemas.push(`${archivo}: pesa ${kb(b.length)} y el bucket acepta menos de 2 MB`); continue; }
    archivos.set(archivo, { bytes: b, hash: sha(b) });
  }
  return { archivos, problemas };
}

async function subirFoto(rid, archivo, bytes) {
  const nombre = `${rid}/${archivo}`;
  let r;
  try {
    r = await fetch(`${URL_BASE}/storage/v1/object/productos/${rutaCodificada(nombre)}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "image/jpeg", "x-upsert": "true" },
      body: bytes
    });
  } catch (e) {
    throw new Error(`sin conexion al subir ${archivo} (${String(e.cause?.code || e.message).slice(0, 60)})`);
  }
  const t = await r.text();
  if (!r.ok) throw new Error(`subir ${archivo}: HTTP ${r.status} ${t.slice(0, 160)}`);
}

/* Asigna la foto solo si el producto sigue como se leyo. true = cambio una fila. */
async function asignarImagen(rid, id, actual, nueva) {
  const filtro = actual === null || actual === undefined ? "imagen=is.null" : `imagen=eq.${encodeURIComponent(actual)}`;
  const r = await pedir("PATCH", `/rest/v1/productos?restaurante_id=eq.${rid}&id=eq.${encodeURIComponent(id)}&${filtro}`,
    { cuerpo: { imagen: nueva }, extra: { Prefer: "return=representation" } });
  if (!r.ok) throw falla(r, `no pude asignar la foto del producto ${id}`);
  return Array.isArray(r.json) && r.json.length === 1;
}

async function principal() {
  const rest = await buscarRestaurante(SLUG);
  const rid = rest.id;

  console.log(`${APLICAR ? "APLICANDO" : "SIMULACION (no se cambia nada)"} - fotos de ${rest.nombre} (${rest.slug})`);
  console.log(`Proyecto: ${URL_BASE.replace(/^https:\/\//, "")}`);
  console.log(`Carpeta de fotos: ${CARPETA}`);
  if (!APLICAR) console.log("\n(Para subir de verdad: --aplicar)");

  // 1. archivos locales
  const { archivos, problemas } = revisarArchivos();
  if (problemas.length) {
    console.error("\nNO SE HIZO NADA. Hay problemas con las fotos locales:");
    for (const p of problemas) console.error("  - " + p);
    return terminar(2);
  }

  // 2. el SQL 17 tiene que estar aplicado: los 13 productos tienen que existir
  const productos = await leerProductos(rid);
  const faltan = FOTOS.map((f) => f[1]).filter((id) => !productos.has(id));
  if (faltan.length) {
    console.error(`\nNO SE HIZO NADA. Faltan ${faltan.length} de ${FOTOS.length} productos (${faltan.slice(0, 4).join(", ")}${faltan.length > 4 ? ", ..." : ""}).`);
    console.error("El SQL 17 todavia no se aplico en este proyecto: corre primero supabase/17-rebrand-northe.sql (docs seccion 20).");
    return terminar(2);
  }

  // 3. foto por foto
  console.log(`\n${FOTOS.length} foto(s) para los productos de ${rest.slug}:`);
  for (const [archivo, id] of FOTOS) {
    const local = archivos.get(archivo);
    const nombre = `${rid}/${archivo}`;
    const url = PREFIJO + rutaCodificada(nombre);
    const p = productos.get(id);
    try {
      const remota = await leerFoto(nombre);
      const subir = !remota.existe || remota.hash !== local.hash;
      const apunta = p.imagen === url;
      const ajena = p.imagen !== null && p.imagen !== undefined && p.imagen !== "" && !apunta;
      if (ajena && !FORZAR) {
        linea(`SALTA  ${archivo}: ${id} ya tiene OTRA foto (${String(p.imagen).slice(0, 60)}...). No se toca; con --forzar se reemplaza.`);
        resumen.saltadas++;
        continue;
      }
      if (!subir && apunta) { linea(`YA     ${archivo}  ->  ${id}   (${kb(local.bytes.length)}, ya esta subida y asignada)`); resumen.yaEstaban++; continue; }
      const acciones = [subir && "subir", !apunta && "asignar al producto", "verificar"].filter(Boolean).join(" > ");
      if (!APLICAR) { linea(`${archivo}  ->  ${nombre}   [${kb(local.bytes.length)}]   ${acciones}`); resumen.subidas++; continue; }

      // 1. SUBIR
      if (subir) await subirFoto(rid, archivo, local.bytes);
      // 2. VERIFICAR la direccion publica (200 y los mismos bytes)
      const V = await leerFoto(nombre);
      if (!V.existe || V.hash !== local.hash) throw new Error("la direccion publica no responde con el mismo contenido; no se asigna al producto");
      // 3. ASIGNAR
      if (!apunta) {
        const ok = await asignarImagen(rid, id, ajena ? p.imagen : (p.imagen ?? null), url);
        if (!ok) { linea(`SALTA  ${archivo}: ${id} cambio de foto mientras corria el script; no se toco.`); resumen.saltadas++; continue; }
      }
      // 4. COMPROBAR el resultado
      const rel = await pedir("GET", `/rest/v1/productos?restaurante_id=eq.${rid}&id=eq.${encodeURIComponent(id)}&select=imagen`);
      const F = await leerFoto(nombre);
      if (!rel.ok || !Array.isArray(rel.json) || rel.json[0]?.imagen !== url || !F.existe || F.hash !== local.hash) {
        throw new Error("despues de asignarla, el producto o la foto no quedaron como se esperaba");
      }
      linea(`OK     ${archivo}  ->  ${id}   (${kb(local.bytes.length)}, responde 200)`);
      resumen.subidas++;
    } catch (err) {
      linea(`ERROR  ${archivo}: ${err.message}`);
      resumen.errores++;
    }
  }
  fin();
}

/* Sale sin process.exit() inmediato: en Windows cerrar de golpe con conexiones de fetch abiertas imprime una
   "Assertion failed ... async.c" y pierde el codigo de salida. Se deja drenar y, si algo la retiene, se fuerza. */
function terminar(codigo) {
  process.exitCode = codigo;
  setTimeout(() => process.exit(), SALIDA_MS).unref();
}

function fin() {
  console.log("");
  console.log(`Resumen: ${resumen.subidas} ${APLICAR ? "subida(s) y asignada(s)" : "por subir"}, ${resumen.yaEstaban} ya estaban, ${resumen.saltadas} saltada(s), ${resumen.errores} con error.`);
  if (!APLICAR && resumen.subidas) console.log("Si todo se ve bien: node supabase/subir-fotos-northe.mjs --aplicar");
  if (APLICAR && !resumen.errores && !resumen.saltadas) console.log("Listo: abre el sitio (o refrescalo con Ctrl+F5) y las 13 fotos deben verse. El menu puede tardar hasta 5 minutos en actualizarse.");
  if (resumen.errores) console.log("Hubo errores: vuelve a correr el script (retoma lo pendiente) o sube esa foto a mano desde menu-admin.html.");
  terminar(resumen.errores ? 1 : 0);
}

principal().catch((e) => {
  console.error("\nERROR: " + String(e.message || e).slice(0, 400));
  terminar(1);
});
