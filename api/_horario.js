const { leerConfiguracion } = require("./_supabase.js");

/* =============================================================
   ESTADO DEL RESTAURANTE (abierto / cerrado)

   Es la unica fuente de verdad sobre si se puede pedir o no.
   La usa /api/estado.js (para pintar la pagina) y tambien
   /api/crear-pedido.js (para RECHAZAR pedidos fuera de horario).
   Validar solo en el navegador no sirve: cualquiera puede saltarse
   eso desde la consola.

   MULTI-RESTAURANTE: el horario, el interruptor "cerrado temporal", la zona
   horaria y la hora de corte de la jornada salen de la configuracion de UN
   restaurante (su fila en 'configuracion' y su fila en 'restaurantes').
============================================================= */

/* Colombia no cambia de hora en todo el ano (UTC-5 siempre), pero
   los servidores de Vercel corren en UTC. Se convierte de forma
   explicita para que el horario no se corra 5 horas. Es la zona por
   defecto; cada restaurante trae la suya (restaurantes.zona_horaria). */
const ZONA = "America/Bogota";

/* Una zona que Intl no conoce no debe tumbar el servicio: se usa la de Colombia. */
function zonaValida(zona) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zona });
    return zona;
  } catch (e) {
    return ZONA;
  }
}

/* Devuelve { diaSemana, minutos, hora, fecha } en la zona del restaurante.
   diaSemana: 0 = domingo ... 6 = sabado (igual que Date.getDay).
   fecha: "AAAA-MM-DD" del dia calendario local. */
function ahoraEnZona(zona, momento) {
  const ahora = momento || new Date();

  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: zonaValida(zona || ZONA),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
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
    hora: String(hora).padStart(2, "0") + ":" + String(minuto).padStart(2, "0"),
    fecha: `${buscar("year")}-${buscar("month")}-${buscar("day")}`
  };
}

/* Igual que antes: la hora de Colombia. */
function ahoraEnColombia(momento) {
  return ahoraEnZona(ZONA, momento);
}

/* "AAAA-MM-DD" del dia anterior. */
function diaAnterior(fecha) {
  const [a, m, d] = String(fecha).split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d - 1)).toISOString().slice(0, 10);
}

/* "22:00" -> 1320 */
function aMinutos(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

/* "11:00" -> "11:00 am" */
function aFormatoAmPm(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (h === 24 && m === 0) return "12:00 am (medianoche)";   // 24:00 = cierra a la medianoche, no es el mediodia
  const periodo = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${periodo}`;
}

/* Estado actual de UN restaurante.
   Recibe la fila de 'restaurantes' (id, zona_horaria, hora_corte_jornada).
   Devuelve:
     {
       abierto, motivo, mensaje,
       horarioHoy: { dia, abre, cierra, activo } | null,
       horarios: [...],           // los 7 dias, para el pie de pagina
       cerradoTemporal,
       jornada, horaCorteJornada  // la jornada a la que pertenece este momento
     }
   Si la configuracion no se puede leer, devuelve abierto:true para
   no bloquear las ventas por un problema de la base de datos.

   REGLA DEL HORARIO (la misma de horario-regla.js y del SQL 16b; docs seccion 19.7):
     * "cierra" = "24:00" cierra a la medianoche de ese mismo dia (00:00 a 24:00 = todo el dia).
     * Un horario que cruza la medianoche (cierra < abre, ej. 18:00 -> 02:00): el
       tramo de despues de las 00:00 pertenece a la jornada del dia anterior y
       llega hasta la hora de cierre, pero nunca mas alla de la hora de corte de
       la jornada (esa hora termina la jornada). Con un horario normal
       (11:00 -> 22:00) nada de esto cambia el resultado.
     * (Un cierre igual a la apertura ya no se puede guardar; si hay uno guardado de antes,
       sigue tratandose como cruce de medianoche, igual que siempre.) */
async function estadoRestaurante(restaurante, momento) {
  let config = null;

  try {
    config = await leerConfiguracion(restaurante.id);
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

  const { diaSemana, minutos, fecha } = ahoraEnZona(restaurante.zona_horaria, momento);
  const horarioHoy = config.horarios[diaSemana] || null;

  // La hora de corte que usa el panel (configuracion) manda; la del
  // restaurante es la copia de respaldo.
  const horaCorte = String(config.hora_corte_jornada || restaurante.hora_corte_jornada || "05:00").slice(0, 5);
  const corte = aMinutos(horaCorte);

  const base = {
    horarioHoy,
    horarios: config.horarios,
    cerradoTemporal: !!config.cerrado_temporal,
    jornada: minutos < corte ? diaAnterior(fecha) : fecha,
    horaCorteJornada: horaCorte
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

  // 2) Tramo de madrugada de un horario que cruza la medianoche (ayer abrio)
  const ayer = config.horarios[(diaSemana + 6) % 7] || null;
  if (ayer && ayer.activo !== false && aMinutos(ayer.cierra) <= aMinutos(ayer.abre)) {
    const limite = Math.min(aMinutos(ayer.cierra), corte);
    if (minutos < limite) {
      return Object.assign({}, base, { abierto: true, motivo: "en_horario", mensaje: null });
    }
  }

  // 3) Dia de descanso
  if (!horarioHoy || horarioHoy.activo === false) {
    return Object.assign({}, base, {
      abierto: false,
      motivo: "dia_cerrado",
      mensaje: config.mensaje_cerrado
        || "Hoy no abrimos. Escríbenos por WhatsApp para programar tu pedido."
    });
  }

  // 4) Horario del dia
  const abre = aMinutos(horarioHoy.abre);
  const cierra = aMinutos(horarioHoy.cierra);
  // Si cierra <= abre, el horario cruza la medianoche: abierto desde 'abre' hasta las 24:00
  const abierto = cierra > abre
    ? minutos >= abre && minutos < cierra
    : minutos >= abre;

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

module.exports = { estadoRestaurante, ahoraEnColombia, ahoraEnZona, aFormatoAmPm, aMinutos, ZONA };
