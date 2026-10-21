-- =============================================================
-- TAQUEIROS 2.0 — ENDURECER LA BASE  (SQL 13)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS": este archivo no crea tablas)
--
-- ANTES DE CORRERLO
--   * Los SQL 10, 11 y 12 ya deben estar aplicados.
--   * Haz el respaldo:  node supabase/exportar-respaldo.mjs
--   * Todo el codigo (api/, paginas, scripts) debe mandar restaurante_id
--     explicito: ya lo hace (docs/multirestaurante.md, seccion 16).
--
-- QUE HACE
--   1. Retira el valor por defecto transitorio de restaurante_id en TODAS las
--      tablas de negocio (encontradas por barrido de catalogo). Conserva NOT NULL
--      y la llave foranea. Un insert que olvide el restaurante ya NO cae en
--      Taqueiros: falla.
--   2. Valida restaurantes.config en la propia base (trigger BEFORE INSERT OR
--      UPDATE): claves desconocidas, tipos, largos, colores, URLs, tipografias,
--      etiquetas HTML, numeros fuera de rango y cualquier cosa que parezca un
--      secreto. Las reglas son las de api/_publico.js y restaurante-publico.js
--      (docs/multirestaurante.md, seccion 16, tabla unica). Antes de activarlo,
--      comprueba que la config actual de Taqueiros las cumple; si no, se detiene.
--      Tambien valida los rangos de tarifas_domicilio.
--   3. Minimo privilegio:
--        * restaurantes: el dueno solo cambia nombre y, dentro de config,
--          publico.textos y publico.contacto. Marca, ubicacion, domicilio,
--          llaves publicas y PWA: solo superadmin o servidor.
--        * configuracion: el dueno solo cambia cerrado_temporal, horarios y
--          mensaje_cerrado (lo unico que escribe el panel).
--        * tarifas_domicilio: el dueno y el cajero solo leen.
--        * restaurante_secretos, contadores_pedido, restaurante_dominios,
--          intentos_buscar_pedido, personal: sin privilegios para clientes (se re-afirma).
--
-- QUE NO HACE
--   * No cambia datos (comprueba que ninguna fila cambio), no borra tablas ni columnas.
--   * NO toca Storage: la regla transitoria de la raiz del bucket sigue puesta hasta que
--     las fotos se muevan (supabase/migrar-fotos-raiz.mjs) y se corra el SQL 14.
--   * No borra restaurante_taqueiros_id(): la usan la regla de la raiz del bucket, el
--     trigger personal -> miembros y validar_producto.
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO: va dentro de una transaccion. Si
-- cualquier paso o comprobacion falla, TODO se revierte.
-- Para deshacerlo: supabase/13-revertir.sql.
--
-- NO vuelvas a correr el SQL 10 despues de este: restauraria la version anterior de
-- proteger_campos_restaurante(). Si lo haces, corre este de nuevo (la comprobacion
-- "el dueno solo edita..." lo detecta).
--
-- SI ALGO FALLA
--   * Los bloques "do $do$" repiten el error asi:  MR paso <paso>: <mensaje> [elemento: <objeto>]
--   * Para SQL plano, el editor muestra el numero de linea: en VS Code usa Ctrl+G y busca hacia
--     arriba el marcador "-- >>> PASO ..." mas cercano. Lista de marcadores: buscar ">>> PASO".
--   * Si fallan las comprobaciones finales, el error dice "LA MIGRACION 13 SE REVIRTIO" y las lista.
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
  foreach t in array array['restaurantes','miembros','superadmins','tarifas_domicilio','pedidos','categorias',
                           'productos','configuracion','salud_notificaciones','restaurante_secretos','contadores_pedido'] loop
    v_item := t;
    if to_regclass('public.' || t) is null then faltan := faltan || ('tabla public.' || t); end if;
  end loop;

  foreach f in array array['public.restaurante_taqueiros_id()','public.es_servidor()','public.es_superadmin()',
                           'public.rol_en(uuid)','public.proteger_campos_restaurante()'] loop
    v_item := f;
    if to_regprocedure(f) is null then faltan := faltan || ('funcion ' || f); end if;
  end loop;

  if array_length(faltan, 1) > 0 then
    raise exception 'Faltan cosas del SQL 10. Corre primero supabase/10-multirestaurante.sql: %', array_to_string(faltan, '; ');
  end if;

  v_item := 'restaurante Taqueiros';
  if not exists (select 1 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()) then
    raise exception 'No existe el restaurante Taqueiros (id fijo del SQL 10)';
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- Lo que NO debe cambiar: la comprobacion final compara contra esto.
drop table if exists pg_temp._mr13_antes;
create temp table _mr13_antes as
select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t;

-- Tablas a las que este archivo les quito el valor por defecto en ESTA corrida
drop table if exists pg_temp._mr13_barrido;
create temp table _mr13_barrido (tabla text primary key);


-- =============================================================
-- >>> PASO 1) RETIRAR EL VALOR POR DEFECTO DE restaurante_id
-- =============================================================
-- Barrido por OID del catalogo: toda tabla (no de una extension) de public cuya columna
-- restaurante_id tenga un valor por defecto. Sigue siendo NOT NULL y con su llave foranea.
do $do$
declare
  v_paso constant text := '1 retirar el valor por defecto de restaurante_id';
  v_item text := '';
  r record;
begin
  for r in select c.oid as relid
           from pg_class c
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
             and a.atthasdef
             and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
           order by c.relname loop
    v_item := r.relid::regclass::text;
    execute format('alter table %s alter column restaurante_id drop default', r.relid::regclass);
    insert into _mr13_barrido (tabla) values (r.relid::regclass::text) on conflict do nothing;
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 2) VALIDACION DE restaurantes.config EN LA BASE
-- =============================================================
-- config_restaurante_errores(config) devuelve la lista de problemas (vacia = valida).
-- Es funcion pura: la usan el trigger, las comprobaciones de este archivo y, mas adelante,
-- el formulario del dueno. NO repite en los mensajes el valor recibido (podria ser un secreto).
--
-- Funcionamiento: se recorre TODO el JSON (clave por clave, a cualquier profundidad) y cada
-- nodo debe ser una hoja de la lista de reglas, un contenedor de alguna hoja (objeto) o un
-- elemento de colores_zonas. Lo demas es "clave desconocida".

