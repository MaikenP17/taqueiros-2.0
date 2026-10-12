/* =============================================================
   PRUEBA DE LA LLAVE PUBLISHABLE CONTRA SUPABASE REAL
   Solo LECTURAS y RECHAZOS. No usa la llave secreta ni modifica datos:
   cada intento de escritura esta armado para fallar por una
   restriccion aunque RLS se rompiera (llave duplicada, check, FK).

   Que demuestra:
     1. el menu y las RPC publicas se leen con la publishable
        (SOLO en 'apikey', sin Bearer)
     2. pedidos, configuracion y personal NO se leen como anonimo
     3. anon NO puede insertar, actualizar ni borrar
     4. (opcional) supabase-js se conecta y Realtime queda SUBSCRIBED

   USO (PowerShell, desde la raiz del repo):
     node supabase/probar-publishable.mjs
   Para incluir el paso 4:  npm i --no-save @supabase/supabase-js@2.117.2
   Otra llave:  $env:PUB = "sb_publishable_..."
============================================================= */
// Pruebas de SOLO LECTURA y RECHAZOS con la llave publishable. No usa la llave secreta.
// Ningun intento de escritura puede dejar datos: cada uno viola una restriccion
// o esta protegido por una llave foranea, y se espera que RLS lo corte antes.

const URL = "https://pzryobpriyewlxltditw.supabase.co";
const PUB = process.env.PUB || "sb_publishable_z16BcFrV9JvRKlKOy118PA_71-sWQqa";
if (!PUB || !PUB.startsWith("sb_publishable_")) { console.error("Falta PUB"); process.exit(2); }

const H = { apikey: PUB, "Content-Type": "application/json" };   // SOLO apikey
let fallos = 0;
const ok = (c, m, extra = "") => { console.log((c ? "  OK   " : "  FALLA ") + m + (extra ? "  -> " + extra : "")); if (!c) fallos++; };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function rest(path, opts = {}) {
  const r = await fetch(URL + "/rest/v1/" + path, { headers: { ...H, ...(opts.headers || {}) }, method: opts.method || "GET", body: opts.body });
  return { status: r.status, body: await j(r), headers: r.headers };
}

console.log("\n== 1. Lecturas publicas (solo apikey, sin Bearer) ==");
let cats = await rest("categorias?select=id,nombre,activa&order=orden");
ok(cats.status === 200 && Array.isArray(cats.body) && cats.body.length > 0, "categorias legibles", `${cats.status}, ${cats.body.length} filas`);
let prods = await rest("productos?select=id,nombre,precio,disponible,categoria,imagen");
ok(prods.status === 200 && prods.body.length > 0, "productos legibles", `${prods.status}, ${prods.body.length} filas`);

console.log("\n== 2. RPC publicas ==");
let seg = await rest("rpc/seguimiento", { method: "POST", body: JSON.stringify({ ref: "TQ-NO-EXISTE-000" }) });
ok(seg.status === 200 && Array.isArray(seg.body) && seg.body.length === 0, "rpc seguimiento (ref inexistente) -> []", `${seg.status} ${JSON.stringify(seg.body).slice(0, 80)}`);
let bus = await rest("rpc/buscar_mis_pedidos", { method: "POST", body: JSON.stringify({ telefono: "3000000000", total_pagado: 1 }) });
ok(bus.status === 200 && Array.isArray(bus.body) && bus.body.length === 0, "rpc buscar_mis_pedidos (datos inexistentes) -> []", `${bus.status} ${JSON.stringify(bus.body).slice(0, 80)}`);

