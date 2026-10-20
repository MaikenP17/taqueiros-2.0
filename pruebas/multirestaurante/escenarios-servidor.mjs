/* =============================================================
   ESCENARIOS DE LA API MULTI-RESTAURANTE  (compartidos)

   Ejecutan los MANEJADORES REALES de api/*.js (menu, estado, disponibilidad,
   crear-pedido, webhook-wompi, alertas, keep-alive, restaurante, reembolso,
   generar-firma) contra una base con el SQL 10 y el SQL 11:

     * local:  el Supabase falso (PGlite)   -> pruebas/multirestaurante/servidor.mjs
     * real:   la base de verdad             -> supabase/probar-servidor-multirestaurante.mjs

   Crean restaurantes de prueba (slug "test-srv-...", con dominios de prueba
   "*.mr-prueba.test"), cada uno con menu, tarifas, secretos y horarios DISTINTOS,
   y comprueban que cada uno ve y toca solo lo suyo. Todo lo de la red externa
   (CallMeBot, Nominatim) esta simulado: nada sale a internet.

   En modo real NO se escribe nada en Taqueiros ni se tocan sus pedidos: los
   escenarios que lo necesitan se omiten, y /api/alertas solo ve los
   restaurantes de prueba.

   correrEscenarios() devuelve { resultados } y SIEMPRE limpia lo que creo.
============================================================= */
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TAQUEIROS_ID = '00000000-0000-4000-8000-000000000001';
const HOST_TAQUEIROS = 'taqueiros-2-0.vercel.app';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export async function correrEscenarios(opts) {
  const {
    apiDir, urlBase, llaveServicio, llavePublicable = '', real = false,
    sinInvariante = false, soloGrupos = null, log = () => {}
  } = opts;
  const URL_BASE = urlBase.replace(/\/$/, '');
  const resultados = [];
  const sfx = crypto.randomBytes(3).toString('hex');

  // ---- entorno y red simulada -------------------------------------------------
  const entornoOriginal = { ...process.env };
  const fetchReal = globalThis.fetch;
  const dateNowReal = Date.now;
  const consolaReal = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const logs = [];
  const respuestas = [];          // JSON de todas las respuestas de los manejadores (para buscar fugas)
  const registro = [];            // peticiones del servidor a Supabase
  const callmebot = [];           // envios simulados de WhatsApp
  let desfase = 0;                // para adelantar el reloj
  let falla = null;               // (url) => true  simula Supabase caido
  let dominiosAusente = false;    // simula que la tabla restaurante_dominios no existe
  let idsPrueba = [];             // para que /api/alertas (modo real) solo vea restaurantes de prueba
  let callmebotResponde = () => ({ status: 200, texto: 'Message queued. You will receive it in a few seconds' });

  const H = (extra) => {
    const { cabecerasSupabase } = require(path.join(apiDir, '_llave.js'));
    return cabecerasSupabase(llaveServicio, extra);
  };

  globalThis.fetch = async function (u, o) {
    const url = String(u);
    const metodo = (o && o.method) || 'GET';
    if (url.startsWith('https://api.callmebot.com/')) {
      const q = new URL(url).searchParams;
      const r = callmebotResponde(q.get('phone'));
      callmebot.push({ phone: q.get('phone'), apikey: q.get('apikey'), text: q.get('text') || '' });
      return new Response(r.texto, { status: r.status });
    }
    if (url.includes('nominatim.openstreetmap.org')) {
      return new Response(JSON.stringify({ address: { neighbourhood: 'Barrio Prueba' } }), { status: 200 });
    }
    if (url.startsWith(URL_BASE)) {
      registro.push({ url, metodo, cuerpo: o && o.body });
      if (falla && falla(url)) throw new Error('red caida (simulada)');
      if (dominiosAusente && url.includes('/rest/v1/restaurante_dominios')) {
        return new Response(JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.restaurante_dominios' in the schema cache" }), { status: 404 });
      }
      // Modo real: /api/alertas recorre TODOS los restaurantes; solo se le muestran los de prueba
      if (real && metodo === 'GET' && /\/rest\/v1\/restaurantes\?select=[^&]*&order=creado_en\.asc/.test(url)) {
        const r = await fetchReal(u, o);
        const filas = JSON.parse(await r.text()).filter((x) => idsPrueba.includes(x.id));
        return new Response(JSON.stringify(filas), { status: 200 });
      }
    }
    return fetchReal(u, o);
  };
  Date.now = () => dateNowReal() + desfase;
  for (const n of ['log', 'warn', 'error', 'info']) console[n] = (...a) => logs.push(a.map(String).join(' '));

  process.env.SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = llaveServicio;
  if (llavePublicable) process.env.SUPABASE_PUBLISHABLE_KEY = llavePublicable; else delete process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.CRON_SECRET = 'cron-' + sfx;
  process.env.VERCEL_ENV = 'production';
  delete process.env.DOMINIO_BASE;
  for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_INTEGRITY_SECRET_PROD', 'WOMPI_EVENTS_SECRET_TEST', 'WOMPI_EVENTS_SECRET_PROD', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];

  // ---- llamadas directas a la base (como el servidor, con la llave secreta; sin registro) ----
  async function srv(metodo, ruta, cuerpo, prefer) {
    const r = await fetchReal(`${URL_BASE}/rest/v1/${ruta}`, {
      method: metodo,
      headers: H(prefer ? { Prefer: prefer } : (metodo === 'GET' ? undefined : { Prefer: 'return=representation' })),
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${metodo} ${ruta.slice(0, 60)} -> ${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  }
  const insertar = async (tabla, cuerpo) => { const f = await srv('POST', tabla, cuerpo); return Array.isArray(cuerpo) ? f : f[0]; };
  const parchear = (tabla, filtro, cuerpo) => srv('PATCH', `${tabla}?${filtro}`, cuerpo);
  const leer = (tabla, filtro) => srv('GET', `${tabla}?${filtro}`);

  // ---- manejadores reales ---------------------------------------------------------
  const api = (n) => require(path.join(apiDir, n + '.js'));
  const M = {
    menu: api('menu'), estado: api('estado'), disponibilidad: api('disponibilidad'), crear: api('crear-pedido'),
    webhook: api('webhook-wompi'), alertas: api('alertas'), keepAlive: api('keep-alive'), restaurante: api('restaurante'),
    reembolso: api('reembolso'), firma: api('generar-firma')
  };
  const R = api('_restaurante');
  const S = api('_supabase');
  const horario = api('_horario');
  const dom = api('_domicilio');
  const notificar = api('_notificar');

  function invocar(manejador, { metodo = 'GET', host, ruta = '/', cuerpo, headers = {} }) {
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
        end() { fin(this.code, undefined, this.cab); return this; }
      };
      Promise.resolve(manejador(req, res)).catch((e) => fin(500, { error: 'EXCEPCION: ' + e.message }, {}));
    });
  }

  // ---- fixtures ---------------------------------------------------------------------------------
  const creados = { restaurantes: [], usuarios: [], pedidosTaqueiros: [], configTaqueiros: null };
  const hostDe = (n) => `${n}-${sfx}.mr-prueba.test`;
  const secretoDe = (n, que) => `SECRETO-${n}-${sfx}-${que}`;
  const todosLosSecretos = [llaveServicio];

  async function nuevoRestaurante(n, extra = {}) {
    const fila = await insertar('restaurantes', Object.assign({
      slug: `test-srv-${n}-${sfx}`, nombre: `PRUEBA-SERVIDOR ${n.toUpperCase()} ${sfx}`, estado: 'activo'
    }, extra));
    creados.restaurantes.push(fila.id);
    idsPrueba = creados.restaurantes.slice();
    return fila;
  }
  const horariosTodoElDia = () => ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
    .map((dia) => ({ dia, abre: '00:00', cierra: '24:00', activo: true }));
  const horariosDe = (abre, cierra) => horariosTodoElDia().map((d) => ({ ...d, abre, cierra }));

  async function ponerSecretos(r, n, extra = {}) {
    const s = {
      wompi_integridad_test: secretoDe(n, 'integridad-test'), wompi_eventos_test: secretoDe(n, 'eventos-test'),
      callmebot_telefono: '57' + String(3000000000 + parseInt(sfx, 16) % 1000000 + n.charCodeAt(0)), callmebot_apikey: secretoDe(n, 'callmebot'),
      otros: { wompi_modo: 'test' }
    };
    Object.assign(s, extra);
    await parchear('restaurante_secretos', `restaurante_id=eq.${r.id}`, s);
    todosLosSecretos.push(s.wompi_integridad_test, s.wompi_eventos_test, s.callmebot_apikey);
    return s;
  }

  async function menuDe(r, productos) {
    await insertar('categorias', [{ restaurante_id: r.id, id: 'tacos', nombre: 'Tacos', emoji: '🌮', orden: 1, activa: true }]);
    await insertar('productos', productos.map((p, i) => ({ restaurante_id: r.id, id: p[0], nombre: p[1], precio: p[2], categoria: 'tacos', orden: i + 1, disponible: true })));
  }
  async function tarifasDe(r, filas) {
    await insertar('tarifas_domicilio', filas.map(([hasta, precio]) => ({ restaurante_id: r.id, hasta, precio })));
  }
  const dominio = (host, r) => insertar('restaurante_dominios', { host, restaurante_id: r.id });

  const ORIGEN = { lat: 7.9, lng: -72.5 };
  const P1 = { lat: 7.909, lng: -72.5 };      // ~1.0 km en linea recta
  const P2 = { lat: 7.92, lng: -72.5 };       // ~2.2 km
  const P3 = { lat: 8.5, lng: -72.5 };        // ~66 km: fuera de cobertura en todos
  const cliente = (extra = {}) => ({ nombre: 'Cliente Prueba', telefono: '3001234567', email: 'prueba@example.com', tipoPedido: 'llevar', ...extra });
  const clienteDomicilio = (p) => cliente({ tipoPedido: 'domicilio', direccion: 'Calle 1 # 2-3', barrio: 'Barrio Prueba', ubicacion: p });
  const cuerpoPedido = (items, c = cliente(), modo = 'test') => ({ cliente: c, items, modo });

  let A, B, C, D;
  let hA, hB, hC, hD;
  const slugDe = (r) => r.slug;

  async function preparar() {
    A = await nuevoRestaurante('a', { config: { ubicacion: ORIGEN, publico: { color: 'rojo', logo: 'a.png' }, interno: 'SOLO-INTERNO-A', domicilio: { area: { latMin: 7.85, latMax: 7.95, lngMin: -72.55, lngMax: -72.45 } } } });
    B = await nuevoRestaurante('b', { config: { ubicacion: ORIGEN, publico: { color: 'azul' }, domicilio: { factor_recorrido: 1.0 } } });
    C = await nuevoRestaurante('c', { zona_horaria: 'America/Bogota' });
    D = await nuevoRestaurante('d');
    hA = hostDe('a'); hB = hostDe('b'); hC = hostDe('c');
    await dominio(hA, A); await dominio(hB, B); await dominio(hC, C);
    // D solo se alcanza por subdominio de DOMINIO_BASE (sin fila en restaurante_dominios)
    hD = `${D.slug}.dominio-base.test`;

    await menuDe(A, [['taco', 'Taco de A', 10000], ['solo-a', 'Exclusivo de A', 7000]]);
    await menuDe(B, [['taco', 'Taco de B', 20000], ['solo-b', 'Exclusivo de B', 9000]]);
    await menuDe(D, [['taco', 'Taco de D', 5000]]);
    await menuDe(C, [['taco', 'Taco de C', 1000]]);
    await tarifasDe(C, [[5, 1000], [999, null]]);     // C: tarifas pero SIN ubicacion
    await tarifasDe(A, [[2, 3000], [5, 6000], [999, null]]);
    await tarifasDe(B, [[2, 4500], [3, 5500], [999, null]]);
    // D: sin tarifas a proposito

    await parchear('configuracion', `restaurante_id=eq.${A.id}`, { horarios: horariosTodoElDia(), cerrado_temporal: false });
    await parchear('configuracion', `restaurante_id=eq.${B.id}`, { horarios: horariosTodoElDia(), cerrado_temporal: false });
    await parchear('configuracion', `restaurante_id=eq.${C.id}`, { horarios: horariosTodoElDia(), cerrado_temporal: false });
    await parchear('configuracion', `restaurante_id=eq.${D.id}`, { horarios: horariosTodoElDia(), cerrado_temporal: false });

    await ponerSecretos(A, 'a');
    await ponerSecretos(B, 'b');
    await ponerSecretos(C, 'c');
    // D: sin secretos (ni Wompi ni CallMeBot) y sin wompi_modo
  }

  const secretosDe = async (r) => (await leer('restaurante_secretos', `restaurante_id=eq.${r.id}&select=*`))[0];
  const pedidoDe = async (r, ref) => (await leer('pedidos', `referencia=eq.${encodeURIComponent(ref)}&restaurante_id=eq.${r.id}&select=*`))[0] || null;
  const pedidoPorRef = async (ref) => (await leer('pedidos', `referencia=eq.${encodeURIComponent(ref)}&select=*`))[0] || null;
  const contarPedidos = async (r) => (await leer('pedidos', `restaurante_id=eq.${r.id}&select=id`)).length;
  const salud = async (r) => (await leer('salud_notificaciones', `restaurante_id=eq.${r.id}&select=*`))[0];

  async function crearPedidoEn(host, r, items, c, extra = {}) {
    const res = await invocar(M.crear, { metodo: 'POST', host, ruta: '/api/crear-pedido', cuerpo: cuerpoPedido(items, c, extra.modo), headers: extra.headers });
    return res;
  }

  function evento({ referencia, estado = 'APPROVED', montoCentavos, secreto, ambiente = 'test', txId }) {
    const data = { transaction: { id: txId || 'tx-' + crypto.randomBytes(4).toString('hex'), reference: referencia, status: estado, amount_in_cents: montoCentavos, payment_method_type: 'CARD' } };
    const timestamp = Math.floor(dateNowReal() / 1000);
    const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
    const valores = properties.map((p) => p.split('.').reduce((v, k) => v[k], data)).join('');
    return { event: 'transaction.updated', data, environment: ambiente, signature: { checksum: sha(valores + timestamp + secreto), properties }, timestamp };
  }
  const webhook = (cuerpo) => invocar(M.webhook, { metodo: 'POST', host: 'wompi.example', ruta: '/api/webhook-wompi', cuerpo });

  // ---- registro de resultados -------------------------------------------------------------------------
  let grupoActual = '';
  const grupo = (g) => { grupoActual = g; };
  async function T(nombre, fn) {
    if (soloGrupos && !soloGrupos.includes(grupoActual)) return;
    const inicio = registro.length;
    try {
      const r = await fn();
      const ok = r === undefined ? true : !!(r && r.ok !== undefined ? r.ok : r);
      resultados.push({ grupo: grupoActual, nombre, ok, info: ok ? '' : String((r && r.info) || '') });
    } catch (e) {
      resultados.push({ grupo: grupoActual, nombre, ok: false, info: 'EXCEPCION: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e) });
    }
    void inicio;
  }
  // Igualdad profunda que no depende del orden de las claves (jsonb las reordena)
  const canon = (x) => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
  const igual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const es = (cond, info) => ({ ok: !!cond, info });

  /* Invariante: toda peticion del servidor a una tabla de negocio lleva el filtro del restaurante
     esperado (o, en los inserts, restaurante_id en el cuerpo). Excepciones: las tablas que no son
     de un restaurante, las RPC y la busqueda por referencia del webhook (deduce el restaurante). */
  function violaciones(desde, esperados) {
    const malas = [];
    for (const r of registro.slice(desde)) {
      const m = r.url.match(/\/rest\/v1\/([a-z_]+)(\?|$)/);
      if (!m) continue;
      const tabla = m[1];
      if (['restaurantes', 'restaurante_dominios', 'superadmins'].includes(tabla)) continue;
      if (tabla === 'pedidos' && r.metodo === 'GET' && /[?&]referencia=eq\./.test(r.url) && /[?&]limit=2(&|$)/.test(r.url) && !/restaurante_id=/.test(r.url)) continue;
      if (r.metodo === 'POST') {
        let c; try { c = JSON.parse(r.cuerpo); } catch { c = null; }
        if (!c || !esperados.includes(c.restaurante_id)) malas.push(`${r.metodo} ${tabla} sin restaurante_id esperado en el cuerpo`);
        continue;
      }
      const f = r.url.match(/[?&]restaurante_id=eq\.([0-9a-f-]{36})/);
      if (!f || !esperados.includes(f[1])) malas.push(`${r.metodo} ${r.url.replace(URL_BASE, '').slice(0, 90)} sin filtro de restaurante esperado`);
    }
    return malas;
  }
  async function conInvariante(nombre, esperados, fn) {
    if (sinInvariante) return;
    await T(`[invariante] ${nombre}: toda consulta a tablas de negocio lleva el filtro de su restaurante`, async () => {
      const desde = registro.length;
      await fn();
      const m = violaciones(desde, esperados);
      return es(m.length === 0 && registro.length > desde, m.slice(0, 3).join('; ') || 'no hubo peticiones');
    });
  }

  let usuarioDueno = null;
  try {
    await preparar();

    /* =====================================================================
       1. RESOLUCION DEL RESTAURANTE
    ===================================================================== */
    grupo('resolucion');
    R.invalidarCache();
    const pedirMenu = (host, ruta = '/api/menu', headers) => invocar(M.menu, { host, ruta, headers });
    const idsMenu = (res) => (res.cuerpo.productos || []).map((p) => p.id).sort();

    await T('host de A -> solo el menu de A', async () => {
      const r = await pedirMenu(hA);
      return es(r.status === 200 && igual(idsMenu(r), ['solo-a', 'taco']) && r.cuerpo.productos.find((p) => p.id === 'taco').precio === 10000, JSON.stringify(r.cuerpo).slice(0, 200));
    });
    await T('host de B -> solo el menu de B (mismo id "taco", otro precio)', async () => {
      const r = await pedirMenu(hB);
      return es(r.status === 200 && igual(idsMenu(r), ['solo-b', 'taco']) && r.cuerpo.productos.find((p) => p.id === 'taco').precio === 20000, JSON.stringify(r.cuerpo).slice(0, 200));
    });
    await T('las categorias tampoco se mezclan (cada una trae las suyas)', async () => {
      const a = await pedirMenu(hA); const b = await pedirMenu(hB);
      return es(a.cuerpo.categorias.length === 1 && b.cuerpo.categorias.length === 1 && a.cuerpo.productos.every((p) => p.categoria === 'tacos'), '');
    });
    await T('el menu no expone restaurante_id (mismas columnas de siempre)', async () => {
      const a = await pedirMenu(hA);
      return es(a.cuerpo.productos.every((p) => !('restaurante_id' in p)) && a.cuerpo.categorias.every((c) => !('restaurante_id' in c)), '');
    });
    await T('el menu va con "Vary: Host" (la cache del borde es por dominio)', async () => {
      const a = await pedirMenu(hA);
      return es(String(a.cab.Vary || '') === 'Host' && /s-maxage=60/.test(a.cab['Cache-Control']), JSON.stringify(a.cab));
    });
    await conInvariante('menu', [A.id], () => pedirMenu(hA));
    await conInvariante('disponibilidad y estado', [B.id], async () => {
      await invocar(M.disponibilidad, { host: hB }); await invocar(M.estado, { host: hB });
    });

    await T('host desconocido -> 404 en TODOS los endpoints publicos, siempre el mismo cuerpo', async () => {
      const malo = `desconocido-${sfx}.otro.test`;
      const nombres = ['menu', 'estado', 'disponibilidad', 'restaurante'];
      const cuerpos = [];
      for (const n of nombres) {
        const r = await invocar(M[n], { host: malo, ruta: '/api/' + n });
        if (r.status !== 404) return es(false, `${n} -> ${r.status}`);
        cuerpos.push(JSON.stringify(r.cuerpo));
      }
      for (const [n, metodo] of [['crear', 'POST'], ['firma', 'POST'], ['reembolso', 'POST']]) {
        const r = await invocar(M[n], { metodo, host: malo, cuerpo: {} });
        if (r.status !== 404) return es(false, `${n} -> ${r.status}`);
        cuerpos.push(JSON.stringify(r.cuerpo));
      }
      return es(new Set(cuerpos).size === 1 && !/test-srv|restaurante/i.test(cuerpos[0]), cuerpos[0]);
    });
    await T('sin encabezado Host -> 404', async () => es((await invocar(M.menu, { host: undefined })).status === 404, ''));
    await T('el Host se normaliza (mayusculas, puerto, punto final)', async () => {
      const r = await pedirMenu(hA.toUpperCase() + '.:443');
      const r2 = await pedirMenu(hA.toUpperCase() + ':443');
      return es(r.status === 200 && r2.status === 200 && igual(idsMenu(r), ['solo-a', 'taco']) && igual(idsMenu(r2), ['solo-a', 'taco']), `${r.status} ${r2.status}`);
    });
    await T('hosts raros (inyeccion de filtros, espacios, barras) -> 404 sin llegar a la base', async () => {
      const desde = registro.length;
      for (const h of ['a.test&restaurante_id=neq.0', 'a b.test', 'a.test/../x', "a.test'--", '', '.', '..', 'a..test', '-a.test']) {
        const r = await pedirMenu(h);
        if (r.status !== 404) return es(false, `${h} -> ${r.status}`);
      }
      return es(!registro.slice(desde).some((x) => /restaurante_dominios/.test(x.url)), 'se consulto la tabla con un host invalido');
    });

    // --- ?r= y encabezados falsificables ---------------------------------------
    await T('PRODUCCION: ?r=<slug> NO elige restaurante (host desconocido -> 404)', async () => {
      process.env.VERCEL_ENV = 'production';
      const r = await pedirMenu(`desconocido-${sfx}.otro.test`, `/api/menu?r=${slugDe(B)}`);
      return es(r.status === 404, r.status);
    });
    await T('PRODUCCION: con host de A, ?r=<slug de B> sigue dando A', async () => {
      process.env.VERCEL_ENV = 'production';
      const r = await pedirMenu(hA, `/api/menu?r=${slugDe(B)}`);
      return es(r.status === 200 && igual(idsMenu(r), ['solo-a', 'taco']), idsMenu(r));
    });
    await T('si VERCEL_ENV no esta definido, tampoco se acepta ?r= como "produccion" (solo preview/desarrollo)', async () => {
      process.env.VERCEL_ENV = 'preview';
      const r = await pedirMenu(`desconocido-${sfx}.otro.test`, `/api/menu?r=${slugDe(B)}`);
      process.env.VERCEL_ENV = 'production';
      return es(r.status === 200 && igual(idsMenu(r), ['solo-b', 'taco']), r.status);
    });
    await T('PREVIEW: con host de A y ?r=B manda el host (el parametro es el ultimo recurso)', async () => {
      process.env.VERCEL_ENV = 'preview';
      const r = await pedirMenu(hA, `/api/menu?r=${slugDe(B)}`);
      process.env.VERCEL_ENV = 'production';
      return es(r.status === 200 && igual(idsMenu(r), ['solo-a', 'taco']), idsMenu(r));
    });
    await T('PREVIEW: ?r= con un slug que no existe o con formato raro -> 404', async () => {
      process.env.VERCEL_ENV = 'preview';
      const malo = `desconocido-${sfx}.otro.test`;
      const a = await pedirMenu(malo, '/api/menu?r=no-existe-' + sfx);
      const b = await pedirMenu(malo, '/api/menu?r=' + encodeURIComponent("x' or 1=1"));
      process.env.VERCEL_ENV = 'production';
      return es(a.status === 404 && b.status === 404, `${a.status} ${b.status}`);
    });
    await T('PRODUCCION: encabezados falsos (x-forwarded-host, x-restaurante, origin...) no cambian el restaurante', async () => {
      const r = await pedirMenu(hA, '/api/menu', { 'x-forwarded-host': hB, 'x-restaurante': slugDe(B), 'x-tenant': B.id, origin: 'https://' + hB, referer: 'https://' + hB + '/', 'x-vercel-deployment-url': hB });
      return es(r.status === 200 && igual(idsMenu(r), ['solo-a', 'taco']), idsMenu(r));
    });
    await T('PRODUCCION: un host desconocido con x-forwarded-host de un restaurante real sigue siendo 404', async () => {
      const r = await pedirMenu(`desconocido-${sfx}.otro.test`, '/api/menu', { 'x-forwarded-host': hB });
      return es(r.status === 404, r.status);
    });
    await T('el cuerpo de crear-pedido no elige restaurante (restaurante_id / slug / host en el body se ignoran)', async () => {
      const antesB = await contarPedidos(B);
      const cuerpo = cuerpoPedido([{ id: 'taco', cantidad: 1, precio: 10000 }]);
      Object.assign(cuerpo, { restaurante_id: B.id, restauranteId: B.id, slug: slugDe(B), host: hB, restaurante: slugDe(B) });
      cuerpo.cliente.restaurante_id = B.id;
      const r = await invocar(M.crear, { metodo: 'POST', host: hA, cuerpo, headers: { 'x-forwarded-host': hB } });
      const p = r.cuerpo && r.cuerpo.referencia ? await pedidoPorRef(r.cuerpo.referencia) : null;
      return es(r.status === 200 && p && p.restaurante_id === A.id && (await contarPedidos(B)) === antesB, `${r.status} ${p && p.restaurante_id}`);
    });

    // --- subdominio ----------------------------------------------------------------------
    process.env.DOMINIO_BASE = 'dominio-base.test';
    await T('subdominio: <slug>.DOMINIO_BASE resuelve al restaurante de ese slug', async () => {
      const r = await invocar(M.restaurante, { host: hD, ruta: '/api/restaurante' });
      return es(r.status === 200 && r.cuerpo.slug === slugDe(D), JSON.stringify(r.cuerpo).slice(0, 120));
    });
    await T('subdominio: dos niveles, slug inexistente o dominio parecido -> 404', async () => {
      const malos = [`x.${hD}`, `${D.slug}xdominio-base.test`, `${D.slug}-dominio-base.test`, `no-existe-${sfx}.dominio-base.test`, `${D.slug}.dominio-base.test.evil.com`, `${D.slug}dominio-base.test`, `${D.slug}.otro-dominio-base.test`, 'dominio-base.test', `.dominio-base.test`];
      for (const h of malos) {
        const r = await invocar(M.restaurante, { host: h, ruta: '/api/restaurante' });
        if (r.status !== 404) return es(false, `${h} -> ${r.status}`);
      }
      return true;
    });
    await T('subdominio: sin DOMINIO_BASE configurado no se resuelve por subdominio', async () => {
      delete process.env.DOMINIO_BASE; R.invalidarCache();
      const r = await invocar(M.restaurante, { host: hD, ruta: '/api/restaurante' });
      process.env.DOMINIO_BASE = 'dominio-base.test';
      return es(r.status === 404, r.status);
    });
    await T('el host exacto manda sobre el subdominio', async () => {
      // <slug de C>.dominio-base.test seria C por subdominio, pero se registra como dominio exacto de A
      const raro = `${C.slug}.dominio-base.test`;
      const antes = await invocar(M.restaurante, { host: raro, ruta: '/api/restaurante' });
      await insertar('restaurante_dominios', { host: raro, restaurante_id: A.id });
      R.invalidarCache();
      const despues = await invocar(M.restaurante, { host: raro, ruta: '/api/restaurante' });
      await srv('DELETE', `restaurante_dominios?host=eq.${raro}`, undefined, 'return=minimal');
      R.invalidarCache();
      return es(antes.cuerpo.slug === slugDe(C) && despues.cuerpo.slug === slugDe(A), `${antes.cuerpo.slug} ${despues.cuerpo.slug}`);
    });

    // --- cache ------------------------------------------------------------------------------
    await T('cache: dos peticiones del mismo host consultan restaurante_dominios UNA vez', async () => {
      R.invalidarCache();
      const desde = registro.length;
      await pedirMenu(hA); await pedirMenu(hA);
      const n = registro.slice(desde).filter((x) => x.url.includes('restaurante_dominios')).length;
      return es(n === 1, n);
    });
    await T('cache negativa: un host desconocido repetido tampoco castiga a la base', async () => {
      const malo = `inventado-${sfx}.otro.test`;
      const desde = registro.length;
      await pedirMenu(malo); await pedirMenu(malo); await pedirMenu(malo);
      const n = registro.slice(desde).filter((x) => x.url.includes('restaurante_dominios')).length;
      return es(n === 1, n);
    });
    await T('cache: vence a los 30-60 s (a los 31 s vuelve a consultar)', async () => {
      R.invalidarCache();
      await pedirMenu(hA);
      desfase += 31 * 1000;
      const desde = registro.length;
      await pedirMenu(hA);
      const n = registro.slice(desde).filter((x) => x.url.includes('restaurante_dominios')).length;
      desfase -= 31 * 1000;
      return es(n === 1, n);
    });
    await T('invalidarCache(id) saca solo a ese restaurante', async () => {
      R.invalidarCache(); await pedirMenu(hA); await pedirMenu(hB);
      R.invalidarCache(A.id);
      const desde = registro.length;
      await pedirMenu(hA); await pedirMenu(hB);
      const q = registro.slice(desde).filter((x) => x.url.includes('restaurante_dominios'));
      return es(q.length === 1 && q[0].url.includes(encodeURIComponent(hA)), q.length);
    });
    await T('cache de resolucion nunca guarda secretos (ni en memoria, ni en lo que devuelve)', async () => {
      R.invalidarCache();
      const r = await R.resolverRestaurante({ headers: { host: hA }, url: '/' });
      const texto = JSON.stringify(r);
      return es(!todosLosSecretos.some((s) => s && texto.includes(s)) && !('callmebot_apikey' in r.restaurante) && !('wompi_eventos_test' in r.restaurante), '');
    });

    // --- red de seguridad (Supabase caido) ----------------------------------------------------
    await T('Supabase caido: la resolucion usa la ultima conocida y el menu sale de la copia de ESE restaurante', async () => {
      R.invalidarCache();
      await pedirMenu(hA); await pedirMenu(hB);                         // se sirven bien: quedan las copias
      await invocar(M.restaurante, { host: hC, ruta: '/api/restaurante' }); // C se resuelve pero su menu nunca se sirvio
      desfase += 120 * 1000;                                            // el cache vence
      falla = (u) => true;
      const a = await pedirMenu(hA); const b = await pedirMenu(hB); const c = await pedirMenu(hC);
      const nuevo = await pedirMenu(`nunca-visto-${sfx}.otro.test`);
      falla = null; desfase -= 120 * 1000;
      return es(a.status === 200 && a.cuerpo.deRespaldo === true && igual(idsMenu(a), ['solo-a', 'taco'])
        && b.status === 200 && b.cuerpo.deRespaldo === true && igual(idsMenu(b), ['solo-b', 'taco'])
        && c.status === 503 && nuevo.status === 503,
        `${a.status} ${b.status} ${c.status} ${nuevo.status} ${idsMenu(a)} ${idsMenu(b)}`);
    });

    await T('transicion: sin la tabla restaurante_dominios, SOLO el host de produccion de Taqueiros resuelve (a Taqueiros)', async () => {
      R.invalidarCache(); dominiosAusente = true;
      const t = await invocar(M.restaurante, { host: HOST_TAQUEIROS, ruta: '/api/restaurante' });
      const otro = await invocar(M.restaurante, { host: hA, ruta: '/api/restaurante' });
      dominiosAusente = false; R.invalidarCache();
      return es(t.status === 200 && t.cuerpo.slug === 'taqueiros' && otro.status === 503, `${t.status} ${otro.status}`);
    });
    await T('Taqueiros: su host de produccion (sembrado por el SQL 11) resuelve a Taqueiros', async () => {
      R.invalidarCache();
      const t = await invocar(M.restaurante, { host: HOST_TAQUEIROS, ruta: '/api/restaurante' });
      return es(t.status === 200 && t.cuerpo.slug === 'taqueiros' && t.cuerpo.id === TAQUEIROS_ID, JSON.stringify(t.cuerpo).slice(0, 100));
    });

    /* =====================================================================
       2. ESTADO DEL SERVICIO
    ===================================================================== */
    grupo('servicio');
    const ahora = (iso) => new Date(iso);
    const rest = (extra) => ({ id: 'x', estado: 'activo', vigente_hasta: null, dias_gracia: 5, zona_horaria: 'America/Bogota', ...extra });
    const ra = R.restauranteActivo;
    await T('restauranteActivo: activo y prueba sirven; sin vencimiento (nulo) siempre', async () => {
      return es(ra(rest({}), ahora('2030-01-01T12:00:00Z')).estado === 'activo' && ra(rest({ estado: 'prueba' }), ahora('2030-01-01T12:00:00Z')).sirve === true, '');
    });
    await T('restauranteActivo: suspendido no sirve, aunque no haya vencido', async () => {
      const r = ra(rest({ estado: 'suspendido', vigente_hasta: '2099-01-01' }), ahora('2026-10-20T12:00:00Z'));
      return es(r.estado === 'suspendido' && r.sirve === false && r.motivo === 'suspendido', JSON.stringify(r));
    });
    await T('restauranteActivo: el dia de vigente_hasta todavia es activo; despues, gracia; pasada la gracia, suspendido', async () => {
      const h = (iso) => ra(rest({ vigente_hasta: '2026-10-20' }), ahora(iso));
      const a = h('2026-10-20T20:00:00Z');      // 15:00 del 20 en Bogota
      const g1 = h('2026-10-21T20:00:00Z');     // 1 dia vencido
      const g5 = h('2026-10-25T20:00:00Z');     // 5 dias vencido (limite de la gracia)
      const s6 = h('2026-10-26T20:00:00Z');     // 6 dias vencido
      return es(a.estado === 'activo' && g1.estado === 'gracia' && g1.sirve && g5.estado === 'gracia' && g5.sirve && s6.estado === 'suspendido' && !s6.sirve && s6.motivo === 'vencido',
        [a, g1, g5, s6].map((x) => x.estado).join(','));
    });
    await T('restauranteActivo: dias_gracia = 0 -> suspendido al dia siguiente; gracia larga se respeta', async () => {
      const a = ra(rest({ vigente_hasta: '2026-10-20', dias_gracia: 0 }), ahora('2026-10-21T20:00:00Z'));
      const b = ra(rest({ vigente_hasta: '2026-10-20', dias_gracia: 30 }), ahora('2026-11-15T20:00:00Z'));
      return es(a.estado === 'suspendido' && b.estado === 'gracia', `${a.estado} ${b.estado}`);
    });
    await T('restauranteActivo: "hoy" es la fecha en la zona horaria del restaurante', async () => {
      // 2026-10-21T03:00Z = 22:00 del 20 en Bogota, pero ya es el 21 en Tokio
      const bogota = ra(rest({ vigente_hasta: '2026-10-20' }), ahora('2026-10-21T03:00:00Z'));
      const tokio = ra(rest({ vigente_hasta: '2026-10-20', zona_horaria: 'Asia/Tokyo' }), ahora('2026-10-21T03:00:00Z'));
      return es(bogota.estado === 'activo' && tokio.estado === 'gracia', `${bogota.estado} ${tokio.estado}`);
    });
    await T('restauranteActivo: zona horaria invalida no rompe (usa Bogota); fecha invalida = sin vencimiento', async () => {
      const a = ra(rest({ vigente_hasta: '2026-10-20', zona_horaria: 'No/Existe' }), ahora('2026-10-20T20:00:00Z'));
      const b = ra(rest({ vigente_hasta: 'basura' }), ahora('2026-10-20T20:00:00Z'));
      return es(a.estado === 'activo' && b.estado === 'activo', `${a.estado} ${b.estado}`);
    });

    await T('SUSPENDIDO: crear-pedido responde 403 "servicio_suspendido", no crea ni modifica nada, y el menu sigue', async () => {
      const antes = await contarPedidos(B);
      const cfgAntes = JSON.stringify(await leer('configuracion', `restaurante_id=eq.${B.id}&select=*`));
      R.invalidarCache(); await pedirMenu(hB);          // B queda en la cache como ACTIVO
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' });
      // B ya estaba en cache como "activo": el cambio debe regir en el acto para pedir
      const r = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      const menu = await pedirMenu(hB);
      const cfgDespues = JSON.stringify(await leer('configuracion', `restaurante_id=eq.${B.id}&select=*`));
      const despues = await contarPedidos(B);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo' });
      R.invalidarCache();
      return es(r.status === 403 && r.cuerpo.motivo === 'servicio_suspendido' && antes === despues && cfgAntes === cfgDespues && menu.status === 200,
        `${r.status} ${JSON.stringify(r.cuerpo)} ${antes}/${despues} menu ${menu.status}`);
    });
    await T('suspender a B no afecta a A (A sigue recibiendo pedidos)', async () => {
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' });
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo' });
      R.invalidarCache();
      return es(a.status === 200, a.status + JSON.stringify(a.cuerpo));
    });
    await T('VENCIDO mas alla de la gracia: 403; en gracia todavia recibe pedidos', async () => {
      const dia = (n) => new Date(dateNowReal() - n * 86400000).toISOString().slice(0, 10);
      await parchear('restaurantes', `id=eq.${B.id}`, { vigente_hasta: dia(30), dias_gracia: 5 });
      const vencido = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      await parchear('restaurantes', `id=eq.${B.id}`, { vigente_hasta: dia(2), dias_gracia: 5 });
      const gracia = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      await parchear('restaurantes', `id=eq.${B.id}`, { vigente_hasta: null, dias_gracia: 5 });
      R.invalidarCache();
      return es(vencido.status === 403 && vencido.cuerpo.motivo === 'servicio_suspendido' && gracia.status === 200, `${vencido.status} ${gracia.status}`);
    });
    await T('/api/estado informa servicio (sirve o no) sin tocar el resto de la respuesta', async () => {
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' }); R.invalidarCache();
      const b = await invocar(M.estado, { host: hB }); const a = await invocar(M.estado, { host: hA });
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo' }); R.invalidarCache();
      return es(b.cuerpo.servicio.sirve === false && b.cuerpo.servicio.motivo === 'servicio_suspendido' && a.cuerpo.servicio.sirve === true
        && 'abierto' in a.cuerpo && 'horarioHoy' in a.cuerpo && Array.isArray(a.cuerpo.horarios) && a.cuerpo.horarios.length === 7, JSON.stringify(b.cuerpo).slice(0, 150));
    });

    /* =====================================================================
       3. /api/restaurante: solo datos no sensibles
    ===================================================================== */
    grupo('restaurante');
    await T('devuelve nombre, slug, id, modulos, config PUBLICA y estado de servicio', async () => {
      const r = await invocar(M.restaurante, { host: hA, ruta: '/api/restaurante' });
      const c = r.cuerpo;
      return es(r.status === 200 && c.slug === slugDe(A) && c.nombre === A.nombre && c.id === A.id && igual(c.config, { color: 'rojo', logo: 'a.png' })
        && c.modulos && c.modulos.pasarela === true && c.servicio.estado === 'activo' && c.servicio.sirve === true, JSON.stringify(c));
    });
    await T('NO expone secretos, plan, vigencia, gracia, modalidad ni la config interna', async () => {
      const textos = [];
      for (const [h, r] of [[hA, A], [hB, B], [hC, C], [hD, D]]) {
        const x = await invocar(M.restaurante, { host: h, ruta: '/api/restaurante' });
        textos.push(JSON.stringify(x.cuerpo));
        const llaves = Object.keys(x.cuerpo);
        if (llaves.some((k) => !['id', 'slug', 'nombre', 'zona_horaria', 'modulos', 'config', 'servicio'].includes(k))) return es(false, 'campo inesperado: ' + llaves.join(','));
      }
      const t = textos.join('|');
      return es(!todosLosSecretos.some((s) => s && t.includes(s)) && !/SOLO-INTERNO-A|vigente_hasta|dias_gracia|modalidad|plan|ubicacion|callmebot|wompi/i.test(t), t.slice(0, 200));
    });
    await T('reporta el servicio suspendido (y en gracia) sin revelar fechas', async () => {
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' }); R.invalidarCache();
      const s = await invocar(M.restaurante, { host: hB, ruta: '/api/restaurante' });
      const dia = new Date(dateNowReal() - 2 * 86400000).toISOString().slice(0, 10);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo', vigente_hasta: dia }); R.invalidarCache();
      const g = await invocar(M.restaurante, { host: hB, ruta: '/api/restaurante' });
      await parchear('restaurantes', `id=eq.${B.id}`, { vigente_hasta: null }); R.invalidarCache();
      return es(s.cuerpo.servicio.estado === 'suspendido' && s.cuerpo.servicio.sirve === false && s.cuerpo.servicio.motivo === 'servicio_suspendido'
        && g.cuerpo.servicio.estado === 'gracia' && g.cuerpo.servicio.sirve === true && !JSON.stringify(g.cuerpo).includes(dia), JSON.stringify([s.cuerpo.servicio, g.cuerpo.servicio]));
    });
    await T('solo GET (POST -> 405) y sin cache en el borde', async () => {
      const p = await invocar(M.restaurante, { metodo: 'POST', host: hA });
      const g = await invocar(M.restaurante, { host: hA });
      return es(p.status === 405 && g.cab['Cache-Control'] === 'no-store', `${p.status} ${g.cab['Cache-Control']}`);
    });

    /* =====================================================================
       4. DISPONIBILIDAD, ESTADO Y HORARIOS
    ===================================================================== */
    grupo('disponibilidad');
    await T('agotar "taco" en A no lo agota en B', async () => {
      await parchear('productos', `restaurante_id=eq.${A.id}&id=eq.taco`, { disponible: false });
      const a = await invocar(M.disponibilidad, { host: hA }); const b = await invocar(M.disponibilidad, { host: hB });
      await parchear('productos', `restaurante_id=eq.${A.id}&id=eq.taco`, { disponible: true });
      return es(igual(a.cuerpo.agotados, ['taco']) && igual(b.cuerpo.agotados, []), JSON.stringify([a.cuerpo, b.cuerpo]));
    });
    await T('categoria apagada en B no afecta a A', async () => {
      await parchear('categorias', `restaurante_id=eq.${B.id}&id=eq.tacos`, { activa: false });
      const a = await invocar(M.disponibilidad, { host: hA }); const b = await invocar(M.disponibilidad, { host: hB });
      await parchear('categorias', `restaurante_id=eq.${B.id}&id=eq.tacos`, { activa: true });
      return es(igual(a.cuerpo.categoriasInactivas, []) && igual(b.cuerpo.categoriasInactivas, ['tacos']), JSON.stringify([a.cuerpo, b.cuerpo]));
    });
    await T('cerrar B (interruptor) no cierra A; los horarios que ve cada pagina son los suyos', async () => {
      await parchear('configuracion', `restaurante_id=eq.${B.id}`, { cerrado_temporal: true, mensaje_cerrado: 'B cerrado por prueba', horarios: horariosDe('08:00', '09:00') });
      const a = await invocar(M.estado, { host: hA }); const b = await invocar(M.estado, { host: hB });
      await parchear('configuracion', `restaurante_id=eq.${B.id}`, { cerrado_temporal: false, mensaje_cerrado: null, horarios: horariosTodoElDia() });
      return es(a.cuerpo.abierto === true && b.cuerpo.abierto === false && b.cuerpo.mensaje === 'B cerrado por prueba'
        && a.cuerpo.horarios[0].abre === '00:00' && b.cuerpo.horarios[0].abre === '08:00', JSON.stringify([a.cuerpo.abierto, b.cuerpo]).slice(0, 200));
    });
    await T('crear-pedido respeta el horario de SU restaurante: B cerrado -> 409, A abierto -> 200', async () => {
      await parchear('configuracion', `restaurante_id=eq.${B.id}`, { cerrado_temporal: true });
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      await parchear('configuracion', `restaurante_id=eq.${B.id}`, { cerrado_temporal: false });
      return es(b.status === 409 && b.cuerpo.cerrado === true && a.status === 200, `${b.status} ${a.status}`);
    });

    const ponerHorario = (r, horarios, extra = {}) => parchear('configuracion', `restaurante_id=eq.${r.id}`, { horarios, cerrado_temporal: false, ...extra });
    const filaC = async (extra) => ({ ...(await S.buscarRestaurantePorId(C.id)), ...extra });
    await T('zona horaria: el mismo instante abre en Tokio y esta cerrado en Bogota', async () => {
      await ponerHorario(C, horariosDe('11:00', '22:00'));
      const cB = await filaC({ zona_horaria: 'America/Bogota' });
      const cT = await filaC({ zona_horaria: 'Asia/Tokyo' });
      const m = new Date('2026-10-21T03:00:00Z');       // 22:00 en Bogota, 12:00 en Tokio
      const b = await horario.estadoRestaurante(cB, m); const t = await horario.estadoRestaurante(cT, m);
      return es(b.abierto === false && b.motivo === 'ya_cerro' && t.abierto === true, `${b.motivo} ${t.motivo}`);
    });
    await T('zona horaria invalida cae a Bogota (no se cae)', async () => {
      const x = await horario.estadoRestaurante(await filaC({ zona_horaria: 'No/Existe' }), new Date('2026-10-20T17:00:00Z'));
      return es(x.abierto === true, x.motivo);
    });
    await T('horario normal (11-22): mismo resultado que la logica de siempre, cada 30 min durante dos dias y en los bordes', async () => {
      await ponerHorario(C, horariosDe('11:00', '22:00'));
      const c = await filaC({});
      const inicio = Date.UTC(2026, 9, 20, 5, 0);      // 00:00 en Bogota
      const momentos = [];
      for (let i = 0; i < 96; i++) momentos.push(inicio + i * 30 * 60000);
      for (const [h, m] of [[10, 59], [11, 0], [21, 59], [22, 0], [0, 0], [23, 59]]) momentos.push(Date.UTC(2026, 9, 21, h + 5, m));
      for (const t of momentos) {
        const minutosLocal = (((t / 60000) % 1440) - 300 + 1440) % 1440;     // Colombia = UTC-5 todo el ano
        const esperado = minutosLocal >= 660 && minutosLocal < 1320;
        const x = await horario.estadoRestaurante(c, new Date(t));
        if (x.abierto !== esperado) return es(false, `${new Date(t).toISOString()} esperado ${esperado} dio ${x.abierto} (${x.motivo})`);
      }
      return true;
    });
    await T('horario que cruza la medianoche (18:00-02:00, corte 05:00): abierto de madrugada solo hasta el cierre', async () => {
      await ponerHorario(C, horariosDe('18:00', '02:00'), { hora_corte_jornada: '05:00' });
      const c = await filaC({});
      const en = async (iso) => (await horario.estadoRestaurante(c, new Date(iso))).abierto;
      // hora local = UTC - 5
      return es((await en('2026-10-21T06:00:00Z')) === true     // 01:00 local
        && (await en('2026-10-21T08:00:00Z')) === false         // 03:00 local
        && (await en('2026-10-21T00:00:00Z')) === true          // 19:00 local
        && (await en('2026-10-20T20:00:00Z')) === false,        // 15:00 local
        'cruce de medianoche');
    });
    await T('la hora de corte de la jornada limita el tramo de madrugada (cierra 02:00, corte 01:00 -> cierra a la 01:00)', async () => {
      await ponerHorario(C, horariosDe('18:00', '02:00'), { hora_corte_jornada: '01:00' });
      const c = await filaC({});
      const a = await horario.estadoRestaurante(c, new Date('2026-10-21T05:30:00Z'));   // 00:30 local
      const b = await horario.estadoRestaurante(c, new Date('2026-10-21T06:30:00Z'));   // 01:30 local
      return es(a.abierto === true && b.abierto === false, `${a.abierto} ${b.abierto}`);
    });
    await T('estado informa la jornada y la hora de corte del restaurante', async () => {
      await ponerHorario(C, horariosDe('11:00', '22:00'), { hora_corte_jornada: '05:00' });
      const c = await filaC({});
      const madrugada = await horario.estadoRestaurante(c, new Date('2026-10-21T08:00:00Z'));   // 03:00 del 21 local
      const dia = await horario.estadoRestaurante(c, new Date('2026-10-21T11:00:00Z'));         // 06:00 del 21 local
      return es(madrugada.jornada === '2026-10-20' && dia.jornada === '2026-10-21' && dia.horaCorteJornada === '05:00', `${madrugada.jornada} ${dia.jornada} ${dia.horaCorteJornada}`);
    });
    await ponerHorario(C, horariosTodoElDia());

    /* =====================================================================
       5. CREAR-PEDIDO: menu, precios, numero, domicilio, llaves
    ===================================================================== */
    grupo('crear-pedido');
    let primerPedidoA = null, primerPedidoB = null;
    await T('un producto que solo existe en B no se puede pedir desde el host de A (409 "desconocidos")', async () => {
      const antes = await contarPedidos(A);
      const r = await crearPedidoEn(hA, A, [{ id: 'solo-b', cantidad: 1, precio: 9000 }]);
      return es(r.status === 409 && igual(r.cuerpo.desconocidos, ['solo-b']) && (await contarPedidos(A)) === antes, JSON.stringify(r.cuerpo));
    });
    await T('y al reves: "solo-a" no se pide desde B', async () => {
      const r = await crearPedidoEn(hB, B, [{ id: 'solo-a', cantidad: 1, precio: 7000 }]);
      return es(r.status === 409 && igual(r.cuerpo.desconocidos, ['solo-a']), JSON.stringify(r.cuerpo));
    });
    await T('mismo id "taco" en los dos: cada host cobra el precio de SU restaurante', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 2, precio: 10000 }]);
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 2, precio: 20000 }]);
      primerPedidoA = a.cuerpo; primerPedidoB = b.cuerpo;
      return es(a.status === 200 && a.cuerpo.subtotal === 20000 && b.status === 200 && b.cuerpo.subtotal === 40000, JSON.stringify([a.cuerpo, b.cuerpo]));
    });
    await T('el precio de A en el host de B se detecta como cambiado (no se cobra en silencio)', async () => {
      const r = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      return es(r.status === 409 && r.cuerpo.preciosCambiados.length === 1 && r.cuerpo.preciosCambiados[0].precioNuevo === 20000, JSON.stringify(r.cuerpo));
    });
    await T('el pedido queda guardado en el restaurante del host, con sus items y precios', async () => {
      const pa = await pedidoDe(A, primerPedidoA.referencia); const pb = await pedidoDe(B, primerPedidoB.referencia);
      const cruzadoA = await pedidoDe(B, primerPedidoA.referencia);
      return es(pa && pb && !cruzadoA && pa.restaurante_id === A.id && pb.restaurante_id === B.id && pa.items[0].nombre === 'Taco de A' && pb.items[0].nombre === 'Taco de B', '');
    });
    await conInvariante('crear-pedido (A)', [A.id], () => crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]));
    await conInvariante('crear-pedido a domicilio (B)', [B.id], () => crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }], clienteDomicilio(P1)));

    await T('numero de pedido: cada restaurante cuenta desde 1 y sin saltos (independientes entre si)', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      const a2 = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      const b2 = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      const filasA = (await leer('pedidos', `restaurante_id=eq.${A.id}&select=numero,id&order=numero.asc`)).map((f) => Number(f.numero));
      const filasB = (await leer('pedidos', `restaurante_id=eq.${B.id}&select=numero,id&order=numero.asc`)).map((f) => Number(f.numero));
      const seguidos = (xs) => xs.every((n, i) => n === i + 1);
      return es(seguidos(filasA) && seguidos(filasB) && Number(a2.cuerpo.numero) === Number(a.cuerpo.numero) + 1 && Number(b2.cuerpo.numero) === Number(b.cuerpo.numero) + 1,
        JSON.stringify([filasA, filasB]));
    });
    await T('la respuesta trae el numero del pedido (el del restaurante) y el total firmado', async () => {
      const r = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      const p = await pedidoDe(A, r.cuerpo.referencia);
      return es(Number(r.cuerpo.numero) === Number(p.numero) && r.cuerpo.total === 10000 && /^[0-9a-f]{64}$/.test(r.cuerpo.firma), JSON.stringify(r.cuerpo).slice(0, 150));
    });
    await T('pedidos simultaneos del mismo restaurante nunca repiten numero', async () => {
      const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }])));
      const nums = rs.map((r) => Number(r.cuerpo.numero));
      return es(rs.every((r) => r.status === 200) && new Set(nums).size === 6, nums.join(','));
    });

    // --- llaves y modo ---------------------------------------------------------------------------
    await T('la firma de integridad usa los secretos del restaurante (A con los de A, B con los de B)', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }]);
      const f = (r, n) => sha(`${r.cuerpo.referencia}${r.cuerpo.total * 100}COP${secretoDe(n, 'integridad-test')}`);
      return es(a.cuerpo.firma === f(a, 'a') && b.cuerpo.firma === f(b, 'b') && a.cuerpo.firma !== sha(`${a.cuerpo.referencia}${a.cuerpo.total * 100}COP${secretoDe('b', 'integridad-test')}`), '');
    });
    await T('el MODO de cobro lo decide el servidor: si el navegador pide "produccion" pero el restaurante esta en test, se cobra en test', async () => {
      const r = await invocar(M.crear, { metodo: 'POST', host: hA, cuerpo: cuerpoPedido([{ id: 'taco', cantidad: 1, precio: 10000 }], cliente(), 'produccion') });
      const p = await pedidoDe(A, r.cuerpo.referencia);
      return es(r.status === 200 && p.wompi_ambiente === 'test' && r.cuerpo.firma === sha(`${r.cuerpo.referencia}${r.cuerpo.total * 100}COP${secretoDe('a', 'integridad-test')}`), `${r.status} ${p && p.wompi_ambiente}`);
    });
    await T('un restaurante sin secretos ni modo configurado NO cobra (500) y no deja pedidos', async () => {
      const antes = await contarPedidos(D);
      const r = await crearPedidoEn(hD, D, [{ id: 'taco', cantidad: 1, precio: 5000 }]);
      return es(r.status === 500 && /secreto/i.test(r.cuerpo.error) && (await contarPedidos(D)) === antes, `${r.status} ${JSON.stringify(r.cuerpo)}`);
    });
    await T('con las variables de entorno puestas, un restaurante que NO es Taqueiros sigue sin cobrar (el respaldo es solo para Taqueiros)', async () => {
      process.env.WOMPI_INTEGRITY_SECRET_TEST = 'ENV-integridad-' + sfx; process.env.WOMPI_EVENTS_SECRET_TEST = 'ENV-eventos-' + sfx;
      todosLosSecretos.push(process.env.WOMPI_INTEGRITY_SECRET_TEST, process.env.WOMPI_EVENTS_SECRET_TEST);
      const r = await crearPedidoEn(hD, D, [{ id: 'taco', cantidad: 1, precio: 5000 }]);
      return es(r.status === 500, `${r.status}`);
    });
    await T('secretos del restaurante sin modo configurado (no-Taqueiros): sin pagos aunque haya llaves', async () => {
      await parchear('restaurante_secretos', `restaurante_id=eq.${D.id}`, { wompi_integridad_test: secretoDe('d', 'integridad-test'), otros: {} });
      todosLosSecretos.push(secretoDe('d', 'integridad-test'));
      const r = await crearPedidoEn(hD, D, [{ id: 'taco', cantidad: 1, precio: 5000 }]);
      await parchear('restaurante_secretos', `restaurante_id=eq.${D.id}`, { wompi_integridad_test: null });
      for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_EVENTS_SECRET_TEST']) delete process.env[k];
      return es(r.status === 500, r.status);
    });

    // --- domicilio -------------------------------------------------------------------------------------
    await T('domicilio: el MISMO punto cuesta distinto en A y en B (tarifas y factor propios), calculado por el servidor', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }], clienteDomicilio(P1));
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }], clienteDomicilio(P1));
      return es(a.status === 200 && a.cuerpo.costoDomicilio === 3000 && a.cuerpo.distanciaKm === 1.3 && a.cuerpo.total === 13000
        && b.status === 200 && b.cuerpo.costoDomicilio === 4500 && b.cuerpo.distanciaKm === 1 && b.cuerpo.total === 24500, JSON.stringify([a.cuerpo, b.cuerpo]));
    });
    await T('domicilio: segundo tramo distinto en cada restaurante', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }], clienteDomicilio(P2));
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }], clienteDomicilio(P2));
      return es(a.cuerpo.costoDomicilio === 6000 && b.cuerpo.costoDomicilio === 5500, `${a.cuerpo.costoDomicilio} ${b.cuerpo.costoDomicilio}`);
    });
    await T('domicilio fuera de cobertura: no se cobra y queda marcado; el area de cobertura solo existe donde se configuro', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }], clienteDomicilio(P3));
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }], clienteDomicilio(P3));
      const pa = await pedidoDe(A, a.cuerpo.referencia); const pb = await pedidoDe(B, b.cuerpo.referencia);
      return es(a.cuerpo.fueraDeCobertura === true && a.cuerpo.costoDomicilio === 0 && b.cuerpo.fueraDeCobertura === true
        && /fuera del área de cobertura/.test(pa.ubicacion_sospechosa || '') && !pb.ubicacion_sospechosa, JSON.stringify([pa.ubicacion_sospechosa, pb.ubicacion_sospechosa]));
    });
    await T('pin sobre el local: se avisa con el origen de CADA restaurante', async () => {
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }], clienteDomicilio(ORIGEN));
      const pa = await pedidoDe(A, a.cuerpo.referencia);
      return es(/sobre el restaurante/.test(pa.ubicacion_sospechosa || ''), pa.ubicacion_sospechosa);
    });
    await T('un restaurante sin tarifas (o sin ubicacion) no ofrece domicilio (400); recoger en el local sigue funcionando para el menu', async () => {
      const r = await crearPedidoEn(hD, D, [{ id: 'taco', cantidad: 1, precio: 5000 }], clienteDomicilio(P1));
      return es(r.status === 400 && /domicilio/i.test(r.cuerpo.error), `${r.status} ${JSON.stringify(r.cuerpo)}`);
    });
    await T('un restaurante con tarifas pero sin ubicacion tampoco ofrece domicilio (el origen de Taqueiros no se presta)', async () => {
      const r = await crearPedidoEn(hC, C, [{ id: 'taco', cantidad: 1, precio: 1000 }], clienteDomicilio(P1));
      const ok = await crearPedidoEn(hC, C, [{ id: 'taco', cantidad: 1, precio: 1000 }]);
      return es(r.status === 400 && /domicilio/i.test(r.cuerpo.error) && ok.status === 200, `${r.status} ${ok.status} ${JSON.stringify(r.cuerpo)}`);
    });
    await T('las tarifas se leen de la tabla: cambiar la tarifa de A cambia su cobro de inmediato y no el de B', async () => {
      await parchear('tarifas_domicilio', `restaurante_id=eq.${A.id}&precio=eq.3000`, { precio: 3333 });
      const a = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }], clienteDomicilio(P1));
      const b = await crearPedidoEn(hB, B, [{ id: 'taco', cantidad: 1, precio: 20000 }], clienteDomicilio(P1));
      await parchear('tarifas_domicilio', `restaurante_id=eq.${A.id}&precio=eq.3333`, { precio: 3000 });
      return es(a.cuerpo.costoDomicilio === 3333 && b.cuerpo.costoDomicilio === 4500, `${a.cuerpo.costoDomicilio} ${b.cuerpo.costoDomicilio}`);
    });
    await T('TARIFAS DE TAQUEIROS: la tabla da los mismos precios que el codigo antiguo (441 puntos + lejanos)', async () => {
      // Copia literal de la logica y las constantes que estaban en api/_domicilio.js antes de pasar a la base
      const ANTIGUO = { origen: { lat: 7.8997382, lng: -72.4968525 }, factor: 1.3, tarifas: [{ hasta: 2, precio: 5000 }, { hasta: 4, precio: 7000 }, { hasta: 6, precio: 9000 }, { hasta: 8, precio: 12000 }, { hasta: 999, precio: null }] };
      const hav = (a, b, c, d) => { const R6 = 6371; const rad = (x) => x * Math.PI / 180; const dl = rad(c - a), dg = rad(d - b); const q = Math.sin(dl / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dg / 2) ** 2; return 2 * R6 * Math.asin(Math.sqrt(q)); };
      const viejo = (lat, lng) => { const km = hav(ANTIGUO.origen.lat, ANTIGUO.origen.lng, lat, lng) * ANTIGUO.factor; const t = ANTIGUO.tarifas.find((x) => km <= x.hasta); return { km: Math.round(km * 10) / 10, precio: t && t.precio != null ? t.precio : 0, fuera: !t || t.precio == null }; };
      const taq = await S.buscarRestaurantePorId(TAQUEIROS_ID);
      const ctx = dom.contextoDomicilio(taq, await S.leerTarifasDomicilio(TAQUEIROS_ID));
      if (!ctx) return es(false, 'Taqueiros sin contexto de domicilio (tarifas o ubicacion)');
      let n = 0;
      const puntos = [];
      for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) puntos.push([7.85 + i * 0.005, -72.55 + j * 0.005]);
      puntos.push([8.5, -72.5], [7.0, -72.0], [7.8997382, -72.4968525], [-33.0, -70.0]);
      for (const [lat, lng] of puntos) {
        const v = viejo(lat, lng); const x = dom.calcularDomicilio(lat, lng, ctx);
        if (v.precio !== x.precio || v.fuera !== x.fueraDeCobertura || v.km !== x.km) return es(false, `(${lat},${lng}) antiguo ${JSON.stringify(v)} nuevo ${JSON.stringify(x)}`);
        n++;
      }
      const tramos = new Set(puntos.map(([la, lo]) => viejo(la, lo).precio));
      return es(n === 445 && tramos.size >= 5, `${n} puntos, ${tramos.size} tramos distintos`);
    });
    await T('las tarifas escritas en el codigo ya no existen (api/_domicilio.js no las exporta)', async () => {
      return es(!('TARIFAS_DOMICILIO' in dom) && !('RESTAURANTE' in dom), Object.keys(dom).join(','));
    });

    // --- Taqueiros en local (en la base real no se escribe en Taqueiros) ----------------------------------
    if (!real) {
      grupo('taqueiros');
      const cfgT = (await leer('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}&select=*`))[0];
      creados.configTaqueiros = { horarios: cfgT.horarios, cerrado_temporal: cfgT.cerrado_temporal };
      await parchear('configuracion', `restaurante_id=eq.${TAQUEIROS_ID}`, { horarios: horariosTodoElDia(), cerrado_temporal: false });
      const prodT = (await leer('productos', `restaurante_id=eq.${TAQUEIROS_ID}&disponible=is.true&select=id,precio,categoria&limit=1`))[0];
      process.env.WOMPI_INTEGRITY_SECRET_TEST = 'ENV-integridad-' + sfx; process.env.WOMPI_EVENTS_SECRET_TEST = 'ENV-eventos-' + sfx;
      process.env.CALLMEBOT_PHONE = '573009998877'; process.env.CALLMEBOT_APIKEY = 'ENV-callmebot-' + sfx;
      todosLosSecretos.push(process.env.WOMPI_INTEGRITY_SECRET_TEST, process.env.WOMPI_EVENTS_SECRET_TEST, process.env.CALLMEBOT_APIKEY);
      let refT = null, totalT = 0;
      await T('Taqueiros (host de produccion, secretos solo en variables de entorno): crea el pedido y firma con la variable de entorno, como siempre', async () => {
        const r = await invocar(M.crear, { metodo: 'POST', host: HOST_TAQUEIROS, cuerpo: cuerpoPedido([{ id: prodT.id, cantidad: 1, precio: prodT.precio }], cliente(), 'test') });
        refT = r.cuerpo && r.cuerpo.referencia; totalT = r.cuerpo && r.cuerpo.total;
        if (refT) creados.pedidosTaqueiros.push(refT);
        const p = refT ? await pedidoDe({ id: TAQUEIROS_ID }, refT) : null;
        return es(r.status === 200 && p && p.restaurante_id === TAQUEIROS_ID && r.cuerpo.firma === sha(`${refT}${totalT * 100}COP${process.env.WOMPI_INTEGRITY_SECRET_TEST}`), `${r.status} ${JSON.stringify(r.cuerpo)}`);
      });
      await T('Taqueiros: el webhook firmado con la variable de entorno aprueba el pedido y avisa al CALLMEBOT de entorno', async () => {
        callmebot.length = 0;
        const r = await webhook(evento({ referencia: refT, montoCentavos: totalT * 100, secreto: process.env.WOMPI_EVENTS_SECRET_TEST }));
        const p = await pedidoDe({ id: TAQUEIROS_ID }, refT);
        return es(r.status === 200 && p.estado === 'nuevo' && p.estado_pago === 'aprobado' && callmebot.length === 1 && callmebot[0].phone === '573009998877', `${r.status} ${JSON.stringify(callmebot.map((c) => c.phone))}`);
      });
      await T('el respaldo de entorno no sirve para otro restaurante: un pedido de A firmado con la variable de entorno -> 401', async () => {
        const c = await crearPedidoEn(hA, A, [{ id: 'taco', cantidad: 1, precio: 10000 }]);
        const r = await webhook(evento({ referencia: c.cuerpo.referencia, montoCentavos: c.cuerpo.total * 100, secreto: process.env.WOMPI_EVENTS_SECRET_TEST }));
        const p = await pedidoDe(A, c.cuerpo.referencia);
        return es(r.status === 401 && p.estado === 'pendiente_pago', `${r.status} ${p.estado}`);
      });
      await T('el respaldo de entorno tampoco sirve a Taqueiros si ya cargo SUS secretos en la base (la base manda)', async () => {
        await parchear('restaurante_secretos', `restaurante_id=eq.${TAQUEIROS_ID}`, { wompi_integridad_test: secretoDe('t', 'integridad-test') });
        todosLosSecretos.push(secretoDe('t', 'integridad-test'));
        const r = await invocar(M.crear, { metodo: 'POST', host: HOST_TAQUEIROS, cuerpo: cuerpoPedido([{ id: prodT.id, cantidad: 1, precio: prodT.precio }], cliente(), 'test') });
        if (r.cuerpo && r.cuerpo.referencia) creados.pedidosTaqueiros.push(r.cuerpo.referencia);
        await parchear('restaurante_secretos', `restaurante_id=eq.${TAQUEIROS_ID}`, { wompi_integridad_test: null });
        return es(r.status === 200 && r.cuerpo.firma === sha(`${r.cuerpo.referencia}${r.cuerpo.total * 100}COP${secretoDe('t', 'integridad-test')}`), '');
      });
      for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_EVENTS_SECRET_TEST', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];
      grupo('crear-pedido');
    }
    await T('secretosWompi/contactoAlertas (funciones puras): respaldo de entorno solo para Taqueiros y por campo', async () => {
      const env = { WOMPI_INTEGRITY_SECRET_TEST: 'E1', WOMPI_EVENTS_SECRET_PROD: 'E2', CALLMEBOT_PHONE: '57300', CALLMEBOT_APIKEY: 'E3' };
      const taq = { id: TAQUEIROS_ID }; const otro = { id: '11111111-1111-4111-8111-111111111111' };
      const a = R.secretosWompi(taq, {}, 'test', env), b = R.secretosWompi(taq, { wompi_integridad_test: 'DB1' }, 'test', env);
      const c = R.secretosWompi(otro, {}, 'test', env), d = R.contactoAlertas(otro, {}, env), e = R.contactoAlertas(taq, {}, env);
      return es(a.integridad === 'E1' && a.eventos === null && b.integridad === 'DB1' && c.integridad === null && c.eventos === null
        && d.telefono === null && d.apikey === null && e.telefono === '57300' && e.restauranteId === TAQUEIROS_ID, JSON.stringify([a, b, c, d, e]));
    });
    await T('modoDePago: manda el del restaurante; el del navegador solo cuenta en Taqueiros sin configurar', async () => {
      const taq = { id: TAQUEIROS_ID }; const otro = { id: '11111111-1111-4111-8111-111111111111' };
      return es(R.modoDePago(otro, { otros: { wompi_modo: 'test' } }, 'produccion') === 'test'
        && R.modoDePago(otro, { otros: { wompi_modo: 'produccion' } }, 'test') === 'produccion'
        && R.modoDePago(otro, {}, 'produccion') === null && R.modoDePago(otro, { otros: { wompi_modo: 'raro' } }, 'test') === null
        && R.modoDePago(taq, {}, 'produccion') === 'produccion' && R.modoDePago(taq, {}, 'xxx') === 'test'
        && R.modoDePago(taq, { otros: { wompi_modo: 'test' } }, 'produccion') === 'test', '');
    });

    /* =====================================================================
       6. WEBHOOK DE WOMPI
    ===================================================================== */
    grupo('webhook');
    const nuevoPedidoPendiente = async (host, r, precio) => {
      const c = await crearPedidoEn(host, r, [{ id: 'taco', cantidad: 1, precio }]);
      if (c.status !== 200) throw new Error('no se pudo crear el pedido: ' + JSON.stringify(c.cuerpo));
      return c.cuerpo;
    };
    await T('firmado con los secretos de A: aprueba el pedido de A y avisa SOLO al contacto de A', async () => {
      callmebot.length = 0;
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const sa = await secretosDe(A);
      const antesB = await salud(B);
      const r = await webhook(evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: secretoDe('a', 'eventos-test') }));
      const p = await pedidoDe(A, pa.referencia);
      const sA = await salud(A); const sB = await salud(B);
      return es(r.status === 200 && p.estado === 'nuevo' && p.estado_pago === 'aprobado' && p.pagado_en && p.notificacion_ok === true
        && callmebot.length === 1 && callmebot[0].phone === sa.callmebot_telefono && callmebot[0].apikey === sa.callmebot_apikey && callmebot[0].text.includes(pa.referencia)
        && sA.ultimo_ok === true && igual(sB.ultimo_intento, antesB.ultimo_intento),
        `${r.status} ${p.estado} ${JSON.stringify(callmebot.map((c) => c.phone))}`);
    });
    await T('SEGURIDAD: un evento firmado con los secretos de A sobre un pedido de B -> 401 y el pedido de B no cambia', async () => {
      const pb = await nuevoPedidoPendiente(hB, B, 20000);
      callmebot.length = 0;
      const r = await webhook(evento({ referencia: pb.referencia, montoCentavos: pb.total * 100, secreto: secretoDe('a', 'eventos-test') }));
      const p = await pedidoDe(B, pb.referencia);
      return es(r.status === 401 && p.estado === 'pendiente_pago' && p.estado_pago === 'pendiente' && callmebot.length === 0, `${r.status} ${p.estado}`);
    });
    await T('SEGURIDAD: y al reves (firmado con los de B sobre un pedido de A) -> 401', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const r = await webhook(evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: secretoDe('b', 'eventos-test') }));
      const p = await pedidoDe(A, pa.referencia);
      return es(r.status === 401 && p.estado === 'pendiente_pago', `${r.status} ${p.estado}`);
    });
    await T('SEGURIDAD: el secreto de INTEGRIDAD (que usa el widget) no sirve para firmar eventos', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const r = await webhook(evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: secretoDe('a', 'integridad-test') }));
      return es(r.status === 401, r.status);
    });
    await T('el ambiente del evento elige el secreto: un evento "prod" con secretos de test -> 401 (no hay secretos prod cargados)', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const r = await webhook(evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: secretoDe('a', 'eventos-test'), ambiente: 'prod' }));
      const p = await pedidoDe(A, pa.referencia);
      return es(r.status === 401 && p.estado === 'pendiente_pago', `${r.status} ${p.estado}`);
    });
    await T('referencia desconocida y firma mala responden IGUAL (401, mismo cuerpo): no revela que referencias existen', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const malaFirma = await webhook(evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: 'incorrecto' }));
      const desconocida = await webhook(evento({ referencia: 'TAQ-0-000000', montoCentavos: 100, secreto: secretoDe('a', 'eventos-test') }));
      const vacia = await webhook(evento({ referencia: '', montoCentavos: 100, secreto: secretoDe('a', 'eventos-test') }));
      return es(malaFirma.status === 401 && desconocida.status === 401 && vacia.status === 401 && igual(malaFirma.cuerpo, desconocida.cuerpo), `${malaFirma.status} ${desconocida.status} ${vacia.status}`);
    });
    await T('idempotencia: reenviar el mismo evento no vuelve a avisar ni cambia nada', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const ev = evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: secretoDe('a', 'eventos-test') });
      callmebot.length = 0;
      const r1 = await webhook(ev); const antes = await pedidoDe(A, pa.referencia);
      const r2 = await webhook(ev); const despues = await pedidoDe(A, pa.referencia);
      return es(r1.status === 200 && r2.status === 200 && r2.cuerpo.duplicated === true && callmebot.length === 1 && antes.pagado_en === despues.pagado_en, `${r2.status} ${JSON.stringify(r2.cuerpo)} ${callmebot.length}`);
    });
    await T('monto distinto al del pedido -> estado_pago "error", no entra a cocina', async () => {
      const pb = await nuevoPedidoPendiente(hB, B, 20000);
      const r = await webhook(evento({ referencia: pb.referencia, montoCentavos: 100, secreto: secretoDe('b', 'eventos-test') }));
      const p = await pedidoDe(B, pb.referencia);
      return es(r.status === 200 && r.cuerpo.warning === 'monto no coincide' && p.estado === 'pendiente_pago' && p.estado_pago === 'error', `${r.status} ${p.estado} ${p.estado_pago}`);
    });
    await T('pago rechazado -> estado_pago "rechazado"; anulado -> "anulado"', async () => {
      const p1 = await nuevoPedidoPendiente(hB, B, 20000); const p2 = await nuevoPedidoPendiente(hB, B, 20000);
      await webhook(evento({ referencia: p1.referencia, estado: 'DECLINED', montoCentavos: p1.total * 100, secreto: secretoDe('b', 'eventos-test') }));
      await webhook(evento({ referencia: p2.referencia, estado: 'VOIDED', montoCentavos: p2.total * 100, secreto: secretoDe('b', 'eventos-test') }));
      return es((await pedidoDe(B, p1.referencia)).estado_pago === 'rechazado' && (await pedidoDe(B, p2.referencia)).estado_pago === 'anulado', '');
    });
    await T('un restaurante SUSPENDIDO sigue procesando los pagos que ya estaban en curso (no se pierde el dinero del cliente)', async () => {
      const pb = await nuevoPedidoPendiente(hB, B, 20000);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' }); R.invalidarCache();
      const r = await webhook(evento({ referencia: pb.referencia, montoCentavos: pb.total * 100, secreto: secretoDe('b', 'eventos-test') }));
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo' }); R.invalidarCache();
      const p = await pedidoDe(B, pb.referencia);
      return es(r.status === 200 && p.estado === 'nuevo' && p.estado_pago === 'aprobado', `${r.status} ${p.estado}`);
    });
    await T('evento sin transaccion -> 200 y se ignora; GET -> 405', async () => {
      const a = await webhook({ event: 'nequi_token.updated', data: {} });
      const g = await invocar(M.webhook, { metodo: 'GET', host: 'wompi.example' });
      return es(a.status === 200 && g.status === 405, `${a.status} ${g.status}`);
    });
    await conInvariante('webhook', [A.id], async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      await webhook(evento({ referencia: pa.referencia, montoCentavos: pa.total * 100, secreto: secretoDe('a', 'eventos-test') }));
    });
    await T('el aviso de un restaurante no puede salir por el contacto de otro (notificarWhatsApp lanza error y no envia)', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000);
      const pedido = await pedidoDe(A, pa.referencia);
      callmebot.length = 0;
      let lanzo = false;
      try { await notificar.notificarWhatsApp(pedido, undefined, R.contactoAlertas(B, await secretosDe(B))); } catch (e) { lanzo = true; }
      let lanzo2 = false;
      try { await notificar.notificarWhatsApp(pedido, undefined, undefined); } catch (e) { lanzo2 = true; }
      return es(lanzo && lanzo2 && callmebot.length === 0, `${lanzo} ${lanzo2} ${callmebot.length}`);
    });

    /* =====================================================================
       7. ALERTAS Y KEEP-ALIVE (crons)
    ===================================================================== */
    grupo('alertas');
    const alertaMal = (clave) => invocar(M.alertas, { host: 'cron.example', ruta: '/api/alertas' + (clave ? `?clave=${clave}` : '') });
    const conCron = (m, extra = {}) => invocar(m, { host: 'cron.example', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET }, ...extra });
    const sembrarSinAtender = async (r, ref) => insertar('pedidos', {
      restaurante_id: r.id, referencia: ref, estado: 'nuevo', estado_pago: 'aprobado', cliente_nombre: 'Sin Atender', cliente_telefono: '3001112233',
      tipo_pedido: 'llevar', items: [{ id: 'taco', nombre: 'Taco', cantidad: 1, precio: 1000 }], subtotal: 1000, costo_domicilio: 0, total: 1000,
      pagado_en: new Date(dateNowReal() - 10 * 60000).toISOString(), alerta_enviada: false
    });
    await T('401 sin secreto; con Bearer o ?clave= entra', async () => {
      const a = await alertaMal(); const b = await alertaMal('incorrecta');
      const c = await conCron(M.alertas); const d = await alertaMal(process.env.CRON_SECRET);
      return es(a.status === 401 && b.status === 401 && c.status === 200 && d.status === 200, `${a.status} ${b.status} ${c.status} ${d.status}`);
    });
    await T('cada restaurante avisa SOLO a su contacto y solo de sus pedidos (sin cruces)', async () => {
      const refA = `TAQ-AL-${sfx}-A`, refB = `TAQ-AL-${sfx}-B`;
      await sembrarSinAtender(A, refA); await sembrarSinAtender(B, refB);
      // los pedidos de pruebas anteriores que quedaron "nuevo" sin avisar tambien se avisaran: se filtra por referencia
      callmebot.length = 0;
      const sa = await secretosDe(A), sb = await secretosDe(B);
      const r = await conCron(M.alertas);
      const aA = callmebot.filter((c) => c.text.includes(refA)); const aB = callmebot.filter((c) => c.text.includes(refB));
      const cruzado = callmebot.some((c) => (c.phone === sa.callmebot_telefono && c.text.includes(refB))
        || (c.phone === sb.callmebot_telefono && c.text.includes(refA)));
      const pA = await pedidoDe(A, refA), pB = await pedidoDe(B, refB);
      return es(r.status === 200 && aA.length === 1 && aB.length === 1 && aA[0].phone === sa.callmebot_telefono && aB[0].phone === sb.callmebot_telefono
        && aA[0].apikey === sa.callmebot_apikey && aB[0].apikey === sb.callmebot_apikey && !cruzado && pA.alerta_enviada === true && pB.alerta_enviada === true,
        `${r.status} ${aA.length} ${aB.length} ${cruzado}`);
    });
    await T('la salud del WhatsApp se registra en la fila de CADA restaurante', async () => {
      const refA = `TAQ-AL-${sfx}-SA`, refB = `TAQ-AL-${sfx}-SB`;
      await sembrarSinAtender(A, refA); await sembrarSinAtender(B, refB);
      const sa0 = (await salud(A)).ultimo_intento, sb0 = (await salud(B)).ultimo_intento;
      callmebotResponde = (phone) => (phone && phone === sa.callmebot_telefono ? { status: 203, texto: 'APIKey is invalid' } : { status: 200, texto: 'Message queued' });
      const sa = await secretosDe(A);
      await conCron(M.alertas);
      callmebotResponde = () => ({ status: 200, texto: 'Message queued. You will receive it' });
      const A1 = await salud(A), B1 = await salud(B);
      return es(A1.ultimo_ok === false && A1.fallos_seguidos >= 1 && /invalid/i.test(A1.ultimo_error || '') && B1.ultimo_ok === true && B1.fallos_seguidos === 0 && A1.ultimo_intento !== sa0 && B1.ultimo_intento !== sb0,
        JSON.stringify([A1, B1]));
    });
    await T('el fallo de un restaurante no impide avisar a los demas', async () => {
      const refA = `TAQ-AL-${sfx}-FA`, refB = `TAQ-AL-${sfx}-FB`;
      await sembrarSinAtender(A, refA); await sembrarSinAtender(B, refB);
      const sa = await secretosDe(A);
      callmebotResponde = (phone) => (phone === sa.callmebot_telefono ? { status: 500, texto: 'error' } : { status: 200, texto: 'Message queued' });
      callmebot.length = 0;
      const r = await conCron(M.alertas);
      callmebotResponde = () => ({ status: 200, texto: 'Message queued. You will receive it' });
      return es(r.status === 200 && callmebot.some((c) => c.text.includes(refB)), `${r.status}`);
    });
    await T('si la base falla para UN restaurante (excepcion), los demas se avisan igual', async () => {
      const refA = `TAQ-AL-${sfx}-XA`, refB = `TAQ-AL-${sfx}-XB`;
      await sembrarSinAtender(A, refA); await sembrarSinAtender(B, refB);
      callmebot.length = 0;
      falla = (u) => u.includes('restaurante_secretos') && u.includes(`restaurante_id=eq.${A.id}`);
      const r = await conCron(M.alertas);
      falla = null;
      return es(r.status === 200 && callmebot.some((c) => c.text.includes(refB)) && !callmebot.some((c) => c.text.includes(refA)), `${r.status} ${callmebot.length}`);
    });
    await T('un restaurante sin contacto configurado se salta y sus pedidos NO se marcan como avisados', async () => {
      const refD = `TAQ-AL-${sfx}-D`;
      await sembrarSinAtender(D, refD);
      callmebot.length = 0;
      await conCron(M.alertas);
      const p = await pedidoDe(D, refD);
      return es(p.alerta_enviada === false && !callmebot.some((c) => c.text.includes(refD)), JSON.stringify(p.alerta_enviada));
    });
    await T('un restaurante suspendido no recibe alertas', async () => {
      const refB = `TAQ-AL-${sfx}-SUS`;
      await sembrarSinAtender(B, refB);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' });
      callmebot.length = 0;
      await conCron(M.alertas);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo' });
      const p = await pedidoDe(B, refB);
      return es(p.alerta_enviada === false && !callmebot.some((c) => c.text.includes(refB)), '');
    });
    await conInvariante('alertas', [A.id, B.id, C.id, D.id, ...(real ? [] : [TAQUEIROS_ID])], async () => {
      await sembrarSinAtender(A, `TAQ-AL-${sfx}-INV`);
      await conCron(M.alertas);
    });
    if (!real) {
      await T('keep-alive: 401 sin secreto; 200 con Bearer y con ?clave=; el ping no toca tablas de negocio', async () => {
        const a = await invocar(M.keepAlive, { host: 'cron.example' });
        const desde = registro.length;
        const b = await conCron(M.keepAlive);
        const ping = registro.slice(desde).filter((x) => !x.url.includes('/rpc/'));
        const c = await invocar(M.keepAlive, { host: 'cron.example', ruta: `/api/keep-alive?clave=${process.env.CRON_SECRET}` });
        return es(a.status === 401 && b.status === 200 && c.status === 200 && ping.length === 1 && /restaurantes\?select=id/.test(ping[0].url), `${a.status} ${b.status} ${c.status} ${ping.map((p) => p.url).join(',')}`);
      });
    } else {
      await T('keep-alive: 401 sin secreto (el barrido de huerfanos no se corre contra la base real)', async () => es((await invocar(M.keepAlive, { host: 'cron.example' })).status === 401, ''));
    }

    /* =====================================================================
       8. REEMBOLSO (solo el dueno o el servidor)
    ===================================================================== */
    grupo('reembolso');
    async function usuario(nombre) {
      const email = `${nombre}-${sfx}@prueba-servidor.example.com`;
      const password = 'Pw-' + crypto.randomBytes(8).toString('hex');
      const rc = await fetchReal(`${URL_BASE}/auth/v1/admin/users`, { method: 'POST', headers: H(), body: JSON.stringify({ email, password, email_confirm: true }) });
      const u = JSON.parse(await rc.text());
      if (!rc.ok || !u.id) throw new Error('no se pudo crear el usuario ' + nombre + ': ' + JSON.stringify(u).slice(0, 150));
      creados.usuarios.push(u.id);
      const rt = await fetchReal(`${URL_BASE}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: llavePublicable || llaveServicio, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const t = JSON.parse(await rt.text());
      if (!t.access_token) throw new Error('no se pudo iniciar sesion con ' + nombre + ': ' + JSON.stringify(t).slice(0, 150));
      todosLosSecretos.push(t.access_token);
      return { id: u.id, token: t.access_token };
    }
    const duenoA = await usuario('dueno-a'), cajeroA = await usuario('cajero-a'), duenoB = await usuario('dueno-b'), sinMembresia = await usuario('nadie'), duenoInactivoA = await usuario('inactivo-a');
    await insertar('miembros', [
      { user_id: duenoA.id, restaurante_id: A.id, rol: 'dueno', activo: true }, { user_id: cajeroA.id, restaurante_id: A.id, rol: 'cajero', activo: true },
      { user_id: duenoB.id, restaurante_id: B.id, rol: 'dueno', activo: true }, { user_id: duenoInactivoA.id, restaurante_id: A.id, rol: 'dueno', activo: false }
    ]);
    const pedidoCancelado = async (r, ref, extra = {}) => insertar('pedidos', Object.assign({
      restaurante_id: r.id, referencia: ref, estado: 'cancelado', estado_pago: 'aprobado', cliente_nombre: 'Reembolso', cliente_telefono: '3001112233',
      tipo_pedido: 'llevar', items: [{ id: 'taco', nombre: 'Taco', cantidad: 1, precio: 1000 }], subtotal: 1000, costo_domicilio: 0, total: 1000,
      pagado_en: new Date().toISOString(), alerta_enviada: true
    }, extra));
    const pedirReembolso = (host, token, referencia) => invocar(M.reembolso, { metodo: 'POST', host, cuerpo: { referencia }, headers: token ? { authorization: 'Bearer ' + token } : {} });

    const refR = `TAQ-RE-${sfx}-1`;
    await pedidoCancelado(A, refR);
    await T('sin sesion -> 401; con un token invalido -> 401', async () => {
      const a = await pedirReembolso(hA, null, refR); const b = await pedirReembolso(hA, 'token-invalido', refR);
      return es(a.status === 401 && b.status === 401 && (await pedidoDe(A, refR)).reembolsado_en === null, `${a.status} ${b.status}`);
    });
    await T('el CAJERO no puede registrar un reembolso (403) ni alguien sin membresia', async () => {
      const a = await pedirReembolso(hA, cajeroA.token, refR); const b = await pedirReembolso(hA, sinMembresia.token, refR);
      return es(a.status === 403 && b.status === 403 && (await pedidoDe(A, refR)).reembolsado_en === null, `${a.status} ${b.status}`);
    });
    await T('un dueno DESACTIVADO (activo = false) ya no puede (403)', async () => {
      const r = await pedirReembolso(hA, duenoInactivoA.token, refR);
      return es(r.status === 403 && (await pedidoDe(A, refR)).reembolsado_en === null, r.status);
    });
    await T('el dueno de OTRO restaurante no puede (403)', async () => {
      const r = await pedirReembolso(hA, duenoB.token, refR);
      return es(r.status === 403 && (await pedidoDe(A, refR)).reembolsado_en === null, r.status);
    });
    await T('el dueno de B tampoco puede reembolsar el pedido de A desde el host de B (404, no existe en B)', async () => {
      const r = await pedirReembolso(hB, duenoB.token, refR);
      return es(r.status === 404 && (await pedidoDe(A, refR)).reembolsado_en === null, r.status);
    });
    await T('el dueno de A lo registra: 200 con la fecha; una segunda vez no cambia la fecha (yaRegistrado)', async () => {
      const a = await pedirReembolso(hA, duenoA.token, refR);
      const p1 = await pedidoDe(A, refR);
      const b = await pedirReembolso(hA, duenoA.token, refR);
      const p2 = await pedidoDe(A, refR);
      return es(a.status === 200 && a.cuerpo.yaRegistrado === false && p1.reembolsado_en && b.status === 200 && b.cuerpo.yaRegistrado === true && p1.reembolsado_en === p2.reembolsado_en, `${a.status} ${JSON.stringify(a.cuerpo)} ${b.status}`);
    });
    await T('solo pedidos CANCELADOS y ya cobrados: uno entregado o uno sin cobrar -> 409', async () => {
      const r1 = `TAQ-RE-${sfx}-2`, r2 = `TAQ-RE-${sfx}-3`;
      await pedidoCancelado(A, r1, { estado: 'entregado' }); await pedidoCancelado(A, r2, { estado_pago: 'pendiente', pagado_en: null });
      const a = await pedirReembolso(hA, duenoA.token, r1); const b = await pedirReembolso(hA, duenoA.token, r2);
      return es(a.status === 409 && b.status === 409 && (await pedidoDe(A, r1)).reembolsado_en === null && (await pedidoDe(A, r2)).reembolsado_en === null, `${a.status} ${b.status}`);
    });
    await T('referencia inexistente -> 404; sin referencia -> 400; GET -> 405', async () => {
      const a = await pedirReembolso(hA, duenoA.token, 'TAQ-NO-EXISTE'); const b = await pedirReembolso(hA, duenoA.token, '');
      const g = await invocar(M.reembolso, { metodo: 'GET', host: hA });
      return es(a.status === 404 && b.status === 400 && g.status === 405, `${a.status} ${b.status} ${g.status}`);
    });
    await T('dos llamadas a la vez registran UNA sola fecha', async () => {
      const ref = `TAQ-RE-${sfx}-4`; await pedidoCancelado(A, ref);
      const [a, b] = await Promise.all([pedirReembolso(hA, duenoA.token, ref), pedirReembolso(hA, duenoA.token, ref)]);
      return es(a.status === 200 && b.status === 200 && [a, b].filter((x) => x.cuerpo.yaRegistrado === false).length === 1, JSON.stringify([a.cuerpo, b.cuerpo]));
    });
    await T('el servidor puede registrarlo directamente (registrarReembolso) y un cliente con la llave publicable no puede escribir esa columna', async () => {
      const ref = `TAQ-RE-${sfx}-5`; await pedidoCancelado(B, ref);
      const r = await M.reembolso.registrarReembolso(B.id, ref);
      const p = await pedidoDe(B, ref);
      // un dueno con su propia sesion (PostgREST, no el servidor) no puede cambiar reembolsado_en: lo bloquea el trigger
      const ref2 = `TAQ-RE-${sfx}-6`; await pedidoCancelado(B, ref2);
      const intento = await fetchReal(`${URL_BASE}/rest/v1/pedidos?referencia=eq.${ref2}`, { method: 'PATCH', headers: { apikey: llavePublicable || llaveServicio, Authorization: 'Bearer ' + duenoB.token, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ reembolsado_en: new Date().toISOString() }) });
      const p2 = await pedidoDe(B, ref2);
      return es(r.ok === true && p.reembolsado_en && intento.status >= 400 && p2.reembolsado_en === null, `${r.ok} ${intento.status} ${p2.reembolsado_en}`);
    });
    await conInvariante('reembolso', [A.id], () => pedirReembolso(hA, duenoA.token, `TAQ-RE-${sfx}-1`));
    await T('un restaurante suspendido SI puede registrar sus reembolsos (el panel no se bloquea)', async () => {
      const ref = `TAQ-RE-${sfx}-7`; await pedidoCancelado(A, ref);
      await parchear('restaurantes', `id=eq.${A.id}`, { estado: 'suspendido' }); R.invalidarCache();
      const r = await pedirReembolso(hA, duenoA.token, ref);
      await parchear('restaurantes', `id=eq.${A.id}`, { estado: 'activo' }); R.invalidarCache();
      return es(r.status === 200, r.status);
    });

    /* =====================================================================
       9. GENERAR-FIRMA
    ===================================================================== */
    grupo('firma');
    await T('solo firma pedidos del restaurante del host, pendientes y por el monto guardado', async () => {
      const pa = await nuevoPedidoPendiente(hA, A, 10000); const pb = await nuevoPedidoPendiente(hB, B, 20000);
      const firmar = (host, referencia, monto) => invocar(M.firma, { metodo: 'POST', host, cuerpo: { referencia, montoEnCentavos: monto, modo: 'test' } });
      const ok = await firmar(hA, pa.referencia, pa.total * 100);
      const ajeno = await firmar(hA, pb.referencia, pb.total * 100);
      const otroMonto = await firmar(hA, pa.referencia, 100);
      const inexistente = await firmar(hA, 'TAQ-0-000000', 100);
      const falta = await invocar(M.firma, { metodo: 'POST', host: hA, cuerpo: {} });
      const get = await invocar(M.firma, { metodo: 'GET', host: hA });
      return es(ok.status === 200 && ok.cuerpo.firma === sha(`${pa.referencia}${pa.total * 100}COP${secretoDe('a', 'integridad-test')}`)
        && ajeno.status === 404 && otroMonto.status === 404 && inexistente.status === 404 && falta.status === 400 && get.status === 405,
        [ok, ajeno, otroMonto, inexistente, falta, get].map((x) => x.status).join(','));
    });
    await T('un restaurante suspendido no obtiene firmas nuevas', async () => {
      const pb = await nuevoPedidoPendiente(hB, B, 20000);
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'suspendido' }); R.invalidarCache();
      const r = await invocar(M.firma, { metodo: 'POST', host: hB, cuerpo: { referencia: pb.referencia, montoEnCentavos: pb.total * 100, modo: 'test' } });
      await parchear('restaurantes', `id=eq.${B.id}`, { estado: 'activo' }); R.invalidarCache();
      return es(r.status === 403 && r.cuerpo.motivo === 'servicio_suspendido', r.status);
    });

    /* =====================================================================
       10. DEFENSAS DEL CLIENTE DE SUPABASE
    ===================================================================== */
    grupo('cliente');
    await T('sin restaurante_id valido ninguna funcion de negocio consulta la base', async () => {
      const desde = registro.length;
      const llamadas = [
        () => S.consultarTabla(undefined, 'productos', 'select=id'), () => S.consultarTabla(null, 'productos', 'select=id'),
        () => S.consultarTabla('', 'productos', 'select=id'), () => S.consultarTabla('no-es-uuid', 'productos', 'select=id'),
        () => S.consultarTabla(`${A.id}&restaurante_id=neq.${A.id}`, 'productos', 'select=id'),
        () => S.consultarPedidos(undefined, 'select=id'), () => S.leerConfiguracion(undefined), () => S.leerTarifasDomicilio(''),
        () => S.leerSecretosRestaurante(undefined), () => S.insertarPedido(undefined, {}), () => S.buscarPedidoPorReferencia(undefined, 'x'),
        () => S.actualizarPedidoPorReferencia(undefined, 'x', {}), () => S.registrarSaludNotificacion(undefined, true), () => S.marcarReembolsado(undefined, 'x')
      ];
      for (const l of llamadas) {
        let lanzo = false;
        try { await l(); } catch (e) { lanzo = true; }
        if (!lanzo) return es(false, 'una funcion acepto un restaurante invalido: ' + String(l).slice(0, 60));
      }
      return es(registro.length === desde, 'se hizo una peticion a la base');
    });
    // --- cada funcion del cliente, con el id del OTRO restaurante, no ve ni toca nada ---------------------
    const refN = `TAQ-CL-${sfx}-N`, refC = `TAQ-CL-${sfx}-C`;
    await sembrarSinAtender(A, refN);
    await pedidoCancelado(A, refC);
    await T('cliente: buscar/actualizar/consultar un pedido de A con el id de B no ve ni cambia nada (y con el de A si)', async () => {
      const verB = await S.buscarPedidoPorReferencia(B.id, refN), verA = await S.buscarPedidoPorReferencia(A.id, refN);
      const actB = await S.actualizarPedidoPorReferencia(B.id, refN, { notificacion_ok: true });
      const intacto = (await pedidoDe(A, refN)).notificacion_ok === null;
      const listaB = await S.consultarPedidos(B.id, `estado=eq.nuevo&referencia=eq.${refN}&select=referencia`);
      const listaA = await S.consultarPedidos(A.id, `estado=eq.nuevo&referencia=eq.${refN}&select=referencia`);
      const actA = await S.actualizarPedidoPorReferencia(A.id, refN, { notificacion_ok: false });
      return es(verB === null && verA && verA.referencia === refN && actB === null && intacto && listaB.length === 0 && listaA.length === 1 && actA && actA.notificacion_ok === false,
        `${verB} ${!!verA} ${actB} ${intacto} ${listaB.length} ${listaA.length}`);
    });
    await T('cliente: el reembolso condicional con el id de B no toca el pedido de A', async () => {
      const b = await S.marcarReembolsado(B.id, refC);
      const intacto = (await pedidoDe(A, refC)).reembolsado_en === null;
      const a = await S.marcarReembolsado(A.id, refC);
      const otraVez = await S.marcarReembolsado(A.id, refC);
      return es(b === null && intacto && a && a.reembolsado_en && otraVez === null, `${b} ${intacto} ${!!a} ${otraVez}`);
    });
    await T('cliente: menu, tarifas, secretos y configuracion de cada restaurante son solo suyos', async () => {
      const prodB = await S.consultarTabla(B.id, 'productos', 'select=id,nombre'), prodA = await S.consultarTabla(A.id, 'productos', 'select=id,nombre');
      const tarB = await S.leerTarifasDomicilio(B.id), tarA = await S.leerTarifasDomicilio(A.id);
      const secB = await S.leerSecretosRestaurante(B.id), cfgB = await S.leerConfiguracion(B.id);
      return es(prodB.length === 2 && prodB.every((p) => /de B|solo-b/i.test(p.nombre + p.id)) && prodA.every((p) => /de A|solo-a/i.test(p.nombre + p.id))
        && igual(tarB.map((t) => [Number(t.hasta), t.precio]), [[2, 4500], [3, 5500], [999, null]]) && igual(tarA.map((t) => [Number(t.hasta), t.precio]), [[2, 3000], [5, 6000], [999, null]])
        && secB.restaurante_id === B.id && secB.wompi_eventos_test === secretoDe('b', 'eventos-test') && cfgB.restaurante_id === B.id, JSON.stringify([prodB, tarB]).slice(0, 200));
    });
    await T('cliente: la salud del WhatsApp cuenta los fallos de SU fila (no de otra) y solo cambia la suya', async () => {
      await parchear('salud_notificaciones', `restaurante_id=eq.${A.id}`, { fallos_seguidos: 5 });
      await parchear('salud_notificaciones', `restaurante_id=eq.${B.id}`, { fallos_seguidos: 2 });
      await parchear('salud_notificaciones', `restaurante_id=eq.${C.id}`, { fallos_seguidos: 9 });
      await S.registrarSaludNotificacion(B.id, false, 'prueba');
      const a = await salud(A), b = await salud(B), c = await salud(C);
      await S.registrarSaludNotificacion(B.id, true);
      const b2 = await salud(B);
      return es(b.fallos_seguidos === 3 && b.ultimo_ok === false && a.fallos_seguidos === 5 && c.fallos_seguidos === 9 && b2.fallos_seguidos === 0 && b2.ultimo_ok === true && (await salud(A)).fallos_seguidos === 5,
        `${a.fallos_seguidos} ${b.fallos_seguidos} ${c.fallos_seguidos} ${b2.fallos_seguidos}`);
    });
    await T('cliente: insertarPedido guarda en el restaurante que recibe, aunque el pedido traiga otro restaurante_id', async () => {
      const fila = await S.insertarPedido(B.id, { restaurante_id: A.id, referencia: `TAQ-CL-${sfx}-I`, estado: 'pendiente_pago', estado_pago: 'pendiente', cliente_nombre: 'Insert', cliente_telefono: '3001112233',
        tipo_pedido: 'llevar', items: [], subtotal: 1000, costo_domicilio: 0, total: 1000 });
      return es(fila.restaurante_id === B.id && Number(fila.numero) >= 1, JSON.stringify(fila).slice(0, 120));
    });
    await T('consultarTabla rechaza nombres de tabla raros', async () => {
      for (const t of ['productos?x=1', 'pedidos;drop', 'a/b', '']) { try { await S.consultarTabla(A.id, t, 'select=id'); return es(false, t); } catch (e) { /* ok */ } }
      return true;
    });
    await T('las respuestas de error nunca incluyen la llave secreta', async () => {
      falla = null;
      let texto = '';
      const original = process.env.SUPABASE_URL;
      process.env.SUPABASE_URL = URL_BASE + '/no-existe';
      try { await S.leerConfiguracion(A.id); } catch (e) { texto = e.message; }
      process.env.SUPABASE_URL = original;
      return es(texto.length > 0 && !texto.includes(llaveServicio), texto.slice(0, 100));
    });

    /* =====================================================================
       11. NADA SECRETO SALE: ni en respuestas ni en el log
    ===================================================================== */
    grupo('secretos');
    await T('ningun secreto (Wompi, CallMeBot, llave de servicio, tokens) aparece en ninguna respuesta de la API ni en el log de la corrida', async () => {
      const todo = respuestas.join('\n') + '\n' + logs.join('\n');
      const fugas = todosLosSecretos.filter((s) => s && String(s).length > 6 && todo.includes(s));
      return es(fugas.length === 0 && respuestas.length > 50, `${fugas.length} fugas; ${respuestas.length} respuestas revisadas; ` + fugas.map((s) => s.slice(0, 12) + '...').join(','));
    });
    await T('el log avisa (sin imprimir valores) cuando Taqueiros usa una variable de entorno como respaldo', async () => {
      if (real) return true;   // no se uso el respaldo en modo real
      const l = logs.filter((x) => /\[Secretos\].*respaldo/.test(x));
      return es(l.length >= 1 && l.every((x) => /WOMPI_|CALLMEBOT_/.test(x)), logs.length);
    });
  } finally {
    // ---- limpieza (siempre) ---------------------------------------------------------------------
    globalThis.fetch = fetchReal;
    Date.now = dateNowReal;
    for (const n of Object.keys(consolaReal)) console[n] = consolaReal[n];
    const fallosLimpieza = [];
    const ids = creados.restaurantes;
    const lista = ids.length ? `(${ids.join(',')})` : null;
    const borrar = async (ruta) => {
      try {
        const r = await fetchReal(`${URL_BASE}/rest/v1/${ruta}`, { method: 'DELETE', headers: H({ Prefer: 'return=minimal' }) });
        if (!r.ok) fallosLimpieza.push(`${ruta.slice(0, 60)} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
      } catch (e) { fallosLimpieza.push(`${ruta.slice(0, 60)} -> ${e.message}`); }
    };
    if (lista) {
      for (const t of ['pedidos', 'productos', 'categorias', 'tarifas_domicilio', 'miembros', 'restaurante_dominios', 'configuracion', 'salud_notificaciones', 'intentos_buscar_pedido']) {
        await borrar(`${t}?restaurante_id=in.${lista}`);
      }
      await borrar(`restaurantes?id=in.${lista}`);
    }
    if (creados.pedidosTaqueiros.length) {
      await borrar(`pedidos?restaurante_id=eq.${TAQUEIROS_ID}&referencia=in.(${creados.pedidosTaqueiros.join(',')})`);
    }
    if (creados.configTaqueiros) {
      try { await fetchReal(`${URL_BASE}/rest/v1/configuracion?restaurante_id=eq.${TAQUEIROS_ID}`, { method: 'PATCH', headers: H({ Prefer: 'return=minimal' }), body: JSON.stringify(creados.configTaqueiros) }); }
      catch (e) { fallosLimpieza.push('config de Taqueiros -> ' + e.message); }
    }
    for (const u of creados.usuarios) {
      try { await fetchReal(`${URL_BASE}/auth/v1/admin/users/${u}`, { method: 'DELETE', headers: H() }); } catch (e) { fallosLimpieza.push('usuario ' + u + ' -> ' + e.message); }
    }
    // Los inserts de prueba consumen ids de la secuencia: se realinea (solo la funcion del SQL 10, solo servidor)
    try { await fetchReal(`${URL_BASE}/rest/v1/rpc/realinear_secuencia_pedidos`, { method: 'POST', headers: H(), body: '{}' }); } catch (e) { /* no es critico */ }
    // restaurar el entorno
    for (const k of Object.keys(process.env)) if (!(k in entornoOriginal)) delete process.env[k];
    Object.assign(process.env, entornoOriginal);
    resultados.limpieza = fallosLimpieza;
  }
  return { resultados, limpieza: resultados.limpieza };
}
