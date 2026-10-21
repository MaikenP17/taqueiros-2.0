/* =============================================================
   PRUEBAS DEL SQL 15 (supabase/15-datos-restaurante.sql) Y DE SU REVERSA (15-revertir.sql)

     node pruebas/multirestaurante/datos-restaurante.mjs                 todo (sin la revision por mutacion)
     node pruebas/multirestaurante/datos-restaurante.mjs --mutaciones    ademas, la revision por mutacion (varios minutos)

   Postgres 16 real (PGlite) con los SQL 10 a 13 y 15; roles reales (anon, authenticated, service_role) y RLS.

     A. El SQL 15 corre dos veces (idempotente) y todas sus comprobaciones dan OK; la reversa y volver a aplicar.
     B. COMPORTAMIENTO (la "sonda", que tambien usa la revision por mutacion):
          - guardar_datos_restaurante: el dueno edita lo permitido; no pierde otras claves; no pisa cambios ajenos
            (dos ediciones: la segunda con el mismo campo recibe el conflicto, con otro campo se suma); cajero,
            cocina, dueno de otro restaurante, sin membresia y anon no pueden aunque fabriquen la llamada; campos
            fuera de la lista (marca, plan, vigencia, modulos...) y valores no validos se rechazan
          - horario y mensaje de cerrado validados en la base, sin frenar abrir/cerrar el local
     C. Escenarios: se detiene (y no cambia nada) si el horario de Taqueiros no cumple las reglas o si falta el SQL 13;
        convivencia con el SQL 13 y el 14; la reversa.
     D. (--mutaciones) cada defensa del SQL 15 se rompe a proposito y algo tiene que detectarlo.
============================================================= */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { crearBase, sembrar, sql10, sql, intentar, U } from './sim.mjs';

const require = createRequire(import.meta.url);
const DR = require('../../datos-restaurante.js');   // el formulario del panel: sus listas de campos y sus reglas se comparan con las de la base

const TAQ = '00000000-0000-4000-8000-000000000001';
const OTRO = '55555555-5555-4555-8555-555555555555';
const usr = {
  dT: U.dueno_taq,
  cT: 'c1000000-0000-4000-8000-0000000000c1', kT: 'c1000000-0000-4000-8000-0000000000c2',
  dO: 'c1000000-0000-4000-8000-0000000000d1', sin: 'c1000000-0000-4000-8000-0000000000e1', sa: 'c1000000-0000-4000-8000-0000000000f1'
};
const SQL15 = () => (process.env.SQL15_ARCHIVO ? fs.readFileSync(process.env.SQL15_ARCHIVO, 'utf8') : sql('15-datos-restaurante.sql'));
const clonar = (o) => JSON.parse(JSON.stringify(o));
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const igual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

const resultados = [];
const prueba = (nombre, ok, info = '') => resultados.push({ nombre, ok: !!ok, info: ok ? '' : String(info).slice(0, 600) });

export async function baseConSql13() {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  await db.exec(sql10());
  await db.exec(sql('11-dominios.sql'));
  await db.exec(sql('12-config-publica.sql'));
  await db.exec(sql('13-endurecer.sql'));
  return db;
}

const HOR_OK = [
  { dia: 'Domingo', abre: '11:00', cierra: '22:00', activo: true }, { dia: 'Lunes', abre: '11:00', cierra: '22:00', activo: true },
  { dia: 'Martes', abre: '11:00', cierra: '22:00', activo: true }, { dia: 'Miercoles', abre: '11:00', cierra: '24:00', activo: true },
  { dia: 'Jueves', abre: '00:00', cierra: '23:59', activo: true }, { dia: 'Viernes', abre: '18:00', cierra: '02:00', activo: true },
  { dia: 'Sabado', abre: '11:00', cierra: '22:00', activo: false }
];

