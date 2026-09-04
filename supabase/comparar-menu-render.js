/* =============================================================
   COMPARACION OBJETIVA: el menú ANTES vs DESPUÉS de la migración

   Responde sin "míralo tú": ¿lo que ahora sirve /api/menu es
   exactamente lo mismo que estaba escrito a mano en index.html?

   Compara, producto por producto y en el mismo orden:
     id, nombre, descripción, precio, categoría e imagen.

   USO:
     node supabase/comparar-menu-render.js <ruta-al-index.html-viejo>

   Si no se pasa ruta, usa el index.html del commit anterior:
     git show HEAD~1:index.html > /tmp/index.viejo.html
============================================================= */
const fs = require("fs");
const path = require("path");

const RUTA_VIEJA = process.argv[2];
if (!RUTA_VIEJA || !fs.existsSync(RUTA_VIEJA)) {
  console.error("Falta el index.html anterior a la migración.\n");
  console.error("Consíguelo así, desde la carpeta del proyecto:");
  console.error("  git show <commit-anterior>:index.html > index.viejo.html");
  console.error("  node supabase/comparar-menu-render.js index.viejo.html");
  process.exit(1);
}

// ---- Fuente A: el menú escrito a mano en el HTML viejo ----
const html = fs.readFileSync(RUTA_VIEJA, "utf8");
const m = html.match(/const CATEGORIES = (\[[\s\S]*?\n\];)/);
if (!m) {
  console.error("Ese archivo no contiene el arreglo CATEGORIES.");
  process.exit(1);
}
const CATEGORIES = eval(m[1].replace(/;$/, ""));

const antes = [];
CATEGORIES.forEach((cat) => {
  cat.products.forEach((p, i) => {
    antes.push({
      id: p.id, nombre: p.name, desc: p.desc || "", precio: p.price,
      categoria: cat.id, categoriaNombre: cat.name, emoji: cat.emoji,
      img: p.img || null, orden: i
    });
  });
});

// ---- Fuente B: lo que devuelve la base hoy ----
const BASE = process.env.SUPABASE_URL;
const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !SR) {
  console.error("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno.");
  process.exit(1);
}

(async () => {
  const H = { apikey: SR, Authorization: "Bearer " + SR };
  const cats = await (await fetch(BASE + "/rest/v1/categorias?select=*&order=orden.asc", { headers: H })).json();
  const prods = await (await fetch(BASE + "/rest/v1/productos?select=*&order=orden.asc", { headers: H })).json();

  const nombreCat = new Map(cats.map((c) => [c.id, c]));
  const ahora = [];
  cats.forEach((c) => {
    prods.filter((p) => p.categoria === c.id)
      .sort((a, b) => a.orden - b.orden)
      .forEach((p) => {
        ahora.push({
          id: p.id, nombre: p.nombre, desc: p.descripcion || "", precio: Number(p.precio),
          categoria: p.categoria, categoriaNombre: c.nombre, emoji: c.emoji,
          img: p.imagen || null, orden: p.orden
        });
      });
  });

  console.log("Productos antes :", antes.length);
  console.log("Productos ahora :", ahora.length);
  console.log("");

  const diffs = [];
  const porId = new Map(ahora.map((p) => [p.id, p]));

  antes.forEach((a, i) => {
    const b = porId.get(a.id);
    if (!b) { diffs.push(`FALTA: "${a.nombre}" (${a.id})`); return; }

    ["nombre", "desc", "precio", "categoria", "img"].forEach((campo) => {
      if (String(a[campo]) !== String(b[campo])) {
        diffs.push(`${a.id} · ${campo}:\n      antes: ${JSON.stringify(a[campo])}\n      ahora: ${JSON.stringify(b[campo])}`);
      }
    });

    // El orden absoluto dentro del menú completo debe coincidir
    if (ahora[i] && ahora[i].id !== a.id) {
      diffs.push(`ORDEN distinto en la posición ${i}: antes "${a.id}", ahora "${ahora[i].id}"`);
    }
  });

  ahora.forEach((b) => {
    if (!antes.find((a) => a.id === b.id)) diffs.push(`SOBRA: "${b.nombre}" (${b.id})`);
  });

  // Las categorías: nombre, emoji y orden
  CATEGORIES.forEach((c, i) => {
    const b = nombreCat.get(c.id);
    if (!b) { diffs.push(`FALTA la categoría "${c.name}" (${c.id})`); return; }
    if (b.nombre !== c.name) diffs.push(`Categoría ${c.id} · nombre: antes "${c.name}", ahora "${b.nombre}"`);
    if (b.emoji !== c.emoji) diffs.push(`Categoría ${c.id} · emoji: antes "${c.emoji}", ahora "${b.emoji}"`);
    if (b.orden !== i) diffs.push(`Categoría ${c.id} · orden: antes ${i}, ahora ${b.orden}`);
  });

  if (diffs.length === 0) {
    console.log("✅ IDÉNTICO");
    console.log("   Los " + antes.length + " productos coinciden en id, nombre, descripción,");
    console.log("   precio, categoría, imagen y orden. Las " + CATEGORIES.length + " categorías");
    console.log("   coinciden en nombre, emoji y orden.");
    console.log("   El menú se ve exactamente igual que antes de la migración.");
  } else {
    console.log("⚠️  " + diffs.length + " DIFERENCIAS:\n");
    diffs.forEach((d, i) => console.log("  " + (i + 1) + ". " + d));
  }
})();
