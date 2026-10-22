/* =============================================================
   REVISION POR MUTACION DEL PASO 3A  (SQL 16, SQL 16b, api/superadmin.js, horario-regla.js, cron)

     node pruebas/multirestaurante/mutaciones-16.mjs                  todas
     node pruebas/multirestaurante/mutaciones-16.mjs --solo="exigir"  solo las que casen

   Rompe A PROPOSITO, una por una, cada defensa del paso (la comprobacion de superadmin, los permisos de las funciones, la
   auditoria de solo agregar, la cuenta de la vigencia, la regla R4 de los secretos, el limite de intentos, la regla del horario,
   el 401 del cron...) y exige que ALGUNA prueba lo detecte:
     * mutaciones del SQL 16 / 16b  -> sql16.mjs y superadmin.mjs (con SQL16_ARCHIVO / SQL16B_ARCHIVO apuntando a la copia rota)
     * mutaciones de api/ y horario-regla.js -> una copia de la carpeta, probada con superadmin.mjs / horario-regla.test.js / cron.test.js
   Una mutacion que no detecta nadie es una defensa sin prueba. Las "equivalentes" (romper la defensa no cambia lo que un atacante
   puede hacer, porque otra capa lo cubre) estan declaradas con su razon.
============================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const solo = (process.argv.find((a) => a.startsWith('--solo=')) || '').slice(7);
const SQL16 = fs.readFileSync(path.join(RAIZ, 'supabase', '16-superadmin.sql'), 'utf8');
const SQL16B = fs.readFileSync(path.join(RAIZ, 'supabase', '16b-horario.sql'), 'utf8');

/* [nombre, archivo, viejo, nuevo, suites, { equivalente? }]  ('viejo' tiene que aparecer EXACTAMENTE una vez) */
const M = [];
const m = (nombre, archivo, viejo, nuevo, suites, extra = {}) => M.push({ nombre, archivo, viejo, nuevo, suites, ...extra });

