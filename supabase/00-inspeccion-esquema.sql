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
-- =============================================================

with
tablas as (
  select c.relname as tabla,
         c.relrowsecurity as rls,
         c.relforcerowsecurity as rls_forzado,
         (xpath('/row/c/text()',
                query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint as filas,
         has_table_privilege('anon', c.oid, 'select') as anon_select,
         has_table_privilege('anon', c.oid, 'insert,update,delete') as anon_escribe,
         has_table_privilege('authenticated', c.oid, 'select') as authenticated_select
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
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
         -- CREATE POLICY en storage.objects exige ser (miembro del) dueno de la tabla
         'puede_crear_politicas_en_storage', (select pg_has_role(current_user, c.relowner, 'member')
                                              from pg_class c where c.oid = 'storage.objects'::regclass),
         'pedidos_replica_identity', (select c.relreplident from pg_class c where c.oid = 'public.pedidos'::regclass))
union all
select 'secuencia_pedidos',
       (select jsonb_build_object('ultimo_valor', s.last_value, 'max_id', (select max(id) from public.pedidos))
        from pg_sequences s
        where s.schemaname = 'public'
          and s.sequencename = split_part(pg_get_serial_sequence('public.pedidos', 'id'), '.', 2));
