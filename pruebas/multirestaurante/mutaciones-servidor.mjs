/* =============================================================
   REVISION POR MUTACION DEL SERVIDOR MULTI-RESTAURANTE

   Rompe A PROPOSITO, una por una, cada defensa de api/*.js y exige que alguna
   prueba (escenarios-servidor.mjs) lo detecte:

     1. FILTROS: cada llamada a filtroRestaurante(...) -> se quita (la consulta
        queda sin filtro de restaurante). Se hace automaticamente sobre todo
        api/*.js, asi que un filtro nuevo queda cubierto sin tocar este archivo.
        Cada una se prueba primero SIN el espia de URLs (solo comportamiento) y,
        si asi no se detecta, con el.
     2. EL restaurante_id DE LOS INSERTS: se quita del cuerpo.
     3. DEFENSAS: resolucion del host, cache, ?r=, servicio, secretos, firma del
        webhook, contactos de alertas, autorizacion de reembolsos, tarifas,
        horarios, respaldo del menu, datos publicos...

   Una mutacion es DETECTADA si alguna prueba falla o el manejador se rompe.
   SOBREVIVE si todas pasan: eso es una prueba que falta (o una defensa que
   sobra). Las EQUIVALENTES (quitar una defensa en capas no cambia lo que puede
   hacer un atacante porque otra capa lo cubre) se declaran con su razon.

     node pruebas/multirestaurante/mutaciones-servidor.mjs
     node pruebas/multirestaurante/mutaciones-servidor.mjs --solo=webhook     (las que contengan ese texto)

   Sale con codigo 1 si alguna mutacion NO equivalente sobrevive.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { levantar } from './fake-supabase.mjs';
import { correrContraFalso, RAIZ } from './servidor.mjs';

const TAQ = '00000000-0000-4000-8000-000000000001';
const API = path.join(RAIZ, 'api');
const archivos = fs.readdirSync(API).filter((f) => f.endsWith('.js'));
const original = Object.fromEntries(archivos.map((f) => [f, fs.readFileSync(path.join(API, f), 'utf8').replace(/\r\n/g, '\n')]));

/* ---- mutaciones: [nombre, archivo, buscar, reemplazar, { equivalente: 'razon' }] ---------------------- */
const M = [];
const m = (nombre, archivo, buscar, reemplazar, extra) => M.push({ nombre, archivo, buscar, reemplazar, ...(extra || {}) });

// Cliente de Supabase
m('el restaurante_id de un insert ya no va en el cuerpo (cae en el defecto transitorio = Taqueiros)', '_supabase.js',
  'cuerpo: Object.assign({}, pedido, { restaurante_id: exigirRestauranteId(rid) })', 'cuerpo: Object.assign({}, pedido)');
m('exigirRestauranteId acepta cualquier texto (inyeccion de filtros)', '_supabase.js', 'if (typeof rid !== "string" || !UUID.test(rid)) {', 'if (typeof rid !== "string") {');
m('exigirRestauranteId acepta lo que sea', '_supabase.js', 'if (typeof rid !== "string" || !UUID.test(rid)) {', 'if (false) {');
m('leerConfiguracion vuelve a leer id=eq.1 (la fila de Taqueiros) en vez de la del restaurante', '_supabase.js',
  '`configuracion?${filtroRestaurante(rid)}&select=*`', '`configuracion?id=eq.1&select=*`');
m('la salud del WhatsApp vuelve a usar id=eq.1', '_supabase.js', '`salud_notificaciones?${filtroRestaurante(rid)}`, {', '`salud_notificaciones?id=eq.1`, {');
m('buscarPedidoPorReferenciaGlobal acepta referencias repetidas', '_supabase.js', 'if (filas.length > 1) {', 'if (false) {',
  { equivalente: 'la base no permite dos pedidos con la misma referencia (UNIQUE): la defensa es de profundidad' });
m('el reembolso deja de ser condicional/atomico (sin estado, pago ni reembolsado_en en el PATCH)', '_supabase.js',
  '&estado=eq.cancelado&estado_pago=eq.aprobado&reembolsado_en=is.null`', '`');
m('listarRestaurantes: sin orden estable', '_supabase.js', '&order=creado_en.asc`', '`', { equivalente: 'solo cambia el orden en que el cron recorre los restaurantes' });

// Resolucion del restaurante
m('la cache por host se comparte entre hosts', '_restaurante.js', 'conCache("host:" + host,', 'conCache("host:",');
m('la cache por slug se comparte entre slugs', '_restaurante.js', 'conCache("slug:" + slug,', 'conCache("slug:",');
m('?r= tambien funciona en produccion (y sin el interruptor)', '_restaurante.js', 'if (entorno.VERCEL_ENV !== "production" && entorno.RESTAURANTE_POR_PARAMETRO === "1") {', 'if (true) {');
m('el restaurante se elige con x-forwarded-host', '_restaurante.js', 'const h = req && req.headers ? req.headers.host : null;',
  'const h = req && req.headers ? (req.headers["x-forwarded-host"] || req.headers.host) : null;');
m('el restaurante se elige con un host dentro del cuerpo', '_restaurante.js', 'const host = hostDe(req);',
  'const host = (req && req.body && req.body.host) ? normalizarHost(req.body.host) : hostDe(req);');
m('el subdominio acepta DOMINIO_BASE pegado sin punto', '_restaurante.js', 'host.endsWith("." + base)', 'host.endsWith(base)');
m('el subdominio acepta cualquier etiqueta (sin validar el formato del slug)', '_restaurante.js',
  'if (etiqueta.length >= 2 && etiqueta.length <= 40 && SLUG.test(etiqueta)) {', 'if (etiqueta.length >= 2) {',
  { equivalente: 'buscarRestaurantePorSlug valida el formato del slug otra vez antes de consultar (defensa en capas)' });
