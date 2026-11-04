/* =============================================================
   PRUEBAS UNITARIAS DE LA MFA (sin red)

     1. TOTP (pruebas/multirestaurante/totp.js) contra los vectores del RFC 6238, Apendice B, para SHA-1, SHA-256 y SHA-512.
        Es lo que las pruebas contra la base REAL usan para sacar el codigo de 6 digitos de un secreto base32.
     2. nivelDeGarantia (api/_sesion.js): el aal se lee SOLO de la carga de un token ya validado, y ante cualquier duda es aal1.
     3. tieneTotpVerificado (api/_sesion.js): ademas, el usuario tiene que tener AHORA un factor TOTP verificado (docs 23.13, R1).

   USO:   node --test pruebas/mfa.test.js
============================================================= */
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("./multirestaurante/totp.js");
const { nivelDeGarantia, tokenDeSolicitud, tieneTotpVerificado } = require("../api/_sesion.js");

/* ---------- 1. TOTP: vectores del RFC 6238 ---------- */
const SEMILLA_SHA1 = Buffer.from("12345678901234567890");
const SEMILLA_SHA256 = Buffer.from("12345678901234567890123456789012");
const SEMILLA_SHA512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");
const VECTORES = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"]
];
for (const [segundos, sha1, sha256, sha512] of VECTORES) {
  test(`RFC 6238: T=${segundos} da ${sha1} (SHA-1), ${sha256} (SHA-256) y ${sha512} (SHA-512)`, () => {
    const ms = segundos * 1000;
    assert.equal(T.codigoTotp(null, ms, { digitos: 8, algoritmo: "sha1", secretoCrudo: SEMILLA_SHA1 }), sha1);
    assert.equal(T.codigoTotp(null, ms, { digitos: 8, algoritmo: "sha256", secretoCrudo: SEMILLA_SHA256 }), sha256);
    assert.equal(T.codigoTotp(null, ms, { digitos: 8, algoritmo: "sha512", secretoCrudo: SEMILLA_SHA512 }), sha512);
  });
}

test("base32: el secreto del RFC en base32 decodifica a los mismos bytes y da el codigo de 6 digitos de Supabase", () => {
  const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";   // "12345678901234567890"
  assert.deepEqual(T.base32Decodificar(b32), SEMILLA_SHA1);
  assert.equal(T.codigoTotp(b32, 59 * 1000), "287082");                 // los 6 ultimos digitos de 94287082
  assert.deepEqual(T.base32Decodificar("gezd gnbv-GY3TQOJQ=="), T.base32Decodificar("GEZDGNBVGY3TQOJQ"));
  assert.throws(() => T.base32Decodificar("no es base32 !!"), /base32/);
});

test("codigoValido: acepta el paso actual y los vecinos, rechaza lo demas y lo que no son 6 digitos", () => {
  const b32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const ahora = 1700000000000;
  const actual = T.codigoTotp(b32, ahora);
  assert.equal(T.codigoValido(b32, actual, ahora), true);
  assert.equal(T.codigoValido(b32, T.codigoTotp(b32, ahora, { ventana: -1 }), ahora), true);
  assert.equal(T.codigoValido(b32, T.codigoTotp(b32, ahora, { ventana: 1 }), ahora), true);
  assert.equal(T.codigoValido(b32, T.codigoTotp(b32, ahora, { ventana: 3 }), ahora), false);
  assert.equal(T.codigoValido(b32, "12345", ahora), false);
  assert.equal(T.codigoValido(b32, "abcdef", ahora), false);
  assert.equal(T.codigoValido(b32, undefined, ahora), false);
});

test("secretoAleatorio: 32 caracteres base32, distintos cada vez, y decodifican a 20 bytes", () => {
  const a = T.secretoAleatorio();
  const b = T.secretoAleatorio();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, b);
  assert.equal(T.base32Decodificar(a).length, 20);
});

/* ---------- 2. nivelDeGarantia ---------- */
const ID = "11111111-2222-4333-8444-555555555555";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (carga) => b64({ alg: "ES256", typ: "JWT" }) + "." + (typeof carga === "string" ? carga : b64(carga)) + ".firma";
const AAL2 = { sub: ID, aal: "aal2", amr: [{ method: "totp", timestamp: 1 }, { method: "password", timestamp: 0 }] };

test("aal2 solo con sub = el id validado, aal exactamente 'aal2' y un metodo TOTP en amr", () => {
  assert.equal(nivelDeGarantia(token(AAL2), ID), "aal2");
  assert.equal(nivelDeGarantia(token({ ...AAL2, amr: [{ method: "mfa/totp" }] }), ID), "aal2");
  assert.equal(nivelDeGarantia(token({ ...AAL2, sub: ID.toUpperCase() }), ID), "aal2");           // el id de Auth se compara en minusculas
});

