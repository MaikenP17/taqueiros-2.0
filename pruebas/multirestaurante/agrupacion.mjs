/* =============================================================
   PRUEBA DE LA AGRUPACION DE ENDPOINTS  (docs/multirestaurante.md, seccion 17)

   Vercel Hobby permite 12 funciones por despliegue. api/ pasó de 11 funciones a 6
   (api/publico.js y api/cron.js despachan a los modulos de api/_modulos/) sin cambiar
   una sola URL ni un solo comportamiento. Esta bateria lo demuestra:

     A. CUENTA de funciones: las que Vercel cuenta (archivos de api/ que no empiezan por
        guion bajo) son EXACTAMENTE estas 6 y nunca pasan de 7.
     B. CADA URL EXTERNA llega al modulo correcto. Se reemplazan los modulos por testigos y se
        pasa cada URL (webhook, cron con Bearer y con ?clave=, manifest, menu...) por el
        enrutador de Vercel (vercel-emulador.mjs, que aplica vercel.json) y por el despachador,
        con las dos formas en que Vercel puede entregar la URL (la original o la reescrita).
     C. EQUIVALENCIA, escenario por escenario: el mismo guion de peticiones se ejecuta contra
        el codigo de ANTES (el commit d689d4d, sacado de git) y contra el de AHORA, cada uno con su
        propia base (Postgres real en PGlite, con los SQL 10 a 13) sembrada igual. Se comparan el
        codigo de estado, el cuerpo y TODAS las cabeceras de cada respuesta, y al final el estado
        de las dos bases (pedidos, avisos). Solo se normalizan los valores que cambian en cada
        corrida por diseno (referencias TAQ-<ms>-<hex>, tokens, fechas).

     node pruebas/multirestaurante/agrupacion.mjs
     node pruebas/multirestaurante/agrupacion.mjs --antes=<commit>     (otro commit como "antes")
     MUTAR=1 ...                                                        (solo la revision por mutacion de A y B)

   Necesita git y, una vez:  npm i --no-save @electric-sql/pglite@0.2.17
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { levantar } from './fake-supabase.mjs';
import { crearEmulador, listarFunciones } from './vercel-emulador.mjs';
import { REPO } from './sim.mjs';

const require = createRequire(import.meta.url);
const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const ANTES = arg('antes') || 'd689d4d';
// El codigo de "ahora" que se prueba: el del repositorio, o (revision por mutacion) una copia mutada con
// api/, vercel.json, index.html y pedido.html.
const RAIZ = process.env.AGRUPACION_REPO ? path.resolve(process.env.AGRUPACION_REPO) : REPO;
// Puertos del Supabase falso (la revision por mutacion corre varias copias a la vez: cada una con su desplazamiento)
const PUERTO_OFFSET = Number(process.env.PUERTO_OFFSET || 0);
const LLAVE = 'sb_secret_FAKE_0000';
const PUBLICABLE = 'sb_publishable_FAKE_0000';
const FUNCIONES_ESPERADAS = ['api/crear-pedido.js', 'api/cron.js', 'api/generar-firma.js', 'api/publico.js', 'api/reembolso.js', 'api/webhook-wompi.js'];
const MAXIMO_DE_FUNCIONES = 7;

const resultados = [];
const comprobar = (cond, nombre, info) => resultados.push({ nombre, ok: !!cond, info: cond ? '' : String(info === undefined ? '' : info) });
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/* ================================================================================================
   A. CUENTA DE FUNCIONES
================================================================================================ */
export function pruebaCuenta(repo = RAIZ) {
  const funciones = listarFunciones(repo);
  comprobar(funciones.length <= MAXIMO_DE_FUNCIONES, `A1 las funciones de Vercel no pasan de ${MAXIMO_DE_FUNCIONES} (hay ${funciones.length})`, funciones.join(', '));
  comprobar(JSON.stringify(funciones) === JSON.stringify(FUNCIONES_ESPERADAS), 'A2 son exactamente las 6 esperadas (si cambia la lista, hay que decidirlo a proposito)', funciones.join(', '));

  // lo que empieza por guion bajo no cuenta: el contenido de _modulos/ y los helpers
  const todos = [];
  (function rec(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(path.join(dir, e.name), r); else todos.push(`api/${r}`);
    }
  })(path.join(repo, 'api'), '');
  const noContadas = todos.filter((f) => !funciones.includes(f));
  comprobar(noContadas.every((f) => f.split('/').some((s) => s.startsWith('_'))), 'A3 todo lo demas de api/ esta bajo un nombre con guion bajo (no es una funcion)', noContadas.join(', '));
  comprobar(todos.filter((f) => f.startsWith('api/_modulos/')).length >= 8, 'A4 los modulos agrupados estan en api/_modulos/');

  // vercel.json solo nombra funciones que existen
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'vercel.json'), 'utf8'));
  const claves = Object.keys(cfg.functions || {});
  comprobar(claves.every((k) => funciones.includes(k)), 'A5 vercel.json "functions" solo nombra funciones que existen', claves.join(', '));
  const emu = crearEmulador(repo);
  for (const c of cfg.crons || []) {
    const r = emu.resolver({ ruta: c.path, headers: {} });
    comprobar(r.tipo === 'funcion', `A6 el cron ${c.path} llega a una funcion`, JSON.stringify(r));
  }
  // la funcion que sirve la vista previa lleva las paginas que lee
  const inc = (cfg.functions['api/publico.js'] || {}).includeFiles || '';
  comprobar(/index/.test(inc) && /pedido/.test(inc), 'A7 api/publico.js incluye index.html y pedido.html (la vista previa las lee)', inc);
  return { funciones };
}

