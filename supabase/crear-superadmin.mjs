/* =============================================================
   DAR DE ALTA A UN SUPERADMIN  (public.superadmins)

   El superadmin es un usuario de Supabase Authentication cuyo id esta en la tabla public.superadmins. Nadie mas.
   TU creas el usuario en Authentication (Dashboard -> Authentication -> Users -> Add user, con correo y contrasena y
   "Auto Confirm User"), y este script lo busca por correo y lo agrega a la tabla con la llave de servicio.

   USO (PowerShell, desde la raiz del repo)
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/crear-superadmin.mjs tu-correo@dominio.com                  agrega a ese usuario
     node supabase/crear-superadmin.mjs tu-correo@dominio.com --solo-verificar  dice si ya es superadmin (no escribe nada)
     node supabase/crear-superadmin.mjs tu-correo@dominio.com --quitar           lo saca de superadmins
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

   NO imprime ninguna llave, contrasena ni token: solo el correo, un trozo del id del usuario y si se agrego.
   Si la llave parece pegada dos veces, no hace nada. Es idempotente: correrlo otra vez no duplica ni falla.

   IMPORTANTE: un superadmin ve y administra TODOS los restaurantes. Activa la verificacion en dos pasos (MFA) en esa
   cuenta (Authentication -> Users -> el usuario, o desde su perfil) y usa una contrasena larga y unica.

   Esto es una accion de OPERADOR (llave de servicio), no de la API: no deja fila en la auditoria del superadmin.
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
process.env.SUPABASE_URL = URL_BASE;
const { buscarUsuarioPorCorreo } = require("../api/_auth-admin.js");

const bandera = (n) => process.argv.includes(`--${n}`);
const soloVerificar = bandera("solo-verificar");
const quitar = bandera("quitar");
const correo = (process.argv.slice(2).find((a) => !a.startsWith("--")) || process.env.SUPERADMIN_CORREO || "").trim().toLowerCase();

if (!URL_BASE) { console.error("No pude leer SUPABASE_URL (ni de supabase-publico.js)."); process.exit(2); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 254) {
  console.error("Falta el correo del usuario (ya creado en Authentication). Ej: node supabase/crear-superadmin.mjs tu-correo@dominio.com");
  process.exit(2);
}
if (soloVerificar && quitar) { console.error("--solo-verificar y --quitar no se combinan."); process.exit(2); }

let SRV;
try { SRV = leerLlaveServicio(); } catch (e) { console.error(e.message); process.exit(2); }
if (tipoDeLlave(SRV) === "secreta" && SRV.split("sb_secret_").length !== 2) {
  console.error("La llave secreta de Supabase parece pegada DOS veces. Vuelve a pegarla una sola vez (clic derecho O Ctrl+V, no ambos).");
  process.exit(2);
}
const H = cabecerasSupabase(SRV);

async function rest(metodo, ruta, cuerpo, extra) {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { method: metodo, headers: { ...H, ...(extra || {}) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${metodo} ${ruta.split("?")[0]} -> HTTP ${r.status} ${t.slice(0, 160)}`);
  return t ? JSON.parse(t) : null;
}

async function principal() {
  let tabla;
  try { tabla = await rest("GET", "superadmins?select=user_id&limit=1"); }
  catch (e) { console.error("No encuentro la tabla superadmins (corre antes supabase/10-multirestaurante.sql): " + e.message); return 2; }
  void tabla;

  let usuario;
  try { usuario = await buscarUsuarioPorCorreo(correo); }
  catch (e) { console.error("No pude consultar Authentication: " + e.message); return 2; }
  if (!usuario) {
    console.error(`No existe ningun usuario con el correo ${correo} en Authentication. Crealo primero (Dashboard -> Authentication -> Users -> Add user, con "Auto Confirm User") y vuelve a correr esto.`);
    return 2;
  }
  const corto = usuario.id.slice(0, 8) + "...";
  console.log(`Usuario: ${usuario.email} (id ${corto})`);

  const ya = await rest("GET", `superadmins?user_id=eq.${usuario.id}&select=user_id`);
  const esYa = ya.length > 0;

  if (soloVerificar) {
    console.log(esYa ? "Es superadmin." : "NO es superadmin.");
    return esYa ? 0 : 1;
  }
  if (quitar) {
    if (!esYa) { console.log("No era superadmin: nada que quitar."); return 0; }
    await rest("DELETE", `superadmins?user_id=eq.${usuario.id}`, undefined, { Prefer: "return=minimal" });
    const sigue = await rest("GET", `superadmins?user_id=eq.${usuario.id}&select=user_id`);
    if (sigue.length) { console.error("No se pudo quitar."); return 1; }
    console.log("Quitado de superadmins.");
    return 0;
  }
  if (esYa) { console.log("Ya era superadmin: nada que hacer."); return 0; }

  await rest("POST", "superadmins", { user_id: usuario.id }, { Prefer: "return=minimal,resolution=ignore-duplicates" });
  const ahora = await rest("GET", `superadmins?user_id=eq.${usuario.id}&select=user_id`);
  if (!ahora.length) { console.error("No quedo registrado. Revisa los permisos de la llave de servicio."); return 1; }
  console.log("Agregado a superadmins y verificado.");
  console.log("Recuerda: activa la verificacion en dos pasos (MFA) en esa cuenta.");
  return 0;
}

// Sin process.exit() inmediato: en Windows, salir de golpe con conexiones de fetch cerrandose imprime una
// "Assertion failed ... async.c" y cambia el codigo de salida. Se deja drenar y, si algo la retiene, se fuerza a los 4 s.
process.exitCode = await principal();
setTimeout(() => process.exit(), 4000).unref();
