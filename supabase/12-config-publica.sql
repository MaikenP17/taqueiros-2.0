-- =============================================================
-- TAQUEIROS 2.0 — CONFIGURACION PUBLICA POR RESTAURANTE Y SEGUIMIENTO SEGURO  (SQL 12)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo activa RLS por su cuenta)
--
-- ANTES DE CORRERLO
--   * El SQL 10 y el SQL 11 ya deben estar aplicados.
--   * Orden recomendado: 1) desplegar el codigo (git push), 2) correr ESTE archivo.
--     El codigo nuevo funciona antes del SQL 12 (Taqueiros se ve igual: el servidor trae
--     sus valores de respaldo) y despues del SQL 12 usa lo que queda en la base.
--
-- QUE HACE
--   1. Mezcla en restaurantes.config de Taqueiros los valores que hasta hoy estaban escritos a
--      mano en las paginas (nombre visible, colores, logo, textos, WhatsApp, coordenadas, domicilio,
--      llaves PUBLICAS de Wompi). MEZCLA, no sobrescribe: si ya hay un valor, se queda el que hay.
--      La forma del JSON esta en docs/multirestaurante.md, seccion 14. NO guarda ningun secreto.
--   2. Enlace de seguimiento no adivinable: pedidos.token_seguimiento (aleatorio, 122 bits) y
--      pedidos.enlace_por_referencia. Los pedidos que YA existen conservan su enlace actual
--      (el de la referencia TAQ-...) y ademas reciben su token; los pedidos nuevos solo se abren
--      con el token. Se agregan sin ningun UPDATE (ni triggers, ni Realtime).
--   3. seguimiento(ref) y buscar_mis_pedidos(...) devuelven el numero de pedido DEL RESTAURANTE
--      (pedidos.numero) y no el id global; buscar_mis_pedidos devuelve ademas el token para
--      armar el enlace. Las firmas no cambian (el SQL 10 las conoce por esa firma).
--   4. Un trigger impide que un usuario cambie el token de un pedido desde el navegador.
--
-- QUE NO HACE
--   * No borra ni cambia pedidos, tablas, columnas ni datos (solo agrega dos columnas y mezcla config).
--   * No toca restaurante_secretos, politicas RLS ni el valor por defecto transitorio de restaurante_id.
--   * No modifica la config de ningun restaurante que no sea Taqueiros.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una transaccion. Si cualquier paso o
-- comprobacion falla, TODO se revierte.
--
-- NO vuelvas a correr el SQL 10 despues de este: recrearia buscar_mis_pedidos con su version
-- anterior (este archivo la repone al correrlo de nuevo).
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Para SQL plano, el editor muestra el numero de linea: en VS Code usa Ctrl+G y busca hacia
--     arriba el marcador "-- >>> PASO ..." mas cercano. Lista de marcadores: buscar ">>> PASO".
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 12 SE REVIRTIO" y las lista.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := '';
begin
  v_item := 'public.restaurantes';
  if to_regclass('public.restaurantes') is null then
    raise exception 'Falta public.restaurantes: corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'public.restaurante_dominios';
  if to_regclass('public.restaurante_dominios') is null then
    raise exception 'Falta public.restaurante_dominios: corre primero supabase/11-dominios.sql';
  end if;

  v_item := 'public.pedidos.numero';
  if not exists (select 1 from pg_attribute a
                 where a.attrelid = to_regclass('public.pedidos') and a.attname = 'numero'
                   and a.attnum > 0 and not a.attisdropped) then
    raise exception 'Falta pedidos.numero: corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'public.es_servidor()';
  if to_regprocedure('public.es_servidor()') is null then
    raise exception 'Falta public.es_servidor(): corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'seguimiento(text) y buscar_mis_pedidos(text,integer,uuid)';
  if to_regprocedure('public.seguimiento(text)') is null
     or to_regprocedure('public.buscar_mis_pedidos(text,integer,uuid)') is null then
    raise exception 'Faltan seguimiento(text) o buscar_mis_pedidos(text,integer,uuid): corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'restaurante Taqueiros';
  if not exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) then
    raise exception 'No existe el restaurante Taqueiros (id fijo del SQL 10)';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr12_flags;
create temp table _mr12_flags (k text primary key, v boolean not null);