// CONTROL: no cambia nada. Las suites tienen que PASAR en la copia; si alguna falla, la copia no corre limpia y las demas detecciones no valen.
m('CONTROL (sin cambios)', '16-superadmin.sql', 'create or replace function public.exigir_superadmin(p_actor uuid)', 'create or replace function public.exigir_superadmin(p_actor uuid)', ['sql16', 'superadmin', 'servidor', 'servidor-vigencia', 'cron', 'horario'], { control: true });
// ---- SQL 16: quien puede ejecutar y que verifican ----
m('SQL exigir_superadmin: nunca rechaza', '16-superadmin.sql', "if p_actor is null or not exists (select 1 from public.superadmins s where s.user_id = p_actor) then", 'if false then', ['sql16', 'superadmin']);
m('SQL exigir_superadmin: un actor nulo pasa', '16-superadmin.sql', "if p_actor is null or not exists (select 1 from public.superadmins s where s.user_id = p_actor) then", "if not exists (select 1 from public.superadmins s where s.user_id = p_actor) and p_actor is not null then", ['sql16']);
m('SQL sa_listar_restaurantes no exige superadmin', '16-superadmin.sql', "begin\n  perform public.exigir_superadmin(p_actor);\n  return coalesce((\n    select jsonb_agg(x.fila order by x.creado_en, x.slug)", "begin\n  return coalesce((\n    select jsonb_agg(x.fila order by x.creado_en, x.slug)", ['sql16']);
m('SQL sa_guardar_secretos no exige superadmin', '16-superadmin.sql', "begin\n  perform public.exigir_superadmin(p_actor);\n\n  if p_valores is null or jsonb_typeof(p_valores) <> 'object' or p_valores = '{}'::jsonb then", "begin\n  if p_valores is null or jsonb_typeof(p_valores) <> 'object' or p_valores = '{}'::jsonb then", ['sql16']);
m('SQL sa_crear_restaurante no exige superadmin', '16-superadmin.sql', "begin\n  perform public.exigir_superadmin(p_actor);\n\n  -- slug", "begin\n  -- slug", ['sql16']);
m('SQL sa_registrar_pago no exige superadmin', '16-superadmin.sql', "begin\n  perform public.exigir_superadmin(p_actor);\n\n  if p_meses is null", "begin\n  if p_meses is null", ['sql16']);
m('SQL las sa_* se le dan tambien a authenticated', '16-superadmin.sql', "execute format('grant execute on function public.%I(%s) to service_role', p.proname, p.args);", "execute format('grant execute on function public.%I(%s) to service_role, authenticated', p.proname, p.args);", ['sql16', 'superadmin']);
m('SQL las sa_* no se le quitan a anon', '16-superadmin.sql', "execute format('revoke all on function public.%I(%s) from public, anon, authenticated', p.proname, p.args);", "execute format('revoke all on function public.%I(%s) from public, authenticated', p.proname, p.args);", ['sql16', 'superadmin']);
m('SQL exigir_superadmin la puede ejecutar el servidor', '16-superadmin.sql', "revoke all on function public.exigir_superadmin(uuid) from public, anon, authenticated, service_role;", "revoke all on function public.exigir_superadmin(uuid) from public, anon, authenticated;", ['sql16']);
m('SQL auditar_superadmin la puede ejecutar el servidor (escribiria auditoria falsa)', '16-superadmin.sql', "revoke all on function public.auditar_superadmin(uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;", "revoke all on function public.auditar_superadmin(uuid, text, uuid, jsonb) from public, anon, authenticated;", ['sql16', 'superadmin']);
// ---- SQL 16: la auditoria ----
m('SQL auditoria: service_role conserva sus privilegios', '16-superadmin.sql', "revoke all on table public.auditoria_superadmin from public, anon, authenticated, service_role;", "revoke all on table public.auditoria_superadmin from public, anon, authenticated;", ['sql16', 'superadmin']);
m('SQL auditoria: sin el trigger que rechaza UPDATE', '16-superadmin.sql', "create trigger auditoria_no_actualizar before update on public.auditoria_superadmin\n  for each row execute function public.auditoria_solo_agregar();", "-- (sin trigger de update)", ['sql16']);
m('SQL auditoria: sin el trigger que rechaza DELETE', '16-superadmin.sql', "create trigger auditoria_no_borrar before delete on public.auditoria_superadmin\n  for each row execute function public.auditoria_solo_agregar();", "-- (sin trigger de delete)", ['sql16']);
m('SQL auditoria: sin el trigger que rechaza TRUNCATE', '16-superadmin.sql', "create trigger auditoria_no_vaciar before truncate on public.auditoria_superadmin\n  for each statement execute function public.auditoria_solo_agregar();", "-- (sin trigger de truncate)", ['sql16']);
m('SQL auditoria: RLS apagado', '16-superadmin.sql', "alter table public.auditoria_superadmin enable row level security;", "-- (sin RLS)", ['sql16']);
m('SQL auditar_superadmin acepta un resumen con pinta de secreto', '16-superadmin.sql', "if v_texto ~* '(prv_|(test|prod)_(integrity|events)_|sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}|-----BEGIN)' then", "if false then", ['sql16']);
m('SQL sa_guardar_secretos escribe los VALORES en la auditoria', '16-superadmin.sql', "'campos_guardados', to_jsonb(v_guardados), 'resultado', v_resultado,", "'campos_guardados', to_jsonb(v_guardados), 'resultado', v_resultado, 'valores', v_nuevo,", ['superadmin', 'sql16']);
m('SQL sa_estado_secretos devuelve el valor de la apikey', '16-superadmin.sql', "'callmebot_apikey',         coalesce(btrim(s.callmebot_apikey), '') <> '',", "'callmebot_apikey',         s.callmebot_apikey,", ['superadmin', 'sql16']);
// ---- SQL 16: vigencia ----
m('SQL vigencia: la gracia termina un dia antes', '16-superadmin.sql', "if v_vencido_hace <= v_gracia then", "if v_vencido_hace < v_gracia then", ['sql16']);
m('SQL vigencia: el ultimo dia ya no sirve', '16-superadmin.sql', "if v_vencido_hace <= 0 then", "if v_vencido_hace < 0 then", ['sql16']);
m('SQL vigencia: una prueba se vuelve "activo"', '16-superadmin.sql', "v_base text := case when p_estado = 'prueba' then 'prueba' else 'activo' end;", "v_base text := 'activo';", ['sql16']);
m('SQL vigencia: "hoy" en UTC y no en la zona del restaurante', '16-superadmin.sql', "v_hoy := (p_ahora at time zone coalesce(nullif(btrim(p_zona), ''), 'America/Bogota'))::date;", "v_hoy := (p_ahora at time zone 'UTC')::date;", ['sql16']);
m('SQL vigencia_restaurante pasa a SECURITY DEFINER (cualquiera vería la vigencia de otro)', '16-superadmin.sql', "returns jsonb\nlanguage sql\nstable\nset search_path = ''\nas $fn$\n  select public.calcular_vigencia(r.estado", "returns jsonb\nlanguage sql\nstable\nsecurity definer\nset search_path = ''\nas $fn$\n  select public.calcular_vigencia(r.estado", ['sql16']);
m('SQL vigencia_restaurante la puede ejecutar anon', '16-superadmin.sql', "revoke all on function public.vigencia_restaurante(uuid, timestamptz) from public, anon;", "revoke all on function public.vigencia_restaurante(uuid, timestamptz) from public;", ['sql16']);
// ---- SQL 16: reglas de cada funcion ----
m('SQL registrar_pago cuenta siempre desde la vigencia actual (aunque ya venciera)', '16-superadmin.sql', "v_base := case when r.vigente_hasta < v_hoy then v_hoy else r.vigente_hasta end;", "v_base := r.vigente_hasta;", ['superadmin']);
m('SQL registrar_pago cuenta siempre desde hoy (perdiendo lo ya pagado)', '16-superadmin.sql', "v_base := case when r.vigente_hasta < v_hoy then v_hoy else r.vigente_hasta end;", "v_base := v_hoy;", ['superadmin']);
m('SQL registrar_pago reactiva a un suspendido', '16-superadmin.sql', "v_estado := case when r.estado = 'prueba' then 'activo' else r.estado end;", "v_estado := 'activo';", ['superadmin']);
m('SQL registrar_pago acepta un restaurante sin vencimiento', '16-superadmin.sql', "if r.vigente_hasta is null then\n    raise exception 'Este restaurante no tiene vencimiento", "if false then\n    raise exception 'Este restaurante no tiene vencimiento", ['superadmin']);
m('SQL guardar_secretos: la regla R4 (no repetir entre restaurantes) apagada', '16-superadmin.sql', "if v_k <> 'wompi_modo' then\n      v_repetido := exists (", "if false then\n      v_repetido := exists (", ['superadmin']);
m('SQL guardar_secretos: guarda aunque haya repetidos', '16-superadmin.sql', "  if v_bloquea then\n    for v_k in select jsonb_object_keys(v_resultado) loop", "  if false then\n    for v_k in select jsonb_object_keys(v_resultado) loop", ['superadmin']);
m('SQL guardar_secretos: permitir_repetidos tambien vale para Wompi', '16-superadmin.sql', "(coalesce(p_permitir_repetidos, false) and v_k like 'callmebot\\_%')", "coalesce(p_permitir_repetidos, false)", ['superadmin']);
m('SQL guardar_secretos: pisa sin pedir sobrescribir', '16-superadmin.sql', "elsif coalesce(btrim(v_actual), '') <> '' and not coalesce(p_sobrescribir, false) then", "elsif false then", ['superadmin']);
m('SQL crear_restaurante: acepta cualquier slug', '16-superadmin.sql', "if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) not between 2 and 40 then", "if false then", ['superadmin', 'sql16'],
  { equivalente: 'la tabla restaurantes tiene el MISMO CHECK del slug (SQL 10): el insert falla igual (23514 -> 400); la funcion lo repite para dar el mensaje claro' });
