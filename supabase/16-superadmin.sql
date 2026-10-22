-- =============================================================
-- TAQUEIROS 2.0 — SUPERADMIN Y VIGENCIA  (SQL 16)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": el archivo activa RLS en su tabla nueva por si mismo)
--
-- ANTES DE CORRERLO
--   * Los SQL 10, 11, 12 y 13 ya deben estar aplicados (el 14 y el 15 no importan para este archivo).
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs
--   * El 16b (horario) es independiente de este archivo; van en el orden que quieras.
--
-- QUE HACE  (paso 3A: la base y el servidor del panel de superadministrador; docs seccion 19)
--   1. VIGENCIA (cuanto tiempo paga cada restaurante), calculada al consultar, sin cron:
--        public.calcular_vigencia(estado, vigente_hasta, dias_gracia, zona, ahora)   funcion pura
--        public.vigencia_restaurante(restaurante, ahora)                              la usa el panel del dueno
--      Estados: prueba | activo | gracia | vencido | suspendido  (vigente_hasta nulo = sin vencimiento).
--   2. AUDITORIA: tabla public.auditoria_superadmin, SOLO DE AGREGAR. Nadie la puede leer, actualizar ni borrar
--      con el cliente (RLS sin politicas + ningun privilegio para anon, authenticated ni service_role) y un trigger
--      rechaza UPDATE, DELETE y TRUNCATE incluso al dueno de la tabla. Solo se escribe a traves de las funciones.
--   3. FUNCIONES DE SUPERADMIN (public.sa_*): listar y ver restaurantes, crear restaurante, actualizar estado / plan /
--      modulos / vigencia / dias de gracia, registrar un pago, editar marca-ubicacion-domicilio dentro de config,
--      administrar tarifas de domicilio y dominios, asignar o quitar miembros, guardar secretos (SOLO ESCRITURA: nunca
--      se leen de vuelta), y leer la auditoria. Todas:
--        * SECURITY DEFINER con search_path fijo, y SIN EXECUTE para anon, authenticated ni PUBLIC: solo las puede
--          llamar el servidor (api/superadmin.js, con la llave de servicio);
--        * reciben como primer argumento el superadmin que actua (p_actor) y LO PRIMERO que hacen es verificar que
--          esa persona este en public.superadmins (42501 si no); despues de eso dejan constancia en la auditoria.
--
-- QUE NO HACE
--   * No cambia datos existentes (comprueba que ninguna fila cambio) ni agrega a nadie a superadmins
--     (eso se hace con node supabase/crear-superadmin.mjs). No toca Taqueiros: sin vigente_hasta sigue sin vencimiento.
--   * No agrega permisos para clientes: anon sigue sin tocar ninguna tabla y solo ejecuta seguimiento y buscar_mis_pedidos.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una transaccion. Si cualquier paso o comprobacion
-- falla, TODO se revierte. Para deshacerlo: supabase/16-revertir.sql.
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Para SQL plano, el editor muestra el numero de linea: en VS Code usa Ctrl+G y busca hacia arriba el marcador
--     "-- >>> PASO ..." mas cercano. Lista de marcadores: buscar ">>> PASO".
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 16 SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES Y FOTO DEL "ANTES"
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := '';
  faltan text[] := '{}';
  t text;
  f text;
begin
  foreach t in array array['restaurantes','miembros','superadmins','restaurante_secretos','restaurante_dominios',
                           'configuracion','pedidos','categorias','productos','salud_notificaciones','tarifas_domicilio',
                           'contadores_pedido'] loop
    v_item := t;
    if to_regclass('public.' || t) is null then faltan := faltan || ('tabla public.' || t); end if;
  end loop;

  foreach f in array array['public.es_servidor()','public.es_superadmin()','public.rol_en(uuid)',
                           'public.config_restaurante_errores(jsonb)','public.proteger_campos_restaurante()',
                           'public.restaurante_taqueiros_id()','public.aprovisionar_restaurante()'] loop
    v_item := f;
    if to_regprocedure(f) is null then faltan := faltan || ('funcion ' || f); end if;
  end loop;

  if array_length(faltan, 1) > 0 then
    raise exception 'Faltan cosas de los SQL 10 a 13. Corre primero supabase/13-endurecer.sql (y antes el 11): %', array_to_string(faltan, '; ');
  end if;

  v_item := 'restaurante Taqueiros';
  if not exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) then
    raise exception 'No existe el restaurante Taqueiros (id fijo del SQL 10)';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- Lo que NO debe cambiar: la comprobacion final compara contra esto (secretos y dominios incluidos; solo se
-- compara una huella, nunca se muestra ningun valor).
drop table if exists pg_temp._mr16_antes;
create temp table _mr16_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t;


-- =============================================================
-- >>> PASO 1) VIGENCIA
-- =============================================================

-- >>> PASO 1.1 calcular_vigencia: funcion pura (no lee tablas). La misma cuenta que hace el servidor en
-- api/_restaurante.js (restauranteActivo); una prueba compara las dos con miles de combinaciones.
--   estado = 'suspendido'                     -> suspendido (lo puso Carlos a mano)
--   vigente_hasta nulo                        -> 'prueba' o 'activo' segun la columna estado (sin vencimiento)
--   hoy <= vigente_hasta                      -> 'prueba' o 'activo'    (vigente_hasta cuenta completo: ese dia aun sirve)
--   hoy <= vigente_hasta + dias_gracia        -> 'gracia'  (todo funciona; el panel del dueno avisa)
--   despues                                   -> 'vencido'
-- "Hoy" es la fecha en la zona horaria del restaurante. Una zona desconocida usa America/Bogota.
-- sirve = el restaurante recibe pedidos nuevos (prueba, activo y gracia si; vencido y suspendido no).
create or replace function public.calcular_vigencia(p_estado text, p_vigente_hasta date, p_dias_gracia integer,
                                                    p_zona text, p_ahora timestamptz default now())
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_hoy date;
  v_gracia integer := greatest(0, coalesce(p_dias_gracia, 0));
  v_base text := case when p_estado = 'prueba' then 'prueba' else 'activo' end;
  v_vencido_hace integer;
begin
  begin
    v_hoy := (p_ahora at time zone coalesce(nullif(btrim(p_zona), ''), 'America/Bogota'))::date;
  exception when others then
    v_hoy := (p_ahora at time zone 'America/Bogota')::date;
  end;

  if p_estado = 'suspendido' then
    return jsonb_build_object('estado', 'suspendido', 'sirve', false, 'motivo', 'suspendido',
      'vigente_hasta', p_vigente_hasta, 'sin_vencimiento', p_vigente_hasta is null,
      'dias_restantes', null, 'dias_para_suspension', null, 'dias_gracia', v_gracia);
  end if;

  if p_vigente_hasta is null then
    return jsonb_build_object('estado', v_base, 'sirve', true, 'motivo', null,
      'vigente_hasta', null, 'sin_vencimiento', true,
      'dias_restantes', null, 'dias_para_suspension', null, 'dias_gracia', v_gracia);
  end if;

  v_vencido_hace := v_hoy - p_vigente_hasta;

  if v_vencido_hace <= 0 then
    return jsonb_build_object('estado', v_base, 'sirve', true, 'motivo', null,
      'vigente_hasta', p_vigente_hasta, 'sin_vencimiento', false,
      'dias_restantes', -v_vencido_hace, 'dias_para_suspension', null, 'dias_gracia', v_gracia);
  end if;

  if v_vencido_hace <= v_gracia then
    -- dias_para_suspension: cuantos dias faltan para el primer dia suspendido (>= 1: hoy todavia se sirve)
    return jsonb_build_object('estado', 'gracia', 'sirve', true, 'motivo', 'en_gracia',
      'vigente_hasta', p_vigente_hasta, 'sin_vencimiento', false,
      'dias_restantes', 0, 'dias_para_suspension', v_gracia - v_vencido_hace + 1, 'dias_gracia', v_gracia);
  end if;

  return jsonb_build_object('estado', 'vencido', 'sirve', false, 'motivo', 'vencido',
    'vigente_hasta', p_vigente_hasta, 'sin_vencimiento', false,
    'dias_restantes', 0, 'dias_para_suspension', null, 'dias_gracia', v_gracia);
end;
$fn$;

revoke all on function public.calcular_vigencia(text, date, integer, text, timestamptz) from public, anon;
grant execute on function public.calcular_vigencia(text, date, integer, text, timestamptz) to authenticated, service_role;

-- >>> PASO 1.2 vigencia_restaurante: la que usa el panel del dueno (aviso de gracia). SECURITY INVOKER: corre con los
-- permisos de quien la llama, asi que RLS manda: un miembro (o un superadmin) ve la vigencia de SU restaurante; cualquier
-- otra persona recibe null. anon no la ejecuta (la vigencia en gracia no es publica).
create or replace function public.vigencia_restaurante(p_restaurante uuid, p_ahora timestamptz default now())
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select public.calcular_vigencia(r.estado, r.vigente_hasta, r.dias_gracia, r.zona_horaria, p_ahora)
         || jsonb_build_object('restaurante_id', r.id)
  from public.restaurantes r
  where r.id = p_restaurante;
$fn$;

revoke all on function public.vigencia_restaurante(uuid, timestamptz) from public, anon;
grant execute on function public.vigencia_restaurante(uuid, timestamptz) to authenticated, service_role;


-- =============================================================
-- >>> PASO 2) AUDITORIA (solo de agregar)
-- =============================================================

