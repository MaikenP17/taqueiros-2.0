const { pingBase, limpiarHuerfanos } = require("./_supabase.js");
const { autorizadoCron } = require("./_cron.js");

/* =============================================================
   MANTENER DESPIERTO EL PROYECTO DE SUPABASE

   Supabase pausa los proyectos del plan gratuito tras 7 dias sin
   actividad. Si el restaurante cierra por vacaciones, el sistema
   quedaria offline justo cuando vuelvan a abrir.

   Esta funcion hace la consulta mas barata posible: pide UN id,
   sin traer ninguna fila completa. Es suficiente para que Supabase
   cuente el proyecto como activo.

   La dispara un cron una vez al dia (ver vercel.json).

   MULTI-RESTAURANTE: no es de ningun restaurante. El ping toca la tabla
   'restaurantes' (que no es de negocio) y la limpieza de pedidos sin pagar es
   global a proposito (ver limpiarHuerfanos en _supabase.js).
============================================================= */
module.exports = async (req, res) => {
  // Protegido igual que el cron de alertas: la URL es publica.
  if (!autorizadoCron(req)) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    // La consulta mas liviana que existe: un solo id, una sola fila.
    await pingBase();

    // De paso se barren los pedidos que nunca se pagaron y llevan
    // mas de 24 horas ahi. Si la funcion no existe todavia, no pasa
    // nada: el keep-alive sigue cumpliendo su trabajo.
    let huerfanosBorrados = null;
    try {
      huerfanosBorrados = await limpiarHuerfanos();
    } catch (err) {
      console.warn("[KeepAlive] No se pudo limpiar huerfanos:", err.message);
    }

    console.log("[KeepAlive] Supabase respondio, proyecto activo. Huerfanos borrados:", huerfanosBorrados);
    res.status(200).json({ ok: true, momento: new Date().toISOString(), huerfanosBorrados });
  } catch (err) {
    console.error("[KeepAlive] Supabase no respondio:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
