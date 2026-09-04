-- =============================================================
-- COMPARACION AUTOMATICA: tabla productos  vs  api/_precios.js
-- Ejecutar en el SQL Editor de Supabase.
--
-- La lista de abajo se genero LEYENDO api/_precios.js, que es la
-- fuente autoritativa (la que calcula lo que se le cobra al cliente).
--
-- SI TODO ESTA BIEN, esta consulta NO DEVUELVE NINGUNA FILA.
-- Cada fila que aparezca es una discrepancia que hay que revisar
-- ANTES de que el front empiece a leer de la tabla.
-- =============================================================

with esperado(id, precio) as (values
  ('bandeja-mixta', 28000),
  ('bandeja-buchona', 29000),
  ('bandeja-chichona-x2', 17000),
  ('bandeja-chichona-x4', 31000),
  ('bandeja-chingona-x2', 16000),
  ('bandeja-chingona-x4', 27000),
  ('bandeja-perrona-x2', 15000),
  ('bandeja-perrona-x4', 26000),
  ('bandeja-vergona-x2', 17000),
  ('bandeja-vergona-x4', 28000),
  ('doriloco', 26000),
  ('doriloco-recargado', 30000),
  ('nachos-locos-p', 15000),
  ('nachos-locos-g', 25000),
  ('birriamen', 26000),
  ('birriaco', 30000),
  ('hamburguesa-chida', 28000),
  ('nachos-padrisimos', 32000),
  ('chicana-birria', 30000),
  ('agua-brisa', 3000),
  ('cocacola', 5000),
  ('coronita', 7000),
  ('cerveza-sol', 5000),
  ('agua-horchata', 9000),
  ('agua-jamaica', 9000),
  ('agua-tamarindo', 9000),
  ('add-chicharron', 8000),
  ('add-chorizo', 4000),
  ('add-pechuga', 8000),
  ('add-carne-birria', 7000),
  ('add-caldo-birria', 5000),
  ('add-queso', 3000),
  ('add-nachos', 5000),
  ('add-tortillas', 6000),
  ('add-papa-casco', 6000),
  ('add-pico-gallo', 4000),
  ('add-guacamole', 5000),
  ('add-salsas', 2000)
)
select
  coalesce(e.id, p.id) as producto,
  case
    when p.id is null then 'FALTA en la tabla productos'
    when e.id is null then 'SOBRA en la tabla (no esta en _precios.js)'
    else 'PRECIO DISTINTO'
  end as problema,
  e.precio as precio_en_precios_js,
  p.precio as precio_en_la_tabla
from esperado e
full outer join public.productos p on p.id = e.id
where p.id is null
   or e.id is null
   or p.precio <> e.precio;
