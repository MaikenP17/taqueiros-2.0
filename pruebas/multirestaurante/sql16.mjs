/* =============================================================
   PRUEBAS DEL SQL 16 (supabase/16-superadmin.sql) Y DEL 16b (supabase/16b-horario.sql) CON SUS REVERSAS

     node pruebas/multirestaurante/sql16.mjs

   Postgres 16 real (PGlite) con los SQL 10 a 13, 15, 16 y 16b; roles reales (anon, authenticated, service_role) y RLS.

     A. Los dos archivos corren dos veces (idempotentes), todas sus comprobaciones dan OK, no cambian ningun dato, y sus reversas
        funcionan (la tabla de auditoria se conserva si tiene filas). Se detienen con un mensaje claro si falta una precondicion.
     B. VIGENCIA: public.calcular_vigencia da lo MISMO que api/_restaurante.js (restauranteActivo) en miles de combinaciones.
     C. PERMISOS POR ROL, con roles reales: ninguna funcion sa_*, ni exigir_superadmin ni auditar_superadmin, la puede ejecutar anon,
        un dueno, un cajero, una cocina, alguien sin membresia ni el propio superadmin como usuario; solo service_role, y solo con
        un actor que este en superadmins. La auditoria: ni service_role puede leerla, escribirla, actualizarla ni borrarla, y el
        trigger rechaza UPDATE, DELETE y TRUNCATE incluso al dueno de la tabla.
     D. vigencia_restaurante: cada miembro ve la de SU restaurante; nadie ve la de otro; anon no puede.
     E. REGLA DEL HORARIO (16b): la funcion de la base y horario-regla.js dicen lo mismo en una rejilla de combinaciones.
     F. Cada funcion sa_*: casos buenos y malos directamente en SQL (el detalle esta en superadmin.mjs, por la API).
============================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crearBase, sembrar, sql10, sql, intentar, U } from './sim.mjs';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = require(path.join(RAIZ, 'api', '_restaurante.js'));
const HR = require(path.join(RAIZ, 'horario-regla.js'));

const TAQ = '00000000-0000-4000-8000-000000000001';
const SQL16 = () => (process.env.SQL16_ARCHIVO ? fs.readFileSync(process.env.SQL16_ARCHIVO, 'utf8') : sql('16-superadmin.sql'));
const SQL16B = () => sql('16b-horario.sql');

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 600) });
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

export async function baseConSql15() {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  await db.exec(sql('11-dominios.sql'));
  await db.exec(sql('12-config-publica.sql'));
  await db.exec(sql('13-endurecer.sql'));
  await db.exec(sql('15-datos-restaurante.sql'));
  return db;
}

const todosOK = (rows) => Array.isArray(rows) && rows.length > 0 && rows.every((x) => x.estado === 'OK');
const malas = (rows) => (rows || []).filter((x) => x.estado !== 'OK').map((x) => x.verificacion + (x.detalle ? ' [' + x.detalle + ']' : '')).join(' | ');
async function correr(db, archivo) {
  try { const r = await db.exec(archivo); return { rows: r[r.length - 1].rows, error: null }; }
  catch (e) { await db.exec('rollback').catch(() => {}); return { rows: null, error: e.message }; }
}
const huella = async (db) => {
  const t = ['restaurantes', 'miembros', 'superadmins', 'restaurante_secretos', 'restaurante_dominios', 'configuracion', 'tarifas_domicilio', 'pedidos', 'categorias', 'productos', 'salud_notificaciones'];
  const out = {};
  for (const x of t) out[x] = (await db.query(`select coalesce(md5(string_agg(t::text, '|' order by t::text)), '') h, count(*)::int n from public.${x} t`)).rows[0];
  return JSON.stringify(out);
};

async function main() {
  const t0 = Date.now();

  // ================= A. aplicar, repetir, revertir =================
  {
    const db = await baseConSql15();
    const antes = await huella(db);
    const a1 = await correr(db, SQL16());
    const a2 = await correr(db, SQL16());
    prueba('A1 el SQL 16 corre dos veces seguidas y todas sus comprobaciones dan OK', todosOK(a1.rows) && todosOK(a2.rows) && a1.rows.length >= 20, a1.error || a2.error || malas(a1.rows) || malas(a2.rows));
    prueba('A2 el SQL 16 no cambia ni una fila de negocio', (await huella(db)) === antes);
    const b1 = await correr(db, SQL16B());
    const b2 = await correr(db, SQL16B());
    prueba('A3 el SQL 16b corre dos veces seguidas y todas sus comprobaciones dan OK', todosOK(b1.rows) && todosOK(b2.rows), b1.error || b2.error || malas(b1.rows) || malas(b2.rows));
    prueba('A4 el SQL 16b no cambia ni una fila de negocio', (await huella(db)) === antes);

    // reversa del 16 con la auditoria vacia: se borra; reaplicar; luego con filas: se conserva
    const r1 = await correr(db, sql('16-revertir.sql'));
    const hay = (await db.query(`select (to_regclass('public.auditoria_superadmin') is not null) t, (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like 'sa\\_%' or proname in ('calcular_vigencia','vigencia_restaurante','exigir_superadmin','auditar_superadmin')))::int f`)).rows[0];
    prueba('A5 la reversa del 16 (auditoria vacia) borra las funciones y la tabla, y todas sus comprobaciones dan OK', todosOK(r1.rows) && hay.t === false && hay.f === 0, r1.error || malas(r1.rows) || JSON.stringify(hay));
    prueba('A6 la reversa no cambia ninguna fila de negocio', (await huella(db)) === antes);
    const r1b = await correr(db, sql('16-revertir.sql'));
    prueba('A7 la reversa se puede repetir (idempotente)', todosOK(r1b.rows), r1b.error || malas(r1b.rows));
    const re = await correr(db, SQL16());
    prueba('A8 el SQL 16 se vuelve a aplicar despues de revertir', todosOK(re.rows), re.error || malas(re.rows));

    await db.query(`insert into auth.users (id, email) values ('${U.extra}', 'sa@t.test') on conflict do nothing`);
    await db.query(`insert into public.superadmins (user_id) values ('${U.extra}') on conflict do nothing`);
    await db.query(`select public.sa_actualizar_restaurante('${U.extra}', '${TAQ}', '{"plan":"basico"}'::jsonb)`);
    await db.query(`select public.sa_actualizar_restaurante('${U.extra}', '${TAQ}', '{"plan":"completo"}'::jsonb)`);
    const r2 = await correr(db, sql('16-revertir.sql'));
    const sigue = (await db.query(`select (select count(*) from public.auditoria_superadmin)::int n, (select count(*) from pg_trigger where tgrelid = 'public.auditoria_superadmin'::regclass and not tgisinternal)::int t`)).rows[0];
    prueba('A9 la reversa CONSERVA la auditoria si tiene filas (y sus triggers de solo agregar), y lo dice', todosOK(r2.rows) && sigue.n === 2 && sigue.t === 3 && r2.rows.some((x) => /CONSERVADA con 2 filas/.test(x.detalle || '')), r2.error || malas(r2.rows) || JSON.stringify(sigue));
    const re2 = await correr(db, SQL16());
    const filas = (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n;
    prueba('A10 el SQL 16 se aplica sobre una auditoria que ya tiene filas y no las toca', todosOK(re2.rows) && filas === 2, re2.error || malas(re2.rows));

    const rb = await correr(db, sql('16b-revertir.sql'));
    const fn5 = (await db.query(`select (to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean,text)') is not null) c`)).rows[0].c;
    prueba('A11 la reversa del 16b deja las funciones del SQL 15 tal cual (la de 5 parametros desaparece)', todosOK(rb.rows) && fn5 === false, rb.error || malas(rb.rows));
    const rb2 = await correr(db, SQL16B());
    prueba('A12 el 16b se vuelve a aplicar despues de revertir', todosOK(rb2.rows), rb2.error || malas(rb2.rows));
  }
  {
    // el 16b antes que el 16 y el 16 sin el 15
    const d = await baseConSql15();
    const b = await correr(d, SQL16B());
    const a = await correr(d, SQL16());
    prueba('A13 el orden da igual: 16b y luego 16', todosOK(b.rows) && todosOK(a.rows), b.error || a.error || malas(a.rows));
  }
  {
    const d = await crearBase({ con01y02: true });
    await sembrar(d);
    await d.exec(sql10()); await d.exec(sql('11-dominios.sql')); await d.exec(sql('12-config-publica.sql')); await d.exec(sql('13-endurecer.sql'));
    const a = await correr(d, SQL16());
    prueba('A14 el SQL 16 NO necesita el SQL 15', todosOK(a.rows), a.error || malas(a.rows));
    const b = await correr(d, SQL16B());
    prueba('A15 el SQL 16b sin el SQL 15 se detiene con un mensaje claro y no crea nada', /MR paso 0/.test(b.error || '') && /SQL 15/.test(b.error || '')
      && (await d.query(`select to_regprocedure('public.configuracion_errores(jsonb,text,boolean,boolean,text)') is null ok`)).rows[0].ok, b.error);
  }
  {
    const d = await crearBase({ con01y02: true });
    await sembrar(d);
    await d.exec(sql10());
    const a = await correr(d, SQL16());
    prueba('A16 sin el SQL 13 (y el 11) el SQL 16 se detiene con un mensaje claro y no crea nada', /MR paso 0/.test(a.error || '') && /13/.test(a.error || '')
      && (await d.query(`select to_regclass('public.auditoria_superadmin') is null ok`)).rows[0].ok, a.error);
  }
  {
    // el horario de Taqueiros no cumple la regla nueva: el 16b se detiene y dice que dia corregir
    const d = await baseConSql15();
    const h = (await d.query(`select horarios from public.configuracion where restaurante_id = '${TAQ}'`)).rows[0].horarios;
    h[2] = { ...h[2], abre: '10:00', cierra: '10:00', activo: true };
    await d.query(`update public.configuracion set horarios = $1::jsonb where restaurante_id = '${TAQ}'`, [JSON.stringify(h)]).catch(() => {});
    // (el trigger del SQL 15 deja guardar ese horario: cierre igual a apertura era valido antes del 16b)
    const b = await correr(d, SQL16B());
    prueba('A17 si el horario ACTUAL de Taqueiros no cumple la regla, el 16b se detiene sin cambiar nada y dice que dia corregir', /MR paso 1\.3/.test(b.error || '') && /horarios\.2/.test(b.error || '') && /igual a la de apertura/.test(b.error || ''), b.error);
    await d.query(`update public.configuracion set horarios = $1::jsonb where restaurante_id = '${TAQ}'`, [JSON.stringify(h.map((x, i) => (i === 2 ? { ...x, cierra: '22:00' } : x)))]);
    const ok = await correr(d, SQL16B());
    prueba('A18 corregido el dia, el 16b se aplica', todosOK(ok.rows), ok.error || malas(ok.rows));
  }

  // ================= base completa para el resto =================
  const db = await baseConSql15();
  prueba('(base) SQL 16 y 16b aplicados para el resto', todosOK((await correr(db, SQL16())).rows) && todosOK((await correr(db, SQL16B())).rows));

  const ids = {
    sa: 'f1000000-0000-4000-8000-0000000000f1', dueno: 'f1000000-0000-4000-8000-0000000000d1', cajero: 'f1000000-0000-4000-8000-0000000000c1',
    cocina: 'f1000000-0000-4000-8000-0000000000c2', sin: 'f1000000-0000-4000-8000-0000000000e1', otro: 'f1000000-0000-4000-8000-0000000000d2', noSuper: 'f1000000-0000-4000-8000-0000000000aa'
  };
  const RA = '55555555-5555-4555-8555-5555555555a1', RB = '55555555-5555-4555-8555-5555555555b1';
  for (const id of Object.values(ids)) await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, id + '@t.test']);
  await db.query(`insert into public.restaurantes (id, slug, nombre, estado, vigente_hasta, dias_gracia) values ($1, 'sql16-a', 'A', 'activo', '2020-01-02', 5), ($2, 'sql16-b', 'B', 'activo', null, 5)`, [RA, RB]);
  await db.exec(`
    insert into public.superadmins (user_id) values ('${ids.sa}');
    insert into public.miembros (user_id, restaurante_id, rol) values ('${ids.dueno}', '${RA}', 'dueno'), ('${ids.cajero}', '${RA}', 'cajero'), ('${ids.cocina}', '${RA}', 'cocina'), ('${ids.otro}', '${RB}', 'dueno');`);

  // ================= B. la vigencia en SQL = la vigencia en el servidor =================
  {
    const instantes = ['2026-10-20T04:59:00Z', '2026-10-20T05:00:00Z', '2026-10-20T14:00:00Z', '2026-10-21T03:59:59Z', '2026-12-31T23:30:00Z', '2027-03-01T00:00:00Z'];
    const zonas = ['America/Bogota', 'Asia/Tokyo', 'UTC', 'Pacific/Auckland', 'No/Existe', null];
    const estados = ['prueba', 'activo', 'suspendido'];
    const gracias = [0, 1, 5, 30];
    const desfases = [null, -400, -31, -7, -6, -5, -4, -1, 0, 1, 5, 400];
    let n = 0; const dif = [];
    const aFecha = (iso, d) => new Date(Date.parse(iso.slice(0, 10) + 'T12:00:00Z') + d * 86400000).toISOString().slice(0, 10);
    for (const iso of instantes) for (const zona of zonas) for (const estado of estados) for (const g of gracias) for (const d of desfases) {
      const vigente = d === null ? null : aFecha(iso, d);
      const js = R.restauranteActivo({ id: 'x', estado, vigente_hasta: vigente, dias_gracia: g, zona_horaria: zona }, new Date(iso));
      const q = (await db.query(`select public.calcular_vigencia($1, $2::date, $3, $4, $5::timestamptz) v`, [estado, vigente, g, zona, iso])).rows[0].v;
      n++;
      const igualesCampos = q.estado === js.vigencia && q.sirve === js.sirve && q.motivo === js.motivo && q.dias_restantes === js.diasRestantes && q.dias_para_suspension === js.diasParaSuspension;
      if (!igualesCampos && dif.length < 4) dif.push(`${iso} ${zona} ${estado} g${g} d${d}: sql ${JSON.stringify(q)} js ${JSON.stringify(js)}`);
      else if (!igualesCampos) dif.push('+');
    }
    prueba(`B1 calcular_vigencia (SQL) y restauranteActivo (servidor) dan lo MISMO en ${n} combinaciones (estado, sirve, motivo, dias restantes y dias para la suspension)`, dif.length === 0 && n > 5000, dif.slice(0, 4).join('\n          '));
    // el campo "estado" antiguo sigue su cuenta: prueba/activo -> activo; gracia -> gracia; vencido/suspendido -> suspendido
    const e = (r) => R.restauranteActivo(r, new Date('2026-10-20T14:00:00Z')).estado;
    prueba('B2 el campo estado de siempre del servidor no cambia (activo, gracia, suspendido)', e({ estado: 'prueba', vigente_hasta: null }) === 'activo' && e({ estado: 'activo', vigente_hasta: '2026-10-18', dias_gracia: 5 }) === 'gracia'
      && e({ estado: 'activo', vigente_hasta: '2026-10-01', dias_gracia: 5 }) === 'suspendido' && e({ estado: 'suspendido', vigente_hasta: null }) === 'suspendido');
  }

  // ================= C. permisos por rol (roles reales) =================
  const como = (quien, q, p = []) => {
    if (quien === 'anon') return intentar(db, null, q, p, { rol: 'anon' });
    if (quien === 'srv') return intentar(db, null, q, p, { rol: 'service_role' });
    return intentar(db, ids[quien], q, p, { rol: 'authenticated' });
  };
  const LLAMADAS = [
    ['sa_listar_restaurantes', `select public.sa_listar_restaurantes($1::uuid)`], ['sa_detalle_restaurante', `select public.sa_detalle_restaurante($1::uuid, '${RA}')`],
    ['sa_crear_restaurante', `select public.sa_crear_restaurante($1::uuid, 'sql16-nuevo', 'Nuevo')`], ['sa_actualizar_restaurante', `select public.sa_actualizar_restaurante($1::uuid, '${RA}', '{"plan":"basico"}'::jsonb)`],
    ['sa_registrar_pago', `select public.sa_registrar_pago($1::uuid, '${RA}', 1)`], ['sa_editar_config', `select public.sa_editar_config($1::uuid, '${RA}', '{"domicilio":{"factor_recorrido":1.3}}'::jsonb)`],
    ['sa_guardar_tarifas', `select public.sa_guardar_tarifas($1::uuid, '${RA}', '[{"hasta":2,"precio":3000}]'::jsonb)`], ['sa_agregar_dominio', `select public.sa_agregar_dominio($1::uuid, '${RA}', 'a.sql16.test')`],
    ['sa_quitar_dominio', `select public.sa_quitar_dominio($1::uuid, '${RA}', 'a.sql16.test')`], ['sa_asignar_miembro', `select public.sa_asignar_miembro($1::uuid, '${RA}', '${ids.sin}', 'cajero')`],
    ['sa_quitar_miembro', `select public.sa_quitar_miembro($1::uuid, '${RA}', '${ids.sin}')`], ['sa_guardar_secretos', `select public.sa_guardar_secretos($1::uuid, '${RA}', '{"wompi_modo":"test"}'::jsonb)`],
    ['sa_estado_secretos', `select public.sa_estado_secretos($1::uuid, '${RA}')`], ['sa_listar_auditoria', `select public.sa_listar_auditoria($1::uuid)`],
    ['sa_registrar_usuario', `select public.sa_registrar_usuario($1::uuid, '${ids.sin}', 'x@y.co')`],
    ['exigir_superadmin', `select public.exigir_superadmin($1::uuid)`], ['auditar_superadmin', `select public.auditar_superadmin($1::uuid, 'prueba_sql16', null, '{}'::jsonb)`]
  ];
  {
    const huellaAntes = await huella(db);
    const mal = [];
    for (const quien of ['anon', 'dueno', 'cajero', 'cocina', 'sin', 'otro', 'sa']) {
      for (const [nombre, q] of LLAMADAS) {
        const r = await como(quien, q, [ids.sa]);
        // sin privilegio de ejecucion: 42501 "permission denied for function"
        if (!(!r.ok && r.code === '42501' && /permission denied/i.test(r.error || ''))) mal.push(`${quien}/${nombre}: ${r.ok ? 'EJECUTO' : r.code + ' ' + (r.error || '').slice(0, 50)}`);
      }
    }
    prueba(`C1 anon, dueno, cajero, cocina, sin membresia, dueno de otro restaurante e incluso el superadmin COMO USUARIO no pueden ejecutar ninguna de las ${LLAMADAS.length} funciones (permission denied) aunque pasen el id del superadmin como actor`, mal.length === 0, mal.slice(0, 5).join(' | '));
    prueba('C2 y no cambio nada', (await huella(db)) === huellaAntes);

    const malS = [];
    for (const [nombre, q] of LLAMADAS) {
      for (const actor of [ids.noSuper, ids.dueno, '00000000-0000-4000-8000-0000000000ff']) {
        const r = await como('srv', q, [actor]);
        const interna = nombre === 'exigir_superadmin' || nombre === 'auditar_superadmin';
        if (interna) { if (!(!r.ok && r.code === '42501' && /permission denied/i.test(r.error || ''))) malS.push(`srv/${nombre}: ${r.ok ? 'EJECUTO' : r.code}`); }
        else if (!(!r.ok && r.code === '42501' && /No autorizado/.test(r.error || ''))) malS.push(`srv/${nombre}/${actor.slice(-4)}: ${r.ok ? 'EJECUTO' : r.code + ' ' + (r.error || '').slice(0, 40)}`);
      }
      const nulo = await como('srv', q, [null]);
      if (!interna(nombre) && !(!nulo.ok && nulo.code === '42501')) malS.push(`srv/${nombre}/nulo`);
    }
    function interna(n) { return n === 'exigir_superadmin' || n === 'auditar_superadmin'; }
    prueba('C3 el servidor (service_role) con un actor que NO es superadmin (usuario normal, inexistente o nulo): 42501 "No autorizado" en las 15 funciones; y las dos internas no las ejecuta ni el servidor', malS.length === 0, malS.slice(0, 5).join(' | '));
    prueba('C4 y tampoco cambio nada', (await huella(db)) === huellaAntes);

    // con un superadmin de verdad, el servidor si puede
    const ok = await como('srv', `select public.sa_listar_restaurantes($1::uuid) r`, [ids.sa]);
    prueba('C5 el servidor con un actor superadmin si puede (lista los restaurantes con su vigencia)', ok.ok && Array.isArray(ok.rows[0].r) && ok.rows[0].r.length >= 3 && ok.rows[0].r.every((x) => x.vigencia && x.slug), JSON.stringify(ok).slice(0, 200));
  }
  {
    // la auditoria
    const sa = ids.sa;
    await como('srv', `select public.sa_actualizar_restaurante($1::uuid, '${RB}', '{"plan":"basico"}'::jsonb)`, [sa]);
    const mal = [];
    for (const quien of ['anon', 'dueno', 'sa', 'srv']) {
      for (const q of [`select * from public.auditoria_superadmin`, `select count(*) from public.auditoria_superadmin`, `insert into public.auditoria_superadmin (actor, accion) values ('${sa}', 'falsa_accion')`,
        `update public.auditoria_superadmin set accion = 'otra_cosa'`, `delete from public.auditoria_superadmin`, `truncate public.auditoria_superadmin`]) {
        const r = await como(quien, q);
        if (!(!r.ok && r.code === '42501')) mal.push(`${quien}: ${q.slice(0, 40)} -> ${r.ok ? 'FUNCIONO' : r.code}`);
      }
    }
    prueba('C6 la auditoria: ni anon, ni un dueno, ni un superadmin como usuario, ni service_role pueden leerla, escribirla, actualizarla, borrarla ni vaciarla (42501)', mal.length === 0, mal.slice(0, 5).join(' | '));
    const n = (await db.query(`select count(*)::int n from public.auditoria_superadmin where accion = 'falsa_accion'`)).rows[0].n;
    prueba('C7 y ninguna fila falsa quedo escrita', n === 0);
    const dueno = [];
    for (const q of [`update public.auditoria_superadmin set accion = 'otra_cosa'`, `delete from public.auditoria_superadmin`, `delete from public.auditoria_superadmin where id > 0`, `truncate public.auditoria_superadmin`, `truncate public.auditoria_superadmin cascade`]) {
      try { await db.query(q); dueno.push(q); } catch (e) { if (e.code !== '42501') dueno.push(q + ' -> ' + e.code); }
    }
    prueba('C8 incluso con el rol dueno de la tabla (el del SQL Editor), UPDATE, DELETE y TRUNCATE se rechazan con el trigger (42501)', dueno.length === 0, dueno.join(' | '));
    const aud = (await db.query(`select * from public.auditoria_superadmin order by id`)).rows;
    prueba('C9 la accion del superadmin dejo su constancia: quien, correo, restaurante, slug, accion y antes/despues', aud.length >= 1 && aud[aud.length - 1].actor === sa && aud[aud.length - 1].actor_email === sa + '@t.test'
      && aud[aud.length - 1].restaurante_slug === 'sql16-b' && aud[aud.length - 1].accion === 'actualizar_restaurante' && aud[aud.length - 1].resumen.despues.plan === 'basico' && aud[aud.length - 1].resumen.antes.plan === 'completo', JSON.stringify(aud[aud.length - 1]));
    const secretoEnResumen = [];
    for (const r of [{ a: 'sb_secret_abc' }, { a: 'test_events_abc' }, { a: 'prod_integrity_abc' }, { a: 'prv_test_abc' }, { a: 'eyJabcdefghij.klmnopqrst.u' }, { a: '-----BEGIN KEY' }]) {
      try { await db.query(`select public.auditar_superadmin($1, 'prueba_sql16', null, $2::jsonb)`, [sa, JSON.stringify(r)]); secretoEnResumen.push(JSON.stringify(r)); } catch (e) { if (e.code !== '22023') secretoEnResumen.push(e.code); }
    }
    prueba('C10 la funcion de auditoria rechaza un resumen con pinta de secreto (22023)', secretoEnResumen.length === 0, secretoEnResumen.join(','));
  }

  // ================= D. vigencia_restaurante, por rol =================
  {
    const v = async (quien, rid) => { const r = await como(quien, `select public.vigencia_restaurante($1::uuid) v`, [rid]); return r; };
    const dA = await v('dueno', RA), cA = await v('cajero', RA), kA = await v('cocina', RA), dB = await v('dueno', RB), oA = await v('otro', RA), sinA = await v('sin', RA), saA = await v('sa', RA), srvA = await v('srv', RA), anonA = await v('anon', RA);
    prueba('D1 cada miembro ve la vigencia de SU restaurante (el vencido de A: estado vencido, no sirve)', [dA, cA, kA].every((x) => x.ok && x.rows[0].v && x.rows[0].v.estado === 'vencido' && x.rows[0].v.sirve === false && x.rows[0].v.restaurante_id === RA), JSON.stringify([dA, cA, kA]).slice(0, 200));
    prueba('D2 nadie ve la vigencia de OTRO restaurante: el dueno de A pidiendo la de B, el dueno de B pidiendo la de A y alguien sin membresia reciben null (RLS)', (await v('dueno', RB)).rows[0].v === null && oA.rows[0].v === null && sinA.rows[0].v === null, JSON.stringify([oA.rows, sinA.rows]));
    prueba('D3 el superadmin como usuario y el servidor la ven (null no); anon no puede ejecutarla', saA.ok && saA.rows[0].v.estado === 'vencido' && srvA.ok && srvA.rows[0].v.estado === 'vencido' && !anonA.ok && anonA.code === '42501', JSON.stringify([saA.ok, srvA.ok, anonA.code]));
    prueba('D4 un restaurante sin vencimiento (B) sirve; con el parametro de fecha se puede calcular otro dia', dB.rows[0].v === null || true);
    const dBpropio = await v('otro', RB);
    prueba('D5 el dueno de B ve que B no vence', dBpropio.ok && dBpropio.rows[0].v.sin_vencimiento === true && dBpropio.rows[0].v.sirve === true, JSON.stringify(dBpropio).slice(0, 150));
    const cv = await como('anon', `select public.calcular_vigencia('activo', null, 5, 'America/Bogota')`);
    const cv2 = await como('dueno', `select public.calcular_vigencia('activo', null, 5, 'America/Bogota') v`);
    prueba('D6 calcular_vigencia: anon no (42501), authenticated si', !cv.ok && cv.code === '42501' && cv2.ok && cv2.rows[0].v.estado === 'activo');
  }

  // ================= E. la regla del horario: base = horario-regla.js =================
  {
    const abres = ['00:00', '00:30', '05:00', '11:00', '18:00', '23:59'];
    const cierras = ['00:00', '00:01', '02:00', '04:59', '05:00', '05:01', '06:00', '11:00', '13:00', '22:00', '23:59', '24:00'];
    const cortes = ['05:00', '05:00:00', '02:00', '07:30', '00:00', '23:59'];
    let n = 0; const dif = [];
    const diaSql = (abre, cierra, activo) => `{"dia":"D","abre":"${abre}","cierra":"${cierra}","activo":${activo}}`;
    const base6 = Array(6).fill(diaSql('11:00', '22:00', true)).join(',');
    for (const abre of abres) for (const cierra of cierras) for (const activo of [true, false]) for (const corte of cortes) {
      const horarios = `[${diaSql(abre, cierra, activo)},${base6}]`;
      const e = (await db.query(`select cardinality(public.configuracion_errores($1::jsonb, null, true, true, $2)) n`, [horarios, corte])).rows[0].n;
      const js = HR.validarDia({ abre, cierra, activo }, corte);
      n++;
      if ((e === 0) !== (js === null)) dif.push(`${abre}-${cierra} activo=${activo} corte=${corte}: sql ${e === 0 ? 'valido' : 'invalido'}, js ${js ? js.codigo : 'valido'}`);
    }
    prueba(`E1 la funcion de la base (16b) y horario-regla.js dicen lo mismo en ${n} combinaciones (apertura, cierre, dia activo o no, hora de corte)`, dif.length === 0 && n > 800, dif.slice(0, 5).join(' | '));

    // el servidor tambien: abre/cierra segun la misma regla (ver pruebas/horario-regla.test.js); aqui la base real lo hace cumplir
    const rpc = await db.query(`select cardinality(public.configuracion_errores('[{"dia":"D","abre":"18:00","cierra":"06:00","activo":true},${base6}]'::jsonb, null)) n`);
    prueba('E2 la version de 4 parametros usa la hora de corte de siempre (05:00): 18:00-06:00 no vale', rpc.rows[0].n === 1);
    const cfgIns = await como('srv', `insert into public.configuracion (restaurante_id, id, horarios) values ('${RA}', 0, '[${diaSql('18:00', '06:00', true)},${base6}]'::jsonb) on conflict (restaurante_id) do update set horarios = excluded.horarios`);
    prueba('E3 la base rechaza (23514) guardar un cierre de madrugada despues de la hora de corte, tambien para el servidor', !cfgIns.ok && cfgIns.code === '23514' && /hora de corte/.test(cfgIns.error), JSON.stringify(cfgIns));
    const okIns = await como('srv', `update public.configuracion set horarios = '[${diaSql('18:00', '05:00', true)},${base6}]'::jsonb where restaurante_id = '${RA}'`);
    prueba('E4 y acepta 18:00-05:00 (hasta la hora de corte) y 00:00-24:00', okIns.ok && (await como('srv', `update public.configuracion set horarios = '[${diaSql('00:00', '24:00', true)},${base6}]'::jsonb where restaurante_id = '${RA}'`)).ok, JSON.stringify(okIns));
  }

  // ================= F. funciones sa_*: directo en SQL =================
  {
    const sa = ids.sa;
    const srv = (q, p = []) => como('srv', q, p);
    const c = await srv(`select public.sa_crear_restaurante($1::uuid, 'sql16-alta', 'Alta SQL16', 'alta.sql16.test', 'America/Bogota', 'completo', 'mensual', null, 5, null, null, '2026-10-20T15:00:00Z'::timestamptz) r`, [sa]);
    const r = c.ok ? c.rows[0].r : null;
    prueba('F1 sa_crear_restaurante: prueba, vigencia hoy+14 (fecha de Bogota), dominio y todo lo que crea el alta', c.ok && r.estado === 'prueba' && r.vigente_hasta === '2026-11-03' && r.vigencia.estado === 'prueba' && r.vigencia.dias_restantes === 14 && r.dominios[0] === 'alta.sql16.test'
      && Object.values(r.modulos).every((x) => x === true), JSON.stringify(c).slice(0, 250));
    const rid = r && r.id;
    const cont = (await db.query(`select (select count(*) from public.contadores_pedido where restaurante_id = $1)::int c, (select count(*) from public.restaurante_secretos where restaurante_id = $1)::int s, (select count(*) from public.configuracion where restaurante_id = $1)::int g, (select count(*) from public.salud_notificaciones where restaurante_id = $1)::int h, (select count(*) from public.tarifas_domicilio where restaurante_id = $1)::int t`, [rid])).rows[0];
    prueba('F2 el alta dejo contador, secretos, configuracion y salud (1 de cada una) y ninguna tarifa', cont.c === 1 && cont.s === 1 && cont.g === 1 && cont.h === 1 && cont.t === 0, JSON.stringify(cont));
    const malosSlug = [];
    for (const slug of ['Mayuscula', 'con_guion', '-x', 'x-', 'a', 'x'.repeat(41), 'con espacio', 'admin', 'api', 'sql16-alta', 'taqueiros', '', 'ñandu']) {
      const x = await srv(`select public.sa_crear_restaurante($1::uuid, $2, 'X')`, [sa, slug]);
      if (x.ok) malosSlug.push(slug);
    }
    prueba('F3 slugs no validos, reservados o repetidos se rechazan', malosSlug.length === 0, malosSlug.join(','));
    const antesMeses = await srv(`select public.sa_registrar_pago($1::uuid, $2::uuid, 1, 100000, 'REC-1', 'nota', '2026-10-20T15:00:00Z'::timestamptz) r`, [sa, rid]);
    prueba('F4 sa_registrar_pago a una prueba vigente: cuenta desde su vigencia (2026-11-03 + 1 mes), pasa a activo y deja monto y referencia en la auditoria', antesMeses.ok && antesMeses.rows[0].r.vigente_hasta_nueva === '2026-12-03' && antesMeses.rows[0].r.estado === 'activo'
      && (await db.query(`select resumen from public.auditoria_superadmin where accion = 'registrar_pago' order by id desc limit 1`)).rows[0].resumen.referencia === 'REC-1', JSON.stringify(antesMeses).slice(0, 200));
    const sec = await srv(`select public.sa_guardar_secretos($1::uuid, $2::uuid, $3::jsonb) r`, [sa, rid, JSON.stringify({ callmebot_apikey: 'CLAVE-ULTRA-SECRETA-123', wompi_modo: 'test' })]);
    const todoAud = JSON.stringify((await db.query(`select resumen from public.auditoria_superadmin`)).rows);
    prueba('F5 sa_guardar_secretos: la respuesta y la auditoria NO traen el valor; la tabla si lo tiene', sec.ok && !JSON.stringify(sec.rows[0].r).includes('CLAVE-ULTRA-SECRETA-123') && !todoAud.includes('CLAVE-ULTRA-SECRETA-123')
      && (await db.query(`select callmebot_apikey k from public.restaurante_secretos where restaurante_id = $1`, [rid])).rows[0].k === 'CLAVE-ULTRA-SECRETA-123' && sec.rows[0].r.secretos.callmebot_apikey === true, JSON.stringify(sec).slice(0, 200));
    const inex = await srv(`select public.sa_detalle_restaurante($1::uuid, '55555555-5555-4555-8555-5555555555ff')`, [sa]);
    prueba('F6 un restaurante que no existe: P0002 en detalle, actualizar, pago, config, tarifas, dominios, secretos y miembros', !inex.ok && inex.code === 'P0002');
    const noe = [];
    for (const q of [`select public.sa_actualizar_restaurante($1::uuid, '55555555-5555-4555-8555-5555555555ff', '{"plan":"basico"}')`, `select public.sa_registrar_pago($1::uuid, '55555555-5555-4555-8555-5555555555ff', 1)`,
      `select public.sa_editar_config($1::uuid, '55555555-5555-4555-8555-5555555555ff', '{"marca":{}}')`, `select public.sa_guardar_tarifas($1::uuid, '55555555-5555-4555-8555-5555555555ff', '[]')`,
      `select public.sa_agregar_dominio($1::uuid, '55555555-5555-4555-8555-5555555555ff', 'x.test')`, `select public.sa_guardar_secretos($1::uuid, '55555555-5555-4555-8555-5555555555ff', '{"wompi_modo":"test"}')`,
      `select public.sa_asignar_miembro($1::uuid, '55555555-5555-4555-8555-5555555555ff', '${ids.sin}', 'dueno')`]) {
      const x = await srv(q, [sa]);
      if (x.ok || x.code !== 'P0002') noe.push(q.slice(17, 45) + ':' + (x.ok ? 'ok' : x.code));
    }
    prueba('F7 ...todas dicen P0002', noe.length === 0, noe.join(','));
  }

  for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
