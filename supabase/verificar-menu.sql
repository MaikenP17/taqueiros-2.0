-- =============================================================
-- LOS TAQUEIROS 2.0 — Comprobar que el menu quedo bien
-- Ejecutar DESPUES de menu.sql, en el SQL Editor de Supabase.
-- Son consultas de solo lectura: no modifican nada.
-- =============================================================

-- 1) CUANTOS QUEDARON -----------------------------------------------
-- Deben salir 6 categorias y 38 productos.
select
  (select count(*) from public.categorias) as categorias,
  (select count(*) from public.productos)  as productos,
  (select count(*) from public.productos where disponible)     as disponibles,
  (select count(*) from public.productos where not disponible) as agotados;


-- 2) EL MENU COMPLETO, EN EL ORDEN EN QUE SE MOSTRARIA ---------------
select
  c.emoji || ' ' || c.nombre                       as categoria,
  p.nombre                                         as producto,
  '$' || to_char(p.precio, 'FM999G999')            as precio,
  case when p.disponible then 'sí' else 'AGOTADO' end as disponible
from public.productos p
join public.categorias c on c.id = p.categoria
order by c.orden, p.orden;


-- 3) TOTALES POR CATEGORIA -------------------------------------------
-- Sirve para cotejar de un vistazo contra el menu de index.html:
-- bandejas 10, con-birria 6, especiales 3, bebidas 4,
-- aguas-frescas 3, adiciones 12.
select c.orden, c.nombre as categoria, count(p.id) as productos
from public.categorias c
left join public.productos p on p.categoria = c.id
group by c.orden, c.nombre
order by c.orden;


-- 4) ERRORES QUE NO DEBERIAN APARECER --------------------------------
-- Cualquier fila aqui es un problema. Lo normal es que no devuelva nada.
select 'precio en cero o negativo' as problema, id, nombre
from public.productos where precio <= 0
union all
select 'sin nombre', id, coalesce(nombre, '(vacio)')
from public.productos where nombre is null or trim(nombre) = ''
union all
select 'categoria inexistente', p.id, p.nombre
from public.productos p
left join public.categorias c on c.id = p.categoria
where c.id is null;


-- 5) SUMA DE CONTROL DE LOS PRECIOS ----------------------------------
-- Un solo numero para comparar contra api/_precios.js sin revisar
-- producto por producto. Debe dar exactamente 586000.
select sum(precio) as suma_de_todos_los_precios from public.productos;
