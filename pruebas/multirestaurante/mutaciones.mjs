/* =============================================================
   REVISION POR MUTACION DEL SQL 10

   Rompe a proposito, una por una, las defensas del SQL 10 (relaja una
   politica, apaga un trigger, abre una funcion...) y corre las pruebas
   locales (rls.mjs y hallazgos.mjs) contra cada version rota. Cada
   mutacion debe quedar DETECTADA: alguna prueba falla o la propia
   migracion se detiene en sus comprobaciones finales. Una mutacion NO
   detectada es una defensa que ninguna prueba vigila.

   USO:  node pruebas/multirestaurante/mutaciones.mjs [filtro]
         (filtro opcional: solo las mutaciones cuyo nombre lo contenga)
   Tarda ~10 s por mutacion. Sale con codigo 1 si alguna no se detecta.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
// Con core.autocrlf=true la copia de trabajo puede tener CRLF: se normaliza para buscar los textos.
const ORIGINAL = fs.readFileSync(path.join(aqui, '..', '..', 'supabase', '10-multirestaurante.sql'), 'utf8').replace(/\r\n/g, '\n');

/** Reemplaza la politica completa "create policy <nombre> on ... ;" por otra definicion. */
const politica = (nombre, nueva) => (s) => {
  const re = new RegExp(`create policy ${nombre} on [^;]*;`);
  if (!re.test(s)) throw new Error('no encontre la politica ' + nombre);
  return s.replace(re, () => nueva);   // funcion: un '$$' en el texto nuevo no se interpreta
};
/** Reemplaza un texto que debe aparecer exactamente una vez (dentro de 'dentro', si se indica). */
const cambiar = (de, a, dentro = null) => (s) => {
  if (dentro) {
    const i = s.indexOf(dentro);
    if (i < 0) throw new Error('no encontre el bloque: ' + dentro.slice(0, 60));
    const j = s.indexOf(de, i);
    if (j < 0) throw new Error('no encontre dentro del bloque: ' + de.slice(0, 60));
    return s.slice(0, j) + a + s.slice(j + de.length);
  }
  const n = s.split(de).length - 1;
  if (n !== 1) throw new Error(`"${de.slice(0, 60)}" aparece ${n} veces`);
  return s.split(de).join(a);
};
const varios = (...fs) => (s) => fs.reduce((x, f) => f(x), s);
const NOOP_TRIGGER = (fn) => cambiar(`create or replace function public.${fn}()\nreturns trigger\nlanguage plpgsql\nset search_path = ''\nas $$\n`,
  `create or replace function public.${fn}()\nreturns trigger\nlanguage plpgsql\nset search_path = ''\nas $$\nbegin return new; end;\n$$;\ncreate or replace function public.${fn}_original_mutado()\nreturns trigger\nlanguage plpgsql\nset search_path = ''\nas $$\n`);

