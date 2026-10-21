"use strict";
/* Pruebas unitarias de datos-restaurante.js (el formulario "Datos de mi restaurante").
   Las funciones puras (campos, normalizar, validar, candidato, diferencias) se prueban sin navegador.
   La comparacion contra las reglas REALES de la base esta en pruebas/multirestaurante/datos-restaurante.mjs.
     node --test pruebas/datos-restaurante.test.js */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DR = require("../datos-restaurante.js");
const SQL15 = fs.readFileSync(path.join(__dirname, "..", "supabase", "15-datos-restaurante.sql"), "utf8");
const SQL13 = fs.readFileSync(path.join(__dirname, "..", "supabase", "13-endurecer.sql"), "utf8");

test("los 32 campos del formulario son exactamente los de guardar_datos_restaurante (SQL 15)", () => {
  const bloque = /c_campos constant text\[\] := array\[([\s\S]*?)\];/.exec(SQL15)[1];
  const delSql = bloque.match(/'[a-z_.]+'/g).map((s) => s.slice(1, -1)).sort();
  const delFormulario = DR.CAMPOS.map((c) => c.campo).sort();
  assert.equal(DR.CAMPOS.length, 32);
  assert.deepEqual(delFormulario, delSql);
});

test("el largo maximo de cada campo es el de las reglas de la base (SQL 13) y no hay campos repetidos", () => {
  const reglas = {};
  for (const m of SQL13.matchAll(/\('publico\.([a-z_.]+)',\s*'([a-z_]+)',\s*[a-z0-9:.\s]+?,\s*(\d+|null)\)/g)) reglas[m[1]] = { clase: m[2], maximo: m[3] === "null" ? null : Number(m[3]) };
  const nombres = new Set();
  for (const c of DR.CAMPOS) {
    assert.ok(!nombres.has(c.campo), "repetido " + c.campo);
    nombres.add(c.campo);
    if (c.campo === "nombre") { assert.equal(c.max, 120); continue; }
    const regla = reglas[c.campo];
    assert.ok(regla, "el campo " + c.campo + " no esta en las reglas de la base");
    if (regla.maximo !== null) assert.equal(c.max, regla.maximo, c.campo);
    if (c.tipo === "whatsapp") assert.equal(regla.clase, "whatsapp");
    if (c.tipo === "usuario") assert.equal(regla.clase, "usuario");
    if (c.tipo === "texto" || c.tipo === "area") assert.equal(regla.clase, "texto", c.campo);
  }
});

test("el dueno NO puede editar aqui marca, ubicacion, domicilio, llaves ni PWA: ningun campo del formulario apunta ahi", () => {
  for (const c of DR.CAMPOS) {
    assert.match(c.campo, /^(nombre|textos[.][a-z_.]+|contacto[.][a-z_]+)$/, c.campo);
    assert.doesNotMatch(c.campo, /marca|colores|logo|ubicacion|domicilio|wompi|pwa|plan|estado|vigen|modulo|slug/);
  }
});

test("normalizar: recorta, junta espacios y cambia los saltos de linea por espacios, avisando", () => {
  assert.deepEqual(DR.normalizar("textos.eslogan", "  Tacos   y  mas  "), { valor: "Tacos y mas", avisos: [] });
  const n = DR.normalizar("textos.eslogan", "linea uno\nlinea dos\r\ntres\tcuatro");
  assert.equal(n.valor, "linea uno linea dos tres cuatro");
  assert.equal(n.avisos.length, 1);
  assert.match(n.avisos[0], /saltos de línea/);
  const z = DR.normalizar("textos.eslogan", "a" + String.fromCharCode(0x200b) + "b" + String.fromCharCode(0x202e) + "c");
  assert.equal(z.valor, "abc");
  assert.match(z.avisos[0], /invisibles/);
  assert.equal(DR.normalizar("textos.eslogan", "").valor, "");
  assert.equal(DR.normalizar("textos.eslogan", null).valor, "");
});

test("normalizar: del WhatsApp se guardan solo los numeros; de Instagram y TikTok, el usuario sin @", () => {
  const w = DR.normalizar("contacto.whatsapp", " +57 (300) 123-4567 ");
  assert.equal(w.valor, "573001234567");
  assert.match(w.avisos[0], /solo los números: 573001234567/);
  assert.deepEqual(DR.normalizar("contacto.whatsapp", "573001234567"), { valor: "573001234567", avisos: [] });
  assert.equal(DR.normalizar("contacto.whatsapp", "no es un numero").valor, "no es un numero");   // no se inventa: la validacion lo rechaza
  const ig = DR.normalizar("contacto.instagram", "@mi.restaurante");
  assert.equal(ig.valor, "mi.restaurante");
  assert.match(ig.avisos[0], /@/);
  assert.equal(DR.normalizar("contacto.tiktok", "usuario").avisos.length, 0);
});