m('el subdominio sin validar el formato en NINGUNA de las dos capas', '_restaurante.js',
  'if (etiqueta.length >= 2 && etiqueta.length <= 40 && SLUG.test(etiqueta)) {', 'if (etiqueta.length >= 2) {', { tambien: ['_supabase.js', 'if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(slug))) return null;', ''] , equivalente: 'el unico slug que pasa sin formato valido seria uno con punto, y ningun restaurante puede tenerlo (CHECK de la tabla): no hay forma de explotarlo' });
m('el host no se normaliza (puerto y punto final)', '_restaurante.js', 'h = h.replace(/:\\d{1,5}$/, "").replace(/\\.$/, "");', 'h = h;');
m('el host no se valida (llega a la base cualquier cosa)', '_restaurante.js',
  'if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) || h.includes("..")) return null;', 'if (false) return null;', { tambien: ['_supabase.js', 'if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(String(host)) || host.length > 253) return null;', ''] });
m('la cache negativa no existe', '_restaurante.js', 'expira: ahora + (restaurante ? TTL_MS : TTL_NEGATIVO_MS),', 'expira: ahora + (restaurante ? TTL_MS : 0),');
m('la cache dura casi para siempre', '_restaurante.js', 'const TTL_MS = 30 * 1000;', 'const TTL_MS = 30 * 1000 * 1000;');
m('invalidarCache(id) vacia todo', '_restaurante.js', 'if (!restauranteId) { cache.clear(); return; }', 'cache.clear(); return;');
m('sin copia vieja cuando Supabase falla', '_restaurante.js', 'if (hit && hit.restaurante && hit.vence > ahora) {', 'if (false) {');
m('la transicion sin SQL 11 vale para cualquier host', '_restaurante.js', 'tablaDominiosAusente(err) && HOSTS_TRANSITORIOS_TAQUEIROS.includes(host)', 'tablaDominiosAusente(err)');
m('el respaldo de entorno sirve a cualquier restaurante', '_restaurante.js', 'if (restaurante.id === RESTAURANTE_TAQUEIROS_ID) {\n    const v =', 'if (true) {\n    const v =');
m('el modo de cobro lo decide el navegador', '_restaurante.js', 'if (otros.wompi_modo === "test" || otros.wompi_modo === "produccion") return otros.wompi_modo;', 'if (false) return otros.wompi_modo;');
m('el modo del navegador vale para cualquier restaurante sin configurar', '_restaurante.js', 'if (restaurante.id === RESTAURANTE_TAQUEIROS_ID) {\n    return modoDelCliente', 'if (true) {\n    return modoDelCliente');
m('los secretos de prueba se usan en produccion (secretosWompi ignora el modo)', '_restaurante.js', 'const prod = modo === "produccion";', 'const prod = false;');
m('suspendido sigue sirviendo', '_restaurante.js', 'if (r.estado === "suspendido") {', 'if (false) {');
m('no hay periodo de gracia', '_restaurante.js', 'if (vencidoHace <= gracia) {', 'if (false) {');
m('el dia de vigente_hasta ya cuenta como vencido', '_restaurante.js', 'if (vencidoHace <= 0) {', 'if (vencidoHace < 0) {');
m('la vigencia se mide en UTC y no en la zona del restaurante', '_restaurante.js', 'fechaLocal(momento, r.zona_horaria)', 'fechaLocal(momento, "UTC")');
m('exigirServicio nunca bloquea', '_restaurante.js', 'if (servicio.sirve) return servicio;', 'return servicio;');
m('restauranteFresco usa el restaurante en cache', '_restaurante.js', 'const r = await buscarRestaurantePorId(restaurante.id);', 'const r = restaurante;');
m('los secretos se leen de la fila de OTRO restaurante', '_restaurante.js', 'return (await leerSecretosRestaurante(restaurante.id)) || {};', `return (await leerSecretosRestaurante("${TAQ}")) || {};`);

// Endpoints
m('menu: siempre el menu de Taqueiros', 'menu.js', 'await leerMenu(restaurante.id)', `await leerMenu("${TAQ}")`);
m('menu: la copia de respaldo es de otro restaurante', 'menu.js', 'menuDeRespaldo(restaurante.id)', `menuDeRespaldo("${TAQ}")`);
m('menu: la cache del borde no es por dominio (sin Vary: Host)', 'menu.js', 'res.setHeader("Vary", "Host");\n    res.status(200).json({ ok: true, ...menu });', 'res.status(200).json({ ok: true, ...menu });');
m('_menu: la copia de respaldo es una sola para todos', '_menu.js', 'return ultimoMenuBuenoPorRestaurante.get(rid) || null;', 'return [...ultimoMenuBuenoPorRestaurante.values()].pop() || null;');
m('disponibilidad: siempre la de Taqueiros', 'disponibilidad.js', 'await leerEstadoMenu(restaurante.id)', `await leerEstadoMenu("${TAQ}")`);
m('estado: siempre el horario de Taqueiros', 'estado.js', 'await estadoRestaurante(restaurante)', `await estadoRestaurante({ id: "${TAQ}", zona_horaria: "America/Bogota" })`);
m('estado: no informa el servicio', 'estado.js', 'servicio: { sirve: servicio.sirve, motivo: servicio.sirve ? null : "servicio_suspendido" }', 'servicio: { sirve: true, motivo: null }');
m('crear-pedido: valida los productos contra el menu de Taqueiros', 'crear-pedido.js', 'validarItems(restaurante.id, items)', `validarItems("${TAQ}", items)`);
m('crear-pedido: las tarifas son las de Taqueiros', 'crear-pedido.js', 'leerTarifasDomicilio(restaurante.id)', `leerTarifasDomicilio("${TAQ}")`);
m('crear-pedido: el pedido se guarda en Taqueiros', 'crear-pedido.js', 'insertarPedido(restaurante.id, {', `insertarPedido("${TAQ}", {`);
m('crear-pedido: las llaves son las de Taqueiros', 'crear-pedido.js', 'const secretos = await leerSecretos(restaurante);', `const secretos = await leerSecretos({ id: "${TAQ}" });`);
m('crear-pedido: el horario es el de Taqueiros', 'crear-pedido.js', 'await estadoRestaurante(restaurante);', `await estadoRestaurante({ id: "${TAQ}", zona_horaria: "America/Bogota" });`);
m('crear-pedido: no revisa el servicio', 'crear-pedido.js', 'if (!exigirServicio(res, restaurante)) return;', '');
m('crear-pedido: usa el restaurante en cache (una suspension tarda en regir)', 'crear-pedido.js', 'const restaurante = await restauranteFresco(restauranteCache);', 'const restaurante = restauranteCache;');
m('crear-pedido: el ambiente guardado es el que dice el navegador', 'crear-pedido.js', 'wompi_ambiente: modoCobro === "produccion" ? "prod" : "test"', 'wompi_ambiente: modo === "produccion" ? "prod" : "test"');
m('crear-pedido: la firma usa el secreto de entorno', 'crear-pedido.js', 'secretosWompi(restaurante, secretos, modoCobro).integridad', 'process.env.WOMPI_INTEGRITY_SECRET_TEST');
m('crear-pedido: el restaurante sale del cuerpo', 'crear-pedido.js', 'const restauranteCache = await exigirRestaurante(req, res);\n  if (!restauranteCache) return;',
  'const restauranteCache = (req.body && req.body.restaurante_id) ? await S_porId(req.body.restaurante_id) : await exigirRestaurante(req, res);\n  if (!restauranteCache) return;',
  { cabecera: 'const { buscarRestaurantePorId: S_porId } = require("./_supabase.js");\n' });
