/* =============================================================
   COMPATIBILIDAD DEL SERVIDOR CON LA BASE MULTI-RESTAURANTE
   (SOLO LECTURA: no crea, no cambia y no borra nada)

   Ejecuta, SIN modificarlos, los mismos manejadores que corren en
   Vercel (api/menu.js, api/estado.js, api/disponibilidad.js,
   api/restaurante.js y la validacion de precios de crear-pedido) contra la
   base real, ya con el SQL 10 aplicado, SIMULANDO una visita al host de
   produccion de Taqueiros (taqueiros-2-0.vercel.app), y comprueba que
   respondan lo de siempre: Taqueiros debe verse exactamente igual.
   (Con el SQL 11 sin correr, ese host se resuelve a Taqueiros por el respaldo
   transitorio y el script lo avisa; con el SQL 11, por restaurante_dominios.)

   Los demas pedazos del codigo actual se prueban asi:
     * tests unitarios:   node --test pruebas/
     * panel (e2e):       node pruebas/impresion/e2e.js     (usa Supabase simulado)
   y el recorrido a mano en el panel real (lista en docs/multirestaurante.md).

   USO (PowerShell, desde la raiz del repo): ver docs/multirestaurante.md
     $env:SUPABASE_SERVICE_ROLE_KEY = ... (con Read-Host)
     node supabase/probar-compatibilidad.mjs
============================================================= */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const aqui = path.dirname(fileURLToPath(import.meta.url));
const publico = fs.readFileSync(path.join(aqui, "..", "supabase-publico.js"), "utf8");
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = (publico.match(/url:\s*"([^"]+)"/) || [])[1];

const { leerLlaveServicio, cabecerasSupabase } = require("../api/_llave.js");
let SRV;
try { SRV = leerLlaveServicio(); } catch (e) { console.error(e.message); process.exit(2); }
if (SRV.startsWith("sb_secret_") && SRV.split("sb_secret_").length !== 2) {
  console.error("La llave parece pegada DOS veces. Pegala una sola vez (clic derecho O Ctrl+V, no ambos).");
  process.exit(2);
}

const resultados = [];
const prueba = (nombre, ok, info = "") => resultados.push({ nombre, ok: !!ok, info: ok ? "" : String(info) });

// El host de produccion de Taqueiros: las rutas ya no sirven sin saber de que restaurante son
const HOST = "taqueiros-2-0.vercel.app";
const RID = "00000000-0000-4000-8000-000000000001";

function llamar(handler, ruta) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(o) { resolve({ status: this.code, cuerpo: o, cabeceras: this.headers }); }
    };
    Promise.resolve(handler({ method: "GET", headers: { host: HOST }, query: {}, url: ruta || "/" }, res)).catch((e) => resolve({ status: 500, cuerpo: { error: String(e) } }));
  });
}

const menuHandler = require("../api/menu.js");
const estadoHandler = require("../api/estado.js");
const dispHandler = require("../api/disponibilidad.js");
const { validarItems } = require("../api/_precios.js");

// Silenciar los console.error del codigo actual si algo falla (se reportan abajo)
const errores = [];
const origError = console.error;
console.error = (...a) => errores.push(a.map(String).join(" "));

/* ---- /api/menu ---- */
const menu = await llamar(menuHandler);
const productos = (menu.cuerpo && menu.cuerpo.productos) || [];
const categorias = (menu.cuerpo && menu.cuerpo.categorias) || [];
prueba("/api/menu responde 200 con ok:true", menu.status === 200 && menu.cuerpo && menu.cuerpo.ok === true && !menu.cuerpo.deRespaldo, JSON.stringify(menu.cuerpo).slice(0, 150));
prueba("/api/menu trae categorias y productos", categorias.length > 0 && productos.length > 0, `${categorias.length} categorias, ${productos.length} productos`);
prueba("/api/menu: cada producto tiene su categoria", productos.every((p) => categorias.some((c) => c.id === p.categoria)), "hay productos con categoria que no esta en la lista");
prueba("/api/menu no mezcla restaurantes: ningun id de producto repetido", new Set(productos.map((p) => p.id)).size === productos.length, "ids repetidos (otro restaurante tiene productos?)");
prueba("/api/menu no expone restaurante_id (mismas columnas de siempre)", productos.every((p) => !("restaurante_id" in p)), "");

