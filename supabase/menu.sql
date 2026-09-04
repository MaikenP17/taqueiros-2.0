-- =============================================================
-- LOS TAQUEIROS 2.0 — El menu pasa a la base de datos
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- QUE HACE Y QUE NO HACE
-- Crea las tablas del menu y mete los 38 productos que hoy estan
-- escritos a mano en index.html y api/_precios.js.
--
-- NO cambia el front. index.html y api/_precios.js siguen igual y el
-- sitio sigue vendiendo exactamente como hasta ahora. Si algo sale
-- mal aqui, no se rompe nada: son tablas nuevas que todavia nadie
-- consulta.
--
-- LOS DATOS SALEN DEL CODIGO, NO SE INVENTARON
-- Se leyeron los dos archivos y se compararon uno a uno: los
-- 38 productos coinciden en id, nombre y precio en ambos.
-- Los precios provienen de api/_precios.js, que es la fuente
-- autoritativa (la que calcula lo que se le cobra al cliente).
--
-- Seguro de re-ejecutar.
-- =============================================================


-- 1) CATEGORIAS ------------------------------------------------------
-- Tabla aparte (y no columnas repetidas en cada producto) para que
-- renombrar o reordenar una categoria sea UNA fila y no 38.
create table if not exists public.categorias (
  id      text primary key,          -- 'bandejas', 'con-birria'...
  nombre  text not null,             -- lo que ve el cliente
  emoji   text,                      -- icono de la barra de categorias
  orden   integer not null default 0,-- posicion en el menu
  activa  boolean not null default true
);


-- 2) PRODUCTOS -------------------------------------------------------
create table if not exists public.productos (
  -- El id es el MISMO texto que ya usan el carrito y api/_precios.js
  -- ('bandeja-mixta', 'doriloco'...). Es imprescindible conservarlo:
  -- si cambiara, los pedidos guardados dejarian de poder enlazarse
  -- con su producto.
  id          text primary key,

  nombre      text not null,
  descripcion text,

  -- En pesos colombianos, entero. Nunca decimales: evita errores de
  -- redondeo al cobrar.
  precio      integer not null check (precio > 0),

  categoria   text not null references public.categorias(id),
  orden       integer not null default 0,

  -- Para agotar un producto sin borrarlo. Un producto agotado sigue
  -- existiendo (los pedidos viejos lo siguen referenciando).
  disponible  boolean not null default true,

  -- Ruta de la foto dentro de /Recursos. Sin esto el front no podria
  -- pintar las tarjetas cuando lea de aqui.
  imagen      text,

  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create index if not exists productos_categoria_idx on public.productos (categoria, orden);
create index if not exists productos_disponible_idx on public.productos (disponible) where disponible = true;

-- actualizado_en se refresca solo (reutiliza el trigger existente)
drop trigger if exists productos_actualizado_en on public.productos;
create trigger productos_actualizado_en
  before update on public.productos
  for each row execute function public.tocar_actualizado_en();


-- 3) SEGURIDAD (RLS) -------------------------------------------------
-- El menu es publico por naturaleza: la pagina del cliente tiene que
-- poder leerlo SIN sesion. Pero escribirlo es cosa del personal, con
-- el mismo criterio que ya usa la tabla 'pedidos'.
alter table public.categorias enable row level security;
alter table public.productos  enable row level security;

-- LECTURA: cualquiera, incluso sin iniciar sesion.
drop policy if exists "menu visible para todos" on public.categorias;
create policy "menu visible para todos"
  on public.categorias for select
  to anon, authenticated
  using (true);

drop policy if exists "productos visibles para todos" on public.productos;
create policy "productos visibles para todos"
  on public.productos for select
  to anon, authenticated
  using (true);

-- ESCRITURA: solo el personal autorizado (misma funcion es_personal()
-- que protege los pedidos). Un anonimo no puede tocar los precios.
drop policy if exists "personal edita categorias" on public.categorias;
create policy "personal edita categorias"
  on public.categorias for all
  to authenticated
  using ( public.es_personal() )
  with check ( public.es_personal() );

drop policy if exists "personal edita productos" on public.productos;
create policy "personal edita productos"
  on public.productos for all
  to authenticated
  using ( public.es_personal() )
  with check ( public.es_personal() );


-- 4) REALTIME --------------------------------------------------------
-- Para que marcar un producto como agotado se vea al instante.
do $$
begin
  alter publication supabase_realtime add table public.productos;
exception
  when duplicate_object then null;
end;
$$;


