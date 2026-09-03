const { consultarPedidos } = require("./_supabase.js");

/* =============================================================
   MANTENER DESPIERTO EL PROYECTO DE SUPABASE

   Supabase pausa los proyectos del plan gratuito tras 7 dias sin
   actividad. Si el restaurante cierra por vacaciones, el sistema
   quedaria offline justo cuando vuelvan a abrir.

   Esta funcion hace la consulta mas barata posible: pide UN id,
   sin traer ninguna fila completa. Es suficiente para que Supabase
   cuente el proyecto como activo.

   La dispara un cron una vez al dia (ver vercel.json).
============================================================= */
module.exports = async (req, res) => {
  // Protegido igual que el cron de alertas: la URL es publica.
  const secreto = process.env.CRON_SECRET;
  const cabecera = req.headers["authorization"] || "";
  const url = new URL(req.url, "http://localhost");
  const clave = url.searchParams.get("clave");

  if (!secreto || (cabecera !== `Bearer ${secreto}` && clave !== secreto)) {
    res.status(401).json({ error: "No autorizado" });
    return;
  }

  try {
    // La consulta mas liviana que existe: un solo id, una sola fila.
    await consultarPedidos("select=id&limit=1");

    console.log("[KeepAlive] Supabase respondio, proyecto activo");
    res.status(200).json({ ok: true, momento: new Date().toISOString() });
  } catch (err) {
    console.error("[KeepAlive] Supabase no respondio:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
