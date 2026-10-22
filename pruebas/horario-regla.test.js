/* =============================================================
   PRUEBAS DE LA REGLA DEL HORARIO (24:00 y medianoche)  -  horario-regla.js

   La misma regla vive en cuatro sitios: horario-regla.js (panel), supabase/16b-horario.sql (base),
   api/_horario.js (servidor) e index.html (como se muestra). Aqui: la regla sola, el formato de las horas
   (pagina publica y servidor igual que la regla) y que el SERVIDOR abra y cierre exactamente cuando la regla
   dice, en una rejilla de combinaciones y de minutos. La comparacion con la BASE esta en
   pruebas/multirestaurante/sql16.mjs.

   USO:   node --test pruebas/horario-regla.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HR = require("../horario-regla.js");
const RAIZ = path.join(__dirname, "..");

/* ---- _horario.js sin red: se sustituye el acceso a la base por una configuracion fija ---- */
let CONFIG = null;
const rutaSupabase = require.resolve("../api/_supabase.js");
require.cache[rutaSupabase] = {
  id: rutaSupabase, filename: rutaSupabase, loaded: true,
  exports: { leerConfiguracion: async () => CONFIG }
};
const horario = require("../api/_horario.js");

const dia = (abre, cierra, activo = true) => ({ dia: "D", abre, cierra, activo });
const sieteDias = (abre, cierra) => [0, 1, 2, 3, 4, 5, 6].map(() => dia(abre, cierra));

test("validarDia: lo que vale", () => {
  for (const [abre, cierra] of [["11:00", "22:00"], ["00:00", "24:00"], ["11:00", "24:00"], ["18:00", "02:00"], ["18:00", "05:00"], ["18:00", "00:00"], ["23:59", "00:01"], ["00:00", "23:59"]]) {
    assert.equal(HR.validarDia(dia(abre, cierra), "05:00"), null, `${abre}-${cierra}`);
  }
});

test("validarDia: un dia desmarcado no se revisa (ni siquiera con horas iguales o mal escritas)", () => {
  assert.equal(HR.validarDia(dia("10:00", "10:00", false), "05:00"), null);
  assert.equal(HR.validarDia(dia("25:00", "xx", false), "05:00"), null);
});

test("validarDia: cierre igual a la apertura no vale en un dia activo (para 24 horas, 00:00 a 24:00)", () => {
  for (const h of ["00:00", "11:00", "23:59"]) {
    const r = HR.validarDia(dia(h, h), "05:00");
    assert.ok(r && r.codigo === "igual", h);
    assert.match(r.mensaje, /00:00 a 24:00/);
  }
});

test("validarDia: un cierre de madrugada no puede pasar de la hora de corte", () => {
  const r = HR.validarDia(dia("18:00", "05:01"), "05:00");
  assert.ok(r && r.codigo === "pasa_del_corte");
  assert.match(r.mensaje, /05:00/);
  assert.match(r.mensaje, /24:00/);
  assert.equal(HR.validarDia(dia("18:00", "06:00"), "07:00"), null, "con otro corte, el mismo cierre vale");
  assert.ok(HR.validarDia(dia("18:00", "03:00"), "02:00"), "bajando el corte, deja de valer");
  // la hora de corte puede llegar como time de Postgres (HH:MM:SS) o venir rara: cae en 05:00
  assert.equal(HR.validarDia(dia("18:00", "05:00"), "05:00:00"), null);
  assert.equal(HR.validarDia(dia("18:00", "05:00"), undefined), null);
  assert.ok(HR.validarDia(dia("18:00", "05:30"), "basura"));
});

test("validarDia: horas mal escritas", () => {
  for (const [abre, cierra, codigo] of [
    ["9:30", "22:00", "abre"], ["24:00", "22:00", "abre"], ["11:60", "22:00", "abre"], [null, "22:00", "abre"], [1100, "22:00", "abre"],
    ["11:00", "24:30", "cierra"], ["11:00", "25:00", "cierra"], ["11:00", "", "cierra"], ["11:00", null, "cierra"], ["11:00", "22", "cierra"]
  ]) {
    const r = HR.validarDia(dia(abre, cierra), "05:00");
    assert.ok(r && r.codigo === codigo, `${abre}-${cierra}: ${JSON.stringify(r)}`);
  }
});

test("formatearHora: 24:00 es la medianoche, no el mediodia", () => {
  const casos = { "00:00": "12:00 a.m.", "00:05": "12:05 a.m.", "01:00": "1:00 a.m.", "11:59": "11:59 a.m.", "12:00": "12:00 p.m.",
    "12:30": "12:30 p.m.", "13:05": "1:05 p.m.", "22:00": "10:00 p.m.", "23:59": "11:59 p.m.", "24:00": "12:00 a.m. (medianoche)" };
  for (const [entrada, salida] of Object.entries(casos)) assert.equal(HR.formatearHora(entrada), salida, entrada);
  assert.equal(HR.formatearHora("rara"), "rara");
});

