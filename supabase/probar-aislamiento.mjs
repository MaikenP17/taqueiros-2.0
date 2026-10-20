/* =============================================================
   PRUEBAS DE AISLAMIENTO MULTI-RESTAURANTE  (contra Supabase real)

   Demuestra que un restaurante no puede ver ni tocar los datos de otro.
   Corre DESPUES de supabase/10-multirestaurante.sql.

   COMO FUNCIONA
     1. Con la llave secreta crea DOS restaurantes de prueba (slug
        "test-<codigo>-a" y "-b") y cinco usuarios de prueba en Auth:
        dueno A, cajero A, cocina A, dueno B y uno SIN membresia.
     2. Inicia sesion de verdad con cada uno y prueba con la llave
        PUBLISHABLE (la misma que usa el navegador): lo que cada rol
        puede leer, insertar, actualizar y borrar en CADA tabla.
        Despues de cada intento de escritura ajena, comprueba con la
        llave secreta que el dato NO cambio (no se fia de la respuesta).
     3. Prueba Storage (fotos) y Realtime con sesiones reales.
     4. Borra TODO lo que creo, aun si algo falla o se interrumpe.

   QUE TOCA EN LA BASE REAL
     Solo filas de los dos restaurantes de prueba (que se borran al
     final) y la secuencia de ids de pedidos (se realinea). No toca
     datos de Taqueiros. Mientras corre (1-2 minutos) existen
     categorias y productos de prueba (apagados) que /api/menu
     devolveria si alguien lo consulta en ese momento: corre esto en un
     momento tranquilo.

   USO (PowerShell, desde la raiz del repo) - ver docs/multirestaurante.md
     npm i --no-save @supabase/supabase-js@2.117.2     (una sola vez)
     $env:SUPABASE_SERVICE_ROLE_KEY = ...              (con Read-Host)
     node supabase/probar-aislamiento.mjs

   Variables opcionales: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY.
   Sale con codigo 1 si alguna prueba FALLA.
============================================================= */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { cabecerasSupabase, leerLlaveServicio, tipoDeLlave } = require("../api/_llave.js");

const aqui = path.dirname(fileURLToPath(import.meta.url));
const publico = fs.readFileSync(path.join(aqui, "..", "supabase-publico.js"), "utf8");
const URL_BASE = (process.env.SUPABASE_URL || (publico.match(/url:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");
const PUB = (process.env.SUPABASE_PUBLISHABLE_KEY || (publico.match(/publishableKey:\s*"([^"]+)"/) || [])[1] || "").trim();
if (!URL_BASE || !PUB) { console.error("No pude leer la URL y la llave publishable de supabase-publico.js"); process.exit(2); }

let SRV;
try { SRV = leerLlaveServicio(); } catch (e) { console.error(e.message); process.exit(2); }
if (tipoDeLlave(SRV) === "secreta" && SRV.split("sb_secret_").length !== 2) {
  console.error("La llave secreta parece pegada DOS veces. Vuelve a correr el comando y pegala una sola vez (clic derecho O Ctrl+V, no ambos).");
  process.exit(2);
}
if (tipoDeLlave(SRV) === "legacy" && SRV.split(".").length !== 3) {
  console.error("La llave legacy no tiene forma de JWT (3 partes). Si la pegaste dos veces, vuelve a intentarlo con un solo pegado.");
  process.exit(2);
}

let createClient;
try { ({ createClient } = await import("@supabase/supabase-js")); }
catch { console.error("Falta supabase-js (para la prueba de Realtime). Instalalo una vez:\n  npm i --no-save @supabase/supabase-js@2.117.2"); process.exit(2); }

/* ------------------------------------------------------------------
   HTTP
------------------------------------------------------------------ */
const H_SRV = cabecerasSupabase(SRV);
async function leer(resp) { const t = await resp.text(); try { return JSON.parse(t); } catch { return t; } }

/** Llamada a PostgREST. token = JWT de un usuario; sin token = anon; servidor = true usa la llave secreta. */
async function api(metodo, ruta, { token, servidor, cuerpo, prefer = "return=representation", extra } = {}) {
  const cab = servidor
    ? { ...H_SRV }
    : { apikey: PUB, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (metodo !== "GET" && prefer) cab.Prefer = prefer;
  Object.assign(cab, extra || {});
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { method: metodo, headers: cab, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await leer(r) };
}
const svc = (m, ruta, cuerpo, prefer) => api(m, ruta, { servidor: true, cuerpo, prefer });

const filas = (r) => (Array.isArray(r.cuerpo) ? r.cuerpo : []);
const tocoFilas = (r) => r.status < 300 && filas(r).length > 0;               // la escritura SI afecto filas
const rechazada = (r) => r.status >= 400;                                      // error (RLS, trigger, check...)
const sinEfecto = (r) => r.status >= 400 || (Array.isArray(r.cuerpo) && r.cuerpo.length === 0);
const detalle = (r) => `HTTP ${r.status} ${JSON.stringify(r.cuerpo).slice(0, 110)}`;

/* ------------------------------------------------------------------
   Resultados
------------------------------------------------------------------ */
const resultados = [];
let grupoActual = "";
function grupo(nombre) { grupoActual = nombre; }
function prueba(nombre, ok, info = "") { resultados.push({ grupo: grupoActual, nombre, ok: !!ok, info: ok ? "" : String(info) }); }

/* ------------------------------------------------------------------
   Estado a limpiar
------------------------------------------------------------------ */
const etiqueta = "t" + crypto.randomBytes(3).toString("hex");
const DOMINIO = "aislamiento.example.com";
const NOMBRE_PRUEBA = "PRUEBA-AISLAMIENTO";
const creado = { restaurantes: [], usuarios: [], fotos: [] };
let errorFatal = null;

const clave = () => crypto.randomBytes(18).toString("base64url") + "aA1!";

async function crearUsuario(alias) {
  const email = `${etiqueta}-${alias}@${DOMINIO}`;
  const password = clave();
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users`, {
    method: "POST", headers: H_SRV, body: JSON.stringify({ email, password, email_confirm: true })
  });
  const u = await leer(r);
  if (!r.ok || !u.id) throw new Error(`No pude crear el usuario ${alias}: HTTP ${r.status} ${JSON.stringify(u).slice(0, 150)}`);
  creado.usuarios.push(u.id);
  return { id: u.id, email, password, alias };
}

async function iniciarSesion(u) {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.password })
  });
  const s = await leer(r);
  if (!r.ok || !s.access_token) throw new Error(`No pude iniciar sesion como ${u.alias}: HTTP ${r.status} ${JSON.stringify(s).slice(0, 150)}`);
  u.token = s.access_token;
}

/* ------------------------------------------------------------------
   Limpieza (se usa al inicio para barrer restos y siempre al final)
------------------------------------------------------------------ */
async function limpiar(ids = null) {
  const problemas = [];
  const paso = async (nombre, fn) => { try { await fn(); } catch (e) { problemas.push(`${nombre}: ${e.message}`); } };

  // 1. Restaurantes de prueba: los propios (ids) o restos de corridas anteriores
  let rids = ids;
  if (!rids) {
    const r = await svc("GET", `restaurantes?select=id&slug=like.test-*&nombre=like.${NOMBRE_PRUEBA}*`);
    rids = filas(r).map((x) => x.id);
  }
  if (rids.length) {
    const lista = `in.(${rids.join(",")})`;
    // Fotos de sus carpetas
    await paso("fotos", async () => {
      const prefijos = [];
      for (const rid of rids) {
        const l = await fetch(`${URL_BASE}/storage/v1/object/list/productos`, {
          method: "POST", headers: H_SRV, body: JSON.stringify({ prefix: rid, limit: 100, offset: 0 })
        });
        const objs = await leer(l);
        if (Array.isArray(objs)) objs.forEach((o) => prefijos.push(`${rid}/${o.name}`));
      }
      creado.fotos.forEach((f) => prefijos.push(f));
      if (prefijos.length) {
        await fetch(`${URL_BASE}/storage/v1/object/productos`, { method: "DELETE", headers: H_SRV, body: JSON.stringify({ prefixes: [...new Set(prefijos)] }) });
      }
    });
    // Orden por llaves foraneas: hijos primero
    for (const t of ["pedidos", "productos", "categorias", "tarifas_domicilio", "configuracion", "salud_notificaciones",
                     "contadores_pedido", "restaurante_secretos", "miembros"]) {
      await paso(t, async () => {
        const r = await svc("DELETE", `${t}?restaurante_id=${lista}`, undefined, "return=minimal");
        if (r.status >= 300) throw new Error(detalle(r));
      });
    }
    await paso("restaurantes", async () => {
      const r = await svc("DELETE", `restaurantes?id=${lista}`, undefined, "return=minimal");
      if (r.status >= 300) throw new Error(detalle(r));
    });
  }

  // 2. Usuarios de prueba (los propios, o cualquiera con el dominio de pruebas)
  await paso("usuarios", async () => {
    let objetivo = [...creado.usuarios];
    if (!ids) {
      const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=1&per_page=1000`, { headers: H_SRV });
      const lista = (await leer(r)).users || [];
      objetivo = lista.filter((u) => (u.email || "").endsWith("@" + DOMINIO)).map((u) => u.id);
    }
    for (const id of objetivo) {
      const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H_SRV });
      if (!r.ok && r.status !== 404) throw new Error(`usuario ${id}: HTTP ${r.status}`);
    }
  });
  return problemas;
}

