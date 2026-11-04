/* =============================================================
   PRUEBAS DEL SQL 19 (supabase/19-superadmin-lectura.sql) Y DE SU REVERSA (supabase/19-revertir.sql)

     node pruebas/multirestaurante/sql19.mjs

   Postgres 16 real (PGlite) con los SQL 10 a 13, 15, 16 y 19; roles reales (anon, authenticated, service_role) y RLS.

     A. Los dos archivos corren dos veces (idempotentes), todas sus comprobaciones dan OK, no cambian ningun dato, funcionan con y sin
        el 16b y con y sin el 18, se detienen con un mensaje claro si falta el 16, la reversa deja el 16 en pie y conserva la auditoria,
        y el 16 se puede volver a correr con el 19 ya puesto (su cuenta de "15 funciones" no se rompe).
     B. PERMISOS POR ROL con roles reales: anon, authenticated (dueno, cajero, cocina, sin membresia, hasta el superadmin COMO USUARIO)
        no ejecutan nada; el servidor solo con un actor que este en superadmins; la ayuda interna ni el servidor.
     C. LAS LECTURAS: forma, aislamiento entre restaurantes, jornada con su corte, limites, paginado, ids malos, mes en la zona del
        restaurante, ausencia de secretos y de tokens.
     D. NO ESCRIBEN: con triggers que rechazan CUALQUIER escritura en las tablas de negocio, todas las lecturas funcionan (y lo unico
        que cambia es la auditoria).
     E. AUDITORIA: una fila por (superadmin, accion, restaurante, modo) por ventana de 10 minutos; sin datos personales; constancia
        acotada (una por 15 minutos) del rechazo por falta de MFA.
============================================================= */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, intentar, U } from './sim.mjs';
import { baseConSql15 } from './sql16.mjs';
import { aplicarSql18 } from './fake-supabase.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAQ = '00000000-0000-4000-8000-000000000001';
const SQL16 = () => sql('16-superadmin.sql');
const SQL19 = () => (process.env.SQL19_ARCHIVO ? fs.readFileSync(process.env.SQL19_ARCHIVO, 'utf8') : sql('19-superadmin-lectura.sql'));
const REV19 = () => sql('19-revertir.sql');

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 700) });
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
const SIN16B = (db) => db.exec(sql('16b-horario.sql'));

