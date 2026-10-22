/* =============================================================
   HORARIO: LA REGLA DE LAS HORAS DE ABRIR Y CERRAR (una sola copia)

   La usan el panel (panel.html, al guardar el horario) y las pruebas; la base
   (supabase/16b-horario.sql) y el servidor (api/_horario.js) aplican la MISMA regla, y una
   prueba compara los tres con miles de combinaciones. Se carga como script comun en el
   navegador (window.HorarioRegla) y con require() en Node.

   REGLA (docs/multirestaurante.md, seccion 19.7):
     1. "abre" es una hora HH:MM de 00:00 a 23:59.
     2. "cierra" es una hora HH:MM de 00:00 a 23:59, o "24:00".
     3. "24:00" = cierra a la MEDIANOCHE, al terminar ese mismo dia (las 12:00 a. m. del dia
        siguiente). 00:00 a 24:00 es "abierto todo el dia".
     4. Si "cierra" es MENOR que "abre" (por ejemplo 18:00 a 02:00) el horario cruza la
        medianoche: la madrugada cuenta como parte de la jornada del dia anterior. Esa
        madrugada llega hasta la hora de cierre, pero NUNCA mas alla de la hora de corte de
        la jornada (05:00 por defecto: ahi termina la jornada), asi que un cierre de
        madrugada no puede ser posterior a esa hora.
     5. "cierra" IGUAL a "abre" en un dia activo no vale (no se sabe si es cerrado o 24 horas).
        Para abrir todo el dia se usa 00:00 a 24:00.
     6. Un dia desmarcado ("activo": false) esta cerrado: sus horas no se revisan.
============================================================= */
(function (raiz, fabrica) {
  var regla = fabrica();
  if (typeof module === "object" && module.exports) module.exports = regla;
  else raiz.HorarioRegla = regla;
})(typeof self !== "undefined" ? self : this, function () {
  var HORA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  var CORTE_POR_DEFECTO = "05:00";

  /* "HH:MM" -> minutos desde las 00:00 ("24:00" = 1440), o null si no es una hora valida de abrir/cerrar.
     Una hora de corte llega como "05:00" o "05:00:00": se toman los primeros 5 caracteres. */
  function minutos(v, permitir24) {
    if (typeof v !== "string") return null;
    if (permitir24 && v === "24:00") return 1440;
    if (!HORA.test(v)) return null;
    return Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  }

  function horaDeCorte(horaCorte) {
    var m = minutos(typeof horaCorte === "string" ? horaCorte.slice(0, 5) : CORTE_POR_DEFECTO, false);
    return m === null ? minutos(CORTE_POR_DEFECTO, false) : m;
  }

  /* Revisa UN dia { abre, cierra, activo }. Devuelve null si esta bien, o { codigo, mensaje } con el
     motivo en espanol (para decirselo a quien edita el horario). */
  function validarDia(dia, horaCorte) {
    var d = dia || {};
    if (d.activo === false) return null;
    var abre = minutos(d.abre, false);
    var cierra = minutos(d.cierra, true);
    if (abre === null) return { codigo: "abre", mensaje: "la hora de apertura no es valida (de 00:00 a 23:59)" };
    if (cierra === null) return { codigo: "cierra", mensaje: "la hora de cierre no es valida (de 00:00 a 23:59, o 24:00 para cerrar a la medianoche)" };
    if (cierra === abre) {
      return { codigo: "igual", mensaje: "la hora de cierre no puede ser igual a la de apertura. Para abrir todo el dia elige de 00:00 a 24:00" };
    }
    if (cierra < abre && cierra > horaDeCorte(horaCorte)) {
      var corte = (typeof horaCorte === "string" && minutos(horaCorte.slice(0, 5), false) !== null) ? horaCorte.slice(0, 5) : CORTE_POR_DEFECTO;
      return {
        codigo: "pasa_del_corte",
        mensaje: "si cierras despues de la medianoche, la hora de cierre no puede pasar de las " + corte +
          " (a esa hora termina la jornada). Para cerrar a la medianoche elige 24:00"
      };
    }
    return null;
  }

  /* "13:05" -> "1:05 p.m.", "00:00" -> "12:00 a.m.", "24:00" -> "12:00 a.m. (medianoche)". */
  function formatearHora(hhmm) {
    var partes = String(hhmm).split(":");
    var h = Number(partes[0]);
    var m = Number(partes[1]);
    if (!(h >= 0 && h <= 24) || !(m >= 0 && m <= 59) || isNaN(h) || isNaN(m)) return String(hhmm);
    if (h === 24) return m === 0 ? "12:00 a.m. (medianoche)" : String(hhmm);
    var periodo = h >= 12 ? "p.m." : "a.m.";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + periodo;
  }

  return {
    CORTE_POR_DEFECTO: CORTE_POR_DEFECTO,
    minutos: minutos,
    validarDia: validarDia,
    formatearHora: formatearHora
  };
});