/* ------------------------------------------------------------------
   PRUEBAS
------------------------------------------------------------------ */
const ahora = () => new Date().toISOString();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function subirFoto(token, ruta) {
  const r = await fetch(`${URL_BASE}/storage/v1/object/productos/${ruta}`, {
    method: "POST",
    headers: token ? { apikey: PUB, Authorization: `Bearer ${token}`, "Content-Type": "image/png", "x-upsert": "false" } : { apikey: PUB, "Content-Type": "image/png" },
    body: PNG
  });
  const c = await leer(r);
  if (r.ok) creado.fotos.push(ruta);
  return { status: r.status, cuerpo: c };
}

async function main() {
  console.log(`Proyecto: ${URL_BASE.replace("https://", "")}   codigo de la corrida: ${etiqueta}\n`);

  // ---- 0. Comprobar que el SQL 10 ya se corrio
  const sonda = await svc("GET", "restaurantes?select=id,slug&slug=eq.taqueiros");
  if (sonda.status === 404 || (sonda.cuerpo && sonda.cuerpo.code === "42P01") || (sonda.cuerpo && sonda.cuerpo.code === "PGRST205")) {
    console.error("La tabla 'restaurantes' no existe: falta correr supabase/10-multirestaurante.sql.");
    process.exit(2);
  }
  if (sonda.status >= 400 || !filas(sonda).length) {
    console.error("No encuentro el restaurante 'taqueiros'. " + detalle(sonda));
    process.exit(2);
  }
  const TAQ = filas(sonda)[0].id;

  // ---- 1. Restos de corridas anteriores
  const restos = await limpiar();
  if (restos.length) console.log("  (aviso: no pude barrer algunos restos de corridas anteriores: " + restos.join("; ") + ")");

  // Para realinear la secuencia de ids al final (solo si nadie mas creo pedidos mientras tanto)
  const antes = await svc("GET", "pedidos?select=id&order=id.desc&limit=1");
  const maxIdAntes = filas(antes)[0] ? filas(antes)[0].id : 0;

  // ---- 2. Dos restaurantes de prueba (el alta crea config, secretos, contador y salud)
  const mk = async (sufijo) => {
    const r = await svc("POST", "restaurantes", { slug: `test-${etiqueta}-${sufijo}`, nombre: `${NOMBRE_PRUEBA} ${sufijo.toUpperCase()}` });
    if (r.status >= 300 || !filas(r)[0]) throw new Error("No pude crear el restaurante de prueba: " + detalle(r));
    creado.restaurantes.push(filas(r)[0].id);
    return filas(r)[0].id;
  };
  const A = await mk("a");
  const B = await mk("b");

  // ---- 3. Usuarios y sesiones
  const dA = await crearUsuario("dueno-a");
  const cA = await crearUsuario("cajero-a");
  const kA = await crearUsuario("cocina-a");
  const dB = await crearUsuario("dueno-b");
  const sin = await crearUsuario("sin-membresia");
  const miembros = await svc("POST", "miembros", [
    { user_id: dA.id, restaurante_id: A, rol: "dueno" },
    { user_id: cA.id, restaurante_id: A, rol: "cajero" },
    { user_id: kA.id, restaurante_id: A, rol: "cocina" },
    { user_id: dB.id, restaurante_id: B, rol: "dueno" }
  ]);
  if (miembros.status >= 300) throw new Error("No pude crear las membresias: " + detalle(miembros));
  for (const u of [dA, cA, kA, dB, sin]) await iniciarSesion(u);

  // ---- 4. Datos de prueba en cada restaurante (categorias y productos APAGADOS)
  const sembrados = {};
  for (const [x, rid] of [["a", A], ["b", B]]) {
    const cat = await svc("POST", "categorias", { restaurante_id: rid, id: `cat-${x}`, nombre: `Cat ${x.toUpperCase()} ${etiqueta}`, activa: false });
    const pro = await svc("POST", "productos", { restaurante_id: rid, id: `prod-${x}`, nombre: `Prod ${x.toUpperCase()}`, precio: 1000, categoria: `cat-${x}`, disponible: false });
    const tar = await svc("POST", "tarifas_domicilio", { restaurante_id: rid, hasta: 2, precio: 5000 });
    const peds = [];
    for (let n = 1; n <= 2; n++) {
      const p = await svc("POST", "pedidos", {
        restaurante_id: rid, referencia: `${etiqueta}-${x}-${n}`, estado: "nuevo", cliente_nombre: `Cliente ${x}${n}`, cliente_telefono: "3000000000",
        tipo_pedido: "llevar", items: [], subtotal: 1000, costo_domicilio: 0, total: 1000, estado_pago: "aprobado", pagado_en: ahora(),
        alerta_enviada: true   // que el cron de alertas jamas avise de un pedido de prueba
      });
      peds.push(filas(p)[0]);
    }
    for (const r of [cat, pro, tar]) if (r.status >= 300) throw new Error("No pude sembrar datos de prueba: " + detalle(r));
    if (peds.some((p) => !p)) throw new Error("No pude sembrar pedidos de prueba");
    const cfg = filas(await svc("GET", `configuracion?restaurante_id=eq.${rid}&select=*`))[0];
    const sal = filas(await svc("GET", `salud_notificaciones?restaurante_id=eq.${rid}&select=*`))[0];
    sembrados[x] = { rid, pedidos: peds, cfg, sal };
  }
  const SA = sembrados.a, SB = sembrados.b;

  // =================================================================
  grupo("Alta de restaurante");
  prueba("el alta crea configuracion (id=0, no choca con la de Taqueiros que es id=1)", SA.cfg && SA.cfg.id === 0 && SB.cfg && SB.cfg.id === 0, JSON.stringify(SA.cfg));
  prueba("el alta crea la fila de salud_notificaciones", !!SA.sal && !!SB.sal);
  const sec = await svc("GET", `restaurante_secretos?restaurante_id=in.(${A},${B})&select=restaurante_id`);
  prueba("el alta crea restaurante_secretos para cada restaurante", filas(sec).length === 2, detalle(sec));
  const cont = await svc("GET", `contadores_pedido?restaurante_id=in.(${A},${B})&select=restaurante_id,ultimo`);
  prueba("el alta crea contadores_pedido", filas(cont).length === 2, detalle(cont));
  prueba("numero de pedido por restaurante: A = 1,2 y B = 1,2",
    SA.pedidos.map((p) => p.numero).join() === "1,2" && SB.pedidos.map((p) => p.numero).join() === "1,2",
    JSON.stringify([SA.pedidos.map((p) => p.numero), SB.pedidos.map((p) => p.numero)]));
  const cfg1 = await svc("GET", "configuracion?id=eq.1&select=restaurante_id");
  prueba("el codigo actual (configuracion?id=eq.1) sigue viendo UNA sola fila: la de Taqueiros", filas(cfg1).length === 1 && filas(cfg1)[0].restaurante_id === TAQ, detalle(cfg1));
  const sal1 = await svc("GET", "salud_notificaciones?id=eq.1&select=restaurante_id");
  prueba("el codigo actual (salud_notificaciones?id=eq.1) sigue viendo UNA sola fila", filas(sal1).length === 1 && filas(sal1)[0].restaurante_id === TAQ, detalle(sal1));
  const com = await svc("POST", "categorias", [{ restaurante_id: A, id: "comun", nombre: `Comun ${etiqueta}`, activa: false }, { restaurante_id: B, id: "comun", nombre: `Comun ${etiqueta}`, activa: false }]);
  prueba("el mismo id y nombre de categoria puede existir en dos restaurantes (unico POR restaurante)", com.status < 300, detalle(com));
  const dup = await svc("POST", "categorias", { restaurante_id: A, id: "comun2", nombre: `COMÚN ${etiqueta}`, activa: false });
  prueba("dentro de un restaurante el nombre sigue siendo unico (ignora mayusculas/tildes)", rechazada(dup), detalle(dup));

  // =================================================================
  grupo("Lectura: cada usuario solo ve su restaurante");
  const tablasNegocio = ["pedidos", "categorias", "productos", "configuracion", "salud_notificaciones", "tarifas_domicilio"];
  for (const t of tablasNegocio) {
    const a = await api("GET", `${t}?select=restaurante_id`, { token: dA.token });
    prueba(`dueno A ve filas de ${t} y TODAS son de A`, a.status === 200 && filas(a).length > 0 && filas(a).every((x) => x.restaurante_id === A), detalle(a));
    const ab = await api("GET", `${t}?select=restaurante_id&restaurante_id=eq.${B}`, { token: dA.token });
    prueba(`dueno A pidiendo ${t} de B recibe vacio`, sinEfecto(ab) && filas(ab).length === 0, detalle(ab));
    const at = await api("GET", `${t}?select=restaurante_id&restaurante_id=eq.${TAQ}`, { token: dA.token });
    prueba(`dueno A pidiendo ${t} de Taqueiros recibe vacio`, sinEfecto(at) && filas(at).length === 0, detalle(at));
    const b = await api("GET", `${t}?select=restaurante_id`, { token: dB.token });
    prueba(`dueno B ve filas de ${t} y TODAS son de B`, b.status === 200 && filas(b).length > 0 && filas(b).every((x) => x.restaurante_id === B), detalle(b));
    const s = await api("GET", `${t}?select=restaurante_id`, { token: sin.token });
    prueba(`usuario SIN membresia no ve nada de ${t}`, sinEfecto(s) && filas(s).length === 0, detalle(s));
    const an = await api("GET", `${t}?select=restaurante_id`, {});
    prueba(`anon no lee ${t}`, sinEfecto(an) && filas(an).length === 0, detalle(an));
  }
  for (const t of ["restaurante_secretos", "contadores_pedido", "superadmins", "personal"]) {
    const a = await api("GET", `${t}?select=*`, { token: dA.token });
    prueba(`dueno A no lee ${t}`, sinEfecto(a) && filas(a).length === 0, detalle(a));
    const an = await api("GET", `${t}?select=*`, {});
    prueba(`anon no lee ${t}`, sinEfecto(an) && filas(an).length === 0, detalle(an));
  }
  {
    const r = await api("GET", "restaurantes?select=id", { token: dA.token });
    prueba("dueno A solo ve su restaurante", filas(r).length === 1 && filas(r)[0].id === A, detalle(r));
    const r2 = await api("GET", "restaurantes?select=id", {});
    prueba("anon no lee restaurantes", sinEfecto(r2) && filas(r2).length === 0, detalle(r2));
    const m = await api("GET", "miembros?select=user_id", { token: dA.token });
    prueba("dueno A solo ve su propia membresia", filas(m).length === 1 && filas(m)[0].user_id === dA.id, detalle(m));
    const m2 = await api("GET", "miembros?select=user_id", { token: sin.token });
    prueba("usuario sin membresia ve 0 membresias", filas(m2).length === 0, detalle(m2));
  }

  // =================================================================
  grupo("Escritura ajena: inserciones con restaurante_id de otro");
  const nuevos = {
    pedidos: (rid, n) => ({ restaurante_id: rid, referencia: `${etiqueta}-x-${n}`, estado: "nuevo", cliente_nombre: "X", cliente_telefono: "3", tipo_pedido: "llevar", items: [], subtotal: 1000, costo_domicilio: 0, total: 1000, estado_pago: "aprobado", alerta_enviada: true }),
    categorias: (rid, n) => ({ restaurante_id: rid, id: `x-${n}`, nombre: `X ${n} ${etiqueta}`, activa: false }),
    productos: (rid, n) => ({ restaurante_id: rid, id: `x-${n}`, nombre: "X", precio: 1000, categoria: rid === B ? "cat-b" : "cat-a", disponible: false }),
    configuracion: (rid) => ({ restaurante_id: rid, id: 5, horarios: [] }),
    salud_notificaciones: (rid) => ({ restaurante_id: rid, id: 5 }),
    tarifas_domicilio: (rid, n) => ({ restaurante_id: rid, hasta: 10 + Number(n), precio: 1 })
  };
  for (const t of tablasNegocio) {
    const ajeno = await api("POST", t, { token: dA.token, cuerpo: nuevos[t](B, "1") });
    prueba(`dueno A no inserta en ${t} con restaurante_id de B`, rechazada(ajeno), detalle(ajeno));
    const taq = await api("POST", t, { token: dA.token, cuerpo: nuevos[t](TAQ, "2") });
    prueba(`dueno A no inserta en ${t} con restaurante_id de Taqueiros`, rechazada(taq), detalle(taq));
    const { restaurante_id, ...sinRid } = nuevos[t](A, "3");
    const defecto = await api("POST", t, { token: dA.token, cuerpo: sinRid });
    prueba(`dueno A no inserta en ${t} SIN restaurante_id (el defecto transitorio apunta a Taqueiros)`, rechazada(defecto), detalle(defecto));
    const s = await api("POST", t, { token: sin.token, cuerpo: nuevos[t](A, "4") });
    prueba(`usuario sin membresia no inserta en ${t}`, rechazada(s), detalle(s));
    const an = await api("POST", t, { cuerpo: nuevos[t](A, "5") });
    prueba(`anon no inserta en ${t}`, rechazada(an), detalle(an));
    const dbA = await api("POST", t, { token: dB.token, cuerpo: nuevos[t](A, "6") });
    prueba(`dueno B no inserta en ${t} con restaurante_id de A`, rechazada(dbA), detalle(dbA));
  }
  // Nada de lo anterior debio crear filas
  const huella = await svc("GET", `pedidos?referencia=like.${etiqueta}-x-*&select=id`);
  prueba("ningun pedido ajeno/huerfano se colo (comprobado con la llave secreta)", filas(huella).length === 0, detalle(huella));
  const huella2 = await svc("GET", `productos?id=like.x-*&restaurante_id=in.(${A},${B},${TAQ})&select=id`);
  prueba("ningun producto ajeno/huerfano se colo", filas(huella2).length === 0, detalle(huella2));

  grupo("Escritura ajena: actualizar y borrar filas de otro");
  {
    // pedidos
    let r = await api("PATCH", `pedidos?id=eq.${SB.pedidos[0].id}`, { token: dA.token, cuerpo: { estado: "listo" } });
    let v = filas(await svc("GET", `pedidos?id=eq.${SB.pedidos[0].id}&select=estado`))[0];
    prueba("dueno A no actualiza un pedido de B (y el pedido no cambio)", sinEfecto(r) && v && v.estado === "nuevo", detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SB.pedidos[0].id}`, { token: dA.token, cuerpo: { cliente_nombre: "HACK" } });
    v = filas(await svc("GET", `pedidos?id=eq.${SB.pedidos[0].id}&select=cliente_nombre`))[0];
    prueba("dueno A no edita el nombre del cliente de un pedido de B", sinEfecto(r) && v.cliente_nombre === "Cliente b1", detalle(r));
    r = await api("DELETE", `pedidos?id=eq.${SB.pedidos[0].id}`, { token: dA.token });
    v = filas(await svc("GET", `pedidos?id=eq.${SB.pedidos[0].id}&select=id`));
    prueba("dueno A no borra un pedido de B (sigue existiendo)", sinEfecto(r) && v.length === 1, detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: dA.token, cuerpo: { restaurante_id: B } });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[0].id}&select=restaurante_id`))[0];
    prueba("dueno A no puede MOVER un pedido suyo a B", rechazada(r) && v.restaurante_id === A, detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: dA.token, cuerpo: { total: 1, subtotal: 1 } });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[0].id}&select=total`))[0];
    prueba("dueno A no cambia el dinero de su pedido (trigger de pago)", rechazada(r) && v.total === 1000, detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: dA.token, cuerpo: { numero: 99 } });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[0].id}&select=numero`))[0];
    prueba("dueno A no cambia el numero de pedido", rechazada(r) && v.numero === 1, detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: sin.token, cuerpo: { estado: "listo" } });
    prueba("sin membresia no actualiza pedidos de A", sinEfecto(r), detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { cuerpo: { estado: "listo" } });
    prueba("anon no actualiza pedidos", sinEfecto(r), detalle(r));
    r = await api("DELETE", `pedidos?id=eq.${SA.pedidos[0].id}`, { cuerpo: undefined });
    prueba("anon no borra pedidos", sinEfecto(r), detalle(r));
    r = await api("DELETE", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: dA.token });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[0].id}&select=id`));
    prueba("dueno A no borra ni su propio pedido pagado (el historial se conserva)", sinEfecto(r) && v.length === 1, detalle(r));

    // categorias / productos
    r = await api("PATCH", "productos?id=eq.prod-b", { token: dA.token, cuerpo: { precio: 1 } });
    v = filas(await svc("GET", `productos?restaurante_id=eq.${B}&id=eq.prod-b&select=precio`))[0];
    prueba("dueno A no cambia el precio de un producto de B", sinEfecto(r) && v.precio === 1000, detalle(r));
    r = await api("DELETE", "productos?id=eq.prod-b", { token: dA.token });
    v = filas(await svc("GET", `productos?restaurante_id=eq.${B}&id=eq.prod-b&select=id`));
    prueba("dueno A no borra un producto de B", sinEfecto(r) && v.length === 1, detalle(r));
    r = await api("PATCH", "categorias?id=eq.cat-b", { token: dA.token, cuerpo: { nombre: "HACK" } });
    v = filas(await svc("GET", `categorias?restaurante_id=eq.${B}&id=eq.cat-b&select=nombre`))[0];
    prueba("dueno A no renombra una categoria de B", sinEfecto(r) && v.nombre.startsWith("Cat B"), detalle(r));
    r = await api("DELETE", "categorias?id=eq.cat-b", { token: dA.token });
    v = filas(await svc("GET", `categorias?restaurante_id=eq.${B}&id=eq.cat-b&select=id`));
    prueba("dueno A no borra una categoria de B", sinEfecto(r) && v.length === 1, detalle(r));
    r = await api("PATCH", "productos?id=eq.prod-a", { token: dA.token, cuerpo: { restaurante_id: B } });
    v = filas(await svc("GET", `productos?id=eq.prod-a&select=restaurante_id`));
    prueba("dueno A no mueve un producto suyo a B", rechazada(r) && v.length === 1 && v[0].restaurante_id === A, detalle(r));
    r = await api("POST", "productos", { token: dA.token, cuerpo: { restaurante_id: A, id: "cruzado", nombre: "Cruzado", precio: 1000, categoria: "cat-b", disponible: false } });
    prueba("un producto de A no puede apuntar a una categoria de B", rechazada(r), detalle(r));
    r = await api("PATCH", "productos?id=eq.prod-a", { token: dA.token, cuerpo: { imagen: `${URL_BASE}/storage/v1/object/public/productos/${B}/x.png` } });
    prueba("un producto de A no puede apuntar a la carpeta de fotos de B", rechazada(r), detalle(r));

    // configuracion / salud / tarifas
    r = await api("PATCH", `configuracion?restaurante_id=eq.${B}`, { token: dA.token, cuerpo: { cerrado_temporal: true, mensaje_cerrado: "HACK" } });
    v = filas(await svc("GET", `configuracion?restaurante_id=eq.${B}&select=cerrado_temporal,mensaje_cerrado`))[0];
    prueba("dueno A no edita la configuracion de B", sinEfecto(r) && v.cerrado_temporal === false && v.mensaje_cerrado === null, detalle(r));
    r = await api("PATCH", `configuracion?restaurante_id=eq.${TAQ}`, { token: dA.token, cuerpo: { cerrado_temporal: true } });
    v = filas(await svc("GET", `configuracion?restaurante_id=eq.${TAQ}&select=cerrado_temporal`))[0];
    prueba("dueno A no edita la configuracion de TAQUEIROS (no pudo cerrar el local)", sinEfecto(r) && v.cerrado_temporal === false, detalle(r));
    r = await api("PATCH", `configuracion?restaurante_id=eq.${A}`, { token: dA.token, cuerpo: { restaurante_id: B } });
    prueba("dueno A no mueve su configuracion a B", rechazada(r), detalle(r));
    r = await api("PATCH", `salud_notificaciones?restaurante_id=eq.${B}`, { token: dA.token, cuerpo: { fallos_seguidos: 9 } });
    v = filas(await svc("GET", `salud_notificaciones?restaurante_id=eq.${B}&select=fallos_seguidos`))[0];
    prueba("dueno A no edita salud_notificaciones de B", sinEfecto(r) && v.fallos_seguidos === 0, detalle(r));
    r = await api("PATCH", `tarifas_domicilio?restaurante_id=eq.${B}`, { token: dA.token, cuerpo: { precio: 1 } });
    v = filas(await svc("GET", `tarifas_domicilio?restaurante_id=eq.${B}&select=precio`))[0];
    prueba("dueno A no edita las tarifas de B", sinEfecto(r) && v.precio === 5000, detalle(r));
    r = await api("DELETE", `tarifas_domicilio?restaurante_id=eq.${B}`, { token: dA.token });
    v = filas(await svc("GET", `tarifas_domicilio?restaurante_id=eq.${B}&select=id`));
    prueba("dueno A no borra las tarifas de B", sinEfecto(r) && v.length === 1, detalle(r));

    // B a A (espejo)
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[1].id}`, { token: dB.token, cuerpo: { estado: "listo" } });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[1].id}&select=estado`))[0];
    prueba("dueno B no actualiza un pedido de A", sinEfecto(r) && v.estado === "nuevo", detalle(r));
    r = await api("PATCH", "productos?id=eq.prod-a", { token: dB.token, cuerpo: { precio: 1 } });
    v = filas(await svc("GET", `productos?restaurante_id=eq.${A}&id=eq.prod-a&select=precio`))[0];
    prueba("dueno B no cambia el precio de un producto de A", sinEfecto(r) && v.precio === 1000, detalle(r));
    r = await api("PATCH", `configuracion?restaurante_id=eq.${A}`, { token: dB.token, cuerpo: { mensaje_cerrado: "HACK" } });
    v = filas(await svc("GET", `configuracion?restaurante_id=eq.${A}&select=mensaje_cerrado`))[0];
    prueba("dueno B no edita la configuracion de A", sinEfecto(r) && v.mensaje_cerrado === null, detalle(r));
  }

  // =================================================================
  grupo("Lo que SI puede hacer el dueno en lo suyo");
  {
    let r = await api("POST", "pedidos", { token: dA.token, cuerpo: nuevos.pedidos(A, "ok1") });
    prueba("dueno A inserta un pedido en A y recibe el numero 3", tocoFilas(r) && filas(r)[0].numero === 3, detalle(r));
    const propio = filas(r)[0];
    r = await api("POST", "pedidos", { token: dA.token, cuerpo: { ...nuevos.pedidos(A, "ok2"), numero: 999 } });
    prueba("dueno A no puede elegir su numero (se ignora y recibe el 4)", tocoFilas(r) && filas(r)[0].numero === 4, detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: dA.token, cuerpo: { estado: "en_preparacion" } });
    prueba("dueno A actualiza el estado de un pedido propio", tocoFilas(r), detalle(r));
    r = await api("POST", "categorias", { token: dA.token, cuerpo: nuevos.categorias(A, "ok") });
    prueba("dueno A crea una categoria", tocoFilas(r), detalle(r));
    r = await api("POST", "productos", { token: dA.token, cuerpo: nuevos.productos(A, "ok") });
    prueba("dueno A crea un producto", tocoFilas(r), detalle(r));
    r = await api("PATCH", "productos?id=eq.x-ok", { token: dA.token, cuerpo: { precio: 2000 } });
    prueba("dueno A edita su producto", tocoFilas(r), detalle(r));
    r = await api("DELETE", "productos?id=eq.x-ok", { token: dA.token });
    prueba("dueno A borra su producto", tocoFilas(r), detalle(r));
    r = await api("DELETE", "categorias?id=eq.x-ok", { token: dA.token });
    prueba("dueno A borra su categoria", tocoFilas(r), detalle(r));
    r = await api("PATCH", `configuracion?restaurante_id=eq.${A}`, { token: dA.token, cuerpo: { cerrado_temporal: true } });
    prueba("dueno A edita su configuracion", tocoFilas(r), detalle(r));
    r = await api("POST", "tarifas_domicilio", { token: dA.token, cuerpo: nuevos.tarifas_domicilio(A, "1") });
    prueba("dueno A crea una tarifa de domicilio", tocoFilas(r), detalle(r));
    r = await api("POST", "pedidos", { token: dA.token, cuerpo: { ...nuevos.pedidos(A, "imp"), estado_pago: "pendiente", estado: "nuevo" } });
    const sinPagar = filas(r)[0];
    r = sinPagar ? await api("DELETE", `pedidos?id=eq.${sinPagar.id}`, { token: dA.token }) : { status: 0, cuerpo: [] };
    prueba("dueno A solo borra pedidos que nunca se cobraron", tocoFilas(r), detalle(r));
    // el dueno A nunca borra el pagado que acaba de crear
    r = await api("DELETE", `pedidos?id=eq.${propio.id}`, { token: dA.token });
    prueba("... pero no uno ya cobrado", sinEfecto(r), detalle(r));
  }

  // =================================================================
  grupo("Roles: cajero y cocina");
  {
    let r = await api("GET", "productos?select=id", { token: cA.token });
    prueba("cajero A lee el menu", filas(r).length > 0, detalle(r));
    r = await api("GET", "configuracion?select=restaurante_id", { token: cA.token });
    prueba("cajero A lee la configuracion de A (solo A)", filas(r).length === 1 && filas(r)[0].restaurante_id === A, detalle(r));
    r = await api("PATCH", "productos?id=eq.prod-a", { token: cA.token, cuerpo: { precio: 1 } });
    let v = filas(await svc("GET", `productos?restaurante_id=eq.${A}&id=eq.prod-a&select=precio`))[0];
    prueba("cajero A NO edita el menu (el precio no cambio)", sinEfecto(r) && v.precio === 1000, detalle(r));
    r = await api("POST", "productos", { token: cA.token, cuerpo: nuevos.productos(A, "cj") });
    prueba("cajero A NO crea productos", rechazada(r), detalle(r));
    r = await api("POST", "categorias", { token: cA.token, cuerpo: nuevos.categorias(A, "cj") });
    prueba("cajero A NO crea categorias", rechazada(r), detalle(r));
    r = await api("DELETE", "productos?id=eq.prod-a", { token: cA.token });
    v = filas(await svc("GET", `productos?restaurante_id=eq.${A}&id=eq.prod-a&select=id`));
    prueba("cajero A NO borra productos", sinEfecto(r) && v.length === 1, detalle(r));
    r = await api("PATCH", `configuracion?restaurante_id=eq.${A}`, { token: cA.token, cuerpo: { mensaje_cerrado: "HACK-CAJERO" } });
    v = filas(await svc("GET", `configuracion?restaurante_id=eq.${A}&select=mensaje_cerrado`))[0];
    prueba("cajero A NO edita la configuracion", sinEfecto(r) && v.mensaje_cerrado === null, detalle(r));
    r = await api("POST", "tarifas_domicilio", { token: cA.token, cuerpo: nuevos.tarifas_domicilio(A, "2") });
    prueba("cajero A NO crea tarifas", rechazada(r), detalle(r));
    r = await api("POST", "pedidos", { token: cA.token, cuerpo: nuevos.pedidos(A, "cj1") });
    prueba("cajero A crea pedidos", tocoFilas(r), detalle(r));
    r = await api("POST", "pedidos", { token: cA.token, cuerpo: nuevos.pedidos(B, "cj2") });
    prueba("cajero A NO crea pedidos en B", rechazada(r), detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[1].id}`, { token: cA.token, cuerpo: { estado: "listo" } });
    prueba("cajero A actualiza pedidos", tocoFilas(r), detalle(r));
    r = await api("DELETE", `pedidos?id=eq.${SA.pedidos[1].id}`, { token: cA.token });
    prueba("cajero A NO borra pedidos", sinEfecto(r), detalle(r));
    r = await api("PATCH", `restaurantes?id=eq.${A}`, { token: cA.token, cuerpo: { nombre: "HACK" } });
    prueba("cajero A NO edita el restaurante", sinEfecto(r), detalle(r));

    // cocina
    r = await api("GET", "pedidos?select=id", { token: kA.token });
    prueba("cocina A lee los pedidos de A", filas(r).length >= 2, detalle(r));
    r = await api("GET", "productos?select=id", { token: kA.token });
    prueba("cocina A no lee el menu", filas(r).length === 0, detalle(r));
    r = await api("GET", "configuracion?select=restaurante_id", { token: kA.token });
    prueba("cocina A no lee la configuracion", filas(r).length === 0, detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: kA.token, cuerpo: { estado: "listo" } });
    prueba("cocina A cambia el ESTADO de un pedido", tocoFilas(r), detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: kA.token, cuerpo: { cliente_nombre: "HACK-COCINA" } });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[0].id}&select=cliente_nombre`))[0];
    prueba("cocina A NO cambia ningun otro campo (nombre del cliente)", rechazada(r) && v.cliente_nombre === "Cliente a1", detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SA.pedidos[0].id}`, { token: kA.token, cuerpo: { direccion: "HACK", estado: "entregado" } });
    v = filas(await svc("GET", `pedidos?id=eq.${SA.pedidos[0].id}&select=direccion,estado`))[0];
    prueba("cocina A NO cambia otros campos aunque cambie el estado a la vez", rechazada(r) && v.direccion === null && v.estado === "listo", detalle(r));
    r = await api("POST", "pedidos", { token: kA.token, cuerpo: nuevos.pedidos(A, "ck") });
    prueba("cocina A NO crea pedidos", rechazada(r), detalle(r));
    r = await api("DELETE", `pedidos?id=eq.${SA.pedidos[1].id}`, { token: kA.token });
    prueba("cocina A NO borra pedidos", sinEfecto(r), detalle(r));
    r = await api("PATCH", `pedidos?id=eq.${SB.pedidos[1].id}`, { token: kA.token, cuerpo: { estado: "listo" } });
    v = filas(await svc("GET", `pedidos?id=eq.${SB.pedidos[1].id}&select=estado`))[0];
    prueba("cocina A no toca pedidos de B", sinEfecto(r) && v.estado === "nuevo", detalle(r));
  }

  // =================================================================
  grupo("Restaurantes, membresias y superadmins");
  {
    let r = await api("PATCH", `restaurantes?id=eq.${A}`, { token: dA.token, cuerpo: { nombre: `${NOMBRE_PRUEBA} A (editado)`, config: { color: "#ffffff" } } });
    prueba("dueno A cambia el nombre y la config de su restaurante", tocoFilas(r), detalle(r));
    for (const [campo, valor] of [["plan", "basico"], ["estado", "suspendido"], ["slug", "otro-slug-x"], ["vigente_hasta", "2099-01-01"], ["dias_gracia", 99], ["modalidad_pago", "unico"], ["modulos", { pasarela: false }]]) {
      r = await api("PATCH", `restaurantes?id=eq.${A}`, { token: dA.token, cuerpo: { [campo]: valor } });
      const v = filas(await svc("GET", `restaurantes?id=eq.${A}&select=${campo}`))[0];
      prueba(`dueno A NO puede cambiar su ${campo} (lo controla Carlos)`, rechazada(r) && JSON.stringify(v[campo]) !== JSON.stringify(valor), detalle(r));
    }
    r = await api("PATCH", `restaurantes?id=eq.${B}`, { token: dA.token, cuerpo: { nombre: "HACK" } });
    prueba("dueno A no edita el restaurante B", sinEfecto(r), detalle(r));
    r = await api("DELETE", `restaurantes?id=eq.${A}`, { token: dA.token });
    prueba("dueno A no borra su restaurante", sinEfecto(r), detalle(r));
    r = await api("POST", "restaurantes", { token: dA.token, cuerpo: { slug: `test-${etiqueta}-hack`, nombre: "HACK" } });
    prueba("dueno A no crea restaurantes", rechazada(r), detalle(r));
    r = await api("POST", "restaurantes", { token: sin.token, cuerpo: { slug: `test-${etiqueta}-hack2`, nombre: "HACK" } });
    prueba("usuario sin membresia no crea restaurantes", rechazada(r), detalle(r));

    r = await api("PATCH", `restaurante_secretos?restaurante_id=eq.${A}`, { token: dA.token, cuerpo: { callmebot_apikey: "HACK" } });
    prueba("dueno A no escribe restaurante_secretos", sinEfecto(r), detalle(r));
    r = await api("POST", "restaurante_secretos", { token: dA.token, cuerpo: { restaurante_id: A } });
    prueba("dueno A no inserta en restaurante_secretos", rechazada(r), detalle(r));
    r = await api("PATCH", `contadores_pedido?restaurante_id=eq.${A}`, { token: dA.token, cuerpo: { ultimo: 0 } });
    prueba("dueno A no toca el contador de pedidos", sinEfecto(r), detalle(r));
    r = await api("POST", "rpc/siguiente_numero_pedido", { token: dA.token, cuerpo: { p_restaurante_id: A } });
    prueba("dueno A no puede llamar siguiente_numero_pedido", rechazada(r), detalle(r));
    r = await api("POST", "rpc/realinear_secuencia_pedidos", { token: dA.token, cuerpo: {} });
    prueba("dueno A no puede llamar realinear_secuencia_pedidos", rechazada(r), detalle(r));

    r = await api("POST", "miembros", { token: dA.token, cuerpo: { user_id: sin.id, restaurante_id: A, rol: "cajero" } });
    let v = filas(await svc("GET", `miembros?user_id=eq.${sin.id}&select=rol`));
    prueba("dueno A no agrega miembros por su cuenta (lo hace el servidor)", rechazada(r) && v.length === 0, detalle(r));
    r = await api("PATCH", `miembros?user_id=eq.${cA.id}`, { token: dA.token, cuerpo: { rol: "dueno" } });
    v = filas(await svc("GET", `miembros?user_id=eq.${cA.id}&select=rol`))[0];
    prueba("dueno A no cambia roles directamente", sinEfecto(r) && v.rol === "cajero", detalle(r));
    r = await api("PATCH", `miembros?user_id=eq.${cA.id}`, { token: cA.token, cuerpo: { rol: "dueno" } });
    v = filas(await svc("GET", `miembros?user_id=eq.${cA.id}&select=rol`))[0];
    prueba("el cajero no se asciende a si mismo a dueno", sinEfecto(r) && v.rol === "cajero", detalle(r));
    r = await api("POST", "miembros", { token: sin.token, cuerpo: { user_id: sin.id, restaurante_id: A, rol: "dueno" } });
    v = filas(await svc("GET", `miembros?user_id=eq.${sin.id}&select=rol`));
    prueba("un usuario sin membresia no se mete a un restaurante", rechazada(r) && v.length === 0, detalle(r));
    r = await api("POST", "miembros", { token: dB.token, cuerpo: { user_id: dB.id, restaurante_id: A, rol: "dueno" } });
    v = filas(await svc("GET", `miembros?user_id=eq.${dB.id}&restaurante_id=eq.${A}&select=rol`));
    prueba("el dueno de B no se mete al restaurante A", rechazada(r) && v.length === 0, detalle(r));
    r = await api("DELETE", `miembros?user_id=eq.${cA.id}`, { token: dA.token });
    v = filas(await svc("GET", `miembros?user_id=eq.${cA.id}&select=rol`));
    prueba("dueno A no borra miembros directamente", sinEfecto(r) && v.length === 1, detalle(r));

    r = await api("POST", "superadmins", { token: dA.token, cuerpo: { user_id: dA.id } });
    v = filas(await svc("GET", `superadmins?user_id=eq.${dA.id}&select=user_id`));
    prueba("dueno A no se hace superadmin", rechazada(r) && v.length === 0, detalle(r));
    r = await api("POST", "superadmins", { token: sin.token, cuerpo: { user_id: sin.id } });
    v = filas(await svc("GET", `superadmins?user_id=eq.${sin.id}&select=user_id`));
    prueba("un usuario sin membresia no se hace superadmin", rechazada(r) && v.length === 0, detalle(r));
    r = await api("POST", "superadmins", { cuerpo: { user_id: dA.id } });
    prueba("anon no escribe superadmins", rechazada(r), detalle(r));
  }

  // =================================================================
  grupo("Impresion (reclamar_impresion / registrar_reimpresion)");
  {
    const rpc = (nombre, token, id) => api("POST", `rpc/${nombre}`, { token, cuerpo: { p_id: id } });
    const estadoDe = async (id) => filas(await svc("GET", `pedidos?id=eq.${id}&select=impreso_en,reimpresiones`))[0];

    let r = await rpc("reclamar_impresion", dA.token, SB.pedidos[0].id);
    let v = await estadoDe(SB.pedidos[0].id);
    prueba("dueno A: reclamar_impresion sobre un pedido de B se rechaza (y no marca nada)", rechazada(r) && v.impreso_en === null, detalle(r));
    r = await rpc("registrar_reimpresion", dA.token, SB.pedidos[0].id);
    v = await estadoDe(SB.pedidos[0].id);
    prueba("dueno A: registrar_reimpresion sobre un pedido de B se rechaza (y no cuenta)", rechazada(r) && v.reimpresiones === 0, detalle(r));
    r = await rpc("reclamar_impresion", dB.token, SA.pedidos[1].id);
    v = await estadoDe(SA.pedidos[1].id);
    prueba("dueno B: reclamar_impresion sobre un pedido de A se rechaza", rechazada(r) && v.impreso_en === null, detalle(r));
    r = await rpc("reclamar_impresion", sin.token, SA.pedidos[1].id);
    prueba("usuario sin membresia: reclamar_impresion se rechaza", rechazada(r), detalle(r));
    r = await rpc("registrar_reimpresion", sin.token, SA.pedidos[1].id);
    prueba("usuario sin membresia: registrar_reimpresion se rechaza", rechazada(r), detalle(r));
    r = await rpc("reclamar_impresion", undefined, SA.pedidos[1].id);
    prueba("anon: reclamar_impresion se rechaza", rechazada(r), detalle(r));
    r = await rpc("registrar_reimpresion", undefined, SA.pedidos[1].id);
    prueba("anon: registrar_reimpresion se rechaza", rechazada(r), detalle(r));
    r = await rpc("reclamar_impresion", dA.token, -12345);
    prueba("un id inexistente se rechaza", rechazada(r), detalle(r));
    r = await rpc("reclamar_impresion", dA.token, SA.pedidos[1].id);
    prueba("dueno A: reclamar_impresion de lo suyo -> true", r.status === 200 && r.cuerpo === true, detalle(r));
    r = await rpc("reclamar_impresion", dA.token, SA.pedidos[1].id);
    prueba("... y la segunda vez -> false (nunca se imprime dos veces)", r.status === 200 && r.cuerpo === false, detalle(r));
    r = await rpc("registrar_reimpresion", dA.token, SA.pedidos[1].id);
    prueba("dueno A: registrar_reimpresion de lo suyo -> 1", r.status === 200 && r.cuerpo === 1, detalle(r));
    r = await rpc("reclamar_impresion", kA.token, SA.pedidos[0].id);
    prueba("cocina A puede reclamar la impresion de lo suyo (imprime los tickets)", r.status === 200, detalle(r));
  }

  // =================================================================
  grupo("Historial, jornada y resumen (antes leian todos los restaurantes)");
  {
    let r = await api("POST", "rpc/buscar_historial", { token: dA.token, cuerpo: {} });
    prueba("buscar_historial de A solo trae pedidos de A", r.status === 200 && filas(r).length > 0 && filas(r).every((x) => x.restaurante_id === A), detalle(r));
    r = await api("POST", "rpc/buscar_historial", { token: dA.token, cuerpo: { p_restaurante: B } });
    prueba("dueno A pidiendo el historial de B recibe vacio", r.status === 200 && filas(r).length === 0, detalle(r));
    r = await api("POST", "rpc/buscar_historial", { token: sin.token, cuerpo: {} });
    prueba("sin membresia: buscar_historial vacio", filas(r).length === 0, detalle(r));
    r = await api("POST", "rpc/buscar_historial", { cuerpo: {} });
    prueba("anon no ejecuta buscar_historial", rechazada(r), detalle(r));
    r = await api("POST", "rpc/buscar_historial", { token: dA.token, cuerpo: { referencia: `${etiqueta}-a-1` } });
    prueba("buscar_historial filtra por referencia", filas(r).length === 1, detalle(r));
    r = await api("POST", "rpc/resumen_jornada", { token: dA.token, cuerpo: {} });
    prueba("resumen_jornada de A funciona (lo que usa historial.html)", r.status === 200 && r.cuerpo && r.cuerpo.num_pedidos !== undefined, detalle(r));
    r = await api("POST", "rpc/resumen_jornada", { token: dA.token, cuerpo: { p_restaurante: B } });
    prueba("dueno A pidiendo el resumen de B recibe null", r.status === 200 && r.cuerpo === null, detalle(r));
    r = await api("POST", "rpc/resumen_jornada", { token: sin.token, cuerpo: {} });
    prueba("sin membresia: resumen_jornada = null", r.status === 200 && r.cuerpo === null, detalle(r));
    r = await api("POST", "rpc/resumen_jornada", { cuerpo: {} });
    prueba("anon no ejecuta resumen_jornada", rechazada(r), detalle(r));
    r = await api("POST", "rpc/jornadas_con_pedidos", { token: dA.token, cuerpo: { limite: 10 } });
    prueba("jornadas_con_pedidos de A funciona", r.status === 200 && filas(r).length >= 1, detalle(r));
    r = await api("POST", "rpc/jornadas_con_pedidos", { token: dA.token, cuerpo: { limite: 10, p_restaurante: B } });
    prueba("dueno A pidiendo las jornadas de B recibe vacio", r.status === 200 && filas(r).length === 0, detalle(r));
    r = await api("POST", "rpc/limites_jornada", { token: dA.token, cuerpo: {} });
    prueba("limites_jornada() sin parametros (como el panel actual) devuelve 1 fila", r.status === 200 && filas(r).length === 1, detalle(r));
    r = await api("POST", "rpc/limites_jornada", { token: dA.token, cuerpo: { p_restaurante: B } });
    prueba("dueno A pidiendo limites_jornada de B recibe vacio", r.status === 200 && filas(r).length === 0, detalle(r));
    r = await api("POST", "rpc/limpiar_pedidos_huerfanos", { token: dA.token, cuerpo: { horas: 24 } });
    prueba("dueno A no ejecuta limpiar_pedidos_huerfanos", rechazada(r), detalle(r));
    r = await api("POST", "rpc/limpiar_pedidos_huerfanos", { cuerpo: { horas: 24 } });
    prueba("anon no ejecuta limpiar_pedidos_huerfanos", rechazada(r), detalle(r));
    // Las dos puertas publicas
    r = await api("POST", "rpc/seguimiento", { cuerpo: { ref: `${etiqueta}-a-1` } });
    prueba("anon SI puede seguimiento(ref) y NO recibe telefono ni correo", r.status === 200 && filas(r).length === 1 && !("cliente_telefono" in filas(r)[0]) && !("cliente_email" in filas(r)[0]), detalle(r));
    r = await api("POST", "rpc/buscar_mis_pedidos", { cuerpo: { telefono: "3000000000", total_pagado: 1000 } });
    prueba("buscar_mis_pedidos (como la llama el sitio hoy) NO trae pedidos de otros restaurantes", r.status === 200 && filas(r).every((x) => !String(x.referencia).startsWith(etiqueta)), detalle(r));
    r = await api("POST", "rpc/buscar_mis_pedidos", { cuerpo: { telefono: "3000000000", total_pagado: 1000, p_restaurante: A } });
    const refsA = filas(r).map((x) => x.referencia);
    const deA = refsA.length ? filas(await svc("GET", `pedidos?select=referencia&restaurante_id=eq.${A}&referencia=in.(${refsA.join(",")})`)) : [];
    prueba("buscar_mis_pedidos acotada a A trae solo pedidos de A (y si trae)", r.status === 200 && refsA.length > 0 && deA.length === refsA.length, detalle(r));
  }

  // =================================================================
  grupo("Storage: fotos de productos");
  {
    let r = await subirFoto(dA.token, `${A}/prueba-${etiqueta}.png`);
    prueba("dueno A sube una foto a SU carpeta", r.status === 200, detalle(r));
    const publica = await fetch(`${URL_BASE}/storage/v1/object/public/productos/${A}/prueba-${etiqueta}.png`);
    prueba("la lectura publica de la foto sigue funcionando sin sesion", publica.status === 200, `HTTP ${publica.status}`);
    r = await subirFoto(dA.token, `${B}/ajena-${etiqueta}.png`);
    prueba("dueno A NO sube a la carpeta de B", r.status >= 400, detalle(r));
    r = await subirFoto(dA.token, `${TAQ}/ajena-${etiqueta}.png`);
    prueba("dueno A NO sube a la carpeta de Taqueiros", r.status >= 400, detalle(r));
    r = await subirFoto(dA.token, `raiz-${etiqueta}.png`);
    prueba("dueno A NO sube a la raiz del bucket (solo el dueno de Taqueiros, transitorio)", r.status >= 400, detalle(r));
    r = await subirFoto(cA.token, `${A}/cajero-${etiqueta}.png`);
    prueba("cajero A NO sube fotos", r.status >= 400, detalle(r));
    r = await subirFoto(kA.token, `${A}/cocina-${etiqueta}.png`);
    prueba("cocina A NO sube fotos", r.status >= 400, detalle(r));
    r = await subirFoto(sin.token, `${A}/sin-${etiqueta}.png`);
    prueba("usuario sin membresia NO sube fotos", r.status >= 400, detalle(r));
    r = await subirFoto(null, `${A}/anon-${etiqueta}.png`);
    prueba("anon NO sube fotos", r.status >= 400, detalle(r));
    r = await subirFoto(dB.token, `${B}/foto-b-${etiqueta}.png`);
    prueba("dueno B sube a su carpeta", r.status === 200, detalle(r));
    // borrar: B no puede borrar la foto de A. Se comprueba con la llave secreta
    // (la URL publica puede estar en cache y mentir).
    const existe = async (ruta) => (await fetch(`${URL_BASE}/storage/v1/object/productos/${ruta}`, { headers: H_SRV })).status === 200;
    const del = await fetch(`${URL_BASE}/storage/v1/object/productos/${A}/prueba-${etiqueta}.png`, { method: "DELETE", headers: { apikey: PUB, Authorization: `Bearer ${dB.token}` } });
    prueba("dueno B NO borra la foto de A (la foto sigue ahi)", await existe(`${A}/prueba-${etiqueta}.png`), `DELETE HTTP ${del.status}`);
    const delA = await fetch(`${URL_BASE}/storage/v1/object/productos/${A}/prueba-${etiqueta}.png`, { method: "DELETE", headers: { apikey: PUB, Authorization: `Bearer ${dA.token}` } });
    prueba("dueno A borra su propia foto", delA.ok && !(await existe(`${A}/prueba-${etiqueta}.png`)), `DELETE HTTP ${delA.status}`);
    // listado
    const lst = await fetch(`${URL_BASE}/storage/v1/object/list/productos`, {
      method: "POST", headers: { apikey: PUB, Authorization: `Bearer ${dA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: B, limit: 50, offset: 0 })
    });
    const lista = await leer(lst);
    prueba("dueno A no puede listar la carpeta de B", Array.isArray(lista) ? lista.length === 0 : lst.status >= 400, `HTTP ${lst.status} ${JSON.stringify(lista).slice(0, 100)}`);
  }

  // =================================================================
  grupo("Realtime: los eventos respetan RLS");
  {
    const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
    const clientes = [];
    const recibidos = { A: [], B: [] };
    const abrir = async (usuario, clave) => {
      const c = createClient(URL_BASE, PUB, opciones);
      const { error } = await c.auth.signInWithPassword({ email: usuario.email, password: usuario.password });
      if (error) throw new Error("Realtime: no pude iniciar sesion como " + usuario.alias + ": " + error.message);
      clientes.push(c);
      const estado = await new Promise((res) => {
        const ch = c.channel(`aislamiento-${clave}-${etiqueta}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "pedidos" }, (p) => {
            const f = p.new && p.new.referencia ? p.new : (p.old || {});
            recibidos[clave].push({ tipo: p.eventType, ref: f.referencia, rid: f.restaurante_id, id: f.id });
          })
          .subscribe((st) => { if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(st)) res(st); });
        setTimeout(() => res("SIN_RESPUESTA"), 12000);
      });
      return estado;
    };
    try {
      const eA = await abrir(dA, "A");
      const eB = await abrir(dB, "B");
      prueba("el canal de Realtime del dueno A queda SUBSCRIBED", eA === "SUBSCRIBED", eA);
      prueba("el canal de Realtime del dueno B queda SUBSCRIBED", eB === "SUBSCRIBED", eB);

      const marcaA = `${etiqueta}-rt-a`, marcaB = `${etiqueta}-rt-b`;
      const base = (rid, ref) => ({ restaurante_id: rid, referencia: ref, estado: "nuevo", cliente_nombre: "RT", cliente_telefono: "3", tipo_pedido: "llevar", items: [], subtotal: 1000, costo_domicilio: 0, total: 1000, estado_pago: "aprobado", alerta_enviada: true });
      const pb = filas(await svc("POST", "pedidos", base(B, marcaB)))[0];
      const pa = filas(await svc("POST", "pedidos", base(A, marcaA)))[0];
      await new Promise((res) => setTimeout(res, 800));
      await svc("PATCH", `pedidos?id=eq.${pb.id}`, { estado: "listo" });
      await svc("PATCH", `pedidos?id=eq.${pa.id}`, { estado: "listo" });
      await new Promise((res) => setTimeout(res, 5000));

      const deA = recibidos.A, deB = recibidos.B;
      const aVeLoSuyo = deA.some((e) => e.ref === marcaA && e.tipo === "INSERT");
      const bVeLoSuyo = deB.some((e) => e.ref === marcaB && e.tipo === "INSERT");
      prueba("la sesion del dueno A RECIBE el evento de su propio pedido (INSERT)", aVeLoSuyo, JSON.stringify(deA));
      prueba("la sesion del dueno A RECIBE la actualizacion de su pedido (UPDATE)", deA.some((e) => e.ref === marcaA && e.tipo === "UPDATE"), JSON.stringify(deA));
      // Una ausencia solo vale si el canal funciona: se exige el control positivo
      prueba("la sesion del dueno A NO recibe ningun evento del restaurante B (con canal vivo)",
        aVeLoSuyo && !deA.some((e) => e.ref === marcaB || e.rid === B), aVeLoSuyo ? JSON.stringify(deA) : "sin control positivo: el canal de A no recibio ni sus propios eventos");
      prueba("la sesion del dueno B RECIBE el evento de su pedido", bVeLoSuyo, JSON.stringify(deB));
      prueba("la sesion del dueno B NO recibe ningun evento del restaurante A (con canal vivo)",
        bVeLoSuyo && !deB.some((e) => e.ref === marcaA || e.rid === A), bVeLoSuyo ? JSON.stringify(deB) : "sin control positivo: el canal de B no recibio ni sus propios eventos");
    } finally {
      for (const c of clientes) { try { await c.removeAllChannels(); await c.auth.signOut(); c.realtime.disconnect(); } catch { /* sigue */ } }
    }
  }

  return { TAQ, maxIdAntes };
}