m('webhook: eventos de produccion se verifican con el secreto de prueba', 'webhook-wompi.js', 'environment === "prod" ? "produccion" : "test"', '"test"');
m('webhook: la firma se verifica con la variable de entorno', 'webhook-wompi.js', 'const secreto = restaurante\n      ?', 'const secreto = process.env.WOMPI_EVENTS_SECRET_TEST ? process.env.WOMPI_EVENTS_SECRET_TEST : restaurante\n      ?');
m('webhook: no se verifica la firma', 'webhook-wompi.js', 'if (!firmaValida(evento, secreto)) {', 'if (false) {');
m('webhook: los secretos son los de Taqueiros', 'webhook-wompi.js', 'await buscarRestaurantePorId(pedido.restaurante_id)', `await buscarRestaurantePorId("${TAQ}")`);
m('webhook: una referencia desconocida responde 200', 'webhook-wompi.js', 'console.error("[Wompi] Evento de una referencia sin pedido, rechazado:", referencia.slice(0, 40));\n      res.status(401)', 'console.error("[Wompi] Evento de una referencia sin pedido, rechazado:", referencia.slice(0, 40));\n      res.status(200)');
m('webhook: las actualizaciones van al restaurante equivocado', 'webhook-wompi.js', 'const rid = pedido.restaurante_id;', `const rid = "${TAQ}";`);
m('webhook: el aviso sale sin contacto del restaurante', 'webhook-wompi.js', 'contactoAlertas(restaurante, secretos)', 'contactoAlertas(restaurante, {})');
m('webhook: el aviso sale por el contacto de Taqueiros', 'webhook-wompi.js', 'contactoAlertas(restaurante, secretos)', `contactoAlertas({ id: "${TAQ}" }, secretos)`);
m('webhook: no detecta eventos duplicados', 'webhook-wompi.js', 'if (pedido.estado_pago === "aprobado") {', 'if (false) {',
  { equivalente: 'desde H2 todas las escrituras del webhook son condicionales (estado_pago=neq.aprobado): un duplicado no cambia nada ni avisa; quitar las dos capas si se detecta' });
m('webhook: no detecta duplicados en NINGUNA de las dos capas', 'webhook-wompi.js', 'if (pedido.estado_pago === "aprobado") {', 'if (false) {',
  { tambien: ['webhook-wompi.js', 'if (!actualizado) {', 'if (false) {'] });
m('webhook: no verifica el monto', 'webhook-wompi.js', 'if (centavosPagados !== Number(pedido.total) * 100 || !monedaOk) {', 'if (false) {');
// Revision adversaria (docs/multirestaurante.md seccion 13)
m('H1 webhook: no compara el ambiente del evento con el del pedido ni con el del restaurante', 'webhook-wompi.js',
  'if ((ambienteFijado && ambienteFijado !== ambienteEvento)\n        || (pedido.wompi_ambiente && pedido.wompi_ambiente !== ambienteEvento)) {', 'if (false) {');
m('H1 webhook: solo compara con el modo del restaurante (no con el del pedido)', 'webhook-wompi.js',
  '\n        || (pedido.wompi_ambiente && pedido.wompi_ambiente !== ambienteEvento)) {', ') {');
m('H1 webhook: solo compara con el pedido (no con el modo fijado del restaurante)', 'webhook-wompi.js',
  'if ((ambienteFijado && ambienteFijado !== ambienteEvento)\n        ||', 'if (false\n        ||');
m('H1 generar-firma: firma en un modo distinto del pedido', 'generar-firma.js',
  'if (pedido.wompi_ambiente && pedido.wompi_ambiente !== (modoCobro === "produccion" ? "prod" : "test")) {', 'if (false) {');
m('H2 webhook: la aprobacion no es condicional (dos eventos simultaneos avisan dos veces)', 'webhook-wompi.js',
  '      pagado_en: new Date().toISOString()\n    }, SIN_APROBAR);', '      pagado_en: new Date().toISOString()\n    });');
m('H2 webhook: un rechazo tardio puede pisar una aprobacion', 'webhook-wompi.js',
  '      wompi_metodo_pago: transaccion.payment_method_type || null\n      }, SIN_APROBAR);', '      wompi_metodo_pago: transaccion.payment_method_type || null\n      });');
