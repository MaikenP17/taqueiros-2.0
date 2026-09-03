const { leerConfiguracion } = require("./_supabase.js");

/* =============================================================
   ESTADO DEL RESTAURANTE (abierto / cerrado)

   Es la unica fuente de verdad sobre si se puede pedir o no.
   La usa /api/estado.js (para pintar la pagina) y tambien
   /api/crear-pedido.js (para RECHAZAR pedidos fuera de horario).
   Validar solo en el navegador no sirve: cualquiera puede saltarse
   eso desde la consola.
============================================================= */

/* Colombia no cambia de hora en todo el ano (UTC-5 siempre), pero
   los servidores de Vercel corren en UTC. Se convierte de forma
   explicita para que el horario no se corra 5 horas. */
const ZONA = "America/Bogota";

/* Devuelve { diaSemana, minutos, hora } en hora de Colombia.
   diaSemana: 0 = domingo ... 6 = sabado (igual que Date.getDay). */
function ahoraEnColombia() {
  const ahora = new Date();

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONA,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(ahora);

  const buscar = (tipo) => {
    const parte = partes.find((x) => x.type === tipo);
    return parte ? parte.value : null;
  };

  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const diaSemana = DIAS[buscar("weekday")];

  let hora = parseInt(buscar("hour"), 10);
  const minuto = parseInt(buscar("minute"), 10);
  if (hora === 24) hora = 0; // algunos runtimes devuelven 24 a medianoche

  return {
    diaSemana,
    minutos: hora * 60 + minuto,
    hora: String(hora).padStart(2, "0") + ":" + String(minuto).padStart(2, "0")
  };
}

/* "22:00" -> 1320 */
function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/* "11:00" -> "11:00 am" */
function aFormatoAmPm(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  const periodo = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${periodo}`;
}

/* Estado actual del restaurante.
   Devuelve:
     {
       abierto, motivo, mensaje,
       horarioHoy: { dia, abre, cierra, activo } | null,
       horarios: [...],           // los 7 dias, para el pie de pagina
       cerradoTemporal
     }
   Si la configuracion no se puede leer, devuelve abierto:true para
   no bloquear las ventas por un problema de la base de datos. */
async function estadoRestaurante() {
  let config = null;

  try {
    config = await leerConfiguracion();
  } catch (err) {
    console.error("[Horario] No se pudo leer la configuracion:", err.message);
  }

  // Sin configuracion: se asume abierto (mejor vender que bloquear
  // por un fallo tecnico). El panel avisara si algo anda mal.
  if (!config || !Array.isArray(config.horarios)) {
    return {
      abierto: true,
      motivo: "sin_configuracion",
      mensaje: null,
      horarioHoy: null,
      horarios: [],
      cerradoTemporal: false
    };
  }

  const { diaSemana, minutos } = ahoraEnColombia();
  const horarioHoy = config.horarios[diaSemana] || null;

  const base = {
    horarioHoy,
    horarios: config.horarios,
    cerradoTemporal: !!config.cerrado_temporal
  };

  // 1) El interruptor manual gana sobre cualquier horario
  if (config.cerrado_temporal) {
    return Object.assign({}, base, {
      abierto: false,
      motivo: "cerrado_temporal",
      mensaje: config.mensaje_cerrado
        || "Cerramos por hoy. Escríbenos por WhatsApp y te contamos cuándo volvemos."
    });
  }

  // 2) Dia de descanso
  if (!horarioHoy || horarioHoy.activo === false) {
    return Object.assign({}, base, {
      abierto: false,
      motivo: "dia_cerrado",
      mensaje: config.mensaje_cerrado
        || "Hoy no abrimos. Escríbenos por WhatsApp para programar tu pedido."
    });
  }

  // 3) Horario del dia
  const abre = aMinutos(horarioHoy.abre);
  const cierra = aMinutos(horarioHoy.cierra);
  const abierto = minutos >= abre && minutos < cierra;

  if (abierto) {
    return Object.assign({}, base, { abierto: true, motivo: "en_horario", mensaje: null });
  }

  const mensaje = config.mensaje_cerrado || (minutos < abre
    ? `Estamos cerrados · Abrimos hoy a las ${aFormatoAmPm(horarioHoy.abre)}`
    : `Ya cerramos por hoy · Mañana abrimos a las ${aFormatoAmPm(horarioHoy.abre)}`);

  return Object.assign({}, base, {
    abierto: false,
    motivo: minutos < abre ? "aun_no_abre" : "ya_cerro",
    mensaje
  });
}

module.exports = { estadoRestaurante, ahoraEnColombia, aFormatoAmPm, aMinutos, ZONA };