m('SQL crear_restaurante: slugs reservados permitidos', '16-superadmin.sql', "if v_slug = any (array['api','www','admin','superadmin','app','panel','static','assets','mail','soporte','login','dashboard','cdn','status']) then", "if false then", ['superadmin', 'sql16']);
m('SQL crear_restaurante: el estado inicial no es prueba', '16-superadmin.sql', "values (v_slug, v_nombre, 'prueba', p_plan,", "values (v_slug, v_nombre, 'activo', p_plan,", ['superadmin', 'sql16']);
m('SQL crear_restaurante: sin validar la config inicial', '16-superadmin.sql', "v_err := public.config_restaurante_errores(v_config);\n  if cardinality(v_err) > 0 then\n    raise exception 'Configuracion inicial no valida", "v_err := '{}';\n  if cardinality(v_err) > 0 then\n    raise exception 'Configuracion inicial no valida", ['superadmin'], { equivalente: 'el trigger restaurantes_validar_config del SQL 13 la rechaza igual al insertar (defensa en capas); en la bateria local ese trigger esta apagado a proposito, por eso aqui si se detecta' });
m('SQL asignar_miembro: acepta cualquier rol', '16-superadmin.sql', "if p_rol is null or p_rol not in ('dueno', 'cajero', 'cocina') then", "if false then", ['superadmin'], { equivalente: 'la tabla miembros tiene un CHECK con los tres roles: el insert falla igual (con otro codigo, 23514)' });
m('SQL editar_config: no valida la config resultante', '16-superadmin.sql', "v_err := public.config_restaurante_errores(v_config);\n  if cardinality(v_err) > 0 then\n    raise exception 'Configuracion no valida", "v_err := '{}';\n  if cardinality(v_err) > 0 then\n    raise exception 'Configuracion no valida", ['superadmin'], { equivalente: 'el trigger restaurantes_validar_config (SQL 13) la rechaza igual al actualizar; en la bateria local esta apagado' });
m('SQL guardar_tarifas: acepta repetidos', '16-superadmin.sql', "if v_hasta = any (v_hastas) then", "if false then", ['superadmin'], { equivalente: 'la tabla tiene UNIQUE (restaurante_id, hasta): el insert falla igual' });
m('SQL actualizar_restaurante: acepta cualquier campo', '16-superadmin.sql', "if v_k <> all (array['nombre','estado','plan','modalidad_pago','vigente_hasta','dias_gracia','modulos','zona_horaria']) then", "if false then", ['superadmin', 'sql16']);
// ---- SQL 16b / horario ----
m('SQL 16b: cierre igual a la apertura permitido', '16b-horario.sql', "if v_cierra = v_abre then", "if false then", ['sql16']);
m('SQL 16b: el cierre de madrugada puede pasar del corte', '16b-horario.sql', "elsif v_cierra < v_abre and v_cierra > v_corte then", "elsif false then", ['sql16']);
m('SQL 16b: el trigger ignora la hora de corte', '16b-horario.sql', "left(new.hora_corte_jornada::text, 5)", "'05:00'", ['sql16']);
m('SQL 16b: el trigger no revisa al cambiar la hora de corte', '16b-horario.sql', "v_horarios := new.horarios is distinct from old.horarios or new.hora_corte_jornada is distinct from old.hora_corte_jornada;", "v_horarios := new.horarios is distinct from old.horarios;", ['sql16']);

