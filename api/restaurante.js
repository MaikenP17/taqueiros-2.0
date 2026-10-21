const { exigirRestaurante } = require("./_restaurante.js");
const { datosPublicos } = require("./_publico.js");

/* =============================================================
   DATOS PUBLICOS DEL RESTAURANTE DE ESTE HOST

   Lo leen las paginas publicas (index.html, pedido.html) para saber como
   pintarse y que ofrecer, sin llevar nada escrito a mano:

     id, slug, nombre, zona_horaria, moneda
     modulos     que partes del producto tiene activas (pasarela, seguimiento...)
     servicio    { estado: activo|suspendido, sirve, motivo }
     marca       logo, iconos, emoji, colores
     textos      eslogan, mensajes, textos del seguimiento
     contacto    WhatsApp, telefono, direccion, redes
     ubicacion   { lat, lng } del local (el mapa del domicilio)
     domicilio   { ofrece, factor_recorrido, tarifas: [{ hasta, precio|null }] }
     pago        { disponible, pasarela, modo: test|produccion, llave_publica }

   La forma exacta, de donde sale cada cosa y que NO sale nunca esta en
   api/_publico.js y en docs/multirestaurante.md (seccion 14). Todo se arma campo
   por campo y se valida (colores, URLs, telefonos, textos): lo que no pasa se omite.

   El modo de cobro y la llave publica los decide el SERVIDOR (otros.wompi_modo de
   restaurante_secretos); el navegador no elige. La llave que sale es la PUBLICA
   (pub_...) del modo vigente y solo si hay secreto de integridad para firmar.

   En gracia (atrasado con la mensualidad) dice "activo": eso no es publico.
   Sin cache en el borde: es por host y el estado del servicio cambia; la
   resolucion del host ya se guarda 30 s en memoria (ver _restaurante.js).
============================================================= */
module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const restaurante = await exigirRestaurante(req, res);
  if (!restaurante) return;

  try {
    const datos = await datosPublicos(restaurante);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(datos);
  } catch (err) {
    console.error("[Restaurante] No se pudieron armar los datos publicos:", err.message);
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "No se pudieron cargar los datos del restaurante" });
  }
};
