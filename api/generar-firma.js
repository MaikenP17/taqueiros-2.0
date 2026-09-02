const crypto = require("crypto");

/* Calcula la firma de integridad que exige el Widget de Wompi antes de
   abrir el checkout. Corre en el servidor (Vercel Serverless Function)
   porque el secreto de integridad NUNCA debe llegar al navegador. */
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const { referencia, montoEnCentavos, modo } = req.body || {};

  if (!referencia || !montoEnCentavos) {
    res.status(400).json({ error: "Faltan datos: referencia o montoEnCentavos" });
    return;
  }

  const moneda = "COP";
  const secreto = modo === "produccion"
    ? process.env.WOMPI_INTEGRITY_SECRET_PROD
    : process.env.WOMPI_INTEGRITY_SECRET_TEST;

  if (!secreto) {
    res.status(500).json({ error: "El secreto de integridad no está configurado en el servidor" });
    return;
  }

  const cadena = `${referencia}${montoEnCentavos}${moneda}${secreto}`;
  const firma = crypto.createHash("sha256").update(cadena).digest("hex");

  res.status(200).json({ firma });
};