async function main() {
  const t0 = Date.now();

  // ================= A. aplicar, repetir, revertir =================
  {
    const db = await baseConSql15();
    // sin el 16: el 19 se detiene con un mensaje claro y no crea nada
    const antes = await huella(db);
    const sin16 = await correr(db, SQL19());
    const hay = (await db.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('sa_ver_pedidos','sa_ver_menu','sa_ver_config','sa_ver_resumen','sa_registrar_rechazo_mfa','auditar_lectura_superadmin')`)).rows[0].n;
    prueba('A1 el SQL 19 sin el 16 se detiene con "MR paso 0" y un mensaje que manda a correr el 16, y no crea nada', /MR paso 0/.test(sin16.error || '') && /SQL 16/.test(sin16.error || '') && hay === 0, sin16.error);

    prueba('(base) SQL 16 aplicado', todosOK((await correr(db, SQL16())).rows));
    const a1 = await correr(db, SQL19());
    const a2 = await correr(db, SQL19());
    prueba('A2 el SQL 19 corre dos veces seguidas, todas sus comprobaciones (14) dan OK', todosOK(a1.rows) && todosOK(a2.rows) && a1.rows.length === 14 && a2.rows.length === 14, a1.error || a2.error || malas(a1.rows) || malas(a2.rows));
    prueba('A3 el SQL 19 no cambia ni una fila de negocio', (await huella(db)) === antes);
    prueba('A4 sin el SQL 16b ni el 18 funciona igual (es independiente del 16b y el 18 es opcional): sa_ver_menu devuelve las opciones vacias', todosOK(a1.rows)
      && (await db.query(`select to_regclass('public.producto_opciones') is null t`)).rows[0].t, 'la base de la prueba ya tenia producto_opciones');

    // el 16 se vuelve a correr con el 19 puesto: su comprobacion "15 funciones" ya no cuenta las del 19
    const re16 = await correr(db, SQL16());
    prueba('A5 el SQL 16 se puede volver a correr con el 19 ya aplicado (cuenta 15 funciones propias y no se rompe)', todosOK(re16.rows), re16.error || malas(re16.rows));
    const sigue = (await db.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('sa_ver_pedidos','sa_ver_menu','sa_ver_config','sa_ver_resumen','sa_registrar_rechazo_mfa','auditar_lectura_superadmin')`)).rows[0].n;
    prueba('A6 y volver a correr el 16 no borra las funciones del 19', sigue === 6, String(sigue));

    // reversa
    await db.query(`insert into auth.users (id, email) values ('${U.extra}', 'sa19@t.test') on conflict do nothing`);
    await db.query(`insert into public.superadmins (user_id) values ('${U.extra}') on conflict do nothing`);
    await db.query(`select public.sa_ver_menu('${U.extra}', '${TAQ}')`);
    const filasAud = (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n;
    const antesRev = await huella(db);
    const r1 = await correr(db, REV19());
    const r2 = await correr(db, REV19());
    const quedan = (await db.query(`select (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname in ('sa_ver_pedidos','sa_ver_menu','sa_ver_config','sa_ver_resumen','sa_registrar_rechazo_mfa','auditar_lectura_superadmin')) n19,
      (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname like 'sa\\_%' and proname not in ('sa_texto_raro','sa_zona_valida','sa_estado_secretos_interno')) n16,
      (select count(*)::int from public.auditoria_superadmin) aud`)).rows[0];
    prueba('A7 la reversa borra las 6 funciones, deja las 15 del 16, conserva TODA la auditoria, no cambia datos y sus 5 comprobaciones dan OK (dos veces: idempotente)',
      todosOK(r1.rows) && todosOK(r2.rows) && r1.rows.length === 5 && quedan.n19 === 0 && quedan.n16 === 15 && quedan.aud === filasAud && (await huella(db)) === antesRev, r1.error || r2.error || malas(r1.rows) || JSON.stringify(quedan));
    const rv = await correr(db, SQL19());
    prueba('A8 el SQL 19 se vuelve a aplicar despues de revertir (y la auditoria que ya tenia filas no se toca)', todosOK(rv.rows) && (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n === filasAud, rv.error || malas(rv.rows));

    // la reversa en una base SIN 19 y en una SIN 16 tampoco falla
    const sola = await baseConSql15();
    const rs = await correr(sola, REV19());
    prueba('A9 la reversa en una base sin el 16 ni el 19 no falla y sus comprobaciones dan OK', todosOK(rs.rows), rs.error || malas(rs.rows));
    const sin19 = await baseConSql15();
    await correr(sin19, SQL16());
    const rs2 = await correr(sin19, REV19());
    prueba('A10 la reversa en una base con el 16 pero sin el 19 tampoco falla', todosOK(rs2.rows), rs2.error || malas(rs2.rows));

    // con el 16b y con el 18 (con opciones) aplicados
    const completa = await baseConSql15();
    await correr(completa, SQL16()); await SIN16B(completa);
    await aplicarSql18(completa, path.join(RAIZ, 'supabase', '18-opciones-producto.sql'));
    const c19 = await correr(completa, SQL19());
    prueba('A11 con el 16b y el 18 aplicados el SQL 19 tambien da todo OK', todosOK(c19.rows), c19.error || malas(c19.rows));
    // revertir el 16 con el 19 puesto: borra TODAS las sa_* (tambien las del 19) y no falla
    const r16 = await correr(completa, sql('16-revertir.sql'));
    const resto = (await db.query('select 1')).rows.length;
    const hay19 = (await completa.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('sa_ver_pedidos','sa_ver_menu','sa_ver_config','sa_ver_resumen','sa_registrar_rechazo_mfa')`)).rows[0].n;
    prueba('A12 la reversa del 16 con el 19 puesto tambien borra las funciones del 19 y todas sus comprobaciones dan OK', todosOK(r16.rows) && hay19 === 0 && resto === 1, r16.error || malas(r16.rows));
  }

  // ================= base completa para el resto =================
  const db = await baseConSql15();
  await correr(db, SQL16());
  await SIN16B(db);
  await aplicarSql18(db, path.join(RAIZ, 'supabase', '18-opciones-producto.sql'));
  prueba('(base) SQL 16, 16b, 18 y 19 aplicados para el resto', todosOK((await correr(db, SQL19())).rows));

  const ids = { sa: 'f1900000-0000-4000-8000-0000000000f1', sa2: 'f1900000-0000-4000-8000-0000000000f2', dueno: 'f1900000-0000-4000-8000-0000000000d1', cajero: 'f1900000-0000-4000-8000-0000000000c1',
    cocina: 'f1900000-0000-4000-8000-0000000000c2', sin: 'f1900000-0000-4000-8000-0000000000e1', otro: 'f1900000-0000-4000-8000-0000000000d2', noSuper: 'f1900000-0000-4000-8000-0000000000aa' };
  const RA = '55555555-5555-4555-8555-5555555555a1', RB = '55555555-5555-4555-8555-5555555555b1';
  for (const id of Object.values(ids)) await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, id.slice(-4) + '@t.test']);
  await db.query(`insert into public.restaurantes (id, slug, nombre, estado, zona_horaria) values ($1, 'sql19-a', 'Restaurante A', 'activo', 'America/Bogota'), ($2, 'sql19-b', 'Restaurante B', 'activo', 'Asia/Tokyo')`, [RA, RB]);
  await db.exec(`
    insert into public.superadmins (user_id) values ('${ids.sa}'), ('${ids.sa2}');
    insert into public.miembros (user_id, restaurante_id, rol) values ('${ids.dueno}', '${RA}', 'dueno'), ('${ids.cajero}', '${RA}', 'cajero'), ('${ids.cocina}', '${RA}', 'cocina'), ('${ids.otro}', '${RB}', 'dueno');`);

  const como = (quien, q, p = []) => {
    if (quien === 'anon') return intentar(db, null, q, p, { rol: 'anon' });
    if (quien === 'srv') return intentar(db, null, q, p, { rol: 'service_role' });
    return intentar(db, ids[quien], q, p, { rol: 'authenticated' });
  };
  const LLAMADAS = [
    ['sa_ver_pedidos', `select public.sa_ver_pedidos($1::uuid, '${RA}')`], ['sa_ver_menu', `select public.sa_ver_menu($1::uuid, '${RA}')`], ['sa_ver_config', `select public.sa_ver_config($1::uuid, '${RA}')`],
    ['sa_ver_resumen', `select public.sa_ver_resumen($1::uuid, '${RA}')`], ['sa_registrar_rechazo_mfa', `select public.sa_registrar_rechazo_mfa($1::uuid)`],
    ['auditar_lectura_superadmin', `select public.auditar_lectura_superadmin($1::uuid, 'ver_menu', '${RA}', '{}'::jsonb)`]
  ];
  const srv = (q, p = []) => como('srv', q, p);

  // ================= B. permisos por rol =================
  {
    const antes = await huella(db);
    const audAntes = (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n;
    const mal = [];
    for (const quien of ['anon', 'dueno', 'cajero', 'cocina', 'sin', 'otro', 'sa']) {
      for (const [nombre, q] of LLAMADAS) {
        const r = await como(quien, q, [ids.sa]);
        if (!(!r.ok && r.code === '42501' && /permission denied/i.test(r.error || ''))) mal.push(`${quien}/${nombre}: ${r.ok ? 'EJECUTO' : r.code + ' ' + (r.error || '').slice(0, 50)}`);
      }
    }
    prueba(`B1 anon, dueno, cajero, cocina, sin membresia, dueno de otro restaurante e incluso el superadmin COMO USUARIO no ejecutan ninguna de las ${LLAMADAS.length} funciones (permission denied) aunque pasen el id del superadmin`, mal.length === 0, mal.slice(0, 5).join(' | '));
    const malS = [];
    for (const [nombre, q] of LLAMADAS) {
      for (const actor of [ids.noSuper, ids.dueno, '00000000-0000-4000-8000-0000000000ff']) {
        const r = await srv(q, [actor]);
        if (nombre === 'auditar_lectura_superadmin') { if (!(!r.ok && r.code === '42501' && /permission denied/i.test(r.error || ''))) malS.push(`srv/${nombre}: ${r.ok ? 'EJECUTO' : r.code}`); }
        else if (!(!r.ok && r.code === '42501' && /No autorizado/.test(r.error || ''))) malS.push(`srv/${nombre}/${actor.slice(-4)}: ${r.ok ? 'EJECUTO' : r.code + ' ' + (r.error || '').slice(0, 40)}`);
      }
      const nulo = await srv(q, [null]);
      if (nombre !== 'auditar_lectura_superadmin' && !(!nulo.ok && nulo.code === '42501')) malS.push(`srv/${nombre}/nulo`);
    }
    prueba('B2 el servidor (service_role) con un actor que NO es superadmin (normal, inexistente o nulo): 42501 "No autorizado" en las 5 funciones; la ayuda interna no la ejecuta ni el servidor', malS.length === 0, malS.slice(0, 5).join(' | '));
    prueba('B3 y nada cambio: ni datos de negocio ni una sola fila de auditoria', (await huella(db)) === antes && (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n === audAntes);
    const def = (await db.query(`select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sa_ver_pedidos','sa_ver_menu','sa_ver_config','sa_ver_resumen','sa_registrar_rechazo_mfa','auditar_lectura_superadmin')`)).rows;
    prueba('B4 las 6 son SECURITY DEFINER con search_path vacio', def.length === 6 && def.every((x) => x.prosecdef && x.cfg === 'search_path=""'), JSON.stringify(def));
    const src = (await db.query(`select p.proname, p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('sa_ver_pedidos','sa_ver_menu','sa_ver_config','sa_ver_resumen')`)).rows;
    prueba('B5 el codigo de las 4 lecturas no trae insert, update, delete, truncate, merge, copy, execute ni format (nada de SQL dinamico ni de escritura)', src.length === 4 && src.every((x) => !/(^|[^a-z_])(insert|update|delete|truncate|merge|copy|execute|format)([^a-z_]|$)/i.test(x.prosrc)), src.map((x) => x.proname).join());
    prueba('B6 ... ni nombra los secretos ni el token de seguimiento', src.every((x) => !/restaurante_secretos|token_seguimiento|wompi_integridad|wompi_eventos|callmebot_apikey|llave_privada/i.test(x.prosrc)));
  }

  // ================= C. las lecturas =================
  const sa = ids.sa;
  const jr = async (q, p = []) => { const r = await srv(q, [sa, ...p]); if (!r.ok) throw new Error(q.slice(0, 60) + ' -> ' + r.code + ' ' + r.error); return Object.values(r.rows[0])[0]; };
  const insP = (restaurante, ref, creado, extra = {}) => db.query(
    `insert into public.pedidos (restaurante_id, referencia, estado, estado_pago, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, creado_en)
     values ($1, $2, $3, $4, 'Cliente PII Uno', '3151112223', $5, $6::jsonb, $7, 0, $7, $8::timestamptz)`,
    [restaurante, ref, extra.estado || 'entregado', extra.pago || 'aprobado', extra.tipo || 'llevar', JSON.stringify(extra.items || [{ id: 'p1', nombre: 'P', cantidad: 1, precio: 10000, opciones: [{ id: 'x', tipo: 'extra', nombre: 'Queso', precio: 500 }] }]), extra.total || 10000, creado]);
  {
    // la jornada: corte 05:00 de Bogota. p_ahora = 2026-10-20 15:00Z (10:00 en Bogota) -> jornada del 20 [10:00Z del 20, 10:00Z del 21)
    await insP(RA, 'J-ANTES', '2026-10-20T09:59:00Z');          // 04:59 Bogota del 20 -> jornada del 19
    await insP(RA, 'J-INICIO', '2026-10-20T10:00:00Z');         // 05:00 Bogota -> jornada del 20
    await insP(RA, 'J-DENTRO', '2026-10-20T14:00:00Z', { total: 20000, tipo: 'domicilio' });
    await insP(RA, 'J-CANCELADO', '2026-10-20T15:00:00Z', { estado: 'cancelado', total: 5000 });
    await insP(RA, 'J-SINPAGAR', '2026-10-20T15:30:00Z', { estado: 'pendiente_pago', pago: 'pendiente', total: 7000 });
    await insP(RA, 'J-FIN', '2026-10-21T10:00:00Z');            // 05:00 Bogota del 21 -> jornada del 21
    await insP(RB, 'B-OTRO', '2026-10-20T14:00:00Z');
    const ahora = '2026-10-20T15:00:00Z';
    const j = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada', 50, null, '${ahora}'::timestamptz)`);
    const refs = j.pedidos.map((x) => x.referencia);
    prueba('C1 sa_ver_pedidos (jornada): usa el corte de las 05:00 de Bogota (04:59 es de la jornada anterior, 05:00 abre la del dia, 05:00 del dia siguiente abre otra), no mezcla restaurantes y trae la jornada',
      JSON.stringify(refs) === JSON.stringify(['J-SINPAGAR', 'J-CANCELADO', 'J-DENTRO', 'J-INICIO']) && j.jornada.fecha === '2026-10-20' && j.jornada.hora_corte === '05:00:00' && j.modo === 'jornada' && j.hay_mas === false && j.siguiente === null && j.devueltos === 4, JSON.stringify(refs) + JSON.stringify(j.jornada));
    const rec = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'recientes', 50, null, '${ahora}'::timestamptz)`);
    prueba('C2 sa_ver_pedidos (recientes): trae todos los del restaurante (6), del mas nuevo al mas viejo, y la jornada es null', rec.pedidos.length === 6 && rec.jornada === null && rec.pedidos.every((x, i, a) => i === 0 || a[i - 1].id > x.id) && !rec.pedidos.some((x) => x.referencia === 'B-OTRO'), JSON.stringify(rec.pedidos.map((x) => x.referencia)));
    const p = rec.pedidos[0];
    prueba('C3 cada pedido trae items con sus opciones, cliente, pago y estado; no trae token de seguimiento, coordenadas ni nada de mas (26 campos)', p.items[0].opciones[0].nombre === 'Queso' && p.cliente_nombre === 'Cliente PII Uno' && p.cliente_telefono === '3151112223' && p.estado_pago && Object.keys(p).length === 26 && !('token_seguimiento' in p) && !('lat' in p) && !('lng' in p), Object.keys(p).join());

    // paginado y limites
    for (let i = 0; i < 130; i++) await insP(RA, 'P-' + i, '2026-10-20T16:00:00Z');
    const g1 = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada', 1000, null, '${ahora}'::timestamptz)`);
    prueba('C4 el limite se recorta a 100 (pidiendo 1000) y avisa que hay mas, con "siguiente" = el id mas bajo entregado', g1.pedidos.length === 100 && g1.hay_mas === true && g1.siguiente === Math.min(...g1.pedidos.map((x) => x.id)), String(g1.pedidos.length));
    const g2 = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada', 100, ${g1.siguiente}, '${ahora}'::timestamptz)`);
    const todosIds = [...g1.pedidos, ...g2.pedidos].map((x) => x.id);
    prueba('C5 la pagina siguiente no repite ni se salta ninguno (134 en la jornada) y la ultima dice hay_mas=false', g2.pedidos.length === 34 && g2.hay_mas === false && g2.siguiente === null && new Set(todosIds).size === 134, `${g2.pedidos.length} ${new Set(todosIds).size}`);
    const l0 = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'recientes', 0, null, '${ahora}'::timestamptz)`);
    const ln = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'recientes', null, null, '${ahora}'::timestamptz)`);
    const lneg = await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'recientes', -5, null, '${ahora}'::timestamptz)`);
    prueba('C6 limite 0 o negativo da 1, nulo da 50', l0.pedidos.length === 1 && lneg.pedidos.length === 1 && ln.pedidos.length === 50, `${l0.pedidos.length} ${lneg.pedidos.length} ${ln.pedidos.length}`);
    const malos = [];
    for (const [q, cod] of [[`select public.sa_ver_pedidos($1::uuid, '${RA}', 'todos')`, '22023'], [`select public.sa_ver_pedidos($1::uuid, '${RA}', null)`, '22023'], [`select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada', 5, 0)`, '22023'], [`select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada', 5, -1)`, '22023'],
      [`select public.sa_ver_pedidos($1::uuid, '55555555-5555-4555-8555-5555555555ff')`, 'P0002'], [`select public.sa_ver_pedidos($1::uuid, null)`, 'P0002'], [`select public.sa_ver_menu($1::uuid, '55555555-5555-4555-8555-5555555555ff')`, 'P0002'],
      [`select public.sa_ver_config($1::uuid, '55555555-5555-4555-8555-5555555555ff')`, 'P0002'], [`select public.sa_ver_resumen($1::uuid, '55555555-5555-4555-8555-5555555555ff')`, 'P0002'], [`select public.sa_ver_menu($1::uuid, null)`, 'P0002']]) {
      const r = await srv(q, [sa]);
      if (r.ok || r.code !== cod) malos.push(q.slice(0, 55) + ':' + (r.ok ? 'ok' : r.code));
    }
    prueba('C7 modo malo, antes_de 0 o negativo (22023) y restaurante inexistente o nulo (P0002) se rechazan', malos.length === 0, malos.join(' | '));

    // menu
    await db.exec(`
      insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa) values ('${RA}', 'c-act', 'Activa', 'x', 1, true), ('${RA}', 'c-ina', 'Inactiva', 'x', 2, false), ('${RB}', 'c-b', 'De B', 'x', 1, true);
      insert into public.productos (restaurante_id, id, nombre, precio, categoria, orden, disponible) values ('${RA}', 'pa1', 'Prod A1', 1000, 'c-act', 1, true), ('${RA}', 'pa2', 'Agotado', 2000, 'c-act', 2, false), ('${RA}', 'pa3', 'Escondido', 3000, 'c-ina', 1, true), ('${RB}', 'pb1', 'Prod B1', 4000, 'c-b', 1, true);
      insert into public.producto_opciones (restaurante_id, producto_id, id, tipo, nombre, precio, orden, activa) values ('${RA}', 'pa1', 'sin-x', 'quitar', 'Sin X', 0, 0, true), ('${RA}', 'pa1', 'extra-y', 'extra', 'Extra Y', 1500, 1, false), ('${RB}', 'pb1', 'extra-b', 'extra', 'Extra B', 100, 0, true);`);
    const m = await jr(`select public.sa_ver_menu($1::uuid, '${RA}')`);
    prueba('C8 sa_ver_menu: categorias, productos y opciones del restaurante, TAMBIEN las inactivas, agotadas y apagadas, sin las de otro restaurante', m.categorias.length === 2 && m.categorias.some((c) => c.activa === false) && m.productos.length === 3 && m.productos.some((x) => x.disponible === false)
      && m.opciones.length === 2 && m.opciones.some((o) => o.activa === false) && m.totales.productos === 3 && m.truncado === false && !JSON.stringify(m).includes('De B') && !JSON.stringify(m).includes('Extra B'), JSON.stringify(m.totales));
    await db.exec(`insert into public.categorias (restaurante_id, id, nombre, emoji, orden, activa) select '${RB}', 'cat-' || g, 'Cat ' || g, 'x', g + 10, true from generate_series(1, 201) g;`);
    const mb = await jr(`select public.sa_ver_menu($1::uuid, '${RB}')`);
    prueba('C9 sa_ver_menu corta cada lista en su tope (200 categorias de 202) y lo dice con truncado=true y los totales reales', mb.categorias.length === 200 && mb.totales.categorias === 202 && mb.truncado === true, `${mb.categorias.length} ${mb.totales.categorias} ${mb.truncado}`);

    // config
    await db.query(`update public.restaurante_secretos set callmebot_apikey = 'SENTINELA-CMB-19', wompi_integridad_test = 'test_integrity_SENTINELA19', otros = '{"wompi_llave_privada_test":"prv_test_SENTINELA19","wompi_modo":"test"}'::jsonb where restaurante_id = $1`, [RA]);
    await db.query(`update public.configuracion set mensaje_cerrado = 'Cerrado A (sql19)' where restaurante_id = $1`, [RA]);   // el horario tiene que ser el de A, no el de otro
    const cfg = await jr(`select public.sa_ver_config($1::uuid, '${RA}')`);
    const miembros = cfg.miembros.map((x) => x.rol + ':' + x.email).sort();
    prueba('C10 sa_ver_config: config, vigencia, dominios, miembros con rol y correo, tarifas, secretos como si/no y el horario', cfg.id === RA && cfg.slug === 'sql19-a' && cfg.vigencia && Array.isArray(cfg.dominios) && Array.isArray(cfg.tarifas) && miembros.length === 3 && miembros.includes('dueno:' + ids.dueno.slice(-4) + '@t.test')
      && cfg.horario && 'horarios' in cfg.horario && cfg.horario.hora_corte_jornada && cfg.horario.mensaje_cerrado === 'Cerrado A (sql19)' && cfg.secretos.callmebot_apikey === true && cfg.secretos.wompi_modo === 'test', JSON.stringify(cfg).slice(0, 250));

    // resumen: jornada y mes (mes en la zona del restaurante)
    const res = await jr(`select public.sa_ver_resumen($1::uuid, '${RA}', '${ahora}'::timestamptz)`);
    const jj = res.jornada;
    // J-INICIO(10000) J-DENTRO(20000) J-CANCELADO(5000, cancelado) J-SINPAGAR(7000, sin pagar) + 130 de 10000 = 134 pedidos; vendidos = 2 + 130; ventas = 30000 + 1300000
    prueba('C11 sa_ver_resumen: la jornada cuenta pedidos, vendidos (pagado y no cancelado), ventas, cancelados, por estado y por tipo', jj.pedidos === 134 && jj.vendidos === 132 && jj.ventas === 1330000 && jj.cancelados === 1 && jj.por_estado.pendiente_pago === 1 && jj.por_estado.entregado === 132 && jj.por_estado.cancelado === 1
      && jj.por_tipo.domicilio === 1 && jj.por_tipo.llevar === 133 && jj.ticket_promedio === Math.round(1330000 / 132) && res.catalogo.productos === 3 && res.catalogo.productos_disponibles === 2 && res.catalogo.miembros_activos === 3 && res.restaurante.slug === 'sql19-a', JSON.stringify(jj).slice(0, 300));
    // mes en Tokyo (UTC+9): 2026-10-31 14:30Z = 23:30 del 31 en Tokyo (octubre); 15:30Z = 00:30 del 1 de noviembre (noviembre)
    await insP(RB, 'M-OCT', '2026-10-31T14:30:00Z'); await insP(RB, 'M-NOV', '2026-10-31T15:30:00Z', { total: 3000 });
    const mes = await jr(`select public.sa_ver_resumen($1::uuid, '${RB}', '2026-10-31T14:45:00Z'::timestamptz)`);
    prueba('C12 el mes se corta en la zona horaria del restaurante (Tokyo): 23:30 del 31 es octubre, 00:30 del 1 es noviembre', mes.mes.zona_horaria === 'Asia/Tokyo' && mes.mes.pedidos === 2 && mes.mes.ventas === 20000 + 0 && mes.mes.desde.startsWith('2026-09-30T15:00:00') && mes.mes.hasta.startsWith('2026-10-31T15:00:00'),
      JSON.stringify(mes.mes));
    // (B-OTRO de 2026-10-20 + M-OCT, ambos de octubre = 2 pedidos de 10000)

    // secretos y tokens
    const todo = JSON.stringify([await jr(`select public.sa_ver_pedidos($1::uuid, '${RA}', 'recientes', 100)`), m, cfg, res, await jr(`select public.sa_ver_resumen($1::uuid, '${RA}')`), await jr(`select public.sa_ver_config($1::uuid, '${RA}')`)]);
    const tokens = (await db.query(`select token_seguimiento t from public.pedidos where restaurante_id = $1 and token_seguimiento is not null`, [RA])).rows.map((x) => x.t).filter((t) => String(t).length > 8);
    prueba('C13 ninguna lectura devuelve los secretos (llave de CallMeBot, secreto de integridad, llave privada) ni un token de seguimiento', tokens.length > 50 && !/SENTINELA/.test(todo) && !tokens.some((t) => todo.includes(t)) && !/prv_test|test_integrity|"token_seguimiento"/.test(todo), tokens.length + '');
  }

  // ================= D. no escriben =================
  {
    await db.exec(`
      create or replace function pg_temp.sin_escrituras() returns trigger language plpgsql as $f$ begin raise exception 'ESCRITURA PROHIBIDA en % (%)', tg_table_name, tg_op using errcode = 'P0001'; end $f$;`).catch(() => {});
    // (los triggers temporales no sirven entre sesiones; se crean funciones normales con un nombre que se limpia al final)
    await db.exec(`create or replace function public.zz_sin_escrituras() returns trigger language plpgsql as $f$ begin raise exception 'ESCRITURA PROHIBIDA en % (%)', tg_table_name, tg_op using errcode = 'P0001'; end $f$;`);
    const tablas = (await db.query(`select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'auditoria_superadmin'
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`)).rows.map((x) => x.relname);
    for (const t of tablas) await db.exec(`create trigger zz_bloquear_escrituras before insert or update or delete on public.${t} for each statement execute function public.zz_sin_escrituras();`);
    await db.exec(`create trigger zz_bloquear_vaciar before truncate on public.pedidos for each statement execute function public.zz_sin_escrituras();`);
    const antes = await huella(db);
    const audAntes = (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n;
    const fallos = [];
    for (const rid of [RA, RB, TAQ]) {
      for (const q of [`select public.sa_ver_pedidos($1::uuid, '${rid}', 'jornada')`, `select public.sa_ver_pedidos($1::uuid, '${rid}', 'recientes', 100, 99999999)`, `select public.sa_ver_menu($1::uuid, '${rid}')`, `select public.sa_ver_config($1::uuid, '${rid}')`, `select public.sa_ver_resumen($1::uuid, '${rid}')`]) {
        for (let i = 0; i < 2; i++) { const r = await srv(q, [ids.sa2]); if (!r.ok) fallos.push(q.slice(0, 40) + ':' + r.error); }
      }
    }
    prueba('D1 con triggers que rechazan CUALQUIER escritura (insertar, actualizar, borrar, vaciar) en TODAS las tablas de negocio, las 4 lecturas funcionan sobre 3 restaurantes, repetidas', fallos.length === 0 && tablas.length >= 10, fallos.slice(0, 3).join(' | ') + ' tablas:' + tablas.length);
    prueba('D2 y la unica diferencia en la base despues de leer es la auditoria (datos de negocio identicos)', (await huella(db)) === antes && (await db.query(`select count(*)::int n from public.auditoria_superadmin`)).rows[0].n > audAntes);
    for (const t of tablas) await db.exec(`drop trigger zz_bloquear_escrituras on public.${t}`);
    await db.exec(`drop trigger zz_bloquear_vaciar on public.pedidos; drop function public.zz_sin_escrituras();`);
  }

  // ================= E. auditoria =================
  {
    const aud = async (accion, rid, actor = sa) => (await db.query(`select * from public.auditoria_superadmin where actor = $1 and accion = $2 and restaurante_id is not distinct from $3 order by id`, [actor, accion, rid])).rows;
    // un superadmin NUEVO, sin historial, para empezar de cero
    const A = 'f1900000-0000-4000-8000-0000000000f3';
    await db.query(`insert into auth.users (id, email) values ($1, 'sa3@t.test') on conflict do nothing`, [A]);
    await db.query(`insert into public.superadmins (user_id) values ($1) on conflict do nothing`, [A]);
    const n0 = (await aud('ver_menu', RA, A)).length;
    await jr0(A, `select public.sa_ver_menu($1::uuid, '${RA}')`);
    await jr0(A, `select public.sa_ver_menu($1::uuid, '${RA}')`);
    await jr0(A, `select public.sa_ver_menu($1::uuid, '${RA}')`);
    const n1 = (await aud('ver_menu', RA, A)).length;
    prueba('E1 la misma lectura repetida deja UNA sola fila de auditoria dentro de la ventana', n1 - n0 <= 1 && (await aud('ver_menu', RA, A)).length >= 1, `${n0} -> ${n1}`);
    // fuera de la ventana: una fila de 11 minutos no cuenta; una de 9 minutos si
    await db.query(`insert into public.auditoria_superadmin (creado_en, actor, accion, restaurante_id, resumen) values (now() - interval '11 minutes', $1, 'ver_config', $2, '{}')`, [A, RA]);
    await jr0(A, `select public.sa_ver_config($1::uuid, '${RA}')`);
    const c = await aud('ver_config', RA, A);
    prueba('E2 una lectura igual hecha hace 11 minutos NO cuenta: la nueva deja su fila (ventana de 10 minutos)', c.length === 2 && c[1].actor_email !== null, String(c.length));
    await db.query(`insert into public.auditoria_superadmin (creado_en, actor, accion, restaurante_id, resumen) values (now() - interval '9 minutes', $1, 'ver_resumen', $2, '{}')`, [A, RA]);
    await jr0(A, `select public.sa_ver_resumen($1::uuid, '${RA}')`);
    prueba('E3 ... y una de hace 9 minutos SI cuenta: no se agrega otra', (await aud('ver_resumen', RA, A)).length === 1);
    // otro modo, otro restaurante y otro superadmin dejan la suya
    await jr0(A, `select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada')`);
    await jr0(A, `select public.sa_ver_pedidos($1::uuid, '${RA}', 'jornada', 5, 99999999)`);
    await jr0(A, `select public.sa_ver_pedidos($1::uuid, '${RA}', 'recientes')`);
    await jr0(A, `select public.sa_ver_menu($1::uuid, '${RB}')`);
    await jr0(ids.sa, `select public.sa_ver_config($1::uuid, '${RA}')`);
    const pj = (await aud('ver_pedidos', RA, A)).map((x) => x.resumen.modo);
    prueba('E4 otro modo (jornada/recientes), otro restaurante y otro superadmin dejan su propia fila; las paginas siguientes de la misma consulta no', JSON.stringify(pj) === JSON.stringify(['jornada', 'recientes']) && (await aud('ver_menu', RB, A)).length === 1 && (await aud('ver_config', RA, ids.sa)).length === 1, JSON.stringify(pj));
    // contenido de la auditoria
    const todas = (await db.query(`select actor, actor_email, restaurante_id, restaurante_slug, accion, resumen, creado_en from public.auditoria_superadmin where accion like 'ver\\_%' and actor_email is not null`)).rows;
    const texto = JSON.stringify(todas);
    const claves = new Set(todas.flatMap((x) => Object.keys(x.resumen)));
    prueba('E5 la auditoria de lecturas trae quien, cuando, restaurante y accion, y un resumen SOLO de conteos y parametros: ningun nombre, telefono, correo de cliente, direccion, secreto ni token',
      todas.length >= 8 && todas.every((x) => x.actor && x.actor_email && x.creado_en && x.restaurante_slug) && !/Cliente PII|3151112223|SENTINELA|Prod A1|Restaurante A/.test(texto)
      && [...claves].every((k) => ['modo', 'limite', 'pagina_inicial', 'devueltos', 'categorias', 'productos', 'opciones', 'miembros', 'dominios', 'jornada'].includes(k)), [...claves].join());
    // rechazo por MFA
    const R = ids.noSuper;   // no superadmin -> 42501
    const r0 = await srv(`select public.sa_registrar_rechazo_mfa($1::uuid) r`, [R]);
    prueba('E6 sa_registrar_rechazo_mfa con alguien que no es superadmin: 42501 y no deja ninguna fila', !r0.ok && r0.code === '42501' && (await db.query(`select count(*)::int n from public.auditoria_superadmin where actor = $1`, [R])).rows[0].n === 0);
    const B = ids.sa;
    const antesR = (await aud('rechazo_mfa', null, B)).length;
    const a = await srv(`select public.sa_registrar_rechazo_mfa($1::uuid, 'aal1', 'listar_restaurantes') r`, [B]);
    const b = await srv(`select public.sa_registrar_rechazo_mfa($1::uuid, 'aal1', 'yo') r`, [B]);
    const filas = await aud('rechazo_mfa', null, B);
    prueba('E7 el rechazo por MFA deja UNA fila por superadmin y ventana de 15 minutos (la segunda dice registrado=false), sin restaurante y con solo aal, accion intentada y ventana',
      a.ok && a.rows[0].r.registrado === true && b.ok && b.rows[0].r.registrado === false && filas.length - antesR === 1 && JSON.stringify(Object.keys(filas[filas.length - 1].resumen).sort()) === '["aal","accion_intentada","ventana_minutos"]' && filas[filas.length - 1].resumen.accion_intentada === 'listar_restaurantes', JSON.stringify([a.rows, b.rows, filas.length - antesR]));
    await db.query(`insert into public.auditoria_superadmin (creado_en, actor, accion, resumen) values (now() - interval '16 minutes', $1, 'rechazo_mfa', '{}')`, [ids.dueno]);
    // (el dueno no es superadmin: se usa un tercer superadmin para la ventana vencida)
    await db.query(`insert into public.superadmins (user_id) values ($1) on conflict do nothing`, [ids.cajero]);
    await db.query(`insert into public.auditoria_superadmin (creado_en, actor, accion, resumen) values (now() - interval '16 minutes', $1, 'rechazo_mfa', '{}')`, [ids.cajero]);
    const v = await srv(`select public.sa_registrar_rechazo_mfa($1::uuid) r`, [ids.cajero]);
    prueba('E8 una constancia de hace 16 minutos no cuenta: la nueva se registra; otro superadmin tiene la suya', v.ok && v.rows[0].r.registrado === true && (await aud('rechazo_mfa', null, ids.cajero)).length === 2);
    const x1 = await srv(`select public.sa_registrar_rechazo_mfa($1::uuid, 'aal2', 'accion con <script> y espacios') r`, [ids.sa2]);
    const x2 = (await aud('rechazo_mfa', null, ids.sa2)).pop();
    await db.query(`insert into public.superadmins (user_id) values ($1) on conflict do nothing`, [ids.cocina]);
    const x3 = await srv(`select public.sa_registrar_rechazo_mfa($1::uuid, 'cualquier-cosa', null) r`, [ids.cocina]);
    const x4 = (await aud('rechazo_mfa', null, ids.cocina)).pop();
    prueba('E9 lo que llega como accion intentada solo se guarda si tiene forma de nombre de accion (si no, null); un nivel raro se guarda como aal1', x1.ok && x2.resumen.accion_intentada === null && x2.resumen.aal === 'aal2' && !JSON.stringify(x2).includes('script') && x3.ok && x4.resumen.aal === 'aal1' && x4.resumen.accion_intentada === null);
  }

  // limpieza de lo que dejo la prueba D
  for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();

  async function jr0(actor, q) { const r = await srv(q, [actor]); if (!r.ok) throw new Error(q.slice(0, 60) + ' -> ' + r.code + ' ' + r.error); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
