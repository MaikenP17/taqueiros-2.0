/* =============================================================
   PRUEBAS DE LAS OPCIONES DE PRODUCTO  (contra Supabase real)

   Corre DESPUES de supabase/18-opciones-producto.sql. Demuestra, con sesiones reales, que:
     * cada rol puede (o no) leer y escribir las opciones de SU restaurante, y que un restaurante no ve ni toca las de otro;
     * la base rechaza lo que no debe (quitar con precio, precios fuera de rango, ids y nombres raros, mas de 12);
     * el servidor calcula bien el precio (base + extras) y rechaza opciones ajenas, apagadas o inexistentes;
     * el menu publico trae solo las opciones ACTIVAS.

   COMO FUNCIONA
     1. Con la llave secreta crea DOS restaurantes de prueba (slug "test-opc-<codigo>-a" y "-b", nombre
        "PRUEBA-OPCIONES ...") con una categoria y un producto cada uno, y cinco usuarios de prueba en Auth:
        dueno A, cajero A, cocina A, dueno B y uno SIN membresia.
     2. Inicia sesion de verdad con cada uno y prueba con la llave PUBLISHABLE (la que usa el navegador).
        Despues de cada intento de escritura ajena comprueba con la llave secreta que el dato NO cambio.
     3. Llama a las funciones REALES del servidor (validarItems, leerMenu) contra esos restaurantes.
     4. Borra TODO lo que creo, aun si algo falla o lo interrumpes con Ctrl+C (y al empezar barre restos).

   QUE TOCA EN LA BASE REAL
     * Solo filas de los dos restaurantes de prueba y usuarios de prueba (se borran). Mientras corre (1 minuto) existen
       categorias y productos de prueba APAGADOS: /api/menu de ningun dominio real los muestra.
     * NO crea, cambia ni borra NINGUN pedido (ni en el restaurante demo ni en ninguno): el calculo se prueba con las
       funciones del servidor, que no escriben pedidos.
     * Del restaurante demo SOLO LEE (cuenta sus opciones antes y despues, para demostrar que no cambiaron).

   USO (PowerShell, desde la raiz del repo) - ver docs/multirestaurante.md seccion 22
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/probar-opciones.mjs
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

   Variables opcionales: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY. Sale con codigo 1 si algo FALLA, y con 2 si falta algo
   (la llave, o el SQL 18 sin correr).
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

/* El servidor (las funciones de api/) lee estas variables */
process.env.SUPABASE_URL = URL_BASE;
const { validarItems } = require("../api/_precios.js");
const { leerMenu, leerOpcionesActivas } = require("../api/_menu.js");

const TAQUEIROS_ID = "00000000-0000-4000-8000-000000000001";
const H_SRV = cabecerasSupabase(SRV);
async function leerCuerpo(resp) { const t = await resp.text(); try { return JSON.parse(t); } catch { return t; } }