m('H2 webhook: si la aprobacion condicional no cambio nada igual se avisa', 'webhook-wompi.js', 'if (!actualizado) {', 'if (false) {');
m('H2 _supabase: actualizarPedidoPorReferencia ignora la condicion', '_supabase.js', 'const extra = condicion ? `&${condicion}` : "";', 'const extra = "";');
m('H3 webhook: el monto se redondea a pesos (vuelve el redondeo)', 'webhook-wompi.js',
  'if (centavosPagados !== Number(pedido.total) * 100 || !monedaOk) {', 'if (Math.round(centavosPagados / 100) !== Number(pedido.total) || !monedaOk) {');
m('H3 webhook: no se mira la moneda', 'webhook-wompi.js', 'const monedaOk = transaccion.currency == null || transaccion.currency === "COP";', 'const monedaOk = true;');
m('H4 ?r= en preview sin el interruptor RESTAURANTE_POR_PARAMETRO', '_restaurante.js',
  'if (entorno.VERCEL_ENV !== "production" && entorno.RESTAURANTE_POR_PARAMETRO === "1") {', 'if (entorno.VERCEL_ENV !== "production") {');
m('H4 ?r= con el interruptor tambien en produccion', '_restaurante.js',
  'if (entorno.VERCEL_ENV !== "production" && entorno.RESTAURANTE_POR_PARAMETRO === "1") {', 'if (entorno.RESTAURANTE_POR_PARAMETRO === "1") {');
m('H4b la copia vieja de la resolucion no vence nunca', '_restaurante.js', 'if (hit && hit.restaurante && hit.vence > ahora) {', 'if (hit && hit.restaurante) {');
m('H5 alertas: sin ventana de tiempo (aluvion de pedidos viejos)', 'alertas.js', '&pagado_en=gt.${encodeURIComponent(desde)}', '');
m('H5 alertas: sin tiempo maximo por restaurante', 'alertas.js', 'if (restante < MINIMO_PARA_ENVIAR_MS) break;', '');
m('H5 alertas: de a un restaurante a la vez (uno lento frena a los demas)', 'alertas.js', 'Math.min(EN_PARALELO, restaurantes.length)', 'Math.min(1, restaurantes.length)');
m('H6 notificar: la apikey queda en el detalle del error', '_notificar.js', 'detalleError = detalleError.split(v).join("***");', '');
m('H6 notificar: solo se tacha la apikey sin codificar', '_notificar.js', 'for (const v of [String(apikey), encodeURIComponent(apikey)]) {', 'for (const v of [String(apikey)]) {');
m('H7 crear-pedido: el nombre conserva saltos de linea', 'crear-pedido.js', ': t.replace(/[\\t\\n]+/g, " ");', ': t;');
m('H7 crear-pedido: no se quitan los caracteres invisibles', 'crear-pedido.js', '.replace(INVISIBLES, " ")', '');
m('H7 crear-pedido: las indicaciones pierden sus saltos de linea (el ticket ya no las ve como notas)', 'crear-pedido.js', 'limpiar(cliente.indicaciones, 400, true)', 'limpiar(cliente.indicaciones, 400)');
m('H7 crear-pedido: no se recortan los textos largos', 'crear-pedido.js', 'return t.trim().slice(0, maximo);', 'return t.trim();');
m('H7 notificar: cada linea de las indicaciones ya no va marcada como nota', '_notificar.js', '.forEach((l) => lineas.push(`\\u{1F4DD} ${l}`));', '.forEach((l) => lineas.push(l));');
m('H7 notificar: el nombre puede traer saltos de linea a la comanda (y el pedido se crea sin limpiar)', '_notificar.js',
  'lineas.push(`\\u{1F464} ${unaLinea(pedido.cliente_nombre)}`);', 'lineas.push(`\\u{1F464} ${pedido.cliente_nombre}`);',
  { tambien: ['crear-pedido.js', ': t.replace(/[\\t\\n]+/g, " ");', ': t;'] });
m('H8 crear-pedido: sin tope de lineas', 'crear-pedido.js', 'if (Array.isArray(items) && items.length > MAX_LINEAS) {', 'if (false) {');
m('H8 precios: se aceptan cantidades negativas o cero (bajan el total)', '_precios.js', 'if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {', 'if (!Number.isInteger(cantidad) || cantidad > 50) {');
m('H8 precios: se aceptan cantidades fraccionarias', '_precios.js', 'if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {', 'if (!Number.isFinite(cantidad) || cantidad <= 0 || cantidad > 50) {');
m('H8 precios: sin maximo por linea', '_precios.js', 'if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {', 'if (!Number.isInteger(cantidad) || cantidad < 1) {');
m('H9 sesion: tokens con caracteres fuera de ASCII imprimible llegan a fetch (500)', '_sesion.js', ' || /[^\\x21-\\x7E]/.test(t)) return null;', ') return null;');
m('H9 sesion: sin largo maximo del token', '_sesion.js', 'if (!t || t.length > LARGO_MAXIMO_TOKEN ||', 'if (!t ||');
m('restaurante: vuelve a decir que el restaurante esta en gracia', '_publico.js', 'estado: servicio.sirve ? "activo" : "suspendido",', 'estado: servicio.estado,');
// Mutaciones propias de la revision sobre lo que ya existia
m('webhook: la firma se compara sin exigir el mismo largo (timingSafeEqual lanza: 500 en vez de 401)', 'webhook-wompi.js', 'return a.length === b.length && crypto.timingSafeEqual(a, b);', 'return crypto.timingSafeEqual(a, b);');
m('webhook: la comparacion de la firma distingue mayusculas (Wompi manda el checksum en MAYUSCULAS: se rechazarian todos los pagos)', 'webhook-wompi.js', 'const a = Buffer.from(calculado.toUpperCase());\n  const b = Buffer.from(recibido.toUpperCase());', 'const a = Buffer.from(calculado);\n  const b = Buffer.from(recibido);');
m('webhook: el restaurante del pedido no se relee (se usa uno inexistente) -> sin secreto', 'webhook-wompi.js', 'const restaurante = await buscarRestaurantePorId(pedido.restaurante_id);', 'const restaurante = null;');
m('sesion: Bearer se busca en cualquier parte de la cabecera (sin ^)', '_sesion.js', 'const m = /^Bearer\\s+(.+)$/i.exec(cabecera);', 'const m = /Bearer\\s+(.+)$/i.exec(cabecera);',
  { equivalente: 'lo que se extrae igual tiene que ser una sesion valida para Supabase Auth; "Basic x Bearer <token>" solo prueba un token que el atacante ya tenia' });
