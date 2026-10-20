/* =============================================================
   PRUEBAS DEL SQL 11 (supabase/11-dominios.sql)

     node pruebas/multirestaurante/dominios.mjs

   1. Corre dos veces sobre una base con el SQL 10 y todas las comprobaciones dan OK;
      y el SQL 10 se puede volver a correr DESPUES del 11 (no lo bloquea).
   2. Roles reales (anon, authenticated, service_role): solo el servidor toca la tabla.
   3. Restricciones: host unico, en minusculas, sin puerto ni espacios; FK; cascada.
   4. REVISION POR MUTACION del propio SQL 11: se rompe cada defensa y la migracion
      tiene que detenerse (o alguna prueba tiene que fallar).
============================================================= */
import { crearBase, sembrar, sql10, sql, intentar, U } from './sim.mjs';

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info) });
const ultimo = (res) => res[res.length - 1];
const TAQ = '00000000-0000-4000-8000-000000000001';

async function baseConSql10() {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  return db;
}

/* ---- 1. idempotencia y convivencia con el SQL 10 ---------------------------------------------------- */
const db = await baseConSql10();
const archivo = sql('11-dominios.sql');
const r1 = ultimo(await db.exec(archivo)).rows;
const r2 = ultimo(await db.exec(archivo)).rows;
prueba('primera corrida: todas las comprobaciones OK', r1.length >= 10 && r1.every((x) => x.estado === 'OK'), JSON.stringify(r1.filter((x) => x.estado !== 'OK')));
prueba('segunda corrida (idempotente): todas OK y sin duplicar el host sembrado',
  r2.every((x) => x.estado === 'OK') && (await db.query(`select count(*)::int n from public.restaurante_dominios`)).rows[0].n === 1, '');
const r10 = ultimo(await db.exec(sql10())).rows;
prueba('el SQL 10 se puede volver a correr DESPUES del 11 y sigue dando todo OK', r10.length === 34 && r10.every((x) => x.estado === 'OK'), JSON.stringify(r10.filter((x) => x.estado !== 'OK')));
prueba('despues de re-correr el 10, restaurante_dominios sigue cerrada (sin politicas ni privilegios de clientes)', (await db.query(`
  select (select relrowsecurity from pg_class where oid = 'public.restaurante_dominios'::regclass) as rls,
         (select count(*) from pg_policy where polrelid = 'public.restaurante_dominios'::regclass)::int as politicas,
         has_table_privilege('anon', 'public.restaurante_dominios', 'select') as anon_sel,
         has_table_privilege('authenticated', 'public.restaurante_dominios', 'select') as auth_sel`)).rows
  .every((x) => x.rls === true && x.politicas === 0 && !x.anon_sel && !x.auth_sel), '');

/* ---- 2. roles ------------------------------------------------------------------------------------------------ */
for (const [nombre, uid, rol] of [['anon', null, 'anon'], ['authenticated (dueno de Taqueiros)', U.dueno_taq, 'authenticated']]) {
  for (const [op, q] of [
    ['leer', `select * from public.restaurante_dominios`],
    ['insertar', `insert into public.restaurante_dominios (host, restaurante_id) values ('hackeo.test', '${TAQ}')`],
    ['actualizar', `update public.restaurante_dominios set host = 'hackeo.test'`],
    ['borrar', `delete from public.restaurante_dominios`]
  ]) {
    const x = await intentar(db, uid, q, [], { rol });
    prueba(`${nombre} NO puede ${op} restaurante_dominios`, x.ok === false && x.code === '42501', JSON.stringify(x).slice(0, 150));
  }
}
const sv = await intentar(db, null, `select host from public.restaurante_dominios`, [], { rol: 'service_role' });
prueba('el servidor (service_role) lee la tabla y ve el host de Taqueiros', sv.ok && sv.rows.length === 1 && sv.rows[0].host === 'taqueiros-2-0.vercel.app', JSON.stringify(sv).slice(0, 150));