/* ---- /api/estado ---- */
const estado = await llamar(estadoHandler);
const horarios = (estado.cuerpo && estado.cuerpo.horarios) || [];
prueba("/api/estado responde 200", estado.status === 200, JSON.stringify(estado.cuerpo).slice(0, 150));
prueba("/api/estado lee los 7 dias de la configuracion (no cayo al respaldo 'abierto')", horarios.length === 7, `${horarios.length} dias; errores del handler: ${errores.slice(-2).join(" | ")}`);
prueba("/api/estado devuelve abierto (booleano) y horarioHoy", typeof (estado.cuerpo && estado.cuerpo.abierto) === "boolean" && "horarioHoy" in (estado.cuerpo || {}), JSON.stringify(estado.cuerpo).slice(0, 150));
prueba("/api/estado conserva sus campos de siempre y agrega 'servicio' sin romper nada", ["abierto", "mensaje", "horarioHoy", "horarios"].every((k) => k in (estado.cuerpo || {})) && estado.cuerpo.servicio && estado.cuerpo.servicio.sirve === true, JSON.stringify(estado.cuerpo).slice(0, 150));

/* ---- /api/restaurante (nuevo): solo datos publicos ---- */
const restHandler = require("../api/restaurante.js");
const rr = await llamar(restHandler, "/api/restaurante");
prueba("/api/restaurante resuelve el host de Taqueiros y responde 'servicio.sirve'", rr.status === 200 && rr.cuerpo && rr.cuerpo.slug === "taqueiros" && rr.cuerpo.id === RID && rr.cuerpo.servicio && rr.cuerpo.servicio.sirve === true, JSON.stringify(rr.cuerpo).slice(0, 150));
prueba("/api/restaurante no expone plan, vigencia, secretos ni la config interna", !/plan|vigente|dias_gracia|modalidad|wompi|callmebot|secret/i.test(JSON.stringify(rr.cuerpo)), JSON.stringify(rr.cuerpo).slice(0, 150));
const desconocido = await new Promise((resolve) => {
  const res = { status(c) { this.c = c; return this; }, setHeader() {}, json(o) { resolve({ status: this.c, cuerpo: o }); } };
  Promise.resolve(menuHandler({ method: "GET", headers: { host: "desconocido.ejemplo.test" }, query: {}, url: "/api/menu" }, res)).catch((e) => resolve({ status: 500, cuerpo: String(e) }));
});
prueba("un host desconocido recibe 404 (no el menu de Taqueiros)", desconocido.status === 404, JSON.stringify(desconocido));

/* ---- /api/disponibilidad ---- */
const disp = await llamar(dispHandler);
prueba("/api/disponibilidad responde ok:true con las dos listas", disp.status === 200 && disp.cuerpo && disp.cuerpo.ok === true && Array.isArray(disp.cuerpo.agotados) && Array.isArray(disp.cuerpo.categoriasInactivas), JSON.stringify(disp.cuerpo).slice(0, 150));

/* ---- validacion de precios de crear-pedido (lee productos y categorias) ---- */
const disponible = productos.find((p) => p.disponible !== false && !(disp.cuerpo.categoriasInactivas || []).includes(p.categoria));
if (disponible) {
  const v = await validarItems(RID, [{ id: disponible.id, cantidad: 1, precio: disponible.precio }]);
  prueba(`validarItems acepta "${disponible.id}" al precio de la base`, v.ok === true && v.subtotal === Number(disponible.precio), JSON.stringify(v).slice(0, 150));
  const mal = await validarItems(RID, [{ id: disponible.id, cantidad: 1, precio: Number(disponible.precio) + 1 }]);
  prueba("validarItems detecta un precio distinto al de la base", mal.ok === false && (mal.preciosCambiados || []).length === 1, JSON.stringify(mal).slice(0, 150));
} else {
  prueba("hay al menos un producto disponible para probar validarItems", false, "no hay productos disponibles");
}