m('sesion: un 200 de Auth con un id que no es UUID se acepta', '_sesion.js', 'return u && typeof u.id === "string" && UUID.test(u.id) ? { id: u.id.toLowerCase() } : null;', 'return u && typeof u.id === "string" ? { id: u.id.toLowerCase() } : null;',
  { equivalente: 'solo Supabase Auth (de confianza) produce esa respuesta y esSuperadmin vuelve a validar el UUID; ademas reembolso.js solo lo usa con eq. y PostgREST lo trata como literal' });
m('reembolso: un error de la sesion se toma como "sin sesion" (401) en vez de 500', 'reembolso.js', 'const usuario = await usuarioDeSolicitud(req);', 'const usuario = await usuarioDeSolicitud(req).catch(() => null);');
m('resolucion: el subdominio acepta dos niveles (a.b.DOMINIO_BASE -> slug "a.b" -> se recorta a "b")', '_restaurante.js', 'const etiqueta = host.slice(0, host.length - base.length - 1);', 'const etiqueta = host.slice(0, host.length - base.length - 1).split(".").pop();');
m('alertas: el cron entra sin CRON_SECRET (comparando con "undefined")', '_cron.js', 'if (!secreto) return false;', '');
m('alertas: los pedidos ya avisados se vuelven a avisar', 'alertas.js', 'estado=eq.nuevo&alerta_enviada=is.false&', 'estado=eq.nuevo&');
m('notificar: no verifica que el contacto sea del restaurante del pedido', '_notificar.js',
  'if (!pedido || !pedido.restaurante_id || !c.restauranteId || pedido.restaurante_id !== c.restauranteId) {', 'if (false) {');
m('notificar: la salud se registra en Taqueiros', '_notificar.js', 'registrarSaludNotificacion(pedido.restaurante_id, ok, detalleError)', `registrarSaludNotificacion("${TAQ}", ok, detalleError)`);
m('alertas: tambien recorre los restaurantes suspendidos', 'alertas.js', '.filter((r) => restauranteActivo(r).sirve)', '');
m('alertas: el contacto es siempre el mismo (el primero)', 'alertas.js', 'contactoAlertas(restaurante, await leerSecretos(restaurante))',
  'contactoAlertas({ id: restaurante.id }, { callmebot_telefono: "573000000000", callmebot_apikey: "x" })');
m('alertas: avisa aunque no haya contacto (y marca como avisado)', 'alertas.js', 'if (!contacto.telefono || !contacto.apikey) {', 'if (false) {');
m('alertas: consulta los pedidos de Taqueiros', 'alertas.js', 'const rid = restaurante.id;', `const rid = "${TAQ}";`);
m('alertas: un restaurante que falla detiene a los demas', 'alertas.js', '        } catch (err) {\n          // Un restaurante con problemas no deja sin aviso a los demas\n          console.error("[Alertas] Fallo el restaurante", restaurante.slug, err.message);\n        }', '        } finally {\n        }');
m('restaurante: devuelve toda la config (incluye lo interno)', '_publico.js', '    moneda: "COP",\n    modulos,', '    moneda: "COP",\n    config: cfg,\n    modulos,');
m('restaurante: expone el plan', '_publico.js', '    moneda: "COP",\n    modulos,', '    moneda: "COP",\n    plan: restaurante.plan,\n    modulos,');
m('restaurante: expone la vigencia', '_publico.js', 'zona_horaria: restaurante.zona_horaria,', 'zona_horaria: restaurante.zona_horaria,\n    vigente_hasta: restaurante.vigente_hasta,');
m('restaurante: siempre dice que el servicio esta activo', '_publico.js', 'sirve: servicio.sirve,', 'sirve: true,');

// Datos publicos y manifest (seccion 14): cada validacion de lo que sale hacia el navegador
m('14 publico: los colores no se validan', '_publico.js', 'return typeof valor === "string" && COLOR.test(valor.trim()) ? valor.trim() : null;', 'return typeof valor === "string" ? valor : null;');
m('14 publico: el color no tiene que ser #RRGGBB completo (regex sin anclas)', '_publico.js', 'const COLOR = /^#[0-9A-Fa-f]{6}$/;', 'const COLOR = /#[0-9A-Fa-f]{6}/;');
m('14 publico: una URL puede ser javascript: o data:', '_publico.js', '  if (u.protocol !== "https:" && u.protocol !== "http:") return null;\n', '',
  { equivalente: 'el origen de javascript:/data: es "null", que nunca esta en la lista de origenes permitidos (otra capa); quitar las dos SI se detecta (la mutacion del origen lo cubre)' });