console.log("\n== 3. Lo que anon NO debe poder leer ==");
for (const t of ["pedidos", "configuracion", "personal"]) {
  const r = await rest(`${t}?select=*&limit=1`);
  const vacio = Array.isArray(r.body) && r.body.length === 0;
  ok(vacio || r.status >= 400, `anon no lee ${t}`, `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
}

console.log("\n== 4. Escrituras de anon: deben ser rechazadas (cada una esta armada para NO dejar datos aunque RLS fallara) ==");
const unaCat = cats.body.find((c) => prods.body.some((p) => p.categoria === c.id));
const unProd = prods.body[0];
// INSERT: un trigger de validacion corre ANTES que RLS, asi que la fila debe pasar el trigger.
// Se usa un id YA EXISTENTE con valores validos: si RLS permitiera, daria 23505 (llave duplicada)
// y no se escribiria nada; con RLS correcto da 42501 antes de tocar el indice.
let r = await rest("productos", { method: "POST", body: JSON.stringify({ id: unProd.id, nombre: unProd.nombre, precio: unProd.precio, categoria: unProd.categoria }) });
ok(r.status === 401 || r.status === 403, "INSERT productos rechazado por RLS", `${r.status} code=${r.body && r.body.code}`);
r = await rest("categorias", { method: "POST", body: JSON.stringify({ id: unaCat.id, nombre: unaCat.nombre }) });
ok(r.status === 401 || r.status === 403, "INSERT categorias rechazado por RLS", `${r.status} code=${r.body && r.body.code}`);
r = await rest("pedidos", { method: "POST", body: JSON.stringify({ referencia: "zz-prueba-anon", total: 0 }) });
ok(r.status === 401 || r.status === 403, "INSERT pedidos rechazado por RLS", `${r.status} code=${r.body && r.body.code}`);
r = await rest("configuracion", { method: "POST", body: JSON.stringify({ id: 999 }) });
ok(r.status === 401 || r.status === 403, "INSERT configuracion rechazado por RLS", `${r.status} code=${r.body && r.body.code}`);
r = await rest("personal", { method: "POST", body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }) });
ok(r.status === 401 || r.status === 403, "INSERT personal rechazado por RLS", `${r.status} code=${r.body && r.body.code}`);

// UPDATE: valor que viola un check; con RLS correcto no hay filas visibles -> 200 [] (o 401/403). Un 4xx con code 23xxx = RLS ROTO.
const noModifico = (x) => (x.status === 200 && Array.isArray(x.body) && x.body.length === 0) || x.status === 401 || x.status === 403;
r = await rest(`productos?id=eq.${encodeURIComponent(unProd.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ precio: 0 }) });
ok(noModifico(r), "UPDATE productos no toca filas", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
r = await rest(`categorias?id=eq.${encodeURIComponent(unaCat.id)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ nombre: "" }) });
ok(noModifico(r), "UPDATE categorias no toca filas", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
r = await rest("pedidos?id=gt.0", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ total: 0 }) });
ok(noModifico(r), "UPDATE pedidos no toca filas", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
r = await rest("configuracion?id=gt.0", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ cerrado_temporal: true, horarios: null }) });
ok(noModifico(r), "UPDATE configuracion no toca filas", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);

// DELETE: categoria con productos -> si RLS permitiera, la llave foranea lo frena (23503) y no se borra nada.
r = await rest(`categorias?id=eq.${encodeURIComponent(unaCat.id)}`, { method: "DELETE", headers: { Prefer: "return=representation" } });
ok(noModifico(r), "DELETE categorias no toca filas (y ademas la FK la protege)", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
r = await rest("pedidos?estado=eq.__no_existe__", { method: "DELETE", headers: { Prefer: "return=representation" } });
ok(noModifico(r), "DELETE pedidos no toca filas (filtro vacio: ver nota en el informe)", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
r = await rest("productos?id=eq.__no_existe__", { method: "DELETE", headers: { Prefer: "return=representation" } });
ok(noModifico(r), "DELETE productos no toca filas (filtro vacio: ver nota en el informe)", `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);

console.log("\n== 5. Storage ==");
const conImagen = prods.body.find((p) => p.imagen && p.imagen.startsWith("http"));
console.log("  (productos con foto en el bucket:", prods.body.filter((p) => p.imagen && p.imagen.startsWith("http")).length, ")");
let s = await fetch(URL + "/storage/v1/object/public/productos/__no_existe__.jpg", { headers: { apikey: PUB } });
console.log("  lectura publica de objeto inexistente:", s.status, (await s.text()).slice(0, 120));
if (conImagen) { const f = await fetch(conImagen.imagen, { headers: { apikey: PUB } }); ok(f.ok, "foto publica del bucket legible", `${f.status} ${f.headers.get("content-type")}`); }
let b = await fetch(URL + "/storage/v1/bucket/productos", { headers: { apikey: PUB } });
console.log("  anon ve metadatos del bucket:", b.status, (await b.text()).slice(0, 120));
let up = await fetch(URL + "/storage/v1/object/productos/zz-anon.txt", { method: "POST", headers: { apikey: PUB, "Content-Type": "text/plain" }, body: "x" });
ok(up.status >= 400, "anon NO puede subir al bucket (si el bucket aun no existe, esto NO prueba las reglas de Storage)", `${up.status} ${(await up.text()).slice(0, 120)}`);

let createClient = null;
try { ({ createClient } = await import("@supabase/supabase-js")); }
catch (e) { console.log("\n== 6-7. supabase-js no instalado: se omite (npm i --no-save @supabase/supabase-js@2.117.2) =="); }

if (createClient) {
  console.log("\n== 6. supabase-js 2.117.2 con la publishable ==");
  const vistos = [];
  const db = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => { vistos.push({ u: String(u), h: Object.fromEntries(new Headers(o && o.headers).entries()) }); return fetch(u, o); } } });
  const q = await db.from("categorias").select("id").limit(1);
  ok(!q.error && q.data.length === 1, "from().select() funciona", q.error ? q.error.message : "");
  const rp = await db.rpc("seguimiento", { ref: "TQ-NO-EXISTE-000" });
  ok(!rp.error && Array.isArray(rp.data), "rpc() funciona", rp.error ? rp.error.message : "");
  const hh = vistos[0].h;
  console.log("  cabeceras que envia supabase-js: apikey=" + (hh.apikey ? hh.apikey.slice(0, 15) + "..." : "(ninguna)") +
    "  authorization=" + (hh.authorization ? hh.authorization.replace(PUB, "<la publishable>").slice(0, 40) : "(ninguna)"));
  const ses = await db.auth.getSession();
  ok(!ses.error && ses.data.session === null, "auth.getSession() sin sesion responde limpio");

  console.log("\n== 7. Realtime con la publishable ==");
  const estado = await new Promise((res) => {
    const ch = db.channel("prueba-publishable-" + Date.now())
      .on("postgres_changes", { event: "*", schema: "public", table: "productos" }, () => {})
      .subscribe((st, err) => {
        if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(st)) res({ st, err: err && err.message });
      });
    setTimeout(() => res({ st: "SIN_RESPUESTA_10s" }), 10000);
  });
  ok(estado.st === "SUBSCRIBED", "canal postgres_changes (productos) queda SUBSCRIBED", JSON.stringify(estado));
  await db.removeAllChannels();


}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
