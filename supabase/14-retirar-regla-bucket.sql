-- =============================================================
-- TAQUEIROS 2.0 — RETIRAR LA REGLA TRANSITORIA DE LA RAIZ DEL BUCKET  (SQL 14)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--             (boton "Run without RLS")
--
-- CORRELO SOLO DESPUES DE MOVER Y VERIFICAR LAS FOTOS
--   1. node supabase/exportar-respaldo.mjs
--   2. node supabase/migrar-fotos-raiz.mjs            (simulacion: solo informa)
--   3. node supabase/migrar-fotos-raiz.mjs --aplicar  (mueve las fotos de Taqueiros a su carpeta)
--   4. node supabase/migrar-fotos-raiz.mjs            (otra vez: debe decir "nada que hacer")
--   5. este archivo.
--   Si algun producto todavia apunta a una foto de la RAIZ del bucket, este archivo se detiene
--   (y no cambia nada) con el nombre de esos productos: esa foto dejaria de poder editarse.
--
-- QUE HACE
--   * puede_gestionar_fotos(): ya no existe el caso "raiz del bucket = Taqueiros". El dueno (y el
--     superadmin) solo escriben en la carpeta {restaurante_id}/ del restaurante del que son dueno.
--   * validar_producto(): ya no acepta una foto "plana" (fuera de carpeta) ni siquiera para Taqueiros.
--
-- QUE NO HACE
--   * No mueve ni borra ningun archivo, ni cambia ningun dato (comprueba la huella de productos).
--   * No cambia las 4 politicas de Storage (siguen llamando a puede_gestionar_fotos).
--   * No borra restaurante_taqueiros_id() (la usa el trigger personal -> miembros).
--
-- SEGURO DE RE-EJECUTAR (idempotente) y ATOMICO. Para deshacerlo: supabase/14-revertir.sql.
--
-- SI ALGO FALLA: los bloques "do $do$" repiten el error como  MR paso <paso>: <mensaje> [elemento: <objeto>];
-- si fallan las comprobaciones finales, "LA MIGRACION 14 SE REVIRTIO" con la lista. Todo se revierte.
-- Para SQL plano, usa Ctrl+G en VS Code y busca hacia arriba el marcador "-- >>> PASO ..." mas cercano.
--
-- Al final devuelve una fila por comprobacion: OK o FALLA.
-- =============================================================

begin;

set local lock_timeout = '20s';


-- =============================================================
-- >>> PASO 0) PRECONDICIONES: NINGUN PRODUCTO APUNTA A LA RAIZ DEL BUCKET
-- =============================================================
do $do$
declare
  v_paso constant text := '0 precondiciones';
  v_item text := '';
  v_lista text;
  v_n integer;
begin
  v_item := 'funciones y tablas del SQL 10';
  if to_regprocedure('public.puede_gestionar_fotos(text)') is null
     or to_regprocedure('public.validar_producto()') is null
     or to_regclass('public.productos') is null
     or to_regclass('storage.objects') is null then
    raise exception 'Faltan cosas del SQL 10. Corre primero supabase/10-multirestaurante.sql';
  end if;

  v_item := 'productos que apuntan a la raiz';
  -- Foto del bucket 'productos' cuyo archivo NO esta dentro de una carpeta
  select count(*), string_agg(r.slug || '/' || p.id, ', ' order by r.slug, p.id)
    into v_n, v_lista
  from (select p0.restaurante_id, p0.id
        from public.productos p0
        where p0.imagen ~ '/storage/v1/object/public/productos/[^/?#]+([?#].*)?$'
          and p0.imagen !~* '%2f'
        order by p0.restaurante_id, p0.id
        limit 1000) p
  join public.restaurantes r on r.id = p.restaurante_id;

  if v_n > 0 then
    raise exception E'Todavia hay % producto(s) que apuntan a una foto de la RAIZ del bucket (%). Mueve las fotos primero: node supabase/migrar-fotos-raiz.mjs --aplicar. No se cambio nada.',
      v_n, left(v_lista, 400);
  end if;
exception when others then
  raise exception 'MR paso %: % [elemento: %]', v_paso, sqlerrm, v_item using errcode = sqlstate;
end
$do$;

drop table if exists pg_temp._mr14_antes;
create temp table _mr14_antes as
select count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) as huella
from public.productos t;


-- =============================================================
-- >>> PASO 1) STORAGE: sin regla para la raiz del bucket
-- =============================================================
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
               and m.restaurante_id::text = (storage.foldername(p_ruta))[1] ) );
$$;

revoke all on function public.puede_gestionar_fotos(text) from public, anon;
grant execute on function public.puede_gestionar_fotos(text) to authenticated, service_role;


