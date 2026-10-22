/* Mini Supabase FALSO (PostgREST + Auth + Storage) sobre PGlite, SOLO para probar los scripts de
   supabase/*.mjs sin la base real. No emula Realtime. Ver contra-falso.mjs. */
// Cada peticion corre en una transaccion con "set local role" + request.jwt.claims, igual que PostgREST.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { crearBase, sembrar, sql10, REPO } from './sim.mjs';

/* validarConfig: false apaga SOLO el trigger de validacion de restaurantes.config del SQL 13 (el resto del 13 queda
   activo). Lo usan las baterias que prueban lo que hacen el servidor y el navegador con una config hostil o de forma
   vieja (defensa en profundidad): la base ya no deja guardar esos datos, pero esas capas tienen que seguir
   defendiendose por si algun dia llegan (por ejemplo, un cambio hecho con el trigger apagado). VALIDAR_CONFIG=1 lo
   fuerza a prender en todas, para ver cuales dependen de ello. */
export async function levantar({ puerto = 54329, migrar = true, validarConfig = true } = {}) {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  if (migrar) {
    await db.exec(sql10());
    // SQL 11 (restaurante_dominios). SQL11_ARCHIVO permite probar otra version; SQL11_NO=1 lo omite
    // (para probar la transicion en la que la tabla todavia no existe).
    const f11 = process.env.SQL11_ARCHIVO || path.join(REPO, 'supabase', '11-dominios.sql');
    if (!process.env.SQL11_NO && fs.existsSync(f11)) await db.exec(fs.readFileSync(f11, 'utf8'));
    // SQL 12 (config publica de Taqueiros y enlace de seguimiento por token). SQL12_NO=1 lo omite (para probar el codigo
    // nuevo ANTES de correr el SQL 12: Taqueiros debe verse igual con los valores de respaldo).
    const f12 = path.join(REPO, 'supabase', '12-config-publica.sql');
    if (!process.env.SQL12_NO && fs.existsSync(f12)) await db.exec(fs.readFileSync(f12, 'utf8'));
    // SQL 13 (sin valor por defecto de restaurante_id, config validada, minimo privilegio). SQL13_NO=1 lo omite
    // (para probar el codigo antes de correrlo). Se aplica solo si el 12 esta (el 13 se corre despues del 12).
    const f13 = process.env.SQL13_ARCHIVO || path.join(REPO, 'supabase', '13-endurecer.sql');
    if (!process.env.SQL13_NO && !process.env.SQL12_NO && fs.existsSync(f13)) await db.exec(fs.readFileSync(f13, 'utf8'));
    // SQL 14 (retira la regla de la raiz del bucket). Solo con SQL14=1: se corre despues de mover las fotos.
    const f14 = path.join(REPO, 'supabase', '14-retirar-regla-bucket.sql');
    if (process.env.SQL14 && fs.existsSync(f14)) await db.exec(fs.readFileSync(f14, 'utf8'));
    // SQL 15 (horario y mensaje de cerrado validados; guardar_datos_restaurante). SQL15_NO=1 lo omite (para probar el codigo antes de correrlo).
    const f15 = process.env.SQL15_ARCHIVO || path.join(REPO, 'supabase', '15-datos-restaurante.sql');
    if (!process.env.SQL15_NO && !process.env.SQL13_NO && !process.env.SQL12_NO && fs.existsSync(f15)) await db.exec(fs.readFileSync(f15, 'utf8'));
    // SQL 16 (superadmin, vigencia y auditoria) y SQL 16b (horario con 24:00 y medianoche). SQL16_NO=1 / SQL16B_NO=1 los omiten (para probar el codigo antes de correrlos).
    const f16 = path.join(REPO, 'supabase', '16-superadmin.sql');
    if (!process.env.SQL16_NO && !process.env.SQL13_NO && !process.env.SQL12_NO && fs.existsSync(f16)) await db.exec(fs.readFileSync(f16, 'utf8'));
    const f16b = path.join(REPO, 'supabase', '16b-horario.sql');
    if (!process.env.SQL16B_NO && !process.env.SQL15_NO && !process.env.SQL13_NO && !process.env.SQL12_NO && fs.existsSync(f16b)) await db.exec(fs.readFileSync(f16b, 'utf8'));
    if (validarConfig === false && !process.env.VALIDAR_CONFIG && !process.env.SQL13_NO && !process.env.SQL12_NO) {
      await db.exec('alter table public.restaurantes disable trigger restaurantes_validar_config');
    }
  }

  const archivos = new Map();    // 'productos/<ruta>' -> Buffer (contenido real de lo subido)
  const falso = { archivos, cortar: null, antes: null, ignorarBorrados: false, peticiones: [] };   // cortar(req, url) -> true: corta la conexion (simula un fallo)
  const passwords = new Map();   // email -> password
  const tokens = new Map();      // token -> uid
  let cola = Promise.resolve();
  const serie = (fn) => { const p = cola.then(fn, fn); cola = p.catch(() => {}); return p; };

  /* Token de sesion con la FORMA de uno real: tres partes en base64url (encabezado.carga.firma), ~700
     caracteres, con mayusculas, minusculas, digitos, '-' y '_'. Antes los tokens del falso eran
     'tok_<hex>' (sin una sola 's'), y un servidor que rechazaba tokens por su forma pasaba todas las
     pruebas locales y fallaba con la base real. */
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tokenDeSesion = (uid, email) => {
    const ahora = Math.floor(Date.now() / 1000);
    return b64({ alg: 'ES256', typ: 'JWT', kid: crypto.randomUUID() }) + '.' + b64({
      iss: 'http://localhost/auth/v1', sub: uid, aud: 'authenticated', exp: ahora + 3600, iat: ahora, email,
      phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { email_verified: true },
      role: 'authenticated', aal: 'aal1', amr: [{ method: 'password', timestamp: ahora }], session_id: crypto.randomUUID(), is_anonymous: false
    }) + '.' + crypto.randomBytes(64).toString('base64url');
  };

  const esLlaveNueva = (v) => /^sb_(secret|publishable)_\S+$/.test(v);

  /* Lo que el gateway de Supabase real rechaza ANTES de llegar a Auth/PostgREST (el proyecto de Taqueiros
     usa las llaves nuevas y tiene las JWT legacy DESACTIVADAS):
       * sin 'apikey' valida (sb_secret_ o sb_publishable_) -> 401: el token del usuario solo NO basta, y un JWT
         (de usuario o legacy) tampoco sirve como apikey;
       * una llave sb_secret_ como Bearer -> 401 (no es un JWT; solo va en 'apikey');
       * un Bearer que no es una sesion conocida ni la llave publishable -> 401. */
  const rechazoDelGateway = (req, url) => {
    if (url.pathname.startsWith('/storage/v1/object/public/')) return null;   // los objetos publicos no piden llave
    const key = String(req.headers.apikey || '').trim();
    if (!esLlaveNueva(key)) return { message: key ? 'Invalid API key' : 'No API key found in request', hint: 'No `apikey` request header or url param was found.' };
    const cabecera = String(req.headers.authorization || '').trim();
    if (!cabecera) return null;
    if (!/^Bearer\s+\S+$/i.test(cabecera)) return { code: 401, error: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'Invalid JWT' };   // sin el esquema Bearer
    const bearer = cabecera.replace(/^Bearer\s+/i, '');
    if (tokens.has(bearer) || /^sb_publishable_/.test(bearer)) return null;
    return { code: 401, error: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'Invalid JWT' };
  };

  const rolDe = (req) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (auth && tokens.has(auth)) return { rol: 'authenticated', uid: tokens.get(auth) };
    const key = req.headers.apikey || '';
    if (key.startsWith('sb_secret_')) return { rol: 'service_role', uid: null };
    return { rol: 'anon', uid: null };
  };

  async function enRol(ctx, fn) {
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${ctx.rol}`);
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(ctx.uid ? { sub: ctx.uid, role: ctx.rol } : { role: ctx.rol })]);
      return fn(tx);
    });
  }

  const estadoDeError = (e, ctx) => {
    const c = e.code || '';
    if (c === '42501') return ctx.rol === 'anon' ? 401 : 403;
    if (c === '23505' || c === '23503') return 409;
    if (c === '42883' || c === '42P01') return 404;
    return 400;
  };

  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

  function filtros(url, params) {
    const where = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      const m = v.match(/^(eq|neq|like|in|is|lt|lte|gt|gte)\.(.*)$/);
      if (!m) throw Object.assign(new Error('filtro no soportado: ' + k + '=' + v), { code: 'PGRST100' });
      const [, op, val] = m;
      if (op === 'eq') { params.push(val); where.push(`${q(k)}::text = $${params.length}`); }
      else if (op === 'neq') { params.push(val); where.push(`${q(k)}::text <> $${params.length}`); }
      else if (op === 'like') { params.push(val.replace(/\*/g, '%')); where.push(`${q(k)}::text like $${params.length}`); }
      else if (op === 'in') { params.push(val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''))); where.push(`${q(k)}::text = any($${params.length})`); }
      else if (op === 'is') { where.push(`${q(k)} is ${val === 'null' ? 'null' : val}`); }
      else {
        // lt / lte / gt / gte: se comparan con el tipo de la columna (timestamptz, numeric...), no como texto
        params.push(val);
        where.push(`${q(k)} ${{ lt: '<', lte: '<=', gt: '>', gte: '>=' }[op]} $${params.length}`);
      }
    }
    return where.length ? ' where ' + where.join(' and ') : '';
  }

  async function leerCuerpo(req) {
    const trozos = [];
    for await (const t of req) trozos.push(t);
    return Buffer.concat(trozos);
  }
  /* Como PostgREST: con "Accept: application/vnd.pgrst.object+json" (supabase-js .single()) la respuesta es UN objeto,
     y si no son exactamente una fila, error 406 (PGRST116). */
  const comoObjeto = (req, res, status, rows) => {
    if (!(req.headers.accept || '').includes('vnd.pgrst.object')) return enviar(res, status, rows);
    if (rows.length === 1) return enviar(res, status, rows[0]);
    return enviar(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
  };
  const enviar = (res, status, cuerpo, tipo = 'application/json') => {
    res.writeHead(status, { 'Content-Type': tipo });
    res.end(typeof cuerpo === 'string' || Buffer.isBuffer(cuerpo) ? cuerpo : JSON.stringify(cuerpo));
  };

  const servidor = http.createServer((req, res) => {
    serie(async () => {
      const url = new URL(req.url, 'http://x');
      const ctx = rolDe(req);
      const bytes = await leerCuerpo(req);
      const crudo = bytes.toString('utf8');
      falso.peticiones.push(req.method + ' ' + url.pathname);
      if (falso.antes) await falso.antes(req, url);   // gancho de las pruebas: cambia el estado justo antes de atender la peticion
      if (falso.cortar && falso.cortar(req, url)) { req.socket.destroy(); return; }
      const rechazo = rechazoDelGateway(req, url);
      if (rechazo) return enviar(res, 401, rechazo);
      let cuerpo;
      try { cuerpo = crudo && req.headers['content-type']?.includes('json') ? JSON.parse(crudo) : undefined; } catch { cuerpo = undefined; }
      const prefer = req.headers.prefer || '';
      const conRep = prefer.includes('return=representation');

      try {
        // ---------------- AUTH ----------------
        if (url.pathname === '/auth/v1/admin/users' && req.method === 'POST') {
          if (ctx.rol !== 'service_role') return enviar(res, 403, { message: 'not admin' });
          // como Auth real: un correo repetido es 422 email_exists (antes el falso creaba duplicados)
          if ((await db.query(`select 1 from auth.users where lower(email) = lower($1)`, [cuerpo.email])).rows.length) return enviar(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
          const r = await db.query(`insert into auth.users (email) values ($1) returning id, email`, [cuerpo.email]);
          passwords.set(cuerpo.email, cuerpo.password);
          return enviar(res, 200, r.rows[0]);
        }
        if (url.pathname === '/auth/v1/admin/users' && req.method === 'GET') {
          const r = await db.query(`select id, email from auth.users`);
          return enviar(res, 200, { users: r.rows });
        }
        let m = url.pathname.match(/^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
        if (m && req.method === 'DELETE') {
          await db.query(`delete from auth.users where id = $1`, [m[1]]);
          return enviar(res, 200, {});
        }
        if (url.pathname === '/auth/v1/user' && req.method === 'GET') {
          const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          if (!tokens.has(t)) return enviar(res, 401, { message: 'invalid JWT' });
          const r = await db.query(`select id, email from auth.users where id = $1`, [tokens.get(t)]);
          return enviar(res, 200, r.rows[0]);
        }
        if (url.pathname === '/auth/v1/token') {
          const r = await db.query(`select id from auth.users where email = $1`, [cuerpo.email]);
          if (!r.rows.length || passwords.get(cuerpo.email) !== cuerpo.password) return enviar(res, 400, { error: 'invalid_grant' });
          const t = tokenDeSesion(r.rows[0].id, cuerpo.email);
          tokens.set(t, r.rows[0].id);
          return enviar(res, 200, { access_token: t, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, user: { id: r.rows[0].id, email: cuerpo.email } });
        }

        // ---------------- REST ----------------
        m = url.pathname.match(/^\/rest\/v1\/(.+)$/);
        if (m) {
          const destino = decodeURIComponent(m[1]);
          if (destino.startsWith('rpc/')) {
            const fn = destino.slice(4);
            const args = cuerpo || {};
            const out = await enRol(ctx, async (tx) => {
              const meta = (await tx.query(`select p.proretset from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1 limit 1`, [fn])).rows[0];
              if (!meta) throw Object.assign(new Error('function not found'), { code: '42883' });
              const nombres = Object.keys(args);
              const params = nombres.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
              const lista = nombres.map((k, i) => `${q(k)} => $${i + 1}`).join(', ');
              if (meta.proretset) return (await tx.query(`select * from public.${q(fn)}(${lista})`, params)).rows;
              const r = (await tx.query(`select public.${q(fn)}(${lista}) as r`, params)).rows[0].r;
              return r;
            });
            return enviar(res, 200, out === undefined ? null : out);
          }
          const tabla = destino;
          const params = [];
          if (req.method === 'GET') {
            const cols = (url.searchParams.get('select') || '*') === '*' ? '*' : url.searchParams.get('select').split(',').map(q).join(',');
            let sqlTxt = `select ${cols} from public.${q(tabla)}` + filtros(url, params);
            const ord = url.searchParams.get('order');
            if (ord) { const [c, d] = ord.split('.'); sqlTxt += ` order by ${q(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }
            if (url.searchParams.get('limit')) sqlTxt += ` limit ${Number(url.searchParams.get('limit'))}`;
            const rows = await enRol(ctx, async (tx) => (await tx.query(sqlTxt, params)).rows);
            return comoObjeto(req, res, 200, rows);
          }
          if (req.method === 'POST') {
            const lote = Array.isArray(cuerpo) ? cuerpo : [cuerpo];
            const cols = [...new Set(lote.flatMap((o) => Object.keys(o)))];
            const sqlTxt = `insert into public.${q(tabla)} (${cols.map(q).join(',')}) select ${cols.map(q).join(',')} from json_populate_recordset(null::public.${q(tabla)}, $1::json)` + (conRep ? ' returning *' : '');
            const rows = await enRol(ctx, async (tx) => (await tx.query(sqlTxt, [JSON.stringify(lote)])).rows);
            return conRep ? comoObjeto(req, res, 201, rows) : (res.writeHead(201), res.end());
          }
          if (req.method === 'PATCH') {
            const cols = Object.keys(cuerpo);
            const sets = cols.map((c) => `${q(c)} = (select ${q(c)} from json_populate_record(null::public.${q(tabla)}, $1::json))`).join(', ');
            params.push(JSON.stringify(cuerpo));
            const sqlTxt = `update public.${q(tabla)} set ${sets}` + filtros(url, params) + (conRep ? ' returning *' : '');
            const rows = await enRol(ctx, async (tx) => (await tx.query(sqlTxt, params)).rows);
            return conRep ? comoObjeto(req, res, 200, rows) : (res.writeHead(204), res.end());
          }
          if (req.method === 'DELETE') {
            const sqlTxt = `delete from public.${q(tabla)}` + filtros(url, params) + (conRep ? ' returning *' : '');
            const rows = await enRol(ctx, async (tx) => (await tx.query(sqlTxt, params)).rows);
            return conRep ? enviar(res, 200, rows) : (res.writeHead(204), res.end());
          }
        }

        // ---------------- STORAGE ----------------
        m = url.pathname.match(/^\/storage\/v1\/object\/list\/productos$/);
        if (m && req.method === 'POST') {
          const pref = cuerpo.prefix ? cuerpo.prefix + '/' : '';
          const rows = await enRol(ctx, async (tx) => (await tx.query(`select name from storage.objects where bucket_id = 'productos' and name like $1`, [pref + '%'])).rows);
          return enviar(res, 200, rows.map((r) => ({ name: r.name.slice(pref.length) })).filter((r) => !r.name.includes('/'))
            .map((r) => ({ name: r.name, metadata: { size: (archivos.get('productos/' + pref + r.name) || Buffer.from('png')).length } })));
        }
        if (url.pathname === '/storage/v1/object/productos' && req.method === 'DELETE') {
          const nombres = cuerpo.prefixes || [];
          if (falso.ignorarBorrados) return enviar(res, 200, []);   // gancho de las pruebas: responde OK pero no borra
          const borrados = await enRol(ctx, async (tx) => (await tx.query(`delete from storage.objects where bucket_id = 'productos' and name = any($1) returning name`, [nombres])).rows);
          for (const b of borrados) archivos.delete('productos/' + b.name);
          return enviar(res, 200, borrados.map((b) => ({ name: b.name })));
        }
        m = url.pathname.match(/^\/storage\/v1\/object\/public\/productos\/(.+)$/);
        if (m && req.method === 'GET') {
          const r = await db.query(`select 1 from storage.objects where bucket_id = 'productos' and name = $1`, [decodeURIComponent(m[1])]);
          if (!r.rows.length) return enviar(res, 404, { error: 'not_found' });
          return enviar(res, 200, archivos.get('productos/' + decodeURIComponent(m[1])) || 'png', 'image/png');
        }
        // copiar un objeto (la usa migrar-fotos-raiz.mjs): solo el servidor; no pisa uno que ya existe
        if (url.pathname === '/storage/v1/object/copy' && req.method === 'POST') {
          if (ctx.rol !== 'service_role') return enviar(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'solo el servidor' });
          const { bucketId, sourceKey, destinationKey } = cuerpo || {};
          if (bucketId !== 'productos') return enviar(res, 404, { statusCode: '404', error: 'Bucket not found' });
          const o = await db.query(`select name from storage.objects where bucket_id = 'productos' and name = any($1)`, [[sourceKey, destinationKey]]);
          const nombres = o.rows.map((x) => x.name);
          if (!nombres.includes(sourceKey)) return enviar(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
          if (nombres.includes(destinationKey)) return enviar(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
          await db.query(`insert into storage.objects (bucket_id, name) values ('productos', $1)`, [destinationKey]);
          archivos.set('productos/' + destinationKey, archivos.get('productos/' + sourceKey) || Buffer.from('png'));
          return enviar(res, 200, { Key: 'productos/' + destinationKey });
        }
        m = url.pathname.match(/^\/storage\/v1\/object\/productos\/(.+)$/);
        if (m) {
          const ruta = decodeURIComponent(m[1]);
          if (req.method === 'POST') {
            try {
              await enRol(ctx, async (tx) => tx.query(`insert into storage.objects (bucket_id, name, owner) values ('productos', $1, $2)`, [ruta, ctx.uid]));
              archivos.set('productos/' + ruta, bytes);
              return enviar(res, 200, { Key: 'productos/' + ruta });
            } catch (e) { return enviar(res, 400, { statusCode: '403', error: 'Unauthorized', message: e.message }); }
          }
          if (req.method === 'DELETE') {
            const rows = await enRol(ctx, async (tx) => (await tx.query(`delete from storage.objects where bucket_id = 'productos' and name = $1 returning name`, [ruta])).rows);
            if (rows.length) archivos.delete('productos/' + ruta);
            return rows.length ? enviar(res, 200, { message: 'Successfully deleted' }) : enviar(res, 404, { error: 'not_found' });
          }
          if (req.method === 'GET') {
            const rows = await enRol(ctx, async (tx) => (await tx.query(`select name from storage.objects where bucket_id = 'productos' and name = $1`, [ruta])).rows);
            return rows.length ? enviar(res, 200, archivos.get('productos/' + ruta) || 'png', 'image/png') : enviar(res, 400, { error: 'not_found' });
          }
        }
        return enviar(res, 404, { message: 'ruta no implementada en el falso: ' + req.method + ' ' + url.pathname });
      } catch (e) {
        return enviar(res, estadoDeError(e, ctx), { code: e.code, message: e.message });
      }
    }).catch((e) => { try { res.writeHead(500); res.end(String(e)); } catch {} });
  });

  await new Promise((r) => servidor.listen(puerto, r));
  return Object.assign(falso, { db, servidor, cerrar: () => new Promise((r) => { servidor.closeAllConnections?.(); servidor.close(r); }), url: `http://localhost:${puerto}` });
}

if (process.argv[1] && process.argv[1].endsWith('fake-supabase.mjs')) {
  const s = await levantar();
  console.log('falso listo en', s.url);
}