test("validarCampo: las reglas de la base (largo, HTML, controles, secretos, claves, whatsapp, usuario, nombre)", () => {
  const ok = (c, v) => assert.deepEqual(DR.validarCampo(c, v), [], c + " " + JSON.stringify(v).slice(0, 40));
  const mal = (c, v, patron) => { const e = DR.validarCampo(c, v); assert.ok(e.length > 0, c + " deberia fallar: " + JSON.stringify(v).slice(0, 40)); if (patron) assert.match(e.join(" "), patron); };
  ok("textos.eslogan", ""); ok("textos.eslogan", "Tacos 🌮 y más"); ok("textos.eslogan", "palabra ".repeat(50)); mal("textos.eslogan", "palabra ".repeat(50) + "x", /400/);
  ok("textos.seguimiento.frase_nuevo", "a ".repeat(100).trim()); mal("textos.seguimiento.frase_nuevo", "a ".repeat(101), /200/);
  mal("textos.eslogan", "<b>hola</b>", /HTML/); mal("textos.eslogan", "a>b", /HTML/);
  mal("textos.eslogan", "dos\nlineas", /saltos/); mal("textos.eslogan", "a" + String.fromCharCode(0x200b), /invisibles/);
  mal("textos.eslogan", "prv_test_abcdefghijk", /secreto/); mal("textos.eslogan", "sb_secret_x", /secreto/); mal("textos.eslogan", "test_integrity_x", /secreto/);
  mal("textos.eslogan", "eyJhbGciOiJIUzI1.NiIsInR5cCI6", /secreto/); mal("textos.eslogan", "mi apikey es", /secreto/); mal("textos.eslogan", "-----BEGIN KEY", /secreto/);
  mal("textos.eslogan", "A".repeat(32), /clave/); ok("textos.eslogan", "A".repeat(31));
  ok("contacto.whatsapp", "573001234567"); mal("contacto.whatsapp", "12", /8 a 15/); mal("contacto.whatsapp", "1".repeat(16), /8 a 15/); mal("contacto.whatsapp", "abc12345678", /8 a 15/);
  ok("contacto.instagram", "mi.restaurante_1"); ok("contacto.instagram", "@mi"); mal("contacto.instagram", "con espacios", /Usuario/); mal("contacto.instagram", "a/b", /Usuario/); mal("contacto.tiktok", "a".repeat(61), /Usuario|largo/);
  ok("contacto.ciudad", "Cúcuta"); mal("contacto.ciudad", "c".repeat(81), /80/);
  ok("nombre", "Los Taqueiros"); mal("nombre", "", /vacío/); mal("nombre", "n".repeat(121), /120/); mal("nombre", "<script>", /< y >/); mal("nombre", "a\u0007b", /control/);
  assert.ok(DR.validarCampo("marca.logo", "x").length > 0, "un campo fuera de la lista no se valida como bueno");
});

test("el largo cuenta caracteres, no unidades UTF-16 (un emoji cuenta uno, como en Postgres)", () => {
  assert.equal(DR.largo("🌮"), 1);
  assert.deepEqual(DR.validarCampo("textos.banner_abierto_icono", "🌮".repeat(400)), []);
  assert.ok(DR.validarCampo("textos.banner_abierto_icono", "🌮".repeat(401)).length > 0);
});

