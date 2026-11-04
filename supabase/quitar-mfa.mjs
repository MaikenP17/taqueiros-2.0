/* =============================================================
   QUITAR LOS FACTORES DE VERIFICACION EN DOS PASOS (MFA) DE UN USUARIO  (recuperacion si se pierde el celular)

   Desde el paso 3B api/superadmin.js exige que el superadmin entre con un segundo factor (TOTP). Si Carlos pierde el celular
   (o la app del autenticador), NO puede generar el codigo y se queda fuera. No hay ninguna variable ni parametro que apague la
   MFA en el servidor (a proposito). La salida es BORRAR los factores de ese usuario en Supabase Auth: el usuario vuelve a
   iniciar sesion solo con su contrasena (aal1) y puede enrolar un factor nuevo desde la pantalla de superadmin.

   Usa la API de administracion de Auth documentada por Supabase (auth.admin.mfa.deleteFactor):
       GET    /auth/v1/admin/users/{id}/factors
       DELETE /auth/v1/admin/users/{id}/factors/{factor_id}
   Al borrar un factor verificado, Supabase cierra todas las sesiones de ese usuario.

   USO (PowerShell, desde la raiz del repo)
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/quitar-mfa.mjs tu-correo@dominio.com               solo MUESTRA los factores (no borra nada)
     node supabase/quitar-mfa.mjs tu-correo@dominio.com --confirmar   los borra
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

   NO imprime llaves, contrasenas, secretos ni codigos: solo el tipo, el estado y un trozo del id de cada factor.
   Es una accion de OPERADOR (llave de servicio), no de la API: quien la corre ya tiene la llave de servicio, que es mas que ser
   superadmin. Por eso NO existe ni puede existir una accion equivalente en api/superadmin.js.
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

const confirmar = process.argv.includes("--confirmar");
const correo = (process.argv.slice(2).find((a) => !a.startsWith("--")) || "").trim().toLowerCase();

if (!URL_BASE) { console.error("No pude leer SUPABASE_URL (ni de supabase-publico.js)."); process.exit(2); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || correo.length > 254) {
  console.error("Falta el correo del usuario. Ej: node supabase/quitar-mfa.mjs tu-correo@dominio.com");
  process.exit(2);
}
let SRV;
try { SRV = leerLlaveServicio(); } catch (e) { console.error(e.message); process.exit(2); }
if (tipoDeLlave(SRV) === "secreta" && SRV.split("sb_secret_").length !== 2) {
  console.error("La llave secreta de Supabase parece pegada DOS veces. Vuelve a pegarla una sola vez (clic derecho O Ctrl+V, no ambos).");
  process.exit(2);
}
const H = cabecerasSupabase(SRV);

async function principal() {
  let usuario;
  try { usuario = await buscarUsuarioPorCorreo(correo); }
  catch (e) { console.error("No pude consultar Authentication: " + e.message); return 2; }
  if (!usuario) { console.error(`No existe ningun usuario con el correo ${correo}.`); return 2; }
  console.log(`Usuario: ${usuario.email} (id ${usuario.id.slice(0, 8)}...)`);

  const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${usuario.id}/factors`, { headers: H });
  const texto = await r.text();
  if (!r.ok) {
    console.error(`Supabase Auth no dejo listar los factores (HTTP ${r.status}). Si este proyecto no ofrece esa ruta, mira docs/multirestaurante.md seccion 23 (recuperacion).`);
    return 1;
  }
  let lista = [];
  try { const j = JSON.parse(texto); lista = Array.isArray(j) ? j : (j.factors || j.data || []); } catch (e) { lista = []; }
  if (!lista.length) { console.log("Este usuario no tiene ningun factor de verificacion en dos pasos: nada que quitar."); return 0; }
  for (const f of lista) console.log(`  - factor ${String(f.id).slice(0, 8)}...  tipo ${f.factor_type || f.type || "?"}  estado ${f.status || "?"}`);

  if (!confirmar) {
    console.log(`\nNo se borro nada. Para borrar ${lista.length === 1 ? "este factor" : "estos " + lista.length + " factores"} vuelve a correr el comando con --confirmar.`);
    return 0;
  }
  let fallos = 0;
  for (const f of lista) {
    const d = await fetch(`${URL_BASE}/auth/v1/admin/users/${usuario.id}/factors/${f.id}`, { method: "DELETE", headers: H });
    if (d.ok) console.log(`  borrado ${String(f.id).slice(0, 8)}...`); else { fallos++; console.error(`  NO se pudo borrar ${String(f.id).slice(0, 8)}... (HTTP ${d.status})`); }
  }
  console.log(fallos ? `\n${fallos} factor(es) no se pudieron borrar.` : "\nListo: el usuario ya no tiene verificacion en dos pasos. Que inicie sesion con su contrasena y enrole un factor nuevo en cuanto pueda.");
  return fallos ? 1 : 0;
}

process.exitCode = await principal();
setTimeout(() => process.exit(), 4000).unref();