-- Foto de lo que NO debe cambiar, para comprobarlo al final.
drop table if exists pg_temp._mr12_antes;
create temp table _mr12_antes as
select
  (select count(*) from public.pedidos)                                   as pedidos_n,
  (select coalesce(sum(p.numero), 0) from public.pedidos p)               as pedidos_suma_numero,
  (select coalesce(sum(p.id), 0) from public.pedidos p)                   as pedidos_suma_id,
  (select r.config from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) as config_taqueiros,
  (select coalesce(md5(string_agg(r.id::text || r.config::text, '|' order by r.id)), '')
     from public.restaurantes r where r.id <> public.restaurante_taqueiros_id()) as huella_otros;


-- =============================================================
-- >>> PASO 1) pedidos.token_seguimiento y pedidos.enlace_por_referencia
-- =============================================================
-- token_seguimiento: 32 caracteres hexadecimales al azar (un UUID v4 sin guiones: 122 bits). Con un
--   valor por defecto VOLATIL, Postgres calcula uno distinto por fila al agregar la columna y reescribe
--   la tabla sin ejecutar UPDATE: no se disparan triggers, no cambia 'actualizado_en' y Realtime no
--   emite eventos. Los pedidos nuevos lo reciben al insertarse (el servidor lo devuelve al cliente).
-- enlace_por_referencia: ¿el enlace viejo (la referencia TAQ-...) todavia abre el seguimiento de este
--   pedido? Los pedidos existentes SI (para que ningun enlace ya entregado se rompa); los nuevos NO.
--   Se agrega con valor true (Postgres lo guarda una sola vez para todas las filas existentes, sin
--   UPDATE) y despues el valor por defecto pasa a false para los pedidos que se inserten de ahora en
--   adelante.
do $do$
declare
  v_paso constant text := '1 columnas de seguimiento en pedidos';
  v_item text := '';
begin
  v_item := 'token_seguimiento';
  if not exists (select 1 from pg_attribute a
                 where a.attrelid = to_regclass('public.pedidos') and a.attname = 'token_seguimiento'
                   and a.attnum > 0 and not a.attisdropped) then
    alter table public.pedidos
      add column token_seguimiento text not null default replace(gen_random_uuid()::text, '-', '');
    insert into _mr12_flags (k, v) values ('token_nuevo', true) on conflict (k) do nothing;
  end if;

  v_item := 'enlace_por_referencia';
  if not exists (select 1 from pg_attribute a
                 where a.attrelid = to_regclass('public.pedidos') and a.attname = 'enlace_por_referencia'
                   and a.attnum > 0 and not a.attisdropped) then
    alter table public.pedidos add column enlace_por_referencia boolean not null default true;
    alter table public.pedidos alter column enlace_por_referencia set default false;
    insert into _mr12_flags (k, v) values ('enlace_nuevo', true) on conflict (k) do nothing;
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

create unique index if not exists pedidos_token_seguimiento_uq on public.pedidos (token_seguimiento);


-- =============================================================
-- >>> PASO 2) El token no se cambia desde el navegador
-- =============================================================
-- Igual que bloquear_cambio_restaurante(): sin SECURITY DEFINER (dentro de una funcion definer
-- current_user seria el dueno y es_servidor() siempre daria true). Solo el servidor (llave secreta),
-- el editor SQL o un superadmin pueden cambiar el enlace de un pedido.
create or replace function public.proteger_token_seguimiento()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.token_seguimiento is distinct from old.token_seguimiento
      or new.enlace_por_referencia is distinct from old.enlace_por_referencia)
     and not public.es_servidor()
     and not (select public.es_superadmin()) then
    raise exception 'No se puede cambiar el enlace de seguimiento de un pedido' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.proteger_token_seguimiento() from public, anon, authenticated;

drop trigger if exists pedidos_proteger_token on public.pedidos;
create trigger pedidos_proteger_token
  before update on public.pedidos
  for each row execute function public.proteger_token_seguimiento();