/* ---- lecturas exactas que hace el servidor (PostgREST con la llave secreta) ---- */
const URL = process.env.SUPABASE_URL.replace(/\/$/, "");
const H = cabecerasSupabase(SRV);
const get = async (ruta) => { const r = await fetch(`${URL}/rest/v1/${ruta}`, { headers: H }); let b; try { b = await r.json(); } catch { b = null; } return { status: r.status, cuerpo: b }; };
const cfg = await get("configuracion?id=eq.1&select=*");
prueba("configuracion?id=eq.1 devuelve exactamente UNA fila", cfg.status === 200 && Array.isArray(cfg.cuerpo) && cfg.cuerpo.length === 1, JSON.stringify(cfg.cuerpo).slice(0, 120));
const sal = await get("salud_notificaciones?id=eq.1&select=fallos_seguidos");
prueba("salud_notificaciones?id=eq.1 devuelve exactamente UNA fila", sal.status === 200 && Array.isArray(sal.cuerpo) && sal.cuerpo.length === 1, JSON.stringify(sal.cuerpo).slice(0, 120));
const alertas = await get(`pedidos?estado=eq.nuevo&alerta_enviada=is.false&select=*&order=pagado_en.asc&limit=10&restaurante_id=eq.${RID}`);
prueba("la consulta del cron de alertas (ahora por restaurante) funciona", alertas.status === 200 && Array.isArray(alertas.cuerpo) && alertas.cuerpo.every((p) => p.restaurante_id === RID), JSON.stringify(alertas.cuerpo).slice(0, 120));
const ping = await get("restaurantes?select=id&limit=1");
prueba("la consulta del keep-alive (ahora a restaurantes) funciona", ping.status === 200 && Array.isArray(ping.cuerpo) && ping.cuerpo.length === 1, JSON.stringify(ping.cuerpo).slice(0, 120));

/* ---- multi-restaurante: lo que el servidor nuevo necesita de la base ---- */
const dom = await get(`restaurante_dominios?host=eq.${HOST}&select=restaurante_id`);
if (dom.status === 200) {
  prueba("restaurante_dominios (SQL 11): el host de produccion apunta a Taqueiros", dom.cuerpo.length === 1 && dom.cuerpo[0].restaurante_id === RID, JSON.stringify(dom.cuerpo));
} else {
  console.log("  AVISO: restaurante_dominios no existe todavia (SQL 11 sin correr): el servidor usa el respaldo transitorio para este host.");
}
const taq = await get(`restaurantes?id=eq.${RID}&select=id,slug,estado,vigente_hasta,dias_gracia,zona_horaria,config`);
prueba("Taqueiros esta 'activo' y sin vencimiento (el servicio nunca le bloquea los pedidos)", taq.status === 200 && taq.cuerpo.length === 1 && taq.cuerpo[0].slug === "taqueiros" && taq.cuerpo[0].estado === "activo" && taq.cuerpo[0].vigente_hasta === null, JSON.stringify(taq.cuerpo).slice(0, 150));
const tar = await get(`tarifas_domicilio?restaurante_id=eq.${RID}&select=hasta,precio&order=hasta.asc`);
prueba("las 5 tarifas de domicilio de Taqueiros estan en la tabla (2/4/6/8 km y fuera de cobertura)",
  tar.status === 200 && JSON.stringify(tar.cuerpo.map((t) => [Number(t.hasta), t.precio])) === JSON.stringify([[2, 5000], [4, 7000], [6, 9000], [8, 12000], [999, null]]), JSON.stringify(tar.cuerpo));
const sec = await get(`restaurante_secretos?restaurante_id=eq.${RID}&select=restaurante_id`);
prueba("el servidor (llave secreta) puede leer restaurante_secretos de Taqueiros", sec.status === 200 && sec.cuerpo.length === 1, JSON.stringify(sec.cuerpo).slice(0, 100));
const limp = await fetch(`${URL}/rest/v1/rpc/limpiar_pedidos_huerfanos`, { method: "POST", headers: H, body: JSON.stringify({ horas: 876000 }) });
const limpCuerpo = await limp.json().catch(() => null);
prueba("limpiar_pedidos_huerfanos sigue disponible para el servidor (con 100 anos de margen: no borra nada)", limp.status === 200 && limpCuerpo === 0, `HTTP ${limp.status} ${JSON.stringify(limpCuerpo)}`);
const pedAjenos = await get("pedidos?select=id,restaurante_id,numero&order=id.desc&limit=3");
prueba("los pedidos traen restaurante_id y numero (el codigo actual ignora las columnas extra)", pedAjenos.status === 200 && pedAjenos.cuerpo.every((p) => p.restaurante_id && p.numero != null), JSON.stringify(pedAjenos.cuerpo).slice(0, 150));

console.error = origError;

/* ---- Informe ---- */
console.log("COMPATIBILIDAD DEL CODIGO ACTUAL (solo lectura)\n");
for (const r of resultados) console.log(`  ${r.ok ? "PASA " : "FALLA"}  ${r.nombre}${r.ok ? "" : "\n          -> " + r.info}`);
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
// Sin process.exit(): en Windows, salir de golpe con conexiones de fetch cerrandose imprime una
// "Assertion failed ... async.c". Se deja drenar y, si algo la retiene, se fuerza a los 4 s.
setTimeout(() => process.exit(), 4000).unref();
