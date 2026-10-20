/* =============================================================
   SIMULADOR LOCAL DE SUPABASE sobre PGlite (Postgres 16 en WASM)

   Para probar supabase/10-multirestaurante.sql SIN tocar la base real:
   crea los roles anon / authenticated / service_role, auth.users +
   auth.uid(), storage.buckets / objects + foldername(), la publicacion
   supabase_realtime y los permisos por defecto de Supabase; aplica en
   orden los SQL antiguos del repo (como quedo la base real), siembra
   unos pedidos y despues corre el SQL 10.

   USO (una vez:  npm i --no-save @electric-sql/pglite@0.2.17)
     node pruebas/multirestaurante/sim.mjs                 aplica los SQL antiguos + el 10 DOS veces
     node pruebas/multirestaurante/sim.mjs conPendientes   igual, pero con el 01 y el 02 ya corridos

   Es un simulador: no reemplaza probar en la base real (ver docs/multirestaurante.md, seccion 8).
============================================================= */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').split(path.sep).join('/');
export const sql = (f) => fs.readFileSync(`${REPO}/supabase/${f}`, 'utf8');
// El SQL 10 a probar. SQL10_ARCHIVO permite probar otra version (la de un commit anterior o una mutacion).
export const sql10 = () => process.env.SQL10_ARCHIVO ? fs.readFileSync(process.env.SQL10_ARCHIVO, 'utf8') : sql('10-multirestaurante.sql');

export const U = {
  dueno_taq: '24fe556c-f26b-4f7e-84a7-c9e7168ac18c',
  extra: '11111111-1111-4111-8111-111111111111',
};

/* PLANES ADVERSOS. Postgres NO garantiza en que orden evalua los filtros de un WHERE: una funcion
   puesta junto a "schemaname = 'public'" puede ejecutarse sobre filas de OTROS esquemas antes de que
   el filtro las descarte. Con el catalogo pequeno del simulador el plan casi siempre filtra primero y
   el fallo no aparece; en Supabase (muchos esquemas, extensiones) el plan es otro. Estos ajustes
   fuerzan planes distintos para destaparlo. Se activan con la variable SQL10_PLAN=<nombre> o "todos"
   en planes.mjs. */
export const PLANES = {
  defecto: '',
  'sin-nestloop': 'set enable_nestloop = off',
  'solo-nestloop': 'set enable_hashjoin = off; set enable_mergejoin = off',
  'sin-indices': 'set enable_indexscan = off; set enable_bitmapscan = off; set enable_indexonlyscan = off',
  'sin-indices-ni-nestloop': 'set enable_indexscan = off; set enable_bitmapscan = off; set enable_indexonlyscan = off; set enable_nestloop = off',
  'solo-seqscan-y-hash': 'set enable_nestloop = off; set enable_mergejoin = off; set enable_indexscan = off; set enable_bitmapscan = off; set enable_indexonlyscan = off',
  'solo-merge': 'set enable_nestloop = off; set enable_hashjoin = off; set enable_indexscan = off; set enable_bitmapscan = off',
  'orden-literal': 'set join_collapse_limit = 1; set from_collapse_limit = 1; set enable_nestloop = off'
};
export async function aplicarPlan(db, nombre) {
  if (!nombre || nombre === 'defecto') return;
  if (!(nombre in PLANES)) throw new Error('plan desconocido: ' + nombre);
  await db.exec(PLANES[nombre]);
}

/* ENTORNO REALISTA: lo que tiene un proyecto Supabase real y el simulador basico no tenia.
   - roles internos (supabase_admin, supabase_auth_admin, supabase_storage_admin, authenticator)
   - esquemas extensions, graphql, graphql_public, vault, realtime con tablas y funciones, algunas de
     supabase_admin, con permisos para anon / authenticated
   - permisos de lectura de anon y authenticated sobre tablas de pg_catalog (pg_statistic...)
   - objetos de una extension (citext) instalados en public
   - muchos esquemas y tablas extra, y ANALYZE del catalogo: cambia los planes del optimizador */
async function entornoRealista(db) {
  await db.exec(`
    create role supabase_admin nologin bypassrls;
    create role supabase_auth_admin nologin;
    create role supabase_storage_admin nologin;
    create role authenticator nologin noinherit;
    grant anon, authenticated, service_role to authenticator;

    create extension citext schema public;

    create schema extensions;
    create function extensions.uuid_generate_v4() returns uuid language sql as 'select gen_random_uuid()';
    create schema graphql;
    create schema graphql_public;
    create function graphql_public.graphql(query text default null) returns jsonb language sql stable as 'select ''{}''::jsonb';
    create schema vault;
    create table vault.secrets (id uuid primary key default gen_random_uuid(), name text, secret text);
    create schema realtime;
    create table realtime.subscription (id bigint generated always as identity primary key, claims jsonb);
    create table realtime.messages (id bigint generated always as identity primary key, topic text, payload jsonb);
    create function realtime.topic() returns text language sql stable as 'select ''t''::text';
    create function realtime.apply_rls(wal jsonb) returns text language sql as 'select ''x''::text';
    alter function realtime.apply_rls(jsonb) owner to supabase_admin;
    alter table realtime.subscription owner to supabase_admin;
    alter function graphql_public.graphql(text) owner to supabase_admin;
    grant usage on schema extensions, graphql_public, realtime to anon, authenticated, service_role;
    grant execute on all functions in schema extensions, graphql_public, realtime to anon, authenticated, service_role;
    grant select, insert on realtime.messages to authenticated;
    grant select on realtime.subscription to authenticated;

    -- lectura de catalogos internos para anon/authenticated (Supabase real los expone en parte)
    grant select on pg_catalog.pg_statistic to anon, authenticated;
    grant select on pg_catalog.pg_largeobject to authenticated;

    -- catalogo grande: 25 esquemas con 4 tablas c/u (cambia estadisticas y planes)
  `);
  for (let i = 0; i < 25; i++) {
    await db.exec(`create schema relleno_${i}; ` + [0, 1, 2, 3].map((j) => `create table relleno_${i}.t${j} (id int primary key, dato text);`).join(' ')
      + ` grant select on all tables in schema relleno_${i} to authenticated;`);
  }
  await db.exec('analyze');
}