/* ------------------------------------------------------------------
   Ejecucion: siempre limpia, pase lo que pase
------------------------------------------------------------------ */
let contexto = null;
let interrumpido = false;
async function finalizar() {
  const problemas = await limpiar(creado.restaurantes.length ? creado.restaurantes : []);
  // Cualquier resto con el dominio de pruebas
  const restos = await limpiar();
  problemas.push(...restos);

  // Dejar la secuencia de ids de pedidos como estaba (el panel actual muestra el id).
  // Solo si en este rato NO entro ningun pedido real.
  let secuencia = "no se toco";
  if (contexto) {
    try {
      const ahoraMax = filas(await svc("GET", "pedidos?select=id&order=id.desc&limit=1"))[0];
      const maxAhora = ahoraMax ? ahoraMax.id : 0;
      if (maxAhora === contexto.maxIdAntes) {
        const r = await svc("POST", "rpc/realinear_secuencia_pedidos", {});
        secuencia = r.status < 300 ? `realineada (ultimo id real: ${r.cuerpo})` : `NO se pudo realinear: ${detalle(r)}`;
      } else {
        secuencia = `NO se realineo porque entro un pedido real durante la prueba (ultimo id ${maxAhora}, antes ${contexto.maxIdAntes}); el siguiente pedido real tendra un numero algo mayor en el panel actual`;
      }
    } catch (e) { secuencia = "error al realinear: " + e.message; }
  }
  return { problemas, secuencia };
}

