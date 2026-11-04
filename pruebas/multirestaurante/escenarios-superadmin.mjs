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
const totp = require('./totp.js');
const TAQUEIROS_ID = '00000000-0000-4000-8000-000000000001';
const HOST_TAQUEIROS = 'taqueiros-2-0.vercel.app';
const SLUG_PRUEBA = 'mr16-prueba';

/* opts.grupos: que grupos correr. 'base' = los de siempre (permisos, alta, secretos, auditoria, Taqueiros intacto); 'mfa' = la verificacion
   en dos pasos (aal1 / aal2); 'lecturas' = "entrar como" de solo lectura y la constancia de los rechazos (necesita el SQL 19).
   opts.sql19 = false: el SQL 19 NO esta aplicado (la corrida comprueba que el servidor nuevo sigue bien sin el: las lecturas
   avisan que falta y lo demas funciona igual). opts.hooks: ganchos del Supabase FALSO (registrarToken, fabricarToken, b64);
   contra la base real no hay. */
export async function correrSuperadmin(opts) {
  const { apiDir, urlBase, llaveServicio, llavePublicable = '', real = false, grupos = ['base', 'mfa', 'lecturas'], sql19 = true, hooks = {} } = opts;
  const quiere = (g) => grupos.includes(g);
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
  /* Sube una persona a aal2 con un TOTP DE VERDAD, por las rutas de Auth (en el falso o en la base real): inicia sesion (aal1), enrola un
     factor TOTP, lo desafia y lo verifica con el codigo calculado aqui (RFC 6238, sin dependencias). Devuelve la sesion aal2.
     El secreto TOTP y el codigo viven solo en memoria: nunca se imprimen ni se guardan. */
  async function elevarAal2(u) {
    const token1 = await iniciarSesion(u);
    const cab = { apikey: llavePublicable || llaveServicio, Authorization: 'Bearer ' + token1, 'Content-Type': 'application/json' };
    const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { texto: t.slice(0, 120) }; } };
    const enrolado = await fetchReal(`${URL_BASE}/auth/v1/factors`, { method: 'POST', headers: cab, body: JSON.stringify({ factor_type: 'totp', friendly_name: 'prueba-' + sfx + '-' + crypto.randomBytes(2).toString('hex'), issuer: 'prueba-superadmin' }) });
    const f = await json(enrolado);
    if (!enrolado.ok || !f.id || !f.totp || !f.totp.secret) throw new Error('no se pudo enrolar el TOTP de ' + u.email + ' (HTTP ' + enrolado.status + '): ' + JSON.stringify(f).replace(/"secret":"[^"]*"/g, '"secret":"..."').slice(0, 160));
    sembrarSecreto(f.totp.secret);
    const desafio = await fetchReal(`${URL_BASE}/auth/v1/factors/${f.id}/challenge`, { method: 'POST', headers: cab, body: '{}' });
    const d = await json(desafio);
    if (!desafio.ok || !d.id) throw new Error('no se pudo desafiar el TOTP (HTTP ' + desafio.status + '): ' + JSON.stringify(d).slice(0, 160));
    const verificado = await fetchReal(`${URL_BASE}/auth/v1/factors/${f.id}/verify`, { method: 'POST', headers: cab, body: JSON.stringify({ challenge_id: d.id, code: totp.codigoTotp(f.totp.secret, dateNowReal()) }) });
    const v = await json(verificado);
    if (!verificado.ok || !v.access_token) throw new Error('no se pudo verificar el TOTP (HTTP ' + verificado.status + '): ' + JSON.stringify(v).slice(0, 160));
    sembrarSecreto(v.access_token);
    return { token: v.access_token, token1 };
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

    // Desde el paso 3B (parte 1) el servidor exige aal2: los superadmins entran con un segundo factor TOTP real (aal2). tSuper1 / tSuper2_1 son sus
    // sesiones aal1 (solo contrasena), para las pruebas de la MFA.
    const sSuper = await elevarAal2(uSuper);
    const sSuper2 = await elevarAal2(uSuper2);
    const tSuper = sSuper.token, tSuper1 = sSuper.token1;
    const tSuper2 = sSuper2.token, tSuper2_1 = sSuper2.token1;
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

    if (quiere('base')) {
    await T(`la lista de acciones es la esperada (${ACCIONES.length}) y 'yo' funciona para un superadmin`, async () => {
      const y = await llamar(tSuper, { accion: 'yo' });
      return es(ACCIONES.length === 22 && y.status === 200 && y.cuerpo.ok === true && y.cuerpo.usuario.id === uSuper.id && y.cuerpo.es_superadmin === true, `${ACCIONES.length} ${y.status} ${JSON.stringify(y.cuerpo)}`);
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
    } // fin del grupo 'base'

    /* =====================================================================
       5. MFA (paso 3B, parte 1): sesion aal1 (solo contrasena) contra aal2 (con segundo factor TOTP)
          Cada superadmin de estas pruebas tiene un TOTP REAL (enrolado y verificado por las rutas de Auth).
    ===================================================================== */
    let ipContador = 0;
    const ipN = () => '10.50.' + Math.floor(ipContador / 250) + '.' + ((ipContador++ % 250) + 1);
    const normalizar = (x) => x.metodo + ' ' + x.url.replace(URL_BASE, '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID');
    const CUERPO_MFA = { error: 'Activa o confirma la verificación en dos pasos', codigo: 'mfa_requerida', aal: 'aal1' };
    const ACC_SIN_ESTADO = ACCIONES.filter((a) => a !== 'mi_estado');
    const PUB2 = llavePublicable || 'sb_publishable_FAKE_0000';
    const rpcComo = async (fn, args, { llave, token }) => {
      const r = await fetchReal(`${URL_BASE}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: llave, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(args) });
      return { status: r.status, texto: await r.text() };
    };

    if (quiere('mfa')) {
      grupo('mfa');
      SA.reiniciarLimite();
      const uMfaDueno = await crearUsuarioAuth('mfa-dueno');
      const uMfaSin = await crearUsuarioAuth('mfa-sin');
      sembrarSecreto(uMfaDueno.password, uMfaSin.password);
      await insertar('miembros', [{ user_id: uMfaDueno.id, restaurante_id: rA.id, rol: 'dueno', activo: true }]);
      const tMfaDueno = (await elevarAal2(uMfaDueno)).token;   // un dueno CON segundo factor: sigue sin ser superadmin
      const tMfaSin = (await elevarAal2(uMfaSin)).token;
      const huellaGlobal = async () => sha(JSON.stringify([await estadoBase(), await secretosHuella()]));
      const cargaDe = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'));
      const reponer = (t, carga) => t.split('.')[0] + '.' + Buffer.from(JSON.stringify(carga)).toString('base64url') + '.' + t.split('.')[2];

      await T('las sesiones de la prueba son lo que dicen ser: la de contrasena es aal1 y la verificada con TOTP es aal2 (con TOTP en amr)', async () => {
        const a1 = cargaDe(tSuper1), a2 = cargaDe(tSuper);
        return es(a1.aal === 'aal1' && !(a1.amr || []).some((m) => /totp/i.test(m.method)) && a2.aal === 'aal2' && (a2.amr || []).some((m) => /totp/i.test(m.method)) && a2.sub === uSuper.id && a1.sub === uSuper.id,
          JSON.stringify([a1.aal, a1.amr, a2.aal, a2.amr]));
      });
      await T('mi_estado: un superadmin sin MFA (aal1) lo consulta y ve aal1; con MFA ve aal2; los dos ven mfa_requerida', async () => {
        const a = await llamar(tSuper1, { accion: 'mi_estado' }, { ip: ipN() });
        const b = await llamar(tSuper, { accion: 'mi_estado' }, { ip: ipN() });
        return es(a.status === 200 && igual(a.cuerpo, { ok: true, es_superadmin: true, aal: 'aal1', mfa_requerida: true }) && b.status === 200 && igual(b.cuerpo, { ok: true, es_superadmin: true, aal: 'aal2', mfa_requerida: true }),
          JSON.stringify([a.cuerpo, b.cuerpo]));
      });
      await T('mi_estado dice la verdad aunque el cliente mienta: cabeceras y parametros con "aal2" no cambian nada (los campos de mas se rechazan con 400)', async () => {
        const cabecera = await llamar(tSuper1, { accion: 'mi_estado' }, { ip: ipN(), headers: { 'x-aal': 'aal2', aal: 'aal2', 'x-supabase-aal': 'aal2', 'x-mfa': 'true', 'x-forwarded-aal': 'aal2' } });
        const campo = await llamar(tSuper1, { accion: 'mi_estado', aal: 'aal2' }, { ip: ipN() });
        const campo2 = await llamar(tSuper1, { accion: 'mi_estado', mfa: true, amr: ['totp'] }, { ip: ipN() });
        const otra = await llamar(tSuper1, { accion: 'listar_restaurantes', aal: 'aal2', mfa: true }, { ip: ipN(), headers: { 'x-aal': 'aal2' } });
        return es(cabecera.status === 200 && cabecera.cuerpo.aal === 'aal1' && campo.status === 400 && campo2.status === 400 && otra.status === 403 && otra.cuerpo.codigo === 'mfa_requerida',
          [cabecera.status, cabecera.cuerpo.aal, campo.status, campo2.status, otra.status].join(','));
      });
      await T(`SUPERADMIN SIN MFA (aal1): las ${ACC_SIN_ESTADO.length} acciones (las 17 de antes y las nuevas) responden 403 con el codigo estable mfa_requerida y el mensaje en español; la base no cambia y el servidor no llama a ninguna funcion sa_* (salvo la constancia del rechazo)`, async () => {
        const antes = await huellaGlobal();
        const desde = rastro();
        const malas = [];
        for (const a of ACC_SIN_ESTADO) {
          const r = await llamar(tSuper1, lleno(a), { ip: ipN() });
          if (r.status !== 403 || !igual(r.cuerpo, CUERPO_MFA)) malas.push(`${a}:${r.status}`);
        }
        const hechas = registro.slice(desde);
        const extra = hechas.filter((x) => (/\/rpc\/sa_/.test(x.url) && !/\/rpc\/sa_registrar_rechazo_mfa$/.test(x.url)) || /\/auth\/v1\/admin\//.test(x.url));
        const constancias = hechas.filter((x) => /\/rpc\/sa_registrar_rechazo_mfa$/.test(x.url)).length;
        return es(malas.length === 0 && extra.length === 0 && constancias <= 1 && (await huellaGlobal()) === antes, malas.join(',') + ' extra:' + extra.length + ' constancias:' + constancias);
      });
      await T('el segundo superadmin sin MFA tampoco puede nada, y su rechazo es independiente del primero', async () => {
        const r = await llamar(tSuper2_1, { accion: 'listar_restaurantes' }, { ip: ipN() });
        const e = await llamar(tSuper2_1, { accion: 'mi_estado' }, { ip: ipN() });
        return es(r.status === 403 && igual(r.cuerpo, CUERPO_MFA) && e.status === 200 && e.cuerpo.aal === 'aal1', JSON.stringify([r.status, r.cuerpo, e.status, e.cuerpo]));
      });
      await T('SUPERADMIN SIN MFA: un cuerpo roto, vacio o con una accion que no existe tambien da 403 mfa_requerida (no 400): sin MFA no se aprende nada, ni siquiera que una accion existe', async () => {
        const casos = [undefined, null, 'texto', [], {}, { accion: 'no_existe' }, { accion: '__proto__' }, { accion: 7 }, { accion: ['yo'] }, { accion: 'yo' }, { accion: 'MI_ESTADO' }, { accion: 'mi_estado ' }];
        const malos = [];
        for (const c of casos) { const r = await llamar(tSuper1, c, { ip: ipN() }); if (r.status !== 403 || !igual(r.cuerpo, CUERPO_MFA)) malos.push(`${JSON.stringify(c)}:${r.status}`); }
        const m = await llamar(tSuper1, JSON.stringify({ accion: 'mi_estado' }), { ip: ipN() });   // el cuerpo puede llegar como texto JSON
        return es(malos.length === 0 && m.status === 200 && m.cuerpo.aal === 'aal1', malos.join(','));
      });
      await T('SUPERADMIN CON MFA (aal2): pasa la verificacion y llega a la accion (accion desconocida 400, falta de datos 400, metodos que no son POST 405); el 401 y el 405 no cambiaron', async () => {
        const a = await llamar(tSuper, { accion: 'no_existe' }, { ip: ipN() });
        const b = await llamar(tSuper, { accion: 'detalle_restaurante' }, { ip: ipN() });
        const c = await llamar(tSuper, { accion: 'listar_restaurantes' }, { ip: ipN() });
        const d = await llamar(tSuper, undefined, { metodo: 'GET', ip: ipN() });
        const e = await llamar(null, { accion: 'mi_estado' }, { ip: ipN() });
        return es(a.status === 400 && b.status === 400 && c.status === 200 && Array.isArray(c.cuerpo.restaurantes) && d.status === 405 && e.status === 401, [a.status, b.status, c.status, d.status, e.status].join(','));
      });
      await T(`UN NO-SUPERADMIN recibe EXACTAMENTE lo mismo con aal1 que con aal2 en las ${ACCIONES.length} acciones: 403 {"error":"No autorizado"} sin codigo ni aal, y el servidor hace las mismas peticiones (no se puede distinguir a un superadmin por su MFA)`, async () => {
        const malas = [];
        for (const a of ACCIONES) {
          const d1 = rastro(); const r1 = await llamar(sesiones['sin membresia'], lleno(a), { ip: ipN() }); const p1 = registro.slice(d1).map(normalizar);
          const d2 = rastro(); const r2 = await llamar(tMfaSin, lleno(a), { ip: ipN() }); const p2 = registro.slice(d2).map(normalizar);
          if (r1.status !== 403 || r2.status !== 403 || !igual(r1.cuerpo, { error: 'No autorizado' }) || !igual(r1.cuerpo, r2.cuerpo) || JSON.stringify(r1.cab) !== JSON.stringify(r2.cab) || JSON.stringify(p1) !== JSON.stringify(p2)) malas.push(a);
        }
        const dd = await llamar(tMfaDueno, { accion: 'mi_estado' }, { ip: ipN() });   // un dueno con MFA preguntando su estado: igual de generico
        return es(malas.length === 0 && dd.status === 403 && igual(dd.cuerpo, { error: 'No autorizado' }), malas.join(',') + ' ' + dd.status);
      });
      await T('un dueno CON MFA y un dueno sin MFA reciben el mismo 403 generico tambien en yo (tener un segundo factor no convierte a nadie en superadmin)', async () => {
        const a = await llamar(tMfaDueno, { accion: 'yo' }, { ip: ipN() });
        const b = await llamar(sesiones.dueno, { accion: 'yo' }, { ip: ipN() });
        return es(a.status === 403 && b.status === 403 && igual(a.cuerpo, b.cuerpo), JSON.stringify([a.cuerpo, b.cuerpo]));
      });
      await T('un superadmin sin MFA NO suma intentos fallidos (no se bloquea a si mismo: 25 seguidos, ninguno 429) y despues, con MFA, entra desde la misma IP; un no-superadmin SI suma', async () => {
        SA.reiniciarLimite();
        const ip = '203.0.113.90';
        const rs = [];
        for (let i = 0; i < 25; i++) rs.push((await llamar(tSuper1, { accion: 'yo' }, { ip })).status);
        const bien = await llamar(tSuper, { accion: 'yo' }, { ip });
        const ip2 = '203.0.113.91';
        const sin = [];
        for (let i = 0; i < 10; i++) sin.push((await llamar(tMfaSin, { accion: 'yo' }, { ip: ip2 })).status);
        const once = await llamar(tMfaSin, { accion: 'yo' }, { ip: ip2 });
        SA.reiniciarLimite();
        return es(rs.every((x) => x === 403) && bien.status === 200 && sin.every((x) => x === 403) && once.status === 429, [rs.join(''), bien.status, once.status].join(' '));
      });
      await T('TOKEN CON EL AAL MANIPULADO O SIN FIRMA VALIDA: 401 (la firma ya no coincide), nunca 403 ni 200; incluye un aal1 maquillado de aal2, alg none, el sub cambiado y mezclar carga y firma de dos sesiones', async () => {
        const cA1 = cargaDe(tSuper1), cA2 = cargaDe(tSuper);
        const [h1, , s1] = tSuper1.split('.'), [h2, , s2] = tSuper.split('.');
        const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const tokens = {
          'aal1 maquillado de aal2': reponer(tSuper1, { ...cA1, aal: 'aal2', amr: [{ method: 'totp', timestamp: 1 }, ...(cA1.amr || [])] }),
          'solo el aal cambiado': reponer(tSuper1, { ...cA1, aal: 'aal2' }),
          'alg none sin firma': b64u({ alg: 'none', typ: 'JWT' }) + '.' + b64u(cA2) + '.',
          'alg none con firma vacia': b64u({ alg: 'none', typ: 'JWT' }) + '.' + b64u(cA2),
          'alg HS256 inventado': b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u(cA2) + '.' + crypto.createHmac('sha256', 'secreto-inventado').update('x').digest('base64url'),
          'sub de un dueno con la firma del superadmin': reponer(tSuper, { ...cA2, sub: uDueno.id }),
          'carga aal2 con la firma de la sesion aal1': h2 + '.' + tSuper.split('.')[1] + '.' + s1,
          'carga aal1 con la firma de la sesion aal2': h1 + '.' + tSuper1.split('.')[1] + '.' + s2,
          'aal2 con un caracter de la firma cambiado': tSuper.slice(0, -3) + (tSuper.endsWith('AAA') ? 'BBB' : 'AAA'),
          'aal2 partido': tSuper.slice(0, Math.floor(tSuper.length / 2))
        };
        const malos = [];
        for (const [nombre, t] of Object.entries(tokens)) {
          for (const accion of ['mi_estado', 'yo']) {
            const r = await llamar(t, { accion }, { ip: ipN(), headers: { authorization: 'Bearer ' + t } });
            if (r.status !== 401) malos.push(`${nombre}/${accion}:${r.status}`);
          }
        }
        return es(malos.length === 0, malos.slice(0, 4).join(' | '));
      });
      if (hooks.registrarToken && hooks.fabricarToken) {
        await T('LO QUE SE HACE CON LOS CLAIMS DE UN TOKEN QUE AUTH YA ACEPTO (falso): aal2 solo si el sub es el mismo, aal es exactamente aal2 y amr trae TOTP; cualquier otra cosa es aal1 (403 mfa_requerida, nunca 500) y un token bien formado si pasa', async () => {
          const b64u = hooks.b64;
          const firma = 'x'.repeat(86);
          const forjar = (carga, uid = uSuper.id) => { const t = b64u({ alg: 'ES256', typ: 'JWT' }) + '.' + (typeof carga === 'string' ? carga : b64u(carga)) + '.' + firma + crypto.randomBytes(3).toString('hex'); hooks.registrarToken(t, uid); return t; };
          const ahoraS = Math.floor(dateNowReal() / 1000);
          const buena = { sub: uSuper.id, aal: 'aal2', amr: [{ method: 'totp', timestamp: ahoraS }], role: 'authenticated' };
          const casos = {
            'sub de otra persona': { ...buena, sub: uSuper2.id }, 'sin sub': { aal: 'aal2', amr: buena.amr }, 'aal2 sin amr': { sub: uSuper.id, aal: 'aal2' },
            'amr solo con contrasena': { ...buena, amr: [{ method: 'password', timestamp: ahoraS }] }, 'amr vacio': { ...buena, amr: [] }, 'amr no es lista': { ...buena, amr: 'totp' },
            'aal escrito distinto': { ...buena, aal: 'AAL2' }, 'aal numerico': { ...buena, aal: 2 }, 'aal2 solo en user_metadata': { sub: uSuper.id, aal: 'aal1', user_metadata: { aal: 'aal2', amr: [{ method: 'totp' }] }, app_metadata: { aal: 'aal2' } },
            'carga que no es json': Buffer.from('esto no es json').toString('base64url'), 'carga vacia': '', 'carga con caracteres raros': '@@@@', 'carga es una lista': [buena], 'carga es null': 'bnVsbA'
          };
          const malos = [];
          for (const [nombre, carga] of Object.entries(casos)) {
            const r = await llamar(forjar(carga), { accion: 'yo' }, { ip: ipN() });
            const e = await llamar(forjar(carga), { accion: 'mi_estado' }, { ip: ipN() });
            if (r.status !== 403 || !igual(r.cuerpo, CUERPO_MFA) || e.status !== 200 || e.cuerpo.aal !== 'aal1') malos.push(nombre + ':' + r.status + '/' + e.status);
          }
          const ok = await llamar(forjar(buena), { accion: 'yo' }, { ip: ipN() });
          const ok2 = await llamar(forjar({ ...buena, amr: [{ method: 'mfa/totp' }, { method: 'password' }] }), { accion: 'yo' }, { ip: ipN() });
          return es(malos.length === 0 && ok.status === 200 && ok2.status === 200, malos.slice(0, 4).join(' | ') + ' ' + ok.status + ' ' + ok2.status);
        });
      }
      await T('NO SE EXIGE MFA A NADIE MAS: dueno, cajero y cocina con sesion normal (aal1) siguen leyendo SU restaurante con RLS; el reembolso responde por permisos y no por MFA', async () => {
        const leerCon = async (t, ruta) => { const r = await fetchReal(`${URL_BASE}/rest/v1/${ruta}`, { headers: { apikey: PUB2, Authorization: 'Bearer ' + t } }); return { status: r.status, filas: JSON.parse(await r.text()) }; };
        const malos = [];
        for (const quien of ['dueno', 'cajero', 'cocina']) {
          const m = await leerCon(sesiones[quien], 'miembros?select=rol,restaurante_id');
          const r = await leerCon(sesiones[quien], 'restaurantes?select=id,slug');
          if (m.status !== 200 || m.filas.length !== 1 || m.filas[0].restaurante_id !== rA.id || r.status !== 200 || r.filas.length !== 1 || r.filas[0].id !== rA.id) malos.push(quien);
        }
        const reemb = await invocar(api('reembolso'), { host: HOST_TAQUEIROS, ruta: '/api/reembolso', cuerpo: { referencia: 'NO-EXISTE' }, headers: { authorization: 'Bearer ' + sesiones.dueno } });
        const reemb2 = await invocar(api('reembolso'), { host: HOST_TAQUEIROS, ruta: '/api/reembolso', cuerpo: { referencia: 'NO-EXISTE' } });
        return es(malos.length === 0 && reemb.status === 403 && !/dos pasos|mfa/i.test(JSON.stringify(reemb.cuerpo)) && /due/.test(reemb.cuerpo.error) && reemb2.status === 401, malos.join(',') + ' ' + reemb.status + ' ' + JSON.stringify(reemb.cuerpo) + ' ' + reemb2.status);
      });
    }

    /* =====================================================================
       6. "ENTRAR COMO" (SQL 19): lecturas de solo lectura y constancia de los rechazos por falta de MFA
    ===================================================================== */
    if (quiere('lecturas') && !sql19) {
      grupo('sin sql 19');
      await T('SIN EL SQL 19: las 4 lecturas responden 503 con un aviso claro (falta el SQL 19) y generico; mi_estado, yo, listar_restaurantes y el rechazo por MFA siguen funcionando', async () => {
        const malas = [];
        for (const a of ['ver_pedidos', 'ver_menu', 'ver_config', 'ver_resumen']) {
          const r = await llamar(tSuper, { accion: a, restaurante_id: rA.id }, { ip: ipN() });
          if (r.status !== 503 || !/SQL 19/.test(r.cuerpo.error || '') || JSON.stringify(r.cuerpo).length > 200) malas.push(`${a}:${r.status} ${JSON.stringify(r.cuerpo).slice(0, 80)}`);
        }
        const y = await llamar(tSuper, { accion: 'yo' }, { ip: ipN() });
        const l = await llamar(tSuper, { accion: 'listar_restaurantes' }, { ip: ipN() });
        const e = await llamar(tSuper1, { accion: 'mi_estado' }, { ip: ipN() });
        const mfa = await llamar(tSuper1, { accion: 'ver_pedidos', restaurante_id: rA.id }, { ip: ipN() });
        return es(malas.length === 0 && y.status === 200 && l.status === 200 && e.status === 200 && mfa.status === 403 && mfa.cuerpo.codigo === 'mfa_requerida', malas.join(' | '));
      });
      await T('SIN EL SQL 19: un restaurante mal formado se rechaza igual (400) y un no-superadmin sigue recibiendo 403', async () => {
        const a = await llamar(tSuper, { accion: 'ver_menu', restaurante_id: 'x' }, { ip: ipN() });
        const b = await llamar(sesiones.dueno, { accion: 'ver_menu', restaurante_id: rA.id }, { ip: ipN() });
        return es(a.status === 400 && b.status === 403, `${a.status} ${b.status}`);
      });
    }

    if (quiere('lecturas') && sql19) {
      grupo('lecturas');
      SA.reiniciarLimite();
      const L = rA;
      const PII = { nombre: 'Cliente Reservado Uno', telefono: '3151112223', email: 'secreto.cliente@correo-privado.example.com', direccion: 'Calle Privada 12-34 Apto 501', indicaciones: 'Dejar con el portero Anselmo' };
      const SENT = { apikey: 'CMB-SENTINELA-' + sfx, integridad: 'test_integrity_SENTINELA' + sfx, privada: 'prv_test_SENTINELA' + sfx };
      sembrarSecreto(...Object.values(PII), ...Object.values(SENT));
      const inicioLecturas = respuestas.length;
      let tablaOpciones = true;
      try { await leer('producto_opciones', 'select=id&limit=1'); } catch (e) { tablaOpciones = false; }
      await insertar('categorias', [{ restaurante_id: L.id, id: 'lect-activa', nombre: 'Hamburguesas', emoji: 'x', orden: 1, activa: true }, { restaurante_id: L.id, id: 'lect-inactiva', nombre: 'Apagada', emoji: 'x', orden: 2, activa: false }]);
      await insertar('productos', [
        { restaurante_id: L.id, id: 'lect-p1', nombre: 'Producto Uno', precio: 20000, categoria: 'lect-activa', orden: 1, disponible: true },
        { restaurante_id: L.id, id: 'lect-p2', nombre: 'Producto Agotado', precio: 15000, categoria: 'lect-activa', orden: 2, disponible: false },
        { restaurante_id: L.id, id: 'lect-p3', nombre: 'Producto Escondido', precio: 9000, categoria: 'lect-inactiva', orden: 1, disponible: true }]);
      if (tablaOpciones) {
        await insertar('producto_opciones', [
          { restaurante_id: L.id, producto_id: 'lect-p1', id: 'sin-cebolla', tipo: 'quitar', nombre: 'Sin cebolla', precio: 0, orden: 0, activa: true },
          { restaurante_id: L.id, producto_id: 'lect-p1', id: 'extra-queso', tipo: 'extra', nombre: 'Queso extra', precio: 2000, orden: 1, activa: true },
          { restaurante_id: L.id, producto_id: 'lect-p1', id: 'extra-apagada', tipo: 'extra', nombre: 'Opcion apagada', precio: 1500, orden: 2, activa: false }]);
      }
      const itemsConOpciones = [{ id: 'lect-p1', nombre: 'Producto Uno', cantidad: 2, precio: 22000, opciones: [{ id: 'extra-queso', tipo: 'extra', nombre: 'Queso extra', precio: 2000 }, { id: 'sin-cebolla', tipo: 'quitar', nombre: 'Sin cebolla', precio: 0 }] }];
      const ahoraIso = () => new Date(dateNowReal()).toISOString();
      const pedido = (ref, extra) => ({ restaurante_id: L.id, referencia: `LECT-${sfx}-${ref}`, estado: 'nuevo', estado_pago: 'aprobado', cliente_nombre: PII.nombre, cliente_telefono: PII.telefono, cliente_email: PII.email,
        tipo_pedido: 'domicilio', direccion: PII.direccion, barrio: 'Centro', indicaciones: PII.indicaciones, items: itemsConOpciones, subtotal: 44000, costo_domicilio: 3000, total: 47000, pagado_en: ahoraIso(), creado_en: ahoraIso(), ...extra });
      await insertar('pedidos', [
        pedido('a-vendido'), pedido('b-cancelado', { estado: 'cancelado' }), pedido('c-sin-pagar', { estado: 'pendiente_pago', estado_pago: 'pendiente', pagado_en: null }),
        pedido('d-viejo', { estado: 'entregado', creado_en: new Date(dateNowReal() - 3 * 86400000).toISOString() })]);
      await insertar('pedidos', Array.from({ length: 121 }, (_, i) => ({ restaurante_id: L.id, referencia: `LECT-${sfx}-m${i}`, estado: 'entregado', estado_pago: 'aprobado', cliente_nombre: 'Cliente ' + i, cliente_telefono: '3000000000',
        tipo_pedido: 'llevar', items: [{ id: 'lect-p1', nombre: 'Producto Uno', cantidad: 1, precio: 10000 }], subtotal: 10000, costo_domicilio: 0, total: 10000, pagado_en: ahoraIso(), creado_en: ahoraIso() })));
      const TOTAL_JORNADA = 124, TOTAL_TODOS = 125, VENTAS_JORNADA = 47000 + 121 * 10000;
      // secretos de verdad en la fila de este restaurante: ninguna lectura debe devolverlos
      const sec = await srv('PATCH', `restaurante_secretos?restaurante_id=eq.${L.id}`, { callmebot_apikey: SENT.apikey, wompi_integridad_test: SENT.integridad, otros: { wompi_llave_privada_test: SENT.privada, wompi_modo: 'test' } });
      if (sec.status >= 300) throw new Error('no se pudieron sembrar los secretos del restaurante de lecturas: ' + sec.status + ' ' + JSON.stringify(sec.cuerpo).slice(0, 120));
      const tokensSeguimiento = (await leer('pedidos', `restaurante_id=eq.${L.id}&select=token_seguimiento&limit=300`)).map((x) => x.token_seguimiento).filter(Boolean);
      sembrarSecreto(...tokensSeguimiento.filter((t) => String(t).length > 8));
      // (un dueno de L CON segundo factor, creado ANTES de la huella de la base: se usa mas abajo para probar que ni con MFA un dueno puede leer)
      const uMfaL = await crearUsuarioAuth('lect-dueno-mfa');
      sembrarSecreto(uMfaL.password);
      await insertar('miembros', [{ user_id: uMfaL.id, restaurante_id: L.id, rol: 'dueno', activo: true }]);
      const tMfaL = (await elevarAal2(uMfaL)).token;
      // (dos superadmins nuevos, sin historial, para probar la constancia del rechazo; tambien ANTES de la huella de la base)
      const u3 = await crearUsuarioAuth('mfa-nombre-inventado');
      const u4 = await crearUsuarioAuth('mfa-nombre-conocido');
      sembrarSecreto(u3.password, u4.password);
      await insertar('superadmins', [{ user_id: u3.id }, { user_id: u4.id }]);
      const t3 = await iniciarSesion(u3), t4 = await iniciarSesion(u4);
      const huellaNegocio = async () => sha(JSON.stringify([await estadoBase(), await secretosHuella(), await huellaTaq(),
        canon(await leer('pedidos', `restaurante_id=eq.${L.id}&select=*&order=id.asc`)), canon(await leer('productos', `restaurante_id=eq.${L.id}&select=*&order=id.asc`)),
        canon(await leer('categorias', `restaurante_id=eq.${L.id}&select=*&order=id.asc`)), tablaOpciones ? canon(await leer('producto_opciones', `restaurante_id=eq.${L.id}&select=*&order=id.asc`)) : [],
        canon(await leer('configuracion', `restaurante_id=eq.${L.id}&select=*`)), canon(await leer('contadores_pedido', `restaurante_id=eq.${L.id}&select=*`))]));
      const antesNegocio = await huellaNegocio();
      const ver = (cuerpo, token = tSuper) => llamar(token, cuerpo, { ip: ipN() });
      const CLAVES_PEDIDO = ['barrio', 'cliente_email', 'cliente_nombre', 'cliente_telefono', 'costo_domicilio', 'creado_en', 'direccion', 'distancia_km', 'estado', 'estado_cambiado_en', 'estado_pago', 'fuera_de_cobertura', 'id', 'impreso_en', 'indicaciones', 'items',
        'numero', 'pagado_en', 'referencia', 'reembolsado_en', 'reimpresiones', 'subtotal', 'tipo_pedido', 'total', 'wompi_ambiente', 'wompi_metodo_pago'];

      await T('ver_pedidos (jornada actual): 50 por defecto, del mas nuevo al mas viejo, con items y sus opciones, cliente, pago y estado; trae la jornada; NO trae el token de seguimiento ni las coordenadas', async () => {
        const r = await ver({ accion: 'ver_pedidos', restaurante_id: L.id });
        const p = r.cuerpo.pedidos || [];
        const ids = p.map((x) => x.id);
        return es(r.status === 200 && r.cuerpo.ok === true && r.cuerpo.modo === 'jornada' && p.length === 50 && r.cuerpo.devueltos === 50 && r.cuerpo.hay_mas === true && Number.isInteger(r.cuerpo.siguiente) && r.cuerpo.siguiente === Math.min(...ids)
          && ids.every((x, i) => i === 0 || ids[i - 1] > x) && r.cuerpo.jornada && /^\d{4}-\d{2}-\d{2}$/.test(r.cuerpo.jornada.fecha) && r.cuerpo.jornada.inicio && r.cuerpo.jornada.fin
          && p.every((x) => igual(Object.keys(x).sort(), CLAVES_PEDIDO.slice().sort())) && !p.some((x) => 'token_seguimiento' in x || 'lat' in x || 'lng' in x),
          r.status + ' ' + JSON.stringify(r.cuerpo).slice(0, 200));
      });
      await T('ver_pedidos: pagina con "siguiente"/antes_de sin repetir ni saltarse ninguno (100 + 24 en la jornada); el pedido viejo y los de otra jornada no salen; "recientes" si trae los 125', async () => {
        const p1 = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, limite: 100 });
        const p2 = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, limite: 100, antes_de: p1.cuerpo.siguiente });
        const ids1 = p1.cuerpo.pedidos.map((x) => x.id), ids2 = (p2.cuerpo.pedidos || []).map((x) => x.id);
        const todos = new Set([...ids1, ...ids2]);
        const viejoEnJornada = [...p1.cuerpo.pedidos, ...(p2.cuerpo.pedidos || [])].some((x) => x.referencia.endsWith('d-viejo'));
        const r1 = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, modo: 'recientes', limite: 100 });
        const r2 = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, modo: 'recientes', limite: 100, antes_de: r1.cuerpo.siguiente });
        const reciente = [...r1.cuerpo.pedidos, ...(r2.cuerpo.pedidos || [])];
        return es(p1.status === 200 && ids1.length === 100 && p1.cuerpo.hay_mas === true && p2.status === 200 && ids2.length === TOTAL_JORNADA - 100 && p2.cuerpo.hay_mas === false && p2.cuerpo.siguiente === null && todos.size === TOTAL_JORNADA
          && Math.max(...ids2) < Math.min(...ids1) && !viejoEnJornada && r1.cuerpo.modo === 'recientes' && r1.cuerpo.jornada === null && new Set(reciente.map((x) => x.id)).size === TOTAL_TODOS && reciente.some((x) => x.referencia.endsWith('d-viejo')),
          [ids1.length, ids2.length, todos.size, viejoEnJornada, reciente.length].join(','));
      });
      await T('ver_pedidos: los items llegan con sus opciones (extras y "sin") y los datos del cliente tal cual los guardo el servidor', async () => {
        // los 4 pedidos especiales se sembraron primero: tienen los ids mas viejos, asi que estan en la segunda pagina
        const r1 = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, modo: 'recientes', limite: 100 });
        const r = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, modo: 'recientes', limite: 100, antes_de: r1.cuerpo.siguiente });
        const a = r.cuerpo.pedidos.find((x) => x.referencia.endsWith('a-vendido')), c = r.cuerpo.pedidos.find((x) => x.referencia.endsWith('b-cancelado'));
        return es(a && igual(a.items, itemsConOpciones) && a.cliente_nombre === PII.nombre && a.cliente_telefono === PII.telefono && a.estado === 'nuevo' && a.estado_pago === 'aprobado' && a.total === 47000 && a.tipo_pedido === 'domicilio' && Number.isInteger(a.numero) && c.estado === 'cancelado', JSON.stringify(a).slice(0, 200));
      });
      await T('ver_pedidos: los limites y los datos mal formados se rechazan con 400 sin tocar la base (limite 0, 101, fraccion, texto; modo raro; antes_de 0, negativo, texto; campos de mas)', async () => {
        const desde = rastro();
        const casos = [{ limite: 0 }, { limite: 101 }, { limite: 1.5 }, { limite: '5' }, { limite: -1 }, { limite: [5] }, { modo: 'todos' }, { modo: 5 }, { modo: [] }, { modo: {} }, { antes_de: 0 }, { antes_de: -3 }, { antes_de: 'x' }, { antes_de: 1.5 }, { antes_de: 1e30 }, { extra: 1 }, { restaurante_id_2: L.id }];
        const malos = [];
        for (const c of casos) { const r = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, ...c }); if (r.status !== 400) malos.push(`${JSON.stringify(c)}:${r.status}`); }
        const sa = registro.slice(desde).filter((x) => /\/rpc\/sa_/.test(x.url));
        const nulo = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, limite: null, modo: null, antes_de: null });
        const uno = await ver({ accion: 'ver_pedidos', restaurante_id: L.id, limite: 1 });
        return es(malos.length === 0 && sa.length === 0 && nulo.status === 200 && nulo.cuerpo.pedidos.length === 50 && uno.status === 200 && uno.cuerpo.pedidos.length === 1 && uno.cuerpo.hay_mas === true, malos.slice(0, 4).join(' | ') + ' sa:' + sa.length);
      });
      await T('ver_menu: categorias, productos y opciones, INCLUSO las inactivas y agotadas, con sus totales', async () => {
        const r = await ver({ accion: 'ver_menu', restaurante_id: L.id });
        const m = r.cuerpo.menu || {};
        return es(r.status === 200 && m.categorias.length === 2 && m.categorias.some((c) => c.id === 'lect-inactiva' && c.activa === false) && m.productos.length === 3 && m.productos.some((p) => p.id === 'lect-p2' && p.disponible === false)
          && m.productos.some((p) => p.id === 'lect-p3') && m.totales.categorias === 2 && m.totales.productos === 3 && m.truncado === false
          && (tablaOpciones ? m.opciones.length === 3 && m.opciones.some((o) => o.id === 'extra-apagada' && o.activa === false) && m.totales.opciones === 3 : m.opciones.length === 0),
          JSON.stringify(m).slice(0, 250));
      });
      await T('ver_config: lo del detalle (config publica, vigencia, dominios, miembros con rol y correo, tarifas) mas el horario; de los secretos solo si/no', async () => {
        const r = await ver({ accion: 'ver_config', restaurante_id: L.id });
        const x = r.cuerpo.restaurante || {};
        const dueno = (x.miembros || []).find((m) => m.user_id === uDueno.id);
        return es(r.status === 200 && x.id === L.id && x.slug === L.slug && x.vigencia && Array.isArray(x.dominios) && Array.isArray(x.tarifas) && dueno && dueno.rol === 'dueno' && dueno.email === uDueno.email
          && x.horario && 'horarios' in x.horario && 'hora_corte_jornada' in x.horario && x.config && typeof x.config === 'object' && x.secretos.callmebot_apikey === true && x.secretos.wompi_integridad_test === true && x.secretos.wompi_llave_privada_test === true,
          JSON.stringify(x).slice(0, 250));
      });
      await T('ver_resumen: conteos y ventas de la jornada (vendido = pagado y no cancelado) y del mes, y el catalogo', async () => {
        const r = await ver({ accion: 'ver_resumen', restaurante_id: L.id });
        const j = (r.cuerpo.resumen || {}).jornada || {}, m = (r.cuerpo.resumen || {}).mes || {}, c = (r.cuerpo.resumen || {}).catalogo || {};
        return es(r.status === 200 && j.pedidos === TOTAL_JORNADA && j.vendidos === 122 && j.ventas === VENTAS_JORNADA && j.cancelados === 1 && j.por_estado.pendiente_pago === 1 && j.por_estado.nuevo === 1 && j.por_estado.entregado === 121 && j.por_tipo.domicilio === 3 && j.por_tipo.llevar === 121
          && j.ticket_promedio === Math.round(VENTAS_JORNADA / 122) && m.pedidos >= TOTAL_JORNADA && m.ventas >= VENTAS_JORNADA && m.vendidos >= 122 && c.categorias === 2 && c.productos === 3 && c.productos_disponibles === 2 && c.miembros_activos >= 3
          && r.cuerpo.resumen.restaurante.id === L.id && r.cuerpo.resumen.restaurante.vigencia, JSON.stringify(r.cuerpo).slice(0, 300));
      });
      await T('ids de restaurante MALOS (falta, null, vacio, texto, numero, booleano, lista, objeto, inyeccion, con espacios): 400; uno bien formado que no existe: 404; nada se filtra y el servidor ni llama a la base con los mal formados', async () => {
        const desde = rastro();
        const inexistente = '00000000-0000-4000-8000-0000000000dd';
        const malos = [undefined, null, '', 'x', 7, true, [], [L.id], { id: L.id }, { restaurante_id: L.id }, "' or '1'='1", L.id + "'", L.id + ' ', ' ' + L.id, L.id + '\n', L.id.replace(/-/g, ''), 'x'.repeat(5000), '../' + L.id, L.id + ';drop table pedidos', '00000000-0000-0000-0000-000000000000x'];
        const fallas = [];
        for (const a of ['ver_pedidos', 'ver_menu', 'ver_config', 'ver_resumen']) {
          for (const id of malos) {
            const cuerpo = { accion: a }; if (id !== undefined) cuerpo.restaurante_id = id;
            const r = await ver(cuerpo);
            const t = JSON.stringify(r.cuerpo);
            if (r.status !== 400 || t.length > 300 || /pedidos"|productos"|miembros"|drop table|1'='1/.test(t.replace(/"error":"[^"]*"/, ''))) fallas.push(`${a}:${String(id).slice(0, 15)}:${r.status}`);
          }
          const r404 = await ver({ accion: a, restaurante_id: inexistente });
          if (r404.status !== 404 || JSON.stringify(r404.cuerpo).length > 200 || JSON.stringify(r404.cuerpo).includes(inexistente)) fallas.push(`${a}:inexistente:${r404.status}`);
        }
        const hechas = registro.slice(desde).filter((x) => /\/rpc\/sa_ver_/.test(x.url));
        // solo los 4 de "no existe" llegaron a la base
        return es(fallas.length === 0 && hechas.length === 4, fallas.slice(0, 5).join(' | ') + ' sa_ver:' + hechas.length);
      });
      await T('campos de mas en cada una de las 4 lecturas (actor, aal, un campo cualquiera): 400, y el servidor no llama a la base', async () => {
        const desde = rastro();
        const malos = [];
        for (const a of ['ver_pedidos', 'ver_menu', 'ver_config', 'ver_resumen']) for (const extra of [{ actor: uSuper2.id }, { aal: 'aal2' }, { limite_total: 1 }, { restaurante: L.id }]) {
          const r = await ver({ accion: a, restaurante_id: L.id, ...extra });
          if (r.status !== 400) malos.push(`${a}/${Object.keys(extra)[0]}:${r.status}`);
        }
        return es(malos.length === 0 && registro.slice(desde).filter((x) => /\/rpc\/sa_ver_/.test(x.url)).length === 0, malos.join(','));
      });
      await T('un id en MAYUSCULAS se acepta (es el mismo id) y el resultado es el mismo', async () => {
        const a = await ver({ accion: 'ver_menu', restaurante_id: L.id.toUpperCase() });
        const b = await ver({ accion: 'ver_menu', restaurante_id: L.id });
        return es(a.status === 200 && igual(a.cuerpo.menu, b.cuerpo.menu), String(a.status));
      });
      await T('SOLO SUPERADMIN: dueno, cajero, cocina, sin membresia y un dueno CON MFA (aal2) reciben 403 generico en las 4 lecturas, hasta de su propio restaurante, y no se llama a ninguna funcion de la base', async () => {
        const desde = rastro();
        const malas = [];
        const quienes = { dueno: sesiones.dueno, cajero: sesiones.cajero, cocina: sesiones.cocina, 'sin membresia': sesiones['sin membresia'], 'dueno de otro': sesiones['dueno de otro restaurante'] };
        quienes['dueno con MFA'] = tMfaL;
        for (const [q, t] of Object.entries(quienes)) for (const a of ['ver_pedidos', 'ver_menu', 'ver_config', 'ver_resumen']) {
          const r = await ver({ accion: a, restaurante_id: L.id }, t);
          if (r.status !== 403 || !igual(r.cuerpo, { error: 'No autorizado' })) malas.push(`${q}/${a}:${r.status}`);
        }
        const sa = registro.slice(desde).filter((x) => /\/rpc\/sa_/.test(x.url));
        const anon = await llamar(null, { accion: 'ver_pedidos', restaurante_id: L.id }, { ip: ipN() });
        return es(malas.length === 0 && sa.length === 0 && anon.status === 401, malas.join(',') + ' sa:' + sa.length);
      });
      await T('las 4 lecturas y la constancia del rechazo NO se pueden llamar directo a la base (ni anon, ni cada usuario con su sesion, ni el propio superadmin desde su navegador); la ayuda interna ni con la llave de servicio', async () => {
        const malas = [];
        const quienes = [['anon', { llave: PUB2 }], ['superadmin con su sesion', { llave: PUB2, token: tSuper }], ['dueno', { llave: PUB2, token: sesiones.dueno }]];
        for (const [nombre, cred] of quienes) for (const [fn, args] of [['sa_ver_pedidos', { p_actor: uSuper.id, p_restaurante: L.id }], ['sa_ver_menu', { p_actor: uSuper.id, p_restaurante: L.id }], ['sa_ver_config', { p_actor: uSuper.id, p_restaurante: L.id }],
          ['sa_ver_resumen', { p_actor: uSuper.id, p_restaurante: L.id }], ['sa_registrar_rechazo_mfa', { p_actor: uSuper.id }]]) {
          const r = await rpcComo(fn, args, cred);
          if (![401, 403, 404].includes(r.status) || /Reservado|"items"|3151112223/.test(r.texto)) malas.push(`${nombre} ${fn}:${r.status}`);
        }
        const interna = await rpcSrv('auditar_lectura_superadmin', { p_actor: uSuper.id, p_accion: 'ver_menu', p_restaurante: L.id, p_resumen: {} });
        if (interna.status < 400) malas.push('auditar_lectura_superadmin con la llave de servicio: ' + interna.status);
        // con la llave de servicio y un actor que NO es superadmin: 42501 en las 5
        for (const [fn, args] of [['sa_ver_pedidos', { p_restaurante: L.id }], ['sa_ver_menu', { p_restaurante: L.id }], ['sa_ver_config', { p_restaurante: L.id }], ['sa_ver_resumen', { p_restaurante: L.id }], ['sa_registrar_rechazo_mfa', {}]]) {
          for (const actor of [uDueno.id, uSin.id, '00000000-0000-4000-8000-0000000000ff']) { const r = await rpcSrv(fn, { p_actor: actor, ...args }); if (!(r.cuerpo && r.cuerpo.code === '42501')) malas.push(`${fn}/${actor.slice(0, 4)}:${r.status}`); }
        }
        return es(malas.length === 0, malas.slice(0, 5).join(' | '));
      });
      await T('AUDITORIA DE LAS LECTURAS: cada lectura deja su fila (quien, cuando, restaurante, accion) con un resumen de conteos y SIN ningun dato personal, secreto ni token', async () => {
        const a = (await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_restaurante: L.id, p_limite: 200 })).cuerpo;
        const filas = a.filter((x) => /^ver_/.test(x.accion));
        const acciones = new Set(filas.map((x) => x.accion));
        const texto = JSON.stringify(a);
        const pedidosJornada = filas.find((x) => x.accion === 'ver_pedidos' && x.resumen.modo === 'jornada');
        const menu = filas.find((x) => x.accion === 'ver_menu');
        const prohibidos = [...Object.values(PII), ...Object.values(SENT), ...tokensSeguimiento, 'Producto Uno', 'Hamburguesas'].filter((v) => String(v).length > 5);
        const fugas = prohibidos.filter((v) => texto.includes(v));
        return es(['ver_pedidos', 'ver_menu', 'ver_config', 'ver_resumen'].every((x) => acciones.has(x)) && filas.every((x) => x.actor === uSuper.id && x.actor_email === uSuper.email && x.restaurante_id === L.id && x.restaurante_slug === L.slug && x.creado_en)
          && pedidosJornada && pedidosJornada.resumen.pagina_inicial === true && pedidosJornada.resumen.limite === 50 && pedidosJornada.resumen.devueltos === 50 && menu.resumen.productos === 3 && fugas.length === 0,
          fugas.join(',') + ' ' + JSON.stringify(filas.map((x) => [x.accion, x.resumen])).slice(0, 250));
      });
      await T('LA AUDITORIA NO SE INUNDA: varias paginas y refrescos de la misma lectura dejan UNA fila por (superadmin, accion, restaurante, modo) en la ventana; otro modo u otro restaurante si deja la suya', async () => {
        const cuenta = async (rid, accion) => (await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_restaurante: rid, p_limite: 200 })).cuerpo.filter((x) => x.accion === accion);
        const j = (await cuenta(L.id, 'ver_pedidos')).filter((x) => x.resumen.modo === 'jornada').length;
        const rec = (await cuenta(L.id, 'ver_pedidos')).filter((x) => x.resumen.modo === 'recientes').length;
        const menus = (await cuenta(L.id, 'ver_menu')).length;
        for (let i = 0; i < 6; i++) await ver({ accion: 'ver_menu', restaurante_id: L.id });
        const menus2 = (await cuenta(L.id, 'ver_menu')).length;
        const en2 = (await cuenta(rB.id, 'ver_menu')).length;
        await ver({ accion: 'ver_menu', restaurante_id: rB.id });
        const en2b = (await cuenta(rB.id, 'ver_menu')).length;
        return es(j === 1 && rec === 1 && menus === 1 && menus2 === 1 && en2 === 0 && en2b === 1, [j, rec, menus, menus2, en2, en2b].join(','));
      });
      await T('RECHAZO POR FALTA DE MFA: queda UNA constancia por superadmin y ventana (no una por intento), con solo el nivel, el nombre de una accion conocida y la ventana; nada de lo que mande el cliente', async () => {
        SA.reiniciarLimite();
        for (let i = 0; i < 30; i++) await llamar(tSuper1, { accion: i % 2 ? 'guardar_secretos' : 'ver_pedidos', restaurante_id: L.id, valores: { callmebot_apikey: 'NO-DEBE-ESTAR' } }, { ip: ipN() });
        await llamar(tSuper1, { accion: 'accion-inventada <script>alert(1)</script>' }, { ip: ipN() });
        await llamar(tSuper2_1, { accion: 'listar_auditoria' }, { ip: ipN() });
        SA.reiniciarLimite();   // la memoria del servidor se reinicia (otra instancia): la base sigue sin duplicar dentro de la ventana
        await llamar(tSuper1, { accion: 'ver_pedidos', restaurante_id: L.id }, { ip: ipN() });
        const todas = (await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo;
        const delUno = todas.filter((x) => x.accion === 'rechazo_mfa' && x.actor === uSuper.id), delDos = todas.filter((x) => x.accion === 'rechazo_mfa' && x.actor === uSuper2.id);
        const f = delUno[0] || {};
        return es(delUno.length === 1 && delDos.length === 1 && f.restaurante_id === null && f.actor_email === uSuper.email && igual(Object.keys(f.resumen).sort(), ['aal', 'accion_intentada', 'ventana_minutos']) && f.resumen.aal === 'aal1' && f.resumen.ventana_minutos === 15
          && (f.resumen.accion_intentada === null || ACCIONES.includes(f.resumen.accion_intentada)) && !JSON.stringify(todas).includes('NO-DEBE-ESTAR') && !JSON.stringify(todas).includes('script') && ACCIONES.includes(delDos[0].resumen.accion_intentada),
          [delUno.length, delDos.length, JSON.stringify(f.resumen)].join(' '));
      });
      await T('RECHAZO POR FALTA DE MFA: un nombre de accion inventado (aunque tenga forma de nombre valida) NO llega a la auditoria; si la accion es conocida, si', async () => {
        const a = await llamar(t3, { accion: 'accion_inventada_xyz' }, { ip: ipN() });
        const f = (await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo.filter((x) => x.accion === 'rechazo_mfa' && x.actor === u3.id);
        await llamar(t4, { accion: 'ver_menu', restaurante_id: L.id }, { ip: ipN() });
        const g = (await rpcSrv('sa_listar_auditoria', { p_actor: uSuper.id, p_limite: 200 })).cuerpo.filter((x) => x.accion === 'rechazo_mfa' && x.actor === u4.id);
        return es(a.status === 403 && f.length === 1 && f[0].resumen.accion_intentada === null && g.length === 1 && g[0].resumen.accion_intentada === 'ver_menu', JSON.stringify([f.map((x) => x.resumen), g.map((x) => x.resumen)]));
      });
      await T('LAS LECTURAS NO ESCRIBEN: despues de todas las lecturas (buenas, malas, repetidas, paginadas y rechazadas) la base de negocio esta byte por byte igual: pedidos, menu, opciones, categorias, configuracion, contadores, secretos, miembros, dominios, tarifas y Taqueiros', async () => {
        const despues = await huellaNegocio();
        return es(despues === antesNegocio, 'la base cambio');
      });
      await T('NINGUNA LECTURA DEVUELVE SECRETOS NI TOKENS: ni las claves sembradas en la fila de secretos del restaurante, ni los tokens de seguimiento de sus pedidos, ni nada con pinta de llave, en ninguna respuesta de este grupo', async () => {
        const todo = respuestas.slice(inicioLecturas).join('\n');
        const fugas = [...Object.values(SENT), ...tokensSeguimiento.filter((t) => String(t).length > 8)].filter((v) => todo.includes(v));
        return es(fugas.length === 0 && todo.length > 100000 && !/prv_(test|prod)_|(test|prod)_(integrity|events)_|sb_secret_|"token_seguimiento"|"lat":|"lng":/.test(todo), fugas.length + ' fugas; ' + todo.length + ' caracteres revisados');
      });
    }

    if (!quiere('base')) {
      grupo('taqueiros');
      await T('TAQUEIROS QUEDO EXACTAMENTE IGUAL (su fila, configuracion, secretos, tarifas, dominios, miembros y pedidos)', async () => es((await huellaTaq()) === taqAntes, 'la huella de Taqueiros cambio'));
    }
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
