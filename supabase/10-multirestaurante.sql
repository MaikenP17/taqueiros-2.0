-- =============================================================
-- TAQUEIROS 2.0 — BASE DE DATOS MULTI-RESTAURANTE  (SQL 10)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- ANTES DE CORRERLO
--   1. Haz el respaldo:        node supabase/exportar-respaldo.mjs
--   2. (Recomendado) corre     supabase/00-inspeccion-esquema.sql
--      y revisa que no haya tablas ni politicas desconocidas.
--
-- QUE HACE (resumen; el detalle esta en docs/multirestaurante.md)
--   * Crea restaurantes, restaurante_secretos, miembros, superadmins,
--     contadores_pedido y tarifas_domicilio.
--   * Registra a Los Taqueiros como restaurante #1 y pasa a
--     public.personal -> public.miembros (rol 'dueno').
--   * Agrega restaurante_id (NOT NULL, con un valor por defecto
--     TRANSITORIO = Taqueiros) a pedidos, categorias, productos,
--     configuracion y salud_notificaciones.
--   * Numero de pedido por restaurante (contador atomico). Los
--     numeros que ya existen no cambian.
--   * Reescribe TODAS las politicas RLS con la matriz de roles.
--   * Cierra a 'anon': ya no toca ninguna tabla; solo quedan dos
--     funciones publicas (seguimiento y buscar_mis_pedidos).
--   * Fotos: politicas de Storage por carpeta {restaurante_id}/.
--
-- QUE NO HACE
--   * No borra tablas, columnas ni filas. No cambia ningun dato de
--     pedidos, productos, categorias ni numeros de pedido.
--   * No toca api/*.js ni el front: el sitio sigue funcionando igual.
--   * No agrega superadmins (ver el INSERT comentado mas abajo).
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una
-- transaccion. Si cualquier paso o comprobacion falla, TODO se
-- revierte y no queda nada a medias.
--
-- IMPORTANTE: despues de correr este archivo NO vuelvas a correr
-- los SQL antiguos (seguridad.sql, menu.sql, configuracion.sql,
-- jornada.sql, resumen-jornada.sql, 01, 02...): recrearian las
-- politicas y funciones de un solo restaurante.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA.
-- =============================================================

begin;

-- Si la base esta ocupada, mejor fallar (y revertir) que quedarse
-- esperando con el panel colgado.
set local lock_timeout = '20s';


-- =============================================================
-- 0) PRECONDICIONES Y FOTO DEL "ANTES"
-- =============================================================
do $do$
declare
  faltan text[] := '{}';
  t text;
begin
  foreach t in array array['pedidos','categorias','productos','configuracion','salud_notificaciones','personal'] loop
    if to_regclass('public.' || t) is null then
      faltan := faltan || ('tabla public.' || t);
    end if;
  end loop;

  if to_regprocedure('public.tocar_actualizado_en()') is null then faltan := faltan || 'funcion tocar_actualizado_en (schema.sql)'; end if;
  if to_regprocedure('public.marcar_cambio_de_estado()') is null then faltan := faltan || 'funcion marcar_cambio_de_estado (jornada.sql)'; end if;
  if to_regprocedure('public.jornada_de(timestamptz,time)') is null then faltan := faltan || 'funcion jornada_de (jornada.sql)'; end if;
  if to_regprocedure('public.seguimiento(text)') is null then faltan := faltan || 'funcion seguimiento (seguimiento.sql)'; end if;
  if to_regprocedure('public.limpiar_pedidos_huerfanos(integer)') is null then faltan := faltan || 'funcion limpiar_pedidos_huerfanos (limpieza-huerfanos.sql)'; end if;

  if to_regclass('public.pedidos') is not null then
    foreach t in array array['subtotal','costo_domicilio','estado_cambiado_en','alerta_enviada','notificacion_ok','barrio_detectado'] loop
      if not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'pedidos' and column_name = t) then
        faltan := faltan || ('columna pedidos.' || t);
      end if;
    end loop;
  end if;

  if to_regclass('public.configuracion') is not null then
    foreach t in array array['hora_corte_jornada','minutos_ocultar_terminados'] loop
      if not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'configuracion' and column_name = t) then
        faltan := faltan || ('columna configuracion.' || t);
      end if;
    end loop;
  end if;

  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    faltan := faltan || 'publicacion supabase_realtime';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    faltan := faltan || 'Storage de Supabase';
  end if;

  if array_length(faltan, 1) > 0 then
    raise exception 'Faltan cosas de los SQL anteriores. Corre primero esos archivos: %', array_to_string(faltan, '; ');
  end if;
end
$do$;

-- Conteos de antes: la comprobacion final exige que sigan iguales.
drop table if exists pg_temp._mr_antes;
create temp table _mr_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas from public.pedidos
union all select 'categorias', count(*) from public.categorias
union all select 'productos', count(*) from public.productos
union all select 'configuracion', count(*) from public.configuracion
union all select 'salud_notificaciones', count(*) from public.salud_notificaciones
union all select 'personal', count(*) from public.personal;

-- Banderas de "esto se hizo en ESTA corrida" (para comprobar solo lo que corresponde).
drop table if exists pg_temp._mr_flags;
create temp table _mr_flags (k text primary key, v boolean not null);


-- =============================================================
-- 1) EL RESTAURANTE POR DEFECTO (TRANSITORIO)
-- =============================================================
-- Valor por defecto de las columnas restaurante_id mientras el codigo
-- actual no sabe de restaurantes. SE RETIRA EN EL SIGUIENTE PASO:
--   alter table public.<tabla> alter column restaurante_id drop default;
-- y entonces esta funcion se puede borrar.
create or replace function public.restaurante_taqueiros_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select '00000000-0000-4000-8000-000000000001'::uuid;
$$;

revoke all on function public.restaurante_taqueiros_id() from public, anon;
grant execute on function public.restaurante_taqueiros_id() to authenticated, service_role;


-- =============================================================
-- 2) TABLAS NUEVAS
-- =============================================================

-- 2.1 restaurantes ---------------------------------------------------
create table if not exists public.restaurantes (
  id                 uuid primary key default gen_random_uuid(),
  -- Para subdominio o ruta (taqueiros.tuapp.com). Solo minusculas,
  -- numeros y guiones; nunca empieza ni termina en guion.
  slug               text not null unique
                     check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 40),
  nombre             text not null check (btrim(nombre) <> ''),
  estado             text not null default 'prueba'
                     check (estado in ('prueba','activo','suspendido')),
  -- Plan, modalidad y modulos: SOLO estructura. Ninguna logica los usa todavia.
  plan               text not null default 'completo'
                     check (plan in ('completo','basico','comandas')),
  modalidad_pago     text not null default 'mensual'
                     check (modalidad_pago in ('mensual','unico')),
  vigente_hasta      date,                       -- null = sin vencimiento
  dias_gracia        integer not null default 5 check (dias_gracia >= 0),
  modulos            jsonb not null
                     default '{"pasarela":true,"seguimiento":true,"comandas":true,"impresion":true}'::jsonb
                     check (jsonb_typeof(modulos) = 'object'),
  zona_horaria       text not null default 'America/Bogota',
  hora_corte_jornada time not null default '05:00',
  -- Colores, logo, WhatsApp, coordenadas... se llenan en el siguiente paso.
  config             jsonb not null default '{}'::jsonb
                     check (jsonb_typeof(config) = 'object'),
  creado_en          timestamptz not null default now()
);

-- Los Taqueiros = restaurante #1. Conserva la hora de corte actual.
insert into public.restaurantes (id, slug, nombre, estado, plan, modalidad_pago, hora_corte_jornada)
select public.restaurante_taqueiros_id(), 'taqueiros', 'Los Taqueiros', 'activo', 'completo', 'mensual',
       coalesce((select c.hora_corte_jornada from public.configuracion c order by c.id limit 1), '05:00'::time)
on conflict (id) do nothing;

-- 2.2 restaurante_secretos ------------------------------------------
-- Datos privados de cada restaurante. SIN politicas para anon ni
-- authenticated (y sin privilegios): solo el servidor, con la llave
-- secreta. Hoy estos valores viven en variables de entorno de Vercel;
-- el siguiente paso los pasa aqui.
create table if not exists public.restaurante_secretos (
  restaurante_id               uuid primary key references public.restaurantes(id) on delete cascade,
  wompi_llave_publica_test     text,
  wompi_llave_publica_prod     text,
  wompi_integridad_test        text,
  wompi_integridad_prod        text,
  wompi_eventos_test           text,
  wompi_eventos_prod           text,
  callmebot_telefono           text,
  callmebot_apikey             text,
  otros                        jsonb not null default '{}'::jsonb,
  actualizado_en               timestamptz not null default now()
);

insert into public.restaurante_secretos (restaurante_id)
values (public.restaurante_taqueiros_id())
on conflict (restaurante_id) do nothing;

-- 2.3 miembros -------------------------------------------------------
create table if not exists public.miembros (
  user_id        uuid not null references auth.users(id) on delete cascade,
  restaurante_id uuid not null references public.restaurantes(id) on delete cascade,
  rol            text not null check (rol in ('dueno','cajero','cocina')),
  activo         boolean not null default true,
  creado_en      timestamptz not null default now(),
  primary key (user_id, restaurante_id)
);
create index if not exists miembros_restaurante_idx on public.miembros (restaurante_id);

-- Quien hoy esta en public.personal es 'dueno' de Taqueiros.
-- public.personal NO se borra ni se toca (ningun codigo la consulta,
-- asi que no hace falta una vista de compatibilidad); queda como
-- tabla legada y un trigger (abajo) refleja en miembros lo que se
-- agregue o quite alla.
insert into public.miembros (user_id, restaurante_id, rol, activo, creado_en)
select p.id, public.restaurante_taqueiros_id(), 'dueno', true, p.creado_en
from public.personal p
on conflict (user_id, restaurante_id) do nothing;

-- 2.4 superadmins ----------------------------------------------------
-- Solo para Carlos. Ningun cliente la ve (salvo su propia fila, si fuera superadmin).
create table if not exists public.superadmins (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  creado_en timestamptz not null default now()
);

-- PARA HACERTE SUPERADMIN (hazlo tu, cuando quieras; no se hace solo):
--   1. Authentication -> Users -> copia tu UID.
--   2. Quita los "--" de la linea de abajo, pega tu UID y ejecuta SOLO esa linea:
-- insert into public.superadmins (user_id) values ('PEGA-AQUI-TU-UID') on conflict do nothing;

-- 2.5 contadores_pedido (numero de pedido por restaurante) ----------
create table if not exists public.contadores_pedido (
  restaurante_id uuid primary key references public.restaurantes(id) on delete cascade,
  ultimo         bigint not null default 0 check (ultimo >= 0)
);

-- 2.6 tarifas_domicilio ---------------------------------------------
-- Hoy las tarifas estan escritas en api/_domicilio.js y en index.html
-- (TARIFAS_DOMICILIO). El codigo SIGUE leyendo de ahi; el siguiente
-- paso lo pasa a esta tabla. precio null = fuera de cobertura.
create table if not exists public.tarifas_domicilio (
  id             bigint generated always as identity primary key,
  restaurante_id uuid not null references public.restaurantes(id),
  hasta          numeric(6,1) not null check (hasta > 0),   -- limite del rango, en km
  precio         integer check (precio is null or precio >= 0),
  creado_en      timestamptz not null default now(),
  unique (restaurante_id, hasta)
);

insert into public.tarifas_domicilio (restaurante_id, hasta, precio)
values
  (public.restaurante_taqueiros_id(),   2,  5000),   -- 0 - 2 km
  (public.restaurante_taqueiros_id(),   4,  7000),   -- 2 - 4 km
  (public.restaurante_taqueiros_id(),   6,  9000),   -- 4 - 6 km
  (public.restaurante_taqueiros_id(),   8, 12000),   -- 6 - 8 km
  (public.restaurante_taqueiros_id(), 999,  null)    -- +8 km: coordinar por WhatsApp
on conflict (restaurante_id, hasta) do nothing;


-- =============================================================
-- 3) FUNCIONES AUXILIARES DE SEGURIDAD
-- =============================================================
-- Todas STABLE, SECURITY INVOKER (a proposito: leen miembros /
-- superadmins con la identidad de quien pregunta, y esas tablas solo
-- le muestran SUS filas), search_path vacio y nombres calificados.
-- Sin EXECUTE para PUBLIC ni anon; solo authenticated (y el servidor).

create or replace function public.es_superadmin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.superadmins s where s.user_id = (select auth.uid())
  );
$$;

create or replace function public.es_miembro(p_restaurante_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.miembros m
    where m.user_id = (select auth.uid())
      and m.restaurante_id = p_restaurante_id
      and m.activo
  );
$$;

-- Rol de quien pregunta en ese restaurante ('dueno','cajero','cocina') o null.
create or replace function public.rol_en(p_restaurante_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select m.rol from public.miembros m
  where m.user_id = (select auth.uid())
    and m.restaurante_id = p_restaurante_id
    and m.activo
  limit 1;
$$;

-- Restaurante "actual" de quien pregunta: el de su (primera) membresia
-- activa. Lo usan las funciones del panel actual, que todavia no
-- mandan el restaurante. null si no pertenece a ninguno.
create or replace function public.restaurante_actual()
returns uuid
language sql
stable
set search_path = ''
as $$
  select m.restaurante_id from public.miembros m
  where m.user_id = (select auth.uid()) and m.activo
  order by m.creado_en, m.restaurante_id
  limit 1;
$$;

-- ¿La llamada viene del servidor (llave secreta) o del editor SQL?
-- NO LLEVA SECURITY DEFINER (igual que proteger_campos_de_pago): dentro
-- de una funcion definer current_user seria el dueno y siempre daria true.
create or replace function public.es_servidor()
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
begin
  return current_user in ('service_role', 'postgres', 'supabase_admin')
      or (coalesce(claims, '') <> '' and (claims::jsonb) ->> 'role' = 'service_role');
end;
$$;

-- es_personal() existia (seguridad.sql) y ya no la usa ninguna politica.
-- Se conserva con el mismo nombre: ahora significa "es miembro activo
-- de algun restaurante".
create or replace function public.es_personal()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.miembros m where m.user_id = (select auth.uid()) and m.activo
  );
$$;

-- Permisos: nada para PUBLIC/anon; authenticated y el servidor si.
do $do$
declare f text;
begin
  foreach f in array array[
    'public.es_superadmin()', 'public.es_miembro(uuid)', 'public.rol_en(uuid)',
    'public.restaurante_actual()', 'public.es_servidor()', 'public.es_personal()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$do$;

-- public.personal (legada) -> miembros: lo que se agregue o quite alla
-- se refleja aca, para que las instrucciones viejas ("insert into
-- personal") sigan funcionando mientras tanto.
create or replace function public.personal_a_miembros()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.miembros (user_id, restaurante_id, rol, activo)
    values (new.id, public.restaurante_taqueiros_id(), 'dueno', true)
    on conflict (user_id, restaurante_id) do update set activo = true;
    return new;
  elsif tg_op = 'DELETE' then
    update public.miembros set activo = false
    where user_id = old.id and restaurante_id = public.restaurante_taqueiros_id();
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists personal_refleja_en_miembros on public.personal;
create trigger personal_refleja_en_miembros
  after insert or delete on public.personal
  for each row execute function public.personal_a_miembros();

revoke all on function public.personal_a_miembros() from public, anon, authenticated;


-- =============================================================
-- 4) restaurante_id EN LAS TABLAS DE NEGOCIO
-- =============================================================
-- Una sola sentencia por tabla: agrega la columna NOT NULL con el
-- valor por defecto transitorio (Taqueiros). Postgres rellena las
-- filas existentes SIN ejecutar UPDATEs, asi que no se disparan
-- triggers, no cambia 'actualizado_en' y Realtime no emite eventos.
do $do$
declare t text;
begin
  foreach t in array array['pedidos','categorias','productos','configuracion','salud_notificaciones'] loop
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = t and column_name = 'restaurante_id') then
      execute format(
        'alter table public.%I add column restaurante_id uuid not null '
        'default public.restaurante_taqueiros_id() references public.restaurantes(id)', t);
      insert into _mr_flags (k, v) values ('rid_nuevo_' || t, true) on conflict (k) do nothing;
    end if;
  end loop;
end
$do$;

-- 4.1 categorias y productos: la llave primaria pasa a ser por restaurante
do $do$
declare
  r record;
begin
  -- Fuera las llaves foraneas de productos hacia categorias (se rehacen compuestas)
  for r in select conname from pg_constraint
           where conrelid = 'public.productos'::regclass and contype = 'f'
             and confrelid = 'public.categorias'::regclass loop
    execute format('alter table public.productos drop constraint %I', r.conname);
  end loop;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.categorias'::regclass and contype = 'p'
                   and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id, id)') then
    for r in select conname from pg_constraint
             where conrelid = 'public.categorias'::regclass and contype = 'p' loop
      execute format('alter table public.categorias drop constraint %I', r.conname);
    end loop;
    alter table public.categorias add constraint categorias_pkey primary key (restaurante_id, id);
  end if;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.productos'::regclass and contype = 'p'
                   and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id, id)') then
    for r in select conname from pg_constraint
             where conrelid = 'public.productos'::regclass and contype = 'p' loop
      execute format('alter table public.productos drop constraint %I', r.conname);
    end loop;
    alter table public.productos add constraint productos_pkey primary key (restaurante_id, id);
  end if;

  -- Un producto solo puede apuntar a una categoria DE SU MISMO restaurante
  alter table public.productos
    add constraint productos_categoria_fkey
    foreign key (restaurante_id, categoria) references public.categorias (restaurante_id, id)
    on update cascade;
end
$do$;

-- 4.2 configuracion y salud_notificaciones: una fila POR RESTAURANTE
-- La columna 'id' se conserva (el codigo actual consulta id = 1): la
-- fila de Taqueiros sigue siendo id = 1; las de los demas usaran 0, asi
-- esas consultas jamas se cruzan con otro restaurante.
do $do$
declare r record;
begin
  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.configuracion'::regclass and contype = 'p'
                   and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id)') then
    for r in select conname from pg_constraint
             where conrelid = 'public.configuracion'::regclass and contype = 'p' loop
      execute format('alter table public.configuracion drop constraint %I', r.conname);
    end loop;
    alter table public.configuracion add constraint configuracion_pkey primary key (restaurante_id);
  end if;
  alter table public.configuracion drop constraint if exists configuracion_una_sola_fila;
  alter table public.configuracion alter column id set default 0;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.salud_notificaciones'::regclass and contype = 'p'
                   and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id)') then
    for r in select conname from pg_constraint
             where conrelid = 'public.salud_notificaciones'::regclass and contype = 'p' loop
      execute format('alter table public.salud_notificaciones drop constraint %I', r.conname);
    end loop;
    alter table public.salud_notificaciones add constraint salud_notificaciones_pkey primary key (restaurante_id);
  end if;
  alter table public.salud_notificaciones drop constraint if exists salud_una_sola_fila;
  alter table public.salud_notificaciones alter column id set default 0;
end
$do$;

-- 4.3 Nombres de categoria unicos POR restaurante (antes: globales)
create or replace function public.norm_texto(t text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(
    regexp_replace(
      translate(lower(coalesce(t, '')),
                'áàäâéèëêíìïîóòöôúùüûñ',
                'aaaaeeeeiiiioooouuuun'),
      '\s+', ' ', 'g')
  );
$$;

create unique index if not exists categorias_restaurante_nombre_norm_uq
  on public.categorias (restaurante_id, public.norm_texto(nombre));
drop index if exists public.categorias_nombre_norm_uq;

-- 4.4 Indices
create index if not exists pedidos_restaurante_creado_idx    on public.pedidos (restaurante_id, creado_en desc);
create index if not exists pedidos_restaurante_estado_idx    on public.pedidos (restaurante_id, estado);
create index if not exists pedidos_restaurante_alerta_idx    on public.pedidos (restaurante_id, pagado_en)
  where estado = 'nuevo' and alerta_enviada = false;
create index if not exists categorias_restaurante_orden_idx  on public.categorias (restaurante_id, orden);
create index if not exists productos_restaurante_cat_idx     on public.productos (restaurante_id, categoria, orden);
create index if not exists tarifas_restaurante_idx           on public.tarifas_domicilio (restaurante_id, hasta);

-- 4.5 Numero de pedido POR restaurante
-- 'numero' es lo que se le muestra al cliente. Para los pedidos que ya
-- existen vale exactamente su id de hoy (no cambia ningun numero). Se
-- rellena con ALTER ... USING: reescribe la tabla sin ejecutar
-- triggers ni UPDATEs (no toca 'actualizado_en' ni emite eventos).
do $do$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'pedidos' and column_name = 'numero') then
    alter table public.pedidos add column numero bigint;
    alter table public.pedidos alter column numero type bigint using id;
    insert into _mr_flags (k, v) values ('numero_nuevo', true) on conflict (k) do nothing;
  end if;
end
$do$;

alter table public.pedidos alter column numero set not null;
create unique index if not exists pedidos_restaurante_numero_uq on public.pedidos (restaurante_id, numero);

-- Contador de Taqueiros: continua DESPUES del ultimo numero y tambien
-- despues del ultimo id entregado por la secuencia (asi, mientras el
-- codigo actual siga mostrando el id, numero e id coinciden).
insert into public.contadores_pedido (restaurante_id, ultimo)
select public.restaurante_taqueiros_id(),
       greatest(
         coalesce((select max(p.numero) from public.pedidos p where p.restaurante_id = public.restaurante_taqueiros_id()), 0),
         coalesce((select max(p.id) from public.pedidos p), 0),
         coalesce((select s.last_value from pg_sequences s
                   where s.schemaname = 'public'
                     and s.sequencename = split_part(pg_get_serial_sequence('public.pedidos', 'id'), '.', 2)), 0))
on conflict (restaurante_id) do nothing;

-- Incremento atomico: INSERT ... ON CONFLICT DO UPDATE ... RETURNING.
-- Dos pedidos simultaneos del mismo restaurante se ponen en fila sobre
-- la fila del contador; nunca reciben el mismo numero.
-- SECURITY DEFINER a proposito: el contador no tiene politicas para
-- clientes. Nadie puede llamarla directo (solo el servidor y el trigger).
create or replace function public.siguiente_numero_pedido(p_restaurante_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into public.contadores_pedido as c (restaurante_id, ultimo)
  values (p_restaurante_id,
          coalesce((select max(p.numero) from public.pedidos p where p.restaurante_id = p_restaurante_id), 0) + 1)
  on conflict (restaurante_id) do update
    set ultimo = greatest(c.ultimo,
                          coalesce((select max(p.numero) from public.pedidos p
                                    where p.restaurante_id = p_restaurante_id), 0)) + 1
  returning c.ultimo;
$$;

revoke all on function public.siguiente_numero_pedido(uuid) from public, anon, authenticated;
grant execute on function public.siguiente_numero_pedido(uuid) to service_role;

-- Asigna el numero al insertar. Un cliente (JWT que no es del servidor)
-- no puede elegir su numero: se le ignora y se asigna el siguiente.
create or replace function public.asignar_numero_pedido()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
  es_cliente boolean := coalesce(claims, '') <> '' and (claims::jsonb) ->> 'role' is distinct from 'service_role';
begin
  if new.numero is null or es_cliente then
    new.numero := public.siguiente_numero_pedido(new.restaurante_id);
  end if;
  return new;
end;
$$;

revoke all on function public.asignar_numero_pedido() from public, anon, authenticated;

drop trigger if exists pedidos_asignar_numero on public.pedidos;
create trigger pedidos_asignar_numero
  before insert on public.pedidos
  for each row execute function public.asignar_numero_pedido();

-- 4.6 Preparacion: cuando se hizo el reembolso de un pedido cancelado.
-- Solo la columna; ningun codigo la usa todavia.
alter table public.pedidos add column if not exists reembolsado_en timestamptz;

-- 4.7 Alta automatica de un restaurante nuevo: secretos, contador,
-- configuracion y estado del WhatsApp. SECURITY DEFINER porque esas
-- tablas no tienen politicas para clientes.
create or replace function public.aprovisionar_restaurante()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.restaurante_secretos (restaurante_id) values (new.id) on conflict do nothing;
  insert into public.contadores_pedido (restaurante_id, ultimo) values (new.id, 0) on conflict do nothing;
  insert into public.configuracion (restaurante_id, id, horarios, hora_corte_jornada)
  values (
    new.id,
    case when new.id = public.restaurante_taqueiros_id() then 1 else 0 end,
    '[
      {"dia":"Domingo",   "abre":"11:00","cierra":"22:00","activo":true},
      {"dia":"Lunes",     "abre":"11:00","cierra":"22:00","activo":true},
      {"dia":"Martes",    "abre":"11:00","cierra":"22:00","activo":true},
      {"dia":"Miércoles", "abre":"11:00","cierra":"22:00","activo":true},
      {"dia":"Jueves",    "abre":"11:00","cierra":"22:00","activo":true},
      {"dia":"Viernes",   "abre":"11:00","cierra":"22:00","activo":true},
      {"dia":"Sábado",    "abre":"11:00","cierra":"22:00","activo":true}
    ]'::jsonb,
    new.hora_corte_jornada)
  on conflict (restaurante_id) do nothing;
  insert into public.salud_notificaciones (restaurante_id, id, fallos_seguidos)
  values (new.id, case when new.id = public.restaurante_taqueiros_id() then 1 else 0 end, 0)
  on conflict (restaurante_id) do nothing;
  return new;
end;
$$;

revoke all on function public.aprovisionar_restaurante() from public, anon, authenticated;

drop trigger if exists restaurantes_aprovisionar on public.restaurantes;
create trigger restaurantes_aprovisionar
  after insert on public.restaurantes
  for each row execute function public.aprovisionar_restaurante();


-- =============================================================
-- 5) TRIGGERS DE PROTECCION
-- =============================================================

-- 5.1 Dinero y numero del pedido: de solo lectura para el navegador.
-- Es la misma funcion de seguridad.sql (SIN SECURITY DEFINER, ver la
-- advertencia alli) con dos columnas mas: numero y reembolsado_en
-- (que restaurante_id no cambie lo cuida bloquear_cambio_restaurante).
create or replace function public.proteger_campos_de_pago()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  claims text := current_setting('request.jwt.claims', true);
  rol    text := null;
begin
  if claims is not null and claims <> '' then
    rol := (claims::jsonb) ->> 'role';
  end if;

  if current_user in ('service_role', 'postgres', 'supabase_admin')
     or rol = 'service_role' then
    return new;
  end if;

  if new.total is distinct from old.total
     or new.subtotal is distinct from old.subtotal
     or new.costo_domicilio is distinct from old.costo_domicilio
     or new.estado_pago is distinct from old.estado_pago
     or new.items is distinct from old.items
     or new.referencia is distinct from old.referencia
     or new.wompi_transaction_id is distinct from old.wompi_transaction_id
     or new.numero is distinct from old.numero
     or new.reembolsado_en is distinct from old.reembolsado_en then
    raise exception 'No se pueden modificar los datos de pago de un pedido';
  end if;

  return new;
end;
$$;

drop trigger if exists pedidos_proteger_pago on public.pedidos;
create trigger pedidos_proteger_pago
  before update on public.pedidos
  for each row execute function public.proteger_campos_de_pago();

-- 5.2 Un registro nunca cambia de restaurante desde el navegador.
create or replace function public.bloquear_cambio_restaurante()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.restaurante_id is distinct from old.restaurante_id
     and not public.es_servidor()
     and not (select public.es_superadmin()) then
    raise exception 'No se puede cambiar el restaurante de un registro' using errcode = '42501';
  end if;
  return new;
end;
$$;

do $do$
declare t text;
begin
  foreach t in array array['pedidos','categorias','productos','configuracion','salud_notificaciones','tarifas_domicilio'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_restaurante_inmutable', t);
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.bloquear_cambio_restaurante()',
      t || '_restaurante_inmutable', t);
  end loop;
end
$do$;

-- 5.3 La cocina solo cambia el ESTADO (y las marcas de impresion).
create or replace function public.limitar_edicion_por_rol()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  permitidas constant text[] := array['estado','impreso_en','reimpresiones','reimpreso_en','actualizado_en','estado_cambiado_en'];
begin
  if public.es_servidor() or (select public.es_superadmin()) then
    return new;
  end if;
  if (select public.rol_en(new.restaurante_id)) = 'cocina'
     and (to_jsonb(new) - permitidas) is distinct from (to_jsonb(old) - permitidas) then
    raise exception 'La cocina solo puede cambiar el estado del pedido' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists pedidos_limitar_rol on public.pedidos;
create trigger pedidos_limitar_rol
  before update on public.pedidos
  for each row execute function public.limitar_edicion_por_rol();

-- 5.4 El dueno edita el nombre y la config de su restaurante; plan,
-- estado, vigencia, modulos y slug son de Carlos (servidor/superadmin).
create or replace function public.proteger_campos_restaurante()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.es_servidor() or (select public.es_superadmin()) then
    return new;
  end if;
  if new.id is distinct from old.id
     or new.slug is distinct from old.slug
     or new.estado is distinct from old.estado
     or new.plan is distinct from old.plan
     or new.modalidad_pago is distinct from old.modalidad_pago
     or new.vigente_hasta is distinct from old.vigente_hasta
     or new.dias_gracia is distinct from old.dias_gracia
     or new.modulos is distinct from old.modulos
     or new.zona_horaria is distinct from old.zona_horaria
     or new.hora_corte_jornada is distinct from old.hora_corte_jornada
     or new.creado_en is distinct from old.creado_en then
    raise exception 'Solo se puede cambiar el nombre y la configuracion del restaurante' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists restaurantes_proteger on public.restaurantes;
create trigger restaurantes_proteger
  before update on public.restaurantes
  for each row execute function public.proteger_campos_restaurante();

do $do$
declare f text;
begin
  foreach f in array array[
    'public.bloquear_cambio_restaurante()', 'public.limitar_edicion_por_rol()',
    'public.proteger_campos_restaurante()', 'public.proteger_campos_de_pago()',
    'public.norm_texto(text)', 'public.jornada_de(timestamptz,time)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$do$;


-- =============================================================
-- 6) VALIDACIONES DE CATEGORIAS Y PRODUCTOS (SQL 01, por restaurante)
-- =============================================================
-- Mismas reglas que supabase/01-productos-fotos.sql; la diferencia es
-- que ahora la categoria se busca DENTRO del restaurante y la foto
-- puede vivir en la carpeta {restaurante_id}/.
create or replace function public.validar_categoria()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.nombre := btrim(coalesce(new.nombre, ''));

  if new.nombre = '' then
    raise exception 'El nombre de la categoría es obligatorio';
  end if;
  if char_length(new.nombre) > 40 then
    raise exception 'El nombre de la categoría no puede pasar de 40 caracteres';
  end if;
  if new.nombre ~ '[[:cntrl:]]' then
    raise exception 'El nombre de la categoría tiene caracteres no permitidos';
  end if;

  if tg_op = 'INSERT' and new.id !~ '^[a-z0-9][a-z0-9-]{0,59}$' then
    raise exception 'Identificador de categoría inválido';
  end if;

  return new;
end;
$$;

drop trigger if exists categorias_validar on public.categorias;
create trigger categorias_validar
  before insert or update on public.categorias
  for each row execute function public.validar_categoria();

create or replace function public.validar_producto()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  tope_precio   constant integer := 300000;
  prefijo_bucket constant text :=
    'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/';
  resto text;
begin
  new.nombre := btrim(coalesce(new.nombre, ''));

  if new.nombre = '' then
    raise exception 'El nombre del producto es obligatorio';
  end if;
  if char_length(new.nombre) > 60 then
    raise exception 'El nombre del producto no puede pasar de 60 caracteres';
  end if;
  if new.nombre ~ '[[:cntrl:]]' then
    raise exception 'El nombre del producto tiene caracteres no permitidos';
  end if;

  if new.descripcion is not null and char_length(new.descripcion) > 300 then
    raise exception 'La descripción no puede pasar de 300 caracteres';
  end if;

  if new.precio is null or new.precio < 1 or new.precio > tope_precio then
    raise exception 'El precio debe estar entre $1 y $300.000';
  end if;

  -- La categoria tiene que ser de ESTE restaurante
  if not exists (select 1 from public.categorias c
                 where c.restaurante_id = new.restaurante_id and c.id = new.categoria) then
    raise exception 'La categoría elegida no existe';
  end if;

  if tg_op = 'INSERT' and new.id !~ '^[a-z0-9][a-z0-9-]{1,59}$' then
    raise exception 'Identificador de producto inválido';
  end if;

  -- La foto solo se revisa cuando cambia.
  if new.imagen is not null
     and (tg_op = 'INSERT' or new.imagen is distinct from old.imagen) then
    if left(new.imagen, char_length(prefijo_bucket)) = prefijo_bucket then
      resto := substr(new.imagen, char_length(prefijo_bucket) + 1);
      if resto ~ '^[A-Za-z0-9._-]{1,100}$' then
        -- Ruta plana (la estructura antigua): solo el restaurante original
        if new.restaurante_id <> public.restaurante_taqueiros_id() then
          raise exception 'La dirección de la foto no es válida';
        end if;
      elsif resto ~ ('^' || new.restaurante_id::text || '/[A-Za-z0-9._-]{1,100}$') then
        null;   -- carpeta propia: {restaurante_id}/archivo
      else
        raise exception 'La dirección de la foto no es válida';
      end if;
    elsif new.imagen ~ '^Recursos/[A-Za-z0-9 ._/-]{1,200}$' and new.imagen !~ '\.\.' then
      null;   -- foto que ya viene con el sitio
    else
      raise exception 'La foto debe estar guardada en el bucket de productos';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists productos_validar on public.productos;
create trigger productos_validar
  before insert or update on public.productos
  for each row execute function public.validar_producto();


-- =============================================================
-- 7) IMPRESION (SQL 02) — columnas y funciones, ahora por restaurante
-- =============================================================
-- Si el SQL 02 ya se corrio, esto no cambia nada de lo existente.
-- Si NO se habia corrido, deja las columnas listas (los pedidos pagados
-- que ya existen se dan por impresos, igual que haria el 02).
do $do$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'pedidos' and column_name = 'impreso_en') then
    alter table public.pedidos add column impreso_en timestamptz;
    alter table public.pedidos alter column impreso_en type timestamptz
      using (case when estado <> 'pendiente_pago' then coalesce(pagado_en, creado_en) end);
  end if;
end
$do$;

alter table public.pedidos
  add column if not exists reimpresiones integer not null default 0,
  add column if not exists reimpreso_en  timestamptz;

-- SECURITY INVOKER (como hoy): siguen aplicando RLS y el trigger de pago.
-- Ademas verifican, explicitamente, que el pedido sea de un restaurante
-- del que el usuario es miembro. Un pedido de otro restaurante es
-- invisible por RLS, asi que se rechaza con 42501.
create or replace function public.reclamar_impresion(p_id bigint)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rid   uuid;
  v_filas integer;
begin
  select p.restaurante_id into v_rid from public.pedidos p where p.id = p_id;

  if v_rid is null
     or not ((select public.es_superadmin())
             or coalesce((select public.rol_en(v_rid)), '') in ('dueno', 'cajero', 'cocina')) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  update public.pedidos
     set impreso_en = now()
   where id = p_id
     and restaurante_id = v_rid
     and impreso_en is null
     and estado_pago = 'aprobado'
     and estado in ('nuevo', 'en_preparacion', 'listo');

  get diagnostics v_filas = row_count;
  return v_filas = 1;
end;
$$;

create or replace function public.registrar_reimpresion(p_id bigint)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rid   uuid;
  v_total integer;
begin
  select p.restaurante_id into v_rid from public.pedidos p where p.id = p_id;

  if v_rid is null
     or not ((select public.es_superadmin())
             or coalesce((select public.rol_en(v_rid)), '') in ('dueno', 'cajero', 'cocina')) then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  update public.pedidos
     set reimpresiones = reimpresiones + 1,
         reimpreso_en  = now()
   where id = p_id
     and restaurante_id = v_rid
     and estado <> 'pendiente_pago'
  returning reimpresiones into v_total;

  return v_total;   -- null si el pedido no esta pagado
end;
$$;

revoke all on function public.reclamar_impresion(bigint) from public, anon;
revoke all on function public.registrar_reimpresion(bigint) from public, anon;
grant execute on function public.reclamar_impresion(bigint) to authenticated, service_role;
grant execute on function public.registrar_reimpresion(bigint) to authenticated, service_role;


-- =============================================================
-- 8) JORNADA, RESUMEN E HISTORIAL — ahora por restaurante
-- =============================================================
-- ANTES: eran SECURITY DEFINER, no comprobaban quien llamaba y leian
-- TODOS los pedidos (buscar_historial devolvia nombre, telefono y
-- direccion de los clientes a cualquier usuario con sesion). AHORA:
--   * corren como quien llama (RLS filtra a sus restaurantes);
--   * reciben un parametro opcional p_restaurante; si no llega, usan
--     el restaurante de la membresia del usuario (el panel actual no
--     manda nada y sigue funcionando igual).
-- La hora de corte se sigue leyendo de configuracion (como hoy) por una
-- funcion que verifica la membresia.
-- Se borran TODAS las firmas de estas funciones, no solo la conocida: una
-- firma vieja SECURITY DEFINER que sobreviviera seguiria leyendo los
-- pedidos de todos los restaurantes (en produccion hubo mas de una firma).
do $do$
declare r record;
begin
  for r in select p.oid::regprocedure::text as firma
           from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('limites_jornada', 'resumen_jornada', 'buscar_historial',
                               'jornadas_con_pedidos', 'buscar_mis_pedidos') loop
    execute format('drop function %s', r.firma);
  end loop;
end
$do$;

create or replace function public.config_jornada(p_restaurante uuid)
returns table (corte time, minutos_ocultar integer)
language sql
stable
security definer
set search_path = ''
as $$
  select c.hora_corte_jornada, c.minutos_ocultar_terminados
  from public.configuracion c
  where c.restaurante_id = p_restaurante
    and ((select public.es_miembro(p_restaurante)) or (select public.es_superadmin()));
$$;

revoke all on function public.config_jornada(uuid) from public, anon;
grant execute on function public.config_jornada(uuid) to authenticated, service_role;

create or replace function public.limites_jornada(fecha date default null, p_restaurante uuid default null)
returns table (
  jornada           date,
  inicio            timestamptz,
  fin               timestamptz,
  corte             time,
  minutos_ocultar   integer
)
language sql
stable
set search_path = ''
as $$
  with cfg as (
    select cj.corte as corte, cj.minutos_ocultar as mins
    from public.config_jornada(coalesce(p_restaurante, public.restaurante_actual())) cj
  ),
  elegida as (
    select coalesce(fecha, public.jornada_de(now(), cfg.corte)) as d,
           cfg.corte as corte,
           cfg.mins as mins
    from cfg
  )
  select
    e.d,
    ((e.d + e.corte) at time zone 'America/Bogota'),
    ((e.d + 1 + e.corte) at time zone 'America/Bogota'),
    e.corte,
    e.mins
  from elegida e;
$$;

create or replace function public.resumen_jornada(fecha date default null, p_restaurante uuid default null)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_rid uuid := coalesce(p_restaurante, public.restaurante_actual());
  lim   record;
  r     jsonb;
begin
  select * into lim from public.limites_jornada(fecha, v_rid);
  if not found then
    return null;     -- no es miembro de ese restaurante
  end if;

  with
  /* VENDIDOS: pago aprobado y no cancelado (definicion unica, ver
     resumen-jornada.sql). */
  vendidos as (
    select *
    from public.pedidos
    where restaurante_id = v_rid
      and creado_en >= lim.inicio
      and creado_en <  lim.fin
      and estado_pago = 'aprobado'
      and estado <> 'cancelado'
  ),
  cancelados as (
    select
      count(*) as n,
      coalesce(sum(total) filter (where estado_pago = 'aprobado'), 0) as dinero
    from public.pedidos
    where restaurante_id = v_rid
      and creado_en >= lim.inicio
      and creado_en <  lim.fin
      and estado = 'cancelado'
  ),
  totales as (
    select
      coalesce(sum(total), 0)           as ventas_total,
      coalesce(sum(subtotal), 0)        as ventas_productos,
      coalesce(sum(costo_domicilio), 0) as ventas_domicilios,
      count(*)                          as num_pedidos,
      coalesce(round(avg(total)), 0)    as ticket_promedio
    from vendidos
  ),
  productos as (
    select
      it->>'nombre' as nombre,
      sum((it->>'cantidad')::int) as unidades
    from vendidos, jsonb_array_elements(items) as it
    group by 1
    order by 2 desc
    limit 5
  ),
  por_hora as (
    select
      extract(hour from (creado_en at time zone 'America/Bogota'))::int as hora,
      count(*) as pedidos,
      sum(total) as ventas
    from vendidos
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'jornada',           lim.jornada,
    'inicio',            lim.inicio,
    'fin',               lim.fin,
    'ventas_total',      t.ventas_total,
    'ventas_productos',  t.ventas_productos,
    'ventas_domicilios', t.ventas_domicilios,
    'num_pedidos',       t.num_pedidos,
    'ticket_promedio',   t.ticket_promedio,
    'cancelados',        (select n from cancelados),
    'ventas_canceladas', (select dinero from cancelados),
    'top_productos',     coalesce((select jsonb_agg(jsonb_build_object('nombre', nombre, 'unidades', unidades)) from productos), '[]'::jsonb),
    'por_hora',          coalesce((select jsonb_agg(jsonb_build_object('hora', hora, 'pedidos', pedidos, 'ventas', ventas)) from por_hora), '[]'::jsonb)
  )
  into r
  from totales t;

  return r;