process.on("SIGINT", async () => {
  if (interrumpido) process.exit(130);
  interrumpido = true;
  console.log("\nInterrumpido: limpiando lo que se creo...");
  const { problemas } = await finalizar();
  console.log(problemas.length ? "No pude limpiar todo: " + problemas.join("; ") : "Limpieza completa.");
  process.exit(130);
});

try {
  contexto = await main();
} catch (e) {
  errorFatal = e;
}

const { problemas, secuencia } = await finalizar();

/* ------------------------------------------------------------------
   Informe
------------------------------------------------------------------ */
console.log("\n" + "=".repeat(100));
let grupoPrevio = "";
for (const r of resultados) {
  if (r.grupo !== grupoPrevio) { console.log(`\n[${r.grupo}]`); grupoPrevio = r.grupo; }
  console.log(`  ${r.ok ? "PASA " : "FALLA"}  ${r.nombre}${r.ok ? "" : "\n          -> " + r.info}`);
}
const fallas = resultados.filter((r) => !r.ok).length;
console.log("\n" + "=".repeat(100));
console.log(`${resultados.length - fallas} PASAN, ${fallas} FALLAN, de ${resultados.length} pruebas.`);
console.log(`Limpieza: ${problemas.length ? "CON PROBLEMAS -> " + problemas.join("; ") : "todo lo creado fue borrado"}.`);
console.log(`Secuencia de ids de pedidos: ${secuencia}.`);
if (errorFatal) console.log(`\nLA PRUEBA SE DETUVO POR UN ERROR: ${errorFatal.message}`);
if (problemas.length) {
  console.log("\nREVISA a mano en Supabase: restaurantes con slug 'test-*' y nombre 'PRUEBA-AISLAMIENTO*', y usuarios @" + DOMINIO + " en Authentication -> Users. Vuelve a correr este script para barrerlos.");
}
process.exitCode = errorFatal || fallas || problemas.length ? 1 : 0;
// Sin process.exit(): en Windows, salir de golpe con conexiones de fetch cerrandose imprime una
// "Assertion failed ... async.c". Se deja drenar y, si algo la retiene, se fuerza a los 4 s.
setTimeout(() => process.exit(), 4000).unref();