m('14 publico: una URL puede ser de cualquier origen', '_publico.js', '  if (!(origenes || []).includes(u.origin)) return null;\n', '');
m('14 publico: una URL puede traer usuario y clave', '_publico.js', '  if (u.username || u.password) return null;\n', '');
m('14 publico: una ruta relativa puede subir de carpeta o ser //dominio', '_publico.js', 'if (RUTA_RELATIVA.test(s) && !s.includes("..") && !s.includes("//")) return s;', 'if (RUTA_RELATIVA.test(s)) return s;');
m('14 publico: los textos conservan caracteres de control, ancho cero y bidi', '_publico.js', 'valor.replace(CONTROLES, " ").replace(BLANCOS, " ")', 'valor.replace(BLANCOS, " ")');
m('14 publico: los textos no tienen tope de largo', '_publico.js', '.slice(0, maximo || 300);', '.slice(0, 100000);');
m('14 publico: el WhatsApp no se valida', '_publico.js', 'if (WHATSAPP.test(wa)) sal.whatsapp = wa;', 'sal.whatsapp = wa;');
m('14 publico: el usuario de la red social no se valida', '_publico.js', 'if (USUARIO_RED.test(v)) sal[k] = v;', 'sal[k] = v;');
m('14 publico: los textos desconocidos tambien salen (se copia el objeto)', '_publico.js', '  sal.seguimiento = segSal;', '  Object.assign(sal, textos);\n  sal.seguimiento = segSal;');
m('14 publico: la llave de Wompi no se valida', '_publico.js', 'if (!LLAVE_WOMPI.test(t)) return null;', 'if (false) return null;');
m('14 publico: se entrega la llave aunque no sea del modo (la de prueba en produccion)', '_publico.js', 'return t.startsWith(modo === "produccion" ? "pub_prod_" : "pub_test_") ? t : null;', 'return t;');
m('14 publico: se entrega la llave aunque no haya secreto de integridad', '_publico.js', 'llave_publica: ex.modo && llave && ex.integridadOk && modulos.pasarela ? llave : null', 'llave_publica: ex.modo ? llave : null');
m('14 publico: la pasarela se ofrece aunque falte el secreto de integridad', '_publico.js', 'disponible: !!(ex.modo && llave && ex.integridadOk && modulos.pasarela),', 'disponible: !!(ex.modo && llave && modulos.pasarela),');
m('14 publico: la pasarela apagada en modulos se ignora', '_publico.js', 'disponible: !!(ex.modo && llave && ex.integridadOk && modulos.pasarela),', 'disponible: !!(ex.modo && llave && ex.integridadOk),');
m('14 publico: el modo de pago lo elige el navegador (se asume produccion)', '_publico.js', 'modoDePago(restaurante, secretos, undefined)', 'modoDePago(restaurante, secretos, "produccion")');
m('14 publico: el respaldo de Taqueiros se usa para CUALQUIER restaurante', '_publico.js', 'if (!restaurante || restaurante.id !== RESTAURANTE_TAQUEIROS_ID) return cfg;', 'if (!restaurante) return cfg;');
m('14 publico: el respaldo pisa lo que ya tiene la base', '_publico.js', 'const completa = mezclar(CONFIG_TAQUEIROS, cfg, cuenta);', 'const completa = mezclar(cfg, CONFIG_TAQUEIROS, cuenta);');
m('14 publico: el nombre del restaurante no se limpia', '_publico.js', 'nombre: texto(restaurante.nombre, 120) || restaurante.slug,', 'nombre: restaurante.nombre,');
m('14 manifest: el manifest no es por restaurante (nombre fijo)', 'manifest.js', 'name: d.nombre,', 'name: "Panel",');
m('14 manifest: el nombre corto no se limita', '_publico.js', 'nombreCorto: texto(pwa.nombre_corto, 12) || "Comandas",', 'nombreCorto: String(pwa.nombre_corto || "Comandas"),');
m('14 manifest: los iconos no se validan (se usa el valor crudo)', '_publico.js', 'icono192: marca.icono_192 || marca.logo,', 'icono192: objeto(publico.marca).icono_192 || marca.logo,');
m('14 numero: la comanda de WhatsApp vuelve a mostrar el id', '_notificar.js', 'String(pedido.numero != null ? pedido.numero : pedido.id).padStart(3, "0")', 'String(pedido.id).padStart(3, "0")');
m('14 numero: la alerta de sin atender vuelve a mostrar el id', 'alertas.js', 'String(pedido.numero != null ? pedido.numero : pedido.id).padStart(3, "0")', 'String(pedido.id).padStart(3, "0")');
m('14 token: crear-pedido ya no devuelve el token de seguimiento', 'crear-pedido.js', 'tokenSeguimiento: pedidoGuardado && pedidoGuardado.token_seguimiento ? pedidoGuardado.token_seguimiento : null,', 'tokenSeguimiento: null,');
m('reembolso: cualquiera con sesion puede', 'reembolso.js', 'if (!(await esDuenoOSuperadmin(restaurante.id, usuario))) {', 'if (false) {');
m('reembolso: el cajero tambien puede (no se exige el rol dueno)', 'reembolso.js', '&activo=is.true&rol=eq.dueno&', '&activo=is.true&');
m('reembolso: un dueno desactivado todavia puede', 'reembolso.js', '`user_id=eq.${usuario.id}&activo=is.true&rol=eq.dueno&', '`user_id=eq.${usuario.id}&rol=eq.dueno&');
m('reembolso: todo el mundo es superadmin', 'reembolso.js', 'return esSuperadmin(usuario.id);', 'return true;');
m('reembolso: un token invalido se acepta', 'reembolso.js', 'const usuario = await usuarioDeSolicitud(req);', 'const usuario = tokenDeCualquierCosa(req) ? { id: "00000000-0000-4000-8000-0000000000ff" } : null;\n    function tokenDeCualquierCosa(r) { return /^Bearer\\s+\\S+/i.test(String((r.headers && r.headers["authorization"]) || "")); }');
// Validacion de la sesion (_sesion.js): la causa del fallo contra la base real fue la primera de estas
m('sesion: rechaza todo token que contenga la letra "s" (/\\s/ escrito como /s/; la falla contra Supabase real)', '_sesion.js', '/\\s/.test(t)', '/s/.test(t)');
m('sesion: la secreta se manda como Bearer en vez del token del usuario', '_sesion.js', '"Authorization": `Bearer ${t}`', '"Authorization": `Bearer ${llaveDeProyecto()}`');
m('sesion: el token del usuario va tambien como apikey', '_sesion.js', '"apikey": llaveDeProyecto(),', '"apikey": t,');
m('sesion: no se manda apikey', '_sesion.js', '"apikey": llaveDeProyecto(), ', '');
m('sesion: la secreta tambien se manda como Bearer (ademas del token)', '_sesion.js', '"Authorization": `Bearer ${t}`', '"Authorization": `Bearer ${t}, Bearer ${llaveDeProyecto()}`');
m('sesion: un error de Auth (5xx) se toma como "sin sesion"', '_sesion.js', 'if (!resp.ok) {\n    // Cualquier otra', 'if (false) {\n    // Cualquier otra');
m('sesion: la llave del proyecto rechazada se toma como "sin sesion"', '_sesion.js', 'if (resp.status === 401 && /api key/i.test(texto)) {', 'if (false) {');
m('sesion: se acepta cualquier token no vacio sin preguntarle a Auth', '_sesion.js', 'const resp = await fetch(`${url}/auth/v1/user`, {', 'if (t) return { id: "00000000-0000-4000-8000-0000000000ff" };\n  const resp = await fetch(`${url}/auth/v1/user`, {');
m('sesion: un 200 de Auth sin id de usuario se acepta', '_sesion.js', 'return u && typeof u.id === "string" && UUID.test(u.id) ? { id: u.id.toLowerCase() } : null;', 'return { id: "00000000-0000-4000-8000-0000000000ff" };');
m('sesion: se aceptan tokens con espacios internos (llegan a la red)', '_sesion.js', ' || /\\s/.test(t) || /[^\\x21-\\x7E]/.test(t)) return null;', ') return null;');
m('reembolso: no exige que el pedido este cancelado y cobrado (ninguna de las dos capas)', 'reembolso.js',
  'if (pedido.estado !== "cancelado" || pedido.estado_pago !== "aprobado") {', 'if (false) {',
  { tambien: ['_supabase.js', '&estado=eq.cancelado&estado_pago=eq.aprobado&reembolsado_en=is.null`', '&reembolsado_en=is.null`'] });
