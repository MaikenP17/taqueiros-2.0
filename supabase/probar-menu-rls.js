/* Prueba de intrusion contra las tablas del menu.

   Debe demostrar: un anonimo NO puede leer el menu directo (desde el SQL 10 el menu sale de /api/menu, que usa
   la llave secreta del servidor) y TAMPOCO puede modificarlo.

   Cada intento de escritura manda restaurante_id EXPLICITO (el de Taqueiros): desde el SQL 13 la columna ya no tiene
   valor por defecto, y un intento sin restaurante_id fallaria por NOT NULL aunque los permisos estuvieran rotos.
   Con el restaurante puesto, lo unico que lo frena son los permisos: asi la prueba mide lo que tiene que medir.

   USO (PowerShell; la llave de servicio NUNCA va escrita en este repositorio publico):
     $env:SUPABASE_SERVICE_ROLE_KEY = "..." ; node supabase/probar-menu-rls.js
   Opcional: SUPABASE_PUBLISHABLE_KEY (otra llave publica) y SUPABASE_URL (otro proyecto). */
const fs = require("fs");
const path = require("path");
const { cabecerasSupabase, leerLlaveServicio } = require("../api/_llave.js");

// URL y llave publishable: la misma copia que usan las paginas (supabase-publico.js)
const publico = fs.readFileSync(path.join(__dirname, "..", "supabase-publico.js"), "utf8");
const BASE = (process.env.SUPABASE_URL || (publico.match(/url:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");
const ANON = process.env.SUPABASE_PUBLISHABLE_KEY || (publico.match(/publishableKey:\s*"([^"]+)"/) || [])[1];
if (!BASE || !ANON) {
  console.error("No pude leer la URL y la llave publishable de supabase-publico.js");
  process.exit(1);
}
let SR;
try {
  SR = leerLlaveServicio();
} catch (e) {
  console.error(e.message + ". Ver el comentario de arriba.");
  process.exit(1);
}

const Ha = cabecerasSupabase(ANON);
const Hs = cabecerasSupabase(SR);

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

  // El restaurante de las pruebas: Taqueiros (se lee con la llave de servicio)
  const rest = await j(await fetch(BASE + "/rest/v1/restaurantes?slug=eq.taqueiros&select=id", { headers: Hs }));
  if (!Array.isArray(rest) || rest.length !== 1) {
    console.error("No encontre el restaurante 'taqueiros'. Corre antes supabase/10-multirestaurante.sql.");
    process.exit(1);
  }
  const RID = rest[0].id;
  const delRestaurante = "restaurante_id=eq." + RID;

  let fallos = 0;
  const resultado = (bien, texto) => { if (!bien) fallos++; console.log((bien ? "✅ " : "❌ ") + texto); };

  console.log("========== EL MENU YA NO SE LEE DIRECTO (lo sirve /api/menu) ==========");
  let r = await fetch(BASE + "/rest/v1/productos?select=id,nombre,precio,disponible&order=nombre", { headers: Ha });
  const leidos = await j(r);
  resultado(r.status >= 400 || (Array.isArray(leidos) && leidos.length === 0),
    "Anónimo NO lee productos -> HTTP " + r.status + ", filas: " + (Array.isArray(leidos) ? leidos.length : (leidos && leidos.code)));

  r = await fetch(BASE + "/rest/v1/categorias?select=*", { headers: Ha });
  const cats = await j(r);
  resultado(r.status >= 400 || (Array.isArray(cats) && cats.length === 0),
    "Anónimo NO lee categorías -> HTTP " + r.status + ", filas: " + (Array.isArray(cats) ? cats.length : (cats && cats.code)));

  console.log("\n========== Y NO DEBE PODER TOCARLO (con restaurante_id explicito) ==========");

  const antes = (await j(await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta&select=precio,nombre,disponible", { headers: Hs })))[0];
  if (!antes) { console.error("No encuentro 'bandeja-mixta' en Taqueiros: esta prueba usa ese producto."); process.exit(1); }
  console.log("Precio real de 'bandeja-mixta':", antes.precio);

  // A) Bajar el precio
  r = await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta", {
    method: "PATCH", headers: Ha, body: JSON.stringify({ precio: 100 })
  });
  let ahora = (await j(await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta&select=precio", { headers: Hs })))[0];
  resultado(Number(ahora.precio) === Number(antes.precio), "A) Anónimo intenta bajar el precio a $100 -> quedó en: " + ahora.precio);

  // B) Agotar un producto
  r = await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta", {
    method: "PATCH", headers: Ha, body: JSON.stringify({ disponible: false })
  });
  ahora = (await j(await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta&select=disponible", { headers: Hs })))[0];
  resultado(ahora.disponible === antes.disponible, "B) Anónimo intenta agotarlo -> disponible: " + ahora.disponible);

  // C) Insertar un producto falso (con su restaurante_id: lo unico que lo frena son los permisos)
  r = await fetch(BASE + "/rest/v1/productos", {
    method: "POST", headers: Ha,
    body: JSON.stringify({ restaurante_id: RID, id: "producto-pirata", nombre: "Pirata", precio: 1, categoria: "bebidas" })
  });
  const existe = (await j(await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.producto-pirata&select=id", { headers: Hs })));
  resultado(existe.length === 0 && r.status >= 400, "C) Anónimo intenta INSERTAR un producto -> HTTP " + r.status);
  if (existe.length) await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.producto-pirata", { method: "DELETE", headers: Hs });

  // D) Borrar un producto
  r = await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta", { method: "DELETE", headers: Ha });
  const sigue = (await j(await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&id=eq.bandeja-mixta&select=id", { headers: Hs })));
  resultado(sigue.length === 1, "D) Anónimo intenta BORRARLO -> HTTP " + r.status);

  // E) Lo mismo con una categoria
  r = await fetch(BASE + "/rest/v1/categorias", {
    method: "POST", headers: Ha, body: JSON.stringify({ restaurante_id: RID, id: "categoria-pirata", nombre: "Pirata" })
  });
  const existeCat = (await j(await fetch(BASE + "/rest/v1/categorias?" + delRestaurante + "&id=eq.categoria-pirata&select=id", { headers: Hs })));
  resultado(existeCat.length === 0 && r.status >= 400, "E) Anónimo intenta INSERTAR una categoría -> HTTP " + r.status);
  if (existeCat.length) await fetch(BASE + "/rest/v1/categorias?" + delRestaurante + "&id=eq.categoria-pirata", { method: "DELETE", headers: Hs });

  console.log("\n========== SUMA DE CONTROL ==========");
  /* Ya no se compara contra api/_precios.js: ese archivo dejó de
     tener precios escritos a mano y ahora los lee de esta misma
     tabla. Comparar la tabla consigo misma no probaría nada.
     Se usa la suma verificada durante la migración (solo Taqueiros). */
  const enTabla = await j(await fetch(BASE + "/rest/v1/productos?" + delRestaurante + "&select=id,precio", { headers: Hs }));
  const suma = enTabla.reduce((a, p) => a + Number(p.precio), 0);

  console.log("  productos:", enTabla.length, "| suma de precios:", suma);
  console.log("  ->", enTabla.length === 38 && suma === 586000
    ? "✅ coincide con la suma verificada en la migración"
    : "ℹ️  no coincide con la suma de la migración (38 productos, $586.000): revisa si se cambió algún precio a propósito");

  console.log(fallos ? "\n❌ " + fallos + " intento(s) se colaron. REVISA las políticas." : "\n✅ TODO BLOQUEADO: el público no lee ni toca el menú directo.");
  process.exitCode = fallos ? 1 : 0;
})();