end;
$$;

-- OJO: en la version antigua el filtro "referencia" no funcionaba (el
-- parametro se llamaba igual que la columna y la columna ganaba, asi que
-- la condicion siempre era verdadera). Aqui los parametros se califican
-- con el nombre de la funcion y el filtro funciona.
create or replace function public.buscar_historial(
  fecha_desde date default null,
  fecha_hasta date default null,
  telefono    text default null,
  referencia  text default null,
  p_restaurante uuid default null
)
returns setof public.pedidos
language sql
stable
set search_path = ''
as $$
  with r as (
    select coalesce(p_restaurante, public.restaurante_actual()) as rid
  ),
  c as (
    select r.rid, cj.corte
    from r cross join lateral public.config_jornada(r.rid) cj
  )
  select p.*
  from public.pedidos p
  join c on c.rid = p.restaurante_id
  where p.estado <> 'pendiente_pago'
    and (buscar_historial.fecha_desde is null
         or public.jornada_de(p.creado_en, c.corte) >= buscar_historial.fecha_desde)
    and (buscar_historial.fecha_hasta is null
         or public.jornada_de(p.creado_en, c.corte) <= buscar_historial.fecha_hasta)
    and (buscar_historial.telefono is null or buscar_historial.telefono = ''
         or p.cliente_telefono like '%' || buscar_historial.telefono || '%')
    and (buscar_historial.referencia is null or buscar_historial.referencia = ''
         or p.referencia ilike '%' || buscar_historial.referencia || '%')
  order by p.creado_en desc
  limit 100;