test("ante cualquier duda es aal1 (falla hacia lo estricto)", () => {
  const casos = {
    "aal1 de verdad": { ...AAL2, aal: "aal1", amr: [{ method: "password" }] },
    "aal2 sin amr": { sub: ID, aal: "aal2" },
    "aal2 con amr vacio": { ...AAL2, amr: [] },
    "aal2 con amr sin TOTP": { ...AAL2, amr: [{ method: "password" }, { method: "otp" }] },
    "amr no es lista": { ...AAL2, amr: "totp" },
    "amr con basura": { ...AAL2, amr: [null, 7, "totp", { method: 5 }] },
    "sub de OTRA persona": { ...AAL2, sub: "99999999-2222-4333-8444-555555555555" },
    "sin sub": { aal: "aal2", amr: AAL2.amr },
    "sub no es texto": { ...AAL2, sub: [ID] },
    "aal en mayusculas": { ...AAL2, aal: "AAL2" },
    "aal numerico": { ...AAL2, aal: 2 },
    "aal lista": { ...AAL2, aal: ["aal2"] },
    "carga es una lista": [AAL2],
    "carga es null": null
  };
  for (const [nombre, carga] of Object.entries(casos)) assert.equal(nivelDeGarantia(token(carga), ID), "aal1", nombre);
});

test("tokens ilegibles o con otra forma: aal1 y nunca una excepcion", () => {
  for (const t of ["", "abc", "a.b", "a.b.c.d", token("no es base64 !!"), token(Buffer.from("no es json").toString("base64url")), "a..c", undefined, null, 7, {}]) {
    assert.equal(nivelDeGarantia(t, ID), "aal1", String(t).slice(0, 20));
  }
  // la carga viene de lo que el cliente mande: un "aal":"aal2" dentro de otro campo no cuenta
  assert.equal(nivelDeGarantia(token({ sub: ID, user_metadata: { aal: "aal2" }, app_metadata: { aal: "aal2", amr: [{ method: "totp" }] } }), ID), "aal1");
});

test("tieneTotpVerificado: solo con un factor totp en estado verified (como lo devuelve /auth/v1/user); lo demas es false", () => {
  assert.equal(tieneTotpVerificado({ id: "x", factors: [{ id: "f", factor_type: "totp", status: "verified" }] }), true);
  assert.equal(tieneTotpVerificado({ id: "x", factors: [{ factor_type: "phone", status: "verified" }, { factor_type: "totp", status: "verified" }] }), true);
  for (const u of [null, undefined, {}, { factors: null }, { factors: [] }, { factors: "totp" }, { factors: { factor_type: "totp", status: "verified" } },
    { factors: [{ factor_type: "totp", status: "unverified" }] }, { factors: [{ factor_type: "phone", status: "verified" }] },
    { factors: [{ factor_type: "webauthn", status: "verified" }] }, { factors: [{ factor_type: "TOTP", status: "verified" }] },
    { factors: [{ factor_type: "totp", status: "Verified" }] }, { factors: [null, "totp", 7, ["totp", "verified"]] }]) {
    assert.equal(tieneTotpVerificado(u), false, JSON.stringify(u));
  }
});

test("tokenDeSolicitud sigue igual (la MFA no cambio como se lee la cabecera)", () => {
  assert.equal(tokenDeSolicitud({ headers: { authorization: "Bearer abc.def.ghi" } }), "abc.def.ghi");
  assert.equal(tokenDeSolicitud({ headers: {} }), "");
});

/* ---------- 3. Sin escotillas: ninguna variable de entorno ni cabecera apaga la MFA ---------- */
const fs = require("node:fs");
const path = require("node:path");
const RAIZ = path.resolve(__dirname, "..");

test("api/superadmin.js no lee NINGUNA variable de entorno (no hay interruptor de la MFA)", () => {
  const fuente = fs.readFileSync(path.join(RAIZ, "api", "superadmin.js"), "utf8");
  assert.equal(/process\.env/.test(fuente), false);
  assert.equal(/process\[/.test(fuente), false);
});

test("api/_sesion.js solo lee SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (y la llave de servicio por _llave.js): nada que cambie el aal", () => {
  const fuente = fs.readFileSync(path.join(RAIZ, "api", "_sesion.js"), "utf8");
  const nombres = [...fuente.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(nombres)], ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_URL"]);
});

test("las cabeceras que lee api/superadmin.js son solo las de la IP (x-real-ip, x-forwarded-for), y el aal sale de la sesion", () => {
  const fuente = fs.readFileSync(path.join(RAIZ, "api", "superadmin.js"), "utf8");
  const cabeceras = [...fuente.matchAll(/h\["([a-z-]+)"\]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(cabeceras)].sort(), ["x-forwarded-for", "x-real-ip"]);
  const sinComentarios = fuente.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.equal((sinComentarios.match(/req\.headers/g) || []).length, 1);   // las cabeceras solo se tocan dentro de ipDe()
  assert.equal((sinComentarios.match(/\.headers\b/g) || []).length, 1);
  assert.equal(/usuario\.aal\s*=[^=]/.test(fuente), false);          // el aal de la sesion nunca se reasigna en el manejador
  assert.equal(/\.aal\s*=[^=]/.test(fuente.replace(/\/\*[\s\S]*?\*\//g, "")), false);
});