-- >>> PASO 2.1 la tabla. Sin FK a auth.users ni a restaurantes: la constancia sobrevive aunque se borre el usuario o
-- el restaurante (por eso guarda tambien el correo del actor y el slug del restaurante).
create table if not exists public.auditoria_superadmin (
  id             bigint generated always as identity primary key,
  creado_en      timestamptz not null default now(),
  actor          uuid not null,
  actor_email    text,
  restaurante_id uuid,
  restaurante_slug text,
  accion         text not null check (accion ~ '^[a-z][a-z0-9_]{2,59}$'),
  resumen        jsonb not null default '{}'::jsonb check (jsonb_typeof(resumen) = 'object')
);
create index if not exists auditoria_superadmin_restaurante_idx on public.auditoria_superadmin (restaurante_id, id desc);
create index if not exists auditoria_superadmin_creado_idx on public.auditoria_superadmin (id desc);

alter table public.auditoria_superadmin enable row level security;
-- (sin ninguna politica: ningun cliente ve ni toca la tabla)

-- Ningun privilegio para nadie que no sea el dueno de la tabla. Se revoca TAMBIEN a service_role: Supabase le da todos los
-- privilegios por defecto, y con ellos podria actualizar o borrar. Solo las funciones SECURITY DEFINER escriben aqui.
revoke all on table public.auditoria_superadmin from public, anon, authenticated, service_role;
revoke all on sequence public.auditoria_superadmin_id_seq from public, anon, authenticated, service_role;

-- >>> PASO 2.2 el trigger que la hace de solo agregar: rechaza UPDATE, DELETE y TRUNCATE incluso al dueno de la tabla.
create or replace function public.auditoria_solo_agregar()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  raise exception 'La auditoria del superadmin es solo de agregar: no se puede % ninguna fila', lower(tg_op)
    using errcode = '42501';
end;
$fn$;

revoke all on function public.auditoria_solo_agregar() from public, anon, authenticated, service_role;

drop trigger if exists auditoria_no_actualizar on public.auditoria_superadmin;
create trigger auditoria_no_actualizar before update on public.auditoria_superadmin
  for each row execute function public.auditoria_solo_agregar();
drop trigger if exists auditoria_no_borrar on public.auditoria_superadmin;
create trigger auditoria_no_borrar before delete on public.auditoria_superadmin
  for each row execute function public.auditoria_solo_agregar();
drop trigger if exists auditoria_no_vaciar on public.auditoria_superadmin;
create trigger auditoria_no_vaciar before truncate on public.auditoria_superadmin
  for each statement execute function public.auditoria_solo_agregar();


-- =============================================================
-- >>> PASO 3) AYUDAS INTERNAS (no las puede ejecutar nadie desde fuera: solo las llaman las funciones sa_*)
-- =============================================================

-- >>> PASO 3.1 exigir_superadmin: lo PRIMERO que hace cada funcion sa_*
create or replace function public.exigir_superadmin(p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_actor is null or not exists (select 1 from public.superadmins s where s.user_id = p_actor) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;
end;
$fn$;

revoke all on function public.exigir_superadmin(uuid) from public, anon, authenticated, service_role;

-- >>> PASO 3.2 auditar_superadmin: la UNICA forma de escribir en la auditoria. El resumen nunca puede traer un secreto
-- (se rechaza si lo parece) ni ser enorme.
create or replace function public.auditar_superadmin(p_actor uuid, p_accion text, p_restaurante uuid, p_resumen jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_resumen jsonb := coalesce(p_resumen, '{}'::jsonb);
  v_texto text;
  v_slug text;
  v_email text;
  v_id bigint;
begin
  if jsonb_typeof(v_resumen) <> 'object' then
    raise exception 'El resumen de la auditoria debe ser un objeto' using errcode = '22023';
  end if;
  v_texto := v_resumen::text;
  if char_length(v_texto) > 4000 then
    raise exception 'El resumen de la auditoria es demasiado largo' using errcode = '22023';
  end if;
  -- (solo el aspecto de los VALORES; los nombres de campo como callmebot_apikey si pueden aparecer: nunca llevan el valor)
  if v_texto ~* '(prv_|(test|prod)_(integrity|events)_|sb_secret_|sb_publishable_|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN)' then
    raise exception 'El resumen de la auditoria parece traer un secreto: no se guarda' using errcode = '22023';
  end if;

  select r.slug into v_slug from public.restaurantes r where r.id = p_restaurante;
  select u.email into v_email from auth.users u where u.id = p_actor;

  insert into public.auditoria_superadmin (actor, actor_email, restaurante_id, restaurante_slug, accion, resumen)
  values (p_actor, v_email, p_restaurante, v_slug, p_accion, v_resumen)
  returning id into v_id;
  return v_id;
end;
$fn$;

revoke all on function public.auditar_superadmin(uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;

-- >>> PASO 3.3 sa_texto_raro: true si el texto trae < o >, controles, ancho cero, separadores de linea o marcas bidi
create or replace function public.sa_texto_raro(p_t text)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(p_t ~ ('[\x01-\x1f\x7f-\x9f<>' || chr(8203) || '-' || chr(8207) || chr(8232) || '-' || chr(8238) || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279) || ']'), false);
$fn$;

revoke all on function public.sa_texto_raro(text) from public, anon, authenticated, service_role;

-- >>> PASO 3.4 sa_zona_valida: nombre de zona horaria que Postgres conoce (Area/Ciudad o UTC)
create or replace function public.sa_zona_valida(p_zona text)
returns boolean
language plpgsql
stable
set search_path = ''
as $fn$
begin
  if p_zona is null or char_length(p_zona) > 64 or p_zona !~ '^([A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}|UTC)$' then
    return false;
  end if;
  perform now() at time zone p_zona;
  return true;
exception when others then
  return false;
end;
$fn$;

revoke all on function public.sa_zona_valida(text) from public, anon, authenticated, service_role;

-- >>> PASO 3.5 sa_estado_secretos_interno: que secretos hay puestos (solo si/no; el modo de cobro no es un secreto)
create or replace function public.sa_estado_secretos_interno(p_restaurante uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'wompi_llave_publica_test', coalesce(btrim(s.wompi_llave_publica_test), '') <> '',
    'wompi_llave_publica_prod', coalesce(btrim(s.wompi_llave_publica_prod), '') <> '',
    'wompi_integridad_test',    coalesce(btrim(s.wompi_integridad_test), '') <> '',
    'wompi_integridad_prod',    coalesce(btrim(s.wompi_integridad_prod), '') <> '',
    'wompi_eventos_test',       coalesce(btrim(s.wompi_eventos_test), '') <> '',
    'wompi_eventos_prod',       coalesce(btrim(s.wompi_eventos_prod), '') <> '',
    'callmebot_telefono',       coalesce(btrim(s.callmebot_telefono), '') <> '',
    'callmebot_apikey',         coalesce(btrim(s.callmebot_apikey), '') <> '',
    'wompi_llave_privada_test', coalesce(btrim(s.otros ->> 'wompi_llave_privada_test'), '') <> '',
    'wompi_llave_privada_prod', coalesce(btrim(s.otros ->> 'wompi_llave_privada_prod'), '') <> '',
    'wompi_modo',               case when s.otros ->> 'wompi_modo' in ('test', 'produccion') then s.otros ->> 'wompi_modo' else null end
  )
  from public.restaurante_secretos s
  where s.restaurante_id = p_restaurante;
$fn$;

revoke all on function public.sa_estado_secretos_interno(uuid) from public, anon, authenticated, service_role;


-- =============================================================
-- >>> PASO 4) FUNCIONES DE SUPERADMIN  (solo service_role; LO PRIMERO: exigir_superadmin)
-- =============================================================

-- >>> PASO 4.1 listar restaurantes con su vigencia calculada
create or replace function public.sa_listar_restaurantes(p_actor uuid, p_ahora timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  perform public.exigir_superadmin(p_actor);
  return coalesce((
    select jsonb_agg(x.fila order by x.creado_en, x.slug)
    from (
      select r.creado_en, r.slug,
             jsonb_build_object(
               'id', r.id, 'slug', r.slug, 'nombre', r.nombre, 'estado', r.estado, 'plan', r.plan,
               'modalidad_pago', r.modalidad_pago, 'vigente_hasta', r.vigente_hasta, 'dias_gracia', r.dias_gracia,
               'modulos', r.modulos, 'zona_horaria', r.zona_horaria, 'creado_en', r.creado_en,
               'vigencia', public.calcular_vigencia(r.estado, r.vigente_hasta, r.dias_gracia, r.zona_horaria, p_ahora),
               'dominios', coalesce((select jsonb_agg(d.host order by d.host) from public.restaurante_dominios d where d.restaurante_id = r.id), '[]'::jsonb),
               'miembros_activos', (select count(*) from public.miembros m where m.restaurante_id = r.id and m.activo)
             ) as fila
      from public.restaurantes r
    ) x
  ), '[]'::jsonb);
end;
$fn$;

-- >>> PASO 4.2 detalle de un restaurante (sin ningun secreto: de ellos solo si estan puestos o no)
create or replace function public.sa_detalle_restaurante(p_actor uuid, p_restaurante uuid, p_ahora timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  r public.restaurantes%rowtype;
begin
  perform public.exigir_superadmin(p_actor);
  select * into r from public.restaurantes x where x.id = p_restaurante;
  if not found then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'id', r.id, 'slug', r.slug, 'nombre', r.nombre, 'estado', r.estado, 'plan', r.plan,
    'modalidad_pago', r.modalidad_pago, 'vigente_hasta', r.vigente_hasta, 'dias_gracia', r.dias_gracia,
    'modulos', r.modulos, 'zona_horaria', r.zona_horaria, 'hora_corte_jornada', r.hora_corte_jornada, 'creado_en', r.creado_en,
    'config', r.config,
    'vigencia', public.calcular_vigencia(r.estado, r.vigente_hasta, r.dias_gracia, r.zona_horaria, p_ahora),
    'dominios', coalesce((select jsonb_agg(d.host order by d.host) from public.restaurante_dominios d where d.restaurante_id = r.id), '[]'::jsonb),
    'miembros', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'rol', m.rol, 'activo', m.activo) order by m.rol, u.email)
                          from public.miembros m left join auth.users u on u.id = m.user_id where m.restaurante_id = r.id), '[]'::jsonb),
    'tarifas', coalesce((select jsonb_agg(jsonb_build_object('hasta', t.hasta, 'precio', t.precio) order by t.hasta) from public.tarifas_domicilio t where t.restaurante_id = r.id), '[]'::jsonb),
    'secretos', coalesce(public.sa_estado_secretos_interno(r.id), '{}'::jsonb)
  );