// ---- api/superadmin.js y ayudas ----
m('API superadmin: no comprueba la tabla superadmins', 'api/superadmin.js', "  if (!autorizado) {", "  if (false) {", ['superadmin']);
m('API superadmin: acepta cualquier metodo', 'api/superadmin.js', '  if (req.method !== "POST") {', '  if (false) {', ['superadmin']);
m('API superadmin: sin sesion pasa a tratarse como 500', 'api/superadmin.js', "  if (!usuario) {\n    anotarFallo(ip, ahora);\n    res.status(401).json", "  if (!usuario) {\n    anotarFallo(ip, ahora);\n    res.status(500).json", ['superadmin']);
m('API superadmin: el limite de intentos no existe', 'api/superadmin.js', "const MAX_FALLOS = 10;", "const MAX_FALLOS = 100000;", ['superadmin']);
m('API superadmin: el 403 no cuenta como intento fallido', 'api/superadmin.js', "  if (!autorizado) {\n    anotarFallo(ip, ahora);", "  if (!autorizado) {\n", ['superadmin']);
m('API superadmin: el 401 no cuenta como intento fallido', 'api/superadmin.js', "  if (!usuario) {\n    anotarFallo(ip, ahora);", "  if (!usuario) {\n", ['superadmin']);
m('API superadmin: el bloqueo no dura la ventana', 'api/superadmin.js', "const VENTANA_MS = 10 * 60 * 1000;", "const VENTANA_MS = 1;", ['superadmin']);
m('API superadmin: acepta campos de mas', 'api/superadmin.js', 'if (extra.length) throw mal(', 'if (false) throw mal(', ['superadmin']);
m('API guardar_secretos: no detecta el secreto pegado dos veces', 'api/superadmin.js', 'if (pegadoDoble(valor, regla.prefijo)) throw mal(', 'if (false) throw mal(', ['superadmin']);
m('API guardar_secretos: acepta campos que no son de la lista', 'api/superadmin.js', 'if (!regla) throw mal(', 'if (false) throw mal(', ['superadmin']);
m('API guardar_secretos: el 409 del bloqueo por repetido pasa a 200', 'api/superadmin.js', "_estado: r.bloqueado_por_repetido ? 409 : 200", "_estado: 200", ['superadmin']);
m('API errores: devuelve los detalles de la base', 'api/superadmin.js', "res.status(estado).json({ error: mensaje.slice(0, 400), codigo });", "res.status(estado).json({ error: mensaje.slice(0, 400), codigo, detalle: cuerpo });", ['superadmin'], { equivalente: 'los errores de las funciones sa_* no traen detalles con datos; la prueba de "no repite el valor" no cubre esta ruta (el cuerpo de la base no trae nada sensible)' });
m('API errores: un error de la base devuelve su mensaje en un 500', 'api/superadmin.js', 'res.status(500).json({ error: "No se pudo completar la accion" });', 'res.status(500).json({ error: String(err && err.message) });', ['superadmin'], { equivalente: 'ninguna prueba provoca un 500 de la base con un secreto dentro; la defensa es que el log y la respuesta usan un texto fijo' });
m('API crear_usuario: la contrasena no es fuerte', 'api/_auth-admin.js', "while (letras.length < 20) letras.push(todo[crypto.randomInt(todo.length)]);", "while (letras.length < 12) letras.push('a');", ['superadmin']);
m('API crear_usuario: la contrasena es siempre la misma', 'api/_auth-admin.js', "const clase of CLASES) for (let i = 0; i < 3; i++) letras.push(clase[crypto.randomInt(clase.length)]);", "const clase of CLASES) for (let i = 0; i < 3; i++) letras.push(clase[0]);", ['superadmin']);
m('API crear_usuario: no borra el usuario si la asignacion falla', 'api/superadmin.js', "try { await borrarUsuario(nuevo.id); }", "try { /* sin borrar */ }", ['superadmin'], { equivalente: 'la asignacion solo falla si el restaurante desaparece entre la comprobacion previa y el insert (milisegundos); no se puede provocar sin una carrera' });
m('API crear_usuario: el restaurante inexistente no se comprueba antes de crear el usuario', 'api/superadmin.js', "if (rid) await sa(\"sa_detalle_restaurante\", { p_actor: u.id, p_restaurante: rid });", "", ['superadmin'],
  { equivalente: 'si la asignacion falla, el usuario recien creado se borra (todo o nada): la comprobacion previa y la reversa son dos capas del mismo resultado; quitadas LAS DOS juntas SI se detecta (mutacion siguiente)' });
