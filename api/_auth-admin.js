/* =============================================================
   API DE ADMINISTRACION DE SUPABASE AUTH (usuarios)

   Lo usa SOLO api/superadmin.js, para crear el usuario de un dueno y buscar usuarios por correo. Habla con
   {SUPABASE_URL}/auth/v1/admin/... con la llave de servicio (nunca se imprime ni se devuelve). No usa supabase-js:
   fetch nativo, como el resto del servidor.

   Esta es la unica pieza del servidor que maneja una CONTRASENA en claro (la temporal del dueno): sale en la respuesta
   de crear_usuario UNA vez y no se guarda, ni se imprime, ni se escribe en la auditoria.
============================================================= */
const crypto = require("node:crypto");
const { cabecerasSupabase, leerLlaveServicio } = require("./_llave.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function credenciales() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("Falta SUPABASE_URL en las variables de entorno");
  return { url: url.replace(/\/$/, ""), key: leerLlaveServicio() };
}

/* Llama a Auth. Lanza un Error con .status y .codigo (el error_code de Auth, si lo trae) cuando la respuesta no es 2xx.
   El mensaje NUNCA incluye el cuerpo de la peticion (puede llevar una contrasena). */
async function pedirAuth(metodo, ruta, cuerpo) {
  const { url, key } = credenciales();
  const resp = await fetch(`${url}/auth/v1/${ruta}`, {
    method: metodo,
    headers: cabecerasSupabase(key),
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
  });
  const texto = await resp.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch (e) { json = null; }
  if (!resp.ok) {
    const err = new Error(`Supabase Auth ${metodo} ${ruta.split("?")[0]} fallo (HTTP ${resp.status})`);
    err.status = resp.status;
    err.codigo = json && (json.error_code || json.code || json.error) ? String(json.error_code || json.code || json.error) : null;
    throw err;
  }
  return json;
}

/* Clave temporal fuerte: 20 caracteres de un alfabeto sin ambiguos (sin 0/O, 1/l/I), con al menos 3 mayusculas, 3 minusculas,
   3 digitos y 3 simbolos, mezclados con crypto.randomInt. Unos 115 bits. */
function generarClaveTemporal() {
  const CLASES = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnpqrstuvwxyz",
    "23456789",
    "#$%&*+-=?@"
  ];
  const todo = CLASES.join("");
  const letras = [];
  for (const clase of CLASES) for (let i = 0; i < 3; i++) letras.push(clase[crypto.randomInt(clase.length)]);
  while (letras.length < 20) letras.push(todo[crypto.randomInt(todo.length)]);
  for (let i = letras.length - 1; i > 0; i--) {            // Fisher-Yates con aleatoriedad criptografica
    const j = crypto.randomInt(i + 1);
    [letras[i], letras[j]] = [letras[j], letras[i]];
  }
  return letras.join("");
}

/* Crea un usuario con correo confirmado (no se manda ningun correo). Devuelve { id, email }. */
async function crearUsuario(email, clave) {
  const u = await pedirAuth("POST", "admin/users", { email, password: clave, email_confirm: true });
  if (!u || typeof u.id !== "string" || !UUID.test(u.id)) throw new Error("Supabase Auth no devolvio el usuario creado");
  return { id: u.id.toLowerCase(), email: String(u.email || email).toLowerCase() };
}

async function borrarUsuario(id) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Id de usuario invalido");
  await pedirAuth("DELETE", `admin/users/${id.toLowerCase()}`);
}

/* Busca un usuario por su correo recorriendo la lista de Auth (hasta 20 paginas de 1000). Devuelve { id, email } o null. */
async function buscarUsuarioPorCorreo(email) {
  const buscado = String(email || "").trim().toLowerCase();
  const POR_PAGINA = 1000;
  for (let pagina = 1; pagina <= 20; pagina++) {
    const r = await pedirAuth("GET", `admin/users?page=${pagina}&per_page=${POR_PAGINA}`);
    const usuarios = r && Array.isArray(r.users) ? r.users : [];
    const hallado = usuarios.find((u) => u && String(u.email || "").toLowerCase() === buscado && typeof u.id === "string" && UUID.test(u.id));
    if (hallado) return { id: hallado.id.toLowerCase(), email: String(hallado.email).toLowerCase() };
    if (usuarios.length < POR_PAGINA) return null;
  }
  return null;
}

module.exports = { generarClaveTemporal, crearUsuario, borrarUsuario, buscarUsuarioPorCorreo };