end;
$fn$;

-- >>> PASO 4.3 crear un restaurante (estado inicial 'prueba'). El alta automatica (trigger del SQL 10) crea su fila de
-- secretos, su contador de pedidos, su configuracion (horario 11:00-22:00) y su salud del WhatsApp; las tarifas quedan vacias.
create or replace function public.sa_crear_restaurante(
  p_actor uuid, p_slug text, p_nombre text, p_dominio text default null,
  p_zona_horaria text default 'America/Bogota', p_plan text default 'completo', p_modalidad_pago text default 'mensual',
  p_vigente_hasta date default null, p_dias_gracia integer default 5, p_modulos jsonb default null, p_config jsonb default null,
  p_ahora timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_slug text := btrim(coalesce(p_slug, ''));   -- el slug se valida TAL CUAL (con una mayuscula se rechaza: no se corrige en silencio)
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_dominio text := lower(btrim(coalesce(p_dominio, '')));
  v_zona text := btrim(coalesce(p_zona_horaria, ''));
  v_modulos jsonb := '{"pasarela":true,"seguimiento":true,"comandas":true,"impresion":true}'::jsonb;
  v_config jsonb := coalesce(p_config, '{"publico":{}}'::jsonb);
  v_hoy date;
  v_vigente date;
  v_k text;
  v_err text[];
  v_id uuid;
begin
  perform public.exigir_superadmin(p_actor);

  -- slug
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) not between 2 and 40 then
    raise exception 'El slug debe tener de 2 a 40 caracteres: minusculas, numeros y guiones (sin empezar ni terminar en guion)' using errcode = '22023';
  end if;
  if v_slug = any (array['api','www','admin','superadmin','app','panel','static','assets','mail','soporte','login','dashboard','cdn','status']) then
    raise exception 'Ese slug esta reservado' using errcode = '22023';
  end if;
  if exists (select 1 from public.restaurantes r where r.slug = v_slug) then
    raise exception 'Ya existe un restaurante con ese slug' using errcode = '23505';
  end if;

  -- nombre
  if char_length(v_nombre) not between 1 and 120 or public.sa_texto_raro(v_nombre) then
    raise exception 'Nombre del restaurante no valido (1 a 120 caracteres, sin < ni > ni caracteres de control)' using errcode = '22023';
  end if;

  -- dominio (opcional)
  if v_dominio <> '' then
    if char_length(v_dominio) > 253 or v_dominio !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' or v_dominio like '%..%' then
      raise exception 'El dominio no es valido (minusculas, numeros, puntos y guiones; ej. pedidos.mirestaurante.com)' using errcode = '22023';
    end if;
    if exists (select 1 from public.restaurante_dominios d where d.host = v_dominio) then
      raise exception 'Ese dominio ya esta en uso' using errcode = '23505';
    end if;
  end if;

  -- zona, plan, modalidad, dias de gracia
  if not public.sa_zona_valida(v_zona) then
    raise exception 'La zona horaria no es valida (ej. America/Bogota)' using errcode = '22023';
  end if;
  if p_plan is null or p_plan not in ('completo','basico','comandas') then
    raise exception 'El plan debe ser completo, basico o comandas' using errcode = '22023';
  end if;
  if p_modalidad_pago is null or p_modalidad_pago not in ('mensual','unico') then
    raise exception 'La modalidad de pago debe ser mensual o unico' using errcode = '22023';
  end if;
  if p_dias_gracia is null or p_dias_gracia not between 0 and 60 then
    raise exception 'Los dias de gracia deben estar entre 0 y 60' using errcode = '22023';
  end if;

  -- vigencia: por defecto 14 dias de prueba desde hoy (en la zona del restaurante)
  v_hoy := (p_ahora at time zone v_zona)::date;
  v_vigente := coalesce(p_vigente_hasta, v_hoy + 14);
  if v_vigente < v_hoy or v_vigente > v_hoy + 3660 then
    raise exception 'La vigencia debe ser desde hoy hasta dentro de 10 anos' using errcode = '22023';
  end if;

  -- modulos
  if p_modulos is not null then
    if jsonb_typeof(p_modulos) <> 'object' then
      raise exception 'Los modulos deben ser un objeto' using errcode = '22023';
    end if;
    for v_k in select jsonb_object_keys(p_modulos) loop
      if v_k not in ('pasarela','seguimiento','comandas','impresion') or jsonb_typeof(p_modulos -> v_k) <> 'boolean' then
        raise exception 'Modulo no valido (pasarela, seguimiento, comandas o impresion, cada uno verdadero o falso)' using errcode = '22023';
      end if;
    end loop;
    v_modulos := v_modulos || p_modulos;
  end if;

  -- config inicial: las mismas reglas del SQL 13
  v_err := public.config_restaurante_errores(v_config);
  if cardinality(v_err) > 0 then
    raise exception 'Configuracion inicial no valida: %', array_to_string(v_err[1:6], '; ') using errcode = '22023';
  end if;

  insert into public.restaurantes (slug, nombre, estado, plan, modalidad_pago, vigente_hasta, dias_gracia, modulos, zona_horaria, config)
  values (v_slug, v_nombre, 'prueba', p_plan, p_modalidad_pago, v_vigente, p_dias_gracia, v_modulos, v_zona, v_config)
  returning id into v_id;

  if v_dominio <> '' then
    insert into public.restaurante_dominios (host, restaurante_id) values (v_dominio, v_id);
  end if;

  perform public.auditar_superadmin(p_actor, 'crear_restaurante', v_id, jsonb_build_object(
    'slug', v_slug, 'nombre', v_nombre, 'dominio', nullif(v_dominio, ''), 'plan', p_plan, 'modalidad_pago', p_modalidad_pago,
    'vigente_hasta', v_vigente, 'dias_gracia', p_dias_gracia, 'zona_horaria', v_zona, 'modulos', v_modulos));

  return public.sa_detalle_restaurante(p_actor, v_id, p_ahora);
end;
$fn$;