-- =============================================================
-- >>> PASO 3) seguimiento(ref) y buscar_mis_pedidos(...): numero del restaurante y token
-- =============================================================
-- seguimiento(ref): misma firma (text) y mismas columnas. Cambios:
--   * 'numero' sale de pedidos.numero (el contador del restaurante), ya no del id global;
--   * abre el pedido por su token, o por su referencia SOLO si el pedido es anterior a este SQL
--     (enlace_por_referencia). Una referencia de un pedido nuevo ya no sirve para ver nada;
--   * search_path vacio y nombres calificados.
-- Sigue devolviendo una sola fila y nunca telefono, correo ni datos de pago.
create or replace function public.seguimiento(ref text)
returns table (
  numero             bigint,
  referencia         text,
  estado             text,
  tipo_pedido        text,
  direccion          text,
  barrio             text,
  indicaciones       text,
  items              jsonb,
  subtotal           integer,
  costo_domicilio    integer,
  distancia_km       numeric,
  fuera_de_cobertura boolean,
  total              integer,
  creado_en          timestamptz,
  pagado_en          timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    p.numero,
    p.referencia,
    p.estado,
    p.tipo_pedido,
    p.direccion,
    p.barrio,
    p.indicaciones,
    p.items,
    p.subtotal,
    p.costo_domicilio,
    p.distancia_km,
    p.fuera_de_cobertura,
    p.total,
    p.creado_en,
    p.pagado_en
  from public.pedidos p
  where (p.token_seguimiento = seguimiento.ref
         or (p.enlace_por_referencia and p.referencia = seguimiento.ref))
    and p.estado <> 'pendiente_pago'
  limit 1;
$$;

revoke all on function public.seguimiento(text) from public;
grant execute on function public.seguimiento(text) to anon, authenticated, service_role;

-- buscar_mis_pedidos: el tipo de lo que devuelve cambia (numero del restaurante + token), asi que se
-- borran TODAS sus firmas (por catalogo, no solo la conocida) y se recrea la de siempre. La logica
-- (acotada a un restaurante, limite de 10 intentos por celular en 24 h) es la del SQL 10.
do $do$
declare
  v_paso constant text := '3 borrar firmas de buscar_mis_pedidos';
  v_item text := '';
  r record;
begin
  for r in select p.oid::regprocedure::text as firma
           from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname = 'buscar_mis_pedidos' loop
    v_item := r.firma;
    execute format('drop function %s', r.firma);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

create function public.buscar_mis_pedidos(
  telefono      text,
  total_pagado  integer,
  p_restaurante uuid default null
)
returns table (
  numero            bigint,
  referencia        text,
  estado            text,
  tipo_pedido       text,
  total             integer,
  creado_en         timestamptz,
  token_seguimiento text
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
    p.numero,
    p.referencia,
    p.estado,
    p.tipo_pedido,
    p.total,
    p.creado_en,
    p.token_seguimiento
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


-- =============================================================
-- >>> PASO 4) CONFIGURACION PUBLICA DE TAQUEIROS (mezclada, no sobrescrita)
-- =============================================================
-- Estos son los valores que estaban escritos en index.html, pedido.html, manifest.json, marca.js y
-- api/_domicilio.js / api/_ubicacion.js. Deben ser IDENTICOS a api/_respaldo-taqueiros.js (una prueba
-- lo comprueba). Todo es publico por diseno: la llave pub_... de Wompi es la llave PUBLICA del comercio.
-- Reglas de la mezcla: lo que ya esta en la base manda; solo se agrega lo que falta.
create or replace function pg_temp.mr12_mezclar(base jsonb, nuevo jsonb)
returns jsonb
language plpgsql
immutable
as $f$
declare
  k text;
  resultado jsonb;
begin
  if jsonb_typeof(base) = 'object' and jsonb_typeof(nuevo) = 'object' then
    resultado := base;
    for k in select jsonb_object_keys(nuevo) loop
      if resultado ? k and jsonb_typeof(resultado -> k) <> 'null' then
        resultado := jsonb_set(resultado, array[k], pg_temp.mr12_mezclar(resultado -> k, nuevo -> k));
      else
        resultado := jsonb_set(resultado, array[k], nuevo -> k);
      end if;
    end loop;
    return resultado;
  end if;
  if base is null or jsonb_typeof(base) = 'null' then
    return nuevo;
  end if;
  return base;
end
$f$;

do $do$
declare
  v_paso constant text := '4 mezclar la config publica de Taqueiros';
  v_item text := 'restaurantes.config';
  v_nuevo constant jsonb := $cfg${
  "publico": {
    "marca": {
      "logo": "Recursos/logo/logo.png",
      "icono_192": "Recursos/logo/icono-192.png",
      "icono_512": "Recursos/logo/icono-512.png",
      "emoji": "🌮",
      "colores": {
        "primario": "#C1272D",
        "primario_oscuro": "#8A1B1F",
        "primario_brillo": "#E14A42",
        "claro": "#F7ECD6",
        "claro_suave": "#FFF8EA",
        "oscuro": "#1C1210",
        "oscuro_2": "#241714",
        "acento": "#E3A008",
        "positivo": "#5C7A3B",
        "texto_secundario": "#D9C9A8",
        "texto_tenue": "#B9A88C",
        "positivo_brillo": "#7FA855"
      },
      "colores_zonas": [
        "#5C7A3B",
        "#8FA83F",
        "#E3A008",
        "#E07B39"
      ]
    },
    "textos": {
      "titulo_pagina": "Los Taqueiros | Tacos, Birria y Antojitos en Cúcuta",
      "descripcion_pagina": "Los Taqueiros — tacos, birria, dorilocos y antojitos mexicanos en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp.",
      "eslogan": "Tacos · Birria · Antojitos",
      "tagline": "Del comal directo a tu mesa: tacos jugosos, birria con consomé y dorilocos bien cargados. Pide en dos clics y recíbelo por WhatsApp.",
      "descripcion_pie": "Tacos, birria y antojitos mexicanos hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta.",
      "servicios_linea": "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local",
      "pie_final": "Cúcuta, Colombia. Hecho con antojo 🌶️",
      "ejemplo_nota": "Ej: sin cebolla, extra picante, tocarle el timbre...",
      "banner_abierto_icono": "🔥",
      "banner_abierto_titulo": "¡Estamos que ardemos!",
      "banner_abierto_texto": "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🌮",
      "banner_cerrado_icono": "🌮",
      "banner_cerrado_mensaje": "Por hoy ya cerramos la cocina.",
      "seguimiento": {
        "tiempo_nuevo": "Suele estar listo en 25 – 40 minutos",
        "tiempo_preparacion": "Ya está en el comal, unos 15 – 25 minutos más",
        "tiempo_camino": "El domiciliario va en camino, 10 – 20 minutos",
        "tiempo_recoger": "¡Ya puedes pasar por él!",
        "tiempo_entregado": "¡Buen provecho! 🌮",
        "frase_nuevo": "¡Recibimos tu pedido! 🌮",
        "frase_preparacion": "Lo estamos preparando 🔥",
        "frase_camino": "¡Va en camino! 🛵",
        "frase_recoger": "¡Tu pedido está listo! 🥡",
        "frase_entregado": "¡Entregado! 🎉"
      }
    },
    "contacto": {
      "whatsapp": "573125249438",
      "telefono": "+57 312 524 9438",
      "direccion": "Cl 1AN #3E-7, Barrio La Ceiba, Cúcuta, Norte de Santander",
      "direccion_corta": "Cl 1AN #3E-7, Barrio La Ceiba, Cúcuta",
      "ciudad": "Cúcuta",
      "region": "Norte de Santander",
      "instagram": "lostaqueiros.co",
      "tiktok": "lostaqueiros_cuc"
    },
    "wompi": {
      "llave_publica_test": "pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz",
      "llave_publica_prod": "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"
    },
    "pwa": {
      "nombre": "Panel Taqueiros",
      "nombre_corto": "Comandas"
    }
  },
  "ubicacion": {
    "lat": 7.8997382,
    "lng": -72.4968525
  },
  "domicilio": {
    "factor_recorrido": 1.3,
    "pin_minimo_metros": 100,
    "area": {
      "latMin": 7.75,
      "latMax": 8.1,
      "lngMin": -72.68,
      "lngMax": -72.35
    }
  }
}$cfg$::jsonb;
  v_antes jsonb;
  v_despues jsonb;
begin
  select r.config into v_antes from public.restaurantes r where r.id = public.restaurante_taqueiros_id();
  v_despues := pg_temp.mr12_mezclar(coalesce(v_antes, '{}'::jsonb), v_nuevo);

  if v_despues is distinct from v_antes then
    update public.restaurantes r set config = v_despues where r.id = public.restaurante_taqueiros_id();
  end if;
  insert into _mr12_flags (k, v) values ('config_estaba_vacia', coalesce(v_antes = '{}'::jsonb, true))
    on conflict (k) do nothing;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 5) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr12_verif;
