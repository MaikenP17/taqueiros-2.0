const { estadoRestaurante } = require("./_horario.js");

/* =============================================================
   Estado del restaurante para la pagina publica.

   index.html lo consulta al cargar para saber si pinta el banner
   de "cerrado" y si desactiva el pago en linea.

   Devuelve solo lo necesario: nada de datos de clientes ni de la
   configuracion interna. Por eso la pagina no necesita ninguna
   llave de Supabase.
============================================================= */
module.exports = async (req, res) => {
  try {
    const estado = await estadoRestaurante();

    // Se cachea 60 segundos en el borde de Vercel: si el dueno
    // cierra el local, los clientes lo ven en menos de un minuto,
    // y mientras tanto no se gasta una invocacion por visita.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

    res.status(200).json({
      abierto: estado.abierto,
      mensaje: estado.mensaje,
      horarioHoy: estado.horarioHoy,
      horarios: estado.horarios
    });
  } catch (err) {
    console.error("[Estado] Error:", err);
    // Ante un fallo se responde "abierto": es preferible aceptar un
    // pedido de mas que perder ventas por un problema tecnico.
    res.status(200).json({ abierto: true, mensaje: null, horarioHoy: null, horarios: [] });
  }
};