test("candidato: cambia SOLO los campos pedidos de la config vigente y no pierde nada mas", () => {
  const config = {
    ubicacion: { lat: 7.9, lng: -72.5 }, domicilio: { factor_recorrido: 1.3 },
    publico: { marca: { logo: "Recursos/logo.png", colores: { primario: "#112233" } }, wompi: { llave_publica_test: "pub_test_abcdefghijk" }, pwa: { nombre: "Panel" },
      textos: { eslogan: "viejo", tagline: "queda", seguimiento: { frase_nuevo: "queda tambien" } }, contacto: { telefono: "1", ciudad: "Cúcuta" } }
  };
  const copia = JSON.parse(JSON.stringify(config));
  const c = DR.candidato(config, { "textos.eslogan": "nuevo", "contacto.ciudad": "", "textos.seguimiento.frase_camino": "ya va", "contacto.instagram": "mi_ig" });
  assert.deepEqual(config, copia, "no muta la config original");
  assert.equal(c.publico.textos.eslogan, "nuevo");
  assert.equal(c.publico.textos.tagline, "queda");
  assert.equal(c.publico.textos.seguimiento.frase_nuevo, "queda tambien");
  assert.equal(c.publico.textos.seguimiento.frase_camino, "ya va");
  assert.ok(!("ciudad" in c.publico.contacto), "vacio borra");
  assert.equal(c.publico.contacto.instagram, "mi_ig");
  assert.deepEqual(c.publico.marca, config.publico.marca);
  assert.deepEqual(c.publico.wompi, config.publico.wompi);
  assert.deepEqual(c.ubicacion, config.ubicacion);
  assert.deepEqual(c.domicilio, config.domicilio);
  // sobre una config vacia crea solo lo necesario
  assert.deepEqual(DR.candidato({}, { "contacto.ciudad": "Cúcuta" }), { publico: { contacto: { ciudad: "Cúcuta" } } });
  assert.deepEqual(DR.candidato(null, { "textos.seguimiento.frase_nuevo": "x" }), { publico: { textos: { seguimiento: { frase_nuevo: "x" } } } });
  // el nombre no es parte de la config
  assert.deepEqual(DR.candidato({}, { nombre: "X" }), {});
});

test("diferencias: solo lo que cambio, con el valor que el usuario vio ('antes'); vacio = null", () => {
  const original = { nombre: "Los Taqueiros", config: { publico: { textos: { eslogan: "viejo", tagline: "igual" }, contacto: { ciudad: "Cúcuta" } } } };
  const valores = { nombre: "Los Taqueiros", "textos.eslogan": "nuevo", "textos.tagline": "igual", "contacto.ciudad": "", "contacto.telefono": "123", "textos.pie_final": "" };
  assert.deepEqual(DR.diferencias(original, valores), [
    { campo: "contacto.ciudad", antes: "Cúcuta", despues: null },
    { campo: "contacto.telefono", antes: null, despues: "123" },
    { campo: "textos.eslogan", antes: "viejo", despues: "nuevo" }
  ].sort((a, b) => DR.CAMPOS.findIndex((x) => x.campo === a.campo) - DR.CAMPOS.findIndex((x) => x.campo === b.campo)));
  assert.deepEqual(DR.diferencias(original, { nombre: "Los Taqueiros" }), []);
  assert.deepEqual(DR.diferencias(original, { "campo.inventado": "x" }), [], "un campo fuera de la lista nunca se envia");
});

test("leer: texto de la config o vacio (nunca algo que no sea texto)", () => {
  const d = { nombre: "N", config: { publico: { textos: { eslogan: 5, tagline: "t" }, contacto: null } } };
  assert.equal(DR.leer(d, "textos.eslogan"), "");
  assert.equal(DR.leer(d, "textos.tagline"), "t");
  assert.equal(DR.leer(d, "contacto.ciudad"), "");
  assert.equal(DR.leer({ nombre: 3 }, "nombre"), "");
  assert.equal(DR.leer({}, "textos.seguimiento.frase_nuevo"), "");
});

test("interpretarErrorBase: 'ruta: mensaje' de la base -> el campo del formulario y el texto", () => {
  assert.deepEqual(DR.interpretarErrorBase("publico.textos.eslogan: demasiado largo (maximo 400 caracteres)"),
    { campo: "textos.eslogan", ruta: "publico.textos.eslogan", mensaje: "demasiado largo (maximo 400 caracteres)" });
  assert.equal(DR.interpretarErrorBase("publico.contacto.whatsapp: numero no valido").campo, "contacto.whatsapp");
  assert.equal(DR.interpretarErrorBase("publico.textos.seguimiento.frase_nuevo: x").campo, "textos.seguimiento.frase_nuevo");
  assert.equal(DR.interpretarErrorBase("publico.marca.logo: URL no permitida").campo, null);
  assert.equal(DR.interpretarErrorBase("algo sin dos puntos").campo, null);
});

test("el archivo no usa innerHTML, insertAdjacentHTML, document.write ni eval (todo entra con textContent o .value)", () => {
  const crudo = fs.readFileSync(path.join(__dirname, "..", "datos-restaurante.js"), "utf8");
  // sin comentarios (se recorre el texto: bloques /* ... */ y lineas que empiezan por //)
  let src = "";
  for (let i = 0; i < crudo.length;) {
    if (crudo.startsWith("/*", i)) { const f = crudo.indexOf("*/", i + 2); i = f < 0 ? crudo.length : f + 2; continue; }
    src += crudo[i++];
  }
  src = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const prohibido of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
    assert.ok(!src.includes(prohibido), "no deberia usar " + prohibido);
  }
});
