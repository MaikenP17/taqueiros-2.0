const { leerMenu, menuDeRespaldo } = require("./_menu.js");
const { exigirRestaurante } = require("./_restaurante.js");

/* =============================================================
   EL MENU PARA LA PAGINA DEL CLIENTE

   Devuelve categorias y productos listos para pintar.

   CACHE: 60 segundos en el borde de Vercel. Una hora punta de 500
   visitas no son 500 consultas a Supabase, sino una por minuto por
   region de Vercel.

   Eran 300 s con stale-while-revalidate=600. Con productos que el
   dueno agrega desde el panel eso era demasiado: un producto nuevo
   tardaba hasta 5 min en aparecer y, con SWR, la primera visita
   despues de vencer todavia recibia la copia vieja. Sin SWR, la
   visita que encuentra el cache vencido espera la respuesta fresca
   (una consulta de ~100 ms) y ya la ve nueva.

   La disponibilidad NO viaja aqui como verdad de ultimo momento:
   para eso esta /api/disponibilidad, que va casi sin cache. Este
   endpoint incluye 'disponible' solo como valor inicial, y la
   pagina lo corrige enseguida con el otro. Asi agotar un producto
   se ve en segundos y no en 5 minutos.

   MULTI-RESTAURANTE: el menu es el del restaurante del host (ver
   _restaurante.js). La cache del borde va por dominio y se marca
   "Vary: Host"; la copia de respaldo en memoria es por restaurante.
   Un restaurante suspendido sigue mostrando su menu: lo que se
   bloquea es pedir (crear-pedido).
============================================================= */
module.exports = async (req, res) => {
  const restaurante = await exigirRestaurante(req, res);
  if (!restaurante) return;

  try {
    const menu = await leerMenu(restaurante.id);

    if (!menu.categorias.length || !menu.productos.length) {
      throw new Error("Supabase respondio con un menu vacio");
    }

    res.setHeader("Cache-Control", "public, s-maxage=60");
    res.setHeader("Vary", "Host");
    res.status(200).json({ ok: true, ...menu });
  } catch (err) {
    console.error("[Menu] No se pudo leer de Supabase:", err.message);

    // Red de seguridad: lo ultimo que esta instancia sirvio bien
    const respaldo = menuDeRespaldo(restaurante.id);

    if (respaldo) {
      console.warn("[Menu] Sirviendo el ultimo menu bueno, de", respaldo.momento);
      // Cache corto: se quiere reintentar Supabase pronto
      res.setHeader("Cache-Control", "public, s-maxage=30");
      res.setHeader("Vary", "Host");
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
