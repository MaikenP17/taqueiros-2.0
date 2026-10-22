/* =============================================================
   PRUEBA DEL PANEL DE SUPERADMIN CONTRA LA BASE REAL  (api/superadmin.js + SQL 16)

   Ejecuta el MANEJADOR REAL de api/superadmin.js (el mismo que corre en Vercel) y los publicos (menu, estado, datos publicos,
   crear-pedido) contra la base real, con los mismos escenarios que la bateria local
   (pruebas/multirestaurante/escenarios-superadmin.mjs), y dice PASA o FALLA por cada uno.

   Corre DESPUES del SQL 10, del 11 y del 16 (supabase/16-superadmin.sql).

   QUE COMPRUEBA
     * PERMISOS: un anon, un dueno, un cajero, una cocina, alguien sin membresia, el dueno de otro restaurante y un token
       falso o manipulado NO pueden ejecutar NINGUNA accion (401/403, nunca 500) y no cambian nada; el limite de intentos;
       las funciones sa_* y la tabla de auditoria cerradas a todos los clientes por la API real (PostgREST).
     * ALTA: crea el restaurante "mr16-prueba" con su dominio de prueba, su usuario dueno (con contrasena temporal) y sus
       secretos; su menu no se mezcla con el de Taqueiros; estados, pagos, config, tarifas, dominios y miembros.
     * SECRETOS: jamas aparecen en una respuesta, en el log ni en la auditoria.
     * TAQUEIROS: solo se LEE; al terminar su fila, configuracion, secretos, tarifas, dominios y miembros estan iguales.

   QUE TOCA EN LA BASE REAL
     * Solo filas de restaurantes "mr16-prueba*" (dominios "*.mr-prueba.test", sin clientes reales) y usuarios
       "*@prueba-superadmin.example.com" (se borran al terminar, aun con Ctrl+C o si algo falla; al empezar barre los restos).
     * La tabla de auditoria: queda UNA constancia por cada accion de la prueba (superadmins de prueba, restaurantes mr16-*).
       Es de solo agregar a proposito y NO se puede borrar: es lo unico que queda. Se pueden ignorar (accion y
       restaurante_slug dicen "mr16-prueba...").
     * La secuencia de ids de pedidos (se realinea al terminar).
     * Nada sale a internet: CallMeBot y Nominatim estan simulados.

   USO (PowerShell, desde la raiz del repo) - ver docs/multirestaurante.md seccion 19
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/probar-superadmin.mjs
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

   Variables opcionales: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (se leen de supabase-publico.js si no estan).
   Sale con codigo 1 si algo FALLA.
============================================================= */
import { createRequire } from "node:module";
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

const H = cabecerasSupabase(SRV);
const leerJson = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const rest = async (metodo, ruta, cuerpo, extra) => {
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { method: metodo, headers: { ...H, ...(extra || {}) }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await leerJson(r) };
};

/* ---- Precondiciones: SQL 10, 11 y 16 aplicados ---------------------------------------------------------------- */
{
  const a = await rest("GET", "restaurantes?select=id&limit=1");
  if (a.status !== 200) { console.error("No encuentro la tabla restaurantes (HTTP " + a.status + "). Corre primero supabase/10-multirestaurante.sql."); process.exit(2); }
  const b = await rest("GET", "restaurante_dominios?select=host&limit=1");
  if (b.status !== 200) { console.error("No encuentro la tabla restaurante_dominios (HTTP " + b.status + "). Corre primero supabase/11-dominios.sql."); process.exit(2); }
  // La funcion existe si responde 42501 "No autorizado" a un actor cualquiera (si no existe, 404 / PGRST202)
  const c = await rest("POST", "rpc/sa_listar_restaurantes", { p_actor: "00000000-0000-4000-8000-0000000000ff" });
  if (!(c.cuerpo && c.cuerpo.code === "42501")) {
    console.error("No encuentro las funciones del superadmin (HTTP " + c.status + "). Corre primero supabase/16-superadmin.sql.");
    process.exit(2);
  }
}

