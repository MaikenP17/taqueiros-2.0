const { consultarPedidos, actualizarPedidoPorReferencia } = require("./_supabase.js");
const { notificarWhatsApp } = require("./_notificar.js");

/* =============================================================
   ALERTA DE PEDIDOS SIN ATENDER

   Lo dispara un cron cada 2 minutos. Busca pedidos que llevan mas
   de MINUTOS_LIMITE en estado 'nuevo' (o sea: pagados y que nadie
   ha tocado) y manda un aviso al WhatsApp del restaurante.

   Cada pedido se avisa UNA sola vez: al enviarlo se marca la
   columna 'alerta_enviada'. Asi el cron puede correr cada 2 minutos
   sin convertirse en spam.

   COMO SE PROTEGE
   La URL es publica, asi que exige un secreto (CRON_SECRET). Sin el
   responde 401. Se acepta de dos formas:
     - cabecera:  Authorization: Bearer <secreto>   (cron de Vercel)
     - parametro: ?clave=<secreto>                   (crons externos)
============================================================= */

const MINUTOS_LIMITE = 5;

function autorizado(req) {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return false;

  const cabecera = req.headers["authorization"] || "";
  if (cabecera === `Bearer ${secreto}`) return true;

  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("clave") === secreto;
}

module.exports = async (req, res) => {
  if (!autorizado(req)) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    const limite = new Date(Date.now() - MINUTOS_LIMITE * 60 * 1000).toISOString();

    // Pedidos pagados, sin atender, con mas de 5 minutos y sin avisar
    const pendientes = await consultarPedidos(
      `estado=eq.nuevo&alerta_enviada=is.false&pagado_en=lt.${encodeURIComponent(limite)}&select=*&order=pagado_en.asc&limit=10`
    );

    if (!pendientes.length) {
      res.status(200).json({ revisados: 0, alertados: 0 });
      return;
    }

    let alertados = 0;

    for (const pedido of pendientes) {
      const espera = Math.floor((Date.now() - new Date(pedido.pagado_en).getTime()) / 60000);

      try {
        await notificarWhatsApp(pedido, {
          encabezado: `\u26A0\uFE0F *PEDIDO #${String(pedido.id).padStart(3, "0")} SIN ATENDER*`,
          subtitulo: `${espera} minutos esperando`
        });

        // Se marca DESPUES de enviar, para que un fallo de envio
        // permita reintentar en la siguiente pasada del cron.
        await actualizarPedidoPorReferencia(pedido.referencia, { alerta_enviada: true });
        alertados++;
      } catch (err) {
        console.error("[Alertas] No se pudo avisar del pedido", pedido.referencia, err.message);
      }
    }

    console.log(`[Alertas] Revisados ${pendientes.length}, alertados ${alertados}`);
    res.status(200).json({ revisados: pendientes.length, alertados });
  } catch (err) {
    console.error("[Alertas] Error:", err);
    res.status(500).json({ error: "Error revisando pedidos" });
  }
};
