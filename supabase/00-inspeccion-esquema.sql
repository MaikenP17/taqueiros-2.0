-- =============================================================
-- TAQUEIROS 2.0 — INSPECCION DEL ESQUEMA REAL (SOLO LECTURA)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- PARA QUE SIRVE
-- El repositorio solo cuenta lo que se escribio en los archivos
-- supabase/*.sql. La base real puede tener cosas que se crearon a
-- mano desde el dashboard o que nunca se corrieron (por ejemplo los
-- SQL 01 y 02). Antes de correr 10-multirestaurante.sql, corre esto
-- y revisa (o pegame) el resultado.
--
-- NO MODIFICA NADA: es un solo SELECT.
--
-- COMO LEER EL RESULTADO
-- Devuelve una fila por seccion (columna "seccion") y una columna
-- "datos" con un JSON. Haz clic en la celda para verla completa y
-- copiala. Lo que mas importa:
--   * tablas_sin_restaurante_id  -> tablas que la migracion NO conoce.
--                                   Si aparece alguna que no sea
--                                   'personal', avisame antes de seguir.
--   * funciones                  -> mira "anon_ejecuta": una funcion
--                                   con true la puede llamar cualquiera
--                                   sin iniciar sesion.
--   * politicas_public / politicas_storage -> cualquier politica rara
--                                   que alguien creo desde el dashboard.
--   * sql_pendientes             -> si el SQL 01 y el 02 ya corrieron.
--   * funciones_security_definer / firmas_repetidas / triggers_en_auth_users
--                                -> lo que el SQL 10 se niega a dejar
--                                   pasar sin revision (ver docs, seccion 10).
--   * objetos_fuera_de_public_con_permisos / catalogo_pg_catalog_con_permisos
--                                -> lo que anon y authenticated alcanzan
--                                   fuera de public (informativo).
--   * objetos_de_extensiones_en_public -> objetos de public que son de una
--                                   extension (el SQL 10 los ignora).
--   * permiso_storage_objects    -> evidencia sobre si este usuario puede
--                                   crear politicas en storage.objects.
-- =============================================================

with
-- Se filtra PRIMERO (CTE materializada) y solo despues se arman nombres y se cuentan filas:
-- Postgres no garantiza el orden de los filtros de un WHERE, y una funcion que recibe un
-- nombre armado sobre filas de otros esquemas falla (relation "public.pg_statistic" does not exist).
tablas_base as materialized (
  select c.oid as oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
),
tablas as (
  select b.relname as tabla,
         b.relrowsecurity as rls,
         b.relforcerowsecurity as rls_forzado,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from public.%I', b.relname), false, true, '')))[1]::text::bigint as filas,
         has_table_privilege('anon', b.oid, 'select') as anon_select,
         has_table_privilege('anon', b.oid, 'insert,update,delete') as anon_escribe,
         has_table_privilege('authenticated', b.oid, 'select') as authenticated_select
  from tablas_base b
),
columnas as (
  select table_name as tabla,
         jsonb_agg(jsonb_build_object(
           'col', column_name, 'tipo', data_type, 'nulo', is_nullable,
           'defecto', column_default) order by ordinal_position) as cols
  from information_schema.columns
  where table_schema = 'public'
  group by table_name
),
restricciones as (
  select conrelid::regclass::text as tabla,
         jsonb_agg(jsonb_build_object('nombre', conname, 'tipo', contype,
                                      'def', pg_get_constraintdef(oid)) order by conname) as r
  from pg_constraint
  where connamespace = 'public'::regnamespace
  group by conrelid::regclass::text
),
funciones as (
  select p.oid::regprocedure::text as firma,
         p.prosecdef as security_definer,
         p.provolatile as volatilidad,
         p.proconfig as config,
         has_function_privilege('anon', p.oid, 'execute') as anon_ejecuta,
         has_function_privilege('authenticated', p.oid, 'execute') as authenticated_ejecuta
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
)
select 'tablas' as seccion,
       (select jsonb_agg(to_jsonb(t) order by t.tabla) from tablas t) as datos
union all
select 'tablas_sin_restaurante_id',
       (select coalesce(jsonb_agg(t.tabla order by t.tabla), '[]'::jsonb)
        from tablas t
        where not exists (select 1 from information_schema.columns c
                          where c.table_schema = 'public' and c.table_name = t.tabla
                            and c.column_name = 'restaurante_id'))
union all
select 'columnas',
       (select jsonb_object_agg(tabla, cols) from columnas)
union all
select 'restricciones',
       (select jsonb_object_agg(tabla, r) from restricciones)
union all
select 'indices',
       (select jsonb_agg(jsonb_build_object('tabla', tablename, 'indice', indexname, 'def', indexdef)
                         order by tablename, indexname)
        from pg_indexes where schemaname = 'public')
union all
select 'triggers',
       (select jsonb_agg(jsonb_build_object('tabla', tgrelid::regclass::text, 'trigger', tgname,
                                            'def', pg_get_triggerdef(oid), 'activo', tgenabled <> 'D')
                         order by tgrelid::regclass::text, tgname)
        from pg_trigger
        where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace))
union all
select 'politicas_public',
       (select jsonb_agg(jsonb_build_object('tabla', tablename, 'politica', policyname, 'cmd', cmd,
                                            'roles', roles, 'using', qual, 'check', with_check)
                         order by tablename, policyname)
        from pg_policies where schemaname = 'public')
union all
select 'politicas_storage',
       (select jsonb_agg(jsonb_build_object('tabla', tablename, 'politica', policyname, 'cmd', cmd,
                                            'roles', roles, 'using', qual, 'check', with_check)
                         order by policyname)
        from pg_policies where schemaname = 'storage')
union all
select 'funciones',
       (select jsonb_agg(to_jsonb(f) order by f.firma) from funciones f)
union all
select 'funciones_que_anon_ejecuta',
       (select coalesce(jsonb_agg(f.firma order by f.firma), '[]'::jsonb) from funciones f where f.anon_ejecuta)
union all
select 'funciones_security_definer',
       (select coalesce(jsonb_agg(jsonb_build_object('firma', f.firma, 'anon', f.anon_ejecuta,
                                                     'authenticated', f.authenticated_ejecuta) order by f.firma), '[]'::jsonb)
        from funciones f where f.security_definer)
union all
select 'firmas_repetidas',
       (select coalesce(jsonb_agg(jsonb_build_object('funcion', proname, 'firmas', firmas) order by proname), '[]'::jsonb)
        from (select p.proname, jsonb_agg(p.oid::regprocedure::text) as firmas
              from pg_proc p where p.pronamespace = 'public'::regnamespace
              group by p.proname having count(*) > 1) x)
union all
select 'triggers_en_auth_users',
       (select coalesce(jsonb_agg(jsonb_build_object('trigger', t.tgname, 'funcion', f.oid::regprocedure::text,
                                                     'def', pg_get_triggerdef(t.oid))), '[]'::jsonb)
        from pg_trigger t join pg_proc f on f.oid = t.tgfoid
        where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal)
union all
-- Tablas, vistas y funciones FUERA de public que anon o authenticated pueden usar (esquemas de
-- Supabase: auth, storage, realtime, graphql, vault, extensions...). Solo informativo: el SQL 10 no
-- las toca. pg_catalog e information_schema van aparte (son cientos).
select 'objetos_fuera_de_public_con_permisos',
       (select coalesce(jsonb_agg(jsonb_build_object('esquema', x.esquema, 'objeto', x.objeto, 'tipo', x.tipo,
                                                     'dueno', x.dueno, 'anon', x.anon, 'authenticated', x.authenticated)
                               order by x.esquema, x.objeto), '[]'::jsonb)
        from (
          select n.nspname as esquema, c.relname as objeto,
                 case c.relkind when 'r' then 'tabla' when 'p' then 'tabla' when 'v' then 'vista'
                                when 'm' then 'vista materializada' else c.relkind::text end as tipo,
                 pg_get_userbyid(c.relowner)::text as dueno,
                 has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon,
                 has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as authenticated
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm')
            and n.nspname not in ('public', 'pg_catalog', 'information_schema')
            and n.nspname !~ '^pg_toast'
            and (has_table_privilege('anon', c.oid, 'select,insert,update,delete')
                 or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'))
          union all
          select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                 case when p.prosecdef then 'funcion SECURITY DEFINER' else 'funcion' end,
                 pg_get_userbyid(p.proowner)::text,
                 has_function_privilege('anon', p.oid, 'execute'),
                 has_function_privilege('authenticated', p.oid, 'execute')
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname not in ('public', 'pg_catalog', 'information_schema') and n.nspname !~ '^pg_toast'
            and p.prokind in ('f', 'p')
            and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
        ) x)
union all
select 'catalogo_pg_catalog_con_permisos',
       (select jsonb_build_object(
                 'tablas_que_anon_puede_leer', count(*) filter (where has_table_privilege('anon', c.oid, 'select')),
                 'tablas_que_authenticated_puede_leer', count(*) filter (where has_table_privilege('authenticated', c.oid, 'select')),
                 'ejemplos_anon', coalesce((array_agg(c.relname order by c.relname)
                                            filter (where has_table_privilege('anon', c.oid, 'select')))[1:10], '{}'::name[]))
        from pg_class c
        where c.relnamespace = 'pg_catalog'::regnamespace and c.relkind in ('r', 'p', 'v'))
union all
select 'objetos_de_extensiones_en_public',
       (select coalesce(jsonb_agg(jsonb_build_object('objeto', o.objeto, 'tipo', o.tipo, 'extension', o.extension)
                                  order by o.extension, o.objeto), '[]'::jsonb)
        from (
          select c.relname::text as objeto, 'relacion' as tipo, e.extname::text as extension
          from pg_class c join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
               join pg_extension e on e.oid = d.refobjid
          where c.relnamespace = 'public'::regnamespace
          union all
          select p.oid::regprocedure::text, 'funcion', e.extname::text
          from pg_proc p join pg_depend d on d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
               join pg_extension e on e.oid = d.refobjid
          where p.pronamespace = 'public'::regnamespace
          union all
          select t.typname::text, 'tipo', e.extname::text
          from pg_type t join pg_depend d on d.classid = 'pg_type'::regclass and d.objid = t.oid and d.deptype = 'e'
               join pg_extension e on e.oid = d.refobjid
          where t.typnamespace = 'public'::regnamespace and t.typtype <> 'c' and t.typname !~ '^_'
        ) o)
union all
-- Permiso para crear politicas en storage.objects. La membresia de roles NO es una prueba confiable
-- (en Supabase el dueno de la tabla es supabase_storage_admin y postgres puede crear politicas por
-- otra via), asi que aqui se muestra la EVIDENCIA y la verdad la da el propio SQL 10, que intenta
-- crear una politica de prueba y se detiene con un mensaje claro si no puede.
select 'permiso_storage_objects',
       (select jsonb_build_object(
          'usuario_actual', current_user::text,
          'es_superusuario', (select r.rolsuper from pg_roles r where r.rolname = current_user),
          'dueno_de_storage_objects', pg_get_userbyid(c.relowner)::text,
          'es_miembro_del_dueno', pg_has_role(current_user, c.relowner, 'member'),
          'usa_privilegios_del_dueno', pg_has_role(current_user, c.relowner, 'usage'),
          'roles_de_los_que_es_miembro', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)
                                           from pg_auth_members m where m.member = (select oid from pg_roles where rolname = current_user)),
          'politicas_existentes_en_storage_objects',
             (select coalesce(jsonb_agg(policyname order by policyname), '[]'::jsonb) from pg_policies
              where schemaname = 'storage' and tablename = 'objects'),
          'privilegio_en_la_tabla', jsonb_build_object(
             'select', has_table_privilege(current_user, c.oid, 'select'),
             'insert', has_table_privilege(current_user, c.oid, 'insert'),
             'trigger', has_table_privilege(current_user, c.oid, 'trigger')),
          'lectura', 'si politicas_existentes incluye politicas "productos personal ..." (creadas por el SQL 01 desde este mismo editor), este usuario SI puede crearlas aunque es_miembro_del_dueno salga false')
        from pg_class c where c.oid = 'storage.objects'::regclass)
union all
select 'vistas',
       (select coalesce(jsonb_agg(jsonb_build_object('vista', viewname, 'def', definition)), '[]'::jsonb)
        from pg_views where schemaname = 'public')
union all
select 'buckets',
       (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'publico', public,
                                                     'limite', file_size_limit, 'mime', allowed_mime_types)), '[]'::jsonb)
        from storage.buckets)
union all
select 'archivos_en_storage',
       (select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket_id, 'archivos', n,
                                                     'en_la_raiz', en_raiz, 'ejemplos', ejemplos)), '[]'::jsonb)
        from (select bucket_id, count(*) as n,
                     count(*) filter (where position('/' in name) = 0) as en_raiz,
                     (array_agg(name order by created_at desc))[1:3] as ejemplos
              from storage.objects group by bucket_id) s)
union all
select 'realtime_publicacion',
       (select coalesce(jsonb_agg(schemaname || '.' || tablename order by tablename), '[]'::jsonb)
        from pg_publication_tables where pubname = 'supabase_realtime')
union all
select 'extensiones',
       (select jsonb_agg(extname || ' ' || extversion order by extname) from pg_extension)
union all
select 'auth_usuarios',
       (select jsonb_build_object('total', count(*),
                                  'con_correo_confirmado', count(*) filter (where email_confirmed_at is not null))
        from auth.users)
union all
select 'personal_actual',
       (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'nombre', p.nombre, 'creado_en', p.creado_en)), '[]'::jsonb)
        from public.personal p)
union all
select 'sql_pendientes',
       jsonb_build_object(
         'sql_01_fotos_bucket_productos', exists (select 1 from storage.buckets where id = 'productos'),
         'sql_01_trigger_validar_producto', exists (select 1 from pg_trigger where tgname = 'productos_validar' and not tgisinternal),
         'sql_02_impresion_columna_impreso_en', exists (select 1 from information_schema.columns
                                                         where table_schema = 'public' and table_name = 'pedidos' and column_name = 'impreso_en'),
         'sql_02_funcion_reclamar_impresion', to_regprocedure('public.reclamar_impresion(bigint)') is not null,
         'ya_es_multirestaurante', to_regclass('public.restaurantes') is not null,
         -- (el permiso sobre storage.objects ya no se adivina aqui: ver la seccion permiso_storage_objects)
         'pedidos_replica_identity', (select c.relreplident from pg_class c where c.oid = 'public.pedidos'::regclass))
union all
select 'secuencia_pedidos',
       (select jsonb_build_object('ultimo_valor', s.last_value, 'max_id', (select max(id) from public.pedidos))
        from pg_sequences s
        where s.schemaname = 'public'
          and s.sequencename = split_part(pg_get_serial_sequence('public.pedidos', 'id'), '.', 2))
union all
-- SQL 13: tablas que todavia conservan un valor por defecto en restaurante_id (el SQL 13 se lo retira)
select 'restaurante_id_con_valor_por_defecto',
       (select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'restaurante_id' and a.attnum > 0 and not a.attisdropped
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.atthasdef)
union all
-- SQL 14: fotos que siguen en la RAIZ del bucket productos y productos que apuntan a ellas
select 'fotos_en_la_raiz_del_bucket',
       jsonb_build_object(
         'archivos_en_la_raiz', (select count(*) from storage.objects o where o.bucket_id = 'productos' and o.name !~ '/'),
         'productos_que_apuntan_a_la_raiz', case when to_regclass('public.productos') is null then null else
           (select count(*) from public.productos p
            where p.imagen ~ '/storage/v1/object/public/productos/[^/?#]+([?#].*)?$') end);
