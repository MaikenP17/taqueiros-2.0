const crypto = require("crypto");
const { buscarPedidoPorReferencia } = require("./_supabase.js");
const {
  exigirRestaurante, restauranteFresco, exigirServicio,
  leerSecretos, modoDePago, secretosWompi
} = require("./_restaurante.js");

/* Calcula la firma de integridad que exige el Widget de Wompi antes de
   abrir el checkout. Corre en el servidor (Vercel Serverless Function)
   porque el secreto de integridad NUNCA debe llegar al navegador.

   MULTI-RESTAURANTE: el restaurante sale del host; el secreto es el de ese
   restaurante. Ademas, solo firma un pedido que EXISTE en ese restaurante,
   esta pendiente de pago y cuyo monto es el guardado (antes firmaba cualquier
   referencia y monto que le mandaran). Ninguna pagina actual lo llama: la firma
   normal la devuelve /api/crear-pedido. */
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const restauranteCache = await exigirRestaurante(req, res);
  if (!restauranteCache) return;

  try {
    const { referencia, montoEnCentavos, modo } = req.body || {};

    if (!referencia || !montoEnCentavos) {
      res.status(400).json({ error: "Faltan datos: referencia o montoEnCentavos" });
      return;
    }

    const restaurante = await restauranteFresco(restauranteCache);
    if (!exigirServicio(res, restaurante)) return;

    // El pedido debe ser de ESTE restaurante, estar sin pagar y por ese monto
    const pedido = await buscarPedidoPorReferencia(restaurante.id, String(referencia));
    if (!pedido || pedido.estado_pago !== "pendiente"
        || Number(montoEnCentavos) !== Number(pedido.total) * 100) {
      res.status(404).json({ error: "Pedido no encontrado" });
      return;
    }

    const moneda = "COP";
    const secretos = await leerSecretos(restaurante);
    const modoCobro = modoDePago(restaurante, secretos, modo);
    const secreto = modoCobro ? secretosWompi(restaurante, secretos, modoCobro).integridad : null;

    if (!secreto) {
      res.status(500).json({ error: "El secreto de integridad no está configurado en el servidor" });
      return;
    }

    // Se firma SOLO en el modo en que se creo el pedido: firmar un pedido de
    // produccion en prueba permitiria pagarlo con tarjetas de prueba (el webhook
    // tambien lo rechaza; aqui ni se firma).
    if (pedido.wompi_ambiente && pedido.wompi_ambiente !== (modoCobro === "produccion" ? "prod" : "test")) {
      res.status(409).json({ error: "Este pedido se creó con otro modo de cobro" });
      return;
    }

    const cadena = `${referencia}${montoEnCentavos}${moneda}${secreto}`;
    const firma = crypto.createHash("sha256").update(cadena).digest("hex");

    res.status(200).json({ firma });
  } catch (err) {
    console.error("[Firma] Error:", err.message);
    res.status(500).json({ error: "No se pudo generar la firma" });
  }
};
