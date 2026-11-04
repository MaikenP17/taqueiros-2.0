/* =============================================================
   TOTP (RFC 6238) SIN DEPENDENCIAS - solo para las pruebas

   Lo usan el Supabase falso (para validar el codigo que manda la prueba) y las pruebas contra la base REAL
   (supabase/probar-superadmin-mfa.mjs) para pasar de una sesion aal1 a una aal2 sin celular:
       secreto base32 (el que Auth devuelve al enrolar el factor)  ->  codigo de 6 digitos del momento actual.
   Los secretos TOTP de las pruebas viven SOLO en memoria: este archivo no escribe nada en disco ni en pantalla.

   Parametros de Supabase: HMAC-SHA1, 6 digitos, paso de 30 segundos. Se acepta tambien SHA-256/512 y otros digitos
   para poder comprobar los vectores de prueba del propio RFC (pruebas/totp.test.js).
============================================================= */
const crypto = require("node:crypto");

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/* base32 (RFC 4648) -> Buffer. Ignora espacios, guiones y el relleno '='; mayusculas o minusculas. */
function base32Decodificar(texto) {
  const limpio = String(texto).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let valor = 0;
  const salida = [];
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) throw new Error("El secreto TOTP no es base32 valido");
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(salida);
}

/* Codigo TOTP para un momento (milisegundos desde 1970). ventana = pasos hacia atras (-1) o adelante (+1). */
function codigoTotp(secretoBase32, ahoraMs, { digitos = 6, paso = 30, algoritmo = "sha1", ventana = 0, secretoCrudo = null } = {}) {
  const clave = secretoCrudo || base32Decodificar(secretoBase32);
  const contador = Math.floor(ahoraMs / 1000 / paso) + ventana;
  const mensaje = Buffer.alloc(8);
  mensaje.writeBigUInt64BE(BigInt(contador));
  const mac = crypto.createHmac(algoritmo, clave).update(mensaje).digest();
  const desplazamiento = mac[mac.length - 1] & 0x0f;
  const binario = ((mac[desplazamiento] & 0x7f) << 24) | (mac[desplazamiento + 1] << 16) | (mac[desplazamiento + 2] << 8) | mac[desplazamiento + 3];
  return String(binario % 10 ** digitos).padStart(digitos, "0");
}

/* true si 'codigo' es el codigo de algun paso entre -tolerancia y +tolerancia (como hace un servidor TOTP tolerante al reloj). */
function codigoValido(secretoBase32, codigo, ahoraMs, { tolerancia = 1, ...opciones } = {}) {
  if (!/^\d{6,8}$/.test(String(codigo))) return false;
  for (let v = -tolerancia; v <= tolerancia; v++) {
    if (codigoTotp(secretoBase32, ahoraMs, { ...opciones, digitos: String(codigo).length, ventana: v }) === String(codigo)) return true;
  }
  return false;
}

/* Un secreto base32 aleatorio de 160 bits (32 caracteres), con la forma de los que entrega Supabase Auth. */
function secretoAleatorio() {
  const bytes = crypto.randomBytes(20);
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return salida;
}

module.exports = { base32Decodificar, codigoTotp, codigoValido, secretoAleatorio };