/* ================================================================================================
   B. CADA URL EXTERNA LLEGA AL MODULO CORRECTO
================================================================================================ */
function copiarCarpeta(origen, destino) {
  fs.mkdirSync(destino, { recursive: true });
  for (const e of fs.readdirSync(origen, { withFileTypes: true })) {
    const o = path.join(origen, e.name), d = path.join(destino, e.name);
    if (e.isDirectory()) copiarCarpeta(o, d); else fs.copyFileSync(o, d);
  }
}

/* Una copia de api/ cuyos modulos agrupados son testigos: responden quien son y lo que recibieron. */
export function crearTestigos(repo, raiz) {
  const api = path.join(raiz, 'api');
  copiarCarpeta(path.join(repo, 'api'), api);
  for (const f of fs.readdirSync(path.join(api, '_modulos'))) {
    const nombre = f.replace(/[.]js$/, '');
    fs.writeFileSync(path.join(api, '_modulos', f), `module.exports = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  res.status(200).json({ modulo: ${JSON.stringify(nombre)}, metodo: req.method, auth: (req.headers && req.headers.authorization) || null,
    clave: u.searchParams.get('clave'), r: u.searchParams.get('r'), host: (req.headers && req.headers.host) || null,
    cuerpo: req.body === undefined ? null : req.body });
};\n`);
  }
  return api;
}

