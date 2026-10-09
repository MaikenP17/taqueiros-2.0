-- =============================================================
-- LOS TAQUEIROS 2.0 — Gestion de productos y fotos desde el panel
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- QUE HACE
--   1. Crea el bucket publico 'productos' para las fotos del menu
--      (solo webp / jpeg / png, maximo 2 MB; solo el personal sube
--      o borra; cualquiera puede VER las fotos).
--   2. Pone validaciones en la base para que nadie pueda saltarse
--      las del panel: nombre, precio, categoria, URL de la foto.
--   3. Evita categorias repetidas (ignorando mayusculas y tildes).
--
-- QUE NO HACE
--   * No toca ningun producto ni categoria existente.
--   * No agrega columnas: 'productos.imagen' y 'productos.descripcion'
--     ya existen desde menu.sql.
--   * No cambia las politicas de las tablas: la escritura de
--     productos y categorias sigue siendo solo de es_personal().
--
-- Seguro de re-ejecutar (idempotente). Requiere haber corrido antes
-- seguridad.sql (es_personal) y menu.sql (tablas del menu).
--
-- Al final devuelve una tabla de comprobacion: todas las filas
-- deben decir 'OK'.
-- =============================================================


-- 1) COMPARAR TEXTOS SIN MAYUSCULAS NI TILDES -------------------------
-- "Cafe", "café" y "CAFÉ " cuentan como el mismo nombre. La enie se
-- trata como n (ano / año): para detectar repetidos es lo mas seguro.
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


-- 2) CATEGORIAS: nombre valido y sin repetir --------------------------
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

-- Unica barrera a prueba de carreras contra nombres repetidos
create unique index if not exists categorias_nombre_norm_uq
  on public.categorias (public.norm_texto(nombre));


-- 3) PRODUCTOS: nombre, precio, categoria y foto validos ---------------
-- Mismas reglas que el panel, pero aqui no se pueden saltar con la
-- consola del navegador.
--
-- Tope de precio: $300.000. El producto mas caro del menu hoy cuesta
-- $32.000; el tope es casi 10 veces eso, para combos grandes, y aun
-- asi atrapa un dedo gordo (28000 -> 2800000).
--
-- La foto debe ser de ESTE proyecto y de ESTE bucket (o una ruta
-- relativa 'Recursos/...' de las fotos que ya vienen con el sitio).
-- Ojo: si el proyecto cambia de URL, hay que cambiar 'prefijo_bucket'.
create or replace function public.validar_producto()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  tope_precio   constant integer := 300000;
  prefijo_bucket constant text :=
    'https://pzryobpriyewlxltditw.supabase.co/storage/v1/object/public/productos/';
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

  if not exists (select 1 from public.categorias c where c.id = new.categoria) then
    raise exception 'La categoría elegida no existe';
  end if;

  if tg_op = 'INSERT' and new.id !~ '^[a-z0-9][a-z0-9-]{1,59}$' then
    raise exception 'Identificador de producto inválido';
  end if;

  -- La foto solo se revisa cuando cambia: las 38 originales (rutas
  -- 'Recursos/...') no se tocan.
  if new.imagen is not null
     and (tg_op = 'INSERT' or new.imagen is distinct from old.imagen) then
    if left(new.imagen, char_length(prefijo_bucket)) = prefijo_bucket then
      if substr(new.imagen, char_length(prefijo_bucket) + 1) !~ '^[A-Za-z0-9._-]{1,100}$' then
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


-- 4) BUCKET DE FOTOS ---------------------------------------------------
-- Publico de LECTURA (el cliente ve las fotos sin sesion). Subir,
-- reemplazar y borrar: solo el personal (politicas de abajo).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 2097152,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set
  public             = true,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Un bucket publico entrega sus archivos por URL sin necesitar
-- politica de lectura. Estas son para el personal: subir, ver (el
-- panel lo necesita para reemplazar y borrar) y borrar.
drop policy if exists "productos personal sube" on storage.objects;
create policy "productos personal sube"
  on storage.objects for insert
  to authenticated
  with check ( bucket_id = 'productos' and public.es_personal() );

drop policy if exists "productos personal ve" on storage.objects;
create policy "productos personal ve"
  on storage.objects for select
  to authenticated
  using ( bucket_id = 'productos' and public.es_personal() );

drop policy if exists "productos personal reemplaza" on storage.objects;
create policy "productos personal reemplaza"
  on storage.objects for update
  to authenticated
  using ( bucket_id = 'productos' and public.es_personal() )
  with check ( bucket_id = 'productos' and public.es_personal() );

drop policy if exists "productos personal borra" on storage.objects;
create policy "productos personal borra"
  on storage.objects for delete
  to authenticated
  using ( bucket_id = 'productos' and public.es_personal() );


-- 5) COMPROBACION ------------------------------------------------------
-- Todas las filas deben decir OK. Si alguna dice FALTA, copia el
-- error y avisame; no se rompe nada del menu mientras tanto.
select * from (
  select 'bucket productos existe, publico, 2 MB, webp/jpeg/png' as comprobacion,
         case when exists (
           select 1 from storage.buckets
           where id = 'productos' and public = true
             and file_size_limit = 2097152
             and allowed_mime_types @> array['image/webp','image/jpeg','image/png']
             and cardinality(allowed_mime_types) = 3
         ) then 'OK' else 'FALTA' end as estado
  union all
  select 'politicas de storage (4)',
         case when (select count(*) from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname like 'productos personal %') = 4
              then 'OK' else 'FALTA' end
  union all
  select 'trigger de validacion de productos',
         case when exists (select 1 from pg_trigger
                           where tgname = 'productos_validar'
                             and tgrelid = 'public.productos'::regclass)
              then 'OK' else 'FALTA' end
  union all
  select 'trigger de validacion de categorias',
         case when exists (select 1 from pg_trigger
                           where tgname = 'categorias_validar'
                             and tgrelid = 'public.categorias'::regclass)
              then 'OK' else 'FALTA' end
  union all
  select 'indice contra categorias repetidas',
         case when exists (select 1 from pg_indexes
                           where schemaname = 'public'
                             and indexname = 'categorias_nombre_norm_uq')
              then 'OK' else 'FALTA' end
  union all
  select 'el menu original sigue intacto (6 categorias, 38 productos o mas)',
         case when (select count(*) from public.categorias) >= 6
               and (select count(*) from public.productos) >= 38
              then 'OK' else 'REVISAR' end
  union all
  select 'ningun producto existente incumple las reglas nuevas',
         case when not exists (
           select 1 from public.productos
           where char_length(btrim(nombre)) not between 1 and 60
              or precio not between 1 and 300000
         ) then 'OK' else 'REVISAR' end
) t;
