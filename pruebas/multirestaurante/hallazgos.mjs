/* =============================================================
   PRUEBAS DE LOS HALLAZGOS DE LA REVISION DE SEGURIDAD DEL SQL 10

   Cada escenario arma una base NUEVA en el simulador (sim.mjs) con
   la condicion que provoca el hueco (por ejemplo una funcion vieja que
   quedo en la base real, o un trigger creado a mano), corre el SQL 10
   y ataca como lo haria un usuario de otro restaurante o un anonimo.

   Se escribieron ANTES de corregir: contra el SQL 10 del commit 43b6567
   fallan, contra el corregido pasan. Para repetir esa comparacion:
     cmd /c "git show 43b6567:supabase/10-multirestaurante.sql > %TEMP%\sql10-viejo.sql"
     $env:SQL10_ARCHIVO = "$env:TEMP\sql10-viejo.sql"; node pruebas/multirestaurante/hallazgos.mjs
     Remove-Item Env:SQL10_ARCHIVO;                    node pruebas/multirestaurante/hallazgos.mjs

   Necesita (una vez): npm i --no-save @electric-sql/pglite@0.2.17
============================================================= */
import { crearBase, sembrar, sql10, intentar, U } from './sim.mjs';

const TAQ = '00000000-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const dA = 'a0000000-0000-4000-8000-00000000000a';

let fallas = 0, total = 0;
const T = (nombre, cond, detalle = '') => {
  total++; if (!cond) fallas++;
  console.log((cond ? 'PASA   ' : 'FALLA  ') + nombre + (cond ? '' : '   -> ' + String(detalle).slice(0, 220)));
};

/** Base con los SQL antiguos + datos de Taqueiros; 'antes' corre SQL arbitrario previo a la migracion. */
async function escenario({ antes = '' } = {}) {
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  if (antes) await db.exec(antes);
  let error = null;
  try { await db.exec(sql10()); } catch (e) { error = e; }
  // Tras un fallo la sesion queda en una transaccion abortada; el SQL Editor la revierte solo.
  if (error) { try { await db.exec('rollback'); } catch { /* ya revertida */ } }
  return { db, error };
}

/** Restaurantes A y B, dueno de A, y un pedido pagado en B con datos personales. */
async function poblar(db) {
  await db.query(`insert into auth.users (id, email) values ($1, 'da@t.test')`, [dA]);
  await db.exec(`
    insert into public.restaurantes (id, slug, nombre) values ('${A}', 'test-a', 'A'), ('${B}', 'test-b', 'B');
    insert into public.miembros (user_id, restaurante_id, rol) values ('${dA}', '${A}', 'dueno');
    insert into public.pedidos (restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, direccion,
                                items, subtotal, costo_domicilio, total, estado_pago, pagado_en, alerta_enviada)
    values ('${B}', 'REF-B-SECRETA', 'nuevo', 'Victima B', '3119998888', 'domicilio', 'Calle secreta 123',
            '[]', 42000, 5000, 47000, 'aprobado', now(), true);
  `);
}

