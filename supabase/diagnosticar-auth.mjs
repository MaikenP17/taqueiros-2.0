/* =============================================================
   DIAGNOSTICO DE LA VALIDACION DE SESION CONTRA LA BASE REAL

   Responde, con la base real, "que combinacion de cabeceras acepta Supabase
   Auth para decir quien es el dueno de un token de sesion?" y comprueba que
   el helper del servidor (api/_sesion.js) usa una que funciona.

   QUE HACE
     1. Crea un usuario TEMPORAL (test-auth-<aleatorio>@example.invalid,
        contrasena aleatoria, confirmado con la API de administracion) e
        inicia sesion con la llave publishable para obtener su token.
     2. Prueba, una por una, las combinaciones de cabeceras apikey /
        Authorization contra GET /auth/v1/user, y supabase-js auth.getUser.
     3. Prueba el helper real del servidor (api/_sesion.js), con y sin
        SUPABASE_PUBLISHABLE_KEY.
     4. BORRA al usuario al terminar, aunque algo falle o pulses Ctrl+C
        (y al empezar borra los restos de una corrida anterior).

   QUE IMPRIME: solo el nombre de la variante, el codigo HTTP y el codigo de
   error (error_code / code). Nunca imprime llaves, tokens ni contrasenas.
   Del token solo dice su largo, el algoritmo de firma (alg) y si contiene la
   letra "s" (el bug que rompia las sesiones reales).

   QUE TOCA EN LA BASE REAL: un solo usuario de Auth que se borra. No cambia
   ninguna tabla, ninguna politica ni ningun ajuste de Auth, y NO habilita el
   registro publico (el usuario se crea con la API de administracion).

   USO (PowerShell, desde la raiz del repo):
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/diagnosticar-auth.mjs
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

   Variables opcionales: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (se leen de
   supabase-publico.js si no estan). supabase-js es opcional: si no esta
   instalado esa variante se omite (npm i --no-save @supabase/supabase-js@2.117.2).
   Sale con codigo 0 si la variante documentada y el helper del servidor
   funcionan y el usuario temporal se borro; con 1 si no.
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
const publico = fs.readFileSync(path.join(raiz, "supabase-publico.js"), "utf8");
const URL_BASE = (process.env.SUPABASE_URL || (publico.match(/url:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");
const PUB = (process.env.SUPABASE_PUBLISHABLE_KEY || (publico.match(/publishableKey:\s*"([^"]+)"/) || [])[1] || "").trim();
if (!URL_BASE || !PUB) { console.error("No pude leer la URL y la llave publishable de supabase-publico.js"); process.exit(2); }
if (tipoDeLlave(PUB) !== "publicable") { console.error("SUPABASE_PUBLISHABLE_KEY / supabase-publico.js no tiene una llave sb_publishable_..."); process.exit(2); }

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

/* Nada de lo que se imprima debe contener una llave, un token o la contrasena. */
const secretos = [SRV, PUB];
const limpio = (txt) => secretos.filter(Boolean).reduce((t, s) => t.split(s).join("***"), String(txt));
const decir = (txt) => console.log(limpio(txt));

const H = cabecerasSupabase(SRV);
const leerJson = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return {}; } };
/* El codigo de error que devuelve Supabase (no el mensaje): error_code de Auth, o code/error del gateway. */
const codigoDe = (c) => {
  if (!c || typeof c !== "object") return "";
  const v = c.error_code || c.code || c.error || "";
  return typeof v === "string" || typeof v === "number" ? String(v).slice(0, 60).replace(/[^\w.-]/g, "_") : "";
};

/* ---- estado a limpiar ------------------------------------------------------------------------------------------ */
let usuarioId = null;
let creado = false;
const email = `test-auth-${crypto.randomBytes(5).toString("hex")}@example.invalid`;
const password = "Pw-" + crypto.randomBytes(12).toString("hex");
secretos.push(password);