create temp table _mr12_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr12_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('pedidos.token_seguimiento: existe, NOT NULL, con valor por defecto aleatorio',
    exists (select 1 from pg_attribute a
            join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = to_regclass('public.pedidos') and a.attname = 'token_seguimiento'
              and a.attnum > 0 and not a.attisdropped and a.attnotnull
              and pg_get_expr(d.adbin, d.adrelid) like '%gen_random_uuid%'),
    null),

  ('todos los pedidos tienen token y ninguno se repite',
    (select count(*) = count(distinct p.token_seguimiento) and count(*) = count(p.token_seguimiento)
            and coalesce(min(char_length(p.token_seguimiento)), 32) >= 32 from public.pedidos p),
    null),

  ('indice unico sobre token_seguimiento',
    exists (select 1 from pg_index i
            where i.indrelid = to_regclass('public.pedidos') and i.indisunique
              and i.indexrelid = to_regclass('public.pedidos_token_seguimiento_uq')),
    null),

  ('pedidos.enlace_por_referencia: NOT NULL y los pedidos NUEVOS nacen en false',
    exists (select 1 from pg_attribute a
            join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
            where a.attrelid = to_regclass('public.pedidos') and a.attname = 'enlace_por_referencia'
              and a.attnum > 0 and not a.attisdropped and a.attnotnull
              and pg_get_expr(d.adbin, d.adrelid) = 'false'),
    null),

  ('los pedidos que ya existian conservan su enlace por referencia (ninguno quedo en false)',
    case when exists (select 1 from _mr12_flags where k = 'enlace_nuevo')
      then not exists (select 1 from public.pedidos p where not p.enlace_por_referencia)
      else true end,
    (select count(*)::text || ' pedidos con enlace_por_referencia = false'
     from public.pedidos p where not p.enlace_por_referencia)),

  ('ningun pedido se creo, borro ni cambio de numero (cantidad y sumas de id y numero iguales)',
    (select a.pedidos_n = (select count(*) from public.pedidos)
        and a.pedidos_suma_numero = (select coalesce(sum(p.numero), 0) from public.pedidos p)
        and a.pedidos_suma_id = (select coalesce(sum(p.id), 0) from public.pedidos p)
       from _mr12_antes a),
    null),

  ('anon sin ningun privilegio sobre las columnas de pedidos (token incluido)',
    not exists (select 1 from pg_attribute a
                where a.attrelid = to_regclass('public.pedidos') and a.attnum > 0 and not a.attisdropped
                  and has_column_privilege('anon', a.attrelid, a.attnum, 'select,insert,update')),
    null),

  ('trigger pedidos_proteger_token activo (BEFORE UPDATE)',
    exists (select 1 from pg_trigger t
            where t.tgrelid = to_regclass('public.pedidos') and t.tgname = 'pedidos_proteger_token'
              and not t.tgisinternal and t.tgenabled <> 'D'),
    null),

  ('proteger_token_seguimiento: sin SECURITY DEFINER y nadie la ejecuta salvo el sistema',
    exists (select 1 from pg_proc p
            where p.oid = to_regprocedure('public.proteger_token_seguimiento()') and not p.prosecdef)
      and not has_function_privilege('anon', to_regprocedure('public.proteger_token_seguimiento()'), 'execute')
      and not has_function_privilege('authenticated', to_regprocedure('public.proteger_token_seguimiento()'), 'execute'),
    null),

  ('seguimiento: una sola firma (text), SECURITY DEFINER, anon la ejecuta, search_path vacio, usa token y numero',
    (select count(*) = 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'seguimiento')
      and exists (select 1 from pg_proc p
                  where p.oid = to_regprocedure('public.seguimiento(text)') and p.prosecdef
                    and p.proconfig @> array['search_path=""']
                    and p.prosrc like '%token_seguimiento%' and p.prosrc like '%p.numero%' and p.prosrc not like '%p.id,%')
      and has_function_privilege('anon', to_regprocedure('public.seguimiento(text)'), 'execute'),
    null),

  ('seguimiento: solo un pedido nuevo con su token (la referencia sola ya no basta); los viejos siguen abriendose por referencia',
    pg_get_functiondef(to_regprocedure('public.seguimiento(text)')) like '%enlace_por_referencia and p.referencia%',
    null),

  ('buscar_mis_pedidos: una sola firma (text, integer, uuid) y devuelve numero y token_seguimiento',
    (select count(*) = 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'buscar_mis_pedidos')
      and pg_get_function_result(to_regprocedure('public.buscar_mis_pedidos(text,integer,uuid)'))
          = 'TABLE(numero bigint, referencia text, estado text, tipo_pedido text, total integer, creado_en timestamp with time zone, token_seguimiento text)'
      and has_function_privilege('anon', to_regprocedure('public.buscar_mis_pedidos(text,integer,uuid)'), 'execute'),
    null),

  ('buscar_mis_pedidos conserva el limite de intentos y el acotado por restaurante',
    (select p.prosrc like '%v_intentos > 10%' and p.prosrc like '%p.restaurante_id = v_rid%' and p.prosrc like '%p.numero%'
       from pg_proc p where p.oid = to_regprocedure('public.buscar_mis_pedidos(text,integer,uuid)')),
    null),

  ('Taqueiros: la config publica trae marca, textos, contacto, llaves publicas de Wompi y panel instalable',
    (select r.config #> '{publico,marca,colores,primario}' is not null
        and r.config #> '{publico,marca,logo}' is not null
        and r.config #> '{publico,textos,tagline}' is not null
        and r.config #> '{publico,textos,seguimiento,frase_nuevo}' is not null
        and r.config #> '{publico,contacto,whatsapp}' is not null
        and r.config #> '{publico,wompi,llave_publica_test}' is not null
        and r.config #> '{publico,wompi,llave_publica_prod}' is not null
        and r.config #> '{publico,pwa,nombre}' is not null
       from public.restaurantes r where r.id = public.restaurante_taqueiros_id()),
    null),

  ('Taqueiros: ubicacion del local y datos de domicilio en la config',
    (select jsonb_typeof(r.config #> '{ubicacion,lat}') = 'number' and jsonb_typeof(r.config #> '{ubicacion,lng}') = 'number'
        and r.config #> '{domicilio,area,latMin}' is not null
       from public.restaurantes r where r.id = public.restaurante_taqueiros_id()),
    null),

  ('la mezcla no pisa nada: todo lo que Taqueiros ya tenia en su config sigue igual',
    (select jsonb_strip_nulls(a.config_taqueiros) <@ r.config
       from _mr12_antes a, public.restaurantes r where r.id = public.restaurante_taqueiros_id()),
    null),

  ('si la config estaba vacia, ahora tiene exactamente los valores de siempre',
    case when exists (select 1 from _mr12_flags where k = 'config_estaba_vacia' and v)
      then (select r.config = $cfg${
  "publico": {
    "marca": {
      "logo": "Recursos/logo/logo.png",
      "icono_192": "Recursos/logo/icono-192.png",
      "icono_512": "Recursos/logo/icono-512.png",
      "emoji": "🌮",
      "colores": {
        "primario": "#C1272D",
        "primario_oscuro": "#8A1B1F",
        "primario_brillo": "#E14A42",
        "claro": "#F7ECD6",
        "claro_suave": "#FFF8EA",
        "oscuro": "#1C1210",
        "oscuro_2": "#241714",
        "acento": "#E3A008",
        "positivo": "#5C7A3B",
        "texto_secundario": "#D9C9A8",
        "texto_tenue": "#B9A88C",
        "positivo_brillo": "#7FA855"
      },
      "colores_zonas": [
        "#5C7A3B",
        "#8FA83F",
        "#E3A008",
        "#E07B39"
      ]
    },
    "textos": {
      "titulo_pagina": "Los Taqueiros | Tacos, Birria y Antojitos en Cúcuta",
      "descripcion_pagina": "Los Taqueiros — tacos, birria, dorilocos y antojitos mexicanos en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp.",
      "eslogan": "Tacos · Birria · Antojitos",
      "tagline": "Del comal directo a tu mesa: tacos jugosos, birria con consomé y dorilocos bien cargados. Pide en dos clics y recíbelo por WhatsApp.",
      "descripcion_pie": "Tacos, birria y antojitos mexicanos hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta.",
      "servicios_linea": "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local",
      "pie_final": "Cúcuta, Colombia. Hecho con antojo 🌶️",
      "ejemplo_nota": "Ej: sin cebolla, extra picante, tocarle el timbre...",
      "banner_abierto_icono": "🔥",
      "banner_abierto_titulo": "¡Estamos que ardemos!",
      "banner_abierto_texto": "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🌮",
      "banner_cerrado_icono": "🌮",
      "banner_cerrado_mensaje": "Por hoy ya cerramos la cocina.",
      "seguimiento": {
        "tiempo_nuevo": "Suele estar listo en 25 – 40 minutos",
        "tiempo_preparacion": "Ya está en el comal, unos 15 – 25 minutos más",
        "tiempo_camino": "El domiciliario va en camino, 10 – 20 minutos",
        "tiempo_recoger": "¡Ya puedes pasar por él!",
        "tiempo_entregado": "¡Buen provecho! 🌮",
        "frase_nuevo": "¡Recibimos tu pedido! 🌮",
        "frase_preparacion": "Lo estamos preparando 🔥",
        "frase_camino": "¡Va en camino! 🛵",
        "frase_recoger": "¡Tu pedido está listo! 🥡",
        "frase_entregado": "¡Entregado! 🎉"
      }
    },
    "contacto": {
      "whatsapp": "573125249438",
      "telefono": "+57 312 524 9438",
      "direccion": "Cl 1AN #3E-7, Barrio La Ceiba, Cúcuta, Norte de Santander",
      "direccion_corta": "Cl 1AN #3E-7, Barrio La Ceiba, Cúcuta",
      "ciudad": "Cúcuta",
      "region": "Norte de Santander",
      "instagram": "lostaqueiros.co",
      "tiktok": "lostaqueiros_cuc"
    },
    "wompi": {
      "llave_publica_test": "pub_test_BkfgYqw5jzJrzH91HBDi7twQJJEcRXyz",
      "llave_publica_prod": "pub_prod_IwaQLknNwAMDaR6P5dhD4oCPWtF8UfNW"
    },
    "pwa": {
      "nombre": "Panel Taqueiros",
      "nombre_corto": "Comandas"
    }
  },
  "ubicacion": {
    "lat": 7.8997382,
    "lng": -72.4968525
  },
  "domicilio": {
    "factor_recorrido": 1.3,
    "pin_minimo_metros": 100,
    "area": {
      "latMin": 7.75,
      "latMax": 8.1,
      "lngMin": -72.68,
      "lngMax": -72.35
    }
  }
}$cfg$::jsonb from public.restaurantes r where r.id = public.restaurante_taqueiros_id())
      else true end,
    null),

  ('la config de Taqueiros no guarda secretos (ni llaves privadas, ni de integridad o eventos, ni apikey)',
    (select r.config::text !~* '(prv_|integrity|integridad|eventos|events|apikey|secret|service_role)'
       from public.restaurantes r where r.id = public.restaurante_taqueiros_id()),
    null),

  ('las llaves de Wompi de la config son PUBLICAS (pub_test_ / pub_prod_)',
    (select (r.config #>> '{publico,wompi,llave_publica_test}') ~ '^pub_test_[A-Za-z0-9]+$'
        and (r.config #>> '{publico,wompi,llave_publica_prod}') ~ '^pub_prod_[A-Za-z0-9]+$'
       from public.restaurantes r where r.id = public.restaurante_taqueiros_id()),
    null),

  ('la config de los demas restaurantes no cambio',
    (select a.huella_otros = coalesce((select md5(string_agg(r.id::text || r.config::text, '|' order by r.id))
                                       from public.restaurantes r where r.id <> public.restaurante_taqueiros_id()), '')
       from _mr12_antes a),
    null),

  -- Misma comprobacion que el SQL 10: esta migracion no puede abrir nada a clientes.
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
    (select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prosecdef
       and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)
       and p.oid not in ('public.config_jornada(uuid)'::regprocedure,
                         'public.seguimiento(text)'::regprocedure,
                         'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('anon', p.oid, 'execute')
            or has_function_privilege('authenticated', p.oid, 'execute')))),

  ('anon sigue sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
    (select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and has_table_privilege('anon', c.oid, 'select,insert,update,delete'))),

  ('RLS activo en TODAS las tablas de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
    (select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))),

  ('Realtime: pedidos sigue publicada',
    exists (select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pedidos'),
    null)
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr12_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 12 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

-- PostgREST tiene que enterarse de las columnas y funciones nuevas.
notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr12_verif
order by orden;
