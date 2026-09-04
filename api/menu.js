const { leerMenu, menuDeRespaldo } = require("./_menu.js");

/* =============================================================
   EL MENU PARA LA PAGINA DEL CLIENTE

   Devuelve categorias y productos listos para pintar.

   CACHE: 5 minutos en el borde de Vercel. Una hora punta de 500
   visitas no son 500 consultas a Supabase, sino unas pocas.

   La disponibilidad NO viaja aqui como verdad de ultimo momento:
   para eso esta /api/disponibilidad, que va casi sin cache. Este
   endpoint incluye 'disponible' solo como valor inicial, y la
   pagina lo corrige enseguida con el otro. Asi agotar un producto
   se ve en segundos y no en 5 minutos.
============================================================= */
module.exports = async (req, res) => {
  try {
    const menu = await leerMenu();

    if (!menu.categorias.length || !menu.productos.length) {
      throw new Error("Supabase respondio con un menu vacio");
    }

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ ok: true, ...menu });
  } catch (err) {
    console.error("[Menu] No se pudo leer de Supabase:", err.message);

    // Red de seguridad: lo ultimo que esta instancia sirvio bien
    const respaldo = menuDeRespaldo();

    if (respaldo) {
      console.warn("[Menu] Sirviendo el ultimo menu bueno, de", respaldo.momento);
      // Cache corto: se quiere reintentar Supabase pronto
      res.setHeader("Cache-Control", "public, s-maxage=30");
      res.status(200).json({ ok: true, deRespaldo: true, ...respaldo });
      return;
    }

    /* Ni base ni respaldo. Se responde con un error explicito y SIN
       cachearlo, para no congelar el fallo. La pagina tiene su propia
       copia del ultimo menu que recibio; si tampoco la tiene, mostrara
       un aviso con el WhatsApp. */
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ ok: false, error: "El menú no está disponible en este momento" });
  }
};