export async function crearBase({ con01y02 = false, realista = true } = {}) {
  const db = new PGlite({ extensions: { citext } });
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub', '')::uuid $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean default false,
      file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
      name text, owner uuid, created_at timestamptz default now());
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language plpgsql as $$
      declare _parts text[]; begin select string_to_array(name, '/') into _parts;
      return _parts[1:array_length(_parts,1)-1]; end $$;
    create publication supabase_realtime;
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant execute on function storage.foldername(text) to anon, authenticated, service_role;
    grant all on all tables in schema storage to anon, authenticated, service_role;
    grant select on auth.users to service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    insert into auth.users (id, email) values ('${U.dueno_taq}', 'panel@taqueiros.test');
  `);
  if (realista) await entornoRealista(db);
  const orden = ['schema.sql', 'migracion-domicilio.sql', 'seguridad.sql', 'menu.sql', 'configuracion.sql', 'jornada.sql', 'resumen-jornada.sql',
    'migracion-alertas.sql', 'migracion-ubicacion.sql', 'salud-notificaciones.sql',
    'seguimiento.sql', 'buscar-pedidos.sql', 'limpieza-huerfanos.sql'];
  // pedidos.subtotal se agrega en migracion-domicilio, que va despues de jornada; igual que en la base real
  for (const f of orden) {
    try { await db.exec(sql(f)); } catch (e) { throw new Error(`[${f}] ${e.message}`); }
  }
  if (con01y02) {
    for (const f of ['01-productos-fotos.sql', '02-impresion.sql']) {
      try { await db.exec(sql(f)); } catch (e) { throw new Error(`[${f}] ${e.message}`); }
    }
  }
  if (realista) await db.exec('analyze');   // estadisticas del catalogo con todo ya creado
  await aplicarPlan(db, process.env.SQL10_PLAN);
  return db;
}

export async function sembrar(db) {
  // 6 pedidos antiguos: 1..6, con huecos de secuencia (borrados) y estados variados
  await db.exec(`
    insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en, alerta_enviada)
    values
     ('TAQ-1-aaa','entregado','Ana','3001112222','llevar','[{"id":"doriloco","nombre":"Doriloco","cantidad":2,"precio":26000}]',52000,0,52000,'aprobado', now() - interval '2 days', true),
     ('TAQ-2-bbb','entregado','Beto','3003334444','domicilio','[{"id":"cocacola","nombre":"Coca Cola","cantidad":1,"precio":5000}]',5000,5000,10000,'aprobado', now() - interval '1 day', true),
     ('TAQ-3-ccc','pendiente_pago','Cami','3005556666','llevar','[]',28000,0,28000,'pendiente', null, false),
     ('TAQ-4-ddd','nuevo','Dani','3007778888','local','[{"id":"birriaco","nombre":"Birriaco","cantidad":1,"precio":30000}]',30000,0,30000,'aprobado', now(), true),
     ('TAQ-5-eee','cancelado','Eli','3009990000','llevar','[{"id":"birriamen","nombre":"Birriamen","cantidad":1,"precio":26000}]',26000,0,26000,'aprobado', now(), true);
  `);
  await db.exec(`delete from public.pedidos where referencia = 'TAQ-3-ccc';`); // deja un hueco: ids 1,2,4,5 ; secuencia en 5
}

export async function como(db, uid, fn, { rol = 'authenticated' } = {}) {
  await db.exec(`set role ${rol}`);
  if (uid) await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: rol })]);
  else await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: rol })]);
  try { return await fn(); }
  finally { await db.exec(`reset role`); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}

export async function intentar(db, uid, q, params = [], opts = {}) {
  return como(db, uid, async () => {
    try { const r = await db.query(q, params); return { ok: true, rows: r.rows, n: r.affectedRows ?? r.rows.length }; }
    catch (e) { return { ok: false, error: e.message, code: e.code }; }
  }, opts);
}

if (process.argv[1] && process.argv[1].endsWith('sim.mjs') && !process.argv[1].endsWith('fake-supabase.mjs')) {
  const con = process.argv[2] === 'conPendientes';
  const db = await crearBase({ con01y02: con });
  await sembrar(db);
  const antes = (await db.query(`select id from public.pedidos order by id`)).rows;
  console.log('pedidos antes:', antes.map((r) => r.id).join(','));
  const archivo = sql10();
  for (let i = 1; i <= 2; i++) {
    try {
      const res = await db.exec(archivo);
      const ultimo = res[res.length - 1];
      console.log(`corrida ${i}:`);
      console.table(ultimo.rows.map((r) => ({ n: r.orden, estado: r.estado, verificacion: r.verificacion.slice(0, 90), detalle: r.detalle })));
    } catch (e) { console.log(`corrida ${i} FALLO:`, e.message); process.exit(1); }
  }
}