m('API crear_usuario: ni comprueba el restaurante antes ni deshace la creacion si la asignacion falla', 'api/superadmin.js',
  ["if (rid) await sa(\"sa_detalle_restaurante\", { p_actor: u.id, p_restaurante: rid });", "try { await borrarUsuario(nuevo.id); }"], ["", "try { /* sin borrar */ }"], ['superadmin']);
m('API superadmin: no invalida la cache al actualizar', 'api/superadmin.js', "    const restaurante = await sa(\"sa_actualizar_restaurante\", { p_actor: u.id, p_restaurante: rid, p_cambios: objeto(b.cambios, \"cambios\") });\n    invalidarCache(rid);", "    const restaurante = await sa(\"sa_actualizar_restaurante\", { p_actor: u.id, p_restaurante: rid, p_cambios: objeto(b.cambios, \"cambios\") });", ['superadmin']);
m('API _supabase: llamarFuncionSuperadmin acepta cualquier funcion', 'api/_supabase.js', 'if (!/^sa_[a-z_]+$/.test(String(nombre))) {', 'if (false) {', ['servidor'], { equivalente: 'solo api/superadmin.js la usa y siempre con nombres sa_*; no hay entrada del cliente que llegue a "nombre"' });
// ---- sesion, cron, horario, servidor ----
m('SESION: una llave sb_ se manda a la red como si fuera un token', 'api/_sesion.js', "if (/^sb_/i.test(t)) return null;", "", ['servidor']);
m('CRON: ?clave= vuelve a valer', 'api/_cron.js', "  return m ? iguales(m[1].trim(), secreto) : false;", "  let c = null; try { c = new URL(req.url, 'http://localhost').searchParams.get('clave'); } catch (e) {}\n  return (m ? iguales(m[1].trim(), secreto) : false) || (c !== null && iguales(c, secreto));", ['cron']);
m('CRON: ya no exige el secreto', 'api/_cron.js', "  if (!secreto) return false;", "  if (!secreto) return true;", ['cron']);
m('HORARIO regla: el cierre igual a la apertura vale', 'horario-regla.js', "if (cierra === abre) {", "if (false) {", ['horario']);
m('HORARIO regla: el cierre de madrugada no se limita al corte', 'horario-regla.js', "if (cierra < abre && cierra > horaDeCorte(horaCorte)) {", "if (false) {", ['horario']);
m('HORARIO regla: 24:00 no vale como cierre', 'horario-regla.js', "if (permitir24 && v === \"24:00\") return 1440;", "", ['horario']);
m('HORARIO formato: 24:00 se muestra como mediodia', 'horario-regla.js', 'if (h === 24) return m === 0 ? "12:00 a.m. (medianoche)" : String(hhmm);', 'if (h === 24) return "12:00 p.m.";', ['horario']);
m('HORARIO servidor: 24:00 se muestra como mediodia', 'api/_horario.js', 'if (h === 24 && m === 0) return "12:00 am (medianoche)";', '', ['horario']);
m('HORARIO pagina publica: 24:00 se muestra como mediodia', 'index.html', 'if(h === 24 && m === 0) return "12:00 a.m. (medianoche)";', '', ['horario']);
m('VIGENCIA servidor: el ultimo dia de gracia ya no sirve', 'api/_restaurante.js', "if (vencidoHace <= gracia) {", "if (vencidoHace < gracia) {", ['sql16', 'servidor-vigencia']);
m('VIGENCIA servidor: una prueba se vuelve activo', 'api/_restaurante.js', 'const base = r.estado === "prueba" ? "prueba" : "activo";', 'const base = "activo";', ['sql16', 'servidor-vigencia']);
m('VIGENCIA servidor: el menu no avisa cuando no sirve', 'api/_modulos/menu.js', 'return servicio.sirve ? {} : { servicio: { sirve: false, motivo: "servicio_suspendido" } };', 'return {};', ['servidor-vigencia']);
m('VIGENCIA servidor: el menu avisa siempre', 'api/_modulos/menu.js', 'return servicio.sirve ? {} : { servicio: { sirve: false, motivo: "servicio_suspendido" } };', 'return { servicio: { sirve: servicio.sirve, motivo: "servicio_suspendido" } };', ['servidor-vigencia']);