-- =============================================================
-- >>> PASO 2) PRODUCTOS: la foto tiene que estar en la carpeta del propio restaurante
-- =============================================================
-- Igual que validar_producto() del SQL 10, sin la rama de la "ruta plana".
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
      if resto ~ ('^' || new.restaurante_id::text || '/[A-Za-z0-9._-]{1,100}$') then
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
-- >>> PASO 3) COMPROBACIONES  (una fila por verificacion: OK o FALLA)
-- =============================================================
drop table if exists pg_temp._mr14_verif;
create temp table _mr14_verif (
  orden        serial,
  verificacion text,
  ok           boolean,
  detalle      text
);

insert into _mr14_verif (verificacion, ok, detalle)
select v.verificacion, coalesce(v.ok, false), v.detalle
from (values
  ('ningun producto apunta a una foto de la raiz del bucket',
    not exists (select 1 from public.productos p
                where p.imagen ~ '/storage/v1/object/public/productos/[^/?#]+([?#].*)?$' and p.imagen !~* '%2f'),
    null),

  ('puede_gestionar_fotos ya no menciona la raiz ni a Taqueiros, y sigue sin ser SECURITY DEFINER',
    exists (select 1 from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname = 'puede_gestionar_fotos'
              and p.prosrc not like '%restaurante_taqueiros_id%' and p.prosrc like '%foldername%'
              and not p.prosecdef and not has_function_privilege('anon', p.oid, 'execute')
              and has_function_privilege('authenticated', p.oid, 'execute')),
    null),

  ('validar_producto ya no acepta rutas planas (version del SQL 14 activa) y su trigger sigue activo',
    exists (select 1 from pg_trigger t join pg_proc f on f.oid = t.tgfoid
            where t.tgrelid = 'public.productos'::regclass and t.tgname = 'productos_validar'
              and not t.tgisinternal and t.tgenabled <> 'D'
              and f.prosrc not like '%estructura antigua%' and f.prosrc like '%carpeta propia%'),
    null),

  ('Storage: las 4 politicas mr_ del bucket siguen puestas y ninguna otra abre el bucket',
    (select count(*) = 4 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'mr\_productos\_fotos\_%')
      and not exists (select 1 from pg_policies
                      where schemaname = 'storage' and tablename = 'objects'
                        and policyname not like 'mr\_%'
                        and roles && array['anon'::name, 'authenticated'::name, 'public'::name]
                        and (coalesce(qual, '') || coalesce(with_check, '') not like '%bucket_id%'
                             or coalesce(qual, '') || coalesce(with_check, '') like '%productos%')),
    null),

  ('Storage: bucket productos publico, 2 MB, webp/jpeg/png',
    exists (select 1 from storage.buckets
            where id = 'productos' and public = true and file_size_limit = 2097152
              and allowed_mime_types @> array['image/webp', 'image/jpeg', 'image/png']
              and cardinality(allowed_mime_types) = 3),
    null),

  ('ninguna fila de productos cambio (conteo y huella)',
    not exists (select 1 from _mr14_antes a,
                  (select count(*)::bigint as filas, md5(coalesce(string_agg(t::text, '|' order by t.restaurante_id, t.id), '')) as huella
                   from public.productos t) d
                where d.filas <> a.filas or d.huella <> a.huella),
    null),

  ('anon sigue sin ejecutar nada que no sean seguimiento y buscar_mis_pedidos',
    not exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p')
                  and p.oid not in ('public.seguimiento(text)'::regprocedure,
                                    'public.buscar_mis_pedidos(text,integer,uuid)'::regprocedure)
                  and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                  and has_function_privilege('anon', p.oid, 'execute')),
    null),

  ('informativo: archivos que quedan en la RAIZ del bucket (nadie los referencia; solo el servidor puede borrarlos)',
    true,
    (select count(*) || ' archivo(s) en la raiz' from storage.objects o where o.bucket_id = 'productos' and o.name !~ '/'))
) as v(verificacion, ok, detalle);

do $do$
declare
  malas text;
begin
  select string_agg(verificacion || coalesce(' [' || detalle || ']', ''), E'\n  - ' order by orden)
    into malas
  from _mr14_verif where not ok;

  if malas is not null then
    raise exception E'LA MIGRACION 14 SE REVIRTIO (no se cambio nada). Fallaron estas comprobaciones:\n  - %', malas;
  end if;
end
$do$;

notify pgrst, 'reload schema';

commit;

-- Resultado: una fila por comprobacion. Todas deben decir OK.
select orden,
       verificacion,
       case when ok then 'OK' else 'FALLA' end as estado,
       detalle
from _mr14_verif
order by orden;
