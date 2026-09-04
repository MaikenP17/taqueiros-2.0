/* Prueba de intrusion contra las tablas del menu.
   Debe demostrar: un anonimo LEE el menu pero NO puede modificarlo. */
const BASE = "https://pzryobpriyewlxltditw.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6cnlvYnByaXlld2x4bHRkaXR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNzI0NzEsImV4cCI6MjEwMzk0ODQ3MX0.1mR9Y7--zobo28e9gPlS3hk7IVrZ04ae572wp0or5G4";
const SR = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6cnlvYnByaXlld2x4bHRkaXR3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODM3MjQ3MSwiZXhwIjoyMTAzOTQ4NDcxfQ.Iwrf267xV8PWc-jNJU99E0fxE0GqSGQ1tUjpmBIKrlE";

const Ha = { apikey: ANON, Authorization: "Bearer " + ANON, "Content-Type": "application/json" };
const Hs = { apikey: SR, Authorization: "Bearer " + SR, "Content-Type": "application/json" };

async function j(r) { const t = await r.text(); try { return JSON.parse(t); } catch (e) { return t; } }

(async () => {
  // ¿Existe ya la tabla?
  const sonda = await fetch(BASE + "/rest/v1/productos?select=id&limit=1", { headers: Hs });
  if (sonda.status === 404) {
    console.log("La tabla 'productos' todavía no existe.");
    console.log("Ejecuta supabase/menu.sql y vuelve a correr esta prueba.\n");
    console.log("Estado previo verificado: no hay nada que se pueda filtrar todavía.");
    return;
  }

  console.log("========== EL MENU DEBE SER PUBLICO ==========");
  let r = await fetch(BASE + "/rest/v1/productos?select=id,nombre,precio,disponible&order=nombre", { headers: Ha });
  const leidos = await j(r);
  const leyo = Array.isArray(leidos) && leidos.length > 0;
  console.log("Anónimo LEE productos -> filas:", Array.isArray(leidos) ? leidos.length : leidos.code,
    " ", leyo ? "✅ CORRECTO (el cliente puede ver el menú sin sesión)" : "❌ FALLO");

  r = await fetch(BASE + "/rest/v1/categorias?select=*", { headers: Ha });
  const cats = await j(r);
  console.log("Anónimo LEE categorías -> filas:", Array.isArray(cats) ? cats.length : cats.code,
    " ", Array.isArray(cats) && cats.length ? "✅ CORRECTO" : "❌ FALLO");

  console.log("\n========== PERO NO DEBE PODER TOCARLO ==========");

  const antes = (await j(await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta&select=precio,nombre,disponible", { headers: Hs })))[0];
  console.log("Precio real de 'bandeja-mixta':", antes.precio);

  // A) Bajar el precio
  r = await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta", {
    method: "PATCH", headers: Ha, body: JSON.stringify({ precio: 100 })
  });
  let ahora = (await j(await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta&select=precio", { headers: Hs })))[0];
  console.log("A) Anónimo intenta bajar el precio a $100 -> quedó en:", ahora.precio,
    " ", Number(ahora.precio) === Number(antes.precio) ? "✅ BLOQUEADO" : "❌ LO CAMBIÓ");

  // B) Agotar un producto
  r = await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta", {
    method: "PATCH", headers: Ha, body: JSON.stringify({ disponible: false })
  });
  ahora = (await j(await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta&select=disponible", { headers: Hs })))[0];
  console.log("B) Anónimo intenta agotarlo -> disponible:", ahora.disponible,
    " ", ahora.disponible === antes.disponible ? "✅ BLOQUEADO" : "❌ LO CAMBIÓ");

  // C) Insertar un producto falso
  r = await fetch(BASE + "/rest/v1/productos", {
    method: "POST", headers: Ha,
    body: JSON.stringify({ id: "producto-pirata", nombre: "Pirata", precio: 1, categoria: "bebidas" })
  });
  const existe = (await j(await fetch(BASE + "/rest/v1/productos?id=eq.producto-pirata&select=id", { headers: Hs })));
  console.log("C) Anónimo intenta INSERTAR un producto -> HTTP", r.status,
    " ", existe.length === 0 ? "✅ BLOQUEADO" : "❌ LO CREÓ");

  // D) Borrar un producto
  r = await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta", { method: "DELETE", headers: Ha });
  const sigue = (await j(await fetch(BASE + "/rest/v1/productos?id=eq.bandeja-mixta&select=id", { headers: Hs })));
  console.log("D) Anónimo intenta BORRARLO -> HTTP", r.status,
    " ", sigue.length === 1 ? "✅ BLOQUEADO" : "❌ LO BORRÓ");

  console.log("\n========== COTEJO CONTRA api/_precios.js ==========");
  const { PRECIOS } = require("d:/PAGINAS WEB!!!!!!/TAQUEIROS 2.0/api/_precios.js");
  const enTabla = await j(await fetch(BASE + "/rest/v1/productos?select=id,nombre,precio", { headers: Hs }));
  const mapa = new Map(enTabla.map(p => [p.id, p]));

  let fallos = 0;
  for (const [id, esperado] of Object.entries(PRECIOS)) {
    const real = mapa.get(id);
    if (!real) { console.log("  ❌ FALTA en la tabla:", id); fallos++; continue; }
    if (Number(real.precio) !== esperado.precio) {
      console.log("  ❌ PRECIO DISTINTO:", id, "| _precios.js:", esperado.precio, "| tabla:", real.precio);
      fallos++;
    }
  }
  for (const p of enTabla) if (!PRECIOS[p.id]) { console.log("  ❌ SOBRA en la tabla:", p.id); fallos++; }

  console.log(fallos === 0
    ? "  ✅ Los " + Object.keys(PRECIOS).length + " productos coinciden uno a uno con api/_precios.js"
    : "  ❌ " + fallos + " discrepancias");
})();
