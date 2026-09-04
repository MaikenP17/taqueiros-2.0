const { leerAgotados } = require("./_menu.js");

/* =============================================================
   QUE ESTA AGOTADO AHORA MISMO

   Endpoint diminuto a proposito: solo devuelve la lista de ids no
   disponibles. Por eso puede ir casi sin cache sin castigar a
   Supabase, mientras el catalogo completo se cachea 5 minutos.

   POR QUE ESTA SEPARADO DEL MENU
   El catalogo cambia muy poco (precios, fotos, descripciones). La
   disponibilidad cambia en mitad del servicio, cuando se acaba algo.
   Mezclarlos obligaria a elegir entre un menu lento o un agotado que
   tarda 5 minutos en desaparecer. Separados, cada uno tiene el cache
   que le corresponde.
============================================================= */
module.exports = async (req, res) => {
  try {
    const agotados = await leerAgotados();

    // 10 segundos: agotar un producto se nota casi al instante, y aun
    // con mucho trafico son 6 consultas por minuto como maximo.
    res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    res.status(200).json({ ok: true, agotados });
  } catch (err) {
    console.error("[Disponibilidad] No se pudo consultar:", err.message);

    /* Si esto falla NO se inventa nada: se responde 'sin dato'. La
       pagina entonces deja el menu tal cual y la validacion del pago
       (que consulta la base directo) sigue impidiendo que se cobre
       algo agotado. */
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, agotados: null });
  }
};