-- 5) DATOS: CATEGORIAS -----------------------------------------------
insert into public.categorias (id, nombre, emoji, orden) values
  ('bandejas', 'Bandejas de Tacos', '🌮', 0),
  ('con-birria', 'Con Birria', '🔥', 1),
  ('especiales', 'Especiales', '⭐', 2),
  ('bebidas', 'Bebidas', '🥤', 3),
  ('aguas-frescas', 'Aguas Frescas', '🍹', 4),
  ('adiciones', 'Adiciones', '➕', 5)
on conflict (id) do update set
  nombre = excluded.nombre,
  emoji  = excluded.emoji,
  orden  = excluded.orden;


-- 6) DATOS: PRODUCTOS ------------------------------------------------
-- 'disponible' no se toca al re-ejecutar: si el restaurante agoto un
-- producto, volver a correr este script no lo revive por sorpresa.
insert into public.productos (id, nombre, descripcion, precio, categoria, orden, imagen) values
  ('bandeja-mixta', 'Bandeja Mixta', '2 tacos chingones y 2 tacos vergones.', 28000, 'bandejas', 0, 'Recursos/tacos/bandeja mixta.webp'),
  ('bandeja-buchona', 'Bandeja Buchona', 'Un taco de cada una de nuestras 4 bandejas: chichona, chingona, vergona y perrona.', 29000, 'bandejas', 1, 'Recursos/tacos/bandeja buchona.webp'),
  ('bandeja-chichona-x2', 'Bandeja Chichona x2', 'Tortilla de maíz, chicharrón carnudo, guacamole, cebolla y cilantro.', 17000, 'bandejas', 2, 'Recursos/tacos/bandeja chichona x2.jpeg'),
  ('bandeja-chichona-x4', 'Bandeja Chichona x4', 'Tortilla de maíz, chicharrón carnudo, guacamole, cebolla y cilantro.', 31000, 'bandejas', 3, 'Recursos/tacos/bandeja chichona x4.jpeg'),
  ('bandeja-chingona-x2', 'Bandeja Chingona x2', 'Tortilla de maíz, carne de birria, queso mozzarella, cebolla, cilantro y caldo de birria.', 16000, 'bandejas', 4, 'Recursos/tacos/bandeja chingona x2.jpeg'),
  ('bandeja-chingona-x4', 'Bandeja Chingona x4', 'Tortilla de maíz, carne de birria, queso mozzarella, cebolla, cilantro y caldo de birria.', 27000, 'bandejas', 5, 'Recursos/tacos/bandeja chingona x4.jpeg'),
  ('bandeja-perrona-x2', 'Bandeja Perrona x2', 'Tortilla de maíz, carne de birria, cebolla, cilantro y caldo de birria.', 15000, 'bandejas', 6, 'Recursos/tacos/bandeja perrona x2.jpeg'),
  ('bandeja-perrona-x4', 'Bandeja Perrona x4', 'Tortilla de maíz, carne de birria, cebolla, cilantro y caldo de birria.', 26000, 'bandejas', 7, 'Recursos/tacos/bandeja perrona x4.jpeg'),
  ('bandeja-vergona-x2', 'Bandeja Vergona x2', 'Tortilla de maíz, carne de birria, guacamole, cebolla, cilantro y caldo de birria.', 17000, 'bandejas', 8, 'Recursos/tacos/bandeja vergona x2.jpeg'),
  ('bandeja-vergona-x4', 'Bandeja Vergona x4', 'Tortilla de maíz, carne de birria, guacamole, cebolla, cilantro y caldo de birria.', 28000, 'bandejas', 9, 'Recursos/tacos/bandeja vergona x4.jpeg'),
  ('doriloco', 'Doriloco', 'Paquete 80g. Carne de birria, queso mozzarella, salsa dulce, guacamole, cebolla y cilantro.', 26000, 'con-birria', 0, 'Recursos/con birria/dorilocos.webp'),
  ('doriloco-recargado', 'Doriloco Recargado', 'Nuestro Doriloco con chorizo y maíz extra.', 30000, 'con-birria', 1, 'Recursos/con birria/doriloco recargado.webp'),
  ('nachos-locos-p', 'Nachos Locos Pequeño', 'Nachos, carne de birria, pico de gallo, guacamole y salsa dulce.', 15000, 'con-birria', 2, 'Recursos/con birria/nachos locos.webp'),
  ('nachos-locos-g', 'Nachos Locos Grande', 'Nachos, carne de birria, pico de gallo, guacamole y salsa dulce.', 25000, 'con-birria', 3, 'Recursos/con birria/nachos locos.webp'),
  ('birriamen', 'Birriamen', 'Vaso 24oz. Pasta ramen, carne, caldo de birria, queso mozzarella, cebolla y cilantro.', 26000, 'con-birria', 4, 'Recursos/con birria/birriamen.webp'),
  ('birriaco', 'Birriaco', 'Nuestro Birriamen + un taco perrón.', 30000, 'con-birria', 5, 'Recursos/con birria/birriaco.webp'),
  ('hamburguesa-chida', 'Hamburguesa La Chida', 'Pan brioche, croqueta de carne, carne de birria con queso mozzarella, queso philadelphia, cebolla y cilantro. Incluye nachos y caldo de birria.', 28000, 'especiales', 0, 'Recursos/especiales/hamburguesa la chida.jpeg'),
  ('nachos-padrisimos', 'Nachos Padrísimos', 'Nachos, carne de birria, chicharrón, pechuga, maíz y pico de gallo.', 32000, 'especiales', 1, 'Recursos/especiales/nachos padrisimos.jpeg'),
  ('chicana-birria', 'Chicana de Birria', 'Papas casco, carne de birria, chorizo, maduro, pico de gallo y salsa dulce.', 30000, 'especiales', 2, 'Recursos/especiales/chicana de birria.jpeg'),
  ('agua-brisa', 'Agua', 'Agua sin gas, 400ml.', 3000, 'bebidas', 0, 'Recursos/bebidas/agua brisa.webp'),
  ('cocacola', 'Coca Cola', 'Coca Cola personal, ideal para bajar el picante.', 5000, 'bebidas', 1, 'Recursos/bebidas/cocacola.webp'),
  ('coronita', 'Coronita', 'Cerveza Corona mini.', 7000, 'bebidas', 2, 'Recursos/bebidas/coronita.webp'),
  ('cerveza-sol', 'Cerveza Sol', 'Cerveza clara bien fría.', 5000, 'bebidas', 3, 'Recursos/bebidas/cerveza sol.webp'),
  ('agua-horchata', 'Horchata', 'Bebida de arroz con canela. 16 onzas.', 9000, 'aguas-frescas', 0, 'Recursos/aguas frescas/agua de horchata.webp'),
  ('agua-jamaica', 'Flor de Jamaica', 'Bebida antioxidante con limón. 16 onzas.', 9000, 'aguas-frescas', 1, 'Recursos/aguas frescas/agua de jamaica.webp'),
  ('agua-tamarindo', 'Tamarindo', 'Bebida refrescante agridulce. 16 onzas.', 9000, 'aguas-frescas', 2, 'Recursos/aguas frescas/agua de tamarindo.webp'),
  ('add-chicharron', 'Chicharrón', 'Adición.', 8000, 'adiciones', 0, NULL),
  ('add-chorizo', 'Chorizo', 'Adición.', 4000, 'adiciones', 1, NULL),
  ('add-pechuga', 'Pechuga', 'Adición.', 8000, 'adiciones', 2, NULL),
  ('add-carne-birria', 'Carne de Birria', 'Adición.', 7000, 'adiciones', 3, NULL),
  ('add-caldo-birria', 'Caldo de Birria', 'Adición.', 5000, 'adiciones', 4, NULL),
  ('add-queso', 'Queso', 'Adición.', 3000, 'adiciones', 5, NULL),
  ('add-nachos', 'Nachos', 'Adición.', 5000, 'adiciones', 6, NULL),
  ('add-tortillas', 'Tortillas x3', 'Adición.', 6000, 'adiciones', 7, NULL),
  ('add-papa-casco', 'Papa Casco', 'Adición.', 6000, 'adiciones', 8, NULL),
  ('add-pico-gallo', 'Pico de Gallo', 'Adición.', 4000, 'adiciones', 9, NULL),
  ('add-guacamole', 'Guacamole', 'Adición.', 5000, 'adiciones', 10, NULL),
  ('add-salsas', 'Salsas', 'Salsa dulce o salsa picante.', 2000, 'adiciones', 11, NULL)
on conflict (id) do update set
  nombre      = excluded.nombre,
  descripcion = excluded.descripcion,
  precio      = excluded.precio,
  categoria   = excluded.categoria,
  orden       = excluded.orden,
  imagen      = excluded.imagen;


-- 7) COMPROBACION ----------------------------------------------------
select
  (select count(*) from public.categorias) as categorias,
  (select count(*) from public.productos)  as productos,
  (select count(*) from public.productos where disponible) as disponibles;
