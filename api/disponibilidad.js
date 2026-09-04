const { leerEstadoMenu } = require("./_menu.js");

/* =============================================================
   QUE SE PUEDE PEDIR AHORA MISMO

   Devuelve solo ids: los productos agotados y las categorias
   desactivadas. Por eso puede ir casi sin cache sin castigar a
   Supabase, mientras el catalogo completo se cachea 5 minutos.

   -------------------------------------------------------------
   POR QUE NO LLEVA stale-while-revalidate
   -------------------------------------------------------------
   Se midio contra el endpoint desplegado y quedo claro:

     11s | x-vercel-cache: STALE | agotados: []
     16s | x-vercel-cache: HIT   | agotados: ["doriloco"]

   Con stale-while-revalidate, la primera peticion despues de vencer
   sirve la copia VIEJA y refresca por detras. Hacen falta DOS
   peticiones para ver el valor nuevo, asi que el retardo se duplica.

   Para el catalogo eso esta bien (nadie sufre por ver un nombre 10
   segundos viejo). Para la disponibilidad no: es justo el dato que
   tiene que llegar rapido. Sin SWR, la peticion que encuentra el
   cache vencido espera el valor fresco y lo devuelve ya.
============================================================= */
module.exports = async (req, res) => {
  try {
    const estado = await leerEstadoMenu();

    // 10 segundos, sin stale-while-revalidate a proposito (ver arriba)
    res.setHeader("Cache-Control", "public, s-maxage=10");
    res.status(200).json({ ok: true, ...estado });
  } catch (err) {
    console.error("[Disponibilidad] No se pudo consultar:", err.message);

    /* Si esto falla NO se inventa nada: se responde 'sin dato'. La
       pagina deja el menu como esta y la validacion del pago (que
       consulta la base directo) sigue impidiendo que se cobre algo
       agotado. */
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, agotados: null, categoriasInactivas: null });
  }
};