const TODO = '(true)';
const MUTACIONES = [
  // ---- pedidos
  ['pedidos: SELECT para cualquiera', politica('mr_pedidos_select', `create policy mr_pedidos_select on public.pedidos for select to authenticated using ${TODO};`)],
  ['pedidos: INSERT sin control', politica('mr_pedidos_insert', `create policy mr_pedidos_insert on public.pedidos for insert to authenticated with check ${TODO};`)],
  ['pedidos: UPDATE sin WITH CHECK', politica('mr_pedidos_update', `create policy mr_pedidos_update on public.pedidos for update to authenticated using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero', 'cocina')) with check ${TODO};`)],
  ['pedidos: UPDATE para cualquier fila', politica('mr_pedidos_update', `create policy mr_pedidos_update on public.pedidos for update to authenticated using ${TODO} with check ${TODO};`)],
  ['pedidos: el dueno borra pedidos cobrados', cambiar(` and estado_pago <> 'aprobado'));`, `));`)],
  ['pedidos: DELETE para cualquiera', politica('mr_pedidos_delete', `create policy mr_pedidos_delete on public.pedidos for delete to authenticated using ${TODO};`)],
  ['pedidos: cocina puede crear pedidos', politica('mr_pedidos_insert', `create policy mr_pedidos_insert on public.pedidos for insert to authenticated with check ((select public.rol_en(restaurante_id)) in ('dueno', 'cajero', 'cocina'));`)],
  // ---- menu
  ['categorias: SELECT para cualquiera', politica('mr_categorias_select', `create policy mr_categorias_select on public.categorias for select to authenticated using ${TODO};`)],
  ['categorias: INSERT sin control', politica('mr_categorias_insert', `create policy mr_categorias_insert on public.categorias for insert to authenticated with check ${TODO};`)],
  ['categorias: UPDATE sin control', politica('mr_categorias_update', `create policy mr_categorias_update on public.categorias for update to authenticated using ${TODO} with check ${TODO};`)],
  ['categorias: DELETE sin control', politica('mr_categorias_delete', `create policy mr_categorias_delete on public.categorias for delete to authenticated using ${TODO};`)],
  ['productos: SELECT para cualquiera', politica('mr_productos_select', `create policy mr_productos_select on public.productos for select to authenticated using ${TODO};`)],
  ['productos: cocina lee el menu', politica('mr_productos_select', `create policy mr_productos_select on public.productos for select to authenticated using ((select public.rol_en(restaurante_id)) in ('dueno', 'cajero', 'cocina'));`)],
  ['productos: INSERT sin control', politica('mr_productos_insert', `create policy mr_productos_insert on public.productos for insert to authenticated with check ${TODO};`)],
  ['productos: UPDATE sin control', politica('mr_productos_update', `create policy mr_productos_update on public.productos for update to authenticated using ${TODO} with check ${TODO};`)],
  ['productos: UPDATE sin WITH CHECK', politica('mr_productos_update', `create policy mr_productos_update on public.productos for update to authenticated using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno') with check ${TODO};`)],
  // El WITH CHECK de productos es una capa redundante con el trigger restaurante_id
  // inmutable (los dos impiden mover un producto a otro restaurante): se prueban juntos.
  ['productos: UPDATE sin WITH CHECK y sin trigger de restaurante inmutable', varios(
    politica('mr_productos_update', `create policy mr_productos_update on public.productos for update to authenticated using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno') with check ${TODO};`),
    NOOP_TRIGGER('bloquear_cambio_restaurante'))],
  ['productos: el cajero edita el menu', politica('mr_productos_update', `create policy mr_productos_update on public.productos for update to authenticated using ((select public.rol_en(restaurante_id)) in ('dueno', 'cajero')) with check ((select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));`)],
  ['productos: DELETE sin control', politica('mr_productos_delete', `create policy mr_productos_delete on public.productos for delete to authenticated using ${TODO};`)],
  // ---- configuracion / salud / tarifas
  ['configuracion: SELECT para cualquiera', politica('mr_configuracion_select', `create policy mr_configuracion_select on public.configuracion for select to authenticated using ${TODO};`)],
  ['configuracion: el cajero la edita', politica('mr_configuracion_update', `create policy mr_configuracion_update on public.configuracion for update to authenticated using ((select public.rol_en(restaurante_id)) in ('dueno', 'cajero')) with check ((select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));`)],
  ['configuracion: UPDATE sin control', politica('mr_configuracion_update', `create policy mr_configuracion_update on public.configuracion for update to authenticated using ${TODO} with check ${TODO};`)],
  ['configuracion: el dueno inserta filas', politica('mr_configuracion_insert', `create policy mr_configuracion_insert on public.configuracion for insert to authenticated with check ((select public.rol_en(restaurante_id)) = 'dueno');`)],
  ['configuracion: el dueno la borra', politica('mr_configuracion_delete', `create policy mr_configuracion_delete on public.configuracion for delete to authenticated using ((select public.rol_en(restaurante_id)) = 'dueno');`)],
  ['salud: SELECT para cualquiera', politica('mr_salud_select', `create policy mr_salud_select on public.salud_notificaciones for select to authenticated using ${TODO};`)],
  ['salud: el dueno la escribe', politica('mr_salud_superadmin', `create policy mr_salud_superadmin on public.salud_notificaciones for all to authenticated using ((select public.rol_en(restaurante_id)) = 'dueno') with check ((select public.rol_en(restaurante_id)) = 'dueno');`)],
  ['tarifas: SELECT para cualquiera', politica('mr_tarifas_select', `create policy mr_tarifas_select on public.tarifas_domicilio for select to authenticated using ${TODO};`)],
  ['tarifas: INSERT sin control', politica('mr_tarifas_insert', `create policy mr_tarifas_insert on public.tarifas_domicilio for insert to authenticated with check ${TODO};`)],
  ['tarifas: UPDATE sin control', politica('mr_tarifas_update', `create policy mr_tarifas_update on public.tarifas_domicilio for update to authenticated using ${TODO} with check ${TODO};`)],
  ['tarifas: DELETE sin control', politica('mr_tarifas_delete', `create policy mr_tarifas_delete on public.tarifas_domicilio for delete to authenticated using ${TODO};`)],
  // ---- restaurantes, miembros, superadmins, secretos
  ['restaurantes: SELECT para cualquiera', politica('mr_restaurantes_select', `create policy mr_restaurantes_select on public.restaurantes for select to authenticated using ${TODO};`)],
  ['restaurantes: INSERT sin control', politica('mr_restaurantes_insert', `create policy mr_restaurantes_insert on public.restaurantes for insert to authenticated with check ${TODO};`)],
  ['restaurantes: UPDATE sin control', politica('mr_restaurantes_update', `create policy mr_restaurantes_update on public.restaurantes for update to authenticated using ${TODO} with check ${TODO};`)],
  ['restaurantes: el dueno lo borra', politica('mr_restaurantes_delete', `create policy mr_restaurantes_delete on public.restaurantes for delete to authenticated using ((select public.rol_en(id)) = 'dueno');`)],
  ['miembros: SELECT para cualquiera', politica('mr_miembros_select', `create policy mr_miembros_select on public.miembros for select to authenticated using ${TODO};`)],
  ['miembros: INSERT sin control', politica('mr_miembros_insert', `create policy mr_miembros_insert on public.miembros for insert to authenticated with check ${TODO};`)],
  ['miembros: el dueno agrega miembros a su restaurante', politica('mr_miembros_insert', `create policy mr_miembros_insert on public.miembros for insert to authenticated with check ((select public.rol_en(restaurante_id)) = 'dueno');`)],
  ['miembros: UPDATE sin control', politica('mr_miembros_update', `create policy mr_miembros_update on public.miembros for update to authenticated using ${TODO} with check ${TODO};`)],
  ['miembros: DELETE sin control', politica('mr_miembros_delete', `create policy mr_miembros_delete on public.miembros for delete to authenticated using ${TODO};`)],
  ['superadmins: SELECT para cualquiera', politica('mr_superadmins_select', `create policy mr_superadmins_select on public.superadmins for select to authenticated using ${TODO};`)],
  ['superadmins: INSERT abierto', cambiar(`revoke insert, update, delete, truncate, references, trigger on table public.superadmins from authenticated;`,
    `create policy mr_superadmins_insert on public.superadmins for insert to authenticated with check ${TODO};`)],
  ['restaurante_secretos: politica de lectura abierta', cambiar(`-- restaurante_secretos y contadores_pedido: SIN politicas.`,
    `create policy mr_secretos_select on public.restaurante_secretos for select to authenticated using ${TODO};\ngrant select on public.restaurante_secretos to authenticated;\n-- restaurante_secretos y contadores_pedido: SIN politicas.`)],
  ['contadores_pedido: escritura abierta', cambiar(`-- restaurante_secretos y contadores_pedido: SIN politicas.`,
    `create policy mr_contadores_all on public.contadores_pedido for all to authenticated using ${TODO} with check ${TODO};\ngrant all on public.contadores_pedido to authenticated;\n-- restaurante_secretos y contadores_pedido: SIN politicas.`)],
  ['restaurantes sin RLS', cambiar(`alter table public.restaurantes          enable row level security;\n`, ``)],
  // ---- funciones auxiliares
  ['es_superadmin() siempre true', cambiar(`select 1 from public.superadmins s where s.user_id = (select auth.uid())`, `select 1`)],
  ['es_miembro ignora activo', cambiar(`      and m.restaurante_id = p_restaurante_id\n      and m.activo\n  );`, `      and m.restaurante_id = p_restaurante_id\n  );`)],
  ['rol_en no mira el usuario', cambiar(`  select m.rol from public.miembros m\n  where m.user_id = (select auth.uid())\n`, `  select m.rol from public.miembros m\n  where true\n`)],
  // rol_en y es_miembro leen miembros como quien llama: la politica de miembros (cada uno ve
  // SUS filas) es una segunda capa. Se prueban juntas.
  ['rol_en no mira el usuario y miembros legible para todos', varios(
    cambiar(`  select m.rol from public.miembros m
  where m.user_id = (select auth.uid())
`, `  select m.rol from public.miembros m
  where true
`),
    politica('mr_miembros_select', `create policy mr_miembros_select on public.miembros for select to authenticated using ${TODO};`))],
  ['restaurante_actual ignora activo', cambiar(`  where m.user_id = (select auth.uid()) and m.activo\n  order by m.creado_en`, `  where m.user_id = (select auth.uid())\n  order by m.creado_en`)],
  // ---- triggers de proteccion
  ['sin trigger: restaurante_id inmutable', NOOP_TRIGGER('bloquear_cambio_restaurante')],
  ['sin trigger: cocina solo cambia estado', NOOP_TRIGGER('limitar_edicion_por_rol')],
  ['sin trigger: dueno no cambia plan/estado', NOOP_TRIGGER('proteger_campos_restaurante')],
  ['trigger de pago no protege numero', cambiar(`     or new.numero is distinct from old.numero\n`, ``)],
  ['trigger de pago no protege el total', cambiar(`  if new.total is distinct from old.total\n     or new.subtotal`, `  if new.subtotal`)],
  ['el cliente puede elegir su numero', cambiar(`es_cliente boolean := coalesce(claims, '') <> '' and (claims::jsonb) ->> 'role' is distinct from 'service_role';`, `es_cliente boolean := false;`)],
  ['siguiente_numero_pedido abierto a authenticated', cambiar(`grant execute on function public.siguiente_numero_pedido(uuid) to service_role;`, `grant execute on function public.siguiente_numero_pedido(uuid) to service_role, authenticated;`)],
  ['personal -> miembros da rol cajero en vez de inactivar al borrar', cambiar(`    update public.miembros set activo = false\n`, `    update public.miembros set rol = 'cajero'\n`)],
  // ---- validaciones del menu
  ['validar_producto busca la categoria en cualquier restaurante', cambiar(`                 where c.restaurante_id = new.restaurante_id and c.id = new.categoria) then`, `                 where c.id = new.categoria) then`)],
  ['validar_producto acepta la carpeta de otro restaurante', cambiar(`      elsif resto ~ ('^' || new.restaurante_id::text || '/[A-Za-z0-9._-]{1,100}$') then`, `      elsif resto ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$' then`)],
  // validar_producto y la FK compuesta son capas redundantes: se prueban juntas.
  ['sin FK compuesta y validar_producto sin restaurante', varios(
    cambiar(`                 where c.restaurante_id = new.restaurante_id and c.id = new.categoria) then`, `                 where c.id = new.categoria) then`),
    cambiar(`  alter table public.productos\n    add constraint productos_categoria_fkey\n    foreign key (restaurante_id, categoria) references public.categorias (restaurante_id, id)\n    on update cascade;\n`, ``))],
  ['sin FK compuesta producto -> categoria', cambiar(`  alter table public.productos\n    add constraint productos_categoria_fkey\n    foreign key (restaurante_id, categoria) references public.categorias (restaurante_id, id)\n    on update cascade;\n`, ``)],
  // ---- impresion
  ['reclamar_impresion sin comprobar membresia (y DEFINER)', varios(
    cambiar(`create or replace function public.reclamar_impresion(p_id bigint)\nreturns boolean\nlanguage plpgsql\n`, `create or replace function public.reclamar_impresion(p_id bigint)\nreturns boolean\nlanguage plpgsql\nsecurity definer\n`),
    cambiar(`  if v_rid is null\n     or not ((select public.es_superadmin())\n             or coalesce((select public.rol_en(v_rid)), '') in ('dueno', 'cajero', 'cocina')) then\n    raise exception 'No autorizado' using errcode = '42501';\n  end if;\n\n  update public.pedidos\n     set impreso_en = now()`,
      `  update public.pedidos\n     set impreso_en = now()`))],
  ['registrar_reimpresion sin comprobar membresia', cambiar(`  if v_rid is null\n     or not ((select public.es_superadmin())\n             or coalesce((select public.rol_en(v_rid)), '') in ('dueno', 'cajero', 'cocina')) then\n    raise exception 'No autorizado' using errcode = '42501';\n  end if;\n\n  update public.pedidos\n     set reimpresiones`, `  update public.pedidos\n     set reimpresiones`)],
  // ---- historial y jornada
  ['config_jornada no comprueba membresia', cambiar(`  where c.restaurante_id = p_restaurante\n    and ((select public.es_miembro(p_restaurante)) or (select public.es_superadmin()));`, `  where c.restaurante_id = p_restaurante;`)],
  ['buscar_historial DEFINER y sin filtro de restaurante', varios(
    cambiar(`returns setof public.pedidos\nlanguage sql\nstable\nset search_path = ''`, `returns setof public.pedidos\nlanguage sql\nstable\nsecurity definer\nset search_path = ''`),
    cambiar(`  join c on c.rid = p.restaurante_id\n  where p.estado <> 'pendiente_pago'\n    and (buscar_historial.fecha_desde`, `  cross join (select hora_corte_jornada as corte from public.configuracion where id = 1) c\n  where p.estado <> 'pendiente_pago'\n    and (buscar_historial.fecha_desde`))],
  ['resumen_jornada DEFINER y sin filtro de restaurante', varios(
    cambiar(`returns jsonb\nlanguage plpgsql\nstable\nset search_path = ''`, `returns jsonb\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''`),
    cambiar(`    from public.pedidos\n    where restaurante_id = v_rid\n      and creado_en >= lim.inicio\n      and creado_en <  lim.fin\n      and estado_pago = 'aprobado'`, `    from public.pedidos\n    where creado_en >= lim.inicio\n      and creado_en <  lim.fin\n      and estado_pago = 'aprobado'`))],
  ['jornadas_con_pedidos DEFINER y sin filtro de restaurante', varios(
    cambiar(`returns table (jornada date, pedidos bigint, ventas bigint, cancelados bigint)\nlanguage sql\nstable\nset search_path = ''`, `returns table (jornada date, pedidos bigint, ventas bigint, cancelados bigint)\nlanguage sql\nstable\nsecurity definer\nset search_path = ''`),
    cambiar(`  join c on c.rid = p.restaurante_id\n  where p.estado <> 'pendiente_pago'\n  group by 1`, `  cross join (select hora_corte_jornada as corte from public.configuracion where id = 1) c\n  where p.estado <> 'pendiente_pago'\n  group by 1`))],
  ['historial y jornada otra vez para anon', cambiar(`    'public.buscar_historial(date,date,text,text,uuid)', 'public.jornadas_con_pedidos(integer,uuid)'\n  ] loop\n    execute format('revoke all on function %s from public, anon', f);`,
    `    'public.buscar_historial(date,date,text,text,uuid)', 'public.jornadas_con_pedidos(integer,uuid)'\n  ] loop\n    execute format('grant execute on function %s to anon', f);`)],
  // ---- puertas publicas
  ['buscar_mis_pedidos no se acota al restaurante', cambiar(`  where p.restaurante_id = v_rid\n    and p.cliente_telefono = buscar_mis_pedidos.telefono`, `  where p.cliente_telefono = buscar_mis_pedidos.telefono`)],
  ['buscar_mis_pedidos sin limite de intentos', cambiar(`  if v_intentos > 10 then`, `  if v_intentos > 100000 then`)],
  ['intentos_buscar_pedido legible por authenticated', cambiar(`revoke all on table public.restaurante_secretos, public.contadores_pedido, public.personal,\n  public.intentos_buscar_pedido from authenticated;`,
    `revoke all on table public.restaurante_secretos, public.contadores_pedido, public.personal from authenticated;\ncreate policy mr_intentos_select on public.intentos_buscar_pedido for select to authenticated using ${TODO};`)],
  // ---- storage
  ['fotos: cualquier miembro (no solo el dueno) escribe', cambiar(`               and m.rol = 'dueno'\n`, ``, 'create or replace function public.puede_gestionar_fotos')],
  ['fotos: cualquier dueno escribe en la raiz', cambiar(`                       and m.restaurante_id = public.restaurante_taqueiros_id() ) ) ) );`, ` ) ) ) );`)],
  ['fotos: sin control de carpeta', cambiar(`               and ( m.restaurante_id::text = (storage.foldername(p_ruta))[1]`, `               and ( true`)],
  ['fotos: sin bloqueo de ..', cambiar(`  select p_ruta !~ '(^|/)\\.\\.(/|$)'\n     and (`, `  select (`)],
  ['fotos: INSERT de storage sin control', cambiar(`create policy mr_productos_fotos_insert on storage.objects for insert to authenticated\n  with check (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));`,
    `create policy mr_productos_fotos_insert on storage.objects for insert to authenticated\n  with check (bucket_id = 'productos');`)],
  ['fotos: DELETE de storage sin control', cambiar(`create policy mr_productos_fotos_delete on storage.objects for delete to authenticated\n  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));`,
    `create policy mr_productos_fotos_delete on storage.objects for delete to authenticated\n  using (bucket_id = 'productos');`)],
  ['fotos: UPDATE de storage sin control', cambiar(`create policy mr_productos_fotos_update on storage.objects for update to authenticated\n  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)))\n  with check (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));`,
    `create policy mr_productos_fotos_update on storage.objects for update to authenticated\n  using (bucket_id = 'productos')\n  with check (bucket_id = 'productos');`)],
  // Postgres aplica la politica SELECT tambien a la fila NUEVA de un UPDATE: es la segunda capa.
  ['fotos: UPDATE y SELECT de storage sin control', varios(
    cambiar(`create policy mr_productos_fotos_update on storage.objects for update to authenticated
  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)))
  with check (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));`,
      `create policy mr_productos_fotos_update on storage.objects for update to authenticated
  using (bucket_id = 'productos')
  with check (bucket_id = 'productos');`),
    cambiar(`create policy mr_productos_fotos_select on storage.objects for select to authenticated
  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));`,
      `create policy mr_productos_fotos_select on storage.objects for select to authenticated
  using (bucket_id = 'productos');`))],
  ['fotos: SELECT de storage sin control', cambiar(`create policy mr_productos_fotos_select on storage.objects for select to authenticated\n  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));`,
    `create policy mr_productos_fotos_select on storage.objects for select to authenticated\n  using (bucket_id = 'productos');`)],
  // ---- barridos y comprobaciones
  ['sin barrido de EXECUTE para anon', cambiar(`    execute format('revoke execute on function %s from public, anon', r.firma);\n  end loop;`, `    null;\n  end loop;`)],
  ['sin REVOKE de tablas a anon', cambiar(`  public.intentos_buscar_pedido\nfrom anon;`, `  public.intentos_buscar_pedido\nfrom service_role;`)],
  ['no se borran las politicas antiguas', cambiar(`    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);`, `    if r.policyname like 'mr\\_%' then execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename); end if;`)],
  ['no se borran las firmas viejas', cambiar(`    execute format('drop function %s', r.firma);\n  end loop;`, `    if r.firma like '%uuid%' or r.firma in ('limites_jornada(date)', 'resumen_jornada(date)', 'buscar_historial(date,date,text,text)', 'jornadas_con_pedidos(integer)', 'buscar_mis_pedidos(text,integer)') then execute format('drop function %s', r.firma); end if;\n  end loop;`)],
  ['sin comprobacion de funciones DEFINER desconocidas', cambiar(`  ('ninguna funcion SECURITY DEFINER desconocida la pueden llamar anon o authenticated',\n    not exists (`, `  ('ninguna funcion SECURITY DEFINER desconocida la pueden llamar anon o authenticated',\n    true or not exists (`)],
  ['sin comprobacion de vistas', cambiar(`  ('ninguna vista de public que lean anon o authenticated salta RLS',\n    not exists (`, `  ('ninguna vista de public que lean anon o authenticated salta RLS',\n    true or not exists (`)],
  ['sin comprobacion de triggers de auth.users', cambiar(`  ('ningun trigger de auth.users da membresia automatica (personal, miembros, superadmins)',\n    not exists (`, `  ('ningun trigger de auth.users da membresia automatica (personal, miembros, superadmins)',\n    true or not exists (`)],
  ['sin aviso a PostgREST', cambiar(`notify pgrst, 'reload schema';`, ``)],
  ['el alta pone id=1 a todos los restaurantes', cambiar(`  values (\n    new.id,\n    case when new.id = public.restaurante_taqueiros_id() then 1 else 0 end,`, `  values (\n    new.id,\n    1,`)],
];

