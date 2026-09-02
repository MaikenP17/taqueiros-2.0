const crypto = require("crypto");

/* Recibe los eventos que Wompi envía cuando una transacción cambia de
   estado (ver "URL de Eventos" en el dashboard de Wompi). Valida el
   checksum para confirmar que el evento realmente viene de Wompi y no
   de un tercero, y deja constancia en los logs de Vercel.

   Esto NO reemplaza al widget/callback en el frontend, es un respaldo
   server-side para no depender únicamente de que el navegador del
   cliente siga abierto. Por ahora solo registra el evento en los logs;
   si más adelante quieres que dispare una notificación automática
   (email, Slack, base de datos), este es el lugar para agregarlo. */
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  try {
    const evento = req.body || {};
    const { data, signature, timestamp, environment } = evento;

    const secreto = environment === "prod"
      ? process.env.WOMPI_EVENTS_SECRET_PROD
      : process.env.WOMPI_EVENTS_SECRET_TEST;

    let esValido = false;

    if (secreto && signature && Array.isArray(signature.properties) && timestamp) {
      const valores = signature.properties.map((prop) => {
        const partes = prop.split(".").slice(1); // quita el prefijo "transaction."
        let valor = data;
        partes.forEach((k) => { valor = valor ? valor[k] : undefined; });
        return valor;
      }).join("");

      const cadena = `${valores}${timestamp}${secreto}`;
      const checksumCalculado = crypto.createHash("sha256").update(cadena).digest("hex");

      esValido = signature.checksum &&
        checksumCalculado.toUpperCase() === String(signature.checksum).toUpperCase();
    }

    if (esValido) {
      const tx = data && data.transaction;
      console.log("[Wompi] Evento verificado:", tx && tx.id, tx && tx.status, tx && tx.reference);
    } else {
      console.warn("[Wompi] Evento recibido con checksum inválido o secreto no configurado", evento.event);
    }

    // Siempre respondemos 200 para que Wompi no siga reintentando el envío.
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[Wompi] Error procesando webhook:", err);
    res.status(200).json({ received: true });
  }
};