/* ---- Barrido de restos (de una corrida anterior que no pudo limpiar) ---------------------------------------------- */
async function barrer() {
  const fallos = [];
  const del = async (ruta) => { const r = await rest("DELETE", ruta, undefined, { Prefer: "return=minimal" }); if (r.status >= 300) fallos.push(`${ruta.slice(0, 70)} -> ${r.status}`); };
  const r = await rest("GET", "restaurantes?slug=like.mr16-prueba*&select=id");
  if (r.status === 200 && r.cuerpo.length) {
    const lista = `(${r.cuerpo.map((x) => x.id).join(",")})`;
    for (const t of ["pedidos", "productos", "categorias", "tarifas_domicilio", "miembros", "restaurante_dominios", "configuracion", "salud_notificaciones", "intentos_buscar_pedido"]) {
      await del(`${t}?restaurante_id=in.${lista}`);
    }
    await del(`restaurantes?id=in.${lista}`);
  }
  const u = await fetch(`${URL_BASE}/auth/v1/admin/users?per_page=1000`, { headers: H });
  if (u.ok) {
    const cuerpo = await leerJson(u);
    for (const x of (cuerpo.users || cuerpo || [])) {
      if (x && /@prueba-superadmin\.example\.com$/.test(x.email || "")) {
        await rest("DELETE", `superadmins?user_id=eq.${x.id}`, undefined, { Prefer: "return=minimal" });
        await fetch(`${URL_BASE}/auth/v1/admin/users/${x.id}`, { method: "DELETE", headers: H });
      }
    }
  }
  return fallos;
}
const restos = await barrer();
if (restos.length) console.log("Aviso: no pude barrer algunos restos de una corrida anterior:\n  " + restos.join("\n  "));

/* ---- Ctrl+C: limpiar antes de salir ---------------------------------------------------------------------------------- */
let saliendo = false;
process.on("SIGINT", async () => {
  if (saliendo) return;
  saliendo = true;
  console.log("\nInterrumpido: limpiando lo que se creo...");
  const f = await barrer();
  console.log(f.length ? "No pude limpiar todo:\n  " + f.join("\n  ") : "Limpio.");
  process.exit(130);
});

/* ---- Escenarios (los mismos que la bateria local) ------------------------------------------------------------------ */
const { correrSuperadmin } = await import("../pruebas/multirestaurante/escenarios-superadmin.mjs");

console.log(`PANEL DE SUPERADMIN contra ${URL_BASE.replace(/^https:\/\//, "")}\n`);
let resultados = [], limpieza = [];
try {
  ({ resultados, limpieza } = await correrSuperadmin({
    apiDir: path.join(raiz, "api"), urlBase: URL_BASE, llaveServicio: SRV, llavePublicable: PUB, real: true
  }));
} catch (e) {
  console.error("\nLa corrida se interrumpio por un error: " + e.message);
  process.exitCode = 1;
}

// Doble seguridad: si algo quedo, se barre otra vez
const resto = await barrer();
let grupo = "";
for (const r of resultados) {
  if (r.grupo !== grupo) { grupo = r.grupo; console.log(`\n== ${grupo.toUpperCase()} ==`); }
  console.log(`  ${r.ok ? "PASA " : "FALLA"}  ${r.nombre}${r.ok ? "" : "\n          -> " + r.info}`);
}
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
const sucio = [...(limpieza || []), ...resto];
console.log(sucio.length ? `LIMPIEZA INCOMPLETA (vuelve a correr el script: al empezar barre los restos):\n  ${sucio.join("\n  ")}` : "Limpieza: todo lo creado se borro (salvo las filas de la auditoria, que son de solo agregar).");
process.exitCode = fallas || sucio.length || process.exitCode ? 1 : 0;
// Sin process.exit(): en Windows, salir de golpe con conexiones de fetch cerrandose imprime una
// "Assertion failed ... async.c". Se deja drenar y, si algo la retiene, se fuerza a los 4 s.
setTimeout(() => process.exit(), 4000).unref();