-- >>> PASO 2.1 la funcion
create or replace function public.config_restaurante_errores(p_config jsonb)
returns text[]
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  e text[] := '{}';
  r record;
  txt text;
  k text;
  -- Claves y valores que parecen un secreto (insensible a mayusculas). pub_ NO esta: son llaves publicas.
  c_secreto_clave constant text := '(secret|secreto|apikey|api_key|passw|contrase|privad|private|prv_|service_role|token|integrity|integridad|bearer|credential|webhook)';
  c_secreto_valor constant text := '(prv_|(test|prod)_(integrity|events)_|sb_secret_|sb_publishable_|apikey|api_key|service_role|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN)';
  -- Controles, saltos de linea, ancho cero y marcas de direccion (bidi): los mismos que limpia el servidor
  c_control constant text := '[\x01-\x1f\x7f-\x9f' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279) || ']';
  c_color   constant text := '^#[0-9A-Fa-f]{6}$';
  c_ruta    constant text := '^/?[A-Za-z0-9][A-Za-z0-9_./-]*$';
  c_https   constant text := '^https://[a-z0-9-]+\.supabase\.co/storage/v1/object/public/[A-Za-z0-9_./%-]+$';
  c_fuentes constant text[] := array['Anton','Bebas Neue','Oswald','Montserrat','Poppins','Playfair Display','Fredoka',
                                     'Lora','Merriweather','Libre Franklin','Open Sans','Nunito','Lato','DM Sans',
                                     'Work Sans','Source Sans 3'];
  v_num numeric;
  v_ok boolean;
  v_i integer;
  v_a jsonb;