// -----------------------------------------------------------------
console.log('\n[H1] Versiones viejas de las funciones (otras firmas) que sobreviven a la migracion');
{
  // En produccion se revoco a mano "buscar_historial, resumen_jornada y jornadas_con_pedidos
  // (cualquier firma)": hay o hubo mas de una firma. Una firma vieja SECURITY DEFINER que
  // no se borre sigue leyendo TODOS los pedidos para cualquier usuario con sesion.
  const { db, error } = await escenario({ antes: `
    create function public.buscar_historial(texto text) returns setof public.pedidos
      language sql stable security definer set search_path = public
      as $$ select * from public.pedidos where cliente_telefono like '%' || texto || '%' $$;
    create function public.jornadas_con_pedidos() returns setof public.pedidos
      language sql stable security definer set search_path = public
      as $$ select * from public.pedidos $$;
    -- el parche manual que ya se aplico en produccion
    revoke execute on function public.buscar_historial(date, date, text, text) from public, anon;
    revoke execute on function public.resumen_jornada(date) from public, anon;
    revoke execute on function public.jornadas_con_pedidos(integer) from public, anon;
    revoke execute on function public.buscar_historial(text) from public, anon;
    revoke execute on function public.jornadas_con_pedidos() from public, anon;
  ` });
  T('la migracion corre con el parche manual ya aplicado', !error, error && error.message);
  if (!error) {
    await poblar(db);
    let r = await intentar(db, dA, `select referencia, direccion from public.buscar_historial(texto => '3')`);
    T('dueno de A NO puede leer pedidos de B con una firma vieja de buscar_historial', !r.ok || r.rows.every((x) => x.referencia !== 'REF-B-SECRETA'), JSON.stringify(r).slice(0, 160));
    r = await intentar(db, dA, `select count(*)::int as n from public.jornadas_con_pedidos()`);
    T('dueno de A NO puede leer pedidos ajenos con jornadas_con_pedidos() sin argumentos', !r.ok || r.rows[0].n === 0, JSON.stringify(r).slice(0, 160));
    const n = (await db.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace
                               and proname in ('buscar_historial','jornadas_con_pedidos','resumen_jornada','limites_jornada','buscar_mis_pedidos')`)).rows[0].n;
    T('de cada funcion reemplazada queda UNA sola firma (las 5)', n === 5, `${n} firmas`);
    r = await intentar(db, dA, `select * from public.jornadas_con_pedidos(limite => 60)`);
    T('historial.html sigue llamando jornadas_con_pedidos({limite}) sin ambiguedad', r.ok, JSON.stringify(r).slice(0, 160));
  }
}

console.log('\n[H1b] Una firma extra de una funcion PUBLICA (seguimiento) queda abierta a anon');
{
  // El barrido de permisos exceptuaba por NOMBRE: cualquier seguimiento(...) o
  // buscar_mis_pedidos(...) extra conservaba el EXECUTE de anon. Con un id
  // secuencial, un anonimo enumera direcciones de todos los restaurantes.
  const { db, error } = await escenario({ antes: `
    create function public.seguimiento(p_id bigint) returns table (direccion text, cliente_nombre text)
      language sql stable security definer set search_path = public
      as $$ select direccion, cliente_nombre from public.pedidos where id = p_id $$;
  ` });
  let anonLee = false;
  if (!error) {
    await poblar(db);
    const idB = (await db.query(`select id from public.pedidos where referencia = 'REF-B-SECRETA'`)).rows[0].id;
    const r = await intentar(db, null, `select * from public.seguimiento(p_id => ${idB}::bigint)`, [], { rol: 'anon' });
    anonLee = r.ok && r.rows.length > 0;
  }
  T('anon NO puede enumerar pedidos por id con una firma extra de seguimiento', !anonLee, 'anon leyo la direccion de un pedido de B');
  T('la migracion se detiene y nombra la funcion SECURITY DEFINER desconocida',
    !!error && /seguimiento\(bigint\)/.test(error.message), error ? error.message.slice(0, 200) : 'la migracion termino sin avisar');
}

console.log('\n[H1c] Una funcion SECURITY DEFINER de otro dueno (que el SQL no puede revocar)');
{
  // En Supabase postgres NO es superusuario: el barrido no puede revocar funciones de
  // otro dueno (p. ej. supabase_admin) y la verificacion final tambien las ignoraba,
  // asi que una de ellas abierta a anon/authenticated pasaba sin aviso. En este
  // simulador postgres SI es superusuario y el barrido alcanza a revocarla para anon;
  // por eso aqui se comprueba sobre todo que la migracion la detecte y se detenga.
  const { db, error } = await escenario({ antes: `
    create role otro_dueno nologin bypassrls;   -- como supabase_admin
    grant usage, create on schema public to otro_dueno;
    create function public.listar_clientes() returns table (cliente_telefono text, direccion text)
      language sql stable security definer set search_path = public
      as $$ select cliente_telefono, direccion from public.pedidos $$;
    alter function public.listar_clientes() owner to otro_dueno;
    grant select on public.pedidos to otro_dueno;
    grant execute on function public.listar_clientes() to anon, authenticated;
  ` });
  let anonLee = false;
  if (!error) {
    const r = await intentar(db, null, `select * from public.listar_clientes()`, [], { rol: 'anon' });
    anonLee = r.ok && r.rows.length > 0;
  }
  T('anon NO lee clientes por una funcion de otro dueno', !anonLee, 'anon listo telefonos y direcciones');
  T('la migracion se detiene y nombra la funcion', !!error && /listar_clientes/.test(error.message), error ? error.message.slice(0, 200) : 'la migracion termino sin avisar');
}

console.log('\n[H2] buscar_mis_pedidos: adivinar el total por fuerza bruta (telefono conocido)');
{
  // El "segundo factor" es el total exacto: unas pocas centenas de valores posibles.
  // Con la referencia que devuelve, seguimiento(ref) entrega direccion, barrio e indicaciones.
  const { db, error } = await escenario();
  T('migracion OK', !error, error && error.message);
  await db.exec(`insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, direccion, items, subtotal, costo_domicilio, total, estado_pago, pagado_en)
                 values ('TAQ-VICTIMA', 'nuevo', 'Victima', '3001234567', 'domicilio', 'Cra 1 # 2-3', '[]', 42000, 5000, 47000, 'aprobado', now())`);
  let encontrada = null, intentos = 0;
  for (let t = 1000; t <= 100000 && !encontrada; t += 1000) {
    intentos++;
    const r = await intentar(db, null, `select * from public.buscar_mis_pedidos(telefono => '3001234567', total_pagado => ${t})`, [], { rol: 'anon' });
    if (r.ok && r.rows.length) encontrada = r.rows[0].referencia;
  }
  let direccion = null;
  if (encontrada) {
    const s = await intentar(db, null, `select direccion from public.seguimiento('${encontrada}')`, [], { rol: 'anon' });
    direccion = s.ok && s.rows[0] ? s.rows[0].direccion : null;
  }
  T('un anonimo NO obtiene la direccion probando totales con un telefono conocido', !direccion, `encontro ${encontrada} en ${intentos} intentos -> direccion "${direccion}"`);

  await db.exec(`insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago, pagado_en)
                 values ('TAQ-LEGITIMO', 'nuevo', 'Cliente', '3007654321', 'llevar', '[]', 30000, 0, 30000, 'aprobado', now())`);
  const ok = await intentar(db, null, `select referencia from public.buscar_mis_pedidos(telefono => '3007654321', total_pagado => 30000)`, [], { rol: 'anon' });
  T('el cliente legitimo (otro telefono, datos correctos) SI encuentra su pedido', ok.ok && ok.rows.length === 1, JSON.stringify(ok));
  let r;
  for (let i = 0; i < 3; i++) r = await intentar(db, null, `select referencia from public.buscar_mis_pedidos(telefono => '3007654321', total_pagado => 30000)`, [], { rol: 'anon' });
  T('... y puede repetir la busqueda unas cuantas veces', r.ok && r.rows.length === 1, JSON.stringify(r));
  const tabla = await intentar(db, null, `select * from public.intentos_buscar_pedido`, [], { rol: 'anon' });
  T('anon no lee el registro de intentos', !tabla.ok || tabla.rows.length === 0, JSON.stringify(tabla).slice(0, 120));
  const tabla2 = await intentar(db, U.dueno_taq, `select * from public.intentos_buscar_pedido`);
  T('un dueno tampoco lee el registro de intentos', !tabla2.ok || tabla2.rows.length === 0, JSON.stringify(tabla2).slice(0, 120));
}

console.log('\n[H3] Membresia automatica: trigger en auth.users que escribe en personal');
{
  // Plantilla tipica de Supabase ("handle_new_user"). Con el trigger personal -> miembros
  // del SQL 10, CADA usuario nuevo (por ejemplo el dueno de un cliente nuevo creado por
  // Carlos) quedaria como DUENO de Taqueiros.
  const { db, error } = await escenario({ antes: `
    create function public.al_crear_usuario() returns trigger language plpgsql security definer set search_path = public
      as $$ begin insert into public.personal (id, nombre) values (new.id, new.email); return new; end $$;
    create trigger al_crear_usuario after insert on auth.users for each row execute function public.al_crear_usuario();
  ` });
  let esDueno = false;
  if (!error) {
    const nuevo = 'e0000000-0000-4000-8000-0000000000ee';
    await db.query(`insert into auth.users (id, email) values ($1, 'cliente-nuevo@x.test')`, [nuevo]);
    const r = await intentar(db, nuevo, `select count(*)::int n from public.pedidos`);
    esDueno = r.ok && r.rows[0].n > 0;
  }
  T('una cuenta nueva NO ve los pedidos de Taqueiros', !esDueno, 'la cuenta nueva quedo como dueno de Taqueiros');
  T('la migracion se detiene y nombra el trigger de auth.users', !!error && /al_crear_usuario/.test(error.message), error ? error.message.slice(0, 200) : 'la migracion termino sin avisar');
}

console.log('\n[H4] Una vista sin security_invoker salta RLS');
{
  const { db, error } = await escenario({ antes: `
    create view public.pedidos_resumen as select id, cliente_nombre, cliente_telefono, direccion from public.pedidos;
    grant select on public.pedidos_resumen to authenticated;
  ` });
  let leeAjeno = false;
  if (!error) {
    await poblar(db);
    const r = await intentar(db, dA, `select count(*)::int n from public.pedidos_resumen`);
    leeAjeno = r.ok && r.rows[0].n > 0;
  }
  T('el dueno de A NO lee pedidos ajenos por una vista', !leeAjeno, 'la vista devolvio pedidos de Taqueiros y de B');
  T('la migracion se detiene y nombra la vista', !!error && /pedidos_resumen/.test(error.message), error ? error.message.slice(0, 200) : 'la migracion termino sin avisar');
}

console.log('\n[H5] PostgREST debe recargar su esquema al terminar');
{
  // Se borran y recrean funciones con otra firma: si PostgREST no recarga, el panel
  // llama a la firma vieja y recibe 404 hasta que alguien recargue a mano.
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  const avisos = [];
  await db.listen('pgrst', (msg) => avisos.push(msg));
  await db.exec(sql10());
  await new Promise((r) => setTimeout(r, 200));
  T('al confirmar, el SQL avisa a PostgREST (NOTIFY pgrst, \'reload schema\')', avisos.includes('reload schema'), JSON.stringify(avisos));
}

console.log('\n[P] Hueco que existe HOY en produccion (antes del SQL 10): anon borra pedidos en curso');
{
  // limpiar_pedidos_huerfanos(horas) es SECURITY DEFINER y en Supabase "revoke from public"
  // no le quita el EXECUTE a anon (la inspeccion real lo mostro). Con horas = 0 un anonimo
  // borra los pedidos 'pendiente_pago' recien creados: el cliente paga en Wompi, el webhook
  // no encuentra el pedido y la comida nunca llega a la cocina.
  const db = await crearBase({ con01y02: true });
  await sembrar(db);
  const nuevo = `insert into public.pedidos (referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, total, estado_pago)
                 values ($1, 'pendiente_pago', 'Pagando', '3005550000', 'llevar', '[]', 30000, 30000, 'pendiente')`;
  await db.query(nuevo, ['TAQ-PAGANDO-1']);
  let r = await intentar(db, null, `select public.limpiar_pedidos_huerfanos(0) as n`, [], { rol: 'anon' });
  const borradoAntes = r.ok && r.rows[0].n > 0;
  T('ANTES del SQL 10 (base de hoy): anon SI puede borrar un pedido que se esta pagando (se espera true)', borradoAntes, JSON.stringify(r));
  await db.exec(sql10());
  await db.query(nuevo, ['TAQ-PAGANDO-2']);
  r = await intentar(db, null, `select public.limpiar_pedidos_huerfanos(0) as n`, [], { rol: 'anon' });
  const sigue = (await db.query(`select count(*)::int n from public.pedidos where referencia = 'TAQ-PAGANDO-2'`)).rows[0].n;
  T('DESPUES del SQL 10: anon ya no puede, y el pedido sigue ahi', !r.ok && sigue === 1, JSON.stringify(r));
}

console.log('\n[V] Visibilidad de errores: el SQL Editor solo muestra el mensaje, asi que debe decir en que paso fallo');
{
  // Una tabla ajena con llave foranea hacia categorias impide reemplazar su llave primaria (paso 4.1).
  const { db, error } = await escenario({ antes: `create table public.ref_categorias (c text references public.categorias(id));` });
  T('un paso que falla se identifica: "MR paso 4.1 ..."', !!error && /^MR paso 4\.1/.test(error.message), error ? error.message.slice(0, 200) : 'la migracion no fallo');
  T('... y cuenta que objeto fallo', !!error && /elemento|constraint|depend/i.test(error.message), error && error.message.slice(0, 200));
  const huella = await db.query(`select to_regclass('public.restaurantes') is not null as hay_restaurantes,
                                        exists (select 1 from information_schema.columns where table_name = 'pedidos' and column_name = 'restaurante_id') as hay_columna`);
  T('... y todo se revirtio (no quedo restaurantes ni restaurante_id)', !huella.rows[0].hay_restaurantes && !huella.rows[0].hay_columna, JSON.stringify(huella.rows[0]));
}
{
  // Sin permiso para crear politicas en storage.objects (simulado con un event trigger que lo impide)
  const { db, error } = await escenario({ antes: `
    create function public.prohibir_politicas_storage() returns event_trigger language plpgsql as $$
      declare r record;
      begin
        for r in select * from pg_event_trigger_ddl_commands() loop
          if r.command_tag = 'CREATE POLICY' and r.object_identity like '% on storage.objects' then
            raise exception 'must be owner of table objects';
          end if;
        end loop;
      end $$;
    create event trigger sim_sin_permiso_storage on ddl_command_end execute function public.prohibir_politicas_storage();
  ` });
  T('sin permiso sobre storage.objects la migracion se detiene con un mensaje claro',
    !!error && /MR paso 10 \(Storage\)/.test(error.message) && /must be owner/.test(error.message), error ? error.message.slice(0, 220) : 'la migracion no fallo');
  if (error) {
    const huella = await db.query(`select to_regclass('public.restaurantes') is not null as hay`);
    T('... y todo se revirtio', !huella.rows[0].hay, JSON.stringify(huella.rows[0]));
  }
}

console.log('\n[C] Compatibilidad con el parche manual ya aplicado en produccion');
{
  const { db, error } = await escenario({ antes: `
    revoke execute on function public.buscar_historial(date, date, text, text) from public, anon;
    revoke execute on function public.resumen_jornada(date) from public, anon;
    revoke execute on function public.jornadas_con_pedidos(integer) from public, anon;
  ` });
  T('la migracion corre sobre el parche', !error, error && error.message);
  if (!error) {
    const P = U.dueno_taq;
    let r = await intentar(db, P, `select public.resumen_jornada() as r`);
    T('el panel de Taqueiros sigue con resumen_jornada()', r.ok && r.rows[0].r !== null, JSON.stringify(r).slice(0, 120));
    r = await intentar(db, P, `select * from public.buscar_historial(fecha_desde => null, fecha_hasta => null, telefono => '', referencia => '')`);
    T('... y con buscar_historial (4 parametros con nombre)', r.ok && r.rows.length > 0, JSON.stringify(r).slice(0, 120));
    r = await intentar(db, null, `select public.resumen_jornada()`, [], { rol: 'anon' });
    T('anon sigue sin poder llamarlas', !r.ok);
    const { error: e2 } = await (async () => { try { await db.exec(sql10()); return {}; } catch (e) { return { error: e }; } })();
    T('y se puede volver a correr (idempotente)', !e2, e2 && e2.message);
  }
}

console.log(`\n${total - fallas}/${total} pruebas de hallazgos pasan, ${fallas} fallan`);
process.exitCode = fallas ? 1 : 0;