m('reembolso: solo la capa de reembolso.js (la del PATCH sigue)', 'reembolso.js', 'if (pedido.estado !== "cancelado" || pedido.estado_pago !== "aprobado") {', 'if (false) {',
  { equivalente: 'el PATCH condicional de marcarReembolsado repite las mismas condiciones (defensa en capas); quitar ambas si se detecta' });
m('reembolso: busca el pedido en Taqueiros', 'reembolso.js', 'const pedido = await buscarPedidoPorReferencia(rid, ref);', `const pedido = await buscarPedidoPorReferencia("${TAQ}", ref);`);
m('generar-firma: firma cualquier referencia y monto', 'generar-firma.js', 'if (!pedido || pedido.estado_pago !== "pendiente"\n        || Number(montoEnCentavos) !== Number(pedido.total) * 100) {', 'if (false) {');
m('generar-firma: busca el pedido en Taqueiros', 'generar-firma.js', 'buscarPedidoPorReferencia(restaurante.id,', `buscarPedidoPorReferencia("${TAQ}",`);
m('generar-firma: firma con el secreto de entorno', 'generar-firma.js', 'secretosWompi(restaurante, secretos, modoCobro).integridad', 'process.env.WOMPI_INTEGRITY_SECRET_TEST');

// Domicilio y ubicacion
m('domicilio: el factor de recorrido es siempre el de Taqueiros', '_domicilio.js', 'factor: Number.isFinite(factor) && factor > 0 ? factor : FACTOR_RECORRIDO,', 'factor: FACTOR_RECORRIDO,');
m('domicilio: se ignora la ubicacion del restaurante', '_domicilio.js', 'if (u && coordenadasValidas(Number(u.lat), Number(u.lng))) {', 'if (false) {');
m('domicilio: el origen de Taqueiros se presta a cualquier restaurante', '_domicilio.js', '} else if (restaurante && restaurante.id === RESTAURANTE_TAQUEIROS_ID) {', '} else if (true) {');
m('domicilio: las tarifas no se ordenan', '_domicilio.js', '.sort((a, b) => a.hasta - b.hasta);', ';', { equivalente: 'PostgREST ya las entrega ordenadas por hasta (order=hasta.asc); el sort es de profundidad' });
m('domicilio: fuera de cobertura se cobra', '_domicilio.js', 'precio: tramo && tramo.precio != null ? tramo.precio : 0,', 'precio: tramo && tramo.precio != null ? tramo.precio : 1000,');
m('ubicacion: la caja de Cucuta se usa en todos los restaurantes', '_ubicacion.js', '} else if (restaurante && restaurante.id === RESTAURANTE_TAQUEIROS_ID) {\n    area = AREA_CUCUTA;', '} else if (true) {\n    area = AREA_CUCUTA;');
m('ubicacion: no se avisa de un pin sobre el local', '_ubicacion.js', 'if (metros < metrosMinimos) {', 'if (false) {');

// Horario
m('horario: la zona horaria es siempre Bogota', '_horario.js', 'timeZone: zonaValida(zona || ZONA),', 'timeZone: ZONA,');
m('horario: no hay tramo de madrugada de horarios que cruzan la medianoche', '_horario.js', 'if (ayer && ayer.activo !== false && aMinutos(ayer.cierra) <= aMinutos(ayer.abre)) {', 'if (false) {');
m('horario: la hora de corte no limita el tramo de madrugada', '_horario.js', 'const limite = Math.min(aMinutos(ayer.cierra), corte);', 'const limite = aMinutos(ayer.cierra);');
m('horario: la jornada no considera la hora de corte', '_horario.js', 'jornada: minutos < corte ? diaAnterior(fecha) : fecha,', 'jornada: fecha,');
m('horario: un horario que cruza la medianoche cierra al instante', '_horario.js', ': minutos >= abre;', ': false;');
m('horario: la hora de corte es siempre 05:00', '_horario.js', 'const horaCorte = String(config.hora_corte_jornada || restaurante.hora_corte_jornada || "05:00").slice(0, 5);', 'const horaCorte = "05:00";');
m('horario: el interruptor de cerrado temporal se ignora', '_horario.js', 'if (config.cerrado_temporal) {', 'if (false) {');

// ---- ejecucion ----------------------------------------------------------------------------------------------
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const solo = arg('solo');