$$;

create or replace function public.jornadas_con_pedidos(limite integer default 60, p_restaurante uuid default null)
returns table (jornada date, pedidos bigint, ventas bigint, cancelados bigint)
language sql
stable
set search_path = ''
as $$
  with r as (
    select coalesce(p_restaurante, public.restaurante_actual()) as rid
  ),
  c as (
    select r.rid, cj.corte
    from r cross join lateral public.config_jornada(r.rid) cj
  )
  select
    public.jornada_de(p.creado_en, c.corte) as jornada,
    count(*) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado') as pedidos,
    coalesce(sum(p.total) filter (where p.estado_pago = 'aprobado' and p.estado <> 'cancelado'), 0) as ventas,
    count(*) filter (where p.estado = 'cancelado') as cancelados
  from public.pedidos p
  join c on c.rid = p.restaurante_id
  where p.estado <> 'pendiente_pago'
  group by 1
  order by 1 desc
  limit jornadas_con_pedidos.limite;
$$;

do $do$
declare f text;
begin
  foreach f in array array[
    'public.limites_jornada(date,uuid)', 'public.resumen_jornada(date,uuid)',
    'public.buscar_historial(date,date,text,text,uuid)', 'public.jornadas_con_pedidos(integer,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$do$;

-- 8.1 Las dos puertas publicas (anon) que se conservan -------------------
-- seguimiento(ref): sin cambios. Busca por la referencia exacta
-- (imposible de adivinar), devuelve 1 fila y nunca telefono, correo ni
-- datos de pago. 'numero' sigue siendo el id (lo que muestra el panel hoy).
--
-- buscar_mis_pedidos(telefono, total): se ACOTA a un restaurante. Antes
-- buscaba el telefono en todos los pedidos; con varios restaurantes un
-- cliente podria ver los de otro. Mientras el sitio no mande el
-- restaurante, el valor por defecto es Taqueiros (transitorio).
--
-- LIMITE DE INTENTOS: el "segundo factor" (el total exacto) tiene pocas
-- centenas de valores posibles. Sin limite, quien conoce un celular prueba
-- totales hasta dar con la referencia, y seguimiento(ref) le entrega la
-- direccion. Ahora cada (restaurante, telefono) admite 10 consultas en 24 h
-- (el cliente real necesita una o dos); despues responde vacio, que el
-- sitio ya muestra como "No encontramos pedidos con esos datos".
create table if not exists public.intentos_buscar_pedido (
  id             bigint generated always as identity primary key,
  restaurante_id uuid not null references public.restaurantes(id) on delete cascade,
  telefono       text not null,
  momento        timestamptz not null default now()
);
create index if not exists intentos_buscar_pedido_idx
  on public.intentos_buscar_pedido (restaurante_id, telefono, momento);

create or replace function public.buscar_mis_pedidos(
  telefono      text,
  total_pagado  integer,
  p_restaurante uuid default null
)
returns table (
  numero      bigint,
  referencia  text,
  estado      text,
  tipo_pedido text,
  total       integer,
  creado_en   timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rid      uuid := coalesce(buscar_mis_pedidos.p_restaurante, public.restaurante_taqueiros_id());
  v_intentos integer;
begin
  if buscar_mis_pedidos.telefono is null or buscar_mis_pedidos.total_pagado is null
     or not exists (select 1 from public.restaurantes r where r.id = v_rid) then
    return;
  end if;

  delete from public.intentos_buscar_pedido i
   where i.restaurante_id = v_rid and i.telefono = buscar_mis_pedidos.telefono
     and i.momento < now() - interval '24 hours';
  insert into public.intentos_buscar_pedido (restaurante_id, telefono)
  values (v_rid, buscar_mis_pedidos.telefono);
  select count(*) into v_intentos from public.intentos_buscar_pedido i
   where i.restaurante_id = v_rid and i.telefono = buscar_mis_pedidos.telefono;
  if v_intentos > 10 then
    return;
  end if;

  return query
  select
    p.id,
    p.referencia,
    p.estado,
    p.tipo_pedido,
    p.total,
    p.creado_en
  from public.pedidos p
  where p.restaurante_id = v_rid
    and p.cliente_telefono = buscar_mis_pedidos.telefono
    and p.total = buscar_mis_pedidos.total_pagado
    and p.estado <> 'pendiente_pago'
    and p.creado_en > now() - interval '24 hours'
  order by p.creado_en desc
  limit 5;
end;
$$;

revoke all on function public.buscar_mis_pedidos(text, integer, uuid) from public;
grant execute on function public.buscar_mis_pedidos(text, integer, uuid) to anon, authenticated, service_role;

revoke all on function public.seguimiento(text) from public;
grant execute on function public.seguimiento(text) to anon, authenticated, service_role;

-- 8.2 Limpieza de huerfanos: solo el servidor (la intencion original;
-- en Supabase "revoke from public" no le quitaba el permiso a anon).
revoke all on function public.limpiar_pedidos_huerfanos(integer) from public, anon, authenticated;
grant execute on function public.limpiar_pedidos_huerfanos(integer) to service_role;

-- 8.3 Para las pruebas de aislamiento: borrar pedidos de prueba consume
-- numeros de la secuencia de ids, y el panel actual muestra el id. Esta
-- funcion (solo servidor) deja la secuencia en el ultimo id real.
create or replace function public.realinear_secuencia_pedidos()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max bigint;
begin
  select coalesce(max(id), 0) into v_max from public.pedidos;
  if v_max > 0 then
    perform setval(pg_get_serial_sequence('public.pedidos', 'id'), v_max, true);
  end if;
  return v_max;
end;
$$;

revoke all on function public.realinear_secuencia_pedidos() from public, anon, authenticated;
grant execute on function public.realinear_secuencia_pedidos() to service_role;


-- =============================================================
-- 9) SEGURIDAD (RLS)
-- =============================================================
alter table public.restaurantes          enable row level security;
alter table public.restaurante_secretos  enable row level security;
alter table public.miembros              enable row level security;
alter table public.superadmins           enable row level security;
alter table public.contadores_pedido     enable row level security;
alter table public.tarifas_domicilio     enable row level security;
alter table public.pedidos               enable row level security;
alter table public.categorias            enable row level security;
alter table public.productos             enable row level security;
alter table public.configuracion         enable row level security;
alter table public.salud_notificaciones  enable row level security;
alter table public.personal              enable row level security;
alter table public.intentos_buscar_pedido enable row level security;

-- 9.1 Fuera TODAS las politicas de estas tablas (las de es_personal(),
-- las de lectura publica del menu, cualquiera creada a mano en el
-- dashboard y las mr_ de una corrida anterior) y se recrean abajo.
do $do$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies
           where schemaname = 'public'
             and tablename in ('restaurantes','restaurante_secretos','miembros','superadmins','contadores_pedido',
                               'tarifas_domicilio','pedidos','categorias','productos','configuracion',
                               'salud_notificaciones','personal','intentos_buscar_pedido') loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$do$;

-- 9.2 Privilegios de tabla: anon no toca nada; los secretos y los
-- contadores tampoco son accesibles para authenticated.
revoke all on table
  public.restaurantes, public.restaurante_secretos, public.miembros, public.superadmins,
  public.contadores_pedido, public.tarifas_domicilio, public.pedidos, public.categorias,
  public.productos, public.configuracion, public.salud_notificaciones, public.personal,
  public.intentos_buscar_pedido
from anon;

revoke all on table public.restaurante_secretos, public.contadores_pedido, public.personal,
  public.intentos_buscar_pedido from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.superadmins from authenticated;
revoke truncate, references, trigger on table
  public.restaurantes, public.miembros, public.tarifas_domicilio, public.pedidos, public.categorias,
  public.productos, public.configuracion, public.salud_notificaciones
from authenticated;

-- 9.3 Politicas.  sa = superadmin.  Todas TO authenticated.
-- Para que Postgres cachee el resultado se usa (select funcion(...)).

-- restaurantes: cada miembro ve el suyo; el dueno edita nombre/config
-- (el trigger bloquea el resto); crear y borrar: solo superadmin.
create policy mr_restaurantes_select on public.restaurantes for select to authenticated
  using ((select public.es_superadmin()) or (select public.es_miembro(id)));
create policy mr_restaurantes_insert on public.restaurantes for insert to authenticated
  with check ((select public.es_superadmin()));
create policy mr_restaurantes_update on public.restaurantes for update to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(id)) = 'dueno')
  with check ((select public.es_superadmin()) or (select public.rol_en(id)) = 'dueno');