// Mutaciones que NO cambian lo que un atacante puede hacer porque otra capa cubre lo mismo
// (su version combinada, que quita las dos capas, si se detecta). No hacen fallar la corrida.
const EQUIVALENTES = {
  'productos: UPDATE sin WITH CHECK': 'el trigger restaurante_id inmutable impide igual mover el producto; ver la combinada',
  'rol_en no mira el usuario': 'rol_en lee miembros como quien llama y esa tabla solo le muestra SUS filas; ver la combinada',
  'restaurante_actual ignora activo': 'un miembro inactivo igual no lee nada: RLS usa es_miembro (exige activo) y config_jornada tambien',
  'trigger de pago no protege el total': 'la restriccion total = subtotal + costo_domicilio impide cambiar solo el total, y esos dos si estan protegidos',
  'validar_producto busca la categoria en cualquier restaurante': 'la FK compuesta (restaurante_id, categoria) lo impide igual; ver la combinada',
  'historial y jornada otra vez para anon': 'el barrido final revoca EXECUTE a anon en todas las funciones; ver "sin barrido"',
  'fotos: UPDATE de storage sin control': 'Postgres aplica tambien la politica SELECT a la fila NUEVA de un UPDATE; ver la combinada',
};

function correr(script, archivo) {
  return new Promise((res) => {
    const h = spawn(process.execPath, [path.join(aqui, script)], { env: { ...process.env, SQL10_ARCHIVO: archivo }, stdio: ['ignore', 'pipe', 'pipe'] });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; });
    h.stderr.on('data', (d) => { salida += d; });
    h.on('exit', (code) => res({ code, salida }));
  });
}

