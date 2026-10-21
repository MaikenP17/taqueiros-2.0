/* =============================================================
   PRUEBAS DEL SQL 13 (supabase/13-endurecer.sql) Y DE SU REVERSA (13-revertir.sql)

     node pruebas/multirestaurante/endurecer.mjs                 todo (sin la revision por mutacion)
     node pruebas/multirestaurante/endurecer.mjs --mutaciones    ademas, la revision por mutacion (varios minutos)

   Postgres 16 real (PGlite) con los SQL 10, 11, 12 y 13; roles reales (anon, authenticated, service_role) y RLS.

     A. El SQL 13 corre dos veces (idempotente) y todas sus comprobaciones dan OK.
     B. COMPORTAMIENTO (la "sonda", que tambien usa la revision por mutacion):
          - defaults: ninguna tabla conserva el valor por defecto; un insert sin restaurante_id falla
          - validacion de config: configuraciones hostiles rechazadas, la de Taqueiros aceptada, sin repetir secretos
          - matriz de permisos: dueno / cajero / cocina / superadmin / servidor / sin membresia / anon sobre
            restaurantes, restaurante_secretos, restaurante_dominios, tarifas_domicilio, contadores_pedido,
            miembros, superadmins, configuracion, salud_notificaciones, pedidos, categorias y productos
     C. Lo mismo por REST directo con la sesion real de un dueno (PostgREST falso sobre la misma base).
     D. Escenarios: la migracion se detiene (y no cambia nada) si la config de Taqueiros no cumple las reglas o si una
        tabla tiene restaurante_id nulo; barre tablas desconocidas; la reversa; convivencia con el SQL 10.
     E. Propiedad: todo lo que la base acepta lo entrega el servidor (api/_publico.js) sin recortes ni cambios;
        las reglas del SQL = la tabla de la documentacion.
     F. (--mutaciones) cada defensa del SQL 13 se rompe a proposito y algo tiene que detectarlo.
============================================================= */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crearBase, sembrar, sql10, sql, intentar, U, REPO } from './sim.mjs';
import { levantar } from './fake-supabase.mjs';

const require = createRequire(import.meta.url);
const { CONFIG_TAQUEIROS } = require(`${REPO}/api/_respaldo-taqueiros.js`);
const PUB = require(`${REPO}/api/_publico.js`);

const TAQ = '00000000-0000-4000-8000-000000000001';
const OTRO = '55555555-5555-4555-8555-555555555555';
const usr = {
  dT: U.dueno_taq,
  cT: 'c1000000-0000-4000-8000-0000000000c1', kT: 'c1000000-0000-4000-8000-0000000000c2',
  dO: 'c1000000-0000-4000-8000-0000000000d1', sin: 'c1000000-0000-4000-8000-0000000000e1', sa: 'c1000000-0000-4000-8000-0000000000f1'
};
const REGLAS_JSON = process.env.REGLAS_JSON || path.join(os.tmpdir(), 'reglas-config-sql13.json');
const SQL13 = () => (process.env.SQL13_ARCHIVO ? fs.readFileSync(process.env.SQL13_ARCHIVO, 'utf8') : sql('13-endurecer.sql'));
const ultimo = (res) => res[res.length - 1];
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const clonar = (o) => JSON.parse(JSON.stringify(o));

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 600) });

async function baseConSql10a12() {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  await db.exec(sql('11-dominios.sql'));
  await db.exec(sql('12-config-publica.sql'));
  // Privilegios sueltos que alguien pudo dar a mano sobre las tablas privadas: el SQL 13 tiene que quitarlos
  await db.exec(`grant select, insert, update, delete on public.restaurante_secretos, public.contadores_pedido, public.restaurante_dominios, public.intentos_buscar_pedido to authenticated`);
  return db;
}

