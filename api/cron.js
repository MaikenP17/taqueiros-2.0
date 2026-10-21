const { crearDespachador } = require("./_despacho.js");

/* =============================================================
   FUNCION AGRUPADA: LOS ENDPOINTS DE LOS CRONS

   /api/alertas y /api/keep-alive (cron-job.org y el cron de Vercel) llegan aqui
   por las reescrituras de vercel.json (ver _despacho.js). Los dos modulos,
   api/_modulos/alertas.js y api/_modulos/keep-alive.js, exigen CRON_SECRET igual
   que antes: Authorization: Bearer <secreto>, o ?clave=<secreto> (se mantiene).
============================================================= */
module.exports = crearDespachador({
  alertas: () => require("./_modulos/alertas.js"),
  "keep-alive": () => require("./_modulos/keep-alive.js")
});