/* ---------------------------------------------------------------------------------------------------- */
function correr(archivoNodo, args, env, cwd) {
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [archivoNodo, ...args], { cwd, env: { ...process.env, ...env } });
    let salida = '';
    h.stdout.on('data', (d) => { salida += d; });
    h.stderr.on('data', (d) => { salida += d; });
    const t = setTimeout(() => { salida += '\n[TIEMPO AGOTADO]'; h.kill(); }, 8 * 60 * 1000);
    h.on('close', (codigo) => { clearTimeout(t); resolve({ codigo, salida }); });
  });
}
function copiarRepo(destino) {
  const copiar = (rel) => {
    const o = path.join(RAIZ, rel), d = path.join(destino, rel);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(o, d, { recursive: true });
  };
  for (const rel of ['api', 'supabase', 'pruebas', 'horario-regla.js', 'index.html', 'pedido.html', 'panel.html', 'supabase-publico.js', 'restaurante-publico.js', 'vercel.json']) copiar(rel);
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(destino, 'node_modules'), 'junction');
}

const resultados = [];
const lista = M.filter((x) => !solo || new RegExp(solo, 'i').test(x.nombre));
const t0 = Date.now();
for (const [i, mu] of lista.entries()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mut16-'));
  try {
    copiarRepo(tmp);
    const f = mu.archivo.includes('/') || /\.(js|html)$/.test(mu.archivo) ? path.join(tmp, mu.archivo) : path.join(tmp, 'supabase', mu.archivo);
    let s = fs.readFileSync(f, 'utf8');
    const crlf = s.includes('\r\n');
    if (crlf) s = s.replace(/\r\n/g, '\n');
    // 'viejo'/'nuevo' pueden ser listas del mismo largo (varias sustituciones en la misma mutacion; cada 'viejo' tiene que aparecer UNA vez)
    const viejos = [].concat(mu.viejo), nuevos = [].concat(mu.nuevo);
    let malAplicada = null;
    viejos.forEach((v, k) => {
      const partes = s.split(v);
      if (partes.length !== 2) malAplicada = `el texto aparece ${partes.length - 1} veces`;
      else s = partes.join(nuevos[k]);
    });
    if (malAplicada) { resultados.push({ ...mu, estado: 'ERROR', info: malAplicada }); continue; }
    fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
    // la copia es un repositorio completo: sus pruebas leen SU api/, SU supabase/ y SU horario-regla.js (rutas relativas a cada archivo)
    const detectada = [];
    for (const suite of mu.suites) {
      const nodo = (archivo, args = []) => correr(path.join(tmp, archivo), args, {}, tmp);
      let r;
      if (suite === 'sql16') r = await nodo('pruebas/multirestaurante/sql16.mjs');
      else if (suite === 'superadmin') r = await nodo('pruebas/multirestaurante/superadmin.mjs');
      else if (suite === 'servidor') r = await nodo('pruebas/multirestaurante/servidor.mjs', ['--grupo=adversaria']);
      else if (suite === 'servidor-vigencia') r = await nodo('pruebas/multirestaurante/servidor.mjs', ['--grupo=vigencia,servicio']);
      if (suite === 'cron' || suite === 'horario') {
        r = await new Promise((resolve) => {
          const h = spawn(process.execPath, ['--test', path.join(tmp, 'pruebas', suite === 'cron' ? 'cron.test.js' : 'horario-regla.test.js')], { cwd: tmp });
          let salida = ''; h.stdout.on('data', (x) => { salida += x; }); h.stderr.on('data', (x) => { salida += x; });
          h.on('close', (codigo) => resolve({ codigo, salida }));
        });
      }
      if (r.codigo !== 0) { detectada.push(suite); break; }
    }
    resultados.push({ ...mu, estado: mu.control ? (detectada.length ? 'ERROR' : 'CONTROL OK') : detectada.length ? 'DETECTADA' : (mu.equivalente ? 'EQUIVALENTE' : 'SIN DETECTAR'),
      info: mu.control && detectada.length ? 'la copia limpia falla en ' + detectada.join(',') : detectada.join(',') });
  } catch (e) {
    resultados.push({ ...mu, estado: 'ERROR', info: e.message });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* en uso */ }
  }
  const r = resultados[resultados.length - 1];
  console.log(`  [${i + 1}/${lista.length}] ${r.estado.padEnd(12)} ${r.nombre}${r.estado === 'DETECTADA' ? ' (' + r.info + ')' : r.estado === 'ERROR' ? ' -> ' + r.info : ''}`);
}
const cuenta = (e) => resultados.filter((r) => r.estado === e).length;
const controles = cuenta('CONTROL OK');
console.log(`\n${controles ? 'Control: la copia limpia pasa todas las suites. ' : ''}${resultados.length - controles} mutaciones: ${cuenta('DETECTADA')} detectadas, ${cuenta('EQUIVALENTE')} equivalentes declaradas, ${cuenta('SIN DETECTAR')} sin detectar, ${cuenta('ERROR')} con error. (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
for (const r of resultados.filter((x) => x.estado === 'SIN DETECTAR' || x.estado === 'ERROR')) console.log(`  !! ${r.estado}: ${r.nombre} ${r.info || ''}`);
for (const r of resultados.filter((x) => x.estado === 'EQUIVALENTE')) console.log(`  = equivalente: ${r.nombre} -> ${r.equivalente}`);
process.exitCode = cuenta('SIN DETECTAR') || cuenta('ERROR') ? 1 : 0;