/* ---- 3. restricciones --------------------------------------------------------------------------------------------- */
const insertar = (host, rid = TAQ) => intentar(db, null, `insert into public.restaurante_dominios (host, restaurante_id) values ($1, $2)`, [host, rid], { rol: 'service_role' });
prueba('un host repetido se rechaza (unico)', (await insertar('taqueiros-2-0.vercel.app')).code === '23505', '');
for (const malo of ['MayusculasNo.test', 'con espacio.test', 'puerto.test:443', '.empieza.test', 'termina.test.', 'doble..punto.test', 'a/b.test', '', 'ab']) {
  const x = await insertar(malo);
  prueba(`host invalido "${malo}" se rechaza`, x.ok === false && x.code === '23514', JSON.stringify(x).slice(0, 120));
}
prueba('un restaurante inexistente se rechaza (llave foranea)', (await insertar('huerfano.test', '99999999-9999-4999-8999-999999999999')).code === '23503', '');
prueba('un host valido se inserta', (await insertar('lostaqueiros.midominio.com')).ok, '');
await db.exec(`insert into public.restaurantes (id, slug, nombre) values ('22222222-2222-4222-8222-222222222222', 'otro-rest', 'Otro')`);
await insertar('otro.midominio.com', '22222222-2222-4222-8222-222222222222');
await db.exec(`delete from public.configuracion where restaurante_id = '22222222-2222-4222-8222-222222222222'`);
await db.exec(`delete from public.salud_notificaciones where restaurante_id = '22222222-2222-4222-8222-222222222222'`);
await db.exec(`delete from public.restaurantes where id = '22222222-2222-4222-8222-222222222222'`);
prueba('al borrar un restaurante se borran sus dominios (cascada)', (await db.query(`select count(*)::int n from public.restaurante_dominios where host = 'otro.midominio.com'`)).rows[0].n === 0, '');
prueba('la publicacion Realtime NO incluye restaurante_dominios', (await db.query(`select count(*)::int n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'restaurante_dominios'`)).rows[0].n === 0, '');

/* ---- 4. revision por mutacion del SQL 11 -------------------------------------------------------------------------------------- */
const mutaciones = [
  ['no se quitan los privilegios de anon/authenticated', 'revoke all on public.restaurante_dominios from public, anon, authenticated;', '-- (mutacion)'],
  ['se deja a anon leer la tabla', 'grant select, insert, update, delete on public.restaurante_dominios to service_role;', 'grant select, insert, update, delete on public.restaurante_dominios to service_role;\n  grant select on public.restaurante_dominios to anon;'],
  ['se deja a authenticated leer la tabla', 'grant select, insert, update, delete on public.restaurante_dominios to service_role;', 'grant select, insert, update, delete on public.restaurante_dominios to service_role;\n  grant select on public.restaurante_dominios to authenticated;'],
  ['no se activa RLS', 'alter table public.restaurante_dominios enable row level security;', '-- (mutacion)'],
  ['no se siembra el host de Taqueiros', "values ('taqueiros-2-0.vercel.app', public.restaurante_taqueiros_id())", "values ('otro-host.test', public.restaurante_taqueiros_id())"],
  ['se quita el formato del host (minusculas, sin puerto)', "constraint restaurante_dominios_host_formato\n        check (host = lower(host)\n               and char_length(host) between 3 and 253\n               and host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'\n               and host !~ '\\.\\.')", "constraint restaurante_dominios_host_formato check (true)"],
  ['el host deja de ser unico (sin llave primaria)', 'host           text primary key,', 'host           text,'],
  ['restaurante_id sin llave foranea', 'restaurante_id uuid not null references public.restaurantes(id) on delete cascade,', 'restaurante_id uuid not null,']
];
for (const [nombre, buscar, reemplazar] of mutaciones) {
  const n = archivo.split(buscar).length - 1;
  if (n !== 1) { prueba(`mutacion mal definida: ${nombre}`, false, `"${buscar.slice(0, 60)}" aparece ${n} veces`); continue; }
  const base = await baseConSql10();
  let detectada = false, info = '';
  try {
    const res = ultimo(await base.exec(archivo.replace(buscar, () => reemplazar))).rows;
    // la migracion termino: alguna comprobacion debe haber fallado, o una prueba de roles/restricciones lo atrapa
    const x = await intentar(base, null, `select * from public.restaurante_dominios`, [], { rol: 'anon' });
    const y = await intentar(base, U.dueno_taq, `select * from public.restaurante_dominios`, [], { rol: 'authenticated' });
    const z = await intentar(base, null, `insert into public.restaurante_dominios (host, restaurante_id) values ('MAYUS.test', '${TAQ}')`, [], { rol: 'service_role' });
    const w = await intentar(base, null, `insert into public.restaurante_dominios (host, restaurante_id) values ('taqueiros-2-0.vercel.app', '${TAQ}')`, [], { rol: 'service_role' });
    const v = await intentar(base, null, `insert into public.restaurante_dominios (host, restaurante_id) values ('x.test', '99999999-9999-4999-8999-999999999999')`, [], { rol: 'service_role' });
    detectada = res.some((r) => r.estado !== 'OK') || x.ok || y.ok || z.ok || w.ok || v.ok;
    info = 'termino con todo OK y ninguna prueba lo atrapa';
  } catch (e) {
    detectada = /LA MIGRACION 11 SE REVIRTIO|MR paso/.test(e.message);
    info = 'fallo por otra razon: ' + e.message.slice(0, 120);
  }
  prueba(`mutacion detectada: ${nombre}`, detectada, info);
}

for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
const fallas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
process.exitCode = fallas ? 1 : 0;