test("index.html: su formatHour da lo mismo que la regla para las 1441 horas del dia (incluido 24:00)", () => {
  const html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
  const m = /function formatHour\(hhmm\)\{[\s\S]*?\n\}/.exec(html);
  assert.ok(m, "no encuentro formatHour en index.html");
  const formatHour = new Function(m[0] + "; return formatHour;")();
  for (let min = 0; min <= 1440; min++) {
    const hhmm = String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
    if (hhmm > "24:00") continue;
    assert.equal(formatHour(hhmm), HR.formatearHora(hhmm), hhmm);
  }
});

test("servidor: aFormatoAmPm trata 24:00 como medianoche (los demas, como siempre)", () => {
  assert.equal(horario.aFormatoAmPm("24:00"), "12:00 am (medianoche)");
  assert.equal(horario.aFormatoAmPm("00:00"), "12:00 am");
  assert.equal(horario.aFormatoAmPm("12:00"), "12:00 pm");
  assert.equal(horario.aFormatoAmPm("11:00"), "11:00 am");
  assert.equal(horario.aFormatoAmPm("22:30"), "10:30 pm");
});

test("panel.html usa la regla compartida y la casilla 24:00", () => {
  const panel = fs.readFileSync(path.join(RAIZ, "panel.html"), "utf8");
  assert.match(panel, /<script src="horario-regla\.js\?v=1"><\/script>/);
  assert.match(panel, /HorarioRegla\.validarDia/);
  assert.match(panel, /class="chk-24"/);
  assert.match(panel, /"24:00"/);
  // el panel ya no usa la comparacion de texto que convertia 24:00 en 22:00 o rechazaba la medianoche
  assert.doesNotMatch(panel, /h\.abre >= h\.cierra/);
  assert.doesNotMatch(panel, /\|\| "22:00",\s*\n\s*activo/);
});

/* ---- el SERVIDOR abre y cierra exactamente cuando la regla dice ---- */
const MOMENTO = (minutoDelDia) => new Date(Date.UTC(2026, 9, 21, 5, 0) + minutoDelDia * 60000);   // 21 de octubre de 2026, Bogota = UTC-5

test("servidor: para toda combinacion que la regla acepta, abre y cierra en los minutos que la regla describe", async () => {
  const abres = ["00:00", "00:30", "05:00", "11:00", "12:30", "18:00", "23:59"];
  const cierras = ["00:00", "00:01", "02:00", "05:00", "11:00", "13:00", "22:00", "23:59", "24:00"];
  let combinaciones = 0;
  let minutosRevisados = 0;
  for (const abre of abres) for (const cierra of cierras) {
    if (HR.validarDia(dia(abre, cierra), "05:00")) continue;
    combinaciones++;
    CONFIG = { horarios: sieteDias(abre, cierra), cerrado_temporal: false, mensaje_cerrado: null, hora_corte_jornada: "05:00:00" };
    const a = HR.minutos(abre, false);
    const c = HR.minutos(cierra, true);
    for (let m = 0; m < 1440; m += 15) {
      const esperado = c > a ? (m >= a && m < c) : (m >= a || m < c);
      const real = (await horario.estadoRestaurante({ id: "x", zona_horaria: "America/Bogota", hora_corte_jornada: "05:00" }, MOMENTO(m))).abierto;
      minutosRevisados++;
      assert.equal(real, esperado, `${abre}-${cierra} a las ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
  }
  assert.ok(combinaciones >= 40, "pocas combinaciones: " + combinaciones);
  assert.ok(minutosRevisados >= 3800);
});

test("servidor: 24:00 y 00:00-24:00 abren todo el dia; el cierre de 24:00 no deja abierto el minuto siguiente de otro dia desmarcado", async () => {
  CONFIG = { horarios: sieteDias("00:00", "24:00"), cerrado_temporal: false, hora_corte_jornada: "05:00:00" };
  for (let m = 0; m < 1440; m += 5) assert.equal((await horario.estadoRestaurante({ id: "x", zona_horaria: "America/Bogota" }, MOMENTO(m))).abierto, true, String(m));
  // miercoles 21/oct/2026 abre de 11:00 a 24:00; el jueves esta desmarcado: a las 00:30 del jueves (= 24:30 del miercoles) ya cerro
  const h = sieteDias("11:00", "24:00");
  h[4] = dia("11:00", "22:00", false);   // jueves cerrado
  CONFIG = { horarios: h, cerrado_temporal: false, hora_corte_jornada: "05:00:00" };
  assert.equal((await horario.estadoRestaurante({ id: "x", zona_horaria: "America/Bogota" }, MOMENTO(23 * 60 + 59))).abierto, true);
  const despues = await horario.estadoRestaurante({ id: "x", zona_horaria: "America/Bogota" }, MOMENTO(24 * 60 + 30));
  assert.equal(despues.abierto, false);
});

test("servidor: un cierre de madrugada guardado de antes que pasa de la hora de corte (06:00) se corta a las 05:00, como siempre", async () => {
  CONFIG = { horarios: sieteDias("18:00", "06:00"), cerrado_temporal: false, hora_corte_jornada: "05:00:00" };
  const r = (m) => horario.estadoRestaurante({ id: "x", zona_horaria: "America/Bogota" }, MOMENTO(m));
  assert.equal((await r(4 * 60 + 59)).abierto, true);
  assert.equal((await r(5 * 60)).abierto, false);
  assert.equal((await r(5 * 60 + 30)).abierto, false);
});