/** Llamada a PostgREST. token = JWT de un usuario; sin token = anon; servidor = true usa la llave secreta. */
async function api(metodo, ruta, { token, servidor, cuerpo, prefer = "return=representation" } = {}) {
  const cab = servidor
    ? { ...H_SRV }
    : { apikey: PUB, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  if (metodo !== "GET" && prefer) cab.Prefer = prefer;
  const r = await fetch(`${URL_BASE}/rest/v1/${ruta}`, { method: metodo, headers: cab, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  return { status: r.status, cuerpo: await leerCuerpo(r) };
}
const svc = (m, ruta, cuerpo, prefer) => api(m, ruta, { servidor: true, cuerpo, prefer });
const filas = (r) => (Array.isArray(r.cuerpo) ? r.cuerpo : []);
const detalle = (r) => `HTTP ${r.status} ${JSON.stringify(r.cuerpo).slice(0, 140)}`;
const codigo = (r) => (r.cuerpo && r.cuerpo.code) || "";
const sinEfecto = (r) => r.status >= 400 || (Array.isArray(r.cuerpo) && r.cuerpo.length === 0);

const resultados = [];
let grupoActual = "";
const grupo = (n) => { grupoActual = n; };
const prueba = (nombre, ok, info = "") => resultados.push({ grupo: grupoActual, nombre, ok: !!ok, info: ok ? "" : String(info) });

const etiqueta = "o" + crypto.randomBytes(3).toString("hex");
const DOMINIO = "opciones.example.com";
const creado = { restaurantes: [], usuarios: [] };
const clave = () => crypto.randomBytes(18).toString("base64url") + "aA1!";

async function crearUsuario(alias) {
  const email = `${etiqueta}-${alias}@${DOMINIO}`;
  const password = clave();
  const r = await fetch(`${URL_BASE}/auth/v1/admin/users`, { method: "POST", headers: H_SRV, body: JSON.stringify({ email, password, email_confirm: true }) });
  const u = await leerCuerpo(r);
  if (!r.ok || !u.id) throw new Error(`No pude crear el usuario ${alias}: HTTP ${r.status} ${JSON.stringify(u).slice(0, 150)}`);
  creado.usuarios.push(u.id);
  return { id: u.id, email, password, alias };
}
async function iniciarSesion(u) {
  const r = await fetch(`${URL_BASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" }, body: JSON.stringify({ email: u.email, password: u.password })
  });
  const s = await leerCuerpo(r);
  if (!r.ok || !s.access_token) throw new Error(`No pude iniciar sesion como ${u.alias}: HTTP ${r.status} ${JSON.stringify(s).slice(0, 150)}`);
  u.token = s.access_token;
}

/* Limpieza: los propios (ids) o restos de corridas anteriores (slug test-opc-*) */
async function limpiar(ids = null) {
  const problemas = [];
  const paso = async (nombre, fn) => { try { await fn(); } catch (e) { problemas.push(`${nombre}: ${e.message}`); } };
  let rids = ids;
  if (!rids) {
    const r = await svc("GET", "restaurantes?select=id&slug=like.test-opc-*&nombre=like.PRUEBA-OPCIONES*");
    rids = filas(r).map((x) => x.id);
  }
  if (rids.length) {
    const lista = `in.(${rids.join(",")})`;
    // producto_opciones se va sola con sus productos (ON DELETE CASCADE); se borra antes por claridad
    for (const t of ["producto_opciones", "productos", "categorias", "tarifas_domicilio", "configuracion", "salud_notificaciones",
                     "contadores_pedido", "restaurante_secretos", "miembros", "pedidos", "intentos_buscar_pedido"]) {
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
  await paso("usuarios", async () => {
    let objetivo = [...creado.usuarios];
    if (!ids) {
      const r = await fetch(`${URL_BASE}/auth/v1/admin/users?page=1&per_page=1000`, { headers: H_SRV });
      objetivo = ((await leerCuerpo(r)).users || []).filter((u) => (u.email || "").endsWith("@" + DOMINIO)).map((u) => u.id);
    }
    for (const id of objetivo) {
      const r = await fetch(`${URL_BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: H_SRV });
      if (!r.ok && r.status !== 404) throw new Error(`usuario ${id}: HTTP ${r.status}`);
    }
  });
  return problemas;
}

let limpiando = false;
async function salirLimpio(codigoSalida) {
  if (limpiando) return;
  limpiando = true;
  const p = await limpiar(creado.restaurantes.length ? creado.restaurantes : null);
  console.log(p.length ? "LIMPIEZA INCOMPLETA:\n  " + p.join("\n  ") : "Limpieza: todo lo creado se borro.");
  process.exit(p.length ? 1 : codigoSalida);
}
process.on("SIGINT", () => { console.log("\nInterrumpido: limpiando..."); salirLimpio(1); });