create policy mr_restaurantes_delete on public.restaurantes for delete to authenticated
  using ((select public.es_superadmin()));

-- miembros: cada uno ve SUS filas; escribir solo superadmin (las altas
-- las hace el servidor con la llave secreta).
create policy mr_miembros_select on public.miembros for select to authenticated
  using (user_id = (select auth.uid()) or (select public.es_superadmin()));
create policy mr_miembros_insert on public.miembros for insert to authenticated
  with check ((select public.es_superadmin()));
create policy mr_miembros_update on public.miembros for update to authenticated
  using ((select public.es_superadmin())) with check ((select public.es_superadmin()));
create policy mr_miembros_delete on public.miembros for delete to authenticated
  using ((select public.es_superadmin()));

-- superadmins: cada quien ve solo su propia fila (asi es_superadmin()
-- funciona sin SECURITY DEFINER). Nadie escribe desde el navegador.
create policy mr_superadmins_select on public.superadmins for select to authenticated
  using (user_id = (select auth.uid()));

-- restaurante_secretos y contadores_pedido: SIN politicas. Solo el
-- servidor (llave secreta) y los triggers.

-- pedidos
create policy mr_pedidos_select on public.pedidos for select to authenticated
  using ((select public.es_superadmin()) or (select public.es_miembro(restaurante_id)));