-- >>> PASO 4.4 actualizar estado / plan / modalidad / vigencia / dias de gracia / modulos / zona / nombre
-- p_cambios: solo las claves que se quieren cambiar. vigente_hasta: 'AAAA-MM-DD', o null para "sin vencimiento".
create or replace function public.sa_actualizar_restaurante(p_actor uuid, p_restaurante uuid, p_cambios jsonb, p_ahora timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r public.restaurantes%rowtype;
  v_k text;
  v_nuevo public.restaurantes%rowtype;
  v_antes jsonb := '{}'::jsonb;
  v_despues jsonb := '{}'::jsonb;
  v_modulos jsonb;
  v_fecha date;
begin
  perform public.exigir_superadmin(p_actor);

  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' or p_cambios = '{}'::jsonb then
    raise exception 'Faltan los cambios (un objeto con al menos un campo)' using errcode = '22023';
  end if;
  for v_k in select jsonb_object_keys(p_cambios) loop
    if v_k <> all (array['nombre','estado','plan','modalidad_pago','vigente_hasta','dias_gracia','modulos','zona_horaria']) then
      raise exception 'Campo no permitido: %. Se pueden cambiar nombre, estado, plan, modalidad_pago, vigente_hasta, dias_gracia, modulos y zona_horaria', left(v_k, 40) using errcode = '22023';
    end if;
  end loop;

  select * into r from public.restaurantes x where x.id = p_restaurante for update;
  if not found then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;
  v_nuevo := r;

  if p_cambios ? 'nombre' then
    if jsonb_typeof(p_cambios -> 'nombre') <> 'string'
       or char_length(btrim(p_cambios ->> 'nombre')) not between 1 and 120 or public.sa_texto_raro(btrim(p_cambios ->> 'nombre')) then
      raise exception 'Nombre del restaurante no valido (1 a 120 caracteres, sin < ni > ni caracteres de control)' using errcode = '22023';
    end if;
    v_nuevo.nombre := btrim(p_cambios ->> 'nombre');
  end if;
  if p_cambios ? 'estado' then
    if jsonb_typeof(p_cambios -> 'estado') <> 'string' or (p_cambios ->> 'estado') not in ('prueba','activo','suspendido') then
      raise exception 'El estado debe ser prueba, activo o suspendido (vencido y gracia se calculan solos con la vigencia)' using errcode = '22023';
    end if;
    v_nuevo.estado := p_cambios ->> 'estado';
  end if;
  if p_cambios ? 'plan' then
    if jsonb_typeof(p_cambios -> 'plan') <> 'string' or (p_cambios ->> 'plan') not in ('completo','basico','comandas') then
      raise exception 'El plan debe ser completo, basico o comandas' using errcode = '22023';
    end if;
    v_nuevo.plan := p_cambios ->> 'plan';
  end if;
  if p_cambios ? 'modalidad_pago' then
    if jsonb_typeof(p_cambios -> 'modalidad_pago') <> 'string' or (p_cambios ->> 'modalidad_pago') not in ('mensual','unico') then
      raise exception 'La modalidad de pago debe ser mensual o unico' using errcode = '22023';
    end if;
    v_nuevo.modalidad_pago := p_cambios ->> 'modalidad_pago';
  end if;
  if p_cambios ? 'vigente_hasta' then
    if jsonb_typeof(p_cambios -> 'vigente_hasta') = 'null' then
      v_nuevo.vigente_hasta := null;
    else
      if jsonb_typeof(p_cambios -> 'vigente_hasta') <> 'string' or (p_cambios ->> 'vigente_hasta') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'vigente_hasta debe ser una fecha AAAA-MM-DD, o null para "sin vencimiento"' using errcode = '22023';
      end if;
      begin
        v_fecha := (p_cambios ->> 'vigente_hasta')::date;
      exception when others then
        raise exception 'vigente_hasta no es una fecha real' using errcode = '22023';
      end;
      if v_fecha < date '2020-01-01' or v_fecha > date '2100-12-31' then
        raise exception 'vigente_hasta esta fuera del rango permitido (2020 a 2100)' using errcode = '22023';
      end if;
      v_nuevo.vigente_hasta := v_fecha;
    end if;
  end if;
  if p_cambios ? 'dias_gracia' then
    if jsonb_typeof(p_cambios -> 'dias_gracia') <> 'number' or (p_cambios ->> 'dias_gracia') !~ '^\d{1,2}$' or (p_cambios ->> 'dias_gracia')::integer > 60 then
      raise exception 'Los dias de gracia deben ser un numero entero de 0 a 60' using errcode = '22023';
    end if;
    v_nuevo.dias_gracia := (p_cambios ->> 'dias_gracia')::integer;
  end if;
  if p_cambios ? 'modulos' then
    if jsonb_typeof(p_cambios -> 'modulos') <> 'object' or p_cambios -> 'modulos' = '{}'::jsonb then
      raise exception 'Los modulos deben ser un objeto con al menos un modulo' using errcode = '22023';
    end if;
    v_modulos := r.modulos;
    for v_k in select jsonb_object_keys(p_cambios -> 'modulos') loop
      if v_k not in ('pasarela','seguimiento','comandas','impresion') or jsonb_typeof(p_cambios -> 'modulos' -> v_k) <> 'boolean' then
        raise exception 'Modulo no valido (pasarela, seguimiento, comandas o impresion, cada uno verdadero o falso)' using errcode = '22023';
      end if;
    end loop;
    v_nuevo.modulos := v_modulos || (p_cambios -> 'modulos');
  end if;
  if p_cambios ? 'zona_horaria' then
    if jsonb_typeof(p_cambios -> 'zona_horaria') <> 'string' or not public.sa_zona_valida(p_cambios ->> 'zona_horaria') then
      raise exception 'La zona horaria no es valida (ej. America/Bogota)' using errcode = '22023';
    end if;
    v_nuevo.zona_horaria := p_cambios ->> 'zona_horaria';
  end if;

  -- lo que de verdad cambia (para la auditoria y para no escribir en vano)
  for v_k in select jsonb_object_keys(p_cambios) loop
    if to_jsonb(v_nuevo) -> v_k is distinct from to_jsonb(r) -> v_k then
      v_antes := v_antes || jsonb_build_object(v_k, to_jsonb(r) -> v_k);
      v_despues := v_despues || jsonb_build_object(v_k, to_jsonb(v_nuevo) -> v_k);
    end if;
  end loop;

  if v_despues <> '{}'::jsonb then
    update public.restaurantes x
       set nombre = v_nuevo.nombre, estado = v_nuevo.estado, plan = v_nuevo.plan, modalidad_pago = v_nuevo.modalidad_pago,
           vigente_hasta = v_nuevo.vigente_hasta, dias_gracia = v_nuevo.dias_gracia, modulos = v_nuevo.modulos,
           zona_horaria = v_nuevo.zona_horaria
     where x.id = p_restaurante;
    perform public.auditar_superadmin(p_actor, 'actualizar_restaurante', p_restaurante,
      jsonb_build_object('antes', v_antes, 'despues', v_despues));
  end if;

  return public.sa_detalle_restaurante(p_actor, p_restaurante, p_ahora);
end;
$fn$;

-- >>> PASO 4.5 registrar un pago: extiende vigente_hasta N meses.
--   * Si el restaurante ya vencio (vigente_hasta anterior a hoy, en su zona), los meses se cuentan desde HOY.
--   * Si sigue vigente (vigente_hasta es hoy o despues), se cuentan desde la vigencia actual (no se pierde lo ya pagado).
--   * Un restaurante 'prueba' pasa a 'activo'. Uno 'suspendido' (a mano) SIGUE suspendido: reactivarlo es otra decision.
--   * Sin vencimiento (vigente_hasta nulo) no tiene nada que extender: se rechaza (no se le pone un reloj por accidente).
create or replace function public.sa_registrar_pago(p_actor uuid, p_restaurante uuid, p_meses integer,
                                                    p_monto numeric default null, p_referencia text default null, p_nota text default null,
                                                    p_ahora timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r public.restaurantes%rowtype;
  v_hoy date;
  v_base date;
  v_nueva date;
  v_estado text;
begin
  perform public.exigir_superadmin(p_actor);

  if p_meses is null or p_meses not between 1 and 36 then
    raise exception 'Los meses del pago deben estar entre 1 y 36' using errcode = '22023';
  end if;
  if p_monto is not null and (p_monto < 0 or p_monto > 1000000000) then
    raise exception 'El monto del pago no es valido' using errcode = '22023';
  end if;
  if p_referencia is not null and (char_length(p_referencia) > 80 or public.sa_texto_raro(p_referencia)) then
    raise exception 'La referencia del pago no es valida (hasta 80 caracteres, sin < ni > ni caracteres de control)' using errcode = '22023';
  end if;
  if p_nota is not null and (char_length(p_nota) > 300 or public.sa_texto_raro(p_nota)) then
    raise exception 'La nota del pago no es valida (hasta 300 caracteres, sin < ni > ni caracteres de control)' using errcode = '22023';
  end if;

  select * into r from public.restaurantes x where x.id = p_restaurante for update;
  if not found then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;
  if r.vigente_hasta is null then
    raise exception 'Este restaurante no tiene vencimiento (vigente_hasta vacio): no hay vigencia que extender. Fija una fecha primero con actualizar_restaurante' using errcode = '22023';
  end if;

  begin
    v_hoy := (p_ahora at time zone r.zona_horaria)::date;
  exception when others then
    v_hoy := (p_ahora at time zone 'America/Bogota')::date;
  end;
  v_base := case when r.vigente_hasta < v_hoy then v_hoy else r.vigente_hasta end;
  v_nueva := (v_base + make_interval(months => p_meses))::date;
  v_estado := case when r.estado = 'prueba' then 'activo' else r.estado end;

  update public.restaurantes x set vigente_hasta = v_nueva, estado = v_estado where x.id = p_restaurante;

  perform public.auditar_superadmin(p_actor, 'registrar_pago', p_restaurante, jsonb_strip_nulls(jsonb_build_object(
    'meses', p_meses, 'monto', p_monto, 'referencia', p_referencia, 'nota', p_nota,
    'vigente_hasta_anterior', r.vigente_hasta, 'vigente_hasta_nueva', v_nueva, 'contado_desde', v_base,
    'estado_anterior', r.estado, 'estado_nuevo', v_estado)));

  return jsonb_build_object(
    'vigente_hasta_anterior', r.vigente_hasta, 'vigente_hasta_nueva', v_nueva, 'contado_desde', v_base,
    'estado', v_estado,
    'aviso', case when v_estado = 'suspendido' then 'El restaurante sigue SUSPENDIDO (se suspendio a mano): el pago extendio la vigencia pero no lo reactivo' else null end,
    'vigencia', public.calcular_vigencia(v_estado, v_nueva, r.dias_gracia, r.zona_horaria, p_ahora));
end;
$fn$;

-- >>> PASO 4.6 editar marca / ubicacion / domicilio (y llaves publicas de Wompi, PWA, contacto y textos) dentro de config.
-- p_cambios: { seccion: {...} | null }. Cada seccion REEMPLAZA la que habia (null la borra) y el resto de la config queda
-- igual. Se validan con las mismas reglas del SQL 13 (config_restaurante_errores): un valor no valido no se guarda.
--   marca, wompi, pwa, contacto, textos  ->  config.publico.<seccion>
--   ubicacion, domicilio                 ->  config.<seccion>
create or replace function public.sa_editar_config(p_actor uuid, p_restaurante uuid, p_cambios jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r public.restaurantes%rowtype;
  v_k text;
  v_config jsonb;
  v_err text[];
  v_resumen jsonb := '{}'::jsonb;
begin
  perform public.exigir_superadmin(p_actor);

  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' or p_cambios = '{}'::jsonb then
    raise exception 'Faltan los cambios (un objeto con al menos una seccion)' using errcode = '22023';
  end if;
  for v_k in select jsonb_object_keys(p_cambios) loop
    if v_k <> all (array['marca','wompi','pwa','contacto','textos','ubicacion','domicilio']) then
      raise exception 'Seccion no permitida: %. Se pueden editar marca, wompi, pwa, contacto, textos, ubicacion y domicilio', left(v_k, 40) using errcode = '22023';
    end if;
    if jsonb_typeof(p_cambios -> v_k) not in ('object', 'null') then
      raise exception 'La seccion % debe ser un objeto (o null para borrarla)', v_k using errcode = '22023';
    end if;
  end loop;

  select * into r from public.restaurantes x where x.id = p_restaurante for update;
  if not found then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;

  v_config := coalesce(r.config, '{}'::jsonb);
  for v_k in select jsonb_object_keys(p_cambios) loop
    if v_k in ('ubicacion', 'domicilio') then
      if jsonb_typeof(p_cambios -> v_k) = 'null' then
        v_config := v_config - v_k;
      else
        v_config := jsonb_set(v_config, array[v_k], p_cambios -> v_k, true);
      end if;
    else
      if jsonb_typeof(p_cambios -> v_k) = 'null' then
        v_config := v_config #- array['publico', v_k];
      else
        if jsonb_typeof(v_config -> 'publico') is distinct from 'object' then
          v_config := jsonb_set(v_config, array['publico'], '{}'::jsonb, true);
        end if;
        v_config := jsonb_set(v_config, array['publico', v_k], p_cambios -> v_k, true);
      end if;
    end if;
    v_resumen := v_resumen || jsonb_build_object(v_k, case when jsonb_typeof(p_cambios -> v_k) = 'null' then 'borrada' else 'reemplazada' end);
  end loop;

  v_err := public.config_restaurante_errores(v_config);
  if cardinality(v_err) > 0 then
    raise exception 'Configuracion no valida: %', array_to_string(v_err[1:6], '; ') using errcode = '22023';
  end if;

  update public.restaurantes x set config = v_config where x.id = p_restaurante;
  perform public.auditar_superadmin(p_actor, 'editar_config', p_restaurante, jsonb_build_object('secciones', v_resumen));

  return jsonb_build_object('config', v_config);
end;
$fn$;

-- >>> PASO 4.7 tarifas de domicilio: reemplaza TODAS las del restaurante por la lista nueva ([] = sin domicilio)
-- p_tarifas: [{ "hasta": km (1 decimal), "precio": pesos | null }]; precio null = fuera de cobertura (coordinar por WhatsApp).
create or replace function public.sa_guardar_tarifas(p_actor uuid, p_restaurante uuid, p_tarifas jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_i integer;
  v_t jsonb;
  v_k text;
  v_hastas numeric[] := '{}';
  v_hasta numeric;
  v_antes integer;
begin
  perform public.exigir_superadmin(p_actor);

  if p_tarifas is null or jsonb_typeof(p_tarifas) <> 'array' or jsonb_array_length(p_tarifas) > 20 then
    raise exception 'Las tarifas deben ser una lista de hasta 20 tramos ([] para no ofrecer domicilio)' using errcode = '22023';
  end if;
  for v_i in 0 .. jsonb_array_length(p_tarifas) - 1 loop
    v_t := p_tarifas -> v_i;
    if jsonb_typeof(v_t) <> 'object' then
      raise exception 'Cada tarifa debe ser un objeto { hasta, precio }' using errcode = '22023';
    end if;
    for v_k in select jsonb_object_keys(v_t) loop
      if v_k not in ('hasta', 'precio') then
        raise exception 'Cada tarifa solo lleva hasta y precio' using errcode = '22023';
      end if;
    end loop;
    if jsonb_typeof(v_t -> 'hasta') <> 'number' then
      raise exception 'El limite "hasta" de cada tarifa debe ser un numero de kilometros' using errcode = '22023';
    end if;
    v_hasta := (v_t ->> 'hasta')::numeric;
    if v_hasta <= 0 or v_hasta > 1000 or v_hasta * 10 <> trunc(v_hasta * 10) then
      raise exception 'El limite "hasta" debe estar entre 0 (sin incluir) y 1000 km, con un decimal como maximo' using errcode = '22023';
    end if;
    if v_hasta = any (v_hastas) then
      raise exception 'Hay dos tarifas con el mismo limite en km' using errcode = '22023';
    end if;
    v_hastas := v_hastas || v_hasta;
    if v_t ? 'precio' and jsonb_typeof(v_t -> 'precio') not in ('number', 'null') then
      raise exception 'El precio debe ser un numero de pesos, o null para "fuera de cobertura"' using errcode = '22023';
    end if;
    if jsonb_typeof(v_t -> 'precio') = 'number' and (
         (v_t ->> 'precio') !~ '^\d{1,6}$' or (v_t ->> 'precio')::integer > 500000) then
      raise exception 'El precio debe ser un numero entero de pesos entre 0 y 500000' using errcode = '22023';
    end if;
  end loop;

  perform 1 from public.restaurantes x where x.id = p_restaurante for update;
  if not found then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;

  select count(*) into v_antes from public.tarifas_domicilio t where t.restaurante_id = p_restaurante;
  delete from public.tarifas_domicilio t where t.restaurante_id = p_restaurante;
  insert into public.tarifas_domicilio (restaurante_id, hasta, precio)
  select p_restaurante, (e ->> 'hasta')::numeric, case when jsonb_typeof(e -> 'precio') = 'number' then (e ->> 'precio')::integer else null end
  from jsonb_array_elements(p_tarifas) e;

  perform public.auditar_superadmin(p_actor, 'guardar_tarifas', p_restaurante,
    jsonb_build_object('tramos_antes', v_antes, 'tramos_despues', jsonb_array_length(p_tarifas)));

  return coalesce((select jsonb_agg(jsonb_build_object('hasta', t.hasta, 'precio', t.precio) order by t.hasta)
                   from public.tarifas_domicilio t where t.restaurante_id = p_restaurante), '[]'::jsonb);
end;
$fn$;

-- >>> PASO 4.8 dominios
create or replace function public.sa_agregar_dominio(p_actor uuid, p_restaurante uuid, p_host text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_host text := lower(btrim(coalesce(p_host, '')));
begin
  perform public.exigir_superadmin(p_actor);
  if v_host = '' or char_length(v_host) > 253 or v_host !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' or v_host like '%..%' then
    raise exception 'El dominio no es valido (minusculas, numeros, puntos y guiones; ej. pedidos.mirestaurante.com)' using errcode = '22023';
  end if;
  if not exists (select 1 from public.restaurantes r where r.id = p_restaurante) then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.restaurante_dominios d where d.host = v_host) then
    raise exception 'Ese dominio ya esta en uso' using errcode = '23505';
  end if;
  insert into public.restaurante_dominios (host, restaurante_id) values (v_host, p_restaurante);
  perform public.auditar_superadmin(p_actor, 'agregar_dominio', p_restaurante, jsonb_build_object('dominio', v_host));
  return jsonb_build_object('host', v_host, 'restaurante_id', p_restaurante);
end;
$fn$;

create or replace function public.sa_quitar_dominio(p_actor uuid, p_restaurante uuid, p_host text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_host text := lower(btrim(coalesce(p_host, '')));
  v_n integer;
begin
  perform public.exigir_superadmin(p_actor);
  delete from public.restaurante_dominios d where d.host = v_host and d.restaurante_id = p_restaurante;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'Ese dominio no existe en ese restaurante' using errcode = 'P0002';
  end if;
  perform public.auditar_superadmin(p_actor, 'quitar_dominio', p_restaurante, jsonb_build_object('dominio', left(v_host, 253)));
  return jsonb_build_object('host', v_host, 'quitado', true);
end;
$fn$;

-- >>> PASO 4.9 miembros (quien entra al panel de cada restaurante, y con que rol)
create or replace function public.sa_asignar_miembro(p_actor uuid, p_restaurante uuid, p_usuario uuid, p_rol text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_email text;
begin
  perform public.exigir_superadmin(p_actor);
  if p_rol is null or p_rol not in ('dueno', 'cajero', 'cocina') then
    raise exception 'El rol debe ser dueno, cajero o cocina' using errcode = '22023';
  end if;
  if not exists (select 1 from public.restaurantes r where r.id = p_restaurante) then
    raise exception 'No existe ese restaurante' using errcode = 'P0002';
  end if;
  select u.email into v_email from auth.users u where u.id = p_usuario;
  if not found then
    raise exception 'No existe ese usuario en Authentication' using errcode = 'P0002';
  end if;
  insert into public.miembros (user_id, restaurante_id, rol, activo) values (p_usuario, p_restaurante, p_rol, true)
  on conflict (user_id, restaurante_id) do update set rol = excluded.rol, activo = true;
  perform public.auditar_superadmin(p_actor, 'asignar_miembro', p_restaurante,
    jsonb_build_object('usuario', p_usuario, 'email', v_email, 'rol', p_rol));
  return jsonb_build_object('user_id', p_usuario, 'email', v_email, 'restaurante_id', p_restaurante, 'rol', p_rol, 'activo', true);
end;
$fn$;

create or replace function public.sa_quitar_miembro(p_actor uuid, p_restaurante uuid, p_usuario uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rol text;
  v_email text;
begin
  perform public.exigir_superadmin(p_actor);
  delete from public.miembros m where m.user_id = p_usuario and m.restaurante_id = p_restaurante returning m.rol into v_rol;
  if not found then
    raise exception 'Ese usuario no es miembro de ese restaurante' using errcode = 'P0002';
  end if;
  select u.email into v_email from auth.users u where u.id = p_usuario;
  perform public.auditar_superadmin(p_actor, 'quitar_miembro', p_restaurante,
    jsonb_build_object('usuario', p_usuario, 'email', v_email, 'rol_que_tenia', v_rol));
  return jsonb_build_object('user_id', p_usuario, 'restaurante_id', p_restaurante, 'quitado', true);
end;
$fn$;

-- >>> PASO 4.10 secretos del restaurante: SOLO ESCRITURA
-- p_valores: { campo: "valor" } con campos de la lista cerrada de abajo (los mismos de supabase/cargar-secretos.mjs).
-- La respuesta NUNCA trae un valor: solo, por campo, 'guardado' | 'ya_coincide' | 'ya_existe_otro_valor' (hay uno distinto y
-- no se pidio sobrescribir) | 'repetido_en_otro_restaurante'. Reglas:
--   * un valor que ya tiene OTRO restaurante en el mismo campo no se guarda y NO SE GUARDA NADA de la llamada: pasa cuando
--     quedan puestas las variables de otro restaurante (con el mismo secreto de eventos de Wompi dos restaurantes podrian
--     aprobar pedidos el uno del otro; con el mismo CallMeBot, las comandas de uno llegarian al WhatsApp del otro). Los
--     campos de CallMeBot repetidos se aceptan solo con p_permitir_repetidos (un dueno con dos restaurantes y un telefono);
--     los de Wompi, nunca.
--   * un valor distinto de uno ya guardado no lo pisa sin p_sobrescribir; un valor vacio nunca borra uno existente.
create or replace function public.sa_guardar_secretos(p_actor uuid, p_restaurante uuid, p_valores jsonb,
                                                      p_sobrescribir boolean default false, p_permitir_repetidos boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  c_campos constant text[] := array['wompi_llave_publica_test','wompi_llave_publica_prod','wompi_integridad_test','wompi_integridad_prod',
                                    'wompi_eventos_test','wompi_eventos_prod','callmebot_telefono','callmebot_apikey',
                                    'wompi_llave_privada_test','wompi_llave_privada_prod','wompi_modo'];
  v_fila public.restaurante_secretos%rowtype;
  v_k text;
  v_v text;
  v_actual text;
  v_resultado jsonb := '{}'::jsonb;
  v_nuevo jsonb := '{}'::jsonb;
  v_nuevo_otros jsonb;
  v_bloquea boolean := false;
  v_repetido boolean;
  v_guardados text[] := '{}';
begin
  perform public.exigir_superadmin(p_actor);

  if p_valores is null or jsonb_typeof(p_valores) <> 'object' or p_valores = '{}'::jsonb then
    raise exception 'Faltan los secretos (un objeto { campo: valor })' using errcode = '22023';
  end if;

  -- 1) formato de cada campo (sin repetir nunca el valor en un mensaje)
  for v_k in select jsonb_object_keys(p_valores) loop
    if v_k <> all (c_campos) then
      raise exception 'Campo de secretos no permitido: %', left(v_k, 40) using errcode = '22023';
    end if;
    if jsonb_typeof(p_valores -> v_k) <> 'string' then
      raise exception 'El valor de % debe ser un texto', v_k using errcode = '22023';
    end if;
    v_v := btrim(p_valores ->> v_k);
    if v_v = '' then
      raise exception 'El valor de % esta vacio (un valor vacio nunca borra uno existente)', v_k using errcode = '22023';
    end if;
    if char_length(v_v) > 500 or v_v ~ '\s' or v_v ~ '[\x01-\x1f\x7f-\x9f]' then
      raise exception 'El valor de % no es valido (sin espacios ni saltos de linea, hasta 500 caracteres)', v_k using errcode = '22023';
    end if;
    if v_k = 'callmebot_telefono' and v_v !~ '^\d{10,15}$' then
      raise exception 'callmebot_telefono debe ser solo digitos con el indicativo (57XXXXXXXXXX)' using errcode = '22023';
    end if;
    if v_k = 'wompi_modo' and v_v not in ('test', 'produccion') then
      raise exception 'wompi_modo debe ser test o produccion' using errcode = '22023';
    end if;
    if v_k = 'wompi_llave_publica_test' and v_v !~ '^pub_test_[A-Za-z0-9]{10,80}$' then
      raise exception 'wompi_llave_publica_test debe ser la llave publica de prueba (pub_test_...)' using errcode = '22023';
    end if;
    if v_k = 'wompi_llave_publica_prod' and v_v !~ '^pub_prod_[A-Za-z0-9]{10,80}$' then
      raise exception 'wompi_llave_publica_prod debe ser la llave publica de produccion (pub_prod_...)' using errcode = '22023';
    end if;
    v_nuevo := v_nuevo || jsonb_build_object(v_k, v_v);
  end loop;

  select * into v_fila from public.restaurante_secretos s where s.restaurante_id = p_restaurante for update;
  if not found then
    raise exception 'El restaurante no existe o no tiene fila de secretos' using errcode = 'P0002';
  end if;
  v_nuevo_otros := coalesce(v_fila.otros, '{}'::jsonb);

  -- 2) cada campo contra lo que ya hay y contra los demas restaurantes
  for v_k in select jsonb_object_keys(v_nuevo) loop
    v_v := v_nuevo ->> v_k;
    v_actual := case when v_k in ('wompi_llave_privada_test','wompi_llave_privada_prod','wompi_modo')
                     then v_fila.otros ->> v_k
                     else to_jsonb(v_fila) ->> v_k end;

    -- repetido en otro restaurante (el modo de cobro no es un secreto: puede repetirse)
    v_repetido := false;
    if v_k <> 'wompi_modo' then
      v_repetido := exists (
        select 1 from public.restaurante_secretos o
        where o.restaurante_id <> p_restaurante
          and (case when v_k in ('wompi_llave_privada_test','wompi_llave_privada_prod') then o.otros ->> v_k else to_jsonb(o) ->> v_k end) = v_v);
    end if;

    if v_repetido and not (coalesce(p_permitir_repetidos, false) and v_k like 'callmebot\_%') then
      v_resultado := v_resultado || jsonb_build_object(v_k, 'repetido_en_otro_restaurante');
      v_bloquea := true;
    elsif v_actual is not null and v_actual = v_v then
      v_resultado := v_resultado || jsonb_build_object(v_k, 'ya_coincide');
    elsif coalesce(btrim(v_actual), '') <> '' and not coalesce(p_sobrescribir, false) then
      v_resultado := v_resultado || jsonb_build_object(v_k, 'ya_existe_otro_valor');
    else
      v_resultado := v_resultado || jsonb_build_object(v_k, 'guardado');
      v_guardados := v_guardados || v_k;
    end if;
  end loop;

  -- 3) con un valor repetido en otro restaurante no se guarda NADA
  if v_bloquea then
    for v_k in select jsonb_object_keys(v_resultado) loop
      if v_resultado ->> v_k = 'guardado' then
        v_resultado := v_resultado || jsonb_build_object(v_k, 'no_guardado');
      end if;
    end loop;
    v_guardados := '{}';
  elsif cardinality(v_guardados) > 0 then
    foreach v_k in array v_guardados loop
      if v_k in ('wompi_llave_privada_test','wompi_llave_privada_prod','wompi_modo') then
        v_nuevo_otros := v_nuevo_otros || jsonb_build_object(v_k, v_nuevo ->> v_k);
      end if;
    end loop;
    update public.restaurante_secretos s set
      wompi_llave_publica_test = case when 'wompi_llave_publica_test' = any (v_guardados) then v_nuevo ->> 'wompi_llave_publica_test' else s.wompi_llave_publica_test end,
      wompi_llave_publica_prod = case when 'wompi_llave_publica_prod' = any (v_guardados) then v_nuevo ->> 'wompi_llave_publica_prod' else s.wompi_llave_publica_prod end,
      wompi_integridad_test    = case when 'wompi_integridad_test'    = any (v_guardados) then v_nuevo ->> 'wompi_integridad_test'    else s.wompi_integridad_test end,
      wompi_integridad_prod    = case when 'wompi_integridad_prod'    = any (v_guardados) then v_nuevo ->> 'wompi_integridad_prod'    else s.wompi_integridad_prod end,
      wompi_eventos_test       = case when 'wompi_eventos_test'       = any (v_guardados) then v_nuevo ->> 'wompi_eventos_test'       else s.wompi_eventos_test end,
      wompi_eventos_prod       = case when 'wompi_eventos_prod'       = any (v_guardados) then v_nuevo ->> 'wompi_eventos_prod'       else s.wompi_eventos_prod end,
      callmebot_telefono       = case when 'callmebot_telefono'       = any (v_guardados) then v_nuevo ->> 'callmebot_telefono'       else s.callmebot_telefono end,
      callmebot_apikey         = case when 'callmebot_apikey'         = any (v_guardados) then v_nuevo ->> 'callmebot_apikey'         else s.callmebot_apikey end,
      otros = v_nuevo_otros,
      actualizado_en = now()
    where s.restaurante_id = p_restaurante;
  end if;

  perform public.auditar_superadmin(p_actor, 'guardar_secretos', p_restaurante, jsonb_build_object(
    'campos_guardados', to_jsonb(v_guardados), 'resultado', v_resultado,
    'sobrescribir', coalesce(p_sobrescribir, false), 'permitir_repetidos', coalesce(p_permitir_repetidos, false)));

  return jsonb_build_object(
    'guardado', cardinality(v_guardados) > 0,
    'bloqueado_por_repetido', v_bloquea,
    'campos', v_resultado,
    'secretos', public.sa_estado_secretos_interno(p_restaurante));
end;
$fn$;

create or replace function public.sa_estado_secretos(p_actor uuid, p_restaurante uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_r jsonb;
begin
  perform public.exigir_superadmin(p_actor);
  v_r := public.sa_estado_secretos_interno(p_restaurante);
  if v_r is null then
    raise exception 'El restaurante no existe o no tiene fila de secretos' using errcode = 'P0002';
  end if;
  return v_r;
end;
$fn$;

-- >>> PASO 4.11 leer la auditoria (la mas reciente primero)
create or replace function public.sa_listar_auditoria(p_actor uuid, p_restaurante uuid default null, p_limite integer default 50, p_antes_de bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  perform public.exigir_superadmin(p_actor);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'creado_en', a.creado_en, 'actor', a.actor, 'actor_email', a.actor_email,
                                         'restaurante_id', a.restaurante_id, 'restaurante_slug', a.restaurante_slug,
                                         'accion', a.accion, 'resumen', a.resumen) order by a.id desc)
    from (
      select * from public.auditoria_superadmin x
      where (p_restaurante is null or x.restaurante_id = p_restaurante)
        and (p_antes_de is null or x.id < p_antes_de)
      order by x.id desc
      limit greatest(1, least(coalesce(p_limite, 50), 200))
    ) a
  ), '[]'::jsonb);
end;
$fn$;

-- >>> PASO 4.12 dejar constancia de que se creo un usuario (el usuario se crea en Authentication, fuera de Postgres, con la API
-- de administracion; esta funcion solo escribe la auditoria: correo y id, JAMAS la contrasena temporal)
create or replace function public.sa_registrar_usuario(p_actor uuid, p_usuario uuid, p_email text, p_restaurante uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.exigir_superadmin(p_actor);
  if p_usuario is null or p_email is null or char_length(p_email) > 254 or public.sa_texto_raro(p_email) then
    raise exception 'El usuario o el correo no son validos' using errcode = '22023';
  end if;
  perform public.auditar_superadmin(p_actor, 'crear_usuario', p_restaurante, jsonb_build_object('usuario', p_usuario, 'email', p_email));
  return jsonb_build_object('registrado', true);
end;
$fn$;

-- >>> PASO 4.13 permisos: SOLO el servidor (service_role). Ni anon, ni authenticated, ni PUBLIC.
do $do$
declare
  v_paso constant text := '4.13 permisos de las funciones de superadmin';
  v_item text := '';
  p record;
begin
  for p in
    select pr.oid, pr.proname, pg_get_function_identity_arguments(pr.oid) as args
    from pg_proc pr
    where pr.pronamespace = 'public'::regnamespace and pr.proname like 'sa\_%' escape '\'
      and pr.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno')
  loop
    v_item := p.proname || '(' || p.args || ')';
    execute format('revoke all on function public.%I(%s) from public, anon, authenticated', p.proname, p.args);
    execute format('grant execute on function public.%I(%s) to service_role', p.proname, p.args);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 5) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================

-- >>> PASO 5.1 pruebas con datos que se deshacen (no queda ningun dato; solo se gasta un numero de la secuencia de la auditoria)
drop table if exists pg_temp._mr16_func;
create temp table _mr16_func (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '5.1 pruebas de funciones y de la auditoria';
  v_item text := '';
  v_res jsonb := '{}'::jsonb;
  v_cod text;
  v_id bigint;
begin
  begin
    -- (a) alguien que no es superadmin no puede ejecutar NINGUNA funcion sa_* (42501), ni siquiera con datos validos
    v_item := 'no superadmin';
    v_cod := '';
    begin perform public.sa_listar_restaurantes(gen_random_uuid()); v_cod := v_cod || '[listar]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_detalle_restaurante(gen_random_uuid(), public.restaurante_taqueiros_id()); v_cod := v_cod || '[detalle]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_crear_restaurante(gen_random_uuid(), 'mr16-prueba', 'Prueba'); v_cod := v_cod || '[crear]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_actualizar_restaurante(gen_random_uuid(), public.restaurante_taqueiros_id(), '{"plan":"basico"}'); v_cod := v_cod || '[actualizar]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_registrar_pago(gen_random_uuid(), public.restaurante_taqueiros_id(), 1); v_cod := v_cod || '[pago]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_editar_config(gen_random_uuid(), public.restaurante_taqueiros_id(), '{"domicilio":{"factor_recorrido":1.2}}'); v_cod := v_cod || '[config]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_guardar_tarifas(gen_random_uuid(), public.restaurante_taqueiros_id(), '[]'); v_cod := v_cod || '[tarifas]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_agregar_dominio(gen_random_uuid(), public.restaurante_taqueiros_id(), 'x.prueba.test'); v_cod := v_cod || '[dominio]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_quitar_dominio(gen_random_uuid(), public.restaurante_taqueiros_id(), 'x.prueba.test'); v_cod := v_cod || '[quitar dominio]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_asignar_miembro(gen_random_uuid(), public.restaurante_taqueiros_id(), gen_random_uuid(), 'dueno'); v_cod := v_cod || '[asignar]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_quitar_miembro(gen_random_uuid(), public.restaurante_taqueiros_id(), gen_random_uuid()); v_cod := v_cod || '[quitar miembro]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_guardar_secretos(gen_random_uuid(), public.restaurante_taqueiros_id(), '{"wompi_modo":"test"}'); v_cod := v_cod || '[secretos]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_estado_secretos(gen_random_uuid(), public.restaurante_taqueiros_id()); v_cod := v_cod || '[estado secretos]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_listar_auditoria(gen_random_uuid()); v_cod := v_cod || '[auditoria]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_registrar_usuario(gen_random_uuid(), gen_random_uuid(), 'a@b.co'); v_cod := v_cod || '[registrar usuario]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.sa_listar_restaurantes(null); v_cod := v_cod || '[actor nulo]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    v_res := v_res || jsonb_build_object('no_superadmin', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    -- (b) la auditoria es de solo agregar
    v_item := 'auditoria';
    v_id := public.auditar_superadmin(gen_random_uuid(), 'prueba_mr16', null, '{"x":1}'::jsonb);
    v_cod := '';
    begin update public.auditoria_superadmin set accion = 'otra_cosa' where id = v_id; v_cod := v_cod || '[update]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin delete from public.auditoria_superadmin where id = v_id; v_cod := v_cod || '[delete]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin delete from public.auditoria_superadmin; v_cod := v_cod || '[delete sin where]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    begin truncate public.auditoria_superadmin; v_cod := v_cod || '[truncate]'; exception when others then if sqlstate <> '42501' then v_cod := v_cod || sqlstate; end if; end;
    v_res := v_res || jsonb_build_object('auditoria_solo_agregar', jsonb_build_object('ok', v_cod = '' and exists (select 1 from public.auditoria_superadmin where id = v_id and accion = 'prueba_mr16'), 'detalle', v_cod));

    -- (c) un resumen con pinta de secreto, o enorme, no se guarda
    v_item := 'resumen de la auditoria';
    v_cod := '';
    begin perform public.auditar_superadmin(gen_random_uuid(), 'prueba_mr16', null, '{"a":"sb_secret_abcdef"}'::jsonb); v_cod := v_cod || '[secreto]'; exception when others then if sqlstate <> '22023' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.auditar_superadmin(gen_random_uuid(), 'prueba_mr16', null, '{"a":"prod_events_abcdef"}'::jsonb); v_cod := v_cod || '[eventos]'; exception when others then if sqlstate <> '22023' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.auditar_superadmin(gen_random_uuid(), 'prueba_mr16', null, jsonb_build_object('a', repeat('x', 4100))); v_cod := v_cod || '[enorme]'; exception when others then if sqlstate <> '22023' then v_cod := v_cod || sqlstate; end if; end;
    begin perform public.auditar_superadmin(gen_random_uuid(), 'Mala Accion', null, '{}'::jsonb); v_cod := v_cod || '[accion]'; exception when others then if sqlstate <> '23514' then v_cod := v_cod || sqlstate; end if; end;
    v_res := v_res || jsonb_build_object('resumen_sin_secretos', jsonb_build_object('ok', v_cod = '', 'detalle', v_cod));

    raise exception 'mr16_fin %', v_res::text using errcode = 'P0001';
  exception when others then
    if sqlerrm like 'mr16_fin %' then
      insert into _mr16_func select e.key, (e.value ->> 'ok')::boolean, left(e.value ->> 'detalle', 300) from jsonb_each(substr(sqlerrm, 10)::jsonb) e;
    else
      raise exception '% (en la prueba "%")', sqlerrm, v_item using errcode = sqlstate;
    end if;
  end;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 5.2 la tabla de comprobaciones
drop table if exists pg_temp._mr16_verif;
create temp table _mr16_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr16_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  -- ---- 1. vigencia ----
  ('calcular_vigencia: suspendido no sirve aunque la fecha este lejos; sin fecha = sin vencimiento (prueba o activo segun la columna)',
    (public.calcular_vigencia('suspendido', date '2099-01-01', 5, 'America/Bogota', timestamptz '2026-10-20 12:00-05') ->> 'estado') = 'suspendido'
      and (public.calcular_vigencia('suspendido', date '2099-01-01', 5, 'America/Bogota', timestamptz '2026-10-20 12:00-05') ->> 'sirve') = 'false'
      and (public.calcular_vigencia('activo', null, 5, 'America/Bogota', now()) ->> 'estado') = 'activo'
      and (public.calcular_vigencia('prueba', null, 5, 'America/Bogota', now()) ->> 'estado') = 'prueba'
      and (public.calcular_vigencia('activo', null, 5, 'America/Bogota', now()) ->> 'sin_vencimiento') = 'true'
      and (public.calcular_vigencia('activo', null, 5, 'America/Bogota', now()) ->> 'sirve') = 'true',
    null),

  ('calcular_vigencia: el dia de vigente_hasta aun es activo/prueba; despues gracia (con su cuenta de dias); pasada la gracia, vencido',
    (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-20 23:30-05') ->> 'estado') = 'activo'
      and (public.calcular_vigencia('prueba', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-20 23:30-05') ->> 'estado') = 'prueba'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-21 00:30-05') ->> 'estado') = 'gracia'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-21 00:30-05') ->> 'dias_para_suspension') = '5'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-25 12:00-05') ->> 'estado') = 'gracia'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-25 12:00-05') ->> 'dias_para_suspension') = '1'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-26 12:00-05') ->> 'estado') = 'vencido'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-26 12:00-05') ->> 'sirve') = 'false'
      and (public.calcular_vigencia('activo', date '2026-10-20', 0, 'America/Bogota', timestamptz '2026-10-21 12:00-05') ->> 'estado') = 'vencido',
    null),

  ('calcular_vigencia: "hoy" es la fecha en la zona del restaurante (a las 23:30 de Bogota ya es el dia siguiente en Tokio) y una zona desconocida usa Bogota',
    (public.calcular_vigencia('activo', date '2026-10-20', 5, 'America/Bogota', timestamptz '2026-10-20 23:30-05') ->> 'estado') = 'activo'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'Asia/Tokyo', timestamptz '2026-10-20 23:30-05') ->> 'estado') = 'gracia'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, 'No/Existe', timestamptz '2026-10-20 23:30-05') ->> 'estado') = 'activo'
      and (public.calcular_vigencia('activo', date '2026-10-20', 5, null, timestamptz '2026-10-20 23:30-05') ->> 'estado') = 'activo',
    null),

  ('Taqueiros (sin vigente_hasta) sigue sin vencimiento: vigencia_restaurante dice activo y sirve',
    (select (public.vigencia_restaurante(r.id) ->> 'sirve') = 'true' and (public.vigencia_restaurante(r.id) ->> 'sin_vencimiento') = 'true'
            and (public.vigencia_restaurante(r.id) ->> 'estado') in ('activo', 'prueba')
     from public.restaurantes r where r.id = public.restaurante_taqueiros_id() and r.vigente_hasta is null),
    null),

  -- ---- 2. auditoria ----
  ('auditoria_superadmin: RLS activo y sin ninguna politica',
    (select c.relrowsecurity from pg_class c where c.oid = 'public.auditoria_superadmin'::regclass)
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'auditoria_superadmin'),
    null),

  ('auditoria_superadmin: ni anon, ni authenticated ni service_role tienen ningun privilegio sobre la tabla',
    not exists (select 1 from unnest(array['anon','authenticated','service_role']) r(rol)
                where has_table_privilege(r.rol, 'public.auditoria_superadmin', 'select,insert,update,delete,truncate,references,trigger')),
    null),

  ('auditoria_superadmin: tiene los tres triggers que rechazan UPDATE, DELETE y TRUNCATE',
    (select count(*) = 3 from pg_trigger t where t.tgrelid = 'public.auditoria_superadmin'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
       and t.tgname in ('auditoria_no_actualizar', 'auditoria_no_borrar', 'auditoria_no_vaciar')),
    null),

  ('la auditoria es de solo agregar: UPDATE, DELETE (con y sin WHERE) y TRUNCATE se rechazan con 42501 incluso al dueno de la tabla',
    (select h.ok from _mr16_func h where h.k = 'auditoria_solo_agregar'), (select h.detalle from _mr16_func h where h.k = 'auditoria_solo_agregar')),

  ('el resumen de la auditoria rechaza lo que parece un secreto, lo enorme y una accion mal escrita',
    (select h.ok from _mr16_func h where h.k = 'resumen_sin_secretos'), (select h.detalle from _mr16_func h where h.k = 'resumen_sin_secretos')),

  ('nadie puede ejecutar las ayudas internas ni la funcion de auditoria (ni anon, ni authenticated, ni service_role)',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and p.proname in ('exigir_superadmin', 'auditar_superadmin', 'auditoria_solo_agregar', 'sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno')
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))),
    null),

  -- ---- 3. funciones de superadmin ----
  ('hay 15 funciones sa_* de superadmin',
    (select count(*) = 15 from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'sa\_%' escape '\'
       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno')),
    (select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'sa\_%' escape '\'
       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno'))),

  ('todas son SECURITY DEFINER con search_path fijo; service_role las ejecuta; anon y authenticated NO',
    (select bool_and(p.prosecdef
                     and p.proconfig is not null and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
                     and has_function_privilege('service_role', p.oid, 'execute')
                     and not has_function_privilege('anon', p.oid, 'execute')
                     and not has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'sa\_%' escape '\'
       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno')),
    null),

  ('lo PRIMERO que hace cada funcion sa_* es exigir_superadmin(p_actor)',
    (select bool_and(position('perform public.exigir_superadmin(p_actor);' in p.prosrc) > 0
                     and position('perform public.exigir_superadmin(p_actor);' in p.prosrc) < least(
                           coalesce(nullif(position('select ' in p.prosrc), 0), 1000000), coalesce(nullif(position('insert ' in p.prosrc), 0), 1000000),
                           coalesce(nullif(position('update ' in p.prosrc), 0), 1000000), coalesce(nullif(position('delete ' in p.prosrc), 0), 1000000)))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'sa\_%' escape '\'
       and p.proname not in ('sa_texto_raro', 'sa_zona_valida', 'sa_estado_secretos_interno')),
    null),

  ('alguien que no es superadmin (o un actor nulo) no puede ejecutar ninguna funcion sa_* (42501)',
    (select h.ok from _mr16_func h where h.k = 'no_superadmin'), (select h.detalle from _mr16_func h where h.k = 'no_superadmin')),

  ('ninguna funcion nueva devuelve secretos: las que tocan restaurante_secretos solo devuelven si/no por campo',
    (select count(*) = 3 from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and p.proname in ('sa_guardar_secretos', 'sa_estado_secretos', 'sa_estado_secretos_interno')),
    null),

  -- ---- 4. seguridad general ----
  ('calcular_vigencia y vigencia_restaurante: anon no las ejecuta; authenticated y service_role si; vigencia_restaurante NO es SECURITY DEFINER (manda RLS)',
    (select count(*) = 2 and bool_and(not has_function_privilege('anon', p.oid, 'execute')
                                     and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute')
                                     and (p.proname <> 'vigencia_restaurante' or not p.prosecdef))
     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('calcular_vigencia', 'vigencia_restaurante')),
    null),

  ('anon: sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    null),

  ('authenticated: sin privilegios sobre la auditoria (y ninguna tabla nueva fuera de las conocidas)',
    not has_table_privilege('authenticated', 'public.auditoria_superadmin', 'select,insert,update,delete'),
    null),

  ('RLS activo en TODAS las tablas de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
    null),

  ('anon solo puede ejecutar seguimiento y buscar_mis_pedidos',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
                  and p.oid not in ('public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and has_function_privilege('anon', p.oid, 'execute')),
    (select string_agg(p.proname, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
       and p.oid not in ('public.seguimiento(text)'::regprocedure,
                         'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('anon', p.oid, 'execute'))),

  ('ninguna funcion SECURITY DEFINER desconocida la pueden llamar anon o authenticated',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
                  and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
                  and p.oid not in ('public.config_jornada(uuid)'::regprocedure,
                                    'public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))),
    (select string_agg(p.proname, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
       and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
       and p.oid not in ('public.config_jornada(uuid)'::regprocedure,
                         'public.seguimiento(text)'::regprocedure,
                         'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),

  ('los triggers de proteccion de los SQL 10 y 13 siguen activos',
    (select count(*) = 12 from pg_trigger
     where not tgisinternal and tgenabled <> 'D' and tgname in (
       'pedidos_proteger_pago', 'pedidos_restaurante_inmutable', 'categorias_restaurante_inmutable',
       'productos_restaurante_inmutable', 'configuracion_restaurante_inmutable', 'pedidos_limitar_rol',
       'productos_validar', 'categorias_validar', 'pedidos_asignar_numero', 'restaurantes_proteger',
       'restaurantes_validar_config', 'configuracion_proteger')),
    null),

  -- ---- 5. este archivo no cambio datos ----
  ('ninguna fila cambio (conteos y huellas de pedidos, categorias, productos, configuracion, salud, restaurantes, miembros, superadmins, tarifas, secretos y dominios)',
    not exists (select 1 from _mr16_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
                      union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
                      union all select 'superadmins', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id), '')) from public.superadmins t
                      union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
                      union all select 'restaurante_secretos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.restaurante_secretos t
                      union all select 'restaurante_dominios', count(*), md5(coalesce(string_agg(t::text, '|' order by t.host), '')) from public.restaurante_dominios t
                     ) d on d.tabla = a.tabla
                where d.filas <> a.filas or d.huella <> a.huella),
    null),

  ('no quedo ninguna fila de prueba en la auditoria',
    not exists (select 1 from public.auditoria_superadmin a where a.accion = 'prueba_mr16'),
    null),

  ('informativo: superadmins dados de alta (se agregan con node supabase/crear-superadmin.mjs)',
    true,
    (select count(*)::text from public.superadmins))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr16_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 16 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- PostgREST tiene que enterarse de las funciones nuevas.
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr16_verif
order by orden;