export async function pruebaRutas(repo = RAIZ) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-agrup-'));
  try {
    const api = crearTestigos(repo, tmp);
    const emu = crearEmulador(repo);
    const UA_HUMANO = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120';
    const casos = [
      // URL externa                    metodo  modulo esperado   funcion
      ['/api/menu', 'GET', 'menu', 'api/publico.js'],
      ['/api/menu?r=otro', 'GET', 'menu', 'api/publico.js'],
      ['/api/estado', 'GET', 'estado', 'api/publico.js'],
      ['/api/disponibilidad', 'GET', 'disponibilidad', 'api/publico.js'],
      ['/api/restaurante', 'GET', 'restaurante', 'api/publico.js'],
      ['/api/restaurante', 'POST', 'restaurante', 'api/publico.js'],
      ['/api/manifest', 'GET', 'manifest', 'api/publico.js'],
      ['/manifest.json', 'GET', 'manifest', 'api/publico.js'],
      ['/manifest.json', 'HEAD', 'manifest', 'api/publico.js'],
      ['/api/alertas', 'GET', 'alertas', 'api/cron.js'],
      ['/api/alertas?clave=el-secreto', 'GET', 'alertas', 'api/cron.js'],
      ['/api/keep-alive', 'GET', 'keep-alive', 'api/cron.js'],
      ['/api/keep-alive?clave=el-secreto', 'GET', 'keep-alive', 'api/cron.js']
    ];
    const entregas = ['original', 'reescrita', 'reescrita-con-query', 'original-con-query'];
    let fallas = [];
    for (const [ruta, metodo, esperado, archivoEsperado] of casos) {
      const r = emu.resolver({ metodo, ruta, headers: { 'user-agent': UA_HUMANO, authorization: 'Bearer el-secreto' } });
      if (r.tipo !== 'funcion' || r.archivo !== archivoEsperado) { fallas.push(`${metodo} ${ruta} -> ${JSON.stringify(r)}`); continue; }
      for (const entrega of entregas) {
        const url = entrega.startsWith('original') ? r.urlOriginal : r.urlReescrita;
        const query = entrega.endsWith('con-query') ? Object.fromEntries(new URLSearchParams(r.urlReescrita.split('?')[1] || '')) : {};
        const modulo = require(path.join(tmp, r.archivo));
        const salida = await ejecutar(modulo, { method: metodo, url, headers: { host: 'x.test', authorization: 'Bearer el-secreto' }, query });
        const q = new URLSearchParams(ruta.split('?')[1] || '');
        const bien = salida.status === 200 && salida.cuerpo && salida.cuerpo.modulo === esperado && salida.cuerpo.metodo === metodo
          && salida.cuerpo.auth === 'Bearer el-secreto' && salida.cuerpo.clave === q.get('clave') && salida.cuerpo.r === q.get('r') && salida.cuerpo.host === 'x.test';
        if (!bien) fallas.push(`${metodo} ${ruta} (${entrega}) -> ${salida.status} ${JSON.stringify(salida.cuerpo)}`);
      }
    }
    comprobar(fallas.length === 0, `B1 las ${casos.length} URL externas (menu, estado, disponibilidad, restaurante, manifest, /manifest.json, alertas y keep-alive con Bearer y con una consulta ?clave= que viaja intacta) llegan a su modulo, con su metodo, cabeceras y consulta, entregadas de las 4 formas`, fallas.slice(0, 4).join(' | '));

    // las funciones que NO se agruparon siguen en su URL de siempre
    const propias = [['/api/webhook-wompi', 'POST', 'api/webhook-wompi.js'], ['/api/crear-pedido', 'POST', 'api/crear-pedido.js'],
      ['/api/generar-firma', 'POST', 'api/generar-firma.js'], ['/api/reembolso', 'POST', 'api/reembolso.js']];
    const mal = propias.filter(([ruta, metodo, archivo]) => { const r = emu.resolver({ metodo, ruta, headers: {} }); return !(r.tipo === 'funcion' && r.archivo === archivo && r.urlOriginal === ruta && r.urlReescrita === ruta); });
    comprobar(mal.length === 0, 'B2 /api/webhook-wompi, /api/crear-pedido, /api/generar-firma y /api/reembolso siguen siendo sus propios archivos (la URL de Wompi no cambia)', mal.join(','));

    // un cliente no puede cambiar de endpoint con ?_ruta=, ni llegar a lo que la funcion no agrupa
    const publico = require(path.join(tmp, 'api/publico.js')), cron = require(path.join(tmp, 'api/cron.js'));
    const pide = async (fn, url, query = {}) => ejecutar(fn, { method: 'GET', url, headers: { host: 'x.test' }, query });
    const a1 = await pide(publico, '/api/menu?_ruta=restaurante');
    comprobar(a1.cuerpo.modulo === 'menu', 'B3 /api/menu?_ruta=restaurante sigue siendo menu (el PATH manda sobre el parametro)', JSON.stringify(a1.cuerpo));
    const a2 = await pide(publico, '/api/publico');
    comprobar(a2.status === 404 && a2.cuerpo.error === 'No encontrado', 'B4 /api/publico sin _ruta responde 404 "No encontrado"', JSON.stringify(a2));
    const malos = ['alertas', 'keep-alive', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'MENU', 'menu%00', 'menu/..', '../menu', 'cron'];
    const llegaron = [];
    for (const v of malos) {
      for (const [fn, nom] of [[publico, 'publico']]) {
        const s = await pide(fn, '/api/publico?_ruta=' + encodeURIComponent(v));
        if (s.status !== 404 && !(['menu'].includes(v))) llegaron.push(`${nom}:${v}->${s.status}`);
      }
    }
    for (const v of ['menu', 'estado', 'restaurante', 'manifest', 'vista-previa', '__proto__', 'constructor', 'publico']) {
      const s = await pide(cron, '/api/cron?_ruta=' + encodeURIComponent(v));
      if (s.status !== 404) llegaron.push(`cron:${v}->${s.status}`);
    }
    for (const p of ['/api/constructor', '/api/__proto__', '/api/toString', '/api/hasOwnProperty', '/api/valueOf']) {
      const s = await pide(publico, p);
      if (s.status !== 404) llegaron.push(`path ${p}->${s.status}`);
      const c = await pide(cron, p);
      if (c.status !== 404) llegaron.push(`cron path ${p}->${c.status}`);
    }
    comprobar(llegaron.length === 0, 'B5 un _ruta desconocido, de otra funcion o con nombres como __proto__/constructor responde 404 (y publico no sirve alertas/keep-alive ni cron sirve el menu)', llegaron.join(', '));
    const a3 = await pide(publico, '/api/publico?_ruta=menu&_ruta=estado');
    comprobar(a3.cuerpo && ['menu', 'estado'].includes(a3.cuerpo.modulo), 'B6 un _ruta repetido no rompe el despachador', JSON.stringify(a3));
    const a4 = await pide(publico, '/api/estado', { _ruta: 'menu' });
    comprobar(a4.cuerpo.modulo === 'estado', 'B7 con req.query._ruta distinto, el PATH sigue mandando', JSON.stringify(a4.cuerpo));
    const a5 = await pide(publico, 'esto no es una url ::::', {});
    comprobar(a5.status === 404 || a5.status === 200, 'B8 una URL rara no lanza una excepcion', JSON.stringify(a5));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* Ejecuta un manejador con una peticion y devuelve { status, cuerpo, cab } (cabeceras en minusculas). */
export function ejecutar(manejador, { method = 'GET', url, headers = {}, body, query = {} }) {
  return new Promise((resolve) => {
    const req = { method, url, headers, body, query };
    let hecho = false;
    const fin = (status, cuerpo, cab) => {
      if (hecho) return; hecho = true;
      const minus = {};
      for (const k of Object.keys(cab).sort()) minus[k.toLowerCase()] = cab[k];
      resolve({ status, cuerpo, cab: minus });
    };
    const res = {
      code: 200, cab: {},
      setHeader(k, v) { this.cab[k] = v; },
      getHeader(k) { return this.cab[k]; },
      status(c) { this.code = c; return this; },
      json(o) { fin(this.code, o, this.cab); return this; },
      send(o) { fin(this.code, o, this.cab); return this; },
      end() { fin(this.code, undefined, this.cab); return this; }
    };
    Promise.resolve(manejador(req, res)).catch((e) => fin(500, { error: 'EXCEPCION: ' + e.message }, {}));
  });
}

/* ================================================================================================
   C. EQUIVALENCIA ANTES / DESPUES
================================================================================================ */
const IDS = {
  A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  TAQ: '00000000-0000-4000-8000-000000000001'
};
const HOSTS = { A: 'a.equivalencia.test', B: 'b.equivalencia.test', C: 'c.equivalencia.test', TAQ: 'taqueiros-2-0.vercel.app', DESCONOCIDO: 'nadie.equivalencia.test' };
const SECRETO_CRON = 'cron-equivalencia-0123456789';

/* La misma carpeta api/ que habia en el commit ANTES, sacada de git. */
export function extraerAntes(commit, destino) {
  const lista = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', commit, 'api/'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of lista) {
    const contenido = execFileSync('git', ['-C', REPO, 'show', `${commit}:${f}`], { maxBuffer: 20 * 1024 * 1024 });
    const d = path.join(destino, f);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.writeFileSync(d, contenido);
  }
  return lista;
}

const RUTA_ANTES = {
  '/api/menu': 'menu', '/api/estado': 'estado', '/api/disponibilidad': 'disponibilidad', '/api/restaurante': 'restaurante',
  '/api/manifest': 'manifest', '/manifest.json': 'manifest', '/api/alertas': 'alertas', '/api/keep-alive': 'keep-alive',
  '/api/crear-pedido': 'crear-pedido', '/api/generar-firma': 'generar-firma', '/api/reembolso': 'reembolso', '/api/webhook-wompi': 'webhook-wompi'
};