/* ============================================================
   B. LA SONDA DE COMPORTAMIENTO: devuelve la lista de lo que NO se cumple (vacia = todo bien)
============================================================ */
export async function sonda(db, { detalle = false } = {}) {
  const hallazgos = [];
  const T = (nombre, cond, info = '') => { if (detalle) resultados.push({ nombre, ok: !!cond, info: cond ? '' : String(info).slice(0, 500) }); if (!cond) hallazgos.push(nombre + (info && !detalle ? ' -> ' + String(info).slice(0, 160) : '')); };

  // ---- fixtures
  for (const id of Object.values(usr)) await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [id, id + '@t.test']);
  await db.query(`insert into public.restaurantes (id, slug, nombre, config) values ($1, 'otro-sonda', 'Otro sonda', $2::jsonb) on conflict do nothing`,
    [OTRO, JSON.stringify({ publico: { textos: { eslogan: 'Eslogan de otro' }, marca: { logo: 'Recursos/otro/logo.png' } }, ubicacion: { lat: 7.9, lng: -72.5 } })]);
  await db.exec(`
    insert into public.miembros (user_id, restaurante_id, rol) values
      ('${usr.cT}', '${TAQ}', 'cajero'), ('${usr.kT}', '${TAQ}', 'cocina'), ('${usr.dO}', '${OTRO}', 'dueno') on conflict do nothing;
    insert into public.superadmins (user_id) values ('${usr.sa}') on conflict do nothing;`);

  const fila = async (id = TAQ) => (await db.query(`select * from public.restaurantes where id = $1`, [id])).rows[0];
  const como = (quien, q, p = []) => {
    if (quien === 'anon') return intentar(db, null, q, p, { rol: 'anon' });
    if (quien === 'srv') return intentar(db, null, q, p, { rol: 'service_role' });
    return intentar(db, usr[quien], q, p, { rol: 'authenticated' });
  };
  const guardar = (quien, id, cambios) => como(quien, `select public.guardar_datos_restaurante($1::uuid, $2::jsonb) as r`, [id, typeof cambios === 'string' ? cambios : JSON.stringify(cambios)]);
  const cam = (campo, antes, despues) => ({ campo, antes, despues });
  const ok = (r) => r.ok;
  const err = (r, codigo) => !r.ok && (!codigo || r.code === codigo);
  const res = (r) => (r.ok ? r.rows[0].r : null);
  const quitarEditable = (c) => { const x = clonar(c); if (x.publico) { delete x.publico.textos; delete x.publico.contacto; } return x; };

  const f0 = await fila();
  const cfg0 = f0.config;
  const huella = (f) => JSON.stringify(canon({ ...f }));

  // ---- 1. el dueno edita lo permitido
  const r1 = await guardar('dT', TAQ, [
    cam('nombre', f0.nombre, 'Los Taqueiros Editado'),
    cam('textos.eslogan', cfg0.publico.textos.eslogan ?? null, 'Nuevo eslogan'),
    cam('textos.seguimiento.frase_camino', cfg0.publico.textos.seguimiento && cfg0.publico.textos.seguimiento.frase_camino || null, 'En camino a tu mesa'),
    cam('contacto.instagram', cfg0.publico.contacto.instagram ?? null, 'lostaqueiros')
  ]);
  T('el dueno guarda nombre, texto, texto del seguimiento y contacto', ok(r1) && res(r1).ok === true && res(r1).cambios === 4, JSON.stringify(r1));
  const f1 = await fila();
  T('lo guardado queda en la base', f1.nombre === 'Los Taqueiros Editado' && f1.config.publico.textos.eslogan === 'Nuevo eslogan'
    && f1.config.publico.textos.seguimiento.frase_camino === 'En camino a tu mesa' && f1.config.publico.contacto.instagram === 'lostaqueiros', JSON.stringify(f1.config.publico.textos));
  T('NO se pierde ninguna otra clave: marca, ubicacion, domicilio, llaves, pwa y el resto de los textos y el contacto siguen iguales',
    igual(quitarEditable(f1.config), quitarEditable(cfg0))
    && Object.keys(cfg0.publico.textos).filter((k) => !['eslogan', 'seguimiento'].includes(k)).every((k) => f1.config.publico.textos[k] === cfg0.publico.textos[k])
    && Object.keys(cfg0.publico.contacto).filter((k) => k !== 'instagram').every((k) => f1.config.publico.contacto[k] === cfg0.publico.contacto[k]),
    JSON.stringify([quitarEditable(f1.config), quitarEditable(cfg0)]).slice(0, 300));
  T('lo demas de la fila no cambia (slug, estado, plan, modalidad, vigencia, gracia, modulos, zona horaria, hora de corte)',
    ['slug', 'estado', 'plan', 'modalidad_pago', 'vigente_hasta', 'dias_gracia', 'zona_horaria', 'hora_corte_jornada'].every((k) => String(f1[k]) === String(f0[k])) && igual(f1.modulos, f0.modulos), '');
  T('la respuesta trae el estado vigente de lo editable (nombre, textos, contacto)',
    res(r1).datos.nombre === 'Los Taqueiros Editado' && res(r1).datos.textos.eslogan === 'Nuevo eslogan' && res(r1).datos.contacto.instagram === 'lostaqueiros', JSON.stringify(res(r1).datos).slice(0, 200));

  // ---- 1b. los 32 campos del formulario se pueden editar (la lista cerrada esta completa) y cada uno llega a su sitio
  {
    const f = await fila();
    const valorDe = (c) => (c === 'nombre' ? 'Nombre nuevo' : c === 'contacto.whatsapp' ? '573009998877' : c.startsWith('contacto.instagram') || c === 'contacto.tiktok' ? 'u_' + c.split('.').pop() : 'valor de ' + c);
    const todos = DR.CAMPOS.map((c) => cam(c.campo, c.campo === 'nombre' ? f.nombre : (DR.leer({ nombre: f.nombre, config: f.config }, c.campo).trim() || null), valorDe(c.campo)));
    const rTodos = await guardar('dT', TAQ, todos);
    const g = await fila();
    const mal = DR.CAMPOS.filter((c) => DR.leer({ nombre: g.nombre, config: g.config }, c.campo) !== valorDe(c.campo)).map((c) => c.campo);
    T('el dueno edita los ' + DR.CAMPOS.length + ' campos del formulario de una sola llamada y cada uno queda en su sitio', ok(rTodos) && res(rTodos).ok === true && mal.length === 0 && igual(quitarEditable(g.config), quitarEditable(f.config)), JSON.stringify(rTodos).slice(0, 120) + ' / ' + mal.join(','));
    await db.query('update public.restaurantes set nombre = $2, config = $3::jsonb where id = $1', [TAQ, f.nombre, JSON.stringify(f.config)]);
  }

  // ---- 2. dos ediciones: la segunda con el mismo campo recibe el conflicto; con otro campo se suma
  const rB = await guardar('dT', TAQ, [cam('textos.tagline', f1.config.publico.textos.tagline ?? null, 'Tagline de B')]);
  T('una edicion de otra pestana (B) se guarda', ok(rB) && res(rB).ok === true, JSON.stringify(rB));
  const rA = await guardar('dT', TAQ, [cam('textos.tagline', f1.config.publico.textos.tagline ?? null, 'Tagline de A'), cam('textos.ejemplo_nota', cfg0.publico.textos.ejemplo_nota ?? null, 'Sin cebolla')]);
  const f2 = await fila();
  T('la edicion A (que partio de lo que vio antes de B) NO pisa a B: recibe el conflicto con el valor actual y no se guarda NADA de su pedido',
    ok(rA) && res(rA).ok === false && res(rA).conflictos.length === 1 && res(rA).conflictos[0].campo === 'textos.tagline' && res(rA).conflictos[0].actual === 'Tagline de B'
    && f2.config.publico.textos.tagline === 'Tagline de B' && f2.config.publico.textos.ejemplo_nota === (cfg0.publico.textos.ejemplo_nota ?? undefined), JSON.stringify(rA));
  const rA2 = await guardar('dT', TAQ, [cam('textos.ejemplo_nota', cfg0.publico.textos.ejemplo_nota ?? null, 'Sin cebolla')]);
  const f3 = await fila();
  T('A guarda otro campo distinto: se suma y lo de B se conserva', ok(rA2) && res(rA2).ok === true && f3.config.publico.textos.ejemplo_nota === 'Sin cebolla' && f3.config.publico.textos.tagline === 'Tagline de B', JSON.stringify(rA2));
  const rIgual = await guardar('dT', TAQ, [cam('textos.tagline', 'Tagline de B', 'Tagline de B')]);
  T('un cambio igual al valor actual no escribe nada', ok(rIgual) && res(rIgual).ok === true && res(rIgual).cambios === 0, JSON.stringify(rIgual));
  const rEsp = await guardar('dT', TAQ, [cam('textos.tagline', '  Tagline de B  ', '  Tagline de B  ')]);
  T('los espacios de los extremos no cuentan como un cambio ni como un conflicto', ok(rEsp) && res(rEsp).ok === true, JSON.stringify(rEsp));
  const rBorrar = await guardar('dT', TAQ, [cam('textos.ejemplo_nota', 'Sin cebolla', '')]);
  const f4 = await fila();
  T('un campo vacio se borra (solo ese)', ok(rBorrar) && res(rBorrar).ok === true && !('ejemplo_nota' in f4.config.publico.textos) && f4.config.publico.textos.tagline === 'Tagline de B', JSON.stringify(rBorrar));

  await db.query(`update public.restaurantes set config = jsonb_set(config, '{publico,textos,servicios_linea}', '"  Con espacios  "') where id = $1`, [TAQ]);
  const rEsp2 = await guardar('dT', TAQ, [cam('textos.servicios_linea', 'Con espacios', 'Sin espacios')]);
  T('un valor guardado con espacios de mas se compara recortado: el usuario (que ve el texto recortado) no recibe un conflicto falso', ok(rEsp2) && res(rEsp2).ok === true && (await fila()).config.publico.textos.servicios_linea === 'Sin espacios', JSON.stringify(rEsp2));
  await db.query(`update public.restaurantes set config = jsonb_set(config, '{publico,textos,servicios_linea}', to_jsonb($2::text)) where id = $1`, [TAQ, cfg0.publico.textos.servicios_linea ?? '']);
  if (cfg0.publico.textos.servicios_linea === undefined) await db.query(`update public.restaurantes set config = config #- '{publico,textos,servicios_linea}' where id = $1`, [TAQ]);

  // ---- 3. quien no puede
  const antesRechazos = huella(await fila());
  const intento = [cam('textos.eslogan', 'Nuevo eslogan', 'Hackeado')];
  for (const quien of ['cT', 'kT', 'dO', 'sin']) {
    const r = await guardar(quien, TAQ, intento);
    T(`${quien} no puede guardar los datos de Taqueiros (42501)`, err(r, '42501'), JSON.stringify(r));
  }
  const rAnon = await guardar('anon', TAQ, intento);
  T('anon no puede ni ejecutar la funcion (42501)', err(rAnon, '42501'), JSON.stringify(rAnon));
  T('ningun rechazo cambio la fila', huella(await fila()) === antesRechazos, '');
  const rOtro = await guardar('dO', OTRO, [cam('textos.eslogan', 'Eslogan de otro', 'Eslogan de otro, editado')]);
  T('el dueno de OTRO restaurante si puede editar el suyo', ok(rOtro) && res(rOtro).ok === true, JSON.stringify(rOtro));
  const fOtro = await fila(OTRO);
  T('...y solo el suyo (la marca de su config no se toco)', fOtro.config.publico.textos.eslogan === 'Eslogan de otro, editado' && fOtro.config.publico.marca.logo === 'Recursos/otro/logo.png' && huella(await fila()) === antesRechazos, '');
  const rSa = await guardar('sa', TAQ, [cam('textos.eslogan', 'Nuevo eslogan', 'Eslogan del superadmin')]);
  T('un superadmin puede editar', ok(rSa) && res(rSa).ok === true, JSON.stringify(rSa));
  const rSrv = await guardar('srv', TAQ, [cam('textos.eslogan', 'Eslogan del superadmin', 'Nuevo eslogan')]);
  T('el servidor puede editar', ok(rSrv) && res(rSrv).ok === true, JSON.stringify(rSrv));
  const rNo = await guardar('dT', '99999999-9999-4999-8999-999999999999', intento);
  T('un restaurante que no existe: 42501 (no dice si existe)', err(rNo, '42501'), JSON.stringify(rNo));
  const rNoSrv = await guardar('srv', '99999999-9999-4999-8999-999999999999', intento);
  T('...tambien para el servidor (que pasa la revision de rol): 42501 y nada se crea', err(rNoSrv, '42501') && (await db.query(`select count(*)::int n from public.restaurantes where id = '99999999-9999-4999-8999-999999999999'`)).rows[0].n === 0, JSON.stringify(rNoSrv));

  // ---- 4. el dueno fabrica la peticion
  const f5 = await fila();
  const prohibidos = ['marca.logo', 'publico.marca.logo', 'publico.textos.eslogan', 'marca.colores.primario', 'wompi.llave_publica_test', 'ubicacion.lat', 'domicilio.factor_recorrido', 'pwa.nombre',
    'estado', 'plan', 'modalidad_pago', 'vigente_hasta', 'dias_gracia', 'modulos', 'slug', 'zona_horaria', 'hora_corte_jornada', 'id', 'creado_en', 'textos', 'contacto', 'textos.seguimiento', 'textos.x', 'contacto.x', '', ' ', 'NOMBRE', 'nombre ', 'textos.eslogan ', '__proto__'];
  const aceptados = [];
  for (const campo of prohibidos) {
    const r = await guardar('dT', TAQ, [cam(campo, null, 'x')]);
    if (!err(r, '22023')) aceptados.push(campo + ' -> ' + JSON.stringify(r).slice(0, 80));
  }
  T(`${prohibidos.length} campos fuera de la lista cerrada (marca, llaves, ubicacion, domicilio, plan, estado, vigencia, modulos, contenedores...) se rechazan con 22023`, aceptados.length === 0, aceptados.join(' | '));
  const malos = ['null', '{}', '"x"', '5', '[1]', '["a"]', '[{"campo":"textos.eslogan","antes":null,"despues":5}]', '[{"campo":"textos.eslogan","antes":1,"despues":"a"}]', '[{"campo":"textos.eslogan","antes":null,"despues":{"a":1}}]',
    '[{"campo":"textos.eslogan","antes":null,"despues":"a","extra":1}]', '[{"antes":null,"despues":"a"}]', '[{"campo":null,"antes":null,"despues":"a"}]', '[{"campo":["textos.eslogan"],"antes":null,"despues":"a"}]',
    '[{"campo":"textos.eslogan","antes":null,"despues":"a"},{"campo":"textos.eslogan","antes":null,"despues":"b"}]', JSON.stringify(Array.from({ length: 41 }, (_, i) => ({ campo: 'textos.eslogan', antes: null, despues: 'a' + i })))];
  const aceptadosMalos = [];
  for (const m of malos) {
    const r = await guardar('dT', TAQ, m);
    if (!err(r, '22023')) aceptadosMalos.push(m.slice(0, 50) + ' -> ' + JSON.stringify(r).slice(0, 80));
  }
  T(`${malos.length} pedidos mal formados se rechazan con 22023`, aceptadosMalos.length === 0, aceptadosMalos.join(' | '));
  const inval = [['textos.eslogan', '<b>hola</b>'], ['textos.eslogan', 'prv_test_abcdefghijk'], ['textos.eslogan', 'a '.repeat(201)], ['textos.eslogan', 'dos\nlineas'], ['textos.eslogan', 'a' + String.fromCharCode(0x200b) + 'b'], ['textos.eslogan', 'a'.repeat(40)],
    ['contacto.whatsapp', '12'], ['contacto.whatsapp', 'no es un numero'], ['contacto.instagram', 'con espacios'], ['contacto.tiktok', '@a/b'], ['contacto.telefono', 't'.repeat(41)],
    ['contacto.ciudad', 'c'.repeat(81)], ['contacto.direccion', 'd'.repeat(201)], ['textos.seguimiento.frase_nuevo', 'x '.repeat(101)], ['nombre', '<script>'], ['nombre', 'n'.repeat(121)], ['nombre', 'a\u0007b']];
  const aceptadosInval = [];
  for (const [campo, valor] of inval) {
    const f = await fila();
    const actual = campo === 'nombre' ? f.nombre : campo.split('.').reduce((o, k) => (o == null ? null : o[k] ?? null), f.config.publico);
    for (const quien of ['dT', 'srv']) {
      const r = await guardar(quien, TAQ, [cam(campo, actual, valor)]);
      if (!err(r, '23514')) aceptadosInval.push(`${quien} ${campo} -> ${JSON.stringify(r).slice(0, 80)}`);
    }
  }
  T(`${inval.length} valores no validos (HTML, secretos, largos, saltos de linea, ancho cero, whatsapp, usuarios, nombre) se rechazan con 23514, tambien para el servidor`, aceptadosInval.length === 0, aceptadosInval.join(' | '));
  T('ningun rechazo cambio la fila', huella(await fila()) === huella(f5), '');
  const mensaje = (await guardar('dT', TAQ, [cam('textos.eslogan', 'Nuevo eslogan', 'prv_test_abcdefghijk')])).error || '';
  T('el mensaje de error de un secreto no repite el valor', !/prv_test_abcdefghijk/.test(mensaje), mensaje);

  // ---- 5. el dueno por la puerta de atras (UPDATE directo): el SQL 13 sigue mandando
  const dir = async (sets, p = []) => como('dT', `update public.restaurantes set ${sets} where id = '${TAQ}'`, p);
  for (const [sets, p, nombre] of [
    [`plan = 'otro'`, [], 'plan'], [`estado = 'suspendido'`, [], 'estado'], [`vigente_hasta = '2099-01-01'`, [], 'vigencia'], [`modulos = '{"pasarela":false}'::jsonb`, [], 'modulos'],
    [`slug = 'otro'`, [], 'slug'], [`config = jsonb_set(config, '{publico,marca,logo}', '"Recursos/x.png"')`, [], 'marca.logo'],
    [`config = jsonb_set(config, '{ubicacion,lat}', '10')`, [], 'ubicacion'], [`config = jsonb_set(config, '{domicilio,factor_recorrido}', '2')`, [], 'domicilio']
  ]) {
    const r = await dir(sets, p);
    T(`el dueno no cambia ${nombre} por un UPDATE directo`, !r.ok || r.n === 0, JSON.stringify(r));
  }
  T('...y la fila sigue igual', huella(await fila()) === huella(f5), '');

  // ---- 6. un dato viejo invalido en otra parte de la config bloquea el guardado con un error claro
  await db.exec(`alter table public.restaurantes disable trigger restaurantes_validar_config`);
  await db.query(`update public.restaurantes set config = jsonb_set(config, '{publico,marca,logo}', '"http://evil.example/x.png"') where id = $1`, [TAQ]);
  await db.exec(`alter table public.restaurantes enable trigger restaurantes_validar_config`);
  const rViejo = await guardar('dT', TAQ, [cam('textos.eslogan', 'Nuevo eslogan', 'Otro eslogan')]);
  T('con una config vieja invalida en la marca, el dueno no puede guardar y el error dice cual campo (publico.marca.logo)', err(rViejo, '23514') && /publico\.marca\.logo/.test(rViejo.error || ''), JSON.stringify(rViejo));
  await db.query(`update public.restaurantes set config = jsonb_set(config, '{publico,marca,logo}', $2::jsonb) where id = $1`, [TAQ, JSON.stringify(cfg0.publico.marca.logo)]);
  T('(se restaura la marca de Taqueiros)', igual((await fila()).config.publico.marca, cfg0.publico.marca), '');

  // ---- 7. horario y mensaje de cerrado
  const cfgT = (await db.query(`select * from public.configuracion where restaurante_id = $1`, [TAQ])).rows[0];
  const erroresH = async (h, m) => (await db.query(`select public.configuracion_errores($1::jsonb, $2) e`, [JSON.stringify(h), m])).rows[0].e;
  T('el horario y el mensaje actuales de Taqueiros cumplen las reglas', (await erroresH(cfgT.horarios, cfgT.mensaje_cerrado)).length === 0, JSON.stringify(await erroresH(cfgT.horarios, cfgT.mensaje_cerrado)));
  const setH = (quien, h, m) => como(quien, `update public.configuracion set horarios = $1::jsonb, mensaje_cerrado = $2 where restaurante_id = '${TAQ}'`, [JSON.stringify(h), m]);
  for (const quien of ['dT', 'sa', 'srv']) {
    const r = await setH(quien, HOR_OK, 'Volvemos manana\nGracias');
    T(`${quien} guarda un horario valido (24:00, medianoche, dia cerrado) con un mensaje de dos lineas`, ok(r) && r.n === 1, JSON.stringify(r));
  }
  const hostiles = [[[], null], [{}, null], [HOR_OK.slice(0, 6), null], [[...HOR_OK, HOR_OK[0]], null], [HOR_OK.map((d, i) => (i === 0 ? { ...d, abre: '25:00' } : d)), null],
    [HOR_OK.map((d, i) => (i === 0 ? { ...d, abre: '9:30' } : d)), null], [HOR_OK.map((d, i) => (i === 0 ? { ...d, cierra: '24:30' } : d)), null], [HOR_OK.map((d, i) => (i === 0 ? { ...d, activo: 'si' } : d)), null],
    [HOR_OK.map((d, i) => (i === 0 ? { ...d, extra: 1 } : d)), null], [HOR_OK.map((d, i) => (i === 0 ? { ...d, dia: '<b>' } : d)), null], [HOR_OK.map((d, i) => (i === 0 ? { ...d, dia: 'a' + String.fromCharCode(7) + 'b' } : d)), null], [HOR_OK, 'a'.repeat(301)], [HOR_OK, '<script>x</script>'], [HOR_OK, 'a\u0007b'], [HOR_OK, 'a' + String.fromCharCode(0x202e) + 'b']];
  const aceptadosH = [];
  for (const quien of ['dT', 'sa', 'srv']) {
    for (const [h, m] of hostiles) {
      const r = await setH(quien, h, m);
      if (!err(r, '23514')) aceptadosH.push(`${quien} ${JSON.stringify(h).slice(0, 40)}/${String(m).slice(0, 12)} -> ${JSON.stringify(r).slice(0, 60)}`);
    }
  }
  T(`${hostiles.length} horarios/mensajes hostiles se rechazan con 23514 para el dueno, el superadmin y el servidor`, aceptadosH.length === 0, aceptadosH.join(' | '));
  const cfgDespues = (await db.query(`select * from public.configuracion where restaurante_id = $1`, [TAQ])).rows[0];
  T('...y el horario guardado no cambio', igual(cfgDespues.horarios, HOR_OK), JSON.stringify(cfgDespues.horarios).slice(0, 100));
  const rIns = await como('srv', `insert into public.configuracion (restaurante_id, id, horarios) values ('${OTRO}', 7, '[]'::jsonb)`);
  T('un INSERT de configuracion con un horario invalido tambien se rechaza', err(rIns), JSON.stringify(rIns));
  // abrir o cerrar el local jamas se frena por un horario viejo
  await db.exec(`alter table public.configuracion disable trigger configuracion_validar`);
  await db.query(`update public.configuracion set horarios = '[1,2,3]'::jsonb where restaurante_id = $1`, [TAQ]);
  await db.exec(`alter table public.configuracion enable trigger configuracion_validar`);
  const rCerrar = await como('dT', `update public.configuracion set cerrado_temporal = true where restaurante_id = '${TAQ}'`);
  T('el dueno puede cerrar el local aunque el horario guardado sea viejo e invalido', ok(rCerrar) && rCerrar.n === 1, JSON.stringify(rCerrar));
  const rAbrir = await como('dT', `update public.configuracion set cerrado_temporal = false where restaurante_id = '${TAQ}'`);
  T('...y volver a abrirlo', ok(rAbrir) && rAbrir.n === 1, JSON.stringify(rAbrir));
  const rMsg = await como('dT', `update public.configuracion set mensaje_cerrado = 'Cerrado por hoy' where restaurante_id = '${TAQ}'`);
  T('cambiar solo el mensaje valida el mensaje (uno valido pasa)', ok(rMsg) && rMsg.n === 1, JSON.stringify(rMsg));
  const rMsgMalo = await como('dT', `update public.configuracion set mensaje_cerrado = '<b>x</b>' where restaurante_id = '${TAQ}'`);
  T('...y uno con HTML se rechaza', err(rMsgMalo, '23514'), JSON.stringify(rMsgMalo));
  const rCol = await como('dT', `update public.configuracion set hora_corte_jornada = '06:00' where restaurante_id = '${TAQ}'`);
  T('el dueno sigue sin poder cambiar la hora de corte (SQL 13)', !rCol.ok || rCol.n === 0, JSON.stringify(rCol));
  await db.query(`update public.configuracion set horarios = $2::jsonb, mensaje_cerrado = $3 where restaurante_id = $1`, [TAQ, JSON.stringify(cfgT.horarios), cfgT.mensaje_cerrado]);

  // ---- 8. la validacion del formulario (la que usa el navegador antes de guardar)
  const val = (quien, c) => como(quien, `select public.config_restaurante_errores($1::jsonb) e`, [JSON.stringify(c)]);
  const vOk = await val('dT', (await fila()).config);
  T('el dueno puede llamar config_restaurante_errores y la config vigente no tiene errores', ok(vOk) && vOk.rows[0].e.length === 0, JSON.stringify(vOk));
  const vMal = await val('dT', clonar({ publico: { textos: { eslogan: '<b>x</b>' }, contacto: { whatsapp: '12' } } }));
  T('...y le devuelve los campos con problema, sin repetir el valor', ok(vMal) && vMal.rows[0].e.length === 2 && vMal.rows[0].e.every((x) => /^publico\.(textos\.eslogan|contacto\.whatsapp): /.test(x)) && !vMal.rows[0].e.join('').includes('<b>'), JSON.stringify(vMal));
  const vAnon = await val('anon', {});
  T('anon no puede llamar config_restaurante_errores', err(vAnon, '42501'), JSON.stringify(vAnon));

  // ---- 9. catalogo
  const cat = (await db.query(`select p.proname, p.prosecdef, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('guardar_datos_restaurante', 'configuracion_errores', 'validar_configuracion')`)).rows;
  T('las 3 funciones nuevas: no son SECURITY DEFINER, anon no las ejecuta y authenticated si', cat.length === 3 && cat.every((x) => !x.prosecdef && !x.anon && x.auth), JSON.stringify(cat));

  return hallazgos;
}

