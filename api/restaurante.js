const { exigirRestaurante, restauranteActivo } = require("./_restaurante.js");

/* =============================================================
   DATOS PUBLICOS DEL RESTAURANTE DE ESTE HOST

   Lo usara el frontend para saber como pintarse (nombre, colores, logo, que
   modulos mostrar, si el servicio esta activo) sin llevar nada escrito a mano.

   SOLO devuelve datos no sensibles. La lista es explicita (se arma campo por
   campo, no se copia la fila):

     id            para llamar a las funciones publicas de la base (p_restaurante)
     slug, nombre
     zona_horaria
     modulos       que partes del producto tiene activas (pasarela, seguimiento...)
     config        SOLO config.publico (colores, logo, WhatsApp de contacto, etc.)
     servicio      { estado: activo|gracia|suspendido, sirve, motivo }

   NO devuelve nunca: plan, modalidad de pago, fecha de vigencia ni dias de gracia
   (datos comerciales), el resto de config (puede traer configuracion interna),
   nada de restaurante_secretos (llaves de Wompi, CallMeBot), ni miembros.

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

  const servicio = restauranteActivo(restaurante);
  const cfg = restaurante.config && typeof restaurante.config === "object" ? restaurante.config : {};
  const publico = cfg.publico && typeof cfg.publico === "object" && !Array.isArray(cfg.publico) ? cfg.publico : {};

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    id: restaurante.id,
    slug: restaurante.slug,
    nombre: restaurante.nombre,
    zona_horaria: restaurante.zona_horaria,
    modulos: restaurante.modulos || {},
    config: publico,
    servicio: {
      estado: servicio.estado,
      sirve: servicio.sirve,
      motivo: servicio.sirve ? (servicio.estado === "gracia" ? "en_gracia" : null) : "servicio_suspendido"
    }
  });
};