async function borrarUsuario(id) {
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H });
  return r.ok;
}
async function barrerRestos() {
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users?per_page=1000`, { headers: H });
  if (!r.ok) return `no pude listar usuarios (HTTP ${r.status})`;
  const c = await leerJson(r);
  let n = 0;
  for (const u of (c.users || [])) {
    if (u && /^test-auth-[0-9a-f]+@example\.invalid$/.test(u.email || "")) { if (await borrarUsuario(u.id)) n++; }
  }
  return n ? `borre ${n} usuario(s) temporal(es) de una corrida anterior` : "";
}

let limpiando = false;
async function limpiar() {
  if (limpiando || !usuarioId) return usuarioId === null;
  limpiando = true;
  let ok = false;
  try { ok = await borrarUsuario(usuarioId); } catch (e) { ok = false; }
  if (ok) usuarioId = null;
  return ok;
}
process.on("SIGINT", async () => {
  decir("\nInterrumpido: borrando el usuario temporal...");
  const ok = await limpiar();
  decir(ok ? "Usuario temporal borrado." : "NO pude borrar el usuario temporal: " + email + " (borralo en Authentication > Users, o vuelve a correr este script: al empezar barre los restos).");
  process.exit(130);
});

/* ---- resultados ------------------------------------------------------------------------------------------------ */
const filas = [];
function fila(clave, nombre, ok, detalle) {
  filas.push({ clave, ok });
  decir(`  [${ok ? "FUNCIONA" : "rechaza "}] ${nombre.padEnd(74)} ${detalle}`);
}
async function variante(clave, nombre, cabeceras) {
  let detalle;
  let ok = false;
  try {
    const r = await fetch(`${URL_BASE}/auth/v1/user`, { headers: cabeceras });
    const c = await leerJson(r);
    ok = r.status === 200 && typeof c.id === "string" && c.id === usuarioId;
    detalle = `HTTP ${r.status}` + (ok ? "" : codigoDe(c) ? `  error=${codigoDe(c)}` : r.status === 200 ? "  (200 pero con otro usuario)" : "");
  } catch (e) { detalle = "sin respuesta (" + String(e.message).slice(0, 40) + ")"; }
  fila(clave, nombre, ok, detalle);
}

let codigo = 0;
let borrado = false;
try {
  decir(`DIAGNOSTICO DE SESION contra ${URL_BASE.replace(/^https:\/\//, "")}\n`);
  const resto = await barrerRestos();
  if (resto) decir("Aviso: " + resto + "\n");

  /* 1. Usuario temporal y su token */
  decir("1. Usuario temporal");
  const rc = await fetch(`${URL_BASE}/auth/v1/admin/users`, { method: "POST", headers: H, body: JSON.stringify({ email, password, email_confirm: true }) });
  const uc = await leerJson(rc);
  decir(`   crear usuario con la API de administracion (llave secreta en apikey): HTTP ${rc.status}` + (rc.ok ? "" : `  error=${codigoDe(uc)}`));
  if (!rc.ok || !uc.id) throw new Error("no se pudo crear el usuario temporal; sin el no hay nada que probar");
  usuarioId = String(uc.id);
  creado = true;

  const rt = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "apikey": PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email, password })
  });
  const ut = await leerJson(rt);
  decir(`   iniciar sesion con la llave publishable: HTTP ${rt.status}` + (rt.ok ? "" : `  error=${codigoDe(ut)}`));
  const TOKEN = ut.access_token;
  if (!rt.ok || typeof TOKEN !== "string") throw new Error("no se pudo iniciar sesion con el usuario temporal");
  secretos.push(TOKEN);

  let alg = "?";
  try { alg = JSON.parse(Buffer.from(TOKEN.split(".")[0], "base64url").toString("utf8")).alg || "?"; } catch { /* sin alg */ }
  const conS = /s/.test(TOKEN);
  decir(`   el token: ${TOKEN.length} caracteres, ${TOKEN.split(".").length} partes, alg=${alg}, ${conS ? "CONTIENE" : "no contiene"} la letra "s"`);
  decir(`   el codigo ANTERIOR (que rechazaba todo token con "s") ${conS ? "lo habria rechazado: ESA era la causa de los 401" : "no lo habria rechazado (la causa seria otra)"}`);
  const rj = await fetch(`${URL_BASE}/auth/v1/.well-known/jwks.json`, { headers: { apikey: PUB } });
  const cj = await leerJson(rj);
  decir(`   JWKS publico (firmas asimetricas): HTTP ${rj.status}` + (Array.isArray(cj.keys) ? `, ${cj.keys.length} clave(s)` : ""));

  /* 2. Variantes de cabeceras contra GET /auth/v1/user */
  decir("\n2. GET /auth/v1/user con cada combinacion de cabeceras");
  const B = (t) => `Bearer ${t}`;
  await variante("doc", "A. apikey=publishable + Authorization=Bearer <token del usuario>   (documentada)", { apikey: PUB, Authorization: B(TOKEN) });
  await variante("secreta-apikey", "B. apikey=secreta + Authorization=Bearer <token del usuario>", { apikey: SRV, Authorization: B(TOKEN) });
  await variante("secreta-bearer", "C. apikey=secreta + Authorization=Bearer <la secreta>   (lo que NO debe hacerse)", { apikey: SRV, Authorization: B(SRV) });
  await variante("pub-secreta-bearer", "D. apikey=publishable + Authorization=Bearer <la secreta>", { apikey: PUB, Authorization: B(SRV) });
  await variante("token-apikey", "E. apikey=<token del usuario> + Authorization=Bearer <token del usuario>", { apikey: TOKEN, Authorization: B(TOKEN) });
  await variante("sin-apikey", "F. sin apikey + Authorization=Bearer <token del usuario>", { Authorization: B(TOKEN) });
  await variante("solo-pub", "G. apikey=publishable, sin Authorization", { apikey: PUB });
  await variante("solo-secreta", "H. apikey=secreta, sin Authorization", { apikey: SRV });
  await variante("pub-pub", "I. apikey=publishable + Authorization=Bearer <la publishable>", { apikey: PUB, Authorization: B(PUB) });
  await variante("bearer-minuscula", "J. apikey=publishable + Authorization=bearer <token> (esquema en minuscula)", { apikey: PUB, Authorization: `bearer ${TOKEN}` });
  await variante("sin-esquema", "K. apikey=publishable + Authorization=<token> (sin la palabra Bearer)", { apikey: PUB, Authorization: TOKEN });

  /* 3. supabase-js */
  decir("\n3. supabase-js auth.getUser(token)");
  let sdk = null;
  try { sdk = await import("@supabase/supabase-js"); } catch { sdk = null; }
  if (!sdk) {
    decir("   (omitida: supabase-js no esta instalado. Opcional: npm i --no-save @supabase/supabase-js@2.117.2)");
  } else {
    const opciones = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
    for (const [clave, nombre, llave] of [
      ["js-pub", "L. createClient(url, publishable).auth.getUser(token)", PUB],
      ["js-secreta", "M. createClient(url, secreta).auth.getUser(token)", SRV]
    ]) {
      let ok = false, detalle;
      try {
        const cliente = sdk.createClient(URL_BASE, llave, opciones);
        const { data, error } = await cliente.auth.getUser(TOKEN);
        ok = !error && data && data.user && data.user.id === usuarioId;
        detalle = ok ? "OK" : `HTTP ${error && error.status ? error.status : "?"}  error=${(error && (error.code || error.name)) || "?"}`;
      } catch (e) { detalle = "excepcion " + String((e && e.name) || "Error"); }
      fila(clave, nombre, ok, detalle);
    }
  }

  /* 4. El helper real del servidor */
  decir("\n4. El helper del servidor (api/_sesion.js, el que usa api/reembolso.js)");
  const { usuarioDeToken } = require("../api/_sesion.js");
  const envAntes = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY, p: process.env.SUPABASE_PUBLISHABLE_KEY };
  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SRV;
  async function helper(clave, nombre, conPublicable) {
    if (conPublicable) process.env.SUPABASE_PUBLISHABLE_KEY = PUB; else delete process.env.SUPABASE_PUBLISHABLE_KEY;
    let ok = false, detalle;
    try {
      const u = await usuarioDeToken(TOKEN);
      ok = !!u && u.id === usuarioId;
      detalle = ok ? "devuelve el usuario correcto" : "devuelve " + (u ? "OTRO usuario" : "null (sin sesion)");
    } catch (e) { detalle = "lanza: " + String(e.message).slice(0, 70); }
    fila(clave, nombre, ok, detalle);
  }
  try {
    await helper("helper-pub", "N. SUPABASE_PUBLISHABLE_KEY definida (apikey = publishable)", true);
    await helper("helper-secreta", "O. SIN SUPABASE_PUBLISHABLE_KEY (apikey = la secreta)", false);
    let nulo = null;
    try { nulo = await usuarioDeToken(TOKEN.slice(0, -5) + (TOKEN.slice(-5) === "AAAAA" ? "BBBBB" : "AAAAA")); } catch (e) { nulo = "lanza"; }
    fila("helper-invalido", "P. un token con la firma alterada se rechaza (null, no un error)", nulo === null, nulo === null ? "devuelve null" : "devuelve " + (nulo === "lanza" ? "una excepcion" : "un usuario"));
  } finally {
    for (const [k, v] of [["SUPABASE_URL", envAntes.u], ["SUPABASE_SERVICE_ROLE_KEY", envAntes.k], ["SUPABASE_PUBLISHABLE_KEY", envAntes.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  /* 5. Veredicto */
  const f = (c) => (filas.find((x) => x.clave === c) || {}).ok === true;
  decir("\n== VEREDICTO ==");
  decir(`  Variante documentada (A: publishable en apikey + token del usuario en Bearer): ${f("doc") ? "FUNCIONA" : "NO FUNCIONA"}`);
  decir(`  Llave secreta en apikey + token del usuario (B): ${f("secreta-apikey") ? "FUNCIONA (el servidor sirve aunque falte SUPABASE_PUBLISHABLE_KEY)" : "NO FUNCIONA: define SUPABASE_PUBLISHABLE_KEY en Vercel"}`);
  decir(`  Llave secreta como Bearer (C): ${f("secreta-bearer") ? "la acepta (no deberia)" : "la rechaza, como se esperaba (no es un JWT)"}`);
  decir(`  supabase-js: ${sdk ? `publishable ${f("js-pub") ? "FUNCIONA" : "NO"}, secreta ${f("js-secreta") ? "FUNCIONA" : "NO"}` : "no probado"}`);
  decir(`  Helper del servidor: con SUPABASE_PUBLISHABLE_KEY ${f("helper-pub") ? "OK" : "FALLA"}; sin ella ${f("helper-secreta") ? "OK" : "FALLA"}; token alterado ${f("helper-invalido") ? "rechazado" : "NO rechazado"}`);
  if (!f("helper-pub")) codigo = 1;
  if (!f("doc")) codigo = 1;
  if (!f("helper-invalido")) codigo = 1;
  if (!f("helper-secreta")) decir("  -> Recomendacion: crea SUPABASE_PUBLISHABLE_KEY en Vercel (es publica, la misma de supabase-publico.js) y redespliega.");
  else decir("  -> Aun asi se recomienda tener SUPABASE_PUBLISHABLE_KEY en Vercel: es la forma documentada y es publica (la misma de supabase-publico.js).");
} catch (e) {
  console.error("\nEl diagnostico se interrumpio: " + limpio(e.message));
  codigo = 1;
} finally {
  borrado = await limpiar().catch(() => false);
}

decir(!creado ? "\n(No se llego a crear ningun usuario temporal: no hay nada que borrar.)" : borrado ? "\nUsuario temporal borrado." : `\nNO pude borrar el usuario temporal ${email}: borralo en Supabase > Authentication > Users, o vuelve a correr este script (al empezar barre los restos).`);
if (!borrado) codigo = 1;
process.exitCode = codigo;
setTimeout(() => process.exit(), 3000).unref();