create policy mr_pedidos_insert on public.pedidos for insert to authenticated
  with check ((select public.es_superadmin())
              or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
create policy mr_pedidos_update on public.pedidos for update to authenticated
  using ((select public.es_superadmin())
         or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero', 'cocina'))
  with check (
    ((select public.es_superadmin())
     or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero', 'cocina'))
    and estado in ('nuevo', 'en_preparacion', 'listo', 'entregado', 'cancelado')
  );
-- Borrar: el historial se conserva. El dueno solo puede borrar lo que
-- NUNCA se cobro (pago no aprobado).
create policy mr_pedidos_delete on public.pedidos for delete to authenticated
  using ((select public.es_superadmin())
         or ((select public.rol_en(restaurante_id)) = 'dueno' and estado_pago <> 'aprobado'));

-- categorias y productos: leen dueno y cajero; escribe el dueno
create policy mr_categorias_select on public.categorias for select to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
create policy mr_categorias_insert on public.categorias for insert to authenticated
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_categorias_update on public.categorias for update to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_categorias_delete on public.categorias for delete to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');

create policy mr_productos_select on public.productos for select to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
create policy mr_productos_insert on public.productos for insert to authenticated
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_productos_update on public.productos for update to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_productos_delete on public.productos for delete to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');

-- configuracion: leen dueno y cajero; edita el dueno. La fila ya existe
-- (la crea el alta del restaurante), asi que insertar y borrar es solo
-- del superadmin.
create policy mr_configuracion_select on public.configuracion for select to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
create policy mr_configuracion_insert on public.configuracion for insert to authenticated
  with check ((select public.es_superadmin()));
create policy mr_configuracion_update on public.configuracion for update to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_configuracion_delete on public.configuracion for delete to authenticated
  using ((select public.es_superadmin()));

-- salud_notificaciones: la leen dueno y cajero; la escribe el servidor
create policy mr_salud_select on public.salud_notificaciones for select to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
create policy mr_salud_superadmin on public.salud_notificaciones for all to authenticated
  using ((select public.es_superadmin())) with check ((select public.es_superadmin()));

-- tarifas_domicilio: leen dueno y cajero; escribe el dueno
create policy mr_tarifas_select on public.tarifas_domicilio for select to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) in ('dueno', 'cajero'));
create policy mr_tarifas_insert on public.tarifas_domicilio for insert to authenticated
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_tarifas_update on public.tarifas_domicilio for update to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno')
  with check ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');
create policy mr_tarifas_delete on public.tarifas_domicilio for delete to authenticated
  using ((select public.es_superadmin()) or (select public.rol_en(restaurante_id)) = 'dueno');


-- =============================================================
-- 10) STORAGE — fotos de productos por carpeta {restaurante_id}/
-- =============================================================
-- Las fotos de Taqueiros que ya existen estan en la RAIZ del bucket
-- (p-xxxx.webp) y sus URLs estan guardadas en productos.imagen. Mover
-- archivos con SQL no es seguro (el archivo fisico no se mueve) y
-- romperia las URLs, asi que se DEJAN DONDE ESTAN. Regla transitoria:
-- la raiz solo la escribe el dueno de Taqueiros (para que el menu-admin
-- actual siga subiendo fotos). Lo nuevo de cualquier otro restaurante
-- tiene que ir en su carpeta. La lectura sigue publica (bucket publico).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 2097152,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set
  public             = true,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.puede_gestionar_fotos(p_ruta text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_ruta !~ '(^|/)\.\.(/|$)'
     and ( (select public.es_superadmin())
        or exists (
             select 1 from public.miembros m
             where m.user_id = (select auth.uid())
               and m.activo
               and m.rol = 'dueno'
               and ( m.restaurante_id::text = (storage.foldername(p_ruta))[1]
                  -- transitorio: la raiz del bucket es de Taqueiros
                  or ( coalesce(array_length(storage.foldername(p_ruta), 1), 0) = 0
                       and m.restaurante_id = public.restaurante_taqueiros_id() ) ) ) );
$$;

revoke all on function public.puede_gestionar_fotos(text) from public, anon;
grant execute on function public.puede_gestionar_fotos(text) to authenticated, service_role;

drop policy if exists "productos personal sube" on storage.objects;
drop policy if exists "productos personal ve" on storage.objects;
drop policy if exists "productos personal reemplaza" on storage.objects;
drop policy if exists "productos personal borra" on storage.objects;
drop policy if exists mr_productos_fotos_select on storage.objects;
drop policy if exists mr_productos_fotos_insert on storage.objects;
drop policy if exists mr_productos_fotos_update on storage.objects;
drop policy if exists mr_productos_fotos_delete on storage.objects;

create policy mr_productos_fotos_select on storage.objects for select to authenticated
  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));
