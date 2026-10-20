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

export async function crearBase({ con01y02 = false } = {}) {
  const db = new PGlite();
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