async function main() {
  const t0 = Date.now();

  // ---- 0. La tabla tiene que existir (SQL 18) ----
  const sonda = await svc("GET", "producto_opciones?select=id&limit=1");
  if (sonda.status >= 400) {
    console.error("La tabla producto_opciones no existe todavia (" + detalle(sonda) + ").\nCorre primero supabase/18-opciones-producto.sql en el SQL Editor de Supabase.");
    process.exit(2);
  }
  const barrido = await limpiar();
  if (barrido.length) console.log("Aviso al barrer restos de una corrida anterior:\n  " + barrido.join("\n  "));

  // ---- lo que NO debe cambiar: opciones del restaurante demo y pedidos del demo (solo lectura) ----
  const huellaDemo = async () => {
    const o = filas(await svc("GET", `producto_opciones?select=*&restaurante_id=eq.${TAQUEIROS_ID}&order=producto_id.asc,id.asc`));
    const p = await svc("GET", `pedidos?select=id&restaurante_id=eq.${TAQUEIROS_ID}&limit=1&order=id.desc`);
    return { opciones: o.length, h: crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex"), ultimoPedido: filas(p)[0] ? filas(p)[0].id : null };
  };
  const demoAntes = await huellaDemo();

  // ---- fixtures ----
  grupo("preparacion");
  const mk = async (sufijo) => {
    const r = await svc("POST", "restaurantes", { slug: `test-opc-${etiqueta}-${sufijo}`, nombre: `PRUEBA-OPCIONES ${sufijo.toUpperCase()} ${etiqueta}`, estado: "activo" });
    if (r.status >= 300) throw new Error("no pude crear el restaurante " + sufijo + ": " + detalle(r));
    const rest = filas(r)[0];
    creado.restaurantes.push(rest.id);
    for (const [t, c] of [
      ["categorias", { restaurante_id: rest.id, id: "cat", nombre: "Cat " + sufijo, emoji: "x", orden: 1, activa: true }],
      ["productos", [{ restaurante_id: rest.id, id: "taco", nombre: "Taco " + sufijo, precio: sufijo === "a" ? 10000 : 20000, categoria: "cat", orden: 1, disponible: true },
                      { restaurante_id: rest.id, id: "otro", nombre: "Otro " + sufijo, precio: 7000, categoria: "cat", orden: 2, disponible: true }]]
    ]) {
      const x = await svc("POST", t, c);
      if (x.status >= 300) throw new Error(`no pude crear ${t} de ${sufijo}: ${detalle(x)}`);
    }
    return rest;
  };
  const A = await mk("a");
  const B = await mk("b");
  const opcion = (r, producto, id, tipo, nombre, precio, orden = 0, activa = true) => ({ restaurante_id: r.id, producto_id: producto, id, tipo, nombre, precio, orden, activa });
  const sembrar = await svc("POST", "producto_opciones", [
    opcion(A, "taco", "sin-cebolla", "quitar", "Sin cebolla", 0, 0), opcion(A, "taco", "extra-queso", "extra", "Queso extra", 2000, 10),
    opcion(A, "taco", "extra-tocineta", "extra", "Tocineta extra", 3000, 11), opcion(A, "taco", "extra-apagada", "extra", "Apagada", 1500, 12, false),
    opcion(A, "otro", "extra-solo", "extra", "Solo del otro", 500, 0),
    opcion(B, "taco", "extra-queso", "extra", "Queso extra de B", 9000, 0), opcion(B, "taco", "extra-solo-b", "extra", "Solo de B", 700, 1)
  ]);
  prueba("el servidor (llave secreta) puede sembrar opciones en los dos restaurantes de prueba", sembrar.status < 300 && filas(sembrar).length === 7, detalle(sembrar));

  const u = {};
  for (const alias of ["dueno-a", "cajero-a", "cocina-a", "dueno-b", "nadie"]) u[alias] = await crearUsuario(alias);
  const mm = await svc("POST", "miembros", [
    { user_id: u["dueno-a"].id, restaurante_id: A.id, rol: "dueno", activo: true }, { user_id: u["cajero-a"].id, restaurante_id: A.id, rol: "cajero", activo: true },
    { user_id: u["cocina-a"].id, restaurante_id: A.id, rol: "cocina", activo: true }, { user_id: u["dueno-b"].id, restaurante_id: B.id, rol: "dueno", activo: true }
  ]);
  if (mm.status >= 300) throw new Error("no pude crear las membresias: " + detalle(mm));
  for (const x of Object.values(u)) await iniciarSesion(x);
  const T = (alias) => u[alias].token;
  const contar = async (token) => { const r = await api("GET", "producto_opciones?select=id", { token }); return r.status < 300 ? filas(r).length : "HTTP " + r.status; };
  const desdeBase = async (r, extra = "") => filas(await svc("GET", `producto_opciones?select=*&restaurante_id=eq.${r.id}${extra}`));

  // ---- LEER ----
  grupo("leer");
  prueba("el dueno de A ve las 5 de A y ninguna de B", (await contar(T("dueno-a"))) === 5);
  prueba("el cajero de A ve las 5 de A", (await contar(T("cajero-a"))) === 5);
  prueba("el dueno de B ve solo las 2 de B", (await contar(T("dueno-b"))) === 2);
  prueba("la cocina de A no ve ninguna", (await contar(T("cocina-a"))) === 0);
  prueba("alguien sin membresia no ve ninguna", (await contar(T("nadie"))) === 0);
  const anon = await api("GET", "producto_opciones?select=id");
  prueba("ANON no puede leer la tabla (permiso denegado o nada)", anon.status >= 400 || filas(anon).length === 0, detalle(anon));
  const cruzado = await api("GET", `producto_opciones?select=id&restaurante_id=eq.${B.id}`, { token: T("dueno-a") });
  prueba("pedirle a la base las de B con la sesion del dueno de A devuelve 0 filas", cruzado.status < 300 && filas(cruzado).length === 0, detalle(cruzado));

  // ---- ESCRIBIR / AISLAMIENTO ----
  grupo("escribir");
  const nueva = (r, id, extra = {}) => ({ restaurante_id: r.id, producto_id: "taco", id, tipo: "extra", nombre: "Prueba " + id, precio: 100, ...extra });
  const dA = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: nueva(A, "dueno-a-puso") });
  prueba("el dueno de A inserta una opcion en su producto", dA.status < 300 && filas(dA).length === 1, detalle(dA));
  const dAB = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: nueva(B, "intruso") });
  prueba("el dueno de A NO inserta en un producto de B", dAB.status >= 400 && (await desdeBase(B, "&id=eq.intruso")).length === 0, detalle(dAB));
  const dAup = await api("PATCH", `producto_opciones?restaurante_id=eq.${B.id}`, { token: T("dueno-a"), cuerpo: { precio: 1 } });
  prueba("el dueno de A NO cambia las de B (y no cambiaron)", sinEfecto(dAup) && (await desdeBase(B)).every((f) => f.precio !== 1), detalle(dAup));
  const dAdel = await api("DELETE", `producto_opciones?restaurante_id=eq.${B.id}`, { token: T("dueno-a") });
  prueba("el dueno de A NO borra las de B (siguen las 2)", sinEfecto(dAdel) && (await desdeBase(B)).length === 2, detalle(dAdel));
  const mover = await api("PATCH", `producto_opciones?restaurante_id=eq.${A.id}&id=eq.extra-queso`, { token: T("dueno-a"), cuerpo: { restaurante_id: B.id } });
  prueba("el dueno de A NO puede mover una opcion a B (la fila sigue en A)", mover.status >= 400 && (await desdeBase(A, "&id=eq.extra-queso")).length === 1, detalle(mover));
  const cambioId = await api("PATCH", `producto_opciones?restaurante_id=eq.${A.id}&id=eq.extra-queso&producto_id=eq.taco`, { token: T("dueno-a"), cuerpo: { producto_id: "otro" } });
  prueba("el dueno de A NO puede cambiar el producto de una opcion", cambioId.status >= 400 && (await desdeBase(A, "&id=eq.extra-queso")).length === 1 && (await desdeBase(A, "&id=eq.extra-queso"))[0].producto_id === "taco", detalle(cambioId));
  const edita = await api("PATCH", `producto_opciones?restaurante_id=eq.${A.id}&producto_id=eq.taco&id=eq.dueno-a-puso`, { token: T("dueno-a"), cuerpo: { precio: 250, nombre: "Editada", activa: false } });
  prueba("el dueno de A cambia precio, nombre y activa de las suyas", edita.status < 300 && filas(edita).length === 1 && filas(edita)[0].precio === 250 && filas(edita)[0].activa === false, detalle(edita));
  const borra = await api("DELETE", `producto_opciones?restaurante_id=eq.${A.id}&producto_id=eq.taco&id=eq.dueno-a-puso`, { token: T("dueno-a") });
  prueba("el dueno de A borra una opcion suya", borra.status < 300 && (await desdeBase(A, "&id=eq.dueno-a-puso")).length === 0, detalle(borra));
  const dB = await api("POST", "producto_opciones", { token: T("dueno-b"), cuerpo: nueva(B, "dueno-b-puso") });
  const dBA = await api("POST", "producto_opciones", { token: T("dueno-b"), cuerpo: nueva(A, "intruso-b") });
  prueba("el dueno de B escribe en B y NO en A", dB.status < 300 && dBA.status >= 400 && (await desdeBase(A, "&id=eq.intruso-b")).length === 0, detalle(dB) + " | " + detalle(dBA));
  for (const alias of ["cajero-a", "cocina-a", "nadie"]) {
    const ins = await api("POST", "producto_opciones", { token: T(alias), cuerpo: nueva(A, "x-" + alias) });
    const up = await api("PATCH", `producto_opciones?restaurante_id=eq.${A.id}`, { token: T(alias), cuerpo: { precio: 1 } });
    const del = await api("DELETE", `producto_opciones?restaurante_id=eq.${A.id}&id=eq.sin-cebolla`, { token: T(alias) });
    const intacto = await desdeBase(A, "&id=eq.sin-cebolla");
    prueba(`${alias}: no inserta, no cambia y no borra (nada cambio)`, ins.status >= 400 && sinEfecto(up) && sinEfecto(del) && intacto.length === 1 && (await desdeBase(A)).every((f) => f.precio !== 1), `${detalle(ins)} | ${detalle(up)} | ${detalle(del)}`);
  }
  const anonIns = await api("POST", "producto_opciones", { cuerpo: nueva(A, "anon-puso") });
  const anonUp = await api("PATCH", `producto_opciones?restaurante_id=eq.${A.id}`, { cuerpo: { precio: 1 } });
  const anonDel = await api("DELETE", `producto_opciones?restaurante_id=eq.${A.id}`, { cuerpo: undefined });
  prueba("ANON no inserta, no cambia y no borra (siguen las opciones de A)", anonIns.status >= 400 && sinEfecto(anonUp) && sinEfecto(anonDel) && (await desdeBase(A, "&id=eq.sin-cebolla")).length === 1, `${detalle(anonIns)} | ${detalle(anonUp)} | ${detalle(anonDel)}`);

  // ---- REGLAS (la base las exige tambien al dueno) ----
  grupo("reglas");
  const casos = [
    ["un quitar con precio", { id: "r1", tipo: "quitar", precio: 500 }], ["precio negativo", { id: "r2", precio: -1 }], ["precio sobre 50000", { id: "r3", precio: 50001 }],
    ["tipo desconocido", { id: "r4", tipo: "regalo" }], ["id con mayusculas", { id: "R5" }], ["id con espacio", { id: "r 6" }], ["id vacio", { id: "" }],
    ["nombre vacio", { id: "r7", nombre: "" }], ["nombre de 41 caracteres", { id: "r8", nombre: "x".repeat(41) }], ["nombre con salto de linea", { id: "r9", nombre: "a\nb" }],
    ["nombre con ancho cero", { id: "ra", nombre: "a" + String.fromCharCode(0x200b) + "b" }], ["nombre con bidi", { id: "rb", nombre: "a" + String.fromCharCode(0x202e) + "b" }],
    ["nombre con signos de HTML", { id: "rc", nombre: "<b>x</b>" }]
  ];
  let mal = "";
  for (const [n, extra] of casos) {
    const r = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: nueva(A, extra.id || "z", { precio: 100, ...extra }) });
    if (r.status < 400 || (codigo(r) && codigo(r) !== "23514")) mal += `[${n}: ${detalle(r)}]`;
  }
  prueba("13 reglas: la base las rechaza (23514) cuando escribe el dueno", mal === "", mal);
  const buenos = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: [nueva(A, "ok1", { nombre: "Queso extra", precio: 2000 }), nueva(A, "ok2", { tipo: "quitar", precio: 0, nombre: "Sin algo" }), nueva(A, "ok3", { nombre: "ñ".repeat(40), precio: 50000 })] });
  prueba("lo valido entra (nombre de 40 con enie, precio 0 y 50000)", buenos.status < 300 && filas(buenos).length === 3, detalle(buenos));
  await svc("DELETE", `producto_opciones?restaurante_id=eq.${A.id}&id=in.(ok1,ok2,ok3)`, undefined, "return=minimal");
  // tope de 12 por producto (cuentan las apagadas)
  const actuales = (await desdeBase(A, "&producto_id=eq.otro")).length;      // 1
  const faltan = 12 - actuales;
  const lleno = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: Array.from({ length: faltan }, (_, i) => ({ restaurante_id: A.id, producto_id: "otro", id: "t" + i, tipo: "extra", nombre: "T" + i, precio: 10, activa: i % 2 === 0 })) });
  const trece = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: { restaurante_id: A.id, producto_id: "otro", id: "t-trece", tipo: "extra", nombre: "Trece", precio: 10 } });
  prueba("maximo 12 por producto: las que faltan entran, la 13 no (23514)", lleno.status < 300 && trece.status >= 400 && (!codigo(trece) || codigo(trece) === "23514") && (await desdeBase(A, "&producto_id=eq.otro")).length === 12, `${detalle(lleno)} | ${detalle(trece)}`);
  await svc("DELETE", `producto_opciones?restaurante_id=eq.${A.id}&producto_id=eq.otro&id=like.t*`, undefined, "return=minimal");
  const sinRest = await api("POST", "producto_opciones", { token: T("dueno-a"), cuerpo: { producto_id: "taco", id: "sin-rest", tipo: "extra", nombre: "Sin restaurante", precio: 1 } });
  prueba("sin restaurante_id el insert falla (no hay valor por defecto que lo mande a otro restaurante)", sinRest.status >= 400, detalle(sinRest));

  // ---- CALCULO del servidor (funciones reales, base real; no crean pedidos) ----
  grupo("calculo");
  const itemA = (extra) => Object.assign({ id: "taco", cantidad: 1, precio: 10000 }, extra);
  const r0 = await validarItems(A.id, [itemA({ cantidad: 2 })]);
  prueba("sin opciones: igual que siempre (2 x 10000, item de 4 claves)", r0.ok && r0.subtotal === 20000 && Object.keys(r0.items[0]).sort().join() === "cantidad,id,nombre,precio", JSON.stringify(r0));
  const r1 = await validarItems(A.id, [itemA({ cantidad: 3, opciones: ["extra-tocineta", "sin-cebolla", "extra-queso"] })]);
  prueba("con opciones: 3 x (10000 + 2000 + 3000) = 45000; el quitar no suma; la copia trae precio_base y las opciones en orden",
    r1.ok && r1.subtotal === 45000 && r1.items[0].precio === 15000 && r1.items[0].precio_base === 10000 && r1.items[0].opciones.map((o) => o.id).join() === "sin-cebolla,extra-queso,extra-tocineta", JSON.stringify(r1));
  const rB = await validarItems(B.id, [{ id: "taco", cantidad: 1, precio: 20000, opciones: ["extra-queso"] }]);
  prueba("el mismo id de opcion en el otro restaurante cobra SU precio (B: 20000 + 9000)", rB.ok && rB.subtotal === 29000, JSON.stringify(rB));
  const malas = [["una opcion que no existe", ["no-existe"]], ["una apagada", ["extra-apagada"]], ["de otro producto", ["extra-solo"]], ["de otro restaurante", ["extra-solo-b"]], ["repetida", ["extra-queso", "extra-queso"]]];
  let malo = "";
  for (const [n, ops] of malas) {
    const r = await validarItems(A.id, [itemA({ opciones: ops })]);
    if (r.ok || r.codigo !== 400 || /extra-solo-b|no-existe|producto_opciones/.test(r.error)) malo += `[${n}: ${JSON.stringify(r)}]`;
  }
  prueba("rechaza (400 generico) una inexistente, una apagada, de otro producto, de otro restaurante y una repetida", malo === "", malo);
  const formas = [[["x", 5]], "extra-queso", [{ id: "extra-queso", precio: 0 }], Array.from({ length: 13 }, (_, i) => "o" + i), ["EXTRA"]];
  let maloF = "";
  for (const f of formas) { const r = await validarItems(A.id, [itemA({ opciones: f })]); if (r.ok || r.codigo !== 400) maloF += `[${JSON.stringify(f).slice(0, 40)}]`; }
  prueba("rechaza opciones mal formadas (numeros, texto, objetos con precio, mas de 12, mayusculas)", maloF === "", maloF);
  await svc("PATCH", `producto_opciones?restaurante_id=eq.${A.id}&producto_id=eq.taco&id=eq.extra-queso`, { precio: 2500 });
  const rSin = await validarItems(A.id, [itemA({ opciones: ["extra-queso"] })]);
  await svc("PATCH", `producto_opciones?restaurante_id=eq.${A.id}&producto_id=eq.taco&id=eq.extra-queso`, { precio: 2000 });
  prueba("sin cache: cambiar el precio de un extra rige en el siguiente calculo (10000 + 2500)", rSin.ok && rSin.subtotal === 12500, JSON.stringify(rSin));
  const producto = await validarItems(A.id, [{ id: "taco", cantidad: 1, precio: 10000, opciones: ["extra-queso"], precio_base: 1, nombre: "HACK", opcionesPrecios: [0] }]);
  prueba("precio y nombre puestos por el cliente se ignoran: manda la base", producto.ok && producto.items[0].nombre === "Taco a" && producto.items[0].precio === 12000 && producto.items[0].precio_base === 10000, JSON.stringify(producto));

  // ---- MENU publico ----
  grupo("menu");
  const menu = await leerMenu(A.id);
  const taco = menu.productos.find((p) => p.id === "taco");
  prueba("el menu trae solo las opciones ACTIVAS de cada producto, en orden y sin datos internos",
    taco && taco.opciones && taco.opciones.map((o) => o.id).join() === "sin-cebolla,extra-queso,extra-tocineta" && taco.opciones.every((o) => Object.keys(o).sort().join() === "id,nombre,orden,precio,tipo"), JSON.stringify(taco));
  prueba("un producto sin opciones activas queda sin la clave (aditivo)", !("opciones" in menu.productos.find((p) => p.id === "otro")) || menu.productos.find((p) => p.id === "otro").opciones.length > 0);
  const menuB = await leerOpcionesActivas(B.id);
  prueba("el menu de B no trae ninguna opcion de A", Array.from(menuB.values()).flat().every((o) => !["sin-cebolla", "extra-tocineta", "extra-solo"].includes(o.id)));

  // ---- el demo y los pedidos no se tocaron ----
  grupo("demo");
  const demoDespues = await huellaDemo();
  prueba("las opciones del restaurante demo no cambiaron (" + demoAntes.opciones + " filas, misma huella)", demoAntes.opciones === demoDespues.opciones && demoAntes.h === demoDespues.h);
  prueba("no se creo ningun pedido en el demo", demoAntes.ultimoPedido === demoDespues.ultimoPedido, `${demoAntes.ultimoPedido} -> ${demoDespues.ultimoPedido}`);
  const pedidosPrueba = await svc("GET", `pedidos?select=id&restaurante_id=in.(${A.id},${B.id})`);
  prueba("no se creo ningun pedido en los restaurantes de prueba", filas(pedidosPrueba).length === 0, detalle(pedidosPrueba));

  // ---- informe ----
  let g = "";
  for (const r of resultados) {
    if (r.grupo !== g) { g = r.grupo; console.log(`\n== ${g.toUpperCase()} ==`); }
    console.log(`  ${r.ok ? "PASA " : "FALLA"}  ${r.nombre}${r.ok ? "" : "\n          -> " + r.info}`);
  }
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  return fallas ? 1 : 0;
}

let salida = 1;
try { salida = await main(); }
catch (e) { console.error("ERROR:", e.message); salida = 1; }
await salirLimpio(salida);