/* Valores que por diseno cambian en cada corrida. */
export function normalizar(t) {
  return String(t)
    .replace(/TAQ-[0-9]+-[0-9a-f]{6}/g, 'TAQ-<ref>')
    .replace(/"tokenSeguimiento":"[0-9a-f]{32}"/g, '"tokenSeguimiento":"<tok>"')
    .replace(/[0-9a-f]{32}/g, '<hex32>')
    .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, '<ts>')
    .replace(/"[a-z_]*(creado_en|actualizado_en|pagado_en|impreso_en|fecha)[a-z_]*":"[^"]*"/g, '"<fecha>":"<ts>"');
}

async function levantarLado(nombre, puerto) {
  const falso = await levantar({ puerto, validarConfig: true });
  const { cabecerasSupabase } = require(path.join(REPO, 'api', '_llave.js'));
  const rest = async (metodo, ruta, cuerpo, prefer) => {
    const r = await globalThis.fetchReal(`${falso.url}/rest/v1/${ruta}`, {
      method: metodo, headers: cabecerasSupabase(LLAVE, prefer ? { Prefer: prefer } : (metodo === 'GET' ? undefined : { Prefer: 'return=representation' })),
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${nombre}: ${metodo} ${ruta.slice(0, 50)} -> ${r.status} ${t.slice(0, 160)}`);
    return t ? JSON.parse(t) : null;
  };
  return { nombre, falso, url: falso.url, rest, ctx: {}, dir: null };
}

function horarios(abre = '00:00', cierra = '24:00') {
  return ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'].map((dia) => ({ dia, abre, cierra, activo: true }));
}

export async function pruebaEquivalencia(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-equiv-'));
  const consolaReal = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const entorno = { ...process.env };
  globalThis.fetchReal = globalThis.fetch;
  let L1 = null, L2 = null;
  const callmebot = { antes: [], ahora: [] };
  let ladoActual = 'antes';
  try {
    // ---- el codigo de antes y el de ahora ----
    const antesDir = path.join(tmp, 'antes');
    const archivosAntes = extraerAntes(ANTES, antesDir);
    comprobar(archivosAntes.length >= 20, `C0 se pudo sacar de git el api/ de ${ANTES} (${archivosAntes.length} archivos)`, archivosAntes.length);
    const emu = crearEmulador(RAIZ);

    // ---- dos bases iguales ----
    L1 = await levantarLado('antes', 54341 + PUERTO_OFFSET);
    L2 = await levantarLado('ahora', 54342 + PUERTO_OFFSET);

    globalThis.fetch = async function (u, o) {
      const url = String(u);
      if (url.startsWith('https://api.callmebot.com/')) {
        const q = new URL(url).searchParams;
        callmebot[ladoActual].push({ phone: q.get('phone'), text: q.get('text') });
        return new Response('Message queued. You will receive it in a few seconds', { status: 200 });
      }
      if (url.includes('nominatim.openstreetmap.org')) return new Response(JSON.stringify({ address: { neighbourhood: 'Barrio Prueba' } }), { status: 200 });
      return globalThis.fetchReal(u, o);
    };
    for (const n of ['log', 'warn', 'error', 'info']) console[n] = () => {};

    for (const L of [L1, L2]) await sembrarFijo(L);

    // ---- entorno comun ----
    process.env.SUPABASE_SERVICE_ROLE_KEY = LLAVE;
    process.env.SUPABASE_PUBLISHABLE_KEY = PUBLICABLE;
    process.env.CRON_SECRET = SECRETO_CRON;
    process.env.VERCEL_ENV = 'production';
    delete process.env.DOMINIO_BASE;
    delete process.env.RESTAURANTE_POR_PARAMETRO;
    for (const k of ['WOMPI_INTEGRITY_SECRET_TEST', 'WOMPI_INTEGRITY_SECRET_PROD', 'WOMPI_EVENTS_SECRET_TEST', 'WOMPI_EVENTS_SECRET_PROD', 'CALLMEBOT_PHONE', 'CALLMEBOT_APIKEY']) delete process.env[k];

    const escenarios = guionDeEscenarios();
    let n = 0;
    const diferencias = [];
    const porGrupo = {};

    for (const esc of escenarios) {
      n++;
      const variantes = esc.mutante ? ['reescrita'] : ['original', 'reescrita'];
      let respAntes = null;
      if (esc.preparar) { await esc.preparar(L1); await esc.preparar(L2); }
      for (const variante of variantes) {
        // ANTES (una vez; los escenarios que no modifican nada se repiten contra "ahora" en las dos variantes)
        if (!respAntes) {
          ladoActual = 'antes';
          process.env.SUPABASE_URL = L1.url;
          respAntes = await correrAntes(L1, esc, antesDir);
        }
        ladoActual = 'ahora';
        process.env.SUPABASE_URL = L2.url;
        const ahora = await correrAhora(L2, esc, emu, variante);
        // exigirAhora: cambios hechos a proposito despues del commit de referencia (se exige lo nuevo en vez de la igualdad)
        const d = esc.exigirAhora ? esc.exigirAhora(ahora) : comparar(respAntes, ahora);
        (porGrupo[esc.grupo] = porGrupo[esc.grupo] || { total: 0, mal: 0 }).total++;
        if (d) { porGrupo[esc.grupo].mal++; diferencias.push(`[${esc.grupo}] ${esc.nombre} (${variante}): ${d}`); }
        if (esc.despues) { await esc.despues(L1, respAntes, 'antes'); await esc.despues(L2, ahora, 'ahora'); }
      }
    }

    Object.assign(console, consolaReal);
    for (const g of Object.keys(porGrupo)) {
      comprobar(porGrupo[g].mal === 0, `C1 equivalencia de "${g}": ${porGrupo[g].total} comparaciones identicas en codigo, cuerpo y cabeceras`, diferencias.filter((x) => x.startsWith(`[${g}]`)).slice(0, 3).join(' | '));
    }

    // ---- estado final de las dos bases ----
    const estado = async (L) => {
      const salida = {};
      for (const [tabla, orden] of [['pedidos', 'id'], ['salud_notificaciones', 'restaurante_id'], ['contadores_pedido', 'restaurante_id']]) {
        salida[tabla] = await L.rest('GET', `${tabla}?select=*&order=${orden}.asc`);
      }
      return normalizar(JSON.stringify(salida));
    };
    const e1 = await estado(L1), e2 = await estado(L2);
    comprobar(e1 === e2, 'C2 al terminar, las dos bases quedaron iguales (pedidos, salud del WhatsApp, contadores)', e1 === e2 ? '' : primeraDiferencia(e1, e2));
    const avisos = (l) => normalizar(JSON.stringify(l.map((x) => [x.phone, x.text])));
    comprobar(avisos(callmebot.antes) === avisos(callmebot.ahora) && callmebot.antes.length > 0,
      `C3 los avisos de WhatsApp salieron iguales (${callmebot.antes.length} antes, ${callmebot.ahora.length} ahora)`, JSON.stringify([callmebot.antes, callmebot.ahora]).slice(0, 300));
    comprobar(escenarios.length >= 60, `C4 el guion tiene ${escenarios.length} escenarios (minimo 60)`, escenarios.length);
    opts.total = n;
  } finally {
    Object.assign(console, consolaReal);
    globalThis.fetch = globalThis.fetchReal;
    for (const k of Object.keys(process.env)) if (!(k in entorno)) delete process.env[k];
    Object.assign(process.env, entorno);
    for (const L of [L1, L2]) if (L) await L.falso.cerrar();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function primeraDiferencia(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `en la posicion ${i}: "${a.slice(Math.max(0, i - 40), i + 80)}" vs "${b.slice(Math.max(0, i - 40), i + 80)}"`;
}

async function correrAntes(L, esc, antesDir) {
  const spec = await esc.spec(L);
  const pathname = spec.ruta.split('?')[0];
  const archivo = RUTA_ANTES[pathname];
  if (!archivo) return { status: 404, cuerpo: { error: 'sin ruta en el codigo anterior' }, cab: {} };
  const manejador = require(path.join(antesDir, 'api', archivo + '.js'));
  return ejecutar(manejador, { method: spec.metodo || 'GET', url: spec.ruta, headers: { host: spec.host, ...(spec.headers || {}) }, body: spec.cuerpo, query: {} });
}

async function correrAhora(L, esc, emu, variante) {
  const spec = await esc.spec(L);
  const r = emu.resolver({ metodo: spec.metodo || 'GET', ruta: spec.ruta, headers: { host: spec.host, ...(spec.headers || {}) } });
  if (r.tipo !== 'funcion') return { status: 404, cuerpo: { error: 'el enrutador no llego a una funcion: ' + r.tipo }, cab: {} };
  const manejador = require(path.join(RAIZ, r.archivo));
  const url = variante === 'original' ? r.urlOriginal : r.urlReescrita;
  const query = variante === 'original' ? {} : Object.fromEntries(new URLSearchParams(r.urlReescrita.split('?')[1] || ''));
  return ejecutar(manejador, { method: spec.metodo || 'GET', url, headers: { host: spec.host, ...(spec.headers || {}) }, body: spec.cuerpo, query });
}

function comparar(a, b) {
  if (a.status !== b.status) return `codigo ${a.status} vs ${b.status}`;
  const ca = typeof a.cuerpo === 'string' ? a.cuerpo : JSON.stringify(a.cuerpo === undefined ? null : a.cuerpo);
  const cb = typeof b.cuerpo === 'string' ? b.cuerpo : JSON.stringify(b.cuerpo === undefined ? null : b.cuerpo);
  if (normalizar(ca) !== normalizar(cb)) return 'cuerpo: ' + primeraDiferencia(normalizar(ca), normalizar(cb));
  const ha = normalizar(JSON.stringify(a.cab)), hb = normalizar(JSON.stringify(b.cab));
  if (ha !== hb) return `cabeceras ${ha} vs ${hb}`;
  return null;
}

/* ---- datos fijos de las dos bases ---- */
async function sembrarFijo(L) {
  const cfg = (n) => ({
    ubicacion: { lat: 7.9, lng: -72.5 }, domicilio: { factor_recorrido: 1.3 },
    publico: { marca: { logo: `Recursos/${n}/logo.png`, colores: { primario: '#112233' }, emoji: '🍕' },
      textos: { eslogan: `Eslogan ${n}`, tagline: `Tagline ${n}`, titulo_pagina: `Titulo ${n}` },
      contacto: { whatsapp: '573001112233', telefono: `Tel ${n}`, instagram: `ig_${n}` } }
  });
  const rs = [['A', 'a', 'activo'], ['B', 'b', 'activo'], ['C', 'c', 'suspendido']];
  for (const [k, n, estado] of rs) {
    await L.rest('POST', 'restaurantes', { id: IDS[k], slug: `eq-${n}`, nombre: `Equivalencia ${k}`, estado, config: cfg(n) });
    await L.rest('POST', 'restaurante_dominios', { host: HOSTS[k], restaurante_id: IDS[k] });
    await L.rest('PATCH', `configuracion?restaurante_id=eq.${IDS[k]}`, { horarios: horarios(), cerrado_temporal: false });
  }
  for (const [k, precio] of [['A', 10000], ['B', 20000]]) {
    await L.rest('POST', 'categorias', [{ restaurante_id: IDS[k], id: 'tacos', nombre: 'Tacos', emoji: '🌮', orden: 1, activa: true }]);
    await L.rest('POST', 'productos', [
      { restaurante_id: IDS[k], id: 'taco', nombre: `Taco de ${k}`, precio, categoria: 'tacos', orden: 1, disponible: true },
      { restaurante_id: IDS[k], id: 'agotado', nombre: `Agotado de ${k}`, precio: 5000, categoria: 'tacos', orden: 2, disponible: false }
    ]);
  }
  await L.rest('POST', 'tarifas_domicilio', [[2, 3000], [5, 6000], [999, null]].map(([hasta, precio]) => ({ restaurante_id: IDS.A, hasta, precio })));
  await L.rest('PATCH', `restaurante_secretos?restaurante_id=eq.${IDS.A}`, {
    wompi_integridad_test: 'integridad-A-equiv', wompi_eventos_test: 'eventos-A-equiv', callmebot_telefono: '573009998877', callmebot_apikey: 'apikey-A-equiv',
    otros: { wompi_modo: 'test' }
  });
  await L.rest('PATCH', `restaurante_secretos?restaurante_id=eq.${IDS.B}`, { wompi_integridad_test: 'integridad-B-equiv', wompi_eventos_test: 'eventos-B-equiv', otros: { wompi_modo: 'test' } });
}

function firmaWebhook({ referencia, estado = 'APPROVED', centavos, secreto, ambiente = 'test', txId = 'tx-equiv-1', marca = 1700000000 }) {
  const data = { transaction: { id: txId, reference: referencia, status: estado, amount_in_cents: centavos, payment_method_type: 'CARD' } };
  const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
  const valores = properties.map((p) => p.split('.').reduce((v, k) => v[k], data)).join('');
  return { event: 'transaction.updated', data, environment: ambiente, signature: { checksum: sha(valores + marca + secreto), properties }, timestamp: marca };
}

const cliente = (extra = {}) => ({ nombre: 'Cliente Equivalencia', telefono: '3001234567', email: 'eq@example.com', tipoPedido: 'llevar', ...extra });

/* El guion. Cada escenario: { grupo, nombre, mutante?, spec(L) -> { metodo, host, ruta, headers, cuerpo }, despues?(L, resp) } */
function guionDeEscenarios() {
  const G = [];
  const e = (grupo, nombre, spec, extra = {}) => G.push({ grupo, nombre, spec: typeof spec === 'function' ? spec : async () => spec, ...extra });
  const get = (grupo, nombre, host, ruta, headers) => e(grupo, nombre, { host, ruta, headers });

  // ---- menu ----
  for (const k of ['A', 'B', 'TAQ', 'C']) get('menu', `menu de ${k}`, HOSTS[k], '/api/menu');
  get('menu', 'menu en host desconocido (404 neutro)', HOSTS.DESCONOCIDO, '/api/menu');
  get('menu', 'menu sin Host', undefined, '/api/menu');
  get('menu', 'menu con ?r= (apagado en produccion)', HOSTS.DESCONOCIDO, '/api/menu?r=eq-a');
  get('menu', 'menu con x-forwarded-host (no cuenta)', HOSTS.DESCONOCIDO, '/api/menu', { 'x-forwarded-host': HOSTS.A });
  e('menu', 'menu con POST (el menu no mira el metodo)', { metodo: 'POST', host: HOSTS.A, ruta: '/api/menu' });
  e('menu', 'menu con HEAD', { metodo: 'HEAD', host: HOSTS.A, ruta: '/api/menu' });

  // ---- estado y disponibilidad ----
  for (const k of ['A', 'B', 'TAQ', 'C']) get('estado', `estado de ${k}`, HOSTS[k], '/api/estado');
  get('estado', 'estado en host desconocido', HOSTS.DESCONOCIDO, '/api/estado');
  for (const k of ['A', 'B', 'C']) get('disponibilidad', `disponibilidad de ${k}`, HOSTS[k], '/api/disponibilidad');
  get('disponibilidad', 'disponibilidad en host desconocido', HOSTS.DESCONOCIDO, '/api/disponibilidad');

  // ---- restaurante y manifest ----
  for (const k of ['A', 'B', 'C', 'TAQ']) get('restaurante', `datos publicos de ${k}`, HOSTS[k], '/api/restaurante');
  get('restaurante', 'datos publicos en host desconocido', HOSTS.DESCONOCIDO, '/api/restaurante');
  e('restaurante', 'datos publicos con POST (405)', { metodo: 'POST', host: HOSTS.A, ruta: '/api/restaurante' });
  e('restaurante', 'datos publicos con HEAD', { metodo: 'HEAD', host: HOSTS.A, ruta: '/api/restaurante' });
  for (const k of ['A', 'B', 'TAQ']) {
    get('manifest', `/manifest.json de ${k}`, HOSTS[k], '/manifest.json');
    get('manifest', `/api/manifest de ${k}`, HOSTS[k], '/api/manifest');
  }
  get('manifest', '/manifest.json en host desconocido', HOSTS.DESCONOCIDO, '/manifest.json');
  e('manifest', '/manifest.json con POST (405)', { metodo: 'POST', host: HOSTS.A, ruta: '/manifest.json' });

  // ---- crons ----
  const bearer = { authorization: 'Bearer ' + SECRETO_CRON };
  for (const ruta of ['/api/alertas', '/api/keep-alive']) {
    const g = ruta === '/api/alertas' ? 'alertas' : 'keep-alive';
    get(g, `${ruta} sin credencial (401)`, 'cron.equivalencia.test', ruta);
    get(g, `${ruta} con Bearer`, 'cron.equivalencia.test', ruta, bearer);
    get(g, `${ruta} con bearer en minusculas`, 'cron.equivalencia.test', ruta, { authorization: 'bearer ' + SECRETO_CRON });
    // Cambio a proposito (paso 3A): ?clave= se retiro. El codigo anterior respondia 200; ahora tiene que responder 401.
    e(g, `${ruta} con ?clave= correcta (RETIRADA: ahora 401)`, { host: 'cron.equivalencia.test', ruta: `${ruta}?clave=${SECRETO_CRON}` },
      { exigirAhora: (r) => (r.status === 401 ? null : `respondio ${r.status} y debia ser 401`) });
    get(g, `${ruta} con ?clave= mala (401)`, 'cron.equivalencia.test', `${ruta}?clave=mala`);
    get(g, `${ruta} con Bearer malo (401)`, 'cron.equivalencia.test', ruta, { authorization: 'Bearer mala' });
    get(g, `${ruta} con clave vacia (401)`, 'cron.equivalencia.test', `${ruta}?clave=`);
    get(g, `${ruta} con Basic (401)`, 'cron.equivalencia.test', ruta, { authorization: 'Basic ' + SECRETO_CRON });
    get(g, `${ruta} con Bearer correcto y ?clave= mala`, 'cron.equivalencia.test', `${ruta}?clave=mala`, bearer);
  }

  // ---- crear-pedido ----
  const pedido = (host, items, c = cliente(), extra = {}) => ({ metodo: 'POST', host, ruta: '/api/crear-pedido', cuerpo: { cliente: c, items, modo: 'test', ...extra } });
  const guardarRef = (clave) => async (L, resp) => {
    const ref = resp.cuerpo && resp.cuerpo.referencia;
    if (ref) L.ctx[clave] = { referencia: ref, total: resp.cuerpo.total };
  };
  e('crear-pedido', 'pedido valido de A', pedido(HOSTS.A, [{ id: 'taco', cantidad: 2, precio: 10000 }]), { mutante: true, despues: async (L, resp) => { await guardarRef('pedidoA')(L, resp); } });
  e('crear-pedido', 'pedido valido de B', pedido(HOSTS.B, [{ id: 'taco', cantidad: 1, precio: 20000 }]), { mutante: true, despues: guardarRef('pedidoB') });
  e('crear-pedido', 'segundo pedido de A (numero siguiente)', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 10000 }]), { mutante: true, despues: guardarRef('pedidoA2') });
  e('crear-pedido', 'producto agotado', pedido(HOSTS.A, [{ id: 'agotado', cantidad: 1, precio: 5000 }]), { mutante: true });
  e('crear-pedido', 'producto de otro restaurante / desconocido', pedido(HOSTS.A, [{ id: 'solo-b', cantidad: 1, precio: 9000 }]), { mutante: true });
  e('crear-pedido', 'precio manipulado por el cliente', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 1 }]), { mutante: true });
  e('crear-pedido', 'sin items', pedido(HOSTS.A, []), { mutante: true });
  e('crear-pedido', 'sin cuerpo', { metodo: 'POST', host: HOSTS.A, ruta: '/api/crear-pedido', cuerpo: undefined }, { mutante: true });
  e('crear-pedido', 'GET (405)', { metodo: 'GET', host: HOSTS.A, ruta: '/api/crear-pedido' }, { mutante: true });
  e('crear-pedido', 'host desconocido', pedido(HOSTS.DESCONOCIDO, [{ id: 'taco', cantidad: 1, precio: 10000 }]), { mutante: true });
  e('crear-pedido', 'restaurante suspendido (403)', pedido(HOSTS.C, [{ id: 'taco', cantidad: 1, precio: 10000 }]), { mutante: true });
  e('crear-pedido', 'domicilio sin ubicacion (400)', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 10000 }], cliente({ tipoPedido: 'domicilio', direccion: 'Calle 1 # 2-3' })), { mutante: true });
  e('crear-pedido', 'domicilio con ubicacion', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 10000 }], cliente({ tipoPedido: 'domicilio', direccion: 'Calle 1 # 2-3', barrio: 'Centro', ubicacion: { lat: 7.909, lng: -72.5 } })), { mutante: true, despues: guardarRef('pedidoDomicilio') });
  e('crear-pedido', 'domicilio fuera de cobertura', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 10000 }], cliente({ tipoPedido: 'domicilio', direccion: 'Calle 1 # 2-3', barrio: 'Centro', ubicacion: { lat: 8.5, lng: -72.5 } })), { mutante: true });

  // ---- generar-firma ----
  e('firma', 'firma del pedido de A', async (L) => ({ metodo: 'POST', host: HOSTS.A, ruta: '/api/generar-firma', cuerpo: { referencia: (L.ctx.pedidoA || {}).referencia, montoEnCentavos: ((L.ctx.pedidoA || {}).total || 0) * 100, modo: 'test' } }), { mutante: true });
  e('firma', 'firma con otro monto (404)', async (L) => ({ metodo: 'POST', host: HOSTS.A, ruta: '/api/generar-firma', cuerpo: { referencia: (L.ctx.pedidoA || {}).referencia, montoEnCentavos: 100, modo: 'test' } }), { mutante: true });
  e('firma', 'firma del pedido de B desde el host de A (404)', async (L) => ({ metodo: 'POST', host: HOSTS.A, ruta: '/api/generar-firma', cuerpo: { referencia: (L.ctx.pedidoB || {}).referencia, montoEnCentavos: ((L.ctx.pedidoB || {}).total || 0) * 100, modo: 'test' } }), { mutante: true });
  e('firma', 'firma sin cuerpo (400)', { metodo: 'POST', host: HOSTS.A, ruta: '/api/generar-firma', cuerpo: {} }, { mutante: true });
  e('firma', 'firma con GET (405)', { metodo: 'GET', host: HOSTS.A, ruta: '/api/generar-firma' }, { mutante: true });
  e('firma', 'firma en host de restaurante suspendido', { metodo: 'POST', host: HOSTS.C, ruta: '/api/generar-firma', cuerpo: { referencia: 'TAQ-0-000000', montoEnCentavos: 100, modo: 'test' } }, { mutante: true });

  // ---- webhook de Wompi ----
  const wh = (secretoDe, clave, extra = {}) => async (L) => {
    const p = L.ctx[clave] || { referencia: 'TAQ-0-000000', total: 0 };
    return { metodo: 'POST', host: 'wompi.equivalencia.test', ruta: '/api/webhook-wompi', cuerpo: firmaWebhook({ referencia: p.referencia, centavos: p.total * 100, secreto: secretoDe, ...extra }) };
  };
  e('webhook', 'referencia desconocida (401)', { metodo: 'POST', host: 'wompi.equivalencia.test', ruta: '/api/webhook-wompi', cuerpo: firmaWebhook({ referencia: 'TAQ-1-abcdef', centavos: 100, secreto: 'x' }) }, { mutante: true });
  e('webhook', 'firma con el secreto de OTRO restaurante (401)', wh('eventos-B-equiv', 'pedidoA'), { mutante: true });
  e('webhook', 'firma mala (401)', wh('secreto-malo', 'pedidoA'), { mutante: true });
  e('webhook', 'monto distinto', wh('eventos-A-equiv', 'pedidoA', { centavos: 1 }), { mutante: true });
  e('webhook', 'ambiente de produccion con pedido de prueba', wh('eventos-A-equiv', 'pedidoA', { ambiente: 'prod' }), { mutante: true });
  e('webhook', 'cuerpo vacio', { metodo: 'POST', host: 'wompi.equivalencia.test', ruta: '/api/webhook-wompi', cuerpo: {} }, { mutante: true });
  e('webhook', 'GET (405)', { metodo: 'GET', host: 'wompi.equivalencia.test', ruta: '/api/webhook-wompi' }, { mutante: true });
  e('webhook', 'pago aprobado del pedido de A', wh('eventos-A-equiv', 'pedidoA'), { mutante: true });
  e('webhook', 'el mismo evento otra vez (repetido)', wh('eventos-A-equiv', 'pedidoA'), { mutante: true });
  e('webhook', 'rechazo tardio de un pedido ya aprobado', wh('eventos-A-equiv', 'pedidoA', { estado: 'DECLINED', txId: 'tx-equiv-2' }), { mutante: true });
  e('webhook', 'pago aprobado del pedido de B', wh('eventos-B-equiv', 'pedidoB'), { mutante: true });
  e('webhook', 'pago declinado del segundo pedido de A', wh('eventos-A-equiv', 'pedidoA2', { estado: 'DECLINED', txId: 'tx-equiv-3' }), { mutante: true });

  // ---- reembolso ----
  e('reembolso', 'sin sesion (401)', async (L) => ({ metodo: 'POST', host: HOSTS.A, ruta: '/api/reembolso', cuerpo: { referencia: (L.ctx.pedidoA2 || {}).referencia } }), { mutante: true });
  e('reembolso', 'token que no es una sesion (401)', async (L) => ({ metodo: 'POST', host: HOSTS.A, ruta: '/api/reembolso', cuerpo: { referencia: (L.ctx.pedidoA2 || {}).referencia }, headers: { authorization: 'Bearer abc.def.ghi' } }), { mutante: true });
  e('reembolso', 'GET (405)', { metodo: 'GET', host: HOSTS.A, ruta: '/api/reembolso' }, { mutante: true });
  e('reembolso', 'host desconocido', { metodo: 'POST', host: HOSTS.DESCONOCIDO, ruta: '/api/reembolso', cuerpo: { referencia: 'x' } }, { mutante: true });

  // ---- despues de los pedidos: lo que cambia con datos nuevos ----
  get('despues', 'estado tras los pedidos', HOSTS.A, '/api/estado');
  get('despues', 'disponibilidad tras los pedidos', HOSTS.A, '/api/disponibilidad');
  e('despues', 'alertas con Bearer tras los pagos', { host: 'cron.equivalencia.test', ruta: '/api/alertas', headers: { authorization: 'Bearer ' + SECRETO_CRON } }, { mutante: true });
  e('despues', 'keep-alive con Bearer tras los pagos', { host: 'cron.equivalencia.test', ruta: '/api/keep-alive', headers: { authorization: 'Bearer ' + SECRETO_CRON } }, { mutante: true });
  const suspender = (estado) => async (L) => { await L.rest('PATCH', `restaurantes?id=eq.${IDS.A}`, { estado }); };
  e('suspension', 'A suspendido: crear-pedido (403)', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 10000 }]), { mutante: true, preparar: suspender('suspendido') });
  e('suspension', 'A suspendido: generar-firma (403)', { metodo: 'POST', host: HOSTS.A, ruta: '/api/generar-firma', cuerpo: { referencia: 'TAQ-0-000000', montoEnCentavos: 100, modo: 'test' } }, { mutante: true });
  e('suspension', 'A suspendido: el menu sigue', { host: HOSTS.A, ruta: '/api/menu' });
  e('suspension', 'A suspendido: datos publicos (servicio suspendido)', { host: HOSTS.A, ruta: '/api/restaurante' });
  e('suspension', 'A suspendido: alertas no lo avisa', { host: 'cron.equivalencia.test', ruta: '/api/alertas', headers: { authorization: 'Bearer ' + SECRETO_CRON } }, { mutante: true });
  e('suspension', 'A reactivado: crear-pedido', pedido(HOSTS.A, [{ id: 'taco', cantidad: 1, precio: 10000 }]), { mutante: true, preparar: suspender('activo') });
  return G;
}

/* ================================================================================================ */
async function main() {
  const t0 = Date.now();
  pruebaCuenta();
  await pruebaRutas();
  const info = {};
  await pruebaEquivalencia(info);
  let grupo = '';
  for (const r of resultados) {
    console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  }
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