const filtro = process.argv[2] || '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutsql10-'));
const filas = [];
for (const [nombre, f] of MUTACIONES) {
  if (filtro && !nombre.includes(filtro)) continue;
  let texto;
  try { texto = f(ORIGINAL); } catch (e) { filas.push({ nombre, estado: 'ERROR DE MUTACION', por: e.message }); console.log('ERROR      ' + nombre + ' -> ' + e.message); continue; }
  if (texto === ORIGINAL) { filas.push({ nombre, estado: 'ERROR DE MUTACION', por: 'sin cambios' }); continue; }
  const archivo = path.join(dir, 'mut.sql');
  fs.writeFileSync(archivo, texto);
  if (process.env.MUT_GUARDAR) fs.writeFileSync(process.env.MUT_GUARDAR, texto);   // para depurar una mutacion
  const r1 = await correr('rls.mjs', archivo);
  const r2 = await correr('hallazgos.mjs', archivo);
  const fallasDe = (r) => (r.salida.match(/^FALLA.*$/gm) || []).map((x) => x.replace(/\s+->.*/, '').replace(/^FALLA\s+/, ''));
  const abortada = /LA MIGRACION SE REVIRTIO/.test(r1.salida);
  // Si el SQL mutado no llego a aplicarse y no fue su propia verificacion la que lo detuvo, es
  // invalido: eso no cuenta como deteccion. (Si se aplico y la bateria se cayo, si cuenta.)
  if (!abortada && !r1.salida.includes('[SQL 10 aplicado]')) {
    filas.push({ nombre, estado: 'ERROR DE MUTACION', por: (r1.salida.match(/FALLO:.*|Error.*/) || [r1.salida.slice(-160)])[0] });
    console.log('ERROR      ' + nombre + ' -> SQL mutado invalido: ' + filas[filas.length - 1].por.slice(0, 160));
    continue;
  }
  const detectada = r1.code !== 0 || r2.code !== 0;
  const por = abortada ? 'la migracion se detuvo (comprobaciones finales)' : [...fallasDe(r1), ...fallasDe(r2)].slice(0, 2).join(' | ') || (r1.code ? r1.salida.slice(-200) : '');
  const estado = detectada ? 'DETECTADA' : (EQUIVALENTES[nombre] ? 'EQUIVALENTE' : 'NO DETECTADA');
  filas.push({ nombre, estado, por: detectada ? por : (EQUIVALENTES[nombre] || '') });
  console.log(estado.padEnd(12) + ' ' + nombre +
    (detectada ? '   <- ' + por.slice(0, 140) : (EQUIVALENTES[nombre] ? '   (' + EQUIVALENTES[nombre] + ')' : '')));
  // Con filtro se muestra el detalle completo de lo que fallo
  if (filtro) [...fallasDe(r1), ...fallasDe(r2)].forEach((x) => console.log('     falla: ' + x));
}
fs.rmSync(dir, { recursive: true, force: true });
const malas = filas.filter((x) => x.estado !== 'DETECTADA' && x.estado !== 'EQUIVALENTE');
const equiv = filas.filter((x) => x.estado === 'EQUIVALENTE').length;
console.log(`\n${filas.length - malas.length - equiv}/${filas.length} mutaciones detectadas, ${equiv} equivalentes (otra capa cubre lo mismo).` +
  (malas.length ? ' Sin detectar o con error: ' + malas.map((x) => x.nombre).join('; ') : ''));
process.exitCode = malas.length ? 1 : 0;
