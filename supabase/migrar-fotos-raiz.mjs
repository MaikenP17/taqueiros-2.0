/* =============================================================
   MOVER LAS FOTOS DE LA RAIZ DEL BUCKET 'productos' A {restaurante_id}/

   Las fotos que se subieron antes del multi-restaurante estan en la RAIZ del bucket y sus
   direcciones estan guardadas en productos.imagen. Este script las pasa a la carpeta del
   restaurante (la unica que el dueno puede escribir cuando se corra el SQL 14).

   POR DEFECTO ES UNA SIMULACION: solo lee y dice que haria. No escribe nada, ni archivos ni base.

   USO (PowerShell, desde la raiz del repo; la llave se pega UNA sola vez con Read-Host)
     node supabase/migrar-fotos-raiz.mjs                       simulacion (no cambia nada)
     node supabase/migrar-fotos-raiz.mjs --aplicar             mueve las fotos de Taqueiros
     node supabase/migrar-fotos-raiz.mjs --aplicar --no-borrar copia y cambia la direccion, pero deja las antiguas
     node supabase/migrar-fotos-raiz.mjs --deshacer=<registro> simulacion de la reversa
     node supabase/migrar-fotos-raiz.mjs --deshacer=<registro> --aplicar   devuelve las fotos a la raiz
   Opciones: --slug=taqueiros (por defecto)   --registro=<ruta del registro JSON>
             --respaldo-max-horas=24 (antiguedad maxima de la copia de seguridad)

   QUE HACE CON CADA FOTO (en este orden, y solo si la anterior salio bien)
     1. COPIA  raiz/<archivo>  ->  <restaurante_id>/<archivo>   (nunca pisa un archivo que ya exista)
     2. ACTUALIZA productos.imagen de los productos de ESE restaurante que la usan (solo si todavia
        tienen la direccion antigua: si alguien la cambio mientras tanto, no se toca)
     3. VERIFICA que la direccion publica nueva responde y trae EXACTAMENTE los mismos bytes
        (si no, devuelve el producto a la direccion antigua y no borra nada)
     4. BORRA la antigua, solo despues de comprobar que ningun producto la usa

   GARANTIAS
     * Idempotente y reanudable: se puede cortar en cualquier punto (Ctrl+C, internet, apagon) y volver a
       correr; el estado se deduce de lo que hay en Storage y en la base, ayudado por el registro.
     * Solo toca fotos que usa algun producto del restaurante indicado. No toca: fotos de otro restaurante,
       archivos que ningun producto usa, fotos del sitio (Recursos/...) ni nada fuera de la raiz.
       Si una foto de la raiz la usa ademas un producto de OTRO restaurante, no se mueve.
     * Escribe un registro JSON con el mapa antiguo -> nuevo y los productos afectados
       (por defecto respaldos/migracion-fotos-<slug>.json, carpeta ignorada por git) para poder deshacer.
     * Para --aplicar exige una copia de seguridad RECIENTE hecha con supabase/exportar-respaldo.mjs
       (misma base, menos de 24 h, todas las tablas coinciden). Sin ella no hace nada.
     * La llave de servicio se lee de SUPABASE_SERVICE_ROLE_KEY y NUNCA se imprime. Si parece pegada
       dos veces, no hace nada.
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
const NO_BORRAR = bandera("no-borrar");
const SLUG = (arg("slug") || "taqueiros").trim().toLowerCase();
const DESHACER = arg("deshacer");
const MAX_HORAS = Number(arg("respaldo-max-horas") || 24);
const SALIDA_MS = Number(process.env.MIGRAR_FOTOS_SALIDA_MS ?? 4000);   // solo las pruebas lo acortan
const RESPALDOS = process.env.RESPALDOS_DIR || path.join(raiz, "respaldos");
const REGISTRO = arg("registro") || path.join(RESPALDOS, `migracion-fotos-${SLUG}.json`);

if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(SLUG)) { console.error("--slug no es valido (minusculas, numeros y guiones)."); process.exit(2); }
if (!(MAX_HORAS > 0)) { console.error("--respaldo-max-horas debe ser un numero mayor que 0."); process.exit(2); }

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
// MIGRAR_FOTOS_PREFIJO solo lo usan las pruebas locales, donde el servidor falso no tiene la direccion real.
const PREFIJO = process.env.MIGRAR_FOTOS_PREFIJO || `${URL_BASE}/storage/v1/object/public/productos/`;
const NOMBRE_VALIDO = /^[A-Za-z0-9._-]{1,100}$/;   // el mismo patron que validar_producto()

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

function rutaCodificada(nombre) { return nombre.split("/").map(encodeURIComponent).join("/"); }
const urlPublica = (nombre) => PREFIJO + rutaCodificada(nombre);

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
  return { existe: true, bytes: bytes.length, hash: crypto.createHash("sha256").update(bytes).digest("hex") };
}

/* ---- base de datos ----------------------------------------------------------------------------------------- */
async function listarProductos() {
  const filas = [];
  for (;;) {
    const desde = filas.length;
    const r = await pedir("GET", "/rest/v1/productos?select=restaurante_id,id,nombre,imagen&order=restaurante_id.asc,id.asc",
      { extra: { Range: `${desde}-${desde + 999}`, "Range-Unit": "items", Prefer: "count=exact" } });
    if (!r.ok && r.status !== 206) throw falla(r, "no pude leer los productos");
    if (!Array.isArray(r.json)) throw new Error("productos: respuesta inesperada");
    filas.push(...r.json);
    const m = (r.headers.get("content-range") || "").match(/\/(\d+)$/);
    const total = m ? Number(m[1]) : null;
    if (r.json.length === 0 || (total !== null && filas.length >= total) || (total === null && r.json.length < 1000)) break;
  }
  return filas;
}

