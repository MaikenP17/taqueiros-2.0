/* =============================================================
   AUTORIZACION DE LOS CRONS (/api/alertas y /api/keep-alive)

   Las dos rutas son publicas en internet, asi que exigen el secreto
   CRON_SECRET, y SOLO por cabecera:

     Authorization: Bearer <secreto>

   El parametro ?clave=<secreto> YA NO SE ACEPTA (se retiro despues de
   confirmar que cron-job.org usa la cabecera): una URL con la clave dentro
   queda escrita en los registros de Vercel, en el historial de cron-job.org
   y en cualquier proxy por el que pase. Una peticion con ?clave= responde
   401 aunque la clave sea la correcta. (El cron de Vercel manda solo la
   cabecera Authorization: Bearer <CRON_SECRET>.)

   La comparacion es en tiempo constante (timingSafeEqual sobre el
   hash de cada lado, que asi siempre miden lo mismo). El secreto no
   se imprime en ningun registro desde aqui.
============================================================= */
const crypto = require("node:crypto");

function iguales(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* true solo si el pedido trae el secreto correcto en la cabecera
   Authorization: Bearer. Sin CRON_SECRET configurado, nadie entra. */
function autorizadoCron(req, env = process.env) {
  const secreto = env.CRON_SECRET;
  if (!secreto) return false;

  const cabecera = String((req.headers && req.headers["authorization"]) || "");
  const m = /^Bearer\s+(.*)$/i.exec(cabecera);
  return m ? iguales(m[1].trim(), secreto) : false;
}

module.exports = { autorizadoCron };
