/* =============================================================
   AUTORIZACION DE LOS CRONS (/api/alertas y /api/keep-alive)

   Las dos rutas son publicas en internet, asi que exigen el secreto
   CRON_SECRET. Se acepta de dos maneras:

     Authorization: Bearer <secreto>   <- la forma preferida
     ?clave=<secreto>                  <- se mantiene por ahora para no
                                          romper los crons ya creados

   Por que es mejor la cabecera: una URL con la clave dentro queda
   escrita en los registros de Vercel, en el historial de cron-job.org
   y en cualquier proxy por el que pase. Una cabecera no.

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

/* true solo si el pedido trae el secreto correcto por cabecera o por
   ?clave=. Sin CRON_SECRET configurado, nadie entra. */
function autorizadoCron(req, env = process.env) {
  const secreto = env.CRON_SECRET;
  if (!secreto) return false;

  const cabecera = String((req.headers && req.headers["authorization"]) || "");
  const m = /^Bearer\s+(.*)$/i.exec(cabecera);
  const porCabecera = m ? iguales(m[1].trim(), secreto) : false;

  let clave = null;
  try {
    clave = new URL(req.url, "http://localhost").searchParams.get("clave");
  } catch (e) { /* URL rara: sin clave */ }
  const porUrl = clave !== null ? iguales(clave, secreto) : false;

  return porCabecera || porUrl;
}

module.exports = { autorizadoCron };
