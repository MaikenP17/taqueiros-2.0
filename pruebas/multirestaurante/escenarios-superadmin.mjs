/* =============================================================
   ESCENARIOS DEL PANEL DE SUPERADMIN  (api/superadmin.js + SQL 16)  (compartidos)

   Ejecutan el MANEJADOR REAL de api/superadmin.js (y los publicos: menu, estado, restaurante, crear-pedido...) contra una
   base con los SQL 10 a 13 y el 16:

     * local:  el Supabase falso (PGlite)   -> pruebas/multirestaurante/superadmin.mjs
     * real:   la base de verdad            -> supabase/probar-superadmin.mjs

   Que comprueban
     PERMISOS      un anon, un dueno (de cualquier restaurante), un cajero, una cocina, un usuario sin membresia y un token
                   falso o manipulado NO pueden ejecutar NINGUNA accion (401 o 403, nunca 500, y la base queda igual); la
                   limitacion de intentos fallidos; las funciones sa_* y la tabla de auditoria cerradas a todos los clientes
                   (incluida la llave de servicio para escribir en la auditoria y el propio superadmin desde su navegador).
     ALTA          crear el restaurante "mr16-prueba" con su dominio, su usuario dueno y sus secretos; su menu no se mezcla
                   con el de Taqueiros; estados, pagos, config, tarifas, dominios y miembros.
     SECRETOS      jamas aparecen en ninguna respuesta, ni en el log, ni en la auditoria.
     TAQUEIROS     queda exactamente igual.

   Crean SOLO restaurantes "mr16-prueba*" y usuarios "*@prueba-superadmin.example.com" y los borran al terminar, aun si algo
   falla. Unica huella que NO se puede borrar: las filas de public.auditoria_superadmin (es de solo agregar, a proposito).
   Todo lo de la red externa (CallMeBot, Nominatim) esta simulado.
============================================================= */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TAQUEIROS_ID = '00000000-0000-4000-8000-000000000001';
const HOST_TAQUEIROS = 'taqueiros-2-0.vercel.app';
const SLUG_PRUEBA = 'mr16-prueba';

