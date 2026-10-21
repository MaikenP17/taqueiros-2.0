const { exigirRestaurante } = require("./_restaurante.js");
const { datosManifest } = require("./_publico.js");

/* =============================================================
   MANIFEST DE LA PWA (el panel instalable), POR RESTAURANTE

   panel.html lo pide como /manifest.json; vercel.json lo reescribe a este
   endpoint. Nombre, colores e iconos salen del restaurante del host (ver
   _restaurante.js), validados con las mismas reglas que /api/restaurante:
   colores #RRGGBB, iconos con ruta relativa o http(s) de un origen esperado.

   Host desconocido: 404 con el mismo cuerpo que los demas endpoints.
   Sin cache: el navegador lo relee de vez en cuando y cada host tiene el suyo.
============================================================= */
module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const restaurante = await exigirRestaurante(req, res);
  if (!restaurante) return;

  const d = datosManifest(restaurante);
  const ruta = (u) => (u && !/^https?:/i.test(u) && !u.startsWith("/") ? "/" + u : u);

  const iconos = [];
  const i192 = ruta(d.icono192);
  const i512 = ruta(d.icono512);
  if (i192) iconos.push({ src: i192, sizes: "192x192", type: "image/png", purpose: "any" });
  if (i512) iconos.push({ src: i512, sizes: "512x512", type: "image/png", purpose: "any" });

  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(JSON.stringify({
    name: d.nombre,
    short_name: d.nombreCorto,
    description: d.descripcion,
    start_url: "/panel.html",
    scope: "/panel.html",
    display: "standalone",
    orientation: "any",
    background_color: d.colorFondo,
    theme_color: d.colorTema,
    lang: "es-CO",
    categories: ["business", "food"],
    icons: iconos
  }, null, 2));
};
