const { estadoRestaurante } = require("./_horario.js");
const { exigirRestaurante, restauranteActivo } = require("./_restaurante.js");

/* =============================================================
   Estado del restaurante para la pagina publica.

   index.html lo consulta al cargar para saber si pinta el banner
   de "cerrado" y si desactiva el pago en linea.

   Devuelve solo lo necesario: nada de datos de clientes ni de la
   configuracion interna. Por eso la pagina no necesita ninguna
   llave de Supabase.

   MULTI-RESTAURANTE: horario, interruptor, zona horaria y hora de corte
   son los del restaurante del host. Ademas del estado de siempre se
   informa 'servicio' (si el restaurante esta recibiendo pedidos), para que
   la pagina pueda avisar cuando el servicio esta suspendido.
============================================================= */
module.exports = async (req, res) => {
  const restaurante = await exigirRestaurante(req, res);
  if (!restaurante) return;

  try {
    const estado = await estadoRestaurante(restaurante);
    const servicio = restauranteActivo(restaurante);

    // Se cachea 60 segundos en el borde de Vercel: si el dueno
    // cierra el local, los clientes lo ven en menos de un minuto,
    // y mientras tanto no se gasta una invocacion por visita.
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
    res.setHeader("Vary", "Host");

    res.status(200).json({
      abierto: estado.abierto,
      mensaje: estado.mensaje,
      horarioHoy: estado.horarioHoy,
      horarios: estado.horarios,
      servicio: { sirve: servicio.sirve, motivo: servicio.sirve ? null : "servicio_suspendido" }
    });
  } catch (err) {
    console.error("[Estado] Error:", err);
    // Ante un fallo se responde "abierto": es preferible aceptar un
    // pedido de mas que perder ventas por un problema tecnico.
    res.status(200).json({ abierto: true, mensaje: null, horarioHoy: null, horarios: [] });
  }
};