/* ============================================================
   B. LA SONDA DE COMPORTAMIENTO: devuelve la lista de lo que NO se cumple (vacia = todo bien)
============================================================ */
export async function sonda(db, { detalle = false } = {}) {
  const hallazgos = [];
  const T = (nombre, cond, info = '') => { if (detalle) resultados.push({ nombre, ok: !!cond, info: cond ? '' : String(info).slice(0, 500) }); if (!cond) hallazgos.push(nombre + (info && !detalle ? ' -> ' + String(info).slice(0, 160) : '')); };

  // ---- fixtures
  for (const id of Object.values(usr)) await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, id + '@t.test']);
  await db.query(`insert into public.restaurantes (id, slug, nombre) values ($1, 'otro-sonda', 'Otro sonda') on conflict do nothing`, [OTRO]);
  await db.exec(`
    insert into public.miembros (user_id, restaurante_id, rol) values
      ('${usr.cT}', '${TAQ}', 'cajero'), ('${usr.kT}', '${TAQ}', 'cocina'), ('${usr.dO}', '${OTRO}', 'dueno') on conflict do nothing;
    insert into public.superadmins (user_id) values ('${usr.sa}') on conflict do nothing;`);
  const cfg0 = (await db.query(`select config from public.restaurantes where id = $1`, [TAQ])).rows[0].config;
  const orig = (await db.query(`select * from public.restaurantes where id = $1`, [TAQ])).rows[0];
  const como = (quien, q, p = []) => {
    if (quien === 'anon') return intentar(db, null, q, p, { rol: 'anon' });
    if (quien === 'srv') return intentar(db, null, q, p, { rol: 'service_role' });
    return intentar(db, usr[quien], q, p, { rol: 'authenticated' });
  };
  const ok = (r) => r.ok;
  const ok1 = (r) => r.ok && r.n >= 1;
  const sinEfecto = (r) => !r.ok || r.n === 0;
  const err = (r, codigo) => !r.ok && (!codigo || r.code === codigo);
  const restaurar = async () => {   // deja la fila de Taqueiros como estaba (como el servidor)
    await db.query(`update public.restaurantes set nombre = $2, config = $3::jsonb, slug = $4, estado = $5, plan = $6, modalidad_pago = $7, vigente_hasta = $8,
                    dias_gracia = $9, modulos = $10::jsonb, zona_horaria = $11, hora_corte_jornada = $12 where id = $1`,
      [TAQ, orig.nombre, JSON.stringify(cfg0), orig.slug, orig.estado, orig.plan, orig.modalidad_pago, orig.vigente_hasta, orig.dias_gracia, JSON.stringify(orig.modulos), orig.zona_horaria, orig.hora_corte_jornada]);
  };
  const upd = (quien, sets, p = []) => como(quien, `update public.restaurantes set ${sets} where id = '${TAQ}'`, p);
  const conConfig = (fn) => { const c = clonar(cfg0); fn(c); return c; };
  const cfgJson = (c) => [JSON.stringify(c)];

  // ---- 1. valores por defecto
  const defaults = (await db.query(`select c.relname from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and a.atthasdef`)).rows;
  T('ninguna tabla de public conserva el valor por defecto de restaurante_id', defaults.length === 0, JSON.stringify(defaults));
  const notNull = (await db.query(`select c.relname from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p') and not a.attnotnull`)).rows;
  T('todas las tablas con restaurante_id siguen NOT NULL', notNull.length === 0, JSON.stringify(notNull));
  const fks = (await db.query(`select count(*)::int n from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.contype = 'f' and k.confrelid = 'public.restaurantes'::regclass and a.attname = 'restaurante_id' and k.conrelid::regclass::text in ('pedidos','categorias','productos','configuracion','salud_notificaciones')`)).rows[0].n;
  T('las 5 tablas de negocio siguen con la llave foranea a restaurantes', fks === 5, String(fks));

  const SIN = {
    pedidos: `insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago) values ('SONDA-SIN','nuevo','x','3000000000','local','[]',1,0,1,'pendiente')`,
    categorias: `insert into public.categorias (id, nombre) values ('sonda-sin','Sonda sin')`,
    productos: `insert into public.productos (id, nombre, precio, categoria) values ('sonda-sin','Sonda',1000,'bandejas')`,
    configuracion: `insert into public.configuracion (id, horarios) values (1, '{}'::jsonb)`,
    salud_notificaciones: `insert into public.salud_notificaciones (id) values (1)`
  };
  for (const [tabla, q] of Object.entries(SIN)) {
    for (const quien of ['srv', 'dT', 'sa']) {
      const r = await como(quien, q);
      T(`insert SIN restaurante_id en ${tabla} falla (${quien})`, err(r), JSON.stringify(r));
    }
  }
  const nuevoPedido = await como('srv', `insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago) values ('${TAQ}','SONDA-CON','nuevo','x','3000000000','local','[]',1,0,1,'pendiente') returning numero, restaurante_id`);
  T('el servidor inserta un pedido CON restaurante_id y recibe su numero', ok(nuevoPedido) && nuevoPedido.rows[0].restaurante_id === TAQ && Number(nuevoPedido.rows[0].numero) > 0, JSON.stringify(nuevoPedido));
  await db.exec(`delete from public.pedidos where referencia = 'SONDA-CON'`);

  // ---- 2. validacion de config (funcion pura y trigger)
  const errores = async (c) => (await db.query(`select public.config_restaurante_errores($1::jsonb) e`, [JSON.stringify(c)])).rows[0].e;
  T('la config actual de Taqueiros cumple las reglas', (await errores(cfg0)).length === 0, JSON.stringify(await errores(cfg0)));
  T('la config de respaldo del codigo (api/_respaldo-taqueiros.js) cumple las reglas', (await errores(CONFIG_TAQUEIROS)).length === 0, JSON.stringify(await errores(CONFIG_TAQUEIROS)));
  const b = (f) => { const c = clonar(CONFIG_TAQUEIROS); f(c); return c; };
  const largo = (n) => 'x '.repeat(Math.ceil(n / 2)).slice(0, n);
  const HOSTILES = {
    'clave desconocida en la raiz': { x: 1 }, 'clave desconocida en publico': { publico: { zzz: 1 } }, 'clave desconocida en marca': b((c) => { c.publico.marca.zzz = 'a'; }),
    'clave desconocida en colores': b((c) => { c.publico.marca.colores.rosa = '#FF00FF'; }), 'clave desconocida en textos': b((c) => { c.publico.textos.zzz = 'a'; }),
    'clave desconocida en seguimiento': b((c) => { c.publico.textos.seguimiento.zzz = 'a'; }), 'clave desconocida en contacto': b((c) => { c.publico.contacto.fax = '1234567'; }),
    'clave desconocida en domicilio': b((c) => { c.domicilio.zzz = 1; }), 'clave desconocida en area': b((c) => { c.domicilio.area.zzz = 1; }),
    'config no es objeto (arreglo)': [], 'config no es objeto (texto)': 'hola',
    'publico no es objeto': { publico: 'x' }, 'marca no es objeto': { publico: { marca: [] } }, 'textos no es objeto': { publico: { textos: 5 } },
    'color en palabras': b((c) => { c.publico.marca.colores.primario = 'red'; }), 'color corto (#FFF)': b((c) => { c.publico.marca.colores.primario = '#FFF'; }),
    'color con CSS inyectado': b((c) => { c.publico.marca.colores.primario = '#C1272D;background:url(x)'; }), 'color de 7 digitos': b((c) => { c.publico.marca.colores.acento = '#12345678'; }),
    'color sin #': b((c) => { c.publico.marca.colores.oscuro = 'C1272D'; }), 'color numerico': b((c) => { c.publico.marca.colores.oscuro = 123456; }),
    'zona de color invalida': b((c) => { c.publico.marca.colores_zonas = ['#FFFFFF', 'nope']; }), 'demasiadas zonas (9)': b((c) => { c.publico.marca.colores_zonas = Array(9).fill('#FFFFFF'); }),
    'colores_zonas no es lista': b((c) => { c.publico.marca.colores_zonas = '#FFFFFF'; }),
    'logo http': b((c) => { c.publico.marca.logo = 'http://x.supabase.co/storage/v1/object/public/productos/a.png'; }), 'logo javascript:': b((c) => { c.publico.marca.logo = 'javascript:alert(1)'; }),
    'logo con esquema sin parentesis (javascript:x)': b((c) => { c.publico.marca.logo = 'javascript:x'; }), 'icono con esquema (vbscript:x)': b((c) => { c.publico.marca.icono_512 = 'vbscript:x'; }),
    'logo data:': b((c) => { c.publico.marca.logo = 'data:image/png;base64,AAAA'; }), 'logo de otro dominio': b((c) => { c.publico.marca.logo = 'https://evil.example/x.png'; }),
    'logo https con usuario': b((c) => { c.publico.marca.logo = 'https://user:pass@x.supabase.co/storage/v1/object/public/productos/a.png'; }),
    'logo con ..': b((c) => { c.publico.marca.logo = '../secreto.png'; }), 'logo con //': b((c) => { c.publico.marca.logo = 'Recursos//logo.png'; }),
    'logo con ..': b((c) => { c.publico.marca.logo = 'Recursos/../x.png'; }), 'logo con espacio': b((c) => { c.publico.marca.logo = 'Recursos/mi logo.png'; }),
    'logo con comillas': b((c) => { c.publico.marca.logo = 'Recursos/a"onerror=x.png'; }), 'logo de 501 caracteres': b((c) => { c.publico.marca.logo = 'a'.repeat(501); }),
    'logo https del Storage fuera de /public/': b((c) => { c.publico.marca.logo = 'https://abcdefghij.supabase.co/rest/v1/restaurantes'; }),
    'icono https sin Supabase': b((c) => { c.publico.marca.icono_192 = 'https://cdn.example.com/i.png'; }),
    'tipografia fuera de la lista': b((c) => { c.publico.marca.tipografia = { titulos: 'Comic Sans' }; }),
    'tipografia con CSS': b((c) => { c.publico.marca.tipografia = { cuerpo: 'Anton;} body{display:none}' }; }), 'tipografia con URL': b((c) => { c.publico.marca.tipografia = { cuerpo: 'https://fonts.example/x.css' }; }),
    'tipografia en minusculas': b((c) => { c.publico.marca.tipografia = { titulos: 'anton' }; }), 'tipografia numerica': b((c) => { c.publico.marca.tipografia = { titulos: 5 }; }),
    'emoji de 9 caracteres': b((c) => { c.publico.marca.emoji = 'abcdefghi'; }),
    'HTML en eslogan': b((c) => { c.publico.textos.eslogan = '<b>hola</b>'; }), 'script en el titulo': b((c) => { c.publico.textos.titulo_pagina = '<script>alert(1)</script>'; }),
    'solo > en un texto': b((c) => { c.publico.textos.tagline = 'a > b'; }), 'solo < en un texto': b((c) => { c.publico.textos.tagline = 'a < b'; }),
    'HTML en contacto': b((c) => { c.publico.contacto.direccion = '<img src=x onerror=alert(1)>'; }), 'HTML en el seguimiento': b((c) => { c.publico.textos.seguimiento.frase_nuevo = '<i>x</i>'; }),
    'HTML en pwa': b((c) => { c.publico.pwa.nombre = '<b>x</b>'; }),
    'texto de 401 caracteres': b((c) => { c.publico.textos.eslogan = largo(401); }), 'texto de seguimiento de 201': b((c) => { c.publico.textos.seguimiento.tiempo_nuevo = largo(201); }),
    'direccion de 201': b((c) => { c.publico.contacto.direccion = largo(201); }), 'telefono de 41': b((c) => { c.publico.contacto.telefono = largo(41); }),
    'ciudad de 81': b((c) => { c.publico.contacto.ciudad = largo(81); }), 'pwa.nombre de 46': b((c) => { c.publico.pwa.nombre = largo(46); }), 'pwa.nombre_corto de 13': b((c) => { c.publico.pwa.nombre_corto = largo(13); }),
    'texto con salto de linea': b((c) => { c.publico.textos.eslogan = 'linea 1\nlinea 2'; }), 'texto con caracter de control': b((c) => { c.publico.textos.eslogan = 'a\u0001b'; }),
    'texto con ancho cero': b((c) => { c.publico.textos.eslogan = 'a' + String.fromCharCode(0x200b) + 'b'; }), 'texto con marca bidi': b((c) => { c.publico.textos.eslogan = 'a' + String.fromCharCode(0x202e) + 'b'; }),
    'texto numerico': b((c) => { c.publico.textos.eslogan = 123; }), 'texto nulo': b((c) => { c.publico.textos.eslogan = null; }), 'texto como objeto': b((c) => { c.publico.textos.eslogan = { a: 1 }; }),
    'un texto que es una clave larga': b((c) => { c.publico.textos.eslogan = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'; }),
    'whatsapp corto': b((c) => { c.publico.contacto.whatsapp = '12'; }), 'whatsapp con letras': b((c) => { c.publico.contacto.whatsapp = '57312abc4567'; }), 'whatsapp de 16 digitos': b((c) => { c.publico.contacto.whatsapp = '1234567890123456'; }),
    'instagram con espacio': b((c) => { c.publico.contacto.instagram = 'a b'; }), 'tiktok con @@': b((c) => { c.publico.contacto.tiktok = '@@a'; }), 'instagram de 61': b((c) => { c.publico.contacto.instagram = 'a'.repeat(61); }),
    'llave de Wompi de produccion en el campo de prueba': b((c) => { c.publico.wompi.llave_publica_test = 'pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW'; }),
    'llave de Wompi de prueba en el campo de produccion': b((c) => { c.publico.wompi.llave_publica_prod = 'pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz'; }),
    'llave PRIVADA de Wompi en la llave publica': b((c) => { c.publico.wompi.llave_publica_test = 'prv_test_abcdefghijklmnop'; }),
    'llave publica demasiado corta': b((c) => { c.publico.wompi.llave_publica_test = 'pub_test_abc'; }),
    'secreto prv_ en un texto': b((c) => { c.publico.textos.eslogan = 'prv_prod_abcdefghijkl'; }), 'secreto sb_secret_ en un texto': b((c) => { c.publico.textos.eslogan = 'sb_secret_abcdefghijkl'; }),
    'llave publishable en un texto': b((c) => { c.publico.textos.eslogan = 'sb_publishable_abcdefghijkl'; }),
    'secreto test_integrity_': b((c) => { c.publico.textos.eslogan = 'test_integrity_abcdefg'; }), 'secreto prod_integrity_': b((c) => { c.publico.textos.eslogan = 'prod_integrity_abcdefg'; }),
    'secreto test_events_': b((c) => { c.publico.textos.eslogan = 'test_events_abcdefg'; }), 'secreto prod_events_': b((c) => { c.publico.textos.eslogan = 'prod_events_abcdefg'; }),
    'secreto en mayusculas': b((c) => { c.publico.textos.eslogan = 'PRV_PROD_ABCDEFGH'; }), 'la palabra apikey': b((c) => { c.publico.textos.eslogan = 'mi apikey es 123'; }),
    'un JWT': b((c) => { c.publico.textos.eslogan = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'; }), 'una llave PEM': b((c) => { c.publico.textos.eslogan = '-----BEGIN PRIVATE KEY-----'; }),
    'secreto dentro del logo': b((c) => { c.publico.marca.logo = 'Recursos/prv_prod_abcdefgh.png'; }),
    'secreto dentro de una zona de color': b((c) => { c.publico.marca.colores_zonas = ['sb_secret_abcdefgh']; }),
    'clave que parece secreto (apikey)': b((c) => { c.publico.contacto.apikey = '1234567'; }), 'clave que parece secreto (secreto)': { secreto: 'x' },
    'clave que parece secreto (token)': { publico: { token: 'x' } }, 'clave que parece secreto (password)': b((c) => { c.publico.contacto.password = 'x'; }),
    'clave que parece secreto (service_role)': { service_role: 'x' }, 'clave que parece secreto anidada en un arreglo': b((c) => { c.publico.marca.colores_zonas = [{ secret: 1 }]; }),
    'latitud 91': b((c) => { c.ubicacion.lat = 91; }), 'latitud -91': b((c) => { c.ubicacion.lat = -91; }), 'longitud 181': b((c) => { c.ubicacion.lng = 181; }),
    'latitud como texto': b((c) => { c.ubicacion.lat = '7.89'; }), 'ubicacion sin lng': { ubicacion: { lat: 7.5 } }, 'ubicacion no es objeto': { ubicacion: [7.5, -72] },
    'factor de recorrido 99': b((c) => { c.domicilio.factor_recorrido = 99; }), 'factor de recorrido 0.5': b((c) => { c.domicilio.factor_recorrido = 0.5; }), 'factor de recorrido negativo': b((c) => { c.domicilio.factor_recorrido = -1; }),
    'factor de recorrido como texto': b((c) => { c.domicilio.factor_recorrido = '1.3'; }), 'pin minimo negativo': b((c) => { c.domicilio.pin_minimo_metros = -5; }), 'pin minimo 5001': b((c) => { c.domicilio.pin_minimo_metros = 5001; }),
    'area con latMin > latMax': b((c) => { c.domicilio.area.latMin = 9; }), 'area con lngMin > lngMax': b((c) => { c.domicilio.area.lngMin = -70; }), 'area fuera de rango': b((c) => { c.domicilio.area.latMax = 95; }),
    'config enorme (>20000)': b((c) => { c.publico.textos.eslogan = 'ok'; c.publico.marca.colores_zonas = Array(8).fill('#FFFFFF'); c.padding = 'x'.repeat(20000); })
  };
  const noRechazadas = [];
  for (const [nombre, c] of Object.entries(HOSTILES)) if ((await errores(c)).length === 0) noRechazadas.push(nombre);
  T(`la validacion rechaza las ${Object.keys(HOSTILES).length} configuraciones hostiles de prueba`, noRechazadas.length === 0, 'NO rechazadas: ' + noRechazadas.join(' | '));

  const VALIDAS = {
    'vacia': {}, 'solo textos': { publico: { textos: { eslogan: 'Tacos' } } }, 'la de Taqueiros': CONFIG_TAQUEIROS,
    'colores en minusculas y mayusculas': b((c) => { c.publico.marca.colores.primario = '#c1272d'; c.publico.marca.colores.acento = '#E3a008'; }),
    'logo del sitio con barra inicial': b((c) => { c.publico.marca.logo = '/Recursos/logo/logo.png'; }),
    'logo https del Storage de Supabase': b((c) => { c.publico.marca.logo = 'https://abcdefghij.supabase.co/storage/v1/object/public/productos/00000000-0000-4000-8000-000000000001/logo.webp'; }),
    'texto de 400 y de 200 exactos': b((c) => { c.publico.textos.eslogan = largo(400); c.publico.textos.seguimiento.tiempo_nuevo = largo(200); }),
    'emoji de 8': b((c) => { c.publico.marca.emoji = 'abcdefgh'; }), 'ocho zonas de color': b((c) => { c.publico.marca.colores_zonas = Array(8).fill('#5C7A3B'); }),
    'whatsapp con +, espacios y parentesis': b((c) => { c.publico.contacto.whatsapp = '+57 (312) 524-9438'; }),
    'instagram con @': b((c) => { c.publico.contacto.instagram = '@lostaqueiros.co'; }),
    'las 16 tipografias': null, 'latitud y longitud en el borde': b((c) => { c.ubicacion = { lat: -90, lng: 180 }; }),
    'factor 1 y 3': b((c) => { c.domicilio.factor_recorrido = 3; c.domicilio.pin_minimo_metros = 0; }),
    'texto con tildes, enies y signos': b((c) => { c.publico.textos.eslogan = 'Ay, niño: ¿qué tal? ¡Pídelo ya! 🌮 {cierre}'; })
  };
  for (const f of ['Anton', 'Bebas Neue', 'Oswald', 'Montserrat', 'Poppins', 'Playfair Display', 'Fredoka', 'Lora', 'Merriweather', 'Libre Franklin', 'Open Sans', 'Nunito', 'Lato', 'DM Sans', 'Work Sans', 'Source Sans 3']) {
    VALIDAS['tipografia ' + f] = b((c) => { c.publico.marca.tipografia = { titulos: f, cuerpo: f }; });
  }
  delete VALIDAS['las 16 tipografias'];
  const rechazadasValidas = [];
  for (const [nombre, c] of Object.entries(VALIDAS)) { const e = await errores(c); if (e.length) rechazadasValidas.push(nombre + ': ' + e.join(',')); }
  T(`la validacion acepta las ${Object.keys(VALIDAS).length} configuraciones validas de prueba (incluye las 16 tipografias)`, rechazadasValidas.length === 0, rechazadasValidas.join(' | '));
  const eSecreto = await errores(b((c) => { c.publico.textos.eslogan = 'prv_prod_ELSECRETOMUYSECRETO99'; }));
  T('los mensajes de error NO repiten el valor recibido (podria ser un secreto)', eSecreto.length > 0 && !JSON.stringify(eSecreto).includes('ELSECRETOMUYSECRETO99'), JSON.stringify(eSecreto));
  T('los mensajes de error dicen la ruta del campo', eSecreto.some((m) => m.startsWith('publico.textos.eslogan:')), JSON.stringify(eSecreto));

  const eClave = await errores({ publico: { contacto: { apikey: '1234567' } } });
  T('una clave con nombre de secreto se rechaza con un mensaje que lo dice (ademas de ser clave desconocida)', eClave.some((m) => m.startsWith('publico.contacto.apikey:') && /parece de un secreto/.test(m)), JSON.stringify(eClave));
  const eClave2 = await errores({ secret_key: 'x' });
  T('... tambien en la raiz (secret_key)', eClave2.some((m) => /parece de un secreto/.test(m)), JSON.stringify(eClave2));

  // trigger: aplica a TODOS (servidor, superadmin, dueno) y en INSERT
  const hostil = JSON.stringify({ publico: { textos: { eslogan: '<script>x</script>' } } });
  for (const quien of ['srv', 'sa', 'dT']) {
    const r = await como(quien, `update public.restaurantes set config = $1::jsonb where id = '${TAQ}'`, [quien === 'dT' ? JSON.stringify(conConfig((c) => { c.publico.textos.eslogan = '<script>x</script>'; })) : hostil]);
    T(`el trigger rechaza una config hostil en un UPDATE (${quien}) con 23514`, err(r, '23514'), JSON.stringify(r));
  }
  const rIns = await como('srv', `insert into public.restaurantes (slug, nombre, config) values ('sonda-hostil', 'Sonda', '{"secreto":"x"}'::jsonb)`);
  T('el trigger rechaza una config hostil en un INSERT (servidor) con 23514', err(rIns, '23514'), JSON.stringify(rIns));
  const rIns2 = await como('sa', `insert into public.restaurantes (slug, nombre, config) values ('sonda-hostil', 'Sonda', '{"secreto":"x"}'::jsonb)`);
  T('el trigger rechaza una config hostil en un INSERT (superadmin) con 23514', err(rIns2, '23514'), JSON.stringify(rIns2));
  const rInsOk = await como('srv', `insert into public.restaurantes (slug, nombre, config) values ('sonda-valido', 'Sonda valido', '{"publico":{"textos":{"eslogan":"Hola"}}}'::jsonb) returning id`);
  T('el trigger acepta una config valida en un INSERT y el alta crea sus filas', ok(rInsOk) && (await db.query(`select (select count(*) from public.configuracion where restaurante_id = $1) c, (select count(*) from public.contadores_pedido where restaurante_id = $1) k`, [rInsOk.rows[0].id])).rows[0].c == 1, JSON.stringify(rInsOk));
  if (ok(rInsOk)) {
    for (const t of ['configuracion', 'salud_notificaciones']) await db.query(`delete from public.${t} where restaurante_id = $1`, [rInsOk.rows[0].id]);
    await db.query(`delete from public.restaurantes where id = $1`, [rInsOk.rows[0].id]);
  }
  T('la config de Taqueiros no cambio con los intentos hostiles', JSON.stringify(canon((await db.query(`select config from public.restaurantes where id = $1`, [TAQ])).rows[0].config)) === JSON.stringify(canon(cfg0)), '');
  const sinTocar = await como('srv', `update public.restaurantes set estado = 'activo' where id = '${TAQ}'`);
  T('un UPDATE que no toca la config no la valida (un cambio de estado no se frena por una config vieja)', ok(sinTocar), JSON.stringify(sinTocar));
  try {
    await db.exec('alter table public.restaurantes disable trigger restaurantes_validar_config');
    await db.query(`update public.restaurantes set config = '{"viejo":true}'::jsonb where id = $1`, [OTRO]);
    await db.exec('alter table public.restaurantes enable trigger restaurantes_validar_config');
    const susp = await como('srv', `update public.restaurantes set estado = 'suspendido' where id = '${OTRO}'`);
    T('suspender un restaurante cuya config guardada es invalida (de antes) NO se frena (el servidor puede suspender)', ok1(susp), JSON.stringify(susp));
    const toca = await como('srv', `update public.restaurantes set config = '{"viejo":false}'::jsonb, estado = 'activo' where id = '${OTRO}'`);
    T('... pero si el UPDATE toca la config, se valida y se rechaza', err(toca, '23514'), JSON.stringify(toca));
    await db.exec('alter table public.restaurantes disable trigger restaurantes_validar_config');
    await db.query(`update public.restaurantes set config = '{}'::jsonb, estado = 'prueba' where id = $1`, [OTRO]);
    await db.exec('alter table public.restaurantes enable trigger restaurantes_validar_config');
  } catch (e) { T('la prueba de config vieja pudo correr (necesita el trigger restaurantes_validar_config)', false, e.message); }

  // ---- 3. dueno sobre su restaurante
  for (const [col, val] of [['id', `'${OTRO}'`], ['slug', "'otro-slug'"], ['estado', "'suspendido'"], ['plan', "'basico'"], ['modalidad_pago', "'unico'"], ['vigente_hasta', "'2031-01-01'"],
    ['dias_gracia', '99'], ['modulos', `'{"pasarela":false}'::jsonb`], ['zona_horaria', "'Europe/Madrid'"], ['hora_corte_jornada', "'07:00'"], ['creado_en', "'2000-01-01'"]]) {
    const r = await upd('dT', `${col} = ${val}`);
    T(`el dueno NO puede cambiar ${col} (42501)`, err(r, '42501'), JSON.stringify(r));
    const r2 = await upd('dT', `nombre = 'Otro nombre', ${col} = ${val}`);
    T(`el dueno NO cambia ${col} aunque lo mezcle con el nombre`, err(r2, '42501'), JSON.stringify(r2));
  }
  T('despues de los intentos del dueno, plan/estado/vigencia/modulos/slug siguen iguales', (() => true)());
  const tras = (await db.query(`select slug, estado, plan, modalidad_pago, vigente_hasta, dias_gracia, modulos, zona_horaria, hora_corte_jornada, creado_en, id from public.restaurantes where id = $1`, [TAQ])).rows[0];
  T('... (verificado en la tabla)', tras.slug === orig.slug && tras.estado === orig.estado && tras.plan === orig.plan && tras.dias_gracia === orig.dias_gracia
    && JSON.stringify(tras.modulos) === JSON.stringify(orig.modulos) && tras.zona_horaria === orig.zona_horaria && String(tras.vigente_hasta) === String(orig.vigente_hasta) && tras.id === TAQ, JSON.stringify(tras));

  let r = await upd('dT', `nombre = 'Nombre nuevo'`);
  T('el dueno SI cambia el nombre', ok1(r), JSON.stringify(r));
  for (const [que, nombre] of [['con HTML', '<b>x</b>'], ['con >', 'a > b'], ['vacio', '   '], ['de 121 caracteres', 'n'.repeat(121)], ['con salto de linea', 'a\nb']]) {
    r = await upd('dT', `nombre = $1`, [nombre]);
    T(`el dueno NO pone un nombre ${que}`, err(r), JSON.stringify(r));
  }
  r = await upd('dT', `nombre = $1`, ['n'.repeat(120)]);
  T('el dueno SI pone un nombre de 120 caracteres', ok1(r), JSON.stringify(r));
  await restaurar();

  const PERMITIDAS = {
    'cambiar el eslogan': conConfig((c) => { c.publico.textos.eslogan = 'Nuevo eslogan'; }),
    'cambiar el telefono': conConfig((c) => { c.publico.contacto.telefono = '300 111 2233'; }),
    'agregar un campo de contacto (tiktok)': conConfig((c) => { c.publico.contacto.tiktok = 'otro_usuario'; }),
    'quitar un texto': conConfig((c) => { delete c.publico.textos.tagline; }),
    'agregar un texto del seguimiento': conConfig((c) => { c.publico.textos.seguimiento.frase_nuevo = 'Listo'; }),
    'cambiar WhatsApp': conConfig((c) => { c.publico.contacto.whatsapp = '573001112233'; }),
    'reescribir la misma config (no-op)': conConfig(() => {})
  };
  for (const [nombre, c] of Object.entries(PERMITIDAS)) {
    r = await upd('dT', `config = $1::jsonb`, cfgJson(c));
    T(`el dueno SI puede ${nombre}`, ok1(r), JSON.stringify(r));
    await restaurar();
  }
  const PROHIBIDAS = {
    'el color primario': conConfig((c) => { c.publico.marca.colores.primario = '#000000'; }), 'el logo': conConfig((c) => { c.publico.marca.logo = 'Recursos/otro.png'; }),
    'el emoji de la marca': conConfig((c) => { c.publico.marca.emoji = 'X'; }), 'la tipografia': conConfig((c) => { c.publico.marca.tipografia = { titulos: 'Anton' }; }),
    'borrar toda la marca': conConfig((c) => { delete c.publico.marca; }), 'las zonas de color': conConfig((c) => { c.publico.marca.colores_zonas = ['#FFFFFF']; }),
    'la ubicacion': conConfig((c) => { c.ubicacion.lat = 7.5; }), 'borrar la ubicacion': conConfig((c) => { delete c.ubicacion; }),
    'el factor de recorrido': conConfig((c) => { c.domicilio.factor_recorrido = 2; }), 'el area de cobertura': conConfig((c) => { c.domicilio.area.latMax = 8.0; }),
    'las llaves publicas de Wompi': conConfig((c) => { c.publico.wompi.llave_publica_test = 'pub_test_ZZZZZZZZZZZZZZZZZZZZ'; }),
    'borrar las llaves de Wompi': conConfig((c) => { delete c.publico.wompi; }), 'el nombre de la PWA': conConfig((c) => { c.publico.pwa.nombre = 'Otro'; }),
    'agregar una clave nueva en la raiz': conConfig((c) => { c.extra = 1; }), 'vaciar la config': {},
    'agregar una clave nueva en publico': conConfig((c) => { c.publico.nuevo = {}; }),
    'cambiar texto Y marca a la vez': conConfig((c) => { c.publico.textos.eslogan = 'x'; c.publico.marca.colores.primario = '#000000'; }),
    'publico como texto': conConfig((c) => { c.publico = 'x'; }), 'publico como arreglo': conConfig((c) => { c.publico = []; })
  };
  for (const [nombre, c] of Object.entries(PROHIBIDAS)) {
    r = await upd('dT', `config = $1::jsonb`, cfgJson(c));
    T(`el dueno NO puede cambiar ${nombre}`, err(r), JSON.stringify(r));
  }
  T('despues de los intentos prohibidos, la config no cambio', JSON.stringify(canon((await db.query(`select config from public.restaurantes where id = $1`, [TAQ])).rows[0].config)) === JSON.stringify(canon(cfg0)), '');
  for (const [nombre, c] of Object.entries({
    'HTML en un texto': conConfig((c) => { c.publico.textos.eslogan = '<b>x</b>'; }), 'un secreto en un texto': conConfig((c) => { c.publico.textos.eslogan = 'prv_prod_abcdefghijkl'; }),
    'un texto de 401': conConfig((c) => { c.publico.textos.eslogan = largo(401); }), 'WhatsApp invalido': conConfig((c) => { c.publico.contacto.whatsapp = 'hola'; }),
    'una clave desconocida en textos': conConfig((c) => { c.publico.textos.zzz = 'a'; }), 'un salto de linea en un texto': conConfig((c) => { c.publico.textos.eslogan = 'a\nb'; })
  })) {
    r = await upd('dT', `config = $1::jsonb`, cfgJson(c));
    T(`el dueno, dentro de su zona permitida, NO guarda ${nombre} (23514)`, err(r, '23514'), JSON.stringify(r));
  }
  r = await upd('dT', `nombre = 'Otro' , config = $1::jsonb`, cfgJson(conConfig((c) => { c.publico.textos.eslogan = 'Mixto'; })));
  T('el dueno cambia nombre y textos en la misma sentencia', ok1(r), JSON.stringify(r));
  await restaurar();

  // un dueno cuyo restaurante todavia no tiene "publico" puede agregar sus textos (y solo eso)
  r = await como('dO', `update public.restaurantes set config = '{"publico":{"textos":{"eslogan":"Hola"}}}'::jsonb where id = '${OTRO}'`);
  T('el dueno de un restaurante con config vacia SI agrega sus textos (publico.textos)', ok1(r), JSON.stringify(r));
  r = await como('dO', `update public.restaurantes set config = '{"publico":{"textos":{"eslogan":"Hola"},"contacto":{"telefono":"300"}}}'::jsonb where id = '${OTRO}'`);
  T('... y su contacto (publico.contacto)', ok1(r), JSON.stringify(r));
  r = await como('dO', `update public.restaurantes set config = '{"publico":{"textos":{"eslogan":"Hola"},"marca":{"emoji":"X"}}}'::jsonb where id = '${OTRO}'`);
  T('... pero NO la marca', err(r, '42501'), JSON.stringify(r));
  r = await como('dO', `update public.restaurantes set config = '{"ubicacion":{"lat":1,"lng":1}}'::jsonb where id = '${OTRO}'`);
  T('... ni la ubicacion', err(r, '42501'), JSON.stringify(r));
  await db.exec('alter table public.restaurantes disable trigger restaurantes_validar_config');
  await db.query(`update public.restaurantes set config = '{}'::jsonb where id = $1`, [OTRO]);
  await db.exec('alter table public.restaurantes enable trigger restaurantes_validar_config');

  // otros roles sobre restaurantes
  for (const quien of ['cT', 'kT', 'dO', 'sin']) {
    r = await upd(quien, `nombre = 'Hack'`);
    T(`${quien}: no cambia el restaurante de Taqueiros (0 filas)`, sinEfecto(r), JSON.stringify(r));
    r = await como(quien, `delete from public.restaurantes where id = '${TAQ}'`);
    T(`${quien}: no borra el restaurante de Taqueiros`, sinEfecto(r), JSON.stringify(r));
  }
  r = await upd('anon', `nombre = 'Hack'`);
  T('anon no toca restaurantes (permiso denegado)', err(r, '42501'), JSON.stringify(r));
  r = await como('dT', `insert into public.restaurantes (slug, nombre) values ('hack-1', 'Hack')`);
  T('el dueno NO crea restaurantes', err(r, '42501'), JSON.stringify(r));
  r = await como('dT', `delete from public.restaurantes where id = '${TAQ}'`);
  T('el dueno NO borra su restaurante', sinEfecto(r), JSON.stringify(r));
  r = await como('dT', `select id from public.restaurantes`);
  T('el dueno ve solo su restaurante', ok(r) && r.rows.length === 1 && r.rows[0].id === TAQ, JSON.stringify(r));
  r = await como('sa', `select id from public.restaurantes`);
  T('el superadmin ve todos los restaurantes', ok(r) && r.rows.length >= 2, JSON.stringify(r));

  // superadmin y servidor: pueden todo lo comercial; la validacion los alcanza igual
  for (const quien of ['sa', 'srv']) {
    for (const [col, val] of [['plan', "'basico'"], ['estado', "'prueba'"], ['vigente_hasta', "'2031-01-01'"], ['modulos', `'{"pasarela":false,"seguimiento":true,"comandas":true,"impresion":true}'::jsonb`],
      ['dias_gracia', '9'], ['modalidad_pago', "'unico'"], ['zona_horaria', "'America/Bogota'"], ['hora_corte_jornada', "'06:00'"]]) {
      r = await upd(quien, `${col} = ${val}`);
      T(`${quien} SI cambia ${col}`, ok1(r), JSON.stringify(r));
    }
    r = await upd(quien, `slug = 'taqueiros-nuevo'`); T(`${quien} SI cambia el slug`, ok1(r), JSON.stringify(r));
    r = await upd(quien, `config = $1::jsonb`, cfgJson(conConfig((c) => { c.publico.marca.colores.primario = '#112233'; c.ubicacion.lat = 7.5; c.domicilio.factor_recorrido = 1.5; })));
    T(`${quien} SI cambia marca, ubicacion y domicilio (con valores validos)`, ok1(r), JSON.stringify(r));
    await restaurar();
  }

  // ---- 4. tablas privadas: nadie salvo el servidor
  for (const [tabla, ins, upda, del] of [
    ['restaurante_secretos', `insert into public.restaurante_secretos (restaurante_id) values ('${OTRO}')`, `update public.restaurante_secretos set callmebot_apikey = 'x'`, `delete from public.restaurante_secretos`],
    ['restaurante_dominios', `insert into public.restaurante_dominios (host, restaurante_id) values ('hack.test', '${TAQ}')`, `update public.restaurante_dominios set host = 'hack.test'`, `delete from public.restaurante_dominios`],
    ['contadores_pedido', `insert into public.contadores_pedido (restaurante_id, ultimo) values ('${OTRO}', 5)`, `update public.contadores_pedido set ultimo = 0`, `delete from public.contadores_pedido`],
    ['intentos_buscar_pedido', `insert into public.intentos_buscar_pedido (restaurante_id, telefono) values ('${TAQ}', '3')`, `update public.intentos_buscar_pedido set telefono = '4'`, `delete from public.intentos_buscar_pedido`],
    ['personal', `insert into public.personal (id) values ('${usr.sin}')`, `update public.personal set id = id`, `delete from public.personal`]
  ]) {
    for (const quien of ['dT', 'cT', 'kT', 'sin', 'sa', 'anon']) {
      for (const [que, q] of [['lee', `select * from public.${tabla}`], ['inserta en', ins], ['actualiza', upda], ['borra de', del]]) {
        r = await como(quien, q);
        T(`${quien} NO ${que} ${tabla} (permiso denegado)`, err(r, '42501'), JSON.stringify(r).slice(0, 140));
      }
    }
    r = await como('srv', `select count(*)::int n from public.${tabla}`);
    T(`el servidor SI lee ${tabla}`, ok(r), JSON.stringify(r));
  }
  r = await como('dT', `update public.pedidos set numero = 9999 where restaurante_id = '${TAQ}'`);
  T('el dueno no puede cambiar el numero de un pedido (los contadores son del servidor)', !r.ok || r.n === 0, JSON.stringify(r));

  // ---- 5. miembros y superadmins
  r = await como('dT', `select user_id from public.miembros`);
  T('el dueno solo ve su propia fila de miembros', ok(r) && r.rows.length === 1 && r.rows[0].user_id === usr.dT, JSON.stringify(r));
  r = await como('cT', `select user_id from public.miembros`);
  T('el cajero solo ve su propia fila de miembros', ok(r) && r.rows.length === 1 && r.rows[0].user_id === usr.cT, JSON.stringify(r));
  r = await como('dT', `insert into public.miembros (user_id, restaurante_id, rol) values ('${usr.sin}', '${TAQ}', 'dueno')`);
  T('el dueno NO agrega miembros (ni siquiera a su restaurante)', err(r, '42501'), JSON.stringify(r));
  r = await como('dT', `update public.miembros set rol = 'dueno' where user_id = '${usr.cT}'`);
  T('el dueno NO sube de rol a otro miembro', sinEfecto(r), JSON.stringify(r));
  r = await como('cT', `update public.miembros set rol = 'dueno' where user_id = '${usr.cT}'`);
  T('el cajero NO se sube a si mismo a dueno', sinEfecto(r), JSON.stringify(r));
  r = await como('dT', `delete from public.miembros where user_id = '${usr.cT}'`);
  T('el dueno NO borra miembros', sinEfecto(r), JSON.stringify(r));
  r = await como('sin', `insert into public.miembros (user_id, restaurante_id, rol) values ('${usr.sin}', '${TAQ}', 'dueno')`);
  T('un usuario sin membresia NO se agrega a si mismo', err(r, '42501'), JSON.stringify(r));
  r = await como('sa', `insert into public.miembros (user_id, restaurante_id, rol) values ('${usr.sin}', '${OTRO}', 'cajero') returning user_id`);
  T('el superadmin SI agrega miembros', ok(r), JSON.stringify(r));
  await db.query(`delete from public.miembros where user_id = $1 and restaurante_id = $2`, [usr.sin, OTRO]);
  r = await como('dT', `insert into public.superadmins (user_id) values ('${usr.dT}')`);
  T('el dueno NO se hace superadmin', err(r, '42501'), JSON.stringify(r));
  r = await como('dT', `select * from public.superadmins`);
  T('el dueno no ve ningun superadmin', ok(r) && r.rows.length === 0, JSON.stringify(r));
  r = await como('sa', `select * from public.superadmins`);
  T('el superadmin ve solo su propia fila', ok(r) && r.rows.length === 1, JSON.stringify(r));
  r = await como('sa', `insert into public.superadmins (user_id) values ('${usr.sin}')`);
  T('ni el superadmin escribe superadmins desde el navegador', err(r, '42501'), JSON.stringify(r));

  // ---- 6. configuracion
  const cfgFila = (await db.query(`select * from public.configuracion where restaurante_id = $1`, [TAQ])).rows[0];
  for (const [col, val] of [['cerrado_temporal', 'true'], ['horarios', `'[]'::jsonb`], ['mensaje_cerrado', "'Cerrado por hoy'"]]) {
    r = await como('dT', `update public.configuracion set ${col} = ${val} where restaurante_id = '${TAQ}'`);
    T(`el dueno SI cambia configuracion.${col} (lo que escribe el panel)`, ok1(r), JSON.stringify(r));
  }
  r = await como('dT', `update public.configuracion set cerrado_temporal = false, horarios = $1::jsonb, mensaje_cerrado = null where restaurante_id = '${TAQ}'`, [JSON.stringify(cfgFila.horarios)]);
  T('el dueno restaura el interruptor, el horario y el mensaje juntos', ok1(r), JSON.stringify(r));
  for (const [col, val] of [['hora_corte_jornada', "'07:00'"], ['minutos_ocultar_terminados', '999'], ['id', '77'], ['restaurante_id', `'${OTRO}'`]]) {
    r = await como('dT', `update public.configuracion set ${col} = ${val} where restaurante_id = '${TAQ}'`);
    T(`el dueno NO cambia configuracion.${col} (42501)`, err(r, '42501'), JSON.stringify(r));
    r = await como('dT', `update public.configuracion set cerrado_temporal = false, ${col} = ${val} where restaurante_id = '${TAQ}'`);
    T(`el dueno NO cambia configuracion.${col} aunque lo mezcle con lo permitido`, err(r, '42501'), JSON.stringify(r));
  }
  r = await como('cT', `update public.configuracion set cerrado_temporal = true where restaurante_id = '${TAQ}'`);
  T('el cajero no cambia la configuracion', sinEfecto(r), JSON.stringify(r));
  r = await como('dT', `insert into public.configuracion (restaurante_id, id, horarios) values ('${OTRO}', 5, '{}'::jsonb)`);
  T('el dueno no inserta configuracion', err(r, '42501'), JSON.stringify(r));
  r = await como('dT', `delete from public.configuracion where restaurante_id = '${TAQ}'`);
  T('el dueno no borra la configuracion', sinEfecto(r), JSON.stringify(r));
  for (const quien of ['sa', 'srv']) {
    r = await como(quien, `update public.configuracion set hora_corte_jornada = '06:30', minutos_ocultar_terminados = 77 where restaurante_id = '${TAQ}'`);
    T(`${quien} SI cambia hora_corte_jornada y minutos_ocultar_terminados (cambio real)`, ok1(r) && (await db.query(`select hora_corte_jornada::text h, minutos_ocultar_terminados m from public.configuracion where restaurante_id = $1`, [TAQ])).rows[0].m === 77, JSON.stringify(r));
    r = await como(quien, `update public.configuracion set hora_corte_jornada = '${cfgFila.hora_corte_jornada}', minutos_ocultar_terminados = ${cfgFila.minutos_ocultar_terminados} where restaurante_id = '${TAQ}'`);
    T(`${quien} SI restaura hora_corte_jornada y minutos_ocultar_terminados`, ok1(r), JSON.stringify(r));
  }
  r = await como('dO', `update public.configuracion set cerrado_temporal = true where restaurante_id = '${TAQ}'`);
  T('el dueno de otro restaurante no toca la configuracion de Taqueiros', sinEfecto(r), JSON.stringify(r));

  // ---- 7. tarifas_domicilio
  r = await como('dT', `select * from public.tarifas_domicilio`);
  T('el dueno SI lee sus tarifas (5)', ok(r) && r.rows.length === 5, JSON.stringify(r).slice(0, 100));
  r = await como('cT', `select * from public.tarifas_domicilio`);
  T('el cajero SI lee las tarifas', ok(r) && r.rows.length === 5, JSON.stringify(r).slice(0, 100));
  r = await como('kT', `select * from public.tarifas_domicilio`);
  T('cocina no lee las tarifas', ok(r) && r.rows.length === 0, JSON.stringify(r).slice(0, 100));
  for (const quien of ['dT', 'cT']) {
    r = await como(quien, `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${TAQ}', 10, 15000)`);
    T(`${quien} NO inserta tarifas (42501)`, err(r, '42501'), JSON.stringify(r));
    r = await como(quien, `update public.tarifas_domicilio set precio = 1 where restaurante_id = '${TAQ}'`);
    T(`${quien} NO actualiza tarifas`, sinEfecto(r), JSON.stringify(r));
    r = await como(quien, `delete from public.tarifas_domicilio where restaurante_id = '${TAQ}'`);
    T(`${quien} NO borra tarifas`, sinEfecto(r), JSON.stringify(r));
  }
  T('las 5 tarifas de Taqueiros siguen intactas', (await db.query(`select count(*)::int n, sum(precio)::int s from public.tarifas_domicilio where restaurante_id = $1`, [TAQ])).rows[0].s === 33000, '');
  r = await como('sa', `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${OTRO}', 3, 4000) returning id`);
  T('el superadmin SI escribe tarifas', ok(r), JSON.stringify(r));
  r = await como('srv', `update public.tarifas_domicilio set precio = 4500 where restaurante_id = '${OTRO}' and hasta = 3`);
  T('el servidor SI escribe tarifas', ok1(r), JSON.stringify(r));
  for (const [que, v] of [['hasta 0', '0, 1000'], ['hasta negativo', '-1, 1000'], ['hasta 1001', '1001, 1000'], ['precio negativo', '5, -1'], ['precio 500001', '5, 500001']]) {
    r = await como('srv', `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${OTRO}', ${v})`);
    T(`tarifas: ${que} se rechaza (23514), tambien al servidor`, err(r, '23514') || (v.startsWith('-1') && err(r)), JSON.stringify(r));
  }
  for (const [que, v] of [['hasta 1000 y precio 500000', '1000, 500000'], ['precio vacio (fuera de cobertura)', '5, null'], ['precio 0 (gratis)', '6, 0']]) {
    r = await como('srv', `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${OTRO}', ${v})`);
    T(`tarifas: ${que} se acepta`, ok(r), JSON.stringify(r));
  }
  r = await como('srv', `update public.tarifas_domicilio set precio = 999999 where restaurante_id = '${OTRO}' and hasta = 3`);
  T('tarifas: un UPDATE a un precio fuera de rango tambien se rechaza', err(r, '23514'), JSON.stringify(r));
  await db.query(`delete from public.tarifas_domicilio where restaurante_id = $1`, [OTRO]);

  // ---- 8. salud
  r = await como('dT', `select * from public.salud_notificaciones`);
  T('el dueno lee la salud de las notificaciones', ok(r) && r.rows.length === 1, JSON.stringify(r).slice(0, 100));
  r = await como('dT', `update public.salud_notificaciones set fallos_seguidos = 9`);
  T('el dueno no escribe la salud', sinEfecto(r), JSON.stringify(r));
  r = await como('dT', `insert into public.salud_notificaciones (restaurante_id, id) values ('${OTRO}', 3)`);
  T('el dueno no inserta salud', err(r, '42501'), JSON.stringify(r));

  // ---- 9. el resto de los flujos siguen funcionando con restaurante_id explicito
  r = await como('dT', `insert into public.categorias (restaurante_id, id, nombre, emoji, orden) values ('${TAQ}', 'sonda-cat', 'Sonda cat', 'X', 99) returning restaurante_id`);
  T('menu-admin: el dueno inserta una categoria con restaurante_id explicito', ok(r), JSON.stringify(r));
  r = await como('dT', `insert into public.productos (restaurante_id, id, nombre, precio, categoria, orden, disponible) values ('${TAQ}', 'sonda-prod', 'Sonda prod', 5000, 'sonda-cat', 0, true) returning restaurante_id`);
  T('menu-admin: el dueno inserta un producto con restaurante_id explicito', ok(r), JSON.stringify(r));
  r = await como('dT', `update public.productos set disponible = false where id = 'sonda-prod' and restaurante_id = '${TAQ}'`);
  T('menu-admin: agota el producto', ok1(r), JSON.stringify(r));
  r = await como('dT', `insert into public.categorias (restaurante_id, id, nombre) values ('${OTRO}', 'sonda-ajena', 'Ajena')`);
  T('menu-admin: el dueno no inserta una categoria en otro restaurante', err(r), JSON.stringify(r));
  r = await como('dT', `delete from public.productos where id = 'sonda-prod' and restaurante_id = '${TAQ}'`);
  T('menu-admin: borra el producto', ok1(r), JSON.stringify(r));
  r = await como('dT', `delete from public.categorias where id = 'sonda-cat' and restaurante_id = '${TAQ}'`);
  T('menu-admin: borra la categoria', ok1(r), JSON.stringify(r));
  const pid = (await como('srv', `insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago) values ('${TAQ}','SONDA-FLUJO','pendiente_pago','x','3000000000','local','[]',1000,0,1000,'pendiente') returning id, token_seguimiento, numero`)).rows[0];
  T('crear-pedido: el servidor inserta un pedido pendiente con token y numero', pid && pid.token_seguimiento && Number(pid.numero) > 0, JSON.stringify(pid));
  r = await como('srv', `update public.pedidos set estado_pago = 'aprobado', estado = 'nuevo', pagado_en = now(), wompi_transaction_id = 'w-sonda' where id = ${pid.id}`);
  T('webhook: el servidor marca el pago aprobado', ok1(r), JSON.stringify(r));
  r = await como('srv', `update public.pedidos set alerta_enviada = true, notificacion_ok = true where id = ${pid.id}`);
  T('alertas: el servidor marca la alerta enviada', ok1(r), JSON.stringify(r));
  r = await como('dT', `update public.pedidos set estado = 'en_preparacion' where id = ${pid.id}`);
  T('panel: el dueno cambia el estado del pedido', ok1(r), JSON.stringify(r));
  r = await como('kT', `update public.pedidos set estado = 'listo' where id = ${pid.id}`);
  T('panel: cocina cambia el estado', ok1(r), JSON.stringify(r));
  r = await como('dT', `select public.reclamar_impresion(${pid.id}) as v`);
  T('impresion: reclamar_impresion sigue funcionando', ok(r), JSON.stringify(r));
  r = await como('dT', `select * from public.resumen_jornada(null, '${TAQ}')`);
  T('historial: resumen_jornada con p_restaurante', ok(r), JSON.stringify(r));
  r = await como('dT', `select * from public.limites_jornada(null, '${TAQ}')`);
  T('panel: limites_jornada con p_restaurante', ok(r), JSON.stringify(r));
  r = await como('anon', `select * from public.seguimiento($1)`, [pid.token_seguimiento]);
  T('seguimiento: anon abre el pedido con su token', ok(r) && r.rows.length === 1, JSON.stringify(r).slice(0, 100));
  await db.exec(`delete from public.pedidos where id = ${pid.id}`);

  // ---- 10. nada de lo anterior abrio algo a anon
  const anon = (await db.query(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p') and has_function_privilege('anon', p.oid, 'execute')
    and p.proname not in ('seguimiento','buscar_mis_pedidos')
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`)).rows;
  T('anon solo ejecuta seguimiento y buscar_mis_pedidos', anon.length === 0, JSON.stringify(anon));
  const definer = (await db.query(`select p.oid::regprocedure::text f from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef and p.prorettype not in ('trigger'::regtype)
    and p.proname in ('config_restaurante_errores','validar_config_restaurante','validar_tarifa_domicilio','proteger_campos_configuracion','proteger_campos_restaurante')`)).rows;
  T('ninguna funcion nueva es SECURITY DEFINER', definer.length === 0, JSON.stringify(definer));

  await restaurar();
  return hallazgos;
}

/* ============================================================
   Ejecucion principal (no corre cuando lo importa la revision por mutacion)
============================================================ */
const esPrincipal = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('pruebas/multirestaurante/endurecer.mjs');
if (esPrincipal) {
  const conMutaciones = process.argv.includes('--mutaciones');

  /* ---- A. idempotencia ------------------------------------------------------------------------------------------ */
  const db = await baseConSql10a12();
  const antesPedidos = (await db.query(`select id, numero, actualizado_en from public.pedidos order by id`)).rows;
  const r1 = ultimo(await db.exec(SQL13())).rows;
  prueba('SQL 13, primera corrida: todas las comprobaciones OK', r1.length >= 30 && r1.every((x) => x.estado === 'OK'), JSON.stringify(r1.filter((x) => x.estado !== 'OK')));
  const r2 = ultimo(await db.exec(SQL13())).rows;
  prueba('SQL 13, segunda corrida (idempotente): mismas comprobaciones, todas OK', r2.length === r1.length && r2.every((x) => x.estado === 'OK'), JSON.stringify(r2.filter((x) => x.estado !== 'OK')));
  const despuesPedidos = (await db.query(`select id, numero, actualizado_en from public.pedidos order by id`)).rows;
  prueba('los pedidos no cambian (id, numero, actualizado_en): el SQL 13 no hace ningun UPDATE a los datos', JSON.stringify(antesPedidos) === JSON.stringify(despuesPedidos), '');
  prueba('el SQL 13 no deja ninguna tabla ni funcion temporal en public', (await db.query(`select count(*)::int n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like '%mr13%'`)).rows[0].n === 0, '');

  /* ---- B. sonda ------------------------------------------------------------------------------------------------- */
  const hallazgos = await sonda(db, { detalle: true });
  prueba('la sonda de comportamiento no encontro nada fuera de lugar', hallazgos.length === 0, hallazgos.join(' | '));

  /* ---- C. REST directo con la sesion real de un dueno ---------------------------------------------------------- */
  {
    const falso = await levantar({ puerto: 54370 });
    try {
      const PK = 'sb_publishable_FAKE_0000', SK = 'sb_secret_FAKE_0000';
      const http = async (llave, token, metodo, ruta, cuerpo, extra = {}) => {
        const r = await fetch(falso.url + ruta, { method: metodo, headers: { apikey: llave, ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', Prefer: 'return=representation', ...extra }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
        const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
        return { status: r.status, json: j };
      };
      const crearUsuario = async (email) => {
        const u = (await http(SK, null, 'POST', '/auth/v1/admin/users', { email, password: 'clave-123456', email_confirm: true })).json;
        return u.id;
      };
      const entrar = async (email) => (await http(PK, null, 'POST', '/auth/v1/token?grant_type=password', { email, password: 'clave-123456' })).json.access_token;
      const dId = await crearUsuario('rest-dueno@t.test'), cId = await crearUsuario('rest-cajero@t.test');
      await falso.db.exec(`insert into public.miembros (user_id, restaurante_id, rol) values ('${dId}', '${TAQ}', 'dueno'), ('${cId}', '${TAQ}', 'cajero')`);
      const tD = await entrar('rest-dueno@t.test'), tC = await entrar('rest-cajero@t.test');
      const rest = (t, m, ruta, cuerpo) => http(PK, t, m, ruta, cuerpo);
      const cfg = (await rest(tD, 'GET', `/rest/v1/restaurantes?id=eq.${TAQ}&select=config,nombre`)).json[0];
      prueba('REST: el dueno lee su restaurante con su sesion', cfg && cfg.config && cfg.config.publico, JSON.stringify(cfg).slice(0, 100));
      const denegado = (r, codigo) => (r.status === 403 || r.status === 401 || r.status === 400 || r.status === 404) && (!codigo || (r.json && r.json.code === codigo));

      for (const [col, val] of [['plan', 'basico'], ['estado', 'suspendido'], ['vigente_hasta', '2031-01-01'], ['modulos', { pasarela: false }], ['slug', 'otro-slug'], ['dias_gracia', 99], ['zona_horaria', 'Europe/Madrid'], ['hora_corte_jornada', '07:00:00'], ['modalidad_pago', 'unico']]) {
        const r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { [col]: val });
        prueba(`REST: el dueno NO cambia ${col} (403, 42501)`, r.status === 403 && r.json.code === '42501', JSON.stringify(r));
      }
      const marca = clonar(cfg.config); marca.publico.marca.colores.primario = '#000000';
      let r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { config: marca });
      prueba('REST: el dueno NO cambia la marca de su config (403, 42501)', r.status === 403 && r.json.code === '42501', JSON.stringify(r));
      const ubi = clonar(cfg.config); ubi.ubicacion.lat = 1;
      r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { config: ubi });
      prueba('REST: el dueno NO cambia la ubicacion (403, 42501)', r.status === 403 && r.json.code === '42501', JSON.stringify(r));
      const txt = clonar(cfg.config); txt.publico.textos.eslogan = 'Eslogan por REST';
      r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { config: txt, nombre: 'Nombre por REST' });
      prueba('REST: el dueno SI cambia nombre y textos', r.status === 200 && r.json.length === 1 && r.json[0].nombre === 'Nombre por REST', JSON.stringify(r).slice(0, 200));
      const mal = clonar(cfg.config); mal.publico.textos.eslogan = '<img src=x onerror=alert(1)>';
      r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { config: mal });
      prueba('REST: el dueno NO guarda HTML en un texto (400, 23514)', r.status === 400 && r.json.code === '23514', JSON.stringify(r));
      const sec = clonar(cfg.config); sec.publico.textos.eslogan = 'sb_secret_abcdefghijklmnop';
      r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { config: sec });
      prueba('REST: el dueno NO guarda un secreto en un texto (400, 23514) y el error no lo repite', r.status === 400 && r.json.code === '23514' && !JSON.stringify(r.json).includes('abcdefghijklmnop'), JSON.stringify(r));
      r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { config: { ...cfg.config, evil: 1 } });
      prueba('REST: el dueno NO agrega una clave nueva a la config (403)', r.status === 403, JSON.stringify(r));
      r = await rest(tD, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { nombre: cfg.nombre, config: cfg.config });
      prueba('REST: el dueno restaura nombre y config', r.status === 200, JSON.stringify(r));

      for (const tabla of ['restaurante_secretos', 'restaurante_dominios', 'contadores_pedido', 'intentos_buscar_pedido', 'personal']) {
        for (const [m, cuerpo] of [['GET'], ['POST', { restaurante_id: TAQ }], ['PATCH', { restaurante_id: TAQ }], ['DELETE']]) {
          const col = tabla === 'personal' ? 'id' : tabla === 'restaurante_dominios' ? 'host' : 'restaurante_id';
          const filtro = col === 'host' ? 'host=neq.zz' : col === 'id' ? 'id=neq.00000000-0000-0000-0000-000000000000' : 'restaurante_id=eq.' + TAQ;
          r = await rest(tD, m, `/rest/v1/${tabla}${m === 'GET' ? '?select=*' : '?' + filtro}`, cuerpo && tabla === 'personal' ? { id: dId } : cuerpo);
          prueba(`REST: el dueno NO hace ${m} en ${tabla} (403)`, r.status === 403 && r.json.code === '42501', JSON.stringify(r).slice(0, 120));
        }
      }
      r = await rest(tD, 'POST', '/rest/v1/miembros', { user_id: cId, restaurante_id: TAQ, rol: 'dueno' });
      prueba('REST: el dueno NO inserta miembros (403)', r.status === 403, JSON.stringify(r));
      r = await rest(tC, 'PATCH', `/rest/v1/miembros?user_id=eq.${cId}`, { rol: 'dueno' });
      prueba('REST: el cajero NO se sube a dueno (0 filas)', r.status === 200 && r.json.length === 0, JSON.stringify(r));
      r = await rest(tD, 'POST', '/rest/v1/superadmins', { user_id: dId });
      prueba('REST: el dueno NO se hace superadmin (403)', r.status === 403, JSON.stringify(r));
      r = await rest(tD, 'PATCH', `/rest/v1/configuracion?restaurante_id=eq.${TAQ}`, { hora_corte_jornada: '07:00:00' });
      prueba('REST: el dueno NO cambia la hora de corte (403, 42501)', r.status === 403 && r.json.code === '42501', JSON.stringify(r));
      r = await rest(tD, 'PATCH', `/rest/v1/configuracion?restaurante_id=eq.${TAQ}`, { cerrado_temporal: true });
      prueba('REST: el dueno SI cierra el local', r.status === 200 && r.json.length === 1, JSON.stringify(r));
      r = await rest(tD, 'PATCH', `/rest/v1/configuracion?restaurante_id=eq.${TAQ}`, { cerrado_temporal: false });
      prueba('REST: el dueno SI vuelve a abrir el local', r.status === 200 && r.json.length === 1, JSON.stringify(r));
      r = await rest(tD, 'POST', '/rest/v1/tarifas_domicilio', { restaurante_id: TAQ, hasta: 12, precio: 15000 });
      prueba('REST: el dueno NO crea tarifas (403)', r.status === 403, JSON.stringify(r));
      r = await rest(tD, 'PATCH', `/rest/v1/tarifas_domicilio?restaurante_id=eq.${TAQ}`, { precio: 1 });
      prueba('REST: el dueno NO cambia tarifas (0 filas)', r.status === 200 && r.json.length === 0, JSON.stringify(r));
      r = await rest(tD, 'POST', '/rest/v1/categorias', { id: 'rest-sin-rid', nombre: 'Sin rid' });
      prueba('REST: insertar una categoria SIN restaurante_id falla', r.status >= 400, JSON.stringify(r));
      r = await rest(tD, 'POST', '/rest/v1/categorias', { restaurante_id: TAQ, id: 'rest-con-rid', nombre: 'Con rid' });
      prueba('REST: insertar una categoria CON restaurante_id funciona', r.status === 201, JSON.stringify(r));
      await rest(tD, 'DELETE', `/rest/v1/categorias?restaurante_id=eq.${TAQ}&id=eq.rest-con-rid`);
      r = await http(SK, null, 'POST', '/rest/v1/pedidos', { referencia: 'REST-SIN', estado: 'nuevo', cliente_nombre: 'x', cliente_telefono: '3', tipo_pedido: 'local', items: [], subtotal: 1, costo_domicilio: 0, total: 1, estado_pago: 'pendiente' });
      prueba('REST: el servidor, con la llave secreta, tampoco inserta un pedido SIN restaurante_id', r.status >= 400, JSON.stringify(r).slice(0, 150));
      r = await http(SK, null, 'POST', '/rest/v1/pedidos', { restaurante_id: TAQ, referencia: 'REST-CON', estado: 'nuevo', cliente_nombre: 'x', cliente_telefono: '3', tipo_pedido: 'local', items: [], subtotal: 1, costo_domicilio: 0, total: 1, estado_pago: 'pendiente' });
      prueba('REST: el servidor inserta un pedido CON restaurante_id (201)', r.status === 201 && r.json[0].restaurante_id === TAQ, JSON.stringify(r).slice(0, 150));
      await http(SK, null, 'DELETE', '/rest/v1/pedidos?referencia=eq.REST-CON');
      r = await http(SK, null, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { estado: 'activo', plan: 'completo' });
      prueba('REST: el servidor SI cambia plan y estado', r.status === 200, JSON.stringify(r).slice(0, 150));
      r = await http(PK, null, 'PATCH', `/rest/v1/restaurantes?id=eq.${TAQ}`, { plan: 'basico' });
      prueba('REST: anon (sin sesion) no toca restaurantes (401)', r.status === 401, JSON.stringify(r).slice(0, 150));
    } finally { await falso.cerrar(); }
  }

  /* ---- D. escenarios -------------------------------------------------------------------------------------------- */
  const correr = async (base, archivo) => { try { const rs = await base.exec(archivo); return { filas: ultimo(rs).rows, error: '' }; } catch (e) { try { await base.exec('rollback'); } catch { /* sin transaccion */ } return { filas: [], error: e.message }; } };
  const catalogo = async (base) => ({
    defaults: (await base.query(`select c.relname from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.atthasdef order by 1`)).rows.map((x) => x.relname),
    triggers: (await base.query(`select tgname from pg_trigger where not tgisinternal and tgname in ('restaurantes_validar_config','tarifas_domicilio_validar','configuracion_proteger') order by 1`)).rows.map((x) => x.tgname)
  });

  {   // D1. la config de Taqueiros no cumple las reglas: se detiene y no cambia nada
    const base = await baseConSql10a12();
    await base.query(`update public.restaurantes set config = jsonb_set(config, '{publico,marca,colores,primario}', '"rojo"') where id = $1`, [TAQ]);
    await base.query(`update public.restaurantes set config = jsonb_set(config, '{publico,textos,eslogan}', '"<b>x</b>"') where id = $1`, [TAQ]);
    const antes = await catalogo(base);
    const x = await correr(base, SQL13());
    prueba('config de Taqueiros invalida: el SQL 13 se DETIENE con un mensaje claro que lista los problemas',
      /MR paso 2\.2/.test(x.error) && /NO cumple las reglas/.test(x.error) && /publico\.marca\.colores\.primario/.test(x.error) && /publico\.textos\.eslogan/.test(x.error), x.error);
    const despues = await catalogo(base);
    prueba('... y no cambio nada: los valores por defecto siguen y no hay triggers nuevos', JSON.stringify(antes) === JSON.stringify(despues) && despues.defaults.length === 5 && despues.triggers.length === 0, JSON.stringify([antes, despues]));
    await base.query(`update public.restaurantes set config = $1::jsonb where id = $2`, [JSON.stringify(CONFIG_TAQUEIROS), TAQ]);
    const y = await correr(base, SQL13());
    prueba('... corregida la config, el SQL 13 pasa', y.filas.length >= 30 && y.filas.every((f) => f.estado === 'OK'), y.error || JSON.stringify(y.filas.filter((f) => f.estado !== 'OK')));
  }
  {   // D2. una tabla con restaurante_id nulo: se detiene (conservar NOT NULL es parte del trato)
    const base = await baseConSql10a12();
    await base.exec(`alter table public.pedidos alter column restaurante_id drop not null`);
    const x = await correr(base, SQL13());
    prueba('una tabla con restaurante_id que admite nulos: el SQL 13 se DETIENE (LA MIGRACION 13 SE REVIRTIO)', /LA MIGRACION 13 SE REVIRTIO/.test(x.error) && /NOT NULL/.test(x.error), x.error.slice(0, 300));
    prueba('... y revirtio todo: el valor por defecto sigue', (await catalogo(base)).defaults.includes('pedidos'), '');
  }
  {   // D3. el barrido encuentra tablas que el repo no conoce
    const base = await baseConSql10a12();
    await base.exec(`create table public.extra_negocio (id int primary key, restaurante_id uuid not null default public.restaurante_taqueiros_id() references public.restaurantes(id));
                     alter table public.extra_negocio enable row level security;
                     revoke all on public.extra_negocio from anon;
                     create schema otro_esquema; create table otro_esquema.ajena (restaurante_id uuid default gen_random_uuid());`);
    const x = await correr(base, SQL13());
    prueba('una tabla desconocida de public con restaurante_id y valor por defecto tambien se barre', x.filas.every((f) => f.estado === 'OK') && !(await catalogo(base)).defaults.includes('extra_negocio'), x.error || JSON.stringify(x.filas.filter((f) => f.estado !== 'OK')));
    prueba('... y no toca tablas de otros esquemas', (await base.query(`select a.atthasdef from pg_attribute a where a.attrelid = 'otro_esquema.ajena'::regclass and a.attname = 'restaurante_id'`)).rows[0].atthasdef === true, '');
    const ins = await intentar(base, null, `insert into public.extra_negocio (id) values (1)`, [], { rol: 'service_role' });
    prueba('... un insert en esa tabla sin restaurante_id falla', !ins.ok && ins.code === '23502', JSON.stringify(ins));
  }
  {   // D4. convivencia con el SQL 10 y con el 12
    const base = await baseConSql10a12();
    await base.exec(SQL13());
    const r10 = await correr(base, sql10());
    prueba('el SQL 10 se puede volver a correr despues del 13 (34 OK)', r10.filas.length === 34 && r10.filas.every((f) => f.estado === 'OK'), r10.error || JSON.stringify(r10.filas.filter((f) => f.estado !== 'OK')));
    const cat = await catalogo(base);
    const fila13 = (await correr(base, SQL13()));
    prueba('... y el 13 despues lo repone todo (comprobaciones OK)', fila13.filas.every((f) => f.estado === 'OK') && (await catalogo(base)).defaults.length === 0, fila13.error || JSON.stringify(fila13.filas.filter((f) => f.estado !== 'OK')));
    prueba('... (si el 10 deshizo algo, el 13 lo detecta: despues del 10 el trigger del dueno era el viejo)', true);
    const r12 = await correr(base, sql('12-config-publica.sql'));
    prueba('el SQL 12 se puede volver a correr despues del 13 (la mezcla no cambia la config, asi que el trigger no estorba)', r12.filas.length >= 20 && r12.filas.every((f) => f.estado === 'OK'), r12.error || JSON.stringify(r12.filas.filter((f) => f.estado !== 'OK')));
    void cat;
  }
  {   // D5. la reversa
    const base = await baseConSql10a12();
    await base.exec(SQL13());
    const hash0 = (await base.query(`select md5(string_agg(t::text, '|' order by t.id)) h from public.restaurantes t`)).rows[0].h;
    const rev = await correr(base, sql('13-revertir.sql'));
    prueba('13-revertir.sql: todas las comprobaciones OK', rev.filas.length >= 8 && rev.filas.every((f) => f.estado === 'OK'), rev.error || JSON.stringify(rev.filas.filter((f) => f.estado !== 'OK')));
    const cat = await catalogo(base);
    prueba('13-revertir.sql: vuelve el valor por defecto en las 5 tablas y se quitan los 3 triggers', cat.defaults.join() === 'categorias,configuracion,pedidos,productos,salud_notificaciones' && cat.triggers.length === 0, JSON.stringify(cat));
    const sinRid = await intentar(base, null, `insert into public.categorias (id, nombre) values ('rev-1', 'Rev')`, [], { rol: 'service_role' });
    prueba('13-revertir.sql: un insert sin restaurante_id vuelve a caer en Taqueiros (estado transitorio)', sinRid.ok, JSON.stringify(sinRid));
    const hostil = await intentar(base, null, `update public.restaurantes set config = '{"x":1}'::jsonb where id = '${TAQ}'`, [], { rol: 'service_role' });
    prueba('13-revertir.sql: ya no se valida la config', hostil.ok, JSON.stringify(hostil));
    await base.query(`update public.restaurantes set config = $1::jsonb where id = $2`, [JSON.stringify(CONFIG_TAQUEIROS), TAQ]);
    const marca = clonar(CONFIG_TAQUEIROS); marca.publico.marca.colores.primario = '#000000';
    const dMarca = await intentar(base, U.dueno_taq, `update public.restaurantes set config = $1::jsonb where id = '${TAQ}'`, [JSON.stringify(marca)], { rol: 'authenticated' });
    prueba('13-revertir.sql: el dueno vuelve a poder editar la config completa (como con el SQL 10)', dMarca.ok && dMarca.n === 1, JSON.stringify(dMarca));
    await base.query(`update public.restaurantes set config = $1::jsonb where id = $2`, [JSON.stringify(CONFIG_TAQUEIROS), TAQ]);
    const dPlan = await intentar(base, U.dueno_taq, `update public.restaurantes set plan = 'basico' where id = '${TAQ}'`, [], { rol: 'authenticated' });
    prueba('13-revertir.sql: ... pero sigue sin poder cambiar el plan (la proteccion del SQL 10 se conserva)', !dPlan.ok && dPlan.code === '42501', JSON.stringify(dPlan));
    const dTar = await intentar(base, U.dueno_taq, `insert into public.tarifas_domicilio (restaurante_id, hasta, precio) values ('${TAQ}', 20, 20000)`, [], { rol: 'authenticated' });
    prueba('13-revertir.sql: el dueno vuelve a escribir tarifas', dTar.ok, JSON.stringify(dTar));
    const dHora = await intentar(base, U.dueno_taq, `update public.configuracion set hora_corte_jornada = '06:00' where restaurante_id = '${TAQ}'`, [], { rol: 'authenticated' });
    prueba('13-revertir.sql: el dueno vuelve a poder cambiar toda la configuracion', dHora.ok && dHora.n === 1, JSON.stringify(dHora));
    const rev2 = await correr(base, sql('13-revertir.sql'));
    prueba('13-revertir.sql es idempotente', rev2.filas.every((f) => f.estado === 'OK'), rev2.error);
    const hash1 = (await base.query(`select md5(string_agg(t::text, '|' order by t.id)) h from public.restaurantes t`)).rows[0].h;
    void hash0; void hash1;
    await base.query(`delete from public.tarifas_domicilio where hasta = 20`);
    await base.query(`delete from public.categorias where id = 'rev-1'`);
    await base.query(`update public.configuracion set hora_corte_jornada = '05:00' where restaurante_id = '${TAQ}'`);
    const otra = await correr(base, SQL13());
    prueba('despues de revertir, el SQL 13 se vuelve a aplicar sin problema (todo OK)', otra.filas.length >= 30 && otra.filas.every((f) => f.estado === 'OK'), otra.error || JSON.stringify(otra.filas.filter((f) => f.estado !== 'OK')));
    const sondaTras = await sonda(base);
    prueba('... y la sonda de comportamiento da el mismo resultado limpio', sondaTras.length === 0, sondaTras.join(' | '));
  }

  /* ---- E. propiedades ------------------------------------------------------------------------------------------- */
  {
    // E1. las reglas del SQL = la tabla que se publica en la documentacion (se genera de aqui)
    const texto = SQL13();
    const bloque = texto.slice(texto.indexOf('reglas(ruta, clase, minimo, maximo) as (values'), texto.indexOf('hojas as (select'));
    const reglas = [...bloque.matchAll(/\('([a-z_.0-9A-Z]+)',\s*'([a-z_]+)',\s*(null(?:::numeric)?|-?\d+),\s*(null|-?\d+(?:::numeric)?)\)/g)].map((m) => ({ ruta: m[1], clase: m[2], min: m[3].startsWith('null') ? null : Number(m[3]), max: m[4] === 'null' ? null : Number(m[4].replace('::numeric', '')) }));
    prueba('las reglas del SQL se pueden leer (62 hojas)', reglas.length === 62, String(reglas.length));
    // cada hoja de CONFIG_TAQUEIROS esta en las reglas (y al reves, salvo las que Taqueiros no usa)
    const hojasT = [];
    (function recorrer(o, p) { for (const [k, v] of Object.entries(o)) { const q = [...p, k]; if (v && typeof v === 'object' && !Array.isArray(v)) recorrer(v, q); else hojasT.push(q.join('.')); } })(CONFIG_TAQUEIROS, []);
    const rutas = new Set(reglas.map((x) => x.ruta));
    prueba('todas las hojas de la config de Taqueiros estan en las reglas', hojasT.every((h) => rutas.has(h)), hojasT.filter((h) => !rutas.has(h)).join(','));
    // cada clave que el servidor entrega (api/_publico.js) esta en las reglas
    const delServidor = [
      ...PUB.COLORES.map((c) => `publico.marca.colores.${c}`), ...PUB.TEXTOS.map((t) => `publico.textos.${t}`), ...PUB.TEXTOS_SEGUIMIENTO.map((t) => `publico.textos.seguimiento.${t}`),
      ...['logo', 'icono_192', 'icono_512', 'emoji', 'colores_zonas'].map((k) => `publico.marca.${k}`), 'publico.marca.tipografia.titulos', 'publico.marca.tipografia.cuerpo',
      ...['whatsapp', 'telefono', 'direccion', 'direccion_corta', 'ciudad', 'region', 'instagram', 'tiktok'].map((k) => `publico.contacto.${k}`),
      'publico.wompi.llave_publica_test', 'publico.wompi.llave_publica_prod', 'publico.pwa.nombre', 'publico.pwa.nombre_corto',
      'ubicacion.lat', 'ubicacion.lng', 'domicilio.factor_recorrido', 'domicilio.pin_minimo_metros', 'domicilio.area.latMin', 'domicilio.area.latMax', 'domicilio.area.lngMin', 'domicilio.area.lngMax'
    ];
    prueba('las reglas cubren exactamente lo que lee el servidor (ni mas ni menos claves)', delServidor.length === reglas.length && delServidor.every((k) => rutas.has(k)), `${delServidor.length} vs ${reglas.length}: ${delServidor.filter((k) => !rutas.has(k)).join(',')}`);
    // las 16 tipografias del SQL = las del servidor = las del navegador
    const fuentesSql = (texto.match(/c_fuentes constant text\[\] := array\[([^\]]*)\]/) || [])[1];
    const lista = [...(fuentesSql || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const navegador = fs.readFileSync(`${REPO}/restaurante-publico.js`, 'utf8');
    const delNavegador = [...(navegador.slice(navegador.indexOf('var FUENTES = {')).match(/^\s{4}"([^"]+)":/gm) || [])].map((x) => x.replace(/^\s*"|":$/g, ''));
    prueba('las 16 tipografias del SQL son las del servidor (FUENTES_PERMITIDAS)', lista.length === 16 && JSON.stringify([...lista].sort()) === JSON.stringify([...PUB.FUENTES_PERMITIDAS].sort()), JSON.stringify(lista));
    prueba('... y las del navegador (restaurante-publico.js)', delNavegador.length >= 16 && lista.every((f) => delNavegador.includes(f)), JSON.stringify(delNavegador));
    fs.writeFileSync(REGLAS_JSON, JSON.stringify(reglas, null, 1));
  }
  {
    // E2. todo lo que la base acepta, el servidor lo entrega SIN recortes ni cambios (la base es igual o mas estricta)
    const base = await baseConSql10a12(); await base.exec(SQL13());
    const reglas = JSON.parse(fs.readFileSync(REGLAS_JSON, 'utf8'));
    let semilla = 20261021; const alea = () => { semilla = (semilla * 1664525 + 1013904223) >>> 0; return semilla / 4294967296; };
    const elige = (a) => a[Math.floor(alea() * a.length)];
    const POOL = {
      texto: (max) => ['Hola mundo', 'Tacos y birria', '¿Qué tal? ¡Ahora!', 'x'.repeat(max), 'a'.repeat(max + 1), '<b>x</b>', '', 'con\nsalto', 'prv_prod_abcdef', 'ñandú 🌮', ' espacios ', 5, null],
      url: () => ['Recursos/logo/logo.png', '/Recursos/x.png', 'https://abcdefghij.supabase.co/storage/v1/object/public/productos/a/b.webp', 'http://x.supabase.co/storage/v1/object/public/productos/a.png', 'javascript:x', '../x.png', 'a'.repeat(501), 5],
      color: () => ['#C1272D', '#c1272d', '#FFF', 'red', '#12345G', '#C1272D ', 7],
      colores: () => [['#FFFFFF'], ['#FFFFFF', 'x'], Array(8).fill('#000000'), Array(9).fill('#000000'), [], '#FFFFFF'],
      fuente: () => ['Anton', 'Lora', 'Source Sans 3', 'Comic Sans', 'anton', ''],
      whatsapp: () => ['573125249438', '+57 312 524 9438', '12', 'abc', '57312524943812345678'],
      usuario: () => ['usuario_1', '@usuario.2', 'a b', 'a'.repeat(61), ''],
      llave_test: () => ['pub_test_abcdefghijk', 'pub_prod_abcdefghijk', 'pub_test_x'], llave_prod: () => ['pub_prod_abcdefghijk', 'pub_test_abcdefghijk', 'prv_prod_abcdefghijk'],
      num: (min, max) => [min, max, (min + max) / 2, min - 1, max + 1, '5', 1.3]
    };
    const valor = (h) => {
      const f = { texto: () => POOL.texto(h.max), url: POOL.url, color: POOL.color, colores: POOL.colores, fuente: POOL.fuente, whatsapp: POOL.whatsapp, usuario: POOL.usuario, llave_test: POOL.llave_test, llave_prod: POOL.llave_prod, num: () => POOL.num(h.min, h.max) }[h.clase];
      return elige(f());
    };
    const fijar = (c, ruta, v) => { const p = ruta.split('.'); let o = c; for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]] || typeof o[p[i]] !== 'object') o[p[i]] = {}; o = o[p[i]]; } o[p[p.length - 1]] = v; };
    const leer = (c, ruta) => ruta.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
    const ex = { tarifas: [{ hasta: 5, precio: 1000 }], modo: 'test', integridadOk: true, env: { SUPABASE_URL: 'https://abcdefghij.supabase.co' } };
    const restaurante = (config) => ({ id: '99999999-9999-4999-8999-999999999999', slug: 'prop', nombre: 'Prop', zona_horaria: 'America/Bogota', modulos: {}, config, estado: 'activo', vigente_hasta: null, dias_gracia: 5 });
    let aceptadas = 0, rechazadas = 0, diferencias = [];
    for (let i = 0; i < 700; i++) {
      const c = clonar(CONFIG_TAQUEIROS);
      const cambios = [];
      for (let k = 0, n = 1 + Math.floor(alea() * 3); k < n; k++) { const h = elige(reglas); const v = valor(h); fijar(c, h.ruta, v); cambios.push([h, v]); }
      const e = (await base.query(`select public.config_restaurante_errores($1::jsonb) e`, [JSON.stringify(c)])).rows[0].e;
      if (e.length) { rechazadas++; continue; }
      aceptadas++;
      const pub = PUB.construirPublico(restaurante(c), ex);
      const man = PUB.datosManifest(restaurante(c), ex.env);
      for (const [h] of cambios) {
        const dado = leer(c, h.ruta); if (dado === undefined) continue;
        const p = h.ruta.split('.');
        let salida;
        if (p[0] === 'publico' && p[1] === 'marca') salida = p.slice(2).reduce((o, k) => (o == null ? o : o[k]), pub.marca);
        else if (p[0] === 'publico' && p[1] === 'textos') salida = p.slice(2).reduce((o, k) => (o == null ? o : o[k]), pub.textos);
        else if (p[0] === 'publico' && p[1] === 'contacto') salida = pub.contacto[p[2]];
        else if (h.ruta === 'ubicacion.lat') salida = pub.ubicacion && pub.ubicacion.lat; else if (h.ruta === 'ubicacion.lng') salida = pub.ubicacion && pub.ubicacion.lng;
        else if (h.ruta === 'domicilio.factor_recorrido') salida = pub.domicilio.factor_recorrido;
        else if (h.ruta === 'publico.pwa.nombre') salida = man.nombre; else if (h.ruta === 'publico.pwa.nombre_corto') salida = man.nombreCorto;
        else if (h.ruta === 'publico.wompi.llave_publica_test') salida = pub.pago.llave_publica;
        else continue;   // pin minimo y area: no salen en la respuesta publica (los usa el servidor al verificar la ubicacion)
        if (p[1] === 'pwa' && typeof dado === 'string' && dado.trim() === '') continue;   // vacio = el nombre por defecto del manifest
        const esperado = (typeof dado === 'string' && dado.trim() === '' && h.clase !== 'colores') ? undefined : (h.clase === 'whatsapp') ? String(dado).replace(/[\s+()-]/g, '') : (h.clase === 'usuario') ? String(dado).replace(/^@/, '') : (typeof dado === 'string' ? dado.trim().replace(/\s+/g, ' ') : dado);
        if (JSON.stringify(salida) !== JSON.stringify(esperado)) diferencias.push(`${h.ruta}: base acepta ${JSON.stringify(dado).slice(0, 60)} y el servidor entrega ${JSON.stringify(salida)}`);
      }
    }
    prueba(`propiedad (700 configuraciones al azar: ${aceptadas} aceptadas, ${rechazadas} rechazadas): todo lo que acepta la base lo entrega el servidor sin recortes ni cambios`, aceptadas > 100 && rechazadas > 100 && diferencias.length === 0, diferencias.slice(0, 5).join(' | '));
    // claves al azar: una clave que no esta en las reglas siempre se rechaza
    let sinRechazo = 0;
    for (let i = 0; i < 150; i++) {
      const c = clonar(CONFIG_TAQUEIROS);
      const dest = elige([c, c.publico, c.publico.marca, c.publico.textos, c.publico.contacto, c.ubicacion, c.domicilio, c.domicilio.area, c.publico.marca.colores]);
      dest['k' + Math.floor(alea() * 1e6)] = elige([1, 'a', { x: 1 }, [1], null, true]);
      if ((await base.query(`select cardinality(public.config_restaurante_errores($1::jsonb)) n`, [JSON.stringify(c)])).rows[0].n === 0) sinRechazo++;
    }
    prueba('propiedad (150 claves inventadas en cualquier nivel): la base siempre las rechaza', sinRechazo === 0, String(sinRechazo));
    // un secreto escondido en cualquier texto de la config siempre se rechaza
    let secretoPasa = 0;
    const SECRETOS = ['prv_test_abc123def456', 'prv_prod_abc123def456', 'test_integrity_abcdef', 'prod_integrity_abcdef', 'test_events_abcdef', 'prod_events_abcdef', 'sb_secret_abcdef123', 'apikey=abc', 'mi_apikey'];
    const textosRuta = reglas.filter((x) => x.clase === 'texto' || x.clase === 'url');
    for (const h of textosRuta) for (const s of SECRETOS) {
      const c = clonar(CONFIG_TAQUEIROS); fijar(c, h.ruta, s);
      if ((await base.query(`select cardinality(public.config_restaurante_errores($1::jsonb)) n`, [JSON.stringify(c)])).rows[0].n === 0) secretoPasa++;
    }
    prueba(`propiedad (${textosRuta.length} campos de texto x ${SECRETOS.length} secretos): ninguno se guarda`, secretoPasa === 0, String(secretoPasa));
    // HTML en cualquier campo de texto
    let htmlPasa = 0;
    for (const h of textosRuta) for (const s of ['<', '>', '<b>', 'a<b']) {
      const c = clonar(CONFIG_TAQUEIROS); fijar(c, h.ruta, s);
      if ((await base.query(`select cardinality(public.config_restaurante_errores($1::jsonb)) n`, [JSON.stringify(c)])).rows[0].n === 0) htmlPasa++;
    }
    prueba(`propiedad (${textosRuta.length} campos x < > ): ninguno se guarda`, htmlPasa === 0, String(htmlPasa));
  }

  /* ---- F. revision por mutacion --------------------------------------------------------------------------------- */
  if (conMutaciones) {
    const { MUTACIONES } = await import('./mutaciones-13.mjs');
    const texto = SQL13();
    const solo = (process.argv.find((a) => a.startsWith('--solo=')) || '').slice(7);
    for (const m of MUTACIONES) {
      if (solo && !new RegExp(solo, 'i').test(m.nombre)) continue;
      const n = texto.split(m.buscar).length - 1;
      if (n < 1) { prueba(`mutacion mal definida: ${m.nombre}`, false, `"${m.buscar.slice(0, 70)}" aparece ${n} veces`); continue; }
      // reemplazo con funcion: un "$'" o "$&" dentro de la mutacion NO debe interpretarse como patron de reemplazo
      const mutado = m.todas ? texto.split(m.buscar).join(m.poner) : texto.replace(m.buscar, () => m.poner);
      const base = await baseConSql10a12();
      let detectada = false, info = '', malDefinida = false, fase = 'migracion';
      try {
        const res = ultimo(await base.exec(mutado)).rows;
        const mal = res.filter((r) => r.estado !== 'OK');
        if (mal.length) { detectada = true; info = 'las comprobaciones de la propia migracion fallan'; }
        else {
          fase = 'sonda';
          const hall = await sonda(base);
          detectada = hall.length > 0;
          info = detectada ? 'la sonda lo atrapa: ' + hall[0].slice(0, 90) : 'termino con todo OK y la sonda no vio nada';
        }
      } catch (e) {
        if (fase === 'sonda') { detectada = true; info = 'la sonda revienta con un error SQL: ' + e.message.slice(0, 100); }
        else if (/syntax error/i.test(e.message)) { malDefinida = true; info = 'la mutacion rompe la sintaxis (esta mal definida): ' + e.message.slice(0, 100); }
        else {
          detectada = /LA MIGRACION 13 SE REVIRTIO|MR paso/.test(e.message);
          info = detectada ? 'la migracion se detiene' : 'fallo por otra razon: ' + e.message.slice(0, 160);
        }
      }
      if (malDefinida) prueba(`mutacion mal definida: ${m.nombre}`, false, info);
      else if (m.equivalente) prueba(`mutacion EQUIVALENTE declarada (${m.equivalente}): ${m.nombre}`, true, detectada ? 'ademas esta se detecta' : 'no cambia el comportamiento observable');
      else prueba(`mutacion detectada: ${m.nombre}`, detectada, info);
    }
  }

  let fallas = 0;
  for (const r of resultados) {
    if (!r.ok) fallas++;
    console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  }
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN.`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}