/* ============================================================ */
async function main() {
  const t0 = Date.now();
  const mutaciones = process.argv.includes('--mutaciones');

  // ---- A. se aplica dos veces, reversa y otra vez
  const db = await baseConSql13();
  const tablas = ['pedidos', 'categorias', 'productos', 'configuracion', 'salud_notificaciones', 'restaurantes', 'miembros', 'tarifas_domicilio'];
  const foto = async () => JSON.stringify((await Promise.all(tablas.map((t) => db.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h, count(*)::int n from public.${t} x`)))).map((r) => r.rows[0]));
  const antes = await foto();
  let r1, r2;
  try { r1 = (await db.exec(SQL15())).pop().rows; } catch (e) { prueba('A1 el SQL 15 se aplica sin errores', false, e.message); }
  if (r1) {
    prueba(`A1 el SQL 15 se aplica y sus ${r1.length} comprobaciones dan OK`, r1.length >= 28 && r1.every((x) => x.estado === 'OK'), r1.filter((x) => x.estado !== 'OK').map((x) => x.verificacion + ' ' + x.detalle).join(' | '));
    try { r2 = (await db.exec(SQL15())).pop().rows; } catch (e) { prueba('A2 el SQL 15 se puede repetir', false, e.message); }
    if (r2) prueba('A2 el SQL 15 se puede repetir (idempotente): otra vez todo OK', r2.length === r1.length && r2.every((x) => x.estado === 'OK'), r2.filter((x) => x.estado !== 'OK').map((x) => x.verificacion).join(' | '));
    prueba('A3 el SQL 15 no cambio ningun dato (conteos y huellas de 8 tablas)', (await foto()) === antes, '');
  }

  // ---- B. la sonda
  const h = await sonda(db, { detalle: true });
  prueba(`B  la sonda de comportamiento: ${h.length === 0 ? 'todo se cumple' : h.length + ' cosas no se cumplen'}`, h.length === 0, h.slice(0, 3).join(' | '));

  // ---- A4. la reversa y volver a aplicar
  const db2 = await baseConSql13();
  await db2.exec(SQL15());
  const foto2 = async () => JSON.stringify((await Promise.all(tablas.map((t) => db2.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.${t} x`)))).map((r) => r.rows[0]));
  const f0 = await foto2();
  try {
    const rv = (await db2.exec(sql('15-revertir.sql'))).pop().rows;
    prueba(`A4 15-revertir.sql: ${rv.length} comprobaciones OK y no cambia datos`, rv.length >= 6 && rv.every((x) => x.estado === 'OK') && (await foto2()) === f0, rv.filter((x) => x.estado !== 'OK').map((x) => x.verificacion).join(' | '));
    const rv2 = (await db2.exec(sql('15-revertir.sql'))).pop().rows;
    prueba('A5 la reversa se puede repetir', rv2.every((x) => x.estado === 'OK'), '');
    const sin = (await db2.query(`select (select count(*) from pg_proc where proname in ('guardar_datos_restaurante', 'configuracion_errores', 'validar_configuracion'))::int f, (select count(*) from pg_trigger where tgname = 'configuracion_validar')::int t`)).rows[0];
    prueba('A6 despues de la reversa no queda ni la funcion ni el trigger', sin.f === 0 && sin.t === 0, JSON.stringify(sin));
    const c13 = (await db2.query(`select (select count(*) from pg_trigger where tgname in ('restaurantes_validar_config', 'restaurantes_proteger') and not tgisinternal and tgenabled <> 'D')::int t`)).rows[0];
    prueba('A7 el SQL 13 sigue en pie despues de la reversa', c13.t === 2, JSON.stringify(c13));
    const rr = (await db2.exec(SQL15())).pop().rows;
    prueba('A8 se vuelve a aplicar despues de la reversa', rr.every((x) => x.estado === 'OK'), '');
  } catch (e) { prueba('A4 la reversa', false, e.message); }

  // ---- C. escenarios
  {
    const d = await baseConSql13();
    await d.query(`update public.configuracion set horarios = jsonb_set(horarios, '{2,abre}', '"25:00"') where restaurante_id = $1`, [TAQ]);
    const f = async () => JSON.stringify((await d.query(`select md5(string_agg(c::text, '|')) h from public.configuracion c`)).rows[0]);
    const a = await f();
    let msg = '';
    try { await d.exec(SQL15()); } catch (e) { msg = e.message; await d.exec('rollback').catch(() => {}); }
    const quedo = (await d.query(`select (select count(*) from pg_proc where proname in ('guardar_datos_restaurante', 'configuracion_errores', 'validar_configuracion'))::int f, (select count(*) from pg_trigger where tgname = 'configuracion_validar')::int t`)).rows[0];
    prueba('C1 si el horario de Taqueiros no cumple las reglas, el SQL 15 se detiene SIN cambiar nada y dice que dia y que campo corregir',
      /MR paso 1\.2/.test(msg) && /horarios\.2\.abre/.test(msg) && quedo.f === 0 && quedo.t === 0 && (await f()) === a, msg.slice(0, 300) + JSON.stringify(quedo));
  }
  {
    const d = await baseConSql13();
    await d.query(`update public.configuracion set mensaje_cerrado = $2 where restaurante_id = $1`, [TAQ, '<b>cerrado</b>']);
    let msg = '';
    try { await d.exec(SQL15()); } catch (e) { msg = e.message; await d.exec('rollback').catch(() => {}); }
    prueba('C2 lo mismo si el mensaje de cerrado actual de Taqueiros tiene HTML (menciona mensaje_cerrado)', /MR paso 1\.2/.test(msg) && /mensaje_cerrado/.test(msg), msg.slice(0, 300));
  }
  {
    const d = await baseConSql13();
    await d.query(`insert into public.restaurantes (id, slug, nombre) values ($1, 'otro-c3', 'Otro C3')`, [OTRO]);
    await d.query(`alter table public.configuracion disable trigger all`).catch(() => {});
    await d.query(`update public.configuracion set horarios = '[]'::jsonb where restaurante_id = $1`, [OTRO]);
    await d.query(`alter table public.configuracion enable trigger all`).catch(() => {});
    let rows = null, msg = '';
    try { rows = (await d.exec(SQL15())).pop().rows; } catch (e) { msg = e.message; await d.exec('rollback').catch(() => {}); }
    const info = rows && rows.find((x) => /informativo/.test(x.verificacion));
    prueba('C3 un horario viejo invalido de OTRO restaurante no bloquea el SQL 15: solo se informa (el trigger lo validara cuando cambie su horario)', rows && rows.every((x) => x.estado === 'OK') && info && /otro-c3/.test(info.detalle), msg || JSON.stringify(info));
  }
  {
    const d = await crearBase({ con01y02: true });
    await sembrar(d);
    await d.exec(sql10()); await d.exec(sql('11-dominios.sql')); await d.exec(sql('12-config-publica.sql'));
    let msg = '';
    try { await d.exec(SQL15()); } catch (e) { msg = e.message; await d.exec('rollback').catch(() => {}); }
    prueba('C4 sin el SQL 13 el SQL 15 se detiene con un mensaje claro y no crea nada', /MR paso 0/.test(msg) && /13/.test(msg)
      && (await d.query(`select count(*)::int n from pg_proc where proname in ('guardar_datos_restaurante', 'configuracion_errores')`)).rows[0].n === 0, msg.slice(0, 250));
  }
  {
    const d = await baseConSql13();
    await d.exec(sql('14-retirar-regla-bucket.sql'));
    const rows = (await d.exec(SQL15())).pop().rows;
    prueba('C5 despues del SQL 14 el SQL 15 sigue dando todo OK', rows.every((x) => x.estado === 'OK'), rows.filter((x) => x.estado !== 'OK').map((x) => x.verificacion).join(' | '));
  }
  {
    const d = await baseConSql13();
    await d.exec(SQL15());
    // no volver a correr el SQL 13 despues: lo repone intacto y el 15 sigue
    const rows13 = (await d.exec(sql('13-endurecer.sql'))).pop().rows;
    const rows = (await d.exec(SQL15())).pop().rows;
    prueba('C6 el SQL 13 se puede volver a correr despues del 15 y el 15 se reaplica sin problema', rows13.every((x) => x.estado === 'OK') && rows.every((x) => x.estado === 'OK'), '');
  }

  // ---- E. las reglas del navegador (datos-restaurante.js) = las de la base
  {
    const { pruebaReglas } = await import('./reglas-navegador.mjs');
    await pruebaReglas({ baseConSql13, SQL15, prueba, TAQ, igual });
  }

  // ---- D. revision por mutacion
  if (mutaciones) {
    const { correrMutaciones } = await import('./mutaciones-15.mjs');
    const m = await correrMutaciones({ sonda, baseConSql13, SQL15 });
    prueba(`D  revision por mutacion del SQL 15: ${m.detectadas} detectadas, ${m.equivalentes} equivalentes declaradas, ${m.sobreviven.length} sin detectar`, m.sobreviven.length === 0 && m.errores.length === 0, m.sobreviven.concat(m.errores).join(' | '));
  }

  for (const r of resultados) console.log(`  ${r.ok ? 'PASA ' : 'FALLA'}  ${r.nombre}${r.ok ? '' : '\n          -> ' + r.info}`);
  const fallas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - fallas} PASAN, ${fallas} FALLAN. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  process.exitCode = fallas ? 1 : 0;
  setTimeout(() => process.exit(), 1500).unref();
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