// Filtros: una mutacion por cada llamada a filtroRestaurante(...) en cualquier archivo de api/
const filtros = [];
for (const [archivo, texto] of Object.entries(original)) {
  const re = /filtroRestaurante\(([^()]*)\)/g;
  let x;
  const lineas = texto.split('\n');
  while ((x = re.exec(texto))) {
    const linea = texto.slice(0, x.index).split('\n').length;
    if (/function\s+filtroRestaurante/.test(lineas[linea - 1])) continue;
    filtros.push({ archivo, indice: x.index, largo: x[0].length, linea, texto: lineas[linea - 1].trim() });
  }
}

function crearMutante(dir, { archivo, buscar, reemplazar, indice, largo, tambien, cabecera }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const f of archivos) fs.writeFileSync(path.join(dir, f), original[f]);
  const aplicar = (arch, b, r) => {
    let t = fs.readFileSync(path.join(dir, arch), 'utf8');
    const n = t.split(b).length - 1;
    if (n !== 1) throw new Error(`mutacion mal definida: "${b.slice(0, 70)}" aparece ${n} veces en ${arch}`);
    fs.writeFileSync(path.join(dir, arch), t.replace(b, () => r));
  };
  if (indice !== undefined) {
    const t = original[archivo];
    fs.writeFileSync(path.join(dir, archivo), t.slice(0, indice) + '""' + t.slice(indice + largo));
  } else {
    aplicar(archivo, buscar, reemplazar);
    if (tambien) aplicar(tambien[0], tambien[1], tambien[2]);
    if (cabecera) fs.writeFileSync(path.join(dir, archivo), cabecera + fs.readFileSync(path.join(dir, archivo), 'utf8'));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mut-'));
// Cada mutante va en SU carpeta: require() guarda los modulos por ruta y reutilizarla serviria el primer mutante siempre
let contador = 0;
const carpetaNueva = () => path.join(tmp, 'm' + (++contador));
const falso = await levantar({ puerto: 54332 });
const resumen = { detectadas: 0, sobreviven: [], equivalentes: [], soloInvariante: 0, errores: [] };
const filasFiltro = [];

async function correr(dir, opciones) {
  try {
    const { resultados } = await correrContraFalso(falso, dir, opciones);
    return { fallas: resultados.filter((r) => !r.ok) };
  } catch (e) {
    return { fallas: [{ nombre: 'EXCEPCION en la corrida', info: String(e.message).slice(0, 120) }] };
  }
}

// Linea base: sin ninguna mutacion, todo debe pasar
const base = await correr(API, {});
console.log(`LINEA BASE (api/ original): ${base.fallas.length === 0 ? 'todo pasa' : 'FALLAN ' + base.fallas.length}`);
if (base.fallas.length) { base.fallas.slice(0, 5).forEach((f) => console.log('  ', f.nombre, '->', f.info)); process.exit(2); }

console.log(`\n== 1. FILTROS DE restaurante_id (${filtros.length} llamadas a filtroRestaurante en api/) ==`);
for (const f of filtros) {
  const etiqueta = `${f.archivo}:${f.linea}  ${f.texto.slice(0, 80)}`;
  if (solo && !etiqueta.includes(solo)) continue;
  const dir = carpetaNueva();
  crearMutante(dir, f);
  let r = await correr(dir, { sinInvariante: true });
  let modo = 'comportamiento';
  if (!r.fallas.length) {
    r = await correr(dir, {});
    modo = 'solo la invariante de URLs';
    if (r.fallas.length) resumen.soloInvariante++;
  }
  if (r.fallas.length) {
    resumen.detectadas++;
    console.log(`  DETECTADA (${modo}, ${r.fallas.length} pruebas)  ${etiqueta}\n      p.ej.: ${r.fallas[0].nombre.slice(0, 110)}`);
  } else {
    resumen.sobreviven.push(etiqueta);
    console.log(`  SOBREVIVE  ${etiqueta}`);
  }
}

console.log(`\n== 2. DEFENSAS (${M.length}) ==`);
for (const mu of M) {
  if (solo && !mu.nombre.includes(solo)) continue;
  const dir = carpetaNueva();
  try { crearMutante(dir, mu); } catch (e) { resumen.errores.push(`${mu.nombre}: ${e.message}`); console.log(`  ERROR   ${mu.nombre}\n      ${e.message}`); continue; }
  const r = await correr(dir, {});
  if (r.fallas.length) {
    resumen.detectadas++;
    console.log(`  DETECTADA (${r.fallas.length})  ${mu.nombre}\n      p.ej.: ${r.fallas[0].nombre.slice(0, 110)}`);
  } else if (mu.equivalente) {
    resumen.equivalentes.push(`${mu.nombre}  [${mu.equivalente}]`);
    console.log(`  EQUIVALENTE  ${mu.nombre}\n      ${mu.equivalente}`);
  } else {
    resumen.sobreviven.push(mu.nombre);
    console.log(`  SOBREVIVE  ${mu.nombre}`);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
await falso.cerrar();
console.log('\n=============================================================');
console.log(`DETECTADAS: ${resumen.detectadas}   EQUIVALENTES: ${resumen.equivalentes.length}   SOBREVIVEN: ${resumen.sobreviven.length}   ERRORES: ${resumen.errores.length}`);
console.log(`(de las de filtros, ${resumen.soloInvariante} solo las detecta el espia de URLs; las demas fallan por comportamiento)`);
if (resumen.sobreviven.length) { console.log('\nSOBREVIVEN (falta una prueba):'); resumen.sobreviven.forEach((s) => console.log('  - ' + s)); }
if (resumen.equivalentes.length) { console.log('\nEQUIVALENTES:'); resumen.equivalentes.forEach((s) => console.log('  - ' + s)); }
if (resumen.errores.length) { console.log('\nERRORES DE DEFINICION:'); resumen.errores.forEach((s) => console.log('  - ' + s)); }
process.exitCode = resumen.sobreviven.length || resumen.errores.length ? 1 : 0;
setTimeout(() => process.exit(), 1500).unref();