async function buscarRestaurante(slug) {
  const r = await pedir("GET", `/rest/v1/restaurantes?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nombre`);
  if (!r.ok) throw falla(r, "no pude leer restaurantes");
  if (!Array.isArray(r.json) || r.json.length !== 1) throw new Error(`No existe el restaurante con slug "${slug}".`);
  const f = r.json[0];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(f.id)) throw new Error("El id del restaurante no es un UUID.");
  return f;
}

/* Cambia la foto de UN producto solo si todavia tiene la direccion esperada. true = cambio una fila. */
async function cambiarImagen(rid, id, de, a) {
  const r = await pedir("PATCH",
    `/rest/v1/productos?restaurante_id=eq.${rid}&id=eq.${encodeURIComponent(id)}&imagen=eq.${encodeURIComponent(de)}`,
    { cuerpo: { imagen: a }, extra: { Prefer: "return=representation" } });
  if (!r.ok) throw falla(r, `no pude cambiar la foto del producto ${id}`);
  return Array.isArray(r.json) && r.json.length === 1;
}

/* ---- clasificacion de productos.imagen ----------------------------------------------------------------------- */
function clasificar(imagen, rid) {
  if (typeof imagen !== "string" || !imagen) return { tipo: "sin-foto" };
  if (!imagen.startsWith(PREFIJO)) return { tipo: /^Recursos\//.test(imagen) ? "sitio" : "externa" };
  let nombre;
  try { nombre = decodeURIComponent(imagen.slice(PREFIJO.length).split(/[?#]/)[0]); } catch { return { tipo: "rara" }; }
  if (!nombre) return { tipo: "rara" };
  if (!nombre.includes("/")) return { tipo: "raiz", nombre };
  if (nombre.startsWith(rid + "/") && nombre.split("/").length === 2) return { tipo: "carpeta-propia", nombre };
  return { tipo: "otra-carpeta", nombre };
}

/* ---- registro ------------------------------------------------------------------------------------------------- */
function leerRegistro() {
  try {
    const j = JSON.parse(fs.readFileSync(REGISTRO, "utf8"));
    if (j && j.proyecto === URL_BASE && Array.isArray(j.fotos)) return j;
  } catch { /* no hay registro (o no es de este proyecto) */ }
  return null;
}
function guardarRegistro(reg) {
  reg.actualizado = new Date().toISOString();
  fs.mkdirSync(path.dirname(REGISTRO), { recursive: true });
  const tmp = REGISTRO + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, REGISTRO);
}

/* ---- copia de seguridad reciente ------------------------------------------------------------------------------ */
function comprobarRespaldo() {
  const recuerdo = "Haz primero el respaldo:  node supabase/exportar-respaldo.mjs   (y revisa que diga 'Respaldo completo').";
  let carpetas = [];
  try { carpetas = fs.readdirSync(RESPALDOS, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(d.name)).map((d) => d.name).sort(); } catch { /* no existe */ }
  if (!carpetas.length) return `No encontre ninguna copia de seguridad en ${RESPALDOS}. ${recuerdo}`;
  const nombre = carpetas[carpetas.length - 1];
  let res;
  try { res = JSON.parse(fs.readFileSync(path.join(RESPALDOS, nombre, "_resumen.json"), "utf8")); } catch { return `La copia ${nombre} esta incompleta (falta _resumen.json). ${recuerdo}`; }
  if (res.proyecto !== URL_BASE) return `La copia ${nombre} es de otro proyecto de Supabase. ${recuerdo}`;
  const t = Date.parse(res.fecha);
  if (!Number.isFinite(t)) return `La copia ${nombre} no tiene fecha valida. ${recuerdo}`;
  const horas = (Date.now() - t) / 3600000;
  if (horas > MAX_HORAS || horas < -1) return `La copia de seguridad mas reciente (${nombre}) tiene ${horas.toFixed(1)} horas; el maximo es ${MAX_HORAS}. ${recuerdo}`;
  const tablas = Array.isArray(res.tablas) ? res.tablas : [];
  const prod = tablas.find((x) => x.tabla === "productos");
  if (!prod) return `La copia ${nombre} no incluye la tabla productos. ${recuerdo}`;
  const malas = tablas.filter((x) => x.total_base !== null && x.total_base !== undefined && x.exportadas !== x.total_base).map((x) => x.tabla);
  if (malas.length) return `La copia ${nombre} no coincide con la base en: ${malas.join(", ")}. ${recuerdo}`;
  if (!fs.existsSync(path.join(RESPALDOS, nombre, "productos.json"))) return `A la copia ${nombre} le falta productos.json. ${recuerdo}`;
  return null;
}

/* ---- trabajo por foto ------------------------------------------------------------------------------------------ */
const ctx = { rid: null, productos: [], registro: null };
const resumen = { movidas: 0, yaEstaban: 0, saltadas: 0, errores: 0, rotas: 0, pendientesTerminadas: 0 };
const linea = (s) => console.log("  " + s);

function entradaDe(viejo) {
  let e = ctx.registro.fotos.find((x) => x.viejo === viejo);
  if (!e) {
    e = { viejo, nuevo: `${ctx.rid}/${viejo}`, estado: "iniciada", bytes: null, hash: null, productos: [], inicio: new Date().toISOString() };
    ctx.registro.fotos.push(e);
  }
  return e;
}
function paso(e, estado, extra) {
  e.estado = estado;
  if (extra) Object.assign(e, extra);
  guardarRegistro(ctx.registro);
}

/* ¿Algun producto (de cualquier restaurante) usa todavia esta direccion antigua? */
async function usosDeLaAntigua(viejo) {
  const filas = await listarProductos();
  return filas.filter((p) => { const c = clasificar(p.imagen, p.restaurante_id); return c.tipo === "raiz" && c.nombre === viejo; });
}

/* Mueve UNA foto de la raiz. 'grupo' = { viejo, propios:[producto], ajenos:[producto] } */
async function moverFoto(grupo, aplicar) {
  const { viejo } = grupo;
  const nuevo = `${ctx.rid}/${viejo}`;
  const etiqueta = `${viejo}  ->  ${nuevo}`;

  if (!NOMBRE_VALIDO.test(viejo)) { linea(`SALTA  ${viejo}: el nombre del archivo no es de los que acepta la base (letras, numeros, . _ -). No se toca.`); resumen.saltadas++; return; }
  if (grupo.ajenos.length) {
    linea(`SALTA  ${viejo}: tambien la usa(n) ${grupo.ajenos.length} producto(s) de OTRO restaurante. No se toca.`);
    resumen.saltadas++; return;
  }

  const S = await leerFoto(viejo);
  const D = await leerFoto(nuevo);

  if (!S.existe && !D.existe) {
    linea(`ROTA   ${viejo}: ya no existe en Storage (ni la nueva). Producto(s): ${grupo.propios.map((p) => p.nombre || p.id).join(", ")}. Cambia o quita su foto en menu-admin.`);
    resumen.rotas++; return;
  }
  if (S.existe && D.existe && S.hash !== D.hash) {
    linea(`ERROR  ${viejo}: en ${nuevo} ya hay OTRO archivo distinto. No se pisa nada; revisalo a mano.`);
    resumen.errores++; return;
  }

  const hayQueCopiar = S.existe && !D.existe;
  const hayQueActualizar = grupo.propios.length;
  const hayQueBorrar = S.existe && !NO_BORRAR;
  const acciones = [hayQueCopiar && "copiar", hayQueActualizar && `cambiar ${hayQueActualizar} producto(s)`, "verificar", hayQueBorrar && "borrar la antigua"].filter(Boolean).join(" > ");
  if (!aplicar) { linea(`${etiqueta}   [${S.bytes ?? D.bytes} bytes]   ${acciones}`); resumen.movidas++; return; }

  const e = entradaDe(viejo);
  const hash = (S.existe ? S : D).hash;
  const bytes = (S.existe ? S : D).bytes;
  paso(e, e.estado === "borrada" ? "iniciada" : e.estado, { bytes, hash });

  try {
    // 1. COPIAR
    if (hayQueCopiar) {
      const r = await pedir("POST", "/storage/v1/object/copy", { cuerpo: { bucketId: "productos", sourceKey: viejo, destinationKey: nuevo } });
      if (!r.ok && r.status !== 409) throw falla(r, "copiar");
      const otra = await leerFoto(nuevo);
      if (!otra.existe || otra.hash !== hash) throw new Error("la copia no aparece o no coincide con el original; no se cambia nada");
      paso(e, "copiada");
    }

    // 2. ACTUALIZAR los productos del restaurante que todavia usan la direccion antigua
    const cambiados = e.productos.slice();
    for (const p of grupo.propios) {
      const ok = await cambiarImagen(ctx.rid, p.id, p.imagen, urlPublica(nuevo));
      if (ok) { if (!cambiados.some((x) => x.id === p.id)) cambiados.push({ id: p.id, imagen_antigua: p.imagen }); }
      else linea(`  aviso: el producto ${p.id} cambio de foto mientras corria el script; no se toco.`);
      paso(e, "actualizada", { productos: cambiados });
    }
    if (!grupo.propios.length) paso(e, e.estado === "iniciada" ? "actualizada" : e.estado);

    // 3. VERIFICAR la direccion publica nueva (200 y los mismos bytes)
    const V = await leerFoto(nuevo);
    if (!V.existe || V.hash !== hash) {
      // vuelve atras: los productos a la direccion antigua (que sigue existiendo) y no borra nada
      if (S.existe) for (const c of cambiados) { try { await cambiarImagen(ctx.rid, c.id, urlPublica(nuevo), c.imagen_antigua); } catch { /* se reporta abajo */ } }
      throw new Error("la direccion nueva no responde con el mismo contenido; se devolvieron los productos a la direccion antigua y no se borro nada");
    }
    paso(e, "verificada");

    // 4. BORRAR la antigua, solo si nadie la usa
    if (hayQueBorrar) {
      const usos = await usosDeLaAntigua(viejo);
      if (usos.length) throw new Error(`todavia la usan ${usos.length} producto(s); no se borra`);
      const r = await pedir("DELETE", "/storage/v1/object/productos", { cuerpo: { prefixes: [viejo] } });
      if (!r.ok) throw falla(r, "borrar la antigua");
      const x = await leerFoto(viejo);
      if (x.existe) throw new Error("la antigua sigue en Storage despues de borrarla");
      paso(e, "borrada", { fin: new Date().toISOString() });
    } else {
      paso(e, "verificada");
    }
    linea(`OK     ${etiqueta}`);
    resumen.movidas++;
  } catch (err) {
    paso(e, "error", { error: String(err.message).slice(0, 300) });
    linea(`ERROR  ${viejo}: ${err.message}`);
    resumen.errores++;
  }
}

/* Foto que quedo a medias en una corrida anterior (el registro lo dice) y ya no la usa ningun producto de la raiz */
async function terminarPendiente(entrada, aplicar) {
  const viejo = entrada.viejo, nuevo = entrada.nuevo;
  const S = await leerFoto(viejo);
  const D = await leerFoto(nuevo);
  if (!S.existe) { if (aplicar) { entrada.estado = "borrada"; guardarRegistro(ctx.registro); } return; }
  if (!D.existe || D.hash !== S.hash) {
    linea(`PEND   ${viejo}: quedo a medias y la copia nueva no esta completa. Se retomara si algun producto la usa; si no, revisala a mano.`);
    return;
  }
  const usos = await usosDeLaAntigua(viejo);
  if (usos.length) return;   // lo retoma el flujo normal
  if (NO_BORRAR) { linea(`PEND   ${viejo}: ya cambiada y verificada; falta borrar la antigua (corre sin --no-borrar).`); return; }
  if (!aplicar) { linea(`${viejo} (pendiente de una corrida anterior)   verificar > borrar la antigua`); resumen.pendientesTerminadas++; return; }
  try {
    const r = await pedir("DELETE", "/storage/v1/object/productos", { cuerpo: { prefixes: [viejo] } });
    if (!r.ok) throw falla(r, "borrar la antigua");
    paso(entrada, "borrada", { fin: new Date().toISOString() });
    linea(`OK     ${viejo}: pendiente de una corrida anterior, ya terminada`);
    resumen.pendientesTerminadas++;
  } catch (err) {
    paso(entrada, "error", { error: String(err.message).slice(0, 300) });
    linea(`ERROR  ${viejo}: ${err.message}`);
    resumen.errores++;
  }
}

/* ---- deshacer ---------------------------------------------------------------------------------------------- */
async function deshacer(aplicar) {
  let reg;
  try { reg = JSON.parse(fs.readFileSync(DESHACER, "utf8")); } catch { console.error(`No pude leer el registro ${DESHACER}.`); return 2; }
  if (reg.proyecto !== URL_BASE || !Array.isArray(reg.fotos)) { console.error("Ese registro no es de este proyecto de Supabase."); return 2; }
  const rest = await buscarRestaurante(reg.slug || SLUG);
  if (reg.restaurante_id && reg.restaurante_id !== rest.id) { console.error("El registro es de otro restaurante."); return 2; }
  ctx.rid = rest.id;
  console.log(`${aplicar ? "DESHACER (aplicando)" : "DESHACER (simulacion)"} - ${rest.nombre} (${rest.slug})\n`);

  for (const e of reg.fotos) {
    if (!["verificada", "borrada", "actualizada", "copiada"].includes(e.estado)) { linea(`SALTA  ${e.viejo}: estado "${e.estado}", nada que deshacer`); continue; }
    const S = await leerFoto(e.viejo);
    const D = await leerFoto(e.nuevo);
    if (!D.existe) { linea(`SALTA  ${e.viejo}: la copia nueva ya no existe; no se puede deshacer esta foto`); resumen.saltadas++; continue; }
    if (S.existe && S.hash !== D.hash) { linea(`ERROR  ${e.viejo}: en la raiz hay OTRO archivo con ese nombre; no se pisa`); resumen.errores++; continue; }
    if (!aplicar) { linea(`${e.nuevo}  ->  ${e.viejo}   ${S.existe ? "" : "copiar de vuelta > "}devolver ${e.productos.length} producto(s) > verificar > borrar la copia nueva`); resumen.movidas++; continue; }
    let copiadaAhora = false, cambioAlgo = false;
    try {
      if (!S.existe) {
        const r = await pedir("POST", "/storage/v1/object/copy", { cuerpo: { bucketId: "productos", sourceKey: e.nuevo, destinationKey: e.viejo } });
        if (!r.ok && r.status !== 409) throw falla(r, "copiar de vuelta");
        copiadaAhora = r.ok;
      }
      const S2 = await leerFoto(e.viejo);
      if (!S2.existe || S2.hash !== D.hash) throw new Error("la copia de vuelta no coincide; no se cambia nada");
      for (const p of e.productos) {
        const ok = await cambiarImagen(ctx.rid, p.id, urlPublica(e.nuevo), p.imagen_antigua);
        if (ok) cambioAlgo = true;
        else linea(`  aviso: el producto ${p.id} ya no apuntaba a la direccion nueva; no se toco.`);
      }
      const V = await leerFoto(e.viejo);
      if (!V.existe || V.hash !== D.hash) throw new Error("la direccion antigua no responde bien; no se borra la nueva");
      const usan = (await listarProductos()).filter((p) => p.imagen === urlPublica(e.nuevo));
      if (usan.length) throw new Error("todavia hay productos usando la direccion nueva; no se borra");
      const r2 = await pedir("DELETE", "/storage/v1/object/productos", { cuerpo: { prefixes: [e.nuevo] } });
      if (!r2.ok) throw falla(r2, "borrar la copia nueva");
      linea(`OK     ${e.nuevo}  ->  ${e.viejo}`);
      resumen.movidas++;
    } catch (err) {
      // si no se llego a cambiar ningun producto, no se deja una copia de mas en la raiz
      if (copiadaAhora && !cambioAlgo) { try { await pedir("DELETE", "/storage/v1/object/productos", { cuerpo: { prefixes: [e.viejo] } }); } catch { /* se reporta el error original */ } }
      const pista = /direcci.n de la foto|foto debe estar/i.test(err.message) ? " (la base ya no acepta fotos en la raiz: corre primero supabase/14-revertir.sql)" : "";
      linea(`ERROR  ${e.viejo}: ${err.message}${pista}`); resumen.errores++;
    }
  }
}

/* ---- principal ------------------------------------------------------------------------------------------------ */
async function principal() {
  const rest = await buscarRestaurante(SLUG);
  ctx.rid = rest.id;

  console.log(`${APLICAR ? "APLICANDO" : "SIMULACION (no se cambia nada)"} - fotos de la raiz del bucket de ${rest.nombre} (${rest.slug})`);
  console.log(`Proyecto: ${URL_BASE.replace(/^https:\/\//, "")}`);

  if (DESHACER) { const abortado = await deshacer(APLICAR); return abortado ? terminar(abortado) : fin(); }

  const todos = await listarProductos();
  const propios = todos.filter((p) => p.restaurante_id === rest.id);

  if (APLICAR) {
    console.log("\nRecuerda: esto necesita una copia de seguridad reciente (node supabase/exportar-respaldo.mjs).");
    const problema = comprobarRespaldo();
    if (problema) { console.error("\nNO SE HIZO NADA. " + problema); return terminar(2); }
    console.log("Copia de seguridad reciente: encontrada.");
  } else {
    console.log("\n(Para mover de verdad: --aplicar. Antes, haz el respaldo: node supabase/exportar-respaldo.mjs)");
  }

  // Clasificar
  const cuenta = { "sin-foto": 0, sitio: 0, externa: 0, rara: 0, "carpeta-propia": 0, "otra-carpeta": 0, raiz: 0 };
  const grupos = new Map();   // nombre -> { viejo, propios:[], ajenos:[] }
  for (const p of todos) {
    const c = clasificar(p.imagen, p.restaurante_id);
    if (p.restaurante_id === rest.id) cuenta[c.tipo]++;
    if (c.tipo !== "raiz") continue;
    if (!grupos.has(c.nombre)) grupos.set(c.nombre, { viejo: c.nombre, propios: [], ajenos: [] });
    (p.restaurante_id === rest.id ? grupos.get(c.nombre).propios : grupos.get(c.nombre).ajenos).push(p);
  }
  console.log(`\nProductos de ${rest.slug}: ${propios.length}  (sin foto ${cuenta["sin-foto"]}, del sitio Recursos/... ${cuenta.sitio}, ya en su carpeta ${cuenta["carpeta-propia"]}, ` +
    `en la RAIZ del bucket ${cuenta.raiz}, otras ${cuenta.externa + cuenta.rara + cuenta["otra-carpeta"]})`);

  ctx.registro = (APLICAR ? leerRegistro() : null) || { version: 1, proyecto: URL_BASE, slug: rest.slug, restaurante_id: rest.id, creado: new Date().toISOString(), fotos: [] };
  if (!APLICAR) { const previo = leerRegistro(); if (previo) ctx.registro = previo; }

  const pendientes = ctx.registro.fotos.filter((e) => !["borrada"].includes(e.estado) && !grupos.has(e.viejo));
  const trabajo = [...grupos.values()].filter((g) => g.propios.length);   // las que solo usan otros no son de este restaurante

  if (!trabajo.length && !pendientes.length) {
    console.log(`\nNada que hacer: ya no queda ninguna foto de ${rest.slug} en la raiz del bucket.`);
    return fin();
  }

  console.log(`\n${trabajo.length} foto(s) en la raiz usada(s) por productos de ${rest.slug}:`);
  for (const g of trabajo) await moverFoto(g, APLICAR);
  if (pendientes.length) {
    console.log(`\n${pendientes.length} foto(s) que una corrida anterior dejo a medias:`);
    for (const e of pendientes) await terminarPendiente(e, APLICAR);
  }

  // Informacion: archivos de la raiz que ningun producto usa (no se tocan)
  try {
    const usados = new Set(todos.map((p) => clasificar(p.imagen, p.restaurante_id)).filter((c) => c.tipo === "raiz").map((c) => c.nombre));
    let sueltas = 0, todosRaiz = 0;
    for (let off = 0; ; off += 100) {
      const r = await pedir("POST", "/storage/v1/object/list/productos", { cuerpo: { prefix: "", limit: 100, offset: off, sortBy: { column: "name", order: "asc" } } });
      if (!r.ok || !Array.isArray(r.json)) break;
      const archivos = r.json.filter((o) => o && o.name && (o.id !== null || o.metadata));
      todosRaiz += archivos.length;
      sueltas += archivos.filter((o) => !usados.has(o.name)).length;
      if (r.json.length < 100) break;
    }
    if (todosRaiz) console.log(`\nEn la raiz del bucket quedan ${todosRaiz} archivo(s); ${sueltas} no los usa ningun producto (no se tocan).`);
  } catch { /* es solo informacion */ }

  if (!resumen.movidas && !resumen.pendientesTerminadas && !resumen.errores) {
    console.log(`\nNada que hacer: no hay ninguna foto de ${rest.slug} que este script pueda mover${resumen.saltadas || resumen.rotas ? " (las que quedan estan arriba: compartidas, rotas o con un nombre que la base no acepta)" : ""}.`);
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
  if (DESHACER) console.log(`Resumen: ${resumen.movidas} ${APLICAR ? "devuelta(s)" : "por devolver"}, ${resumen.saltadas} saltada(s), ${resumen.errores} con error.`);
  else console.log(`Resumen: ${resumen.movidas} ${APLICAR ? "movida(s)" : "por mover"}${resumen.pendientesTerminadas ? `, ${resumen.pendientesTerminadas} pendiente(s) terminada(s)` : ""}, ${resumen.saltadas} saltada(s), ${resumen.rotas} rota(s), ${resumen.errores} con error.`);
  if (APLICAR && !DESHACER) console.log(`Registro (mapa antiguo -> nuevo, para deshacer): ${REGISTRO}`);
  if (!APLICAR && !DESHACER && (resumen.movidas || resumen.pendientesTerminadas)) console.log("Si todo se ve bien: node supabase/migrar-fotos-raiz.mjs --aplicar");
  if (resumen.errores) console.log("Hubo errores: no corras el SQL 14. Vuelve a correr este script (retoma lo pendiente) o avisame.");
  else if (resumen.rotas) console.log("Hay fotos rotas (ya no existian): el SQL 14 se detendra mientras algun producto las siga usando. Cambia o quita esas fotos en menu-admin.");
  terminar(resumen.errores ? 1 : 0);
}

principal().catch((e) => {
  console.error("\nERROR: " + String(e.message || e).slice(0, 400));
  terminar(1);
});