export async function correrSuperadmin(opts) {
  const { apiDir, urlBase, llaveServicio, llavePublicable = '', real = false } = opts;
  const URL_BASE = urlBase.replace(/\/$/, '');
  const resultados = [];
  const sfx = crypto.randomBytes(3).toString('hex');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

  // ---- entorno y red simulada -------------------------------------------------
  const entornoOriginal = { ...process.env };
  const fetchReal = globalThis.fetch;
  const dateNowReal = Date.now;
  const consolaReal = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const logs = [];
  const respuestas = [];           // JSON de todas las respuestas de los manejadores (para buscar fugas)
  const registro = [];             // peticiones del SERVIDOR a Supabase
  let desfase = 0;

  const { cabecerasSupabase } = require(path.join(apiDir, '_llave.js'));
  const H = (extra) => cabecerasSupabase(llaveServicio, extra);

  globalThis.fetch = async function (u, o) {
    const url = String(u);
    if (url.startsWith('https://api.callmebot.com/')) return new Response('Message queued. You will receive it in a few seconds', { status: 200 });
    if (url.includes('nominatim.openstreetmap.org')) return new Response(JSON.stringify({ address: { neighbourhood: 'Barrio Prueba' } }), { status: 200 });
    if (url.startsWith(URL_BASE)) registro.push({ url, metodo: (o && o.method) || 'GET', cuerpo: o && o.body });
    return fetchReal(u, o);
  };
  Date.now = () => dateNowReal() + desfase;
  for (const n of ['log', 'warn', 'error', 'info']) console[n] = (...a) => logs.push(a.map(String).join(' '));

  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = llaveServicio;
  if (llavePublicable) process.env.SUPABASE_PUBLISHABLE_KEY = llavePublicable; else delete process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.VERCEL_ENV = 'production';
  process.env.CRON_SECRET = 'cron-' + sfx;
  delete process.env.DOMINIO_BASE;
  for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_INTEGRITY_SECRET_PROD', 'WOMPI_EVENTS_SECRET_TEST', 'WOMPI_EVENTS_SECRET_PROD', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];

  // ---- acceso directo a la base con la llave de servicio (preparar y verificar) ----
  async function srv(metodo, ruta, cuerpo, prefer) {
    const r = await fetchReal(`${URL_BASE}/rest/v1/${ruta}`, {
      method: metodo, headers: H(prefer ? { Prefer: prefer } : (metodo === 'GET' ? undefined : { Prefer: 'return=representation' })),
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const t = await r.text();
    let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    return { status: r.status, cuerpo: j };
  }
  const leer = async (tabla, filtro) => { const r = await srv('GET', `${tabla}?${filtro}`); if (r.status !== 200) throw new Error(`GET ${tabla} -> ${r.status} ${JSON.stringify(r.cuerpo).slice(0, 150)}`); return r.cuerpo; };
  const insertar = async (tabla, cuerpo) => { const r = await srv('POST', tabla, cuerpo); if (r.status >= 300) throw new Error(`POST ${tabla} -> ${r.status} ${JSON.stringify(r.cuerpo).slice(0, 150)}`); return Array.isArray(cuerpo) ? r.cuerpo : r.cuerpo[0]; };
  const rpcSrv = async (fn, args) => { const r = await fetchReal(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H(), body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; } return { status: r.status, cuerpo: j }; };

  // ---- manejadores reales ---------------------------------------------------------
  const api = (n) => require(path.join(apiDir, n + '.js'));
  const modulo = (n) => require(path.join(apiDir, '_modulos', n + '.js'));
  const SA = api('superadmin');
  const M = { menu: modulo('menu'), estado: modulo('estado'), restaurante: modulo('restaurante'), crear: api('crear-pedido'), firma: api('generar-firma') };
  const R = api('_restaurante');

  function invocar(manejador, { metodo = 'POST', host, ruta = '/', cuerpo, headers = {} }) {
    return new Promise((resolve) => {
      const req = { method: metodo, url: ruta, headers: Object.assign(host ? { host } : {}, headers), body: cuerpo, query: {} };
      let hecho = false;
      const fin = (status, c, cab) => {
        if (hecho) return; hecho = true;
        respuestas.push(JSON.stringify(c === undefined ? null : c));
        resolve({ status, cuerpo: c, cab });
      };
      const res = {
        code: 200, cab: {},
        setHeader(k, v) { this.cab[k] = v; },
        status(c) { this.code = c; return this; },
        json(o) { fin(this.code, o, this.cab); return this; },
        send(o) { fin(this.code, o, this.cab); return this; },
        end() { fin(this.code, undefined, this.cab); return this; }
      };
      Promise.resolve(manejador(req, res)).catch((e) => fin(500, { error: 'EXCEPCION: ' + e.message }, {}));
    });
  }
  let ipActual = '10.0.0.1';
  const llamar = (token, cuerpo, { ip, metodo = 'POST', headers = {} } = {}) => invocar(SA, {
    metodo, host: 'superadmin.example.test', ruta: '/api/superadmin', cuerpo,
    headers: Object.assign({ 'x-forwarded-for': ip || ipActual }, token ? { authorization: 'Bearer ' + token } : {}, headers)
  });
  const rastro = () => registro.length;

  // ---- registro de resultados -------------------------------------------------------------------------
  let grupoActual = '';
  const grupo = (g) => { grupoActual = g; };
  async function T(nombre, fn) {
    try {
      const r = await fn();
      const ok = r === undefined ? true : !!(r && r.ok !== undefined ? r.ok : r);
      resultados.push({ grupo: grupoActual, nombre, ok, info: ok ? '' : String((r && r.info) || '') });
    } catch (e) {
      resultados.push({ grupo: grupoActual, nombre, ok: false, info: 'EXCEPCION: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) });
    }
  }
  const es = (cond, info) => ({ ok: !!cond, info });
  const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
  const igual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

  // ---- fixtures ---------------------------------------------------------------------------------
  const creados = { restaurantes: [], usuarios: [] };
  const secretosUsados = [];       // todo lo que jamas debe aparecer en una respuesta, en el log ni en la auditoria
  const sembrarSecreto = (...vs) => { for (const v of vs) if (v) secretosUsados.push(v); };
  // La contrasena temporal viaja UNA vez, en la respuesta de crear_usuario: se tacha de esa respuesta y desde ahi no puede aparecer en ningun otro sitio
  const ocultarEnRespuestas = (valor) => { for (let i = 0; i < respuestas.length; i++) if (respuestas[i].includes(valor)) respuestas[i] = respuestas[i].split(valor).join('[mostrada una vez]'); };
  const huellaTaq = async () => {
    const t = (await leer('restaurantes', `id=eq.${TAQUEIROS_ID}&select=*`))[0];
    const cfg = (await leer('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}&select=*`))[0];
    const s = await leer('restaurante_secretos', `restaurante_id=eq.${TAQUEIROS_ID}&select=*`);
    const tar = await leer('tarifas_domicilio', `restaurante_id=eq.${TAQUEIROS_ID}&select=*&order=hasta.asc`);
    const dom = await leer('restaurante_dominios', `restaurante_id=eq.${TAQUEIROS_ID}&select=*`);
    const mie = await leer('miembros', `restaurante_id=eq.${TAQUEIROS_ID}&select=*&order=user_id.asc`);
    // (en la base real un cliente puede pedir mientras corre la prueba: los pedidos solo cuentan en local)
    const ped = real ? [] : await leer('pedidos', `restaurante_id=eq.${TAQUEIROS_ID}&select=id,estado,estado_pago,total`);
    return sha(JSON.stringify(canon([t, cfg, s, tar, dom, mie, ped])));
  };

  async function crearUsuarioAuth(nombre) {
    const email = `${nombre}-${sfx}@prueba-superadmin.example.com`;
    const password = 'Pw-' + crypto.randomBytes(8).toString('hex') + 'aA1!';
    const rc = await fetchReal(`${URL_BASE}/auth/v1/admin/users`, { method: 'POST', headers: H(), body: JSON.stringify({ email, password, email_confirm: true }) });
    const u = JSON.parse(await rc.text());
    if (!rc.ok || !u.id) throw new Error('no se pudo crear el usuario ' + nombre + ': ' + JSON.stringify(u).slice(0, 150));
    creados.usuarios.push(u.id);
    return { id: u.id, email, password };
  }
  async function iniciarSesion(u) {
    const rt = await fetchReal(`${URL_BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: llavePublicable || llaveServicio, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: u.password }) });
    const t = JSON.parse(await rt.text());
    if (!t.access_token) throw new Error('no se pudo iniciar sesion con ' + u.email + ': ' + JSON.stringify(t).slice(0, 150));
    sembrarSecreto(t.access_token);
    return t.access_token;
  }
  const iniciarSesionCon = async (email, password) => {
    const rt = await fetchReal(`${URL_BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: llavePublicable || llaveServicio, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const t = JSON.parse(await rt.text());
    if (t.access_token) sembrarSecreto(t.access_token);
    return t;
  };

  let taqAntes = null;
  const barrer = async () => {
    // restos de una corrida anterior que no pudo limpiar
    const rs = await srv('GET', `restaurantes?slug=like.${SLUG_PRUEBA}*&select=id`);
    const ids = (rs.cuerpo || []).map((x) => x.id).concat(creados.restaurantes);
    const lista = ids.length ? `(${[...new Set(ids)].join(',')})` : null;
    const fallos = [];
    const borrar = async (ruta) => { const r = await srv('DELETE', ruta, undefined, 'return=minimal'); if (r.status >= 300) fallos.push(`${ruta.slice(0, 60)} -> ${r.status} ${JSON.stringify(r.cuerpo).slice(0, 100)}`); };
    if (lista) {
      for (const t of ['pedidos', 'productos', 'categorias', 'tarifas_domicilio', 'miembros', 'restaurante_dominios', 'configuracion', 'salud_notificaciones', 'intentos_buscar_pedido']) await borrar(`${t}?restaurante_id=in.${lista}`);
      await borrar(`restaurantes?id=in.${lista}`);
    }
    const lu = await fetchReal(`${URL_BASE}/auth/v1/admin/users?per_page=1000`, { headers: H() });
    if (lu.ok) {
      const c = JSON.parse(await lu.text());
      for (const x of (c.users || [])) if (x && /@prueba-superadmin\.example\.com$/.test(x.email || '')) {
        await srv('DELETE', `superadmins?user_id=eq.${x.id}`, undefined, 'return=minimal');
        await fetchReal(`${URL_BASE}/auth/v1/admin/users/${x.id}`, { method: 'DELETE', headers: H() });
      }
    }
    for (const u of creados.usuarios) {
      await srv('DELETE', `superadmins?user_id=eq.${u}`, undefined, 'return=minimal');
      await fetchReal(`${URL_BASE}/auth/v1/admin/users/${u}`, { method: 'DELETE', headers: H() });
    }
    return fallos;
  };

  const ACCIONES = SA.ACCIONES;
  let barridoInicial = [];
  try {
    barridoInicial = await barrer();
    creados.restaurantes.length = 0;
    taqAntes = await huellaTaq();

    // Personas: un superadmin y todos los que NO lo son
    const uSuper = await crearUsuarioAuth('super');
    const uSuper2 = await crearUsuarioAuth('super2');
    const uDueno = await crearUsuarioAuth('dueno');
    const uCajero = await crearUsuarioAuth('cajero');
    const uCocina = await crearUsuarioAuth('cocina');
    const uSin = await crearUsuarioAuth('sin-membresia');
    const uOtroDueno = await crearUsuarioAuth('otro-dueno');
    for (const u of [uSuper, uSuper2, uDueno, uCajero, uCocina, uSin, uOtroDueno]) sembrarSecreto(u.password);
    await insertar('superadmins', [{ user_id: uSuper.id }, { user_id: uSuper2.id }]);

    // Dos restaurantes que no son el de la prueba de alta: sus miembros intentan entrar al superadmin
    const rA = await insertar('restaurantes', { slug: `${SLUG_PRUEBA}-a`, nombre: `PRUEBA-SUPERADMIN A ${sfx}`, estado: 'activo' });
    const rB = await insertar('restaurantes', { slug: `${SLUG_PRUEBA}-b`, nombre: `PRUEBA-SUPERADMIN B ${sfx}`, estado: 'activo' });
    creados.restaurantes.push(rA.id, rB.id);
    await insertar('miembros', [
      { user_id: uDueno.id, restaurante_id: rA.id, rol: 'dueno', activo: true }, { user_id: uCajero.id, restaurante_id: rA.id, rol: 'cajero', activo: true },
      { user_id: uCocina.id, restaurante_id: rA.id, rol: 'cocina', activo: true }, { user_id: uOtroDueno.id, restaurante_id: rB.id, rol: 'dueno', activo: true }
    ]);

    const tSuper = await iniciarSesion(uSuper);
    const tSuper2 = await iniciarSesion(uSuper2);
    const sesiones = {
      dueno: await iniciarSesion(uDueno), cajero: await iniciarSesion(uCajero), cocina: await iniciarSesion(uCocina),
      'sin membresia': await iniciarSesion(uSin), 'dueno de otro restaurante': await iniciarSesion(uOtroDueno)
    };
    const lleno = (accion) => ({ accion, restaurante_id: rA.id, email: 'x@y.co', cambios: { plan: 'basico' }, tarifas: [], host: 'x.mr-prueba.test', usuario_id: uSin.id, rol: 'cajero', valores: { wompi_modo: 'test' }, meses: 1, slug: 'mr16-intruso', nombre: 'Intruso' });

    /* =====================================================================
       1. PERMISOS: nadie que no sea superadmin puede hacer NADA
    ===================================================================== */
    grupo('permisos');
    const estadoBase = async () => sha(JSON.stringify(canon([
      await leer('restaurantes', 'select=id,slug,estado,plan,vigente_hasta,nombre,modulos,config&order=id.asc'),
      await leer('miembros', 'select=*&order=user_id.asc'), await leer('restaurante_dominios', 'select=*&order=host.asc'),
      await leer('tarifas_domicilio', 'select=hasta,precio,restaurante_id&order=id.asc'), await leer('superadmins', 'select=*&order=user_id.asc')])));
    const secretosHuella = async () => sha(JSON.stringify(canon(await leer('restaurante_secretos', 'select=*&order=restaurante_id.asc'))));

    await T(`la lista de acciones es la esperada (${ACCIONES.length}) y 'yo' funciona para un superadmin`, async () => {
      const y = await llamar(tSuper, { accion: 'yo' });
      return es(ACCIONES.length === 17 && y.status === 200 && y.cuerpo.ok === true && y.cuerpo.usuario.id === uSuper.id && y.cuerpo.es_superadmin === true, `${ACCIONES.length} ${y.status} ${JSON.stringify(y.cuerpo)}`);
    });
    await T('SIN SESION (anon): ninguna de las acciones responde otra cosa que 401, y la base no cambia', async () => {
      const antes = await estadoBase(); const s0 = await secretosHuella();
      const malas = [];
      for (const a of ACCIONES) { const r = await llamar(null, lleno(a), { ip: '10.9.9.' + (1 + ACCIONES.indexOf(a)) }); if (r.status !== 401) malas.push(`${a}:${r.status}`); }
      return es(malas.length === 0 && (await estadoBase()) === antes && (await secretosHuella()) === s0, malas.join(','));
    });
    await T('TOKEN FALSO O MANIPULADO: 401 (nunca 500) y la base no cambia', async () => {
      const antes = await estadoBase();
      const partes = tSuper.split('.');
      const firmaMala = partes[0] + '.' + partes[1] + '.' + partes[2].slice(0, -4) + 'AAAA';
      const cargaMala = partes[0] + '.' + Buffer.from(JSON.stringify({ sub: uSuper.id, role: 'service_role', aud: 'authenticated' })).toString('base64url') + '.' + partes[2];
      const tokens = ['abc', 'Bearer', '', '   ', 'a.b.c', 'null', 'undefined', firmaMala, cargaMala, tSuper.slice(0, 40), tSuper + 'x', 'x'.repeat(5000), 'ñandú', llaveServicio.slice(0, 12) + '.x.y', 'sb_secret_nope', 'sb_publishable_nope'];
      const malos = [];
      let i = 0;
      for (const t of tokens) {
        const r = await llamar(t, lleno('crear_restaurante'), { ip: '10.8.8.' + (++i), headers: { authorization: 'Bearer ' + t } });
        if (r.status !== 401) malos.push(`"${t.slice(0, 12)}":${r.status}`);
      }
      // otras formas de la cabecera
      for (const cab of ['Basic ' + tSuper, tSuper, 'Bearer  ', 'bearer' + tSuper]) {
        const r = await llamar(null, lleno('listar_restaurantes'), { ip: '10.8.8.' + (++i), headers: { authorization: cab } });
        if (r.status !== 401) malos.push(`cab "${cab.slice(0, 10)}":${r.status}`);
      }
      return es(malos.length === 0 && (await estadoBase()) === antes, malos.join(','));
    });
    await T('LA LLAVE DE SERVICIO Y LA PUBLISHABLE NO SON UNA SESION: 401', async () => {
      const a = await llamar(llaveServicio, lleno('listar_restaurantes'), { ip: '10.7.7.1' });
      const b = await llamar(llavePublicable || 'sb_publishable_x', lleno('listar_restaurantes'), { ip: '10.7.7.2' });
      return es(a.status === 401 && b.status === 401, `${a.status} ${b.status}`);
    });
    for (const [quien, token] of Object.entries(sesiones)) {
      await T(`UN ${quien.toUpperCase()} (sesion valida): las ${ACCIONES.length} acciones responden 403 y no cambian NADA`, async () => {
        const antes = await estadoBase(); const s0 = await secretosHuella();
        const malas = [];
        const desde = rastro();
        let i = 0;
        for (const a of ACCIONES) { const r = await llamar(token, lleno(a), { ip: '10.6.' + (Object.keys(sesiones).indexOf(quien)) + '.' + (++i) }); if (r.status !== 403 || r.cuerpo.error !== 'No autorizado') malas.push(`${a}:${r.status}`); }
        // y el servidor ni siquiera llego a las funciones sa_*: solo valido la sesion y miro la tabla superadmins
        const llamadasSa = registro.slice(desde).filter((x) => /\/rpc\/sa_/.test(x.url) || /\/auth\/v1\/admin\//.test(x.url));
        return es(malas.length === 0 && llamadasSa.length === 0 && (await estadoBase()) === antes && (await secretosHuella()) === s0, malas.join(',') + ' sa:' + llamadasSa.length);
      });
    }
    await T('metodos que no son POST: 405', async () => {
      const r = [];
      for (const m of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) r.push((await llamar(tSuper, undefined, { metodo: m, ip: '10.5.5.5' })).status);
      return es(r.every((x) => x === 405), r.join(','));
    });
    await T('cuerpo que no es un objeto, sin accion o con una accion desconocida / con prototipo: 400', async () => {
      const casos = [undefined, null, 'texto', [], {}, { accion: 'no_existe' }, { accion: '__proto__' }, { accion: 'constructor' }, { accion: 'toString' }, { accion: 7 }, { accion: ['yo'] }];
      const r = [];
      for (const c of casos) r.push((await llamar(tSuper, c, { ip: '10.4.4.4' })).status);
      return es(r.every((x) => x === 400), r.join(','));
    });
    await T('LIMITE DE INTENTOS FALLIDOS: a los 10 fallos desde una IP responde 429 con Retry-After; otra IP no se ve afectada; un superadmin con sesion valida no suma fallos', async () => {
      SA.reiniciarLimite();
      const ip = '203.0.113.50';
      const ok0 = [];
      for (let i = 0; i < 12; i++) ok0.push((await llamar(tSuper, { accion: 'yo' }, { ip })).status);       // 12 aciertos: no cuentan
      const fallosAntes = [];
      for (let i = 0; i < 10; i++) fallosAntes.push((await llamar('token-falso-' + i, { accion: 'yo' }, { ip })).status);
      const bloqueado = await llamar('token-falso', { accion: 'yo' }, { ip });
      const bloqueadoConSesionBuena = await llamar(tSuper, { accion: 'yo' }, { ip });
      const otraIp = await llamar(tSuper, { accion: 'yo' }, { ip: '203.0.113.51' });
      desfase = 11 * 60 * 1000;
      const despues = await llamar(tSuper, { accion: 'yo' }, { ip });
      desfase = 0;
      SA.reiniciarLimite();
      return es(ok0.every((x) => x === 200) && fallosAntes.every((x) => x === 401) && bloqueado.status === 429 && Number(bloqueado.cab['Retry-After']) > 0
        && bloqueadoConSesionBuena.status === 429 && otraIp.status === 200 && despues.status === 200,
        [ok0.join(''), fallosAntes.join(','), bloqueado.status, bloqueado.cab['Retry-After'], bloqueadoConSesionBuena.status, otraIp.status, despues.status].join(' '));
    });
    await T('403 (sesion valida sin permiso) tambien cuenta como intento fallido', async () => {
      SA.reiniciarLimite();
      const ip = '203.0.113.60';
      const rs = [];
      for (let i = 0; i < 10; i++) rs.push((await llamar(sesiones.dueno, { accion: 'listar_restaurantes' }, { ip })).status);
      const once = await llamar(sesiones.dueno, { accion: 'listar_restaurantes' }, { ip });
      SA.reiniciarLimite();
      return es(rs.every((x) => x === 403) && once.status === 429, rs.join(',') + ' ' + once.status);
    });

    // ---- las funciones y la auditoria, cerradas a todos los clientes (por la API REST de la base, como las veria un atacante) ----
    const rpcCon = async (fn, args, { llave, token }) => {
      const r = await fetchReal(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: llave, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(args) });
      const t = await r.text(); return { status: r.status, texto: t };
    };
    const PUB = llavePublicable || 'sb_publishable_FAKE_0000';
    await T('las funciones sa_* no se pueden llamar directo a la base: ni anon, ni cada usuario con SU sesion, ni siquiera el superadmin desde su navegador (solo la llave de servicio)', async () => {
      const malas = [];
      const quienes = [['anon', { llave: PUB }], ['superadmin con su sesion', { llave: PUB, token: tSuper }], ...Object.entries(sesiones).map(([n, t]) => [n, { llave: PUB, token: t }])];
      for (const [nombre, cred] of quienes) {
        for (const [fn, args] of [['sa_listar_restaurantes', { p_actor: uSuper.id }], ['sa_crear_restaurante', { p_actor: uSuper.id, p_slug: 'mr16-intruso', p_nombre: 'X' }],
          ['sa_guardar_secretos', { p_actor: uSuper.id, p_restaurante: rA.id, p_valores: { wompi_modo: 'test' } }], ['sa_listar_auditoria', { p_actor: uSuper.id }]]) {
          const r = await rpcCon(fn, args, cred);
          if (![401, 403, 404].includes(r.status)) malas.push(`${nombre} ${fn}:${r.status}`);
        }
      }
      const slugs = (await leer('restaurantes', 'slug=eq.mr16-intruso&select=id'));
      return es(malas.length === 0 && slugs.length === 0, malas.slice(0, 5).join(','));
    });
    await T('la llave de servicio con un actor que NO es superadmin tampoco: 42501 en todas las funciones sa_*', async () => {
      const malas = [];
      for (const [fn, args] of [['sa_listar_restaurantes', {}], ['sa_detalle_restaurante', { p_restaurante: rA.id }], ['sa_actualizar_restaurante', { p_restaurante: rA.id, p_cambios: { plan: 'basico' } }],
        ['sa_guardar_secretos', { p_restaurante: rA.id, p_valores: { wompi_modo: 'test' } }], ['sa_registrar_pago', { p_restaurante: rA.id, p_meses: 1 }], ['sa_asignar_miembro', { p_restaurante: rA.id, p_usuario: uSin.id, p_rol: 'dueno' }]]) {
        for (const actor of [uDueno.id, uSin.id, '00000000-0000-4000-8000-0000000000ff']) {
          const r = await rpcSrv(fn, { p_actor: actor, ...args });
          if (!(r.cuerpo && r.cuerpo.code === '42501')) malas.push(`${fn}/${actor.slice(0, 4)}:${r.status}`);
        }
      }
      return es(malas.length === 0, malas.slice(0, 5).join(','));
    });
    await T('las ayudas internas (exigir_superadmin, auditar_superadmin) no las puede ejecutar nadie, ni siquiera el servidor', async () => {
      const a = await rpcSrv('auditar_superadmin', { p_actor: uSuper.id, p_accion: 'falsa_accion', p_restaurante: null, p_resumen: { x: 1 } });
      const b = await rpcSrv('exigir_superadmin', { p_actor: uSuper.id });
      return es(a.status >= 400 && b.status >= 400 && !/^\d+$/.test(JSON.stringify(a.cuerpo)), `${a.status} ${b.status}`);
    });
    await T('LA AUDITORIA NO SE PUEDE LEER, ESCRIBIR, ACTUALIZAR NI BORRAR por la API de la base: ni anon, ni usuarios, ni la llave de servicio', async () => {
      const malas = [];
      const intentos = [['GET', 'auditoria_superadmin?select=*'], ['POST', 'auditoria_superadmin'], ['PATCH', 'auditoria_superadmin?id=gt.0'], ['DELETE', 'auditoria_superadmin?id=gt.0'], ['DELETE', 'auditoria_superadmin']];
      const quienes = [['llave de servicio', { apikey: llaveServicio, ...(/^sb_/.test(llaveServicio) ? {} : { Authorization: 'Bearer ' + llaveServicio }) }], ['anon', { apikey: PUB }],
        ['superadmin con su sesion', { apikey: PUB, Authorization: 'Bearer ' + tSuper }], ['dueno', { apikey: PUB, Authorization: 'Bearer ' + sesiones.dueno }]];
      for (const [nombre, cab] of quienes) {
        for (const [m, ruta] of intentos) {
          const r = await fetchReal(`${URL_BASE}/rest/v1/${ruta}`, { method: m, headers: { 'Content-Type': 'application/json', ...cab }, body: m === 'POST' ? JSON.stringify({ actor: uSuper.id, accion: 'falsa_accion', resumen: {} }) : (m === 'PATCH' ? JSON.stringify({ accion: 'otra' }) : undefined) });
          const t = await r.text();
          if (r.ok || (r.status === 200)) malas.push(`${nombre} ${m}:${r.status}`);
          if (r.status === 200 && t.length > 2) malas.push(`${nombre} ${m} leyo datos`);
        }
      }
      const falsas = (await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo;
      return es(malas.length === 0 && Array.isArray(falsas) && !falsas.some((f) => f.accion === 'falsa_accion'), malas.slice(0, 5).join(','));
    });

    /* =====================================================================
       2. ALTA DE UN RESTAURANTE (mr16-prueba): dominio, usuario, secretos, menu aislado
    ===================================================================== */
    grupo('alta');
    const hostPrueba = `pedidos.${SLUG_PRUEBA}-${sfx}.mr-prueba.test`;
    let rp = null;           // el restaurante recien creado
    const llamarSA = (cuerpo, opts) => llamar(tSuper, cuerpo, opts);
    const en = (ip) => ({ ip });
    ipActual = '198.51.100.7';

    await T('crear_restaurante "mr16-prueba": estado inicial prueba, vigencia por defecto de 14 dias, dominio, zona, plan y modalidad; el alta deja contador, secretos (vacios), configuracion y salud; tarifas vacias', async () => {
      const r = await llamarSA({ accion: 'crear_restaurante', slug: SLUG_PRUEBA, nombre: `PRUEBA-SUPERADMIN ${sfx}`, dominio: hostPrueba, zona_horaria: 'America/Bogota', plan: 'completo', modalidad_pago: 'mensual', dias_gracia: 7,
        config: { publico: { contacto: { whatsapp: '573001112233' } }, ubicacion: { lat: 7.9, lng: -72.5 } } });
      if (r.status !== 200) return es(false, `${r.status} ${JSON.stringify(r.cuerpo)}`);
      rp = r.cuerpo.restaurante;
      creados.restaurantes.push(rp.id);
      const [contador, secretos, cfg, salud, tarifas, dominios] = await Promise.all([
        leer('contadores_pedido', `restaurante_id=eq.${rp.id}&select=*`), leer('restaurante_secretos', `restaurante_id=eq.${rp.id}&select=*`),
        leer('configuracion', `restaurante_id=eq.${rp.id}&select=*`), leer('salud_notificaciones', `restaurante_id=eq.${rp.id}&select=*`),
        leer('tarifas_domicilio', `restaurante_id=eq.${rp.id}&select=*`), leer('restaurante_dominios', `restaurante_id=eq.${rp.id}&select=host`)]);
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dateNowReal()));
      const mas14 = new Date(Date.parse(hoy + 'T12:00:00Z') + 14 * 86400000).toISOString().slice(0, 10);
      return es(rp.slug === SLUG_PRUEBA && rp.estado === 'prueba' && rp.vigencia.estado === 'prueba' && rp.vigencia.sirve === true && rp.vigente_hasta === mas14 && rp.dias_gracia === 7
        && rp.plan === 'completo' && rp.modalidad_pago === 'mensual' && rp.zona_horaria === 'America/Bogota' && igual(rp.dominios, [hostPrueba]) && rp.tarifas.length === 0
        && Object.entries(rp.secretos).every(([k, v]) => (k === 'wompi_modo' ? v === null : v === false))
        && contador.length === 1 && Number(contador[0].ultimo) === 0 && secretos.length === 1 && cfg.length === 1 && salud.length === 1 && tarifas.length === 0 && dominios.length === 1
        && rp.config.publico.contacto.whatsapp === '573001112233' && rp.config.ubicacion.lat === 7.9,
        JSON.stringify(rp).slice(0, 300));
    });
    await T('crear_restaurante: slugs y datos no validos se rechazan (400/409) y NO crean nada', async () => {
      const antes = (await leer('restaurantes', 'select=id')).length;
      const malos = [];
      const casos = [
        ['slug con mayuscula', { slug: 'Mr16-x' }, 400], ['slug con guion bajo', { slug: 'mr16_x' }, 400], ['slug que empieza con guion', { slug: '-mr16x' }, 400], ['slug de un caracter', { slug: 'a' }, 400],
        ['slug enorme', { slug: 'a'.repeat(41) }, 400], ['slug reservado', { slug: 'admin' }, 400], ['slug repetido (el de Taqueiros)', { slug: 'taqueiros' }, 409], ['slug repetido (el recien creado)', { slug: SLUG_PRUEBA }, 409],
        ['slug con espacio', { slug: 'mr16 x' }, 400], ['slug no texto', { slug: 7 }, 400],
        ['dominio repetido', { slug: 'mr16-x1', dominio: hostPrueba }, 409], ['dominio con mayusculas y slash', { slug: 'mr16-x2', dominio: 'A/b.com' }, 400], ['dominio vacio entre puntos', { slug: 'mr16-x3', dominio: 'a..b.com' }, 400],
        ['zona inventada', { slug: 'mr16-x4', zona_horaria: 'Marte/Olimpo' }, 400], ['plan inventado', { slug: 'mr16-x5', plan: 'gratis' }, 400], ['modalidad inventada', { slug: 'mr16-x6', modalidad_pago: 'anual' }, 400],
        ['dias de gracia 61', { slug: 'mr16-x7', dias_gracia: 61 }, 400], ['dias de gracia negativos', { slug: 'mr16-x7', dias_gracia: -1 }, 400], ['dias de gracia fraccion', { slug: 'mr16-x7', dias_gracia: 1.5 }, 400],
        ['vigencia en el pasado', { slug: 'mr16-x8', vigente_hasta: '2020-01-01' }, 400], ['vigencia absurda', { slug: 'mr16-x9', vigente_hasta: '2999-01-01' }, 400],
        ['modulo inventado', { slug: 'mr16-y1', modulos: { teletransporte: true } }, 400], ['modulo no booleano', { slug: 'mr16-y2', modulos: { pasarela: 'si' } }, 400],
        ['config con color malo', { slug: 'mr16-y3', config: { publico: { marca: { colores: { primario: 'rojo' } } } } }, 400], ['config con una clave que parece secreto', { slug: 'mr16-y4', config: { publico: { apikey: 'x' } } }, 400],
        ['config con HTML', { slug: 'mr16-y5', config: { publico: { textos: { eslogan: '<b>x</b>' } } } }, 400],
        ['nombre con <>', { slug: 'mr16-y6', nombre: 'Mi <script>' }, 400], ['nombre vacio', { slug: 'mr16-y7', nombre: '   ' }, 400], ['nombre de 121', { slug: 'mr16-y8', nombre: 'n'.repeat(121) }, 400],
        ['campo desconocido en el cuerpo', { slug: 'mr16-y9', estado: 'activo' }, 400]
      ];
      for (const [etiqueta, extra, esperado] of casos) {
        const r = await llamarSA({ accion: 'crear_restaurante', nombre: 'Prueba', ...extra });
        if (r.status !== esperado) malos.push(`${etiqueta}: ${r.status} ${JSON.stringify(r.cuerpo).slice(0, 80)}`);
      }
      const despues = (await leer('restaurantes', 'select=id')).length;
      return es(malos.length === 0 && antes === despues, malos.slice(0, 4).join(' | ') + ` (${antes}->${despues})`);
    });
    await T('los errores de validacion explican el problema y NO repiten el valor recibido', async () => {
      const raro = 'VALOR-RARO-' + sfx;
      const r = await llamarSA({ accion: 'crear_restaurante', slug: 'mr16-z1', nombre: 'Z', config: { publico: { marca: { colores: { primario: raro } } } } });
      return es(r.status === 400 && typeof r.cuerpo.error === 'string' && r.cuerpo.error.length > 10 && !JSON.stringify(r.cuerpo).includes(raro), JSON.stringify(r.cuerpo));
    });

    // ---- el usuario del dueno ----
    let uNuevo = null, claveNueva = null;
    await T('crear_usuario: crea el usuario del dueno con una contrasena temporal fuerte (que se muestra una sola vez), lo asigna como dueno y puede iniciar sesion', async () => {
      const email = `dueno-nuevo-${sfx}@prueba-superadmin.example.com`;
      const r = await llamarSA({ accion: 'crear_usuario', email: email.toUpperCase(), restaurante_id: rp.id, rol: 'dueno' });
      if (r.status !== 200) return es(false, `${r.status} ${JSON.stringify(r.cuerpo).slice(0, 200)}`);
      uNuevo = r.cuerpo.usuario; claveNueva = r.cuerpo.password_temporal;
      creados.usuarios.push(uNuevo.id);
      ocultarEnRespuestas(claveNueva); sembrarSecreto(claveNueva);
      const fuerte = typeof claveNueva === 'string' && claveNueva.length >= 18 && /[a-z]/.test(claveNueva) && /[A-Z]/.test(claveNueva) && /\d/.test(claveNueva) && /[^A-Za-z0-9]/.test(claveNueva) && !/[0OIl1]/.test(claveNueva);
      const miembros = await leer('miembros', `user_id=eq.${uNuevo.id}&select=*`);
      const sesion = await iniciarSesionCon(email, claveNueva);
      return es(fuerte && uNuevo.email === email && miembros.length === 1 && miembros[0].restaurante_id === rp.id && miembros[0].rol === 'dueno' && miembros[0].activo
        && !!sesion.access_token && r.cab['Cache-Control'] === 'no-store' && /UNA sola vez/.test(r.cuerpo.aviso), JSON.stringify([fuerte, miembros, !!sesion.access_token, r.cab]).slice(0, 250));
    });
    await T('crear_usuario: dos usuarios seguidos reciben contrasenas distintas; la contrasena NO queda en el log ni en la auditoria', async () => {
      const a = await llamarSA({ accion: 'crear_usuario', email: `cajero-nuevo-${sfx}@prueba-superadmin.example.com`, restaurante_id: rp.id, rol: 'cajero' });
      if (a.status !== 200) return es(false, `${a.status} ${JSON.stringify(a.cuerpo)}`);
      creados.usuarios.push(a.cuerpo.usuario.id); ocultarEnRespuestas(a.cuerpo.password_temporal); sembrarSecreto(a.cuerpo.password_temporal);
      const aud = JSON.stringify((await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo);
      return es(a.cuerpo.password_temporal !== claveNueva && !aud.includes(a.cuerpo.password_temporal) && !aud.includes(claveNueva) && !logs.join('\n').includes(claveNueva) && !logs.join('\n').includes(a.cuerpo.password_temporal), '');
    });
    await T('la contrasena temporal es aleatoria de verdad: 300 seguidas, todas distintas, de 20 caracteres, con las 4 clases, y ningun caracter aparece fijo en ellas', async () => {
      const { generarClaveTemporal } = require(path.join(apiDir, '_auth-admin.js'));
      const claves = Array.from({ length: 300 }, () => generarClaveTemporal());
      const todasBien = claves.every((c) => c.length === 20 && /[A-HJ-NP-Z]/.test(c) && /[a-km-z]/.test(c) && /[2-9]/.test(c) && /[#$%&*+=?@-]/.test(c) && /^[A-HJ-NP-Za-km-z2-9#$%&*+=?@-]+$/.test(c));
      // si el generador pusiera siempre la misma letra de cada clase (p. ej. 'A' x3), casi todas las claves traerian 3 o mas veces esa letra; al azar es rarisimo
      const fijas = ['A', 'a', '2', '#'].map((ch) => claves.filter((c) => c.split(ch).length - 1 >= 3).length / claves.length);
      const posiciones = Array.from({ length: 20 }, (_, i) => new Set(claves.map((c) => c[i])).size);   // en cada posicion tienen que verse muchos caracteres distintos
      return es(new Set(claves).size === 300 && todasBien && fijas.every((f) => f < 0.1) && posiciones.every((n) => n >= 25), JSON.stringify([new Set(claves).size, todasBien, fijas, Math.min(...posiciones)]));
    });
    await T('crear_usuario: un correo que ya existe (409), un correo invalido (400), un rol invalido (400) y un restaurante que no existe (404) no crean ni dejan nada suelto', async () => {
      const usuariosAntes = JSON.parse(await (await fetchReal(`${URL_BASE}/auth/v1/admin/users?per_page=1000`, { headers: H() })).text()).users.length;
      const dup = await llamarSA({ accion: 'crear_usuario', email: uNuevo.email });
      const malc = await llamarSA({ accion: 'crear_usuario', email: 'no-es-un-correo' });
      const malrol = await llamarSA({ accion: 'crear_usuario', email: `x-${sfx}@prueba-superadmin.example.com`, restaurante_id: rp.id, rol: 'rey' });
      const sinrol = await llamarSA({ accion: 'crear_usuario', email: `x-${sfx}@prueba-superadmin.example.com`, restaurante_id: rp.id });
      const noRest = await llamarSA({ accion: 'crear_usuario', email: `y-${sfx}@prueba-superadmin.example.com`, restaurante_id: '00000000-0000-4000-8000-0000000000ee', rol: 'dueno' });
      const usuariosDespues = JSON.parse(await (await fetchReal(`${URL_BASE}/auth/v1/admin/users?per_page=1000`, { headers: H() })).text()).users.length;
      return es(dup.status === 409 && malc.status === 400 && malrol.status === 400 && sinrol.status === 400 && noRest.status === 404 && usuariosAntes === usuariosDespues && !JSON.stringify(dup.cuerpo).includes('password'),
        [dup.status, malc.status, malrol.status, sinrol.status, noRest.status, usuariosAntes, usuariosDespues].join(','));
    });
    await T('buscar_usuario encuentra por correo (sin distinguir mayusculas) y devuelve null si no existe', async () => {
      const a = await llamarSA({ accion: 'buscar_usuario', email: uNuevo.email.toUpperCase() });
      const b = await llamarSA({ accion: 'buscar_usuario', email: `nadie-${sfx}@prueba-superadmin.example.com` });
      return es(a.status === 200 && a.cuerpo.usuario.id === uNuevo.id && b.status === 200 && b.cuerpo.usuario === null && !JSON.stringify(a.cuerpo).includes('password'), JSON.stringify([a.cuerpo, b.cuerpo]));
    });

    // ---- secretos: solo escritura ----
    const SEC = {
      wompi_integridad_test: `test_integrity_${sfx}${crypto.randomBytes(6).toString('hex')}`, wompi_eventos_test: `test_events_${sfx}${crypto.randomBytes(6).toString('hex')}`,
      wompi_integridad_prod: `prod_integrity_${sfx}${crypto.randomBytes(6).toString('hex')}`, wompi_eventos_prod: `prod_events_${sfx}${crypto.randomBytes(6).toString('hex')}`,
      wompi_llave_publica_test: `pub_test_${sfx}${crypto.randomBytes(6).toString('hex')}`, wompi_llave_publica_prod: `pub_prod_${sfx}${crypto.randomBytes(6).toString('hex')}`,
      callmebot_telefono: '57' + String(3100000000 + parseInt(sfx, 16) % 90000000), callmebot_apikey: `CMB-${sfx}-${crypto.randomBytes(6).toString('hex')}`,
      wompi_llave_privada_test: `prv_test_${sfx}${crypto.randomBytes(6).toString('hex')}`, wompi_modo: 'test'
    };
    // (las llaves PUBLICAS de Wompi no son secretos: viajan al navegador por /api/restaurante; el resto si, y el modo de cobro es solo test o produccion)
    const esSecreto = ([k]) => k !== 'wompi_modo' && !k.startsWith('wompi_llave_publica_');
    const SECRETOS_REALES = () => Object.entries(SEC).filter(esSecreto).map(([, v]) => v);
    sembrarSecreto(...SECRETOS_REALES());
    await T('guardar_secretos: guarda Wompi (test y prod), CallMeBot y el modo de cobro; la respuesta dice SOLO si cada uno quedo puesto, sin ningun valor', async () => {
      const r = await llamarSA({ accion: 'guardar_secretos', restaurante_id: rp.id, valores: SEC });
      const texto = JSON.stringify(r.cuerpo);
      const puestos = Object.entries(SEC).filter(([k]) => k !== 'wompi_modo').every(([k]) => r.cuerpo.secretos && r.cuerpo.secretos[k] === true);
      return es(r.status === 200 && r.cuerpo.guardado === true && puestos && r.cuerpo.secretos.wompi_modo === 'test' && Object.values(r.cuerpo.campos).every((v) => v === 'guardado')
        && !Object.values(SEC).some((v) => v.length > 6 && texto.includes(v)) && !('valores' in r.cuerpo) && !('_valores' in r.cuerpo), texto.slice(0, 250));
    });
    await T('lo guardado esta de verdad en la base (leido con la llave de servicio) y NO se puede leer de vuelta por la API: no existe ninguna accion que devuelva un secreto', async () => {
      const f = (await leer('restaurante_secretos', `restaurante_id=eq.${rp.id}&select=*`))[0];
      const ok = f.wompi_integridad_test === SEC.wompi_integridad_test && f.wompi_eventos_prod === SEC.wompi_eventos_prod && f.callmebot_apikey === SEC.callmebot_apikey
        && f.otros.wompi_modo === 'test' && f.otros.wompi_llave_privada_test === SEC.wompi_llave_privada_test;
      // todas las acciones de lectura, con este restaurante: ninguna trae un valor
      const lecturas = [await llamarSA({ accion: 'detalle_restaurante', restaurante_id: rp.id }), await llamarSA({ accion: 'estado_secretos', restaurante_id: rp.id }),
        await llamarSA({ accion: 'listar_restaurantes' }), await llamarSA({ accion: 'listar_auditoria', restaurante_id: rp.id })];
      const texto = JSON.stringify(lecturas.map((x) => x.cuerpo));
      const fuga = SECRETOS_REALES().filter((v) => v.length > 6 && texto.includes(v));
      return es(ok && lecturas.every((x) => x.status === 200) && fuga.length === 0, fuga.length + ' fugas');
    });
    await T('guardar_secretos otra vez con lo mismo: "ya_coincide"; con otro valor sin sobrescribir: "ya_existe_otro_valor" y NO lo pisa; con sobrescribir: "guardado"', async () => {
      const mismo = await llamarSA({ accion: 'guardar_secretos', restaurante_id: rp.id, valores: { callmebot_apikey: SEC.callmebot_apikey } });
      const nuevoValor = `CMB-${sfx}-nuevo${crypto.randomBytes(4).toString('hex')}`; sembrarSecreto(nuevoValor);
      const otro = await llamarSA({ accion: 'guardar_secretos', restaurante_id: rp.id, valores: { callmebot_apikey: nuevoValor } });
      const intacto = (await leer('restaurante_secretos', `restaurante_id=eq.${rp.id}&select=callmebot_apikey`))[0].callmebot_apikey === SEC.callmebot_apikey;
      const pisa = await llamarSA({ accion: 'guardar_secretos', restaurante_id: rp.id, valores: { callmebot_apikey: nuevoValor }, sobrescribir: true });
      const cambio = (await leer('restaurante_secretos', `restaurante_id=eq.${rp.id}&select=callmebot_apikey`))[0].callmebot_apikey === nuevoValor;
      await llamarSA({ accion: 'guardar_secretos', restaurante_id: rp.id, valores: { callmebot_apikey: SEC.callmebot_apikey }, sobrescribir: true });
      return es(mismo.cuerpo.campos.callmebot_apikey === 'ya_coincide' && mismo.cuerpo.guardado === false && otro.cuerpo.campos.callmebot_apikey === 'ya_existe_otro_valor' && otro.cuerpo.guardado === false && intacto
        && pisa.cuerpo.campos.callmebot_apikey === 'guardado' && cambio, JSON.stringify([mismo.cuerpo.campos, otro.cuerpo.campos, pisa.cuerpo.campos]));
    });
    await T('guardar_secretos: formatos no validos se rechazan (400) SIN repetir el valor: campo desconocido, vacio, con espacios, pegado dos veces, telefono con letras, modo inventado, no es texto, objeto vacio', async () => {
      const malos = [];
      const tonto = `SECRETO-TONTO-${sfx}`; sembrarSecreto(tonto);
      const doble = SEC.wompi_eventos_test + SEC.wompi_eventos_test;
      const casos = [['campo desconocido', { clave_inventada: tonto }], ['vacio', { callmebot_apikey: '   ' }], ['con espacios', { callmebot_apikey: 'a ' + tonto }], ['pegado dos veces', { wompi_eventos_test: doble }],
        ['telefono con letras', { callmebot_telefono: 'abc' + tonto }], ['modo inventado', { wompi_modo: tonto }], ['no es texto', { callmebot_apikey: 12345 }], ['objeto vacio', {}], ['llave publica con otro prefijo', { wompi_llave_publica_test: 'pub_prod_' + tonto }]];
      sembrarSecreto(doble);
      for (const [etiqueta, valores] of casos) {
        const r = await llamarSA({ accion: 'guardar_secretos', restaurante_id: rp.id, valores });
        const t = JSON.stringify(r.cuerpo);
        if (r.status !== 400 || t.includes(tonto) || t.includes(doble)) malos.push(`${etiqueta}: ${r.status} ${t.slice(0, 100)}`);
      }
      const sinPerder = (await leer('restaurante_secretos', `restaurante_id=eq.${rp.id}&select=wompi_eventos_test`))[0].wompi_eventos_test === SEC.wompi_eventos_test;
      return es(malos.length === 0 && sinPerder, malos.slice(0, 3).join(' | '));
    });

    // R4: un secreto que ya tiene OTRO restaurante no se guarda (y no se guarda NADA de la llamada)
    await T('un secreto de Wompi que ya tiene OTRO restaurante NO se guarda y no se guarda nada de esa llamada (409); CallMeBot repetido solo con permitir_repetidos; Wompi repetido, nunca', async () => {
      const otro = await llamarSA({ accion: 'crear_restaurante', slug: `${SLUG_PRUEBA}-2`, nombre: `PRUEBA-SUPERADMIN 2 ${sfx}` });
      creados.restaurantes.push(otro.cuerpo.restaurante.id);
      const id2 = otro.cuerpo.restaurante.id;
      const nuevoTel = '57' + String(3200000000 + parseInt(sfx, 16) % 90000000);
      const r1 = await llamarSA({ accion: 'guardar_secretos', restaurante_id: id2, valores: { wompi_eventos_test: SEC.wompi_eventos_test, callmebot_telefono: nuevoTel } });
      const f = (await leer('restaurante_secretos', `restaurante_id=eq.${id2}&select=*`))[0];
      const nadaGuardado = !f.wompi_eventos_test && !f.callmebot_telefono;
      const r2 = await llamarSA({ accion: 'guardar_secretos', restaurante_id: id2, valores: { callmebot_apikey: SEC.callmebot_apikey } });
      const r3 = await llamarSA({ accion: 'guardar_secretos', restaurante_id: id2, valores: { callmebot_apikey: SEC.callmebot_apikey }, permitir_repetidos: true });
      const r4 = await llamarSA({ accion: 'guardar_secretos', restaurante_id: id2, valores: { wompi_integridad_test: SEC.wompi_integridad_test }, permitir_repetidos: true });
      const t = JSON.stringify([r1.cuerpo, r2.cuerpo, r3.cuerpo, r4.cuerpo]);
      return es(r1.status === 409 && r1.cuerpo.bloqueado_por_repetido === true && r1.cuerpo.campos.wompi_eventos_test === 'repetido_en_otro_restaurante' && r1.cuerpo.campos.callmebot_telefono === 'no_guardado' && nadaGuardado
        && r2.status === 409 && r2.cuerpo.campos.callmebot_apikey === 'repetido_en_otro_restaurante'
        && r3.status === 200 && r3.cuerpo.campos.callmebot_apikey === 'guardado' && r4.status === 409 && r4.cuerpo.campos.wompi_integridad_test === 'repetido_en_otro_restaurante'
        && !Object.values(SEC).some((v) => v.length > 6 && t.includes(v)), t.slice(0, 300));
    });
    await T('estado_secretos: solo si/no por campo (y el modo de cobro); un restaurante inexistente es 404', async () => {
      const r = await llamarSA({ accion: 'estado_secretos', restaurante_id: rp.id });
      const nada = await llamarSA({ accion: 'estado_secretos', restaurante_id: '00000000-0000-4000-8000-0000000000ee' });
      return es(r.status === 200 && Object.keys(r.cuerpo.secretos).length === 11 && Object.entries(r.cuerpo.secretos).every(([k, v]) => k === 'wompi_modo' || typeof v === 'boolean') && nada.status === 404, JSON.stringify(r.cuerpo.secretos));
    });

    // ---- el menu del restaurante nuevo no se mezcla con el de Taqueiros ----
    await T('el menu de mr16-prueba NO se mezcla con el de Taqueiros (y viceversa); su estado y sus datos publicos son los suyos', async () => {
      await insertar('categorias', [{ restaurante_id: rp.id, id: 'tacos', nombre: 'Tacos', emoji: '', orden: 1, activa: true }]);
      await insertar('productos', [{ restaurante_id: rp.id, id: 'taco-prueba', nombre: `Taco de prueba ${sfx}`, precio: 12345, categoria: 'tacos', orden: 1, disponible: true }]);
      // abierto todo el dia (el horario inicial es 11:00 a 22:00 y la prueba no debe depender de la hora a la que corra)
      await srv('PATCH', `configuracion?restaurante_id=eq.${rp.id}`, { cerrado_temporal: false, horarios: ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((dia) => ({ dia, abre: '00:00', cierra: '24:00', activo: true })) });
      const mp = await invocar(M.menu, { metodo: 'GET', host: hostPrueba, ruta: '/api/menu' });
      const mt = await invocar(M.menu, { metodo: 'GET', host: HOST_TAQUEIROS, ruta: '/api/menu' });
      const nombresP = (mp.cuerpo.productos || []).map((p) => p.id);
      const nombresT = (mt.cuerpo.productos || []).map((p) => p.id);
      const pub = await invocar(M.restaurante, { metodo: 'GET', host: hostPrueba, ruta: '/api/restaurante' });
      const pubT = await invocar(M.restaurante, { metodo: 'GET', host: HOST_TAQUEIROS, ruta: '/api/restaurante' });
      return es(mp.status === 200 && nombresP.length === 1 && nombresP[0] === 'taco-prueba' && !nombresT.includes('taco-prueba') && (mt.cuerpo.productos || []).every((p) => p.nombre !== `Taco de prueba ${sfx}`)
        && pub.status === 200 && pub.cuerpo.slug === SLUG_PRUEBA && pubT.cuerpo.slug === 'taqueiros' && pub.cuerpo.contacto.whatsapp === '573001112233',
        JSON.stringify([mp.status, nombresP, nombresT.slice(0, 3), pub.cuerpo.slug]));
    });
    await T('mr16-prueba puede cobrar con sus propios secretos: crear-pedido firma con SU secreto de integridad (modo test fijado) y le toca el numero 1', async () => {
      const r = await invocar(M.crear, { host: hostPrueba, ruta: '/api/crear-pedido', cuerpo: { cliente: { nombre: 'Cliente Prueba', telefono: '3001234567', email: 'prueba@example.com', tipoPedido: 'llevar' }, items: [{ id: 'taco-prueba', cantidad: 1, precio: 12345 }], modo: 'produccion' } });
      return es(r.status === 200 && r.cuerpo.numero === 1 && r.cuerpo.firma === sha(`${r.cuerpo.referencia}${r.cuerpo.total * 100}COP${SEC.wompi_integridad_test}`), JSON.stringify(r.cuerpo).slice(0, 200));
    });

    /* =====================================================================
       3. ESTADO, PAGOS, CONFIG, TARIFAS, DOMINIOS Y MIEMBROS
    ===================================================================== */
    grupo('administracion');
    const dia = (n) => { const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(dateNowReal())); return new Date(Date.parse(hoy + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); };
    const actualizar = (cambios) => llamarSA({ accion: 'actualizar_restaurante', restaurante_id: rp.id, cambios });
    const crearPedidoP = () => invocar(M.crear, { host: hostPrueba, ruta: '/api/crear-pedido', cuerpo: { cliente: { nombre: 'Cliente Prueba', telefono: '3001234567', email: 'prueba@example.com', tipoPedido: 'llevar' }, items: [{ id: 'taco-prueba', cantidad: 1, precio: 12345 }], modo: 'test' } });
    await T('actualizar_restaurante: estado, plan, modalidad, dias de gracia, modulos, zona y vigencia; el cambio rige en el acto en el sitio publico (suspender = no se puede pedir, el menu avisa neutro)', async () => {
      const a = await actualizar({ estado: 'activo', plan: 'basico', modalidad_pago: 'unico', dias_gracia: 3, modulos: { pasarela: false }, zona_horaria: 'America/Bogota', vigente_hasta: dia(30), nombre: `PRUEBA-SUPERADMIN ${sfx} (editado)` });
      const pasarelaApagada = await invocar(M.restaurante, { metodo: 'GET', host: hostPrueba, ruta: '/api/restaurante' });
      await actualizar({ modulos: { pasarela: true } });
      // la cache de restaurantes (30 s) se calienta con un menu; el cambio hecho por la API tiene que verse en el MISMO instante, sin esperar
      // (crear-pedido invalida la cache por su cuenta: por eso se mira el menu ANTES de pedir)
      const menuAlDia = await invocar(M.menu, { metodo: 'GET', host: hostPrueba, ruta: '/api/menu' });
      const s = await actualizar({ estado: 'suspendido' });
      const menuSuspInmediato = await invocar(M.menu, { metodo: 'GET', host: hostPrueba, ruta: '/api/menu' });
      const suspendido = await crearPedidoP();
      const menuSusp = await invocar(M.menu, { metodo: 'GET', host: hostPrueba, ruta: '/api/menu' });
      const r = await actualizar({ estado: 'activo' });
      const menuReactivadoInmediato = await invocar(M.menu, { metodo: 'GET', host: hostPrueba, ruta: '/api/menu' });
      const reactivado = await crearPedidoP();
      const e = a.cuerpo.restaurante;
      return es(a.status === 200 && e.estado === 'activo' && e.plan === 'basico' && e.modalidad_pago === 'unico' && e.dias_gracia === 3 && e.modulos.pasarela === false && e.vigente_hasta === dia(30) && e.vigencia.estado === 'activo'
        && pasarelaApagada.cuerpo.modulos.pasarela === false
        && s.cuerpo.restaurante.vigencia.estado === 'suspendido' && suspendido.status === 403 && suspendido.cuerpo.motivo === 'servicio_suspendido' && menuSusp.status === 200 && menuSusp.cuerpo.servicio.sirve === false
        && r.cuerpo.restaurante.vigencia.estado === 'activo' && reactivado.status === 200
        && !('servicio' in menuAlDia.cuerpo) && menuSuspInmediato.cuerpo.servicio && menuSuspInmediato.cuerpo.servicio.sirve === false && !('servicio' in menuReactivadoInmediato.cuerpo),
        JSON.stringify([a.status, suspendido.status, menuSusp.cuerpo.servicio, reactivado.status, menuSuspInmediato.cuerpo.servicio, menuReactivadoInmediato.cuerpo.servicio]));
    });
    await T('actualizar_restaurante: vigencia en el pasado = gracia / vencido y quitar el vencimiento (null); cada estado se refleja en vigencia y en lo que ve el cliente', async () => {
      const gracia = await actualizar({ vigente_hasta: dia(-1), dias_gracia: 5 });
      const pg = await crearPedidoP();
      const vencido = await actualizar({ vigente_hasta: dia(-9) });
      const pv = await crearPedidoP();
      const prueba = await actualizar({ estado: 'prueba', vigente_hasta: dia(5) });
      const sin = await actualizar({ vigente_hasta: null, estado: 'activo' });
      const ps = await crearPedidoP();
      return es(gracia.cuerpo.restaurante.vigencia.estado === 'gracia' && gracia.cuerpo.restaurante.vigencia.dias_para_suspension === 5 && pg.status === 200
        && vencido.cuerpo.restaurante.vigencia.estado === 'vencido' && pv.status === 403
        && prueba.cuerpo.restaurante.vigencia.estado === 'prueba'
        && sin.cuerpo.restaurante.vigencia.estado === 'activo' && sin.cuerpo.restaurante.vigencia.sin_vencimiento === true && ps.status === 200,
        JSON.stringify([gracia.cuerpo.restaurante && gracia.cuerpo.restaurante.vigencia, vencido.cuerpo.restaurante && vencido.cuerpo.restaurante.vigencia]).slice(0, 250));
    });
    await T('actualizar_restaurante: valores y campos no validos se rechazan (400) y no cambian nada', async () => {
      const antes = JSON.stringify(canon((await leer('restaurantes', `id=eq.${rp.id}&select=*`))[0]));
      const malos = [];
      for (const [etiqueta, cambios] of [['estado vencido (se calcula)', { estado: 'vencido' }], ['estado gracia', { estado: 'gracia' }], ['plan inventado', { plan: 'vip' }], ['fecha mala', { vigente_hasta: '2026-02-30' }], ['fecha en texto', { vigente_hasta: 'manana' }],
        ['fecha numerica', { vigente_hasta: 20261231 }], ['fecha lejana', { vigente_hasta: '2999-01-01' }], ['gracia 100', { dias_gracia: 100 }], ['gracia texto', { dias_gracia: '5' }], ['modulo malo', { modulos: { x: true } }], ['modulos vacio', { modulos: {} }],
        ['zona mala', { zona_horaria: 'No/Existe' }], ['slug (no se puede cambiar)', { slug: 'otro' }], ['id', { id: '00000000-0000-4000-8000-000000000001' }], ['config entera', { config: {} }], ['vacio', {}], ['nombre con HTML', { nombre: '<i>x</i>' }]]) {
        const r = await actualizar(cambios);
        if (r.status !== 400) malos.push(`${etiqueta}:${r.status}`);
      }
      const despues = JSON.stringify(canon((await leer('restaurantes', `id=eq.${rp.id}&select=*`))[0]));
      const inex = await llamarSA({ accion: 'actualizar_restaurante', restaurante_id: '00000000-0000-4000-8000-0000000000ee', cambios: { plan: 'basico' } });
      return es(malos.length === 0 && antes === despues && inex.status === 404, malos.join(',') + ' inex ' + inex.status);
    });
    await T('registrar_pago: vencido -> cuenta desde HOY; vigente -> cuenta desde la vigencia actual; en gracia -> desde hoy; la prueba pasa a activo; deja constancia', async () => {
      await actualizar({ estado: 'prueba', vigente_hasta: dia(-20), dias_gracia: 5 });
      const venc = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, meses: 1, monto: 150000, referencia: `REC-${sfx}-1`, nota: 'Pago de prueba' });
      const base1 = new Date(Date.parse(dia(0) + 'T12:00:00Z')); base1.setUTCMonth(base1.getUTCMonth() + 1);
      await actualizar({ estado: 'activo', vigente_hasta: dia(10) });
      const vig = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, meses: 2 });
      const base2 = new Date(Date.parse(dia(10) + 'T12:00:00Z')); base2.setUTCMonth(base2.getUTCMonth() + 2);
      await actualizar({ vigente_hasta: dia(-2) });
      const grac = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, meses: 1 });
      const lunes = (d) => d.toISOString().slice(0, 10);
      return es(venc.status === 200 && venc.cuerpo.pago.contado_desde === dia(0) && venc.cuerpo.pago.estado === 'activo' && venc.cuerpo.pago.vigente_hasta_anterior === dia(-20)
        && vig.cuerpo.pago.contado_desde === dia(10) && vig.cuerpo.pago.vigente_hasta_nueva.slice(0, 7) === lunes(base2).slice(0, 7)
        && grac.cuerpo.pago.contado_desde === dia(0) && grac.cuerpo.pago.vigencia.estado === 'activo' && lunes(base1).slice(0, 7) === venc.cuerpo.pago.vigente_hasta_nueva.slice(0, 7),
        JSON.stringify([venc.cuerpo.pago, vig.cuerpo.pago, grac.cuerpo.pago]).slice(0, 300));
    });
    await T('registrar_pago: sigue SUSPENDIDO si se suspendio a mano (avisa); sin vencimiento no tiene nada que extender (400); meses y datos no validos (400)', async () => {
      await actualizar({ estado: 'suspendido', vigente_hasta: dia(5) });
      const susp = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, meses: 1 });
      const sigue = (await leer('restaurantes', `id=eq.${rp.id}&select=estado`))[0].estado === 'suspendido';
      await actualizar({ estado: 'activo', vigente_hasta: null });
      const sin = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, meses: 1 });
      await actualizar({ vigente_hasta: dia(30) });
      const malos = [];
      for (const [e, extra] of [['0 meses', { meses: 0 }], ['37 meses', { meses: 37 }], ['meses fraccion', { meses: 1.5 }], ['meses texto', { meses: '1' }], ['monto negativo', { meses: 1, monto: -5 }], ['referencia con HTML', { meses: 1, referencia: '<b>' }], ['nota enorme', { meses: 1, nota: 'n'.repeat(301) }], ['campo extra', { meses: 1, extra: 1 }]]) {
        const r = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, ...extra });
        if (r.status !== 400) malos.push(`${e}:${r.status}`);
      }
      return es(susp.status === 200 && susp.cuerpo.pago.estado === 'suspendido' && /SUSPENDIDO/.test(susp.cuerpo.pago.aviso) && sigue && sin.status === 400 && malos.length === 0, JSON.stringify([susp.status, sin.status, malos]));
    });
    await T('registrar_pago: 31 de enero + 1 mes = fin de febrero (no se salta de mes)', async () => {
      await actualizar({ estado: 'activo', vigente_hasta: '2099-01-31', dias_gracia: 5 });
      const r = await llamarSA({ accion: 'registrar_pago', restaurante_id: rp.id, meses: 1 });
      await actualizar({ vigente_hasta: dia(30) });
      return es(r.status === 200 && r.cuerpo.pago.vigente_hasta_nueva === '2099-02-28', JSON.stringify(r.cuerpo.pago));
    });

    const verPublico = () => invocar(M.restaurante, { metodo: 'GET', host: hostPrueba, ruta: '/api/restaurante' });
    await T('editar_config: marca, ubicacion y domicilio se editan con las reglas del SQL 13; el resto de la config queda; lo no valido se rechaza (400) sin cambiar nada; null borra una seccion', async () => {
      const e1 = await llamarSA({ accion: 'editar_config', restaurante_id: rp.id, cambios: { marca: { colores: { primario: '#112233' }, emoji: '🍕' }, domicilio: { factor_recorrido: 1.4 }, ubicacion: { lat: 7.91, lng: -72.51 } } });
      const pub = await verPublico();
      const cfg1 = e1.cuerpo.config;
      const antes = JSON.stringify(canon((await leer('restaurantes', `id=eq.${rp.id}&select=config`))[0].config));
      const malos = [];
      for (const [e, cambios] of [['color malo', { marca: { colores: { primario: 'rojo' } } }], ['logo javascript', { marca: { logo: 'javascript:alert(1)' } }], ['seccion desconocida', { secretos: {} }], ['ubicacion fuera de rango', { ubicacion: { lat: 99, lng: 0 } }],
        ['factor absurdo', { domicilio: { factor_recorrido: 50 } }], ['clave que parece secreto', { marca: { apikey: 'x' } }], ['seccion no objeto', { marca: 'rojo' }], ['seccion lista', { marca: [] }], ['vacio', {}], ['llave publica con otro prefijo', { wompi: { llave_publica_test: 'pub_prod_abcdefghij1' } }]]) {
        const r = await llamarSA({ accion: 'editar_config', restaurante_id: rp.id, cambios });
        if (r.status !== 400) malos.push(`${e}:${r.status}`);
      }
      const despues = JSON.stringify(canon((await leer('restaurantes', `id=eq.${rp.id}&select=config`))[0].config));
      const w = await llamarSA({ accion: 'editar_config', restaurante_id: rp.id, cambios: { wompi: { llave_publica_test: SEC.wompi_llave_publica_test, llave_publica_prod: SEC.wompi_llave_publica_prod } } });
      const borrar = await llamarSA({ accion: 'editar_config', restaurante_id: rp.id, cambios: { domicilio: null } });
      return es(e1.status === 200 && cfg1.publico.marca.colores.primario === '#112233' && cfg1.publico.contacto.whatsapp === '573001112233' && cfg1.ubicacion.lat === 7.91 && cfg1.domicilio.factor_recorrido === 1.4
        && String(pub.cuerpo.marca.colores.primario).toUpperCase() === '#112233' && malos.length === 0 && antes === despues && w.status === 200 && w.cuerpo.config.publico.wompi.llave_publica_test === SEC.wompi_llave_publica_test
        && borrar.status === 200 && !('domicilio' in borrar.cuerpo.config) && borrar.cuerpo.config.publico.marca.emoji === '🍕',
        malos.join(',') + ' ' + JSON.stringify(e1.cuerpo).slice(0, 120));
    });
    await T('guardar_tarifas: reemplaza las tarifas (se ven en los datos publicos), [] no ofrece domicilio, y lo no valido se rechaza (400) sin cambiar nada', async () => {
      const t1 = await llamarSA({ accion: 'guardar_tarifas', restaurante_id: rp.id, tarifas: [{ hasta: 2, precio: 4000 }, { hasta: 5.5, precio: 7000 }, { hasta: 999, precio: null }] });
      const pub = await verPublico();
      const malos = [];
      for (const [e, tarifas] of [['hasta 0', [{ hasta: 0, precio: 1 }]], ['hasta negativo', [{ hasta: -1, precio: 1 }]], ['hasta enorme', [{ hasta: 1001, precio: 1 }]], ['dos decimales', [{ hasta: 1.25, precio: 1 }]], ['repetido', [{ hasta: 2, precio: 1 }, { hasta: 2, precio: 2 }]],
        ['precio negativo', [{ hasta: 2, precio: -5 }]], ['precio enorme', [{ hasta: 2, precio: 500001 }]], ['precio fraccion', [{ hasta: 2, precio: 10.5 }]], ['precio texto', [{ hasta: 2, precio: '5' }]], ['campo de mas', [{ hasta: 2, precio: 1, extra: 1 }]],
        ['no es objeto', [5]], ['21 tramos', Array.from({ length: 21 }, (_, i) => ({ hasta: i + 1, precio: 1 }))], ['hasta texto', [{ hasta: '2', precio: 1 }]]]) {
        const r = await llamarSA({ accion: 'guardar_tarifas', restaurante_id: rp.id, tarifas });
        if (r.status !== 400) malos.push(`${e}:${r.status}`);
      }
      const nolista = await llamarSA({ accion: 'guardar_tarifas', restaurante_id: rp.id, tarifas: 'x' });
      const intactas = (await leer('tarifas_domicilio', `restaurante_id=eq.${rp.id}&select=hasta,precio&order=hasta.asc`)).length === 3;
      const vacio = await llamarSA({ accion: 'guardar_tarifas', restaurante_id: rp.id, tarifas: [] });
      const pub2 = await verPublico();
      return es(t1.status === 200 && t1.cuerpo.tarifas.length === 3 && pub.cuerpo.domicilio.tarifas.length === 3 && pub.cuerpo.domicilio.tarifas[1].hasta === 5.5 && pub.cuerpo.domicilio.tarifas[2].precio === null
        && malos.length === 0 && nolista.status === 400 && intactas && vacio.status === 200 && vacio.cuerpo.tarifas.length === 0 && pub2.cuerpo.domicilio.ofrece === false, malos.join(',') + ' ' + JSON.stringify(pub.cuerpo.domicilio).slice(0, 120));
    });
    await T('dominios: agregar uno lo hace servir el sitio de ese restaurante; repetido 409; invalido 400; quitar lo deja en 404; quitar uno que no existe 404', async () => {
      const host2 = `www.${SLUG_PRUEBA}-${sfx}.mr-prueba.test`;
      const a = await llamarSA({ accion: 'agregar_dominio', restaurante_id: rp.id, host: host2.toUpperCase() });
      const m = await invocar(M.menu, { metodo: 'GET', host: host2, ruta: '/api/menu' });
      const dup = await llamarSA({ accion: 'agregar_dominio', restaurante_id: rp.id, host: host2 });
      const dupOtro = await llamarSA({ accion: 'agregar_dominio', restaurante_id: rA.id, host: host2 });
      const mal = await llamarSA({ accion: 'agregar_dominio', restaurante_id: rp.id, host: 'a b' });
      const equivocado = await llamarSA({ accion: 'quitar_dominio', restaurante_id: rA.id, host: host2 });
      const q = await llamarSA({ accion: 'quitar_dominio', restaurante_id: rp.id, host: host2 });
      const m2 = await invocar(M.menu, { metodo: 'GET', host: host2, ruta: '/api/menu' });
      const q2 = await llamarSA({ accion: 'quitar_dominio', restaurante_id: rp.id, host: host2 });
      return es(a.status === 200 && m.status === 200 && m.cuerpo.productos.length === 1 && dup.status === 409 && dupOtro.status === 409 && mal.status === 400 && equivocado.status === 404 && q.status === 200 && m2.status === 404 && q2.status === 404,
        [a.status, m.status, dup.status, dupOtro.status, mal.status, equivocado.status, q.status, m2.status, q2.status].join(','));
    });
    await T('miembros: asignar con cada rol, cambiar el rol, quitar; rol o usuario no validos se rechazan; el usuario ve su membresia con SU sesion', async () => {
      const a = await llamarSA({ accion: 'asignar_miembro', restaurante_id: rp.id, usuario_id: uSin.id, rol: 'cocina' });
      const tUsuario = sesiones['sin membresia'];
      const suya = await fetchReal(`${URL_BASE}/rest/v1/miembros?select=rol,restaurante_id,activo`, { headers: { apikey: PUB, Authorization: 'Bearer ' + tUsuario } });
      const filas = JSON.parse(await suya.text());
      const cambia = await llamarSA({ accion: 'asignar_miembro', restaurante_id: rp.id, usuario_id: uSin.id, rol: 'cajero' });
      const rol = (await leer('miembros', `user_id=eq.${uSin.id}&restaurante_id=eq.${rp.id}&select=rol`))[0].rol;
      const malRol = await llamarSA({ accion: 'asignar_miembro', restaurante_id: rp.id, usuario_id: uSin.id, rol: 'rey' });
      const noUser = await llamarSA({ accion: 'asignar_miembro', restaurante_id: rp.id, usuario_id: '00000000-0000-4000-8000-0000000000ee', rol: 'dueno' });
      const noRest = await llamarSA({ accion: 'asignar_miembro', restaurante_id: '00000000-0000-4000-8000-0000000000ee', usuario_id: uSin.id, rol: 'dueno' });
      const q = await llamarSA({ accion: 'quitar_miembro', restaurante_id: rp.id, usuario_id: uSin.id });
      const q2 = await llamarSA({ accion: 'quitar_miembro', restaurante_id: rp.id, usuario_id: uSin.id });
      const restan = (await leer('miembros', `user_id=eq.${uSin.id}&select=*`)).length;
      return es(a.status === 200 && filas.length === 1 && filas[0].restaurante_id === rp.id && filas[0].rol === 'cocina' && cambia.status === 200 && rol === 'cajero' && malRol.status === 400 && noUser.status === 404 && noRest.status === 404
        && q.status === 200 && q2.status === 404 && restan === 0, [a.status, filas.length, cambia.status, rol, malRol.status, noUser.status, noRest.status, q.status, q2.status, restan].join(','));
    });
    await T('listar_restaurantes y detalle_restaurante: traen todos (Taqueiros sin vencimiento incluido) con vigencia, dominios y miembros, y NINGUN secreto', async () => {
      const l = await llamarSA({ accion: 'listar_restaurantes' });
      const d = await llamarSA({ accion: 'detalle_restaurante', restaurante_id: rp.id });
      const taq = l.cuerpo.restaurantes.find((x) => x.id === TAQUEIROS_ID);
      const texto = JSON.stringify([l.cuerpo, d.cuerpo]);
      const miembro = d.cuerpo.restaurante.miembros.find((m) => m.user_id === uNuevo.id);
      return es(l.status === 200 && taq && taq.slug === 'taqueiros' && taq.vigencia.sin_vencimiento === true && taq.vigencia.sirve === true && l.cuerpo.restaurantes.some((x) => x.slug === SLUG_PRUEBA)
        && d.status === 200 && miembro && miembro.rol === 'dueno' && miembro.email === uNuevo.email && igual(d.cuerpo.restaurante.dominios, [hostPrueba])
        && !SECRETOS_REALES().some((v) => v.length > 6 && texto.includes(v)) && !('restaurante_secretos' in d.cuerpo.restaurante), JSON.stringify(taq && taq.vigencia));
    });

    /* =====================================================================
       4. AUDITORIA, SECRETOS EN NINGUN SITIO, Y TAQUEIROS INTACTO
    ===================================================================== */
    grupo('auditoria');
    await T('listar_auditoria: deja constancia de cada accion (quien, cuando, restaurante, accion y un resumen) en orden, y se puede filtrar por restaurante y paginar', async () => {
      const todo = await llamarSA({ accion: 'listar_auditoria', limite: 200 });
      const deP = await llamarSA({ accion: 'listar_auditoria', restaurante_id: rp.id, limite: 200 });
      const acciones = new Set(deP.cuerpo.auditoria.map((x) => x.accion));
      const esperadas = ['crear_restaurante', 'crear_usuario', 'asignar_miembro', 'guardar_secretos', 'actualizar_restaurante', 'registrar_pago', 'editar_config', 'guardar_tarifas', 'agregar_dominio', 'quitar_dominio', 'quitar_miembro'];
      const faltan = esperadas.filter((a) => !acciones.has(a));
      const ids = todo.cuerpo.auditoria.map((x) => x.id);
      const ordenado = ids.every((x, i) => i === 0 || ids[i - 1] > x);
      const primera = deP.cuerpo.auditoria[deP.cuerpo.auditoria.length - 1];
      const pag = await llamarSA({ accion: 'listar_auditoria', limite: 2 });
      const pag2 = await llamarSA({ accion: 'listar_auditoria', limite: 2, antes_de: pag.cuerpo.auditoria[1].id });
      const pago = deP.cuerpo.auditoria.find((x) => x.accion === 'registrar_pago');
      return es(faltan.length === 0 && ordenado && primera.accion === 'crear_restaurante' && primera.actor === uSuper.id && primera.actor_email === uSuper.email && primera.restaurante_slug === SLUG_PRUEBA && primera.creado_en
        && pag.cuerpo.auditoria.length === 2 && pag2.cuerpo.auditoria.length >= 1 && pag2.cuerpo.auditoria[0].id < pag.cuerpo.auditoria[1].id && pago.resumen.meses >= 1 && ('vigente_hasta_nueva' in pago.resumen),
        'faltan: ' + faltan.join(','));
    });
    await T('la auditoria registra tambien al segundo superadmin y no mezcla actores', async () => {
      const r = await llamar(tSuper2, { accion: 'actualizar_restaurante', restaurante_id: rp.id, cambios: { plan: 'comandas' } });
      const a = await llamar(tSuper2, { accion: 'listar_auditoria', restaurante_id: rp.id, limite: 1 });
      await actualizar({ plan: 'completo' });
      return es(r.status === 200 && a.cuerpo.auditoria[0].actor === uSuper2.id && a.cuerpo.auditoria[0].resumen.despues.plan === 'comandas' && a.cuerpo.auditoria[0].resumen.antes.plan, JSON.stringify(a.cuerpo.auditoria[0]).slice(0, 200));
    });
    await T('SECRETOS: ningun valor secreto, ni contrasena temporal, ni token aparece en la auditoria, ni en ninguna respuesta de la API, ni en el log de la corrida', async () => {
      const aud = JSON.stringify((await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo);
      const todo = respuestas.join('\n') + '\n' + logs.join('\n') + '\n' + aud;
      const fugas = secretosUsados.filter((s) => s && String(s).length > 6 && todo.includes(s));
      return es(fugas.length === 0 && respuestas.length > 200 && aud.length > 500, `${fugas.length} fugas; ${respuestas.length} respuestas; ${fugas.map((s) => s.slice(0, 10) + '...').join(',')}`);
    });
    await T('la auditoria no guarda ni siquiera patrones de secretos (prv_, *_integrity_, *_events_, sb_secret_, eyJ...)', async () => {
      const aud = JSON.stringify((await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo);
      return es(!/prv_(test|prod)_|(test|prod)_(integrity|events)_|sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(aud), '');
    });
    await T('el servidor solo habla con la base por 4 caminos: validar la sesion, mirar la tabla superadmins, las funciones sa_* y la API de administracion de Auth (nada de tablas de negocio)', async () => {
      // se revisa todo lo que el manejador de superadmin pidio a Supabase en toda la corrida
      const permitidas = [/\/auth\/v1\/user$/, /\/rest\/v1\/superadmins\?user_id=eq\.[0-9a-f-]+&select=user_id&limit=1$/, /\/rest\/v1\/rpc\/sa_[a-z_]+$/, /\/auth\/v1\/admin\/users(\?page=\d+&per_page=\d+|\/[0-9a-f-]+)?$/];
      const raras = registro.filter((x) => /^https?:/.test(x.url) && (x.url.includes('/rpc/') || x.url.includes('/auth/') || x.url.includes('/superadmins'))).filter((x) => !permitidas.some((p) => p.test(x.url)));
      return es(raras.length === 0, raras.slice(0, 3).map((x) => x.metodo + ' ' + x.url.slice(URL_BASE.length)).join(' | '));
    });
    await T('TAQUEIROS QUEDO EXACTAMENTE IGUAL (su fila, configuracion, secretos, tarifas, dominios, miembros y pedidos)', async () => {
      const despues = await huellaTaq();
      return es(despues === taqAntes, 'la huella de Taqueiros cambio');
    });
  } finally {
    // ---- limpieza (siempre) ---------------------------------------------------------------------
    globalThis.fetch = fetchReal;
    Date.now = dateNowReal;
    for (const n of Object.keys(consolaReal)) console[n] = consolaReal[n];
    let fallosLimpieza = [];
    try { fallosLimpieza = await barrer(); } catch (e) { fallosLimpieza = ['limpieza: ' + e.message]; }
    try { await fetchReal(`${URL_BASE}/rest/v1/rpc/realinear_secuencia_pedidos`, { method: 'POST', headers: H(), body: '{}' }); } catch (e) { /* no es critico */ }
    for (const k of Object.keys(process.env)) if (!(k in entornoOriginal)) delete process.env[k];
    Object.assign(process.env, entornoOriginal);
    resultados.limpieza = fallosLimpieza.concat(barridoInicial.map((x) => 'barrido inicial: ' + x));
  }
  return { resultados, limpieza: resultados.limpieza };
}
