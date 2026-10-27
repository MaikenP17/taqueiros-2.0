const {
  buscarPedidoPorReferencia, marcarReembolsado, consultarTabla, esSuperadmin
} = require("./_supabase.js");
const { usuarioDeSolicitud } = require("./_sesion.js");
const { exigirRestaurante } = require("./_restaurante.js");

/* =============================================================
   REGISTRAR QUE UN PEDIDO CANCELADO FUE REEMBOLSADO

   Cuando se cancela un pedido que el cliente ya pago, el dinero se devuelve
   por fuera (desde el panel de Wompi). Este endpoint deja constancia en
   pedidos.reembolsado_en. Un cliente no puede escribir esa columna (la
   bloquea un trigger de la base); solo el servidor.

   QUIEN PUEDE:
     * El DUENO del restaurante de este host (sesion del panel: cabecera
       Authorization: Bearer <JWT de la sesion>), o un superadmin.
       Un cajero, la cocina o alguien sin membresia reciben 403.
     * El propio servidor, llamando a registrarReembolso(rid, referencia)
       desde otro modulo.

   QUE EXIGE DEL PEDIDO: ser de este restaurante, estar CANCELADO, tener el pago
   APROBADO y no tener ya fecha de reembolso. Llamarlo dos veces no cambia la
   fecha: responde ok con "yaRegistrado".

   Cuerpo:  { "referencia": "PED-..." }   (los pedidos anteriores al rebrand tienen "TAQ-...")
   Los endpoints internos del panel NO se bloquean por suspension: un
   restaurante suspendido tiene que poder registrar sus reembolsos.
============================================================= */

/* Logica comun (la usa el endpoint y puede usarla el servidor). */
async function registrarReembolso(rid, referencia, ahora) {
  const ref = String(referencia || "").trim();
  if (!ref) return { ok: false, codigo: 400, error: "Falta la referencia del pedido" };

  const pedido = await buscarPedidoPorReferencia(rid, ref);
  if (!pedido) return { ok: false, codigo: 404, error: "Pedido no encontrado" };

  if (pedido.reembolsado_en) {
    return { ok: true, yaRegistrado: true, reembolsado_en: pedido.reembolsado_en };
  }
  if (pedido.estado !== "cancelado" || pedido.estado_pago !== "aprobado") {
    return { ok: false, codigo: 409, error: "Solo se puede registrar el reembolso de un pedido cancelado que ya se había cobrado" };
  }

  const fila = await marcarReembolsado(rid, ref, ahora);
  if (!fila) {
    // Otra llamada se adelanto o el pedido cambio justo ahora: se vuelve a mirar
    const actual = await buscarPedidoPorReferencia(rid, ref);
    if (actual && actual.reembolsado_en) {
      return { ok: true, yaRegistrado: true, reembolsado_en: actual.reembolsado_en };
    }
    return { ok: false, codigo: 409, error: "El pedido ya no se puede marcar como reembolsado" };
  }
  return { ok: true, yaRegistrado: false, reembolsado_en: fila.reembolsado_en };
}

/* true solo si el JWT es de un dueno ACTIVO de ese restaurante o de un superadmin. */
async function esDuenoOSuperadmin(rid, usuario) {
  const filas = await consultarTabla(rid, "miembros",
    `user_id=eq.${usuario.id}&activo=is.true&rol=eq.dueno&select=rol&limit=1`);
  if (filas.length) return true;
  return esSuperadmin(usuario.id);
}

async function manejador(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const restaurante = await exigirRestaurante(req, res);
  if (!restaurante) return;

  try {
    const usuario = await usuarioDeSolicitud(req);

    if (!usuario) {
      res.status(401).json({ error: "Inicia sesión para continuar" });
      return;
    }
    // El restaurante es el del host; la autorizacion se comprueba CONTRA ESE
    // restaurante (ser dueno de otro restaurante no sirve).
    if (!(await esDuenoOSuperadmin(restaurante.id, usuario))) {
      res.status(403).json({ error: "Solo el dueño del restaurante puede registrar reembolsos" });
      return;
    }

    const { referencia } = req.body || {};
    const r = await registrarReembolso(restaurante.id, referencia);
    if (!r.ok) {
      res.status(r.codigo).json({ error: r.error });
      return;
    }
    res.status(200).json({ ok: true, yaRegistrado: r.yaRegistrado, reembolsado_en: r.reembolsado_en });
  } catch (err) {
    console.error("[Reembolso] Error:", err.message);
    res.status(500).json({ error: "No se pudo registrar el reembolso" });
  }
}

module.exports = manejador;
module.exports.registrarReembolso = registrarReembolso;
