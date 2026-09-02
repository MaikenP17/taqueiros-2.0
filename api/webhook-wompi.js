const crypto = require("crypto");
const { buscarPedidoPorReferencia, actualizarPedidoPorReferencia } = require("./_supabase.js");
const { notificarWhatsApp } = require("./_notificar.js");

/* =============================================================
   WEBHOOK DE WOMPI — el corazon del sistema de pedidos.

   Wompi llama a esta URL cuando una transaccion cambia de estado.
   Gracias a esto el pedido llega al restaurante SIN que el cliente
   tenga que hacer nada (ni presionar WhatsApp, ni dejar la pestana
   abierta).

   Flujo:
     1. Valida la firma del evento (obligatorio: sin esto cualquiera
        podria inventar pagos falsos haciendo un POST a esta URL).
     2. Busca el pedido por su referencia (lo creo /api/crear-pedido
        antes de abrir el widget de pago).
     3. Verifica que el monto pagado coincida con el monto guardado.
     4. Si esta APPROVED -> el pedido pasa a estado 'nuevo' y aparece
        en el panel de comandas. Si no, se registra el rechazo.
     5. Responde 200 siempre que el evento sea legitimo, para que
        Wompi no lo siga reintentando.

   Duplicados: Wompi puede reenviar el mismo evento (reintenta a los
   30 min, 3 h y 24 h si no recibe un 200). Como aqui se hace un
   UPDATE por referencia y no un INSERT, procesar el mismo evento
   dos veces deja exactamente el mismo resultado. Ademas, si el
   pedido ya estaba aprobado, se corta antes de volver a notificar
   para no mandar la comanda repetida al WhatsApp del restaurante.
============================================================= */

/* Recalcula el checksum del evento y lo compara con el que envio
   Wompi. Las propiedades que se firman pueden variar segun el
   evento, por eso se leen dinamicamente de signature.properties. */
function firmaValida(evento, secreto) {
  const { data, signature, timestamp } = evento;

  if (!secreto || !signature || !Array.isArray(signature.properties) || !timestamp) {
    return false;
  }

  const valores = signature.properties.map((prop) => {
    // "transaction.id" -> data.transaction.id
    let valor = data;
    prop.split(".").forEach((clave) => {
      valor = valor ? valor[clave] : undefined;
    });
    return valor;
  }).join("");

  const calculado = crypto
    .createHash("sha256")
    .update(`${valores}${timestamp}${secreto}`)
    .digest("hex");

  const recibido = String(signature.checksum || "");

  // Comparacion en tiempo constante para no filtrar informacion
  // a traves del tiempo de respuesta.
  const a = Buffer.from(calculado.toUpperCase());
  const b = Buffer.from(recibido.toUpperCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ESTADO_PAGO = {
  APPROVED: "aprobado",
  DECLINED: "rechazado",
  ERROR: "error",
  VOIDED: "anulado"
};

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  try {
    const evento = req.body || {};
    const { data, environment } = evento;
    const transaccion = data && data.transaction;

    if (!transaccion) {
      console.warn("[Wompi] Evento sin transaccion, se ignora:", evento.event);
      res.status(200).json({ received: true });
      return;
    }

    // ---- 1. Validar la firma ---------------------------------
    const secreto = environment === "prod"
      ? process.env.WOMPI_EVENTS_SECRET_PROD
      : process.env.WOMPI_EVENTS_SECRET_TEST;

    if (!firmaValida(evento, secreto)) {
      console.error("[Wompi] FIRMA INVALIDA. Evento rechazado. Referencia:", transaccion.reference);
      // 401: el evento no es legitimo (o falta el secreto). No se
      // toca ningun pedido.
      res.status(401).json({ error: "Firma inválida" });
      return;
    }

    const referencia = transaccion.reference;
    const estadoWompi = transaccion.status;
    console.log("[Wompi] Evento verificado:", referencia, estadoWompi, transaccion.id);

    // ---- 2. Buscar el pedido ---------------------------------
    const pedido = await buscarPedidoPorReferencia(referencia);

    if (!pedido) {
      // No deberia pasar: el pedido se crea antes de pagar. Puede
      // ocurrir si Supabase estaba caido en ese momento.
      console.error("[Wompi] No existe un pedido con la referencia:", referencia);
      res.status(200).json({ received: true, warning: "pedido no encontrado" });
      return;
    }

    // ---- 3. Duplicado: ya estaba procesado -------------------
    if (pedido.estado_pago === "aprobado") {
      console.log("[Wompi] Evento duplicado ignorado, el pedido ya estaba aprobado:", referencia);
      res.status(200).json({ received: true, duplicated: true });
      return;
    }

    // ---- 4. Rechazos: se registran, no crean comanda ---------
    if (estadoWompi !== "APPROVED") {
      await actualizarPedidoPorReferencia(referencia, {
        estado_pago: ESTADO_PAGO[estadoWompi] || "error",
        wompi_transaction_id: transaccion.id,
        wompi_metodo_pago: transaccion.payment_method_type || null
      });
      console.log("[Wompi] Pago no aprobado, el pedido no entra a cocina:", referencia, estadoWompi);
      res.status(200).json({ received: true });
      return;
    }

    // ---- 5. Verificar que el monto coincida ------------------
    const pagadoEnPesos = Math.round(Number(transaccion.amount_in_cents) / 100);
    if (pagadoEnPesos !== Number(pedido.total)) {
      console.error(
        "[Wompi] ALERTA: el monto pagado no coincide con el pedido.",
        "Referencia:", referencia,
        "Pagado:", pagadoEnPesos,
        "Esperado:", pedido.total
      );
      await actualizarPedidoPorReferencia(referencia, {
        estado_pago: "error",
        wompi_transaction_id: transaccion.id
      });
      res.status(200).json({ received: true, warning: "monto no coincide" });
      return;
    }

    // ---- 6. Pago aprobado: el pedido entra a cocina ----------
    const actualizado = await actualizarPedidoPorReferencia(referencia, {
      estado: "nuevo",
      estado_pago: "aprobado",
      wompi_transaction_id: transaccion.id,
      wompi_metodo_pago: transaccion.payment_method_type || null,
      pagado_en: new Date().toISOString()
    });

    console.log("[Wompi] PEDIDO CONFIRMADO Y EN COCINA:", referencia, "total:", pedido.total);

    // ---- 7. Respaldo: comanda al WhatsApp del restaurante ----
    // No se deja que un fallo aqui rompa el webhook: el pedido ya
    // esta guardado y visible en el panel, que es el canal principal.
    try {
      await notificarWhatsApp(actualizado || pedido);
    } catch (errNotif) {
      console.error("[Wompi] El pedido se guardo pero fallo la notificacion:", errNotif.message);
    }

    res.status(200).json({ received: true, ok: true });
  } catch (err) {
    console.error("[Wompi] Error procesando webhook:", err);
    // 500 hace que Wompi reintente (30 min, 3 h, 24 h). Es lo
    // correcto: si Supabase fallo, queremos otra oportunidad.
    res.status(500).json({ error: "Error interno" });
  }
};