begin
  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    return array['config: debe ser un objeto JSON'];
  end if;
  if octet_length(p_config::text) > 20000 then
    return array['config: demasiado grande (maximo 20000 caracteres)'];
  end if;

  for r in
    with recursive
    reglas(ruta, clase, minimo, maximo) as (values
      ('publico.marca.logo',       'url',   null::numeric, 500::numeric),
      ('publico.marca.icono_192',  'url',   null, 500),
      ('publico.marca.icono_512',  'url',   null, 500),
      ('publico.marca.emoji',      'texto', null, 8),
      ('publico.marca.colores_zonas', 'colores', null, 8),
      ('publico.marca.tipografia.titulos', 'fuente', null, null),
      ('publico.marca.tipografia.cuerpo',  'fuente', null, null),
      ('publico.marca.colores.primario',         'color', null, null),
      ('publico.marca.colores.primario_oscuro',  'color', null, null),
      ('publico.marca.colores.primario_brillo',  'color', null, null),
      ('publico.marca.colores.claro',            'color', null, null),
      ('publico.marca.colores.claro_suave',      'color', null, null),
      ('publico.marca.colores.oscuro',           'color', null, null),
      ('publico.marca.colores.oscuro_2',         'color', null, null),
      ('publico.marca.colores.acento',           'color', null, null),
      ('publico.marca.colores.positivo',         'color', null, null),
      ('publico.marca.colores.texto_secundario', 'color', null, null),
      ('publico.marca.colores.texto_tenue',      'color', null, null),
      ('publico.marca.colores.positivo_brillo',  'color', null, null),
      ('publico.textos.titulo_pagina',        'texto', null, 400),
      ('publico.textos.descripcion_pagina',   'texto', null, 400),
      ('publico.textos.eslogan',              'texto', null, 400),
      ('publico.textos.tagline',              'texto', null, 400),
      ('publico.textos.descripcion_pie',      'texto', null, 400),
      ('publico.textos.servicios_linea',      'texto', null, 400),
      ('publico.textos.pie_final',            'texto', null, 400),
      ('publico.textos.ejemplo_nota',         'texto', null, 400),
      ('publico.textos.banner_abierto_icono', 'texto', null, 400),
      ('publico.textos.banner_abierto_titulo','texto', null, 400),
      ('publico.textos.banner_abierto_texto', 'texto', null, 400),
      ('publico.textos.banner_cerrado_icono', 'texto', null, 400),
      ('publico.textos.banner_cerrado_mensaje','texto', null, 400),
      ('publico.textos.seguimiento.tiempo_nuevo',       'texto', null, 200),
      ('publico.textos.seguimiento.tiempo_preparacion', 'texto', null, 200),
      ('publico.textos.seguimiento.tiempo_camino',      'texto', null, 200),
      ('publico.textos.seguimiento.tiempo_recoger',     'texto', null, 200),
      ('publico.textos.seguimiento.tiempo_entregado',   'texto', null, 200),
      ('publico.textos.seguimiento.frase_nuevo',        'texto', null, 200),
      ('publico.textos.seguimiento.frase_preparacion',  'texto', null, 200),
      ('publico.textos.seguimiento.frase_camino',       'texto', null, 200),
      ('publico.textos.seguimiento.frase_recoger',      'texto', null, 200),
      ('publico.textos.seguimiento.frase_entregado',    'texto', null, 200),
      ('publico.contacto.whatsapp',        'whatsapp', null, 25),
      ('publico.contacto.telefono',        'texto', null, 40),
      ('publico.contacto.direccion',       'texto', null, 200),
      ('publico.contacto.direccion_corta', 'texto', null, 200),
      ('publico.contacto.ciudad',          'texto', null, 80),
      ('publico.contacto.region',          'texto', null, 80),
      ('publico.contacto.instagram',       'usuario', null, null),
      ('publico.contacto.tiktok',          'usuario', null, null),
      ('publico.wompi.llave_publica_test', 'llave_test', null, null),
      ('publico.wompi.llave_publica_prod', 'llave_prod', null, null),
      ('publico.pwa.nombre',               'texto', null, 45),
      ('publico.pwa.nombre_corto',         'texto', null, 12),
      ('ubicacion.lat', 'num', -90, 90),
      ('ubicacion.lng', 'num', -180, 180),
      ('domicilio.factor_recorrido',  'num', 1, 3),
      ('domicilio.pin_minimo_metros', 'num', 0, 5000),
      ('domicilio.area.latMin', 'num', -90, 90),
      ('domicilio.area.latMax', 'num', -90, 90),
      ('domicilio.area.lngMin', 'num', -180, 180),
      ('domicilio.area.lngMax', 'num', -180, 180)
    ),
    hojas as (select string_to_array(g.ruta, '.') as p, g.clase, g.minimo, g.maximo from reglas g),
    w(p, v) as (
      select array[x.key], x.value from jsonb_each(p_config) x
      union all
      select w.p || t.k, t.v
      from w
      cross join lateral (
        select x.key as k, x.value as v
          from jsonb_each(case when jsonb_typeof(w.v) = 'object' then w.v else '{}'::jsonb end) x
        union all
        select (a.i - 1)::text, a.v
          from jsonb_array_elements(case when jsonb_typeof(w.v) = 'array' then w.v else '[]'::jsonb end)
               with ordinality as a(v, i)
      ) t
      where cardinality(w.p) < 8
    )
    select array_to_string(n.p, '.') as ruta,
           n.p[cardinality(n.p)] as clave,
           n.v,
           h.clase, h.minimo, h.maximo,
           exists (select 1 from hojas h2
                   where cardinality(h2.p) > cardinality(n.p) and h2.p[1:cardinality(n.p)] = n.p) as es_contenedor,
           exists (select 1 from hojas h3
                   where h3.clase = 'colores' and cardinality(n.p) = cardinality(h3.p) + 1
                     and n.p[1:cardinality(h3.p)] = h3.p) as es_elemento
    from w n
    left join hojas h on h.p = n.p
    order by 1
  loop
    -- a) nombre de clave sospechoso (no aplica a posiciones de un arreglo)
    if not r.es_elemento and r.clave ~* c_secreto_clave then
      e := e || (r.ruta || ': el nombre de la clave parece de un secreto; aqui no se guardan secretos');
    end if;

    -- b) cualquier texto, en cualquier clave: sin secretos ni etiquetas HTML
    if jsonb_typeof(r.v) = 'string' then
      txt := r.v #>> '{}';
      if txt ~* c_secreto_valor then
        e := e || (r.ruta || ': el valor parece un secreto (llave privada, secreto de Wompi, apikey o token); aqui no se guardan secretos');
      end if;
      if txt ~ '[<>]' then
        e := e || (r.ruta || ': no se permiten etiquetas HTML (los caracteres < y >)');
      end if;
    end if;

    -- c) forma
    if r.clase is null then
      if r.es_contenedor then
        if jsonb_typeof(r.v) <> 'object' then
          e := e || (r.ruta || ': debe ser un objeto');
        end if;
      elsif r.es_elemento then
        null;   -- se revisa junto con su arreglo
      else
        e := e || (r.ruta || ': clave desconocida');
      end if;

    elsif r.clase = 'texto' then
      if jsonb_typeof(r.v) <> 'string' then
        e := e || (r.ruta || ': debe ser texto');
      else
        txt := r.v #>> '{}';
        if char_length(txt) > r.maximo then
          e := e || (r.ruta || ': demasiado largo (maximo ' || r.maximo::integer || ' caracteres)');
        end if;
        if txt ~ c_control then
          e := e || (r.ruta || ': no se permiten saltos de linea ni caracteres de control o invisibles');
        end if;
        if txt ~ '^[A-Za-z0-9_-]{32,}$' then
          e := e || (r.ruta || ': parece una clave y no un texto');
        end if;
      end if;

    elsif r.clase = 'url' then
      if jsonb_typeof(r.v) <> 'string' then
        e := e || (r.ruta || ': debe ser texto');
      else
        txt := r.v #>> '{}';
        v_ok := char_length(txt) <= 500
                and position('..' in txt) = 0
                and ( (txt ~ c_ruta and position('//' in txt) = 0) or txt ~ c_https );
        if not v_ok then
          e := e || (r.ruta || ': URL no permitida (solo una ruta relativa del sitio o https del Storage de Supabase, sin .. ni //)');
        end if;
      end if;

    elsif r.clase = 'color' then
      if jsonb_typeof(r.v) <> 'string' or (r.v #>> '{}') !~ c_color then
        e := e || (r.ruta || ': color no valido (se espera #RRGGBB)');
      end if;

    elsif r.clase = 'colores' then
      if jsonb_typeof(r.v) <> 'array' then
        e := e || (r.ruta || ': debe ser una lista de colores');
      else
        if jsonb_array_length(r.v) > r.maximo then
          e := e || (r.ruta || ': demasiados colores (maximo ' || r.maximo::integer || ')');
        end if;
        for v_i in 0 .. jsonb_array_length(r.v) - 1 loop
          v_a := r.v -> v_i;
          if jsonb_typeof(v_a) <> 'string' or (v_a #>> '{}') !~ c_color then
            e := e || (r.ruta || '.' || v_i || ': color no valido (se espera #RRGGBB)');
          end if;
        end loop;
      end if;

    elsif r.clase = 'whatsapp' then
      if jsonb_typeof(r.v) <> 'string' then
        e := e || (r.ruta || ': debe ser texto');
      else
        txt := r.v #>> '{}';
        if char_length(txt) > r.maximo or regexp_replace(txt, '[[:space:]+()-]', '', 'g') !~ '^[0-9]{8,15}$' then
          e := e || (r.ruta || ': numero no valido (8 a 15 digitos; se admiten espacios, +, parentesis y guiones)');
        end if;
      end if;

    elsif r.clase = 'usuario' then
      if jsonb_typeof(r.v) <> 'string' or (r.v #>> '{}') !~ '^@?[A-Za-z0-9._]{1,60}$' then
        e := e || (r.ruta || ': usuario no valido (letras, numeros, punto y guion bajo; hasta 60)');
      end if;

    elsif r.clase = 'llave_test' then
      if jsonb_typeof(r.v) <> 'string' or (r.v #>> '{}') !~ '^pub_test_[A-Za-z0-9]{10,80}$' then
        e := e || (r.ruta || ': debe ser una llave PUBLICA de prueba de Wompi (pub_test_...)');
      end if;

    elsif r.clase = 'llave_prod' then
      if jsonb_typeof(r.v) <> 'string' or (r.v #>> '{}') !~ '^pub_prod_[A-Za-z0-9]{10,80}$' then
        e := e || (r.ruta || ': debe ser una llave PUBLICA de produccion de Wompi (pub_prod_...)');
      end if;

    elsif r.clase = 'fuente' then
      if jsonb_typeof(r.v) <> 'string' or not ((r.v #>> '{}') = any (c_fuentes)) then
        e := e || (r.ruta || ': tipografia fuera de la lista permitida');
      end if;

    elsif r.clase = 'num' then
      if jsonb_typeof(r.v) <> 'number' then
        e := e || (r.ruta || ': debe ser un numero');
      else
        v_num := (r.v #>> '{}')::numeric;
        if v_num < r.minimo or v_num > r.maximo then
          e := e || (r.ruta || ': fuera de rango (de ' || r.minimo::text || ' a ' || r.maximo::text || ')');
        end if;
      end if;
    end if;
  end loop;

  -- d) coherencia: ubicacion con lat y lng; area con minimos <= maximos
  if jsonb_typeof(p_config -> 'ubicacion') = 'object'
     and not ((p_config -> 'ubicacion') ? 'lat' and (p_config -> 'ubicacion') ? 'lng') then
    e := e || ('ubicacion: debe traer lat y lng')::text;
  end if;
  if jsonb_typeof(p_config #> '{domicilio,area}') = 'object' then
    v_a := p_config #> '{domicilio,area}';
    if jsonb_typeof(v_a -> 'latMin') = 'number' and jsonb_typeof(v_a -> 'latMax') = 'number'
       and (v_a ->> 'latMin')::numeric > (v_a ->> 'latMax')::numeric then
      e := e || ('domicilio.area: latMin no puede ser mayor que latMax')::text;
    end if;
    if jsonb_typeof(v_a -> 'lngMin') = 'number' and jsonb_typeof(v_a -> 'lngMax') = 'number'
       and (v_a ->> 'lngMin')::numeric > (v_a ->> 'lngMax')::numeric then
      e := e || ('domicilio.area: lngMin no puede ser mayor que lngMax')::text;
    end if;
  end if;

  return e;
end;
$fn$;

revoke all on function public.config_restaurante_errores(jsonb) from public, anon;
grant execute on function public.config_restaurante_errores(jsonb) to authenticated, service_role;

-- >>> PASO 2.2 la config actual de Taqueiros TIENE que cumplir las reglas (si no, no se activa nada)
do $do$
declare
  v_paso constant text := '2.2 la config actual de Taqueiros cumple las reglas';
  v_item text := 'restaurantes.config de Taqueiros';
  v_err text[];
begin
  select public.config_restaurante_errores(r.config) into v_err
  from public.restaurantes r where r.id = public.restaurante_taqueiros_id();

  if cardinality(v_err) > 0 then
    raise exception E'La config actual de Taqueiros NO cumple las reglas de validacion y por eso no se activo nada. Corrigela (Table editor -> restaurantes -> config) o avisame:\n  - %',
      array_to_string(v_err, E'\n  - ');
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 2.3 el trigger de validacion
-- Valida siempre en INSERT, y en UPDATE solo si la config cambia (asi un cambio de estado o de
-- vigencia hecho por el servidor nunca se frena por una config vieja). Aplica a TODOS: dueno,
-- superadmin, servidor y editor SQL.
create or replace function public.validar_config_restaurante()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_err text[];
begin
  if tg_op = 'UPDATE' and new.config is not distinct from old.config then
    return new;
  end if;

  v_err := public.config_restaurante_errores(new.config);
  if cardinality(v_err) > 0 then
    raise exception 'Configuracion del restaurante no valida: %',
      array_to_string(v_err[1:6], '; ')
      || case when cardinality(v_err) > 6 then format(' (y %s problemas mas)', cardinality(v_err) - 6) else '' end
      using errcode = '23514', hint = 'Las reglas estan en docs/multirestaurante.md, seccion 16';
  end if;
  return new;
end;
$fn$;

revoke all on function public.validar_config_restaurante() from public, anon;
grant execute on function public.validar_config_restaurante() to authenticated, service_role;

drop trigger if exists restaurantes_validar_config on public.restaurantes;
create trigger restaurantes_validar_config
  before insert or update on public.restaurantes
  for each row execute function public.validar_config_restaurante();

-- >>> PASO 2.4 rangos de las tarifas de domicilio
create or replace function public.validar_tarifa_domicilio()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.hasta is null or new.hasta <= 0 or new.hasta > 1000 then
    raise exception 'Tarifa de domicilio no valida: el limite en km debe estar entre 0 (sin incluir) y 1000'
      using errcode = '23514';
  end if;
  if new.precio is not null and (new.precio < 0 or new.precio > 500000) then
    raise exception 'Tarifa de domicilio no valida: el precio debe estar entre 0 y 500000 (o vacio = fuera de cobertura)'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

revoke all on function public.validar_tarifa_domicilio() from public, anon;
grant execute on function public.validar_tarifa_domicilio() to authenticated, service_role;

drop trigger if exists tarifas_domicilio_validar on public.tarifas_domicilio;
create trigger tarifas_domicilio_validar
  before insert or update on public.tarifas_domicilio
  for each row execute function public.validar_tarifa_domicilio();


-- =============================================================
-- >>> PASO 3) MINIMO PRIVILEGIO
-- =============================================================

-- >>> PASO 3.1 restaurantes: el dueno solo cambia el nombre y, de la config, textos y contacto.
-- Reemplaza la version del SQL 10 (que listaba las columnas prohibidas): ahora es una LISTA
-- DE LO PERMITIDO, asi una columna nueva queda protegida de entrada. Servidor y superadmin
-- no tienen limites aqui (la validacion del PASO 2 si les aplica).
create or replace function public.proteger_campos_restaurante()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  permitidas constant text[] := array['nombre', 'config'];
  v_n jsonb;
  v_o jsonb;
begin
  if public.es_servidor() or (select public.es_superadmin()) then
    return new;
  end if;

  -- id, slug, estado, plan, modalidad_pago, vigente_hasta, dias_gracia, modulos, zona_horaria,
  -- hora_corte_jornada, creado_en y cualquier columna futura
  if (to_jsonb(new) - permitidas) is distinct from (to_jsonb(old) - permitidas) then
    raise exception 'Solo se puede cambiar el nombre y los textos y el contacto del restaurante' using errcode = '42501';
  end if;

  if new.nombre is distinct from old.nombre
     and (char_length(btrim(new.nombre)) not between 1 and 120
          or new.nombre ~ '[<>]'
          or new.nombre ~ ('[\x01-\x1f\x7f-\x9f' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8292) || chr(8294) || '-' || chr(8297) || chr(65279) || ']')) then
    raise exception 'Nombre del restaurante no valido (1 a 120 caracteres, sin < ni > ni caracteres de control)'
      using errcode = '23514';
  end if;

  -- De la config, el dueno solo toca publico.textos y publico.contacto: todo lo demas debe quedar igual
  if new.config is distinct from old.config then
    -- un publico que no es objeto no se puede recortar: se rechaza con un mensaje claro
    if new.config ? 'publico' and jsonb_typeof(new.config -> 'publico') <> 'object' then
      raise exception 'config.publico debe ser un objeto' using errcode = '23514';
    end if;
    v_n := case when jsonb_typeof(new.config -> 'publico') = 'object'
                then new.config #- '{publico,textos}' #- '{publico,contacto}' else new.config end;
    v_o := case when jsonb_typeof(old.config -> 'publico') = 'object'
                then old.config #- '{publico,textos}' #- '{publico,contacto}' else old.config end;
    if v_n -> 'publico' = '{}'::jsonb then v_n := v_n - 'publico'; end if;
    if v_o -> 'publico' = '{}'::jsonb then v_o := v_o - 'publico'; end if;
    if v_n is distinct from v_o then
      raise exception 'El dueno solo puede cambiar config.publico.textos y config.publico.contacto (la marca, la ubicacion, el domicilio, las llaves y la PWA los cambia el servidor o el superadmin)'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$fn$;

revoke all on function public.proteger_campos_restaurante() from public, anon;
grant execute on function public.proteger_campos_restaurante() to authenticated, service_role;

drop trigger if exists restaurantes_proteger on public.restaurantes;
create trigger restaurantes_proteger
  before update on public.restaurantes
  for each row execute function public.proteger_campos_restaurante();

-- >>> PASO 3.2 configuracion: el dueno solo cambia lo que el panel escribe.
-- hora_corte_jornada, minutos_ocultar_terminados, id y cualquier columna futura: servidor o superadmin.
create or replace function public.proteger_campos_configuracion()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  permitidas constant text[] := array['cerrado_temporal', 'horarios', 'mensaje_cerrado', 'actualizado_en'];
begin
  if public.es_servidor() or (select public.es_superadmin()) then
    return new;
  end if;
  if (to_jsonb(new) - permitidas) is distinct from (to_jsonb(old) - permitidas) then
    raise exception 'Solo se puede cambiar si el local esta cerrado, el horario y el mensaje de cerrado' using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke all on function public.proteger_campos_configuracion() from public, anon;
grant execute on function public.proteger_campos_configuracion() to authenticated, service_role;

drop trigger if exists configuracion_proteger on public.configuracion;
create trigger configuracion_proteger
  before update on public.configuracion
  for each row execute function public.proteger_campos_configuracion();

-- >>> PASO 3.3 tarifas_domicilio: dueno y cajero solo leen; escribe el superadmin (y el servidor)
do $do$
declare
  v_paso constant text := '3.3 politicas de tarifas_domicilio';
  v_item text := '';
begin
  v_item := 'mr_tarifas_insert'; drop policy if exists mr_tarifas_insert on public.tarifas_domicilio;
  v_item := 'mr_tarifas_update'; drop policy if exists mr_tarifas_update on public.tarifas_domicilio;
  v_item := 'mr_tarifas_delete'; drop policy if exists mr_tarifas_delete on public.tarifas_domicilio;

  v_item := 'crear mr_tarifas_insert';
  create policy mr_tarifas_insert on public.tarifas_domicilio for insert to authenticated
    with check ((select public.es_superadmin()));
  v_item := 'crear mr_tarifas_update';
  create policy mr_tarifas_update on public.tarifas_domicilio for update to authenticated
    using ((select public.es_superadmin())) with check ((select public.es_superadmin()));
  v_item := 'crear mr_tarifas_delete';
  create policy mr_tarifas_delete on public.tarifas_domicilio for delete to authenticated
    using ((select public.es_superadmin()));
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 3.4 las tablas privadas siguen sin privilegios para clientes (se re-afirma; idempotente)
do $do$
declare
  v_paso constant text := '3.4 privilegios de las tablas privadas';
  v_item text := '';
  r record;
begin
  for r in select c.oid as relid
           from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
             and c.relname in ('restaurante_secretos', 'contadores_pedido', 'restaurante_dominios', 'intentos_buscar_pedido', 'personal') loop
    v_item := r.relid::regclass::text;
    execute format('revoke all on table %s from anon, authenticated', r.relid::regclass);
  end loop;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;


-- =============================================================
-- >>> PASO 4) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================

-- >>> PASO 4.1 pruebas con inserciones que se deshacen (no queda ningun dato)
-- Para cada tabla: (a) el mismo insert CON restaurante_id funciona (o choca con la llave primaria,
-- que se evalua DESPUES del NOT NULL), y (b) SIN restaurante_id falla. Todo se deshace.
create or replace function pg_temp.mr13_probar(p_con text, p_sin text, p_espera_con text)
returns text
language plpgsql
as $fn$
declare
  v_cod text;
begin
  -- (a) control positivo
  begin
    execute p_con;
    raise exception 'mr13_deshacer' using errcode = 'P0001';
  exception when others then
    if sqlerrm <> 'mr13_deshacer' then
      if p_espera_con is null or sqlstate <> p_espera_con then
        return 'control positivo fallo: ' || sqlstate || ' ' || sqlerrm;
      end if;
    end if;
  end;
  -- (b) sin restaurante_id
  begin
    execute p_sin;
    raise exception 'mr13_deshacer' using errcode = 'P0001';
  exception when others then
    if sqlerrm = 'mr13_deshacer' then
      return 'ACEPTO el insert sin restaurante_id';
    end if;
    v_cod := sqlstate;
    -- 23502 = NOT NULL; otro codigo = un trigger de validacion lo rechazo antes (tambien cuenta)
    return 'OK ' || v_cod || case when v_cod <> '23502' then ' (' || left(sqlerrm, 80) || ')' else '' end;
  end;
  return 'OK ' || v_cod;
end;
$fn$;

drop table if exists pg_temp._mr13_inserts;
create temp table _mr13_inserts (tabla text primary key, resultado text);

do $do$
declare
  v_paso constant text := '4.1 pruebas de insert sin restaurante_id';
  v_item text := '';
  v_rid constant text := '''' || public.restaurante_taqueiros_id()::text || '''';
  v_cat text;
begin
  v_item := 'pedidos';
  insert into _mr13_inserts values ('pedidos', pg_temp.mr13_probar(
    'insert into public.pedidos (id, restaurante_id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago) overriding system value values (-1, ' || v_rid || ', ''__mr13__'', ''nuevo'', ''x'', ''3000000000'', ''local'', ''[]'', 1, 0, 1, ''pendiente'')',
    'insert into public.pedidos (id, referencia, estado, cliente_nombre, cliente_telefono, tipo_pedido, items, subtotal, costo_domicilio, total, estado_pago) overriding system value values (-1, ''__mr13__'', ''nuevo'', ''x'', ''3000000000'', ''local'', ''[]'', 1, 0, 1, ''pendiente'')',
    null));

  v_item := 'categorias';
  insert into _mr13_inserts values ('categorias', pg_temp.mr13_probar(
    'insert into public.categorias (restaurante_id, id, nombre) values (' || v_rid || ', ''mr13-prueba'', ''Prueba MR13'')',
    'insert into public.categorias (id, nombre) values (''mr13-prueba'', ''Prueba MR13'')',
    null));

  v_item := 'productos';
  select c.id into v_cat from public.categorias c where c.restaurante_id = public.restaurante_taqueiros_id() limit 1;
  if v_cat is null then
    insert into _mr13_inserts values ('productos', 'OK sin categorias de Taqueiros para probar; se verifica por catalogo');
  else
    insert into _mr13_inserts values ('productos', pg_temp.mr13_probar(
      'insert into public.productos (restaurante_id, id, nombre, precio, categoria) values (' || v_rid || ', ''mr13-prueba'', ''Prueba MR13'', 1000, ' || quote_literal(v_cat) || ')',
      'insert into public.productos (id, nombre, precio, categoria) values (''mr13-prueba'', ''Prueba MR13'', 1000, ' || quote_literal(v_cat) || ')',
      null));
  end if;

  -- configuracion y salud_notificaciones ya tienen la fila de Taqueiros: el control positivo choca con la
  -- llave primaria (23505), que Postgres evalua despues del NOT NULL; sin restaurante_id falla antes (23502).
  v_item := 'configuracion';
  insert into _mr13_inserts values ('configuracion', pg_temp.mr13_probar(
    'insert into public.configuracion (restaurante_id, id, horarios) values (' || v_rid || ', 1, ''{}''::jsonb)',
    'insert into public.configuracion (id, horarios) values (1, ''{}''::jsonb)',
    '23505'));

  v_item := 'salud_notificaciones';
  insert into _mr13_inserts values ('salud_notificaciones', pg_temp.mr13_probar(
    'insert into public.salud_notificaciones (restaurante_id, id) values (' || v_rid || ', 1)',
    'insert into public.salud_notificaciones (id) values (1)',
    '23505'));
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 4.2 pruebas del trigger de validacion (sobre la tabla real, deshechas)
drop table if exists pg_temp._mr13_trigger;
create temp table _mr13_trigger (k text primary key, ok boolean, detalle text);

do $do$
declare
  v_paso constant text := '4.2 pruebas del trigger de validacion';
  v_item text := '';
  v_cod text;
  v_antes jsonb;
begin
  select r.config into v_antes from public.restaurantes r where r.id = public.restaurante_taqueiros_id();

  -- UPDATE hostil rechazado con 23514
  v_item := 'update hostil';
  begin
    update public.restaurantes set config = '{"publico":{"textos":{"eslogan":"<b>hola</b>"}}}'::jsonb
    where id = public.restaurante_taqueiros_id();
    raise exception 'mr13_deshacer' using errcode = 'P0001';
  exception when others then
    insert into _mr13_trigger values ('update_hostil', sqlstate = '23514', sqlstate || ' ' || left(sqlerrm, 120));
  end;

  -- INSERT hostil rechazado con 23514
  v_item := 'insert hostil';
  begin
    insert into public.restaurantes (slug, nombre, config) values ('mr13-prueba', 'Prueba MR13', '{"secreto":"x"}'::jsonb);
    raise exception 'mr13_deshacer' using errcode = 'P0001';
  exception when others then
    insert into _mr13_trigger values ('insert_hostil', sqlstate = '23514', sqlstate || ' ' || left(sqlerrm, 120));
  end;

  -- INSERT valido aceptado (se deshace)
  v_item := 'insert valido';
  begin
    insert into public.restaurantes (slug, nombre, config) values ('mr13-prueba', 'Prueba MR13', '{"publico":{"textos":{"eslogan":"Hola"}}}'::jsonb);
    raise exception 'mr13_deshacer' using errcode = 'P0001';
  exception when others then
    insert into _mr13_trigger values ('insert_valido', sqlerrm = 'mr13_deshacer', sqlstate || ' ' || left(sqlerrm, 120));
  end;

  -- un UPDATE que no toca la config no la valida (un cambio de estado nunca se frena por una config vieja)
  v_item := 'update sin tocar config';
  begin
    update public.restaurantes set nombre = nombre where id = public.restaurante_taqueiros_id();
    raise exception 'mr13_deshacer' using errcode = 'P0001';
  exception when others then
    insert into _mr13_trigger values ('update_sin_config', sqlerrm = 'mr13_deshacer', sqlstate || ' ' || left(sqlerrm, 120));
  end;

  insert into _mr13_trigger values ('config_intacta',
    (select r.config = v_antes from public.restaurantes r where r.id = public.restaurante_taqueiros_id()), null);
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

-- >>> PASO 4.3 la tabla de comprobaciones
drop table if exists pg_temp._mr13_verif;
create temp table _mr13_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr13_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  -- ---- 1. valores por defecto ----
  ('ninguna tabla de public conserva un valor por defecto en restaurante_id (barrido por catalogo)',
    not exists (select 1 from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.atthasdef
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
    (select string_agg(c.relname, ', ') from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.atthasdef
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'))),

  ('todas las tablas con restaurante_id lo conservan NOT NULL y con llave foranea a restaurantes',
    not exists (select 1 from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and (not a.attnotnull
                       or not exists (select 1 from pg_constraint k
                                      where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'public.restaurantes'::regclass
                                        and k.conkey = array[a.attnum]))),
    (select string_agg(c.relname, ', ') from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and (not a.attnotnull
            or not exists (select 1 from pg_constraint k
                           where k.conrelid = c.oid and k.contype = 'f' and k.confrelid = 'public.restaurantes'::regclass
                             and k.conkey = array[a.attnum])))),

  ('las 5 tablas de negocio con restaurante_id siguen existiendo (pedidos, categorias, productos, configuracion, salud_notificaciones)',
    (select count(*) = 5 from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
       and c.relname in ('pedidos', 'categorias', 'productos', 'configuracion', 'salud_notificaciones')),
    null)
) as v(verificacion, ok, detalle);

insert into _mr13_verif (verificacion, ok, detalle)
select 'insert sin restaurante_id FALLA en ' || i.tabla || ' (con control positivo, sin dejar datos)',
       i.resultado like 'OK%', i.resultado
from _mr13_inserts i
order by i.tabla;

insert into _mr13_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  -- ---- 2. validacion de config ----
  ('la config actual de Taqueiros cumple las reglas',
    (select cardinality(public.config_restaurante_errores(r.config)) = 0 from public.restaurantes r where r.id = public.restaurante_taqueiros_id()),
    null),

  ('el trigger restaurantes_validar_config esta activo (BEFORE INSERT OR UPDATE por fila)',
    exists (select 1 from pg_trigger t
            where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_validar_config'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16 and (t.tgtype & 1) = 1),
    null),

  ('config hostil: un UPDATE se rechaza con 23514 y la config queda intacta',
    (select t.ok from _mr13_trigger t where t.k = 'update_hostil') and (select t.ok from _mr13_trigger t where t.k = 'config_intacta'),
    (select t.detalle from _mr13_trigger t where t.k = 'update_hostil')),

  ('config hostil: un INSERT de restaurante se rechaza con 23514',
    (select t.ok from _mr13_trigger t where t.k = 'insert_hostil'),
    (select t.detalle from _mr13_trigger t where t.k = 'insert_hostil')),

  ('config valida: un INSERT de restaurante se acepta (control positivo, deshecho)',
    (select t.ok from _mr13_trigger t where t.k = 'insert_valido'),
    (select t.detalle from _mr13_trigger t where t.k = 'insert_valido')),

  ('un UPDATE que no toca la config no la vuelve a validar',
    (select t.ok from _mr13_trigger t where t.k = 'update_sin_config'),
    (select t.detalle from _mr13_trigger t where t.k = 'update_sin_config')),

  ('la validacion rechaza las 25 configuraciones hostiles de prueba (claves, tipos, largos, colores, URLs, fuentes, HTML, rangos, secretos)',
    (select count(*) = 25 and bool_and(cardinality(public.config_restaurante_errores(h.cfg)) > 0)
     from (values
       ('{"x":1}'::jsonb),
       ('{"publico":{"marca":{"colores":{"primario":"red;background:url(x)"}}}}'),
       ('{"publico":{"marca":{"colores":{"primario":"#12345"}}}}'),
       ('{"publico":{"textos":{"eslogan":"<script>alert(1)</script>"}}}'),
       ('{"publico":{"textos":{"eslogan":"prv_test_abcdefghijk"}}}'),
       ('{"publico":{"textos":{"eslogan":"sb_secret_abcdefghijk"}}}'),
       ('{"publico":{"textos":{"eslogan":"test_integrity_abcdefghijk"}}}'),
       ('{"publico":{"textos":{"eslogan":"prod_events_abcdefghijk"}}}'),
       ('{"publico":{"contacto":{"apikey":"1234567"}}}'),
       ('{"publico":{"marca":{"logo":"http://evil.example/x.png"}}}'),
       ('{"publico":{"marca":{"logo":"javascript:alert(1)"}}}'),
       ('{"publico":{"marca":{"logo":"https://evil.example/x.png"}}}'),
       ('{"publico":{"marca":{"logo":"../secreto.png"}}}'),
       ('{"publico":{"marca":{"tipografia":{"titulos":"Comic Sans"}}}}'),
       ('{"ubicacion":{"lat":91,"lng":0}}'),
       ('{"ubicacion":{"lat":7.5}}'),
       ('{"domicilio":{"area":{"latMin":9,"latMax":8}}}'),
       ('{"domicilio":{"area":{"lngMin":-70,"lngMax":-72}}}'),
       ('{"domicilio":{"factor_recorrido":99}}'),
       ('{"publico":{"textos":{"eslogan":123}}}'),
       ('{"publico":"texto"}'),
       ('{"publico":{"marca":{"colores_zonas":["#FFFFFF","nope"]}}}'),
       ('{"publico":{"contacto":{"whatsapp":"12"}}}'),
       ('{"publico":{"wompi":{"llave_publica_test":"prv_test_abcdefghijk"}}}'),
       (jsonb_build_object('publico', jsonb_build_object('textos', jsonb_build_object('eslogan', repeat('a ', 201)))))
     ) as h(cfg)),
    null),

  ('la validacion acepta 4 configuraciones validas de prueba (vacia, minima, completa, sin claves de mas)',
    (select count(*) = 4 and bool_and(cardinality(public.config_restaurante_errores(h.cfg)) = 0)
     from (values
       ('{}'::jsonb),
       ('{"publico":{"textos":{"eslogan":"Tacos y mas"}}}'),
       ('{"publico":{"marca":{"logo":"Recursos/logo/logo.png","emoji":"X","colores":{"primario":"#C1272D"},"colores_zonas":["#5C7A3B"],"tipografia":{"titulos":"Anton","cuerpo":"Libre Franklin"}},"contacto":{"whatsapp":"+57 312 524 9438","instagram":"@lostaqueiros.co"},"wompi":{"llave_publica_test":"pub_test_abcdefghijklmn"}},"ubicacion":{"lat":7.89,"lng":-72.49},"domicilio":{"factor_recorrido":1.3,"pin_minimo_metros":100,"area":{"latMin":7.7,"latMax":8.1,"lngMin":-72.7,"lngMax":-72.3}}}'),
       ('{"publico":{"marca":{"logo":"https://abcdefghij.supabase.co/storage/v1/object/public/productos/00000000-0000-4000-8000-000000000001/logo.webp"}}}')
     ) as h(cfg)),
    null),

  ('las funciones de validacion no son SECURITY DEFINER y anon no las ejecuta',
    (select count(*) = 4 and bool_and(not p.prosecdef and not has_function_privilege('anon', p.oid, 'execute'))
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('config_restaurante_errores', 'validar_config_restaurante', 'validar_tarifa_domicilio', 'proteger_campos_configuracion')),
    null),

  ('tarifas_domicilio: el trigger de rangos esta activo',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.tarifas_domicilio'::regclass and t.tgname = 'tarifas_domicilio_validar'
            and not t.tgisinternal and t.tgenabled <> 'D'),
    null),

  ('las tarifas actuales cumplen los rangos (hasta 1-1000 km, precio 0-500000 o vacio)',
    not exists (select 1 from public.tarifas_domicilio t
                where t.hasta <= 0 or t.hasta > 1000 or (t.precio is not null and (t.precio < 0 or t.precio > 500000))),
    null),

  -- ---- 3. permisos del dueno ----
  ('restaurantes: el trigger deja al dueno cambiar solo nombre y config.publico.textos / contacto (version del SQL 13 activa)',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.restaurantes'::regclass and t.tgname = 'restaurantes_proteger'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc like '%publico,textos%' and f.prosrc like '%publico,contacto%' and f.prosrc like '%permitidas%'),
    'si falla despues de un SQL 10, corre este archivo otra vez'),

  ('configuracion: el trigger deja al dueno cambiar solo cerrado_temporal, horarios y mensaje_cerrado',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.configuracion'::regclass and t.tgname = 'configuracion_proteger'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc like '%cerrado_temporal%' and f.prosrc like '%permitidas%'),
    null),

  ('tarifas_domicilio: insertar, actualizar y borrar solo el superadmin; dueno y cajero leen',
    (select count(*) = 3 and bool_and(coalesce(pl.qual, '') || coalesce(pl.with_check, '') like '%es_superadmin%'
                                      and coalesce(pl.qual, '') || coalesce(pl.with_check, '') not like '%rol_en%')
     from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'tarifas_domicilio' and pl.cmd in ('INSERT', 'UPDATE', 'DELETE'))
      and exists (select 1 from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'tarifas_domicilio' and pl.cmd = 'SELECT'),
    (select string_agg(pl.policyname || ':' || pl.cmd, ', ') from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'tarifas_domicilio')),

  ('miembros: solo el superadmin escribe; cada quien lee solo sus filas',
    (select count(*) = 3 and bool_and(coalesce(pl.qual, '') || coalesce(pl.with_check, '') like '%es_superadmin%'
                                      and coalesce(pl.qual, '') || coalesce(pl.with_check, '') not like '%rol_en%'
                                      and coalesce(pl.qual, '') || coalesce(pl.with_check, '') not like '%es_miembro%')
     from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'miembros' and pl.cmd in ('INSERT', 'UPDATE', 'DELETE')),
    null),

  ('restaurantes: crear y borrar solo el superadmin',
    (select count(*) = 2 and bool_and(coalesce(pl.qual, '') || coalesce(pl.with_check, '') like '%es_superadmin%'
                                      and coalesce(pl.qual, '') || coalesce(pl.with_check, '') not like '%rol_en%')
     from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'restaurantes' and pl.cmd in ('INSERT', 'DELETE')),
    null),

  ('superadmins: authenticated solo puede leer su propia fila',
    not has_table_privilege('authenticated', 'public.superadmins', 'insert,update,delete')
      and has_table_privilege('authenticated', 'public.superadmins', 'select')
      and (select count(*) = 1 from pg_policies pl where pl.schemaname = 'public' and pl.tablename = 'superadmins'),
    null),

  ('restaurante_secretos, contadores_pedido, restaurante_dominios, intentos_buscar_pedido y personal: ningun privilegio ni politica para anon ni authenticated',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and c.relname in ('restaurante_secretos', 'contadores_pedido', 'restaurante_dominios', 'intentos_buscar_pedido', 'personal')
                  and (has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
                       or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger')
                       or exists (select 1 from pg_policy p where p.polrelid = c.oid)
                       or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                                  and (has_column_privilege('anon', c.oid, a.attnum, 'select,insert,update')
                                       or has_column_privilege('authenticated', c.oid, a.attnum, 'select,insert,update'))))),
    (select string_agg(c.relname, ', ') from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
       and c.relname in ('restaurante_secretos', 'contadores_pedido', 'restaurante_dominios', 'intentos_buscar_pedido', 'personal')
       and (has_table_privilege('anon', c.oid, 'select,insert,update,delete')
            or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete')
            or exists (select 1 from pg_policy p where p.polrelid = c.oid)))),

  -- ---- 4. lo de siempre sigue en pie ----
  ('anon: sin privilegios sobre ninguna tabla de public',
    not exists (select 1 from pg_class c
                where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
                  and has_table_privilege('anon', c.oid, 'select,insert,update,delete')),
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
    null),

  ('Storage: este archivo NO toco la regla transitoria de la raiz del bucket (se retira con el SQL 14)',
    exists (select 1 from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'puede_gestionar_fotos'
              and p.prosrc like '%restaurante_taqueiros_id%')
      and (select count(*) = 4 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'mr\_productos\_fotos\_%'),
    null),

  ('Realtime: pedidos, productos, configuracion y salud_notificaciones siguen publicadas',
    (select count(*) = 4 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public'
       and tablename in ('pedidos', 'productos', 'configuracion', 'salud_notificaciones')),
    null),

  ('triggers de proteccion del SQL 10 siguen activos',
    (select count(*) = 10 from pg_trigger
     where not tgisinternal and tgenabled <> 'D' and tgname in (
       'pedidos_proteger_pago', 'pedidos_restaurante_inmutable', 'categorias_restaurante_inmutable',
       'productos_restaurante_inmutable', 'configuracion_restaurante_inmutable', 'pedidos_limitar_rol',
       'productos_validar', 'categorias_validar', 'pedidos_asignar_numero', 'restaurantes_proteger')),
    null),

  -- ---- 5. este archivo no cambio datos ----
  ('ninguna fila cambio (conteos y huellas de pedidos, categorias, productos, configuracion, salud, restaurantes, miembros y tarifas)',
    not exists (select 1 from _mr13_antes a
                join (select 'pedidos'::text as tabla, count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as huella from public.pedidos t
                      union all select 'categorias', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.categorias t
                      union all select 'productos', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) from public.productos t
                      union all select 'configuracion', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.configuracion t
                      union all select 'salud_notificaciones', count(*), md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id), '')) from public.salud_notificaciones t
                      union all select 'restaurantes', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.restaurantes t
                      union all select 'miembros', count(*), md5(coalesce(string_agg(t::text, '|' order by t.user_id, t.restaurante_id), '')) from public.miembros t
                      union all select 'tarifas_domicilio', count(*), md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.tarifas_domicilio t
                     ) d on d.tabla = a.tabla
                where d.filas <> a.filas or d.huella <> a.huella),
    null),

  ('informativo: restaurantes cuya config actual no cumple las reglas (no bloquea; se validan cuando cambie su config)',
    true,
    coalesce((select string_agg(r.slug, ', ') from public.restaurantes r where cardinality(public.config_restaurante_errores(r.config)) > 0), 'ninguno'))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr13_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 13 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
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
from _mr13_verif
order by orden;