create policy mr_productos_fotos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));
create policy mr_productos_fotos_update on storage.objects for update to authenticated
  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)))
  with check (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));
create policy mr_productos_fotos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'productos' and (select public.puede_gestionar_fotos(name)));


-- =============================================================
-- 11) REALTIME
-- =============================================================
-- Las tablas que el panel escucha siguen en la publicacion. Los
-- eventos de INSERT/UPDATE respetan RLS: cada sesion solo recibe filas
-- que su politica de SELECT le deja ver.
do $do$
declare t text;
begin
  foreach t in array array['pedidos','productos','configuracion','salud_notificaciones'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$do$;


-- =============================================================
-- 12) BARRIDO: ninguna funcion de public la ejecuta anon
-- =============================================================
-- En Supabase, "revoke ... from public" NO le quita el permiso a anon
-- (las funciones nuevas se le otorgan por defecto). Aqui se revoca a
-- todas, salvo las dos puertas publicas del sitio, identificadas por su
-- FIRMA exacta (por nombre, cualquier otra firma de seguimiento(...) o
-- buscar_mis_pedidos(...) que existiera quedaba abierta a anon).
-- Solo se pueden revocar las funciones propias; las de otro dueno las
-- detecta la comprobacion final.
do $do$
declare r record;
begin
  for r in select p.oid::regprocedure::text as firma
           from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.prokind in ('f', 'p')
             and p.oid not in ('public.seguimiento(text)'::regprocedure,
                               'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
             and pg_has_role(current_user, p.proowner, 'usage')
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke execute on function %s from public, anon', r.firma);
  end loop;
end
$do$;


-- =============================================================
-- 13) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
-- Si alguna FALLA, la transaccion completa se revierte y el error
-- lista cuales fallaron. Si todo esta OK, se confirma y se muestra
-- la tabla.
drop table if exists pg_temp._mr_verif;
create temp table _mr_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('tablas nuevas creadas (6)',
    (select count(*) = 6 from pg_tables where schemaname = 'public' and tablename in
      ('restaurantes','restaurante_secretos','miembros','superadmins','contadores_pedido','tarifas_domicilio')),
    null),

  ('RLS activo en TODAS las tablas de public',
    not exists (select 1 from pg_tables where schemaname = 'public' and not rowsecurity),
    (select string_agg(tablename, ', ') from pg_tables where schemaname = 'public' and not rowsecurity)),

  ('ninguna tabla de negocio desconocida sin restaurante_id',
    (select coalesce(string_agg(t.tablename, ', '), '') = '' from pg_tables t
     where t.schemaname = 'public'
       and t.tablename not in ('restaurantes', 'superadmins', 'personal')
       and not exists (select 1 from information_schema.columns c
                       where c.table_schema = 'public' and c.table_name = t.tablename and c.column_name = 'restaurante_id')
       and not exists (select 1 from pg_depend d
                       where d.objid = to_regclass(format('public.%I', t.tablename))::oid and d.deptype = 'e')),
    (select string_agg(t.tablename, ', ') from pg_tables t
     where t.schemaname = 'public'
       and t.tablename not in ('restaurantes', 'superadmins', 'personal')
       and not exists (select 1 from information_schema.columns c
                       where c.table_schema = 'public' and c.table_name = t.tablename and c.column_name = 'restaurante_id')
       and not exists (select 1 from pg_depend d
                       where d.objid = to_regclass(format('public.%I', t.tablename))::oid and d.deptype = 'e'))),

  ('restaurante_id es NOT NULL en todas las tablas que lo tienen',
    not exists (select 1 from information_schema.columns
                where table_schema = 'public' and column_name = 'restaurante_id' and is_nullable = 'YES'),
    null),

  ('ninguna fila con restaurante_id nulo',
    (select (select count(*) from public.pedidos where restaurante_id is null)
          + (select count(*) from public.categorias where restaurante_id is null)
          + (select count(*) from public.productos where restaurante_id is null)
          + (select count(*) from public.configuracion where restaurante_id is null)
          + (select count(*) from public.salud_notificaciones where restaurante_id is null) = 0),
    null),

  ('conteos de filas iguales a antes (pedidos, categorias, productos, configuracion, salud, personal)',
    (select count(*) = 6 and bool_and(a.filas = n.filas)
     from _mr_antes a
     join (select 'pedidos' as tabla, count(*)::bigint as filas from public.pedidos
           union all select 'categorias', count(*) from public.categorias
           union all select 'productos', count(*) from public.productos
           union all select 'configuracion', count(*) from public.configuracion
           union all select 'salud_notificaciones', count(*) from public.salud_notificaciones
           union all select 'personal', count(*) from public.personal) n using (tabla)),
    (select string_agg(a.tabla || ' antes=' || a.filas, ', ') from _mr_antes a)),

  ('las filas que ya existian quedaron en Taqueiros (solo la primera corrida)',
    case when exists (select 1 from _mr_flags where k like 'rid\_nuevo\_%')
      then (select (select count(*) from public.pedidos where restaurante_id <> public.restaurante_taqueiros_id())
                 + (select count(*) from public.categorias where restaurante_id <> public.restaurante_taqueiros_id())
                 + (select count(*) from public.productos where restaurante_id <> public.restaurante_taqueiros_id())
                 + (select count(*) from public.configuracion where restaurante_id <> public.restaurante_taqueiros_id())
                 + (select count(*) from public.salud_notificaciones where restaurante_id <> public.restaurante_taqueiros_id()) = 0)
      else true end,
    null),

  ('Taqueiros existe (slug taqueiros) y tiene config, secretos, contador y 5 tarifas',
    (select exists (select 1 from public.restaurantes where id = public.restaurante_taqueiros_id() and slug = 'taqueiros')
        and exists (select 1 from public.configuracion where restaurante_id = public.restaurante_taqueiros_id() and id = 1)
        and exists (select 1 from public.restaurante_secretos where restaurante_id = public.restaurante_taqueiros_id())
        and exists (select 1 from public.contadores_pedido where restaurante_id = public.restaurante_taqueiros_id())
        and (select count(*) from public.tarifas_domicilio where restaurante_id = public.restaurante_taqueiros_id()) >= 5),
    null),

  ('todo el personal paso a miembros como dueno de Taqueiros',
    (select count(*) = 0 from public.personal p
     where not exists (select 1 from public.miembros m
                       where m.user_id = p.id and m.restaurante_id = public.restaurante_taqueiros_id() and m.rol = 'dueno')),
    null),

  ('personal (tabla legada) sigue intacta',
    (select a.filas = (select count(*) from public.personal) from _mr_antes a where a.tabla = 'personal'),
    null),

  ('hora de corte de Taqueiros copiada correctamente',
    (select r.hora_corte_jornada = c.hora_corte_jornada
     from public.restaurantes r join public.configuracion c on c.restaurante_id = r.id and c.id = 1
     where r.id = public.restaurante_taqueiros_id()),
    null),

  ('pedidos: todos tienen numero y es unico por restaurante',
    not exists (select 1 from public.pedidos where numero is null)
      and not exists (select 1 from public.pedidos group by restaurante_id, numero having count(*) > 1),
    null),

  ('pedidos existentes conservan su numero (numero = id, solo la primera corrida)',
    case when exists (select 1 from _mr_flags where k = 'numero_nuevo')
      then not exists (select 1 from public.pedidos where numero <> id)
      else true end,
    null),

  ('contador de cada restaurante >= su mayor numero (el siguiente continua despues del ultimo)',
    not exists (select 1 from public.pedidos p
                left join public.contadores_pedido c on c.restaurante_id = p.restaurante_id
                group by p.restaurante_id, c.ultimo
                having c.ultimo is null or c.ultimo < max(p.numero)),
    (select 'Taqueiros: contador=' || c.ultimo || ', mayor numero=' || coalesce(max(p.numero), 0)
     from public.contadores_pedido c left join public.pedidos p on p.restaurante_id = c.restaurante_id
     where c.restaurante_id = public.restaurante_taqueiros_id() group by c.ultimo)),

  ('contador de Taqueiros >= mayor id de pedido (numero e id siguen sincronizados mientras el codigo muestre el id)',
    (select c.ultimo >= coalesce((select max(id) from public.pedidos where restaurante_id = public.restaurante_taqueiros_id()), 0)
     from public.contadores_pedido c where c.restaurante_id = public.restaurante_taqueiros_id()),
    null),

  ('pedidos.reembolsado_en existe',
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'pedidos' and column_name = 'reembolsado_en'),
    null),

  ('unicos por restaurante: PK de categorias y productos, nombre de categoria, FK compuesta',
    (select exists (select 1 from pg_constraint where conrelid = 'public.categorias'::regclass and contype = 'p'
                      and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id, id)')
        and exists (select 1 from pg_constraint where conrelid = 'public.productos'::regclass and contype = 'p'
                      and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id, id)')
        and exists (select 1 from pg_constraint where conrelid = 'public.productos'::regclass and contype = 'f'
                      and pg_get_constraintdef(oid) like 'FOREIGN KEY (restaurante_id, categoria)%')
        and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'categorias_restaurante_nombre_norm_uq')
        and not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'categorias_nombre_norm_uq')),
    null),

  ('configuracion y salud_notificaciones: una fila por restaurante (PK restaurante_id)',
    (select count(*) = 2 from pg_constraint
     where contype = 'p' and pg_get_constraintdef(oid) = 'PRIMARY KEY (restaurante_id)'
       and conrelid in ('public.configuracion'::regclass, 'public.salud_notificaciones'::regclass)),
    null),

  ('anon: sin privilegios sobre ninguna tabla de negocio',
    not exists (select 1 from pg_tables t
                where t.schemaname = 'public'
                  and has_table_privilege('anon', format('public.%I', t.tablename), 'select,insert,update,delete')),
    (select string_agg(t.tablename, ', ') from pg_tables t
     where t.schemaname = 'public' and has_table_privilege('anon', format('public.%I', t.tablename), 'select,insert,update,delete'))),

  ('ninguna politica de public alcanza a anon ni a PUBLIC',
    not exists (select 1 from pg_policies where schemaname = 'public' and roles && array['anon'::name, 'public'::name]),
    null),

  ('no queda ninguna politica antigua en las tablas de negocio (todas empiezan por mr_)',
    not exists (select 1 from pg_policies where schemaname = 'public' and policyname not like 'mr\_%'),
    (select string_agg(tablename || '.' || policyname, ', ') from pg_policies
     where schemaname = 'public' and policyname not like 'mr\_%')),

  ('restaurante_secretos, contadores_pedido y superadmins: sin acceso de escritura/lectura para clientes',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename in ('restaurante_secretos', 'contadores_pedido'))
      and not has_table_privilege('authenticated', 'public.restaurante_secretos', 'select')
      and not has_table_privilege('authenticated', 'public.contadores_pedido', 'select')
      and not has_table_privilege('authenticated', 'public.superadmins', 'insert,update,delete'),
    null),

  ('anon solo puede ejecutar seguimiento y buscar_mis_pedidos',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
                  and p.oid not in ('public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
                  and has_function_privilege('anon', p.oid, 'execute')),
    (select string_agg(p.proname, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
       and p.oid not in ('public.seguimiento(text)'::regprocedure,
                         'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('anon', p.oid, 'execute'))),

  ('funciones auxiliares: existen, STABLE, sin SECURITY DEFINER, authenticated si y anon no',
    (select count(*) = 3 and bool_and(p.provolatile = 's' and not p.prosecdef
              and has_function_privilege('authenticated', p.oid, 'execute')
              and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('es_superadmin', 'es_miembro', 'rol_en')),
    null),

  ('reclamar_impresion y registrar_reimpresion: sin SECURITY DEFINER, anon no, authenticated si',
    (select count(*) = 2 and bool_and(not p.prosecdef
              and not has_function_privilege('anon', p.oid, 'execute')
              and has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname in ('reclamar_impresion', 'registrar_reimpresion')),
    null),

  ('triggers de proteccion activos (pago, restaurante inmutable, rol cocina, validaciones, numero)',
    (select count(*) = 10 from pg_trigger
     where not tgisinternal and tgenabled <> 'D' and tgname in (
       'pedidos_proteger_pago', 'pedidos_restaurante_inmutable', 'categorias_restaurante_inmutable',
       'productos_restaurante_inmutable', 'configuracion_restaurante_inmutable', 'pedidos_limitar_rol',
       'productos_validar', 'categorias_validar', 'pedidos_asignar_numero', 'restaurantes_proteger')),
    null),

  ('Storage: bucket productos publico, 2 MB, webp/jpeg/png',
    exists (select 1 from storage.buckets
            where id = 'productos' and public = true and file_size_limit = 2097152
              and allowed_mime_types @> array['image/webp', 'image/jpeg', 'image/png']
              and cardinality(allowed_mime_types) = 3),
    null),

  ('Storage: 4 politicas mr_ del bucket y ninguna otra que lo abra',
    (select count(*) = 4 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'mr\_productos\_fotos\_%')
      and not exists (select 1 from pg_policies
                      where schemaname = 'storage' and tablename = 'objects'
                        and policyname not like 'mr\_%'
                        and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
                        and (coalesce(qual, '') || coalesce(with_check, '') not like '%bucket_id%'
                             or coalesce(qual, '') || coalesce(with_check, '') like '%productos%')),
    (select string_agg(policyname, ', ') from pg_policies
     where schemaname = 'storage' and tablename = 'objects' and policyname not like 'mr\_%'
       and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
       and (coalesce(qual, '') || coalesce(with_check, '') not like '%bucket_id%'
            or coalesce(qual, '') || coalesce(with_check, '') like '%productos%'))),

  ('Realtime: pedidos, productos, configuracion y salud_notificaciones siguen publicadas',
    (select count(*) = 4 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename in ('pedidos', 'productos', 'configuracion', 'salud_notificaciones')),
    null),

  -- Una funcion SECURITY DEFINER ignora RLS: si no es una de las que este
  -- archivo revisa, se detiene todo hasta que alguien la mire.
  ('ninguna funcion SECURITY DEFINER desconocida la pueden llamar anon o authenticated',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
                  and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
                  and p.oid not in ('public.config_jornada(uuid)'::regprocedure,
                                    'public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))),
    (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
       and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
       and p.oid not in ('public.config_jornada(uuid)'::regprocedure,
                         'public.seguimiento(text)'::regprocedure,
                         'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')))),

  -- Una vista corre con los permisos de su dueno y salta RLS, salvo que
  -- tenga security_invoker. Una vista materializada nunca aplica RLS.
  ('ninguna vista de public que lean anon o authenticated salta RLS',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
                  and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
                  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
                  and not (c.relkind = 'v' and exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                                                      where lower(o) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1')))),
    (select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm')
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
       and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))
       and not (c.relkind = 'v' and exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                                           where lower(o) in ('security_invoker=true', 'security_invoker=on', 'security_invoker=1'))))),

  -- personal -> miembros convierte en DUENO de Taqueiros a quien entre en
  -- personal. Un trigger de auth.users que escriba ahi (la plantilla
  -- "handle_new_user") haria dueno a cada cuenta nueva.
  ('ningun trigger de auth.users da membresia automatica (personal, miembros, superadmins)',
    not exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
                where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
                  and f.prosrc ~* '(personal|miembros|superadmins)'),
    (select string_agg(t.tgname || ' -> ' || f.proname, ', ') from pg_trigger t join pg_proc f on f.oid = t.tgfoid
     where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
       and f.prosrc ~* '(personal|miembros|superadmins)')),

  ('intentos_buscar_pedido: sin acceso para clientes',
    not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'intentos_buscar_pedido')
      and not has_table_privilege('anon', 'public.intentos_buscar_pedido', 'select,insert,update,delete')
      and not has_table_privilege('authenticated', 'public.intentos_buscar_pedido', 'select,insert,update,delete'),
    null),

  ('ningun superadmin agregado por este script',
    true,
    (select count(*) || ' superadmin(s) en la tabla' from public.superadmins))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- Se borraron y recrearon funciones con otra firma: PostgREST tiene que
-- recargar su cache o el panel llamaria a la firma vieja (404). El aviso
-- solo sale si la transaccion se confirma.
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr_verif
order by orden;
