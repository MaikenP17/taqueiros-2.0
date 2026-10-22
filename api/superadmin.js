const { usuarioDeSolicitud } = require("./_sesion.js");
const { esSuperadmin, llamarFuncionSuperadmin } = require("./_supabase.js");
const { invalidarCache } = require("./_restaurante.js");
const { generarClaveTemporal, crearUsuario, borrarUsuario, buscarUsuarioPorCorreo } = require("./_auth-admin.js");

/* =============================================================
   PANEL DE SUPERADMINISTRADOR: EL SERVIDOR  (paso 3A; la pantalla es el 3B)

   UNA sola funcion de Vercel (la 7 de 12). El navegador del superadmin NO habla con la base para nada de esto:
   manda POST /api/superadmin con la sesion en "Authorization: Bearer <JWT>" y un cuerpo
       { "accion": "<nombre>", ...datos }
   y recibe { ok: true, ... } o { error }. Es global: no mira el Host ni resuelve ningun restaurante.

   QUIEN PUEDE
     Solo un usuario cuyo id este en public.superadmins. Se comprueba EN CADA PETICION (no se guarda en memoria): quitarlo de
     la tabla lo saca al instante, aunque su token siga vivo. Sin sesion o con un token falso/vencido/manipulado: 401. Con
     sesion valida pero sin ser superadmin (un dueno, cajero, cocina, alguien sin membresia): 403. Despues las funciones SQL
     vuelven a comprobarlo (p_actor) y dejan constancia en la auditoria.
     La sesion se valida con el MISMO helper de siempre (api/_sesion.js).

   LIMITE DE INTENTOS FALLIDOS (sin infraestructura nueva)
     Despues de 10 intentos fallidos (401 o 403) desde la misma IP en 10 minutos responde 429 con Retry-After. Es en memoria de
     cada instancia de Vercel: frena a quien prueba tokens o cuentas a mano, no a un ataque distribuido. El inicio de sesion
     (correo y contrasena) NO pasa por aqui sino por Supabase Auth, que tiene sus propios limites (Authentication -> Rate
     Limits); este limite protege a ESTE endpoint. Ver docs seccion 19.
     Recomendacion: activar MFA en las cuentas de superadmin (P9 de la seccion 13: esta funcion no mira el nivel aal2).

   SECRETOS: SOLO ESCRITURA
     guardar_secretos recibe llaves de Wompi / CallMeBot y las manda a la base. NUNCA las devuelve, ni las imprime, ni las deja
     en la auditoria: la respuesta solo dice, campo por campo, si se guardo / ya coincidia / ya habia otro valor / estaba
     repetido en otro restaurante, y que secretos estan puestos (si/no). No existe ninguna accion que lea un secreto.
     El cuerpo de las peticiones tampoco se imprime nunca.

   ACCIONES
     yo                      quien soy (para que la pantalla sepa si puede entrar)
     listar_restaurantes     todos, con su vigencia calculada
     detalle_restaurante     uno: config, dominios, miembros, tarifas, vigencia, secretos puestos si/no
     crear_restaurante       alta (estado inicial prueba; slug, dominio, zona, plan, modalidad, vigencia, config)
     actualizar_restaurante  estado, plan, modalidad, vigencia, dias de gracia, modulos, zona, nombre
     registrar_pago          extiende vigente_hasta N meses
     editar_config           marca, wompi (llaves publicas), pwa, contacto, textos, ubicacion, domicilio
     guardar_tarifas         reemplaza las tarifas de domicilio
     agregar_dominio / quitar_dominio
     buscar_usuario          por correo
     crear_usuario           crea el usuario del dueno (clave temporal fuerte que se muestra UNA vez) y, si se pide, lo asigna
     asignar_miembro / quitar_miembro   (rol dueno, cajero o cocina)
     guardar_secretos / estado_secretos
     listar_auditoria
============================================================= */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CORREO = /^[^\s@<>"'`,;:()\[\]\\]+@[^\s@<>"'`,;:()\[\]\\]+\.[^\s@<>"'`,;:()\[\]\\]+$/;

/* ---------------------------------------------------------------
   LIMITE DE INTENTOS FALLIDOS (en memoria de la instancia)
--------------------------------------------------------------- */
const VENTANA_MS = 10 * 60 * 1000;
const MAX_FALLOS = 10;
const MAX_CLAVES = 5000;
const fallos = new Map();   // ip -> { n, desde }

/* La IP del cliente. En Vercel x-forwarded-for / x-real-ip los pone la plataforma. */
function ipDe(req) {
  const h = (req && req.headers) || {};
  const real = String(Array.isArray(h["x-real-ip"]) ? h["x-real-ip"][0] : (h["x-real-ip"] || "")).trim();
  const reenviada = String(Array.isArray(h["x-forwarded-for"]) ? h["x-forwarded-for"][0] : (h["x-forwarded-for"] || "")).split(",")[0].trim();
  const socket = (req && req.socket && req.socket.remoteAddress) || "";
  return (real || reenviada || String(socket) || "desconocida").slice(0, 80);
}

/* Segundos que faltan para poder volver a intentar (0 = puede). */
function segundosBloqueada(ip, ahora) {
  const f = fallos.get(ip);
  if (!f) return 0;
  if (ahora - f.desde > VENTANA_MS) { fallos.delete(ip); return 0; }
  return f.n >= MAX_FALLOS ? Math.max(1, Math.ceil((f.desde + VENTANA_MS - ahora) / 1000)) : 0;
}

function anotarFallo(ip, ahora) {
  const f = fallos.get(ip);
  if (!f || ahora - f.desde > VENTANA_MS) {
    if (fallos.size >= MAX_CLAVES) fallos.delete(fallos.keys().next().value);
    fallos.set(ip, { n: 1, desde: ahora });
  } else {
    f.n++;
  }
}

/* ---------------------------------------------------------------
   VALIDACION DE LA ENTRADA (la base vuelve a validar todo; esto da errores claros y corta lo absurdo)
--------------------------------------------------------------- */
class ErrorDeAccion extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; this.deAccion = true; }
}
const mal = (mensaje) => new ErrorDeAccion(400, mensaje);

function uuid(v, nombre) {
  if (typeof v !== "string" || !UUID.test(v)) throw mal(`${nombre} debe ser un id valido`);
  return v.toLowerCase();
}
function texto(v, nombre, max, { obligatorio = true } = {}) {
  if (v === undefined || v === null) {
    if (obligatorio) throw mal(`Falta ${nombre}`);
    return undefined;
  }
  if (typeof v !== "string") throw mal(`${nombre} debe ser un texto`);
  if (v.length > max) throw mal(`${nombre} es demasiado largo (maximo ${max} caracteres)`);
  return v;
}
function objeto(v, nombre, { obligatorio = true } = {}) {
  if (v === undefined || v === null) {
    if (obligatorio) throw mal(`Falta ${nombre}`);
    return undefined;
  }
  if (typeof v !== "object" || Array.isArray(v)) throw mal(`${nombre} debe ser un objeto`);
  return v;
}
function entero(v, nombre, min, max, { obligatorio = true } = {}) {
  if (v === undefined || v === null) {
    if (obligatorio) throw mal(`Falta ${nombre}`);
    return undefined;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw mal(`${nombre} debe ser un numero entero de ${min} a ${max}`);
  return v;
}
function booleano(v, nombre) {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw mal(`${nombre} debe ser verdadero o falso`);
  return v;
}
function soloAdmitidos(b, nombre, permitidos) {
  const extra = Object.keys(b).filter((k) => k !== "accion" && !permitidos.includes(k));
  if (extra.length) throw mal(`Campo no permitido en ${nombre}: ${extra[0].slice(0, 40)}`);
}

/* Los campos de secretos (los mismos de supabase/cargar-secretos.mjs y de sa_guardar_secretos) y su validacion previa.
   'prefijo' sirve para detectar un secreto pegado DOS veces (o repetido a la mitad) antes de mandarlo. */
const CAMPOS_SECRETOS = {
  wompi_llave_publica_test: { prefijo: "pub_test_" },
  wompi_llave_publica_prod: { prefijo: "pub_prod_" },
  wompi_integridad_test: { prefijo: "test_integrity_" },
  wompi_integridad_prod: { prefijo: "prod_integrity_" },
  wompi_eventos_test: { prefijo: "test_events_" },
  wompi_eventos_prod: { prefijo: "prod_events_" },
  callmebot_telefono: { soloDigitos: true },
  callmebot_apikey: {},
  wompi_llave_privada_test: { prefijo: "prv_test_" },
  wompi_llave_privada_prod: { prefijo: "prv_prod_" },
  wompi_modo: { enumerado: ["test", "produccion"] }
};

function pegadoDoble(valor, prefijo) {
  if (valor.length >= 8 && valor.length % 2 === 0 && valor.slice(0, valor.length / 2) === valor.slice(valor.length / 2)) return true;
  return !!prefijo && valor.split(prefijo).length > 2;
}

function validarSecretos(valores) {
  const v = objeto(valores, "valores");
  const claves = Object.keys(v);
  if (!claves.length) throw mal("Faltan los secretos (un objeto { campo: valor })");
  if (claves.length > 20) throw mal("Demasiados campos");
  const limpio = {};
  for (const k of claves) {
    const regla = CAMPOS_SECRETOS[k];
    if (!regla) throw mal(`Campo de secretos no permitido: ${k.slice(0, 40)}`);
    if (typeof v[k] !== "string") throw mal(`El valor de ${k} debe ser un texto`);
    const valor = v[k].trim();
    if (!valor) throw mal(`El valor de ${k} esta vacio (un valor vacio nunca borra uno existente)`);
    if (/\s/.test(valor)) throw mal(`El valor de ${k} trae espacios o saltos de linea en medio`);
    if (pegadoDoble(valor, regla.prefijo)) throw mal(`El valor de ${k} parece pegado DOS veces: no se guardo nada. Vuelve a pegarlo una sola vez`);
    if (regla.soloDigitos && !/^\d{10,15}$/.test(valor)) throw mal(`${k} debe ser solo digitos con el indicativo (57XXXXXXXXXX)`);
    if (regla.enumerado && !regla.enumerado.includes(valor)) throw mal(`${k} debe ser uno de: ${regla.enumerado.join(", ")}`);
    limpio[k] = valor;
  }
  return limpio;
}

/* ---------------------------------------------------------------
   ACCIONES   (usuario = { id } del superadmin ya comprobado; b = cuerpo)
--------------------------------------------------------------- */
const sa = (nombre, args) => llamarFuncionSuperadmin(nombre, args);

const ACCIONES = Object.assign(Object.create(null), {
  yo: async (u) => ({ usuario: { id: u.id }, es_superadmin: true }),

  listar_restaurantes: async (u) => ({ restaurantes: await sa("sa_listar_restaurantes", { p_actor: u.id }) }),

  detalle_restaurante: async (u, b) => {
    soloAdmitidos(b, "detalle_restaurante", ["restaurante_id"]);
    return { restaurante: await sa("sa_detalle_restaurante", { p_actor: u.id, p_restaurante: uuid(b.restaurante_id, "restaurante_id") }) };
  },

  crear_restaurante: async (u, b) => {
    soloAdmitidos(b, "crear_restaurante", ["slug", "nombre", "dominio", "zona_horaria", "plan", "modalidad_pago", "vigente_hasta", "dias_gracia", "modulos", "config"]);
    const args = { p_actor: u.id, p_slug: texto(b.slug, "slug", 60), p_nombre: texto(b.nombre, "nombre", 200) };
    const dominio = texto(b.dominio, "dominio", 253, { obligatorio: false });
    if (dominio) args.p_dominio = dominio;
    const zona = texto(b.zona_horaria, "zona_horaria", 64, { obligatorio: false });
    if (zona) args.p_zona_horaria = zona;
    const plan = texto(b.plan, "plan", 20, { obligatorio: false });
    if (plan) args.p_plan = plan;
    const modalidad = texto(b.modalidad_pago, "modalidad_pago", 20, { obligatorio: false });
    if (modalidad) args.p_modalidad_pago = modalidad;
    const vigente = texto(b.vigente_hasta, "vigente_hasta", 10, { obligatorio: false });
    if (vigente) args.p_vigente_hasta = vigente;
    const gracia = entero(b.dias_gracia, "dias_gracia", 0, 60, { obligatorio: false });
    if (gracia !== undefined) args.p_dias_gracia = gracia;
    const modulos = objeto(b.modulos, "modulos", { obligatorio: false });
    if (modulos) args.p_modulos = modulos;
    const config = objeto(b.config, "config", { obligatorio: false });
    if (config) args.p_config = config;
    const restaurante = await sa("sa_crear_restaurante", args);
    invalidarCache();
    return { restaurante };
  },

  actualizar_restaurante: async (u, b) => {
    soloAdmitidos(b, "actualizar_restaurante", ["restaurante_id", "cambios"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    const restaurante = await sa("sa_actualizar_restaurante", { p_actor: u.id, p_restaurante: rid, p_cambios: objeto(b.cambios, "cambios") });
    invalidarCache(rid);
    return { restaurante };
  },

  registrar_pago: async (u, b) => {
    soloAdmitidos(b, "registrar_pago", ["restaurante_id", "meses", "monto", "referencia", "nota"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    const args = { p_actor: u.id, p_restaurante: rid, p_meses: entero(b.meses, "meses", 1, 36) };
    if (b.monto !== undefined && b.monto !== null) {
      if (typeof b.monto !== "number" || !Number.isFinite(b.monto) || b.monto < 0 || b.monto > 1000000000) throw mal("monto debe ser un numero de pesos (0 a 1000000000)");
      args.p_monto = b.monto;
    }
    const referencia = texto(b.referencia, "referencia", 80, { obligatorio: false });
    if (referencia) args.p_referencia = referencia;
    const nota = texto(b.nota, "nota", 300, { obligatorio: false });
    if (nota) args.p_nota = nota;
    const pago = await sa("sa_registrar_pago", args);
    invalidarCache(rid);
    return { pago };
  },

  editar_config: async (u, b) => {
    soloAdmitidos(b, "editar_config", ["restaurante_id", "cambios"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    const r = await sa("sa_editar_config", { p_actor: u.id, p_restaurante: rid, p_cambios: objeto(b.cambios, "cambios") });
    invalidarCache(rid);
    return { config: r.config };
  },

  guardar_tarifas: async (u, b) => {
    soloAdmitidos(b, "guardar_tarifas", ["restaurante_id", "tarifas"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    if (!Array.isArray(b.tarifas)) throw mal("tarifas debe ser una lista");
    const tarifas = await sa("sa_guardar_tarifas", { p_actor: u.id, p_restaurante: rid, p_tarifas: b.tarifas });
    invalidarCache(rid);
    return { tarifas };
  },

  agregar_dominio: async (u, b) => {
    soloAdmitidos(b, "agregar_dominio", ["restaurante_id", "host"]);
    const dominio = await sa("sa_agregar_dominio", { p_actor: u.id, p_restaurante: uuid(b.restaurante_id, "restaurante_id"), p_host: texto(b.host, "host", 253) });
    invalidarCache();
    return { dominio };
  },

  quitar_dominio: async (u, b) => {
    soloAdmitidos(b, "quitar_dominio", ["restaurante_id", "host"]);
    const dominio = await sa("sa_quitar_dominio", { p_actor: u.id, p_restaurante: uuid(b.restaurante_id, "restaurante_id"), p_host: texto(b.host, "host", 253) });
    invalidarCache();
    return { dominio };
  },

  buscar_usuario: async (u, b) => {
    soloAdmitidos(b, "buscar_usuario", ["email"]);
    const email = correo(b.email);
    return { usuario: await buscarUsuarioPorCorreo(email) };   // null si no existe
  },

  crear_usuario: async (u, b) => {
    soloAdmitidos(b, "crear_usuario", ["email", "restaurante_id", "rol"]);
    const email = correo(b.email);
    const rid = b.restaurante_id === undefined || b.restaurante_id === null ? null : uuid(b.restaurante_id, "restaurante_id");
    const rol = texto(b.rol, "rol", 20, { obligatorio: false });
    if (rid && !["dueno", "cajero", "cocina"].includes(rol)) throw mal("Con restaurante_id hay que decir el rol: dueno, cajero o cocina");
    if (!rid && rol) throw mal("El rol necesita un restaurante_id");

    // El restaurante tiene que existir ANTES de crear el usuario (si no, quedaria un usuario suelto)
    if (rid) await sa("sa_detalle_restaurante", { p_actor: u.id, p_restaurante: rid });

    const clave = generarClaveTemporal();
    let nuevo;
    try {
      nuevo = await crearUsuario(email, clave);
    } catch (err) {
      if (err.status === 422 || err.codigo === "email_exists" || err.codigo === "user_already_exists") {
        throw new ErrorDeAccion(409, "Ya existe un usuario con ese correo. Usa buscar_usuario y asignar_miembro");
      }
      if (err.status === 400 || err.status === 422) throw mal("Supabase Auth rechazo el correo o la clave (revisa las reglas de contrasenas del proyecto)");
      throw err;
    }
    try {
      await sa("sa_registrar_usuario", { p_actor: u.id, p_usuario: nuevo.id, p_email: nuevo.email, p_restaurante: rid });
      if (rid) await sa("sa_asignar_miembro", { p_actor: u.id, p_restaurante: rid, p_usuario: nuevo.id, p_rol: rol });
    } catch (err) {
      // Todo o nada: si no se pudo asignar, el usuario recien creado se borra
      try { await borrarUsuario(nuevo.id); } catch (e) { console.error("[Superadmin] No se pudo deshacer la creacion del usuario"); }
      throw err;
    }
    invalidarCache();
    return {
      usuario: { id: nuevo.id, email: nuevo.email },
      miembro: rid ? { restaurante_id: rid, rol } : null,
      password_temporal: clave,
      aviso: "Esta contrasena temporal se muestra UNA sola vez y no se guarda en ningun sitio. Entregala por un canal privado y pidele a la persona que la cambie al entrar."
    };
  },

  asignar_miembro: async (u, b) => {
    soloAdmitidos(b, "asignar_miembro", ["restaurante_id", "usuario_id", "rol"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    const miembro = await sa("sa_asignar_miembro", { p_actor: u.id, p_restaurante: rid, p_usuario: uuid(b.usuario_id, "usuario_id"), p_rol: texto(b.rol, "rol", 20) });
    invalidarCache(rid);
    return { miembro };
  },

  quitar_miembro: async (u, b) => {
    soloAdmitidos(b, "quitar_miembro", ["restaurante_id", "usuario_id"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    const miembro = await sa("sa_quitar_miembro", { p_actor: u.id, p_restaurante: rid, p_usuario: uuid(b.usuario_id, "usuario_id") });
    invalidarCache(rid);
    return { miembro };
  },

  guardar_secretos: async (u, b) => {
    soloAdmitidos(b, "guardar_secretos", ["restaurante_id", "valores", "sobrescribir", "permitir_repetidos"]);
    const rid = uuid(b.restaurante_id, "restaurante_id");
    const valores = validarSecretos(b.valores);
    const r = await sa("sa_guardar_secretos", {
      p_actor: u.id, p_restaurante: rid, p_valores: valores,
      p_sobrescribir: booleano(b.sobrescribir, "sobrescribir"), p_permitir_repetidos: booleano(b.permitir_repetidos, "permitir_repetidos")
    });
    invalidarCache(rid);
    // Solo se devuelve lo que la funcion dijo (resultado por campo y si/no por secreto): ningun valor.
    return { guardado: !!r.guardado, bloqueado_por_repetido: !!r.bloqueado_por_repetido, campos: r.campos, secretos: r.secretos, _estado: r.bloqueado_por_repetido ? 409 : 200, _valores: Object.values(valores) };
  },

  estado_secretos: async (u, b) => {
    soloAdmitidos(b, "estado_secretos", ["restaurante_id"]);
    return { secretos: await sa("sa_estado_secretos", { p_actor: u.id, p_restaurante: uuid(b.restaurante_id, "restaurante_id") }) };
  },

  listar_auditoria: async (u, b) => {
    soloAdmitidos(b, "listar_auditoria", ["restaurante_id", "limite", "antes_de"]);
    const args = { p_actor: u.id };
    if (b.restaurante_id !== undefined && b.restaurante_id !== null) args.p_restaurante = uuid(b.restaurante_id, "restaurante_id");
    const limite = entero(b.limite, "limite", 1, 200, { obligatorio: false });
    if (limite !== undefined) args.p_limite = limite;
    const antes = entero(b.antes_de, "antes_de", 1, Number.MAX_SAFE_INTEGER, { obligatorio: false });
    if (antes !== undefined) args.p_antes_de = antes;
    return { auditoria: await sa("sa_listar_auditoria", args) };
  }
});

function correo(v) {
  const e = texto(v, "email", 254).trim().toLowerCase();
  if (!CORREO.test(e)) throw mal("El correo no es valido");
  return e;
}

/* ---------------------------------------------------------------
   ERRORES: lo que se le dice al navegador (nunca el cuerpo de una peticion ni un detalle de la base)
--------------------------------------------------------------- */
const POR_CODIGO = { "22023": 400, "23514": 400, "23505": 409, "23503": 409, "P0002": 404, "42501": 403, "22P02": 400, "22007": 400, "22008": 400 };

function responderError(res, err, accion, valoresSecretos) {
  if (err && err.deAccion) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // Error de PostgREST: { code, message, details, hint }. 'details' y 'hint' NO se devuelven (pueden traer datos).
  let cuerpo = null;
  if (err && typeof err.cuerpo === "string") { try { cuerpo = JSON.parse(err.cuerpo); } catch (e) { cuerpo = null; } }
  const codigo = cuerpo && cuerpo.code ? String(cuerpo.code) : "";
  const estado = POR_CODIGO[codigo];
  if (estado && cuerpo && typeof cuerpo.message === "string") {
    // Los mensajes de las funciones sa_* y de los triggers de validacion no repiten nunca el valor recibido; aun asi se tacha
    // cualquier secreto que haya viajado en la peticion.
    let mensaje = cuerpo.message;
    for (const s of valoresSecretos || []) if (s && mensaje.includes(s)) mensaje = mensaje.split(s).join("[oculto]");
    if (accion === "guardar_secretos" && !["22023", "P0002"].includes(codigo)) mensaje = "No se pudieron guardar los secretos";
    res.status(estado).json({ error: mensaje.slice(0, 400), codigo });
    return;
  }
  // Lo demas es un fallo nuestro o de la red: al log solo el nombre de la accion, el HTTP y el codigo (no el cuerpo)
  console.error("[Superadmin] Error en", accion, "HTTP", err && err.status, "codigo", codigo || (err && err.codigo) || "-", "-", String((err && err.cuerpo === undefined && err.message) || "").slice(0, 160));
  res.status(500).json({ error: "No se pudo completar la accion" });
}

/* ---------------------------------------------------------------
   EL MANEJADOR
--------------------------------------------------------------- */
async function manejador(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const ahora = Date.now();
  const ip = ipDe(req);
  const espera = segundosBloqueada(ip, ahora);
  if (espera > 0) {
    res.setHeader("Retry-After", String(espera));
    res.status(429).json({ error: "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo." });
    return;
  }

  // ---- quien es (un token falso, vencido o manipulado es 401, nunca 500) ----
  let usuario;
  try {
    usuario = await usuarioDeSolicitud(req);
  } catch (err) {
    console.error("[Superadmin] No se pudo validar la sesion:", err && err.message);
    res.status(500).json({ error: "No se pudo validar la sesión" });
    return;
  }
  if (!usuario) {
    anotarFallo(ip, ahora);
    res.status(401).json({ error: "Inicia sesión para continuar" });
    return;
  }

  // ---- y si es superadmin: se mira la tabla en CADA peticion ----
  let autorizado;
  try {
    autorizado = await esSuperadmin(usuario.id);
  } catch (err) {
    console.error("[Superadmin] No se pudo comprobar el permiso:", err && err.status);
    res.status(500).json({ error: "No se pudo comprobar el permiso" });
    return;
  }
  if (!autorizado) {
    anotarFallo(ip, ahora);
    res.status(403).json({ error: "No autorizado" });
    return;
  }

  // ---- la accion ----
  let cuerpo = req.body;
  if (typeof cuerpo === "string") { try { cuerpo = JSON.parse(cuerpo); } catch (e) { cuerpo = null; } }
  if (!cuerpo || typeof cuerpo !== "object" || Array.isArray(cuerpo)) {
    res.status(400).json({ error: "El cuerpo debe ser un objeto JSON con la accion" });
    return;
  }
  const accion = typeof cuerpo.accion === "string" ? cuerpo.accion : "";
  const hacer = ACCIONES[accion];
  if (!hacer) {
    res.status(400).json({ error: "Accion desconocida" });
    return;
  }

  let valoresSecretos = [];
  try {
    const r = await hacer(usuario, cuerpo);
    const estado = r._estado || 200;
    valoresSecretos = r._valores || [];
    delete r._estado;
    delete r._valores;
    res.status(estado).json(Object.assign({ ok: estado < 400 }, r));
  } catch (err) {
    responderError(res, err, accion, cuerpo.accion === "guardar_secretos" && cuerpo.valores && typeof cuerpo.valores === "object" ? Object.values(cuerpo.valores).filter((x) => typeof x === "string") : valoresSecretos);
  }
}

module.exports = manejador;
module.exports.ACCIONES = Object.keys(ACCIONES);
module.exports.reiniciarLimite = () => fallos.clear();
