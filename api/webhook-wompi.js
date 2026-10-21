const crypto = require("crypto");
const { buscarPedidoPorReferenciaGlobal, actualizarPedidoPorReferencia, buscarRestaurantePorId } = require("./_supabase.js");
const { notificarWhatsApp } = require("./_notificar.js");
const { leerSecretos, secretosWompi, contactoAlertas } = require("./_restaurante.js");

/* =============================================================
   WEBHOOK DE WOMPI — el corazon del sistema de pedidos.

   Wompi llama a esta URL cuando una transaccion cambia de estado.
   Gracias a esto el pedido llega al restaurante SIN que el cliente
   tenga que hacer nada (ni presionar WhatsApp, ni dejar la pestana
   abierta).

   MULTI-RESTAURANTE: es UN solo endpoint para todos los restaurantes, asi que
   no se puede saber de quien es el evento por el host. Se deduce del PEDIDO:
     a. La referencia del evento identifica el pedido (referencia unica en toda
        la base) y el pedido trae su restaurante_id.
     b. La firma se verifica con los secretos de ESE restaurante, nunca con los
        de otro: una firma valida para el restaurante A no sirve para marcar
        como pagado un pedido del restaurante B.
     c. A partir de ahi, todo (buscar, actualizar, avisar) se hace con el
        restaurante_id del pedido.
   Una referencia desconocida y una firma mala responden IGUAL (401): asi el
   endpoint no sirve para averiguar que referencias existen.
   Un restaurante suspendido SI procesa sus pagos: el cliente ya pago y ese
   dinero no puede quedar sin pedido; lo que se corta es crear pedidos nuevos.

   Flujo:
     1. Busca el pedido por su referencia (lo creo /api/crear-pedido
        antes de abrir el widget de pago) y valida la firma del evento con
        los secretos de su restaurante (obligatorio: sin esto cualquiera
        podria inventar pagos falsos haciendo un POST a esta URL).
     2. Revisa si ya estaba procesado (duplicado).
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

    // ---- 1. Identificar el pedido (y su restaurante) y validar la firma
    const referencia = String(transaccion.reference || "");
    const pedido = referencia ? await buscarPedidoPorReferenciaGlobal(referencia) : null;

    if (!pedido) {
      // No deberia pasar con un evento legitimo: el pedido se crea antes de
      // pagar (puede ocurrir si Supabase estaba caido, o si la limpieza ya
      // borro un pedido sin pagar). Sin pedido no hay restaurante con cuyos
      // secretos verificar: se responde igual que una firma mala.
      console.error("[Wompi] Evento de una referencia sin pedido, rechazado:", referencia.slice(0, 40));
      res.status(401).json({ error: "Firma inválida" });
      return;
    }

    // El restaurante es el del pedido; los secretos, los suyos y nada mas
    const restaurante = await buscarRestaurantePorId(pedido.restaurante_id);
    const secretos = restaurante ? await leerSecretos(restaurante) : null;
    const secreto = restaurante
      ? secretosWompi(restaurante, secretos, environment === "prod" ? "produccion" : "test").eventos
      : null;

    if (!firmaValida(evento, secreto)) {
      console.error("[Wompi] FIRMA INVALIDA. Evento rechazado. Referencia:", referencia);
      // 401: el evento no es legitimo (o falta el secreto). No se
      // toca ningun pedido.
      res.status(401).json({ error: "Firma inválida" });
      return;
    }

    const rid = pedido.restaurante_id;
    const estadoWompi = transaccion.status;
    console.log("[Wompi] Evento verificado:", referencia, estadoWompi, transaccion.id);

    // ---- 2. El ambiente del evento debe ser el del cobro -------
    // Un evento de PRUEBA (tarjetas de prueba de Wompi, firmado con el secreto
    // de prueba del restaurante) solo vale para un pedido que se creo en prueba
    // y en un restaurante que no cobra en produccion. Sin esto, un pedido real
    // firmado en prueba (Taqueiros acepta todavia el modo del navegador, o un
    // pedido viejo de cuando el restaurante estaba en prueba) entraria a cocina
    // pagado con una tarjeta de prueba. Se responde 200: el evento es legitimo
    // (la firma es buena) y no tiene sentido que Wompi lo reintente.
    const ambienteEvento = environment === "prod" ? "prod" : "test";
    const modoFijado = ((secretos && secretos.otros) || {}).wompi_modo;
    const ambienteFijado = modoFijado === "produccion" ? "prod" : modoFijado === "test" ? "test" : null;
    if ((ambienteFijado && ambienteFijado !== ambienteEvento)
        || (pedido.wompi_ambiente && pedido.wompi_ambiente !== ambienteEvento)) {
      console.error("[Wompi] Evento de ambiente", ambienteEvento, "para un pedido de", pedido.wompi_ambiente,
        "(restaurante en", ambienteFijado || "modo sin fijar", "): se ignora. Referencia:", referencia);
      res.status(200).json({ received: true, ignored: "ambiente" });
      return;
    }

    // ---- 3. Duplicado: ya estaba procesado -------------------
    if (pedido.estado_pago === "aprobado") {
      console.log("[Wompi] Evento duplicado ignorado, el pedido ya estaba aprobado:", referencia);
      res.status(200).json({ received: true, duplicated: true });
      return;
    }

    // Todas las escrituras de aqui en adelante son CONDICIONALES: solo cambian un
    // pedido que en ese instante NO este aprobado. Dos eventos que llegan a la vez
    // (o un rechazo que leyo el pedido antes de una aprobacion y escribe despues)
    // no pueden deshacer un pago ni mandar la comanda dos veces.
    const SIN_APROBAR = "estado_pago=neq.aprobado";

    // ---- 4. Rechazos: se registran, no crean comanda ---------
    if (estadoWompi !== "APPROVED") {
      await actualizarPedidoPorReferencia(rid, referencia, {
        estado_pago: ESTADO_PAGO[estadoWompi] || "error",
        wompi_transaction_id: transaccion.id,
        wompi_metodo_pago: transaccion.payment_method_type || null
      }, SIN_APROBAR);
      console.log("[Wompi] Pago no aprobado, el pedido no entra a cocina:", referencia, estadoWompi);
      res.status(200).json({ received: true });
      return;
    }

    // ---- 5. Verificar que el monto (en centavos exactos) y la moneda coincidan
    const centavosPagados = Number(transaccion.amount_in_cents);
    const monedaOk = transaccion.currency == null || transaccion.currency === "COP";
    if (centavosPagados !== Number(pedido.total) * 100 || !monedaOk) {
      console.error(
        "[Wompi] ALERTA: el monto pagado no coincide con el pedido.",
        "Referencia:", referencia,
        "Pagado (centavos):", centavosPagados, transaccion.currency,
        "Esperado:", pedido.total
      );
      await actualizarPedidoPorReferencia(rid, referencia, {
        estado_pago: "error",
        wompi_transaction_id: transaccion.id
      }, SIN_APROBAR);
      res.status(200).json({ received: true, warning: "monto no coincide" });
      return;
    }

    // ---- 6. Pago aprobado: el pedido entra a cocina ----------
    const actualizado = await actualizarPedidoPorReferencia(rid, referencia, {
      estado: "nuevo",
      estado_pago: "aprobado",
      wompi_transaction_id: transaccion.id,
      wompi_metodo_pago: transaccion.payment_method_type || null,
      pagado_en: new Date().toISOString()
    }, SIN_APROBAR);

    if (!actualizado) {
      // Otro evento lo aprobo entre la lectura y esta escritura: ya se aviso
      console.log("[Wompi] Evento duplicado (simultaneo) ignorado, el pedido ya estaba aprobado:", referencia);
      res.status(200).json({ received: true, duplicated: true });
      return;
    }

    console.log("[Wompi] PEDIDO CONFIRMADO Y EN COCINA:", referencia, "total:", pedido.total);

    // ---- 7. Respaldo: comanda al WhatsApp del restaurante ----
    // No se deja que un fallo aqui rompa el webhook: el pedido ya
    // esta guardado y visible en el panel, que es el canal principal.
    try {
      // El aviso sale SOLO por el contacto de este restaurante
      const aviso = await notificarWhatsApp(actualizado, undefined, contactoAlertas(restaurante, secretos));

      // Queda registrado en el propio pedido si se logro avisar, para
      // poder revisar despues de cuales no se entero el restaurante.
      await actualizarPedidoPorReferencia(rid, referencia, { notificacion_ok: !!aviso.enviado });
    } catch (errNotif) {
      console.error("[Wompi] El pedido se guardo pero fallo la notificacion:", errNotif.message);
      try {
        await actualizarPedidoPorReferencia(rid, referencia, { notificacion_ok: false });
      } catch (e) { /* si tampoco se puede marcar, el pedido ya esta a salvo */ }
    }

    res.status(200).json({ received: true, ok: true });
  } catch (err) {
    console.error("[Wompi] Error procesando webhook:", err);
    // 500 hace que Wompi reintente (30 min, 3 h, 24 h). Es lo
    // correcto: si Supabase fallo, queremos otra oportunidad.
    res.status(500).json({ error: "Error interno" });
  }
};
