-- =============================================================
-- LOS TAQUEIROS 2.0 — Seguimiento publico del pedido
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- COMO SE RESUELVE LA SEGURIDAD
-- La pagina pedido.html es publica, asi que NO puede tener permiso
-- de leer la tabla 'pedidos' (eso expondria los datos de todos los
-- clientes). En vez de eso, se expone UNA SOLA funcion que:
--
--   * recibe una referencia exacta y devuelve como maximo 1 fila
--   * nunca devuelve telefono, correo ni datos de pago
--   * ignora los pedidos que no se han pagado
--
-- El RLS de la tabla queda EXACTAMENTE igual que antes: 'anon' sigue
-- sin poder hacer SELECT, INSERT ni UPDATE sobre 'pedidos'.
--
-- Por que no se puede adivinar una referencia ajena: tienen la forma
-- TAQ-<milisegundos>-<6 caracteres al azar>, o sea ~16 millones de
-- combinaciones por cada milisegundo exacto.
-- =============================================================

create or replace function public.seguimiento(ref text)
returns table (
  numero            bigint,
  referencia        text,
  estado            text,
  tipo_pedido       text,
  direccion         text,
  barrio            text,
  indicaciones      text,
  items             jsonb,
  subtotal          integer,
  costo_domicilio   integer,
  distancia_km      numeric,
  fuera_de_cobertura boolean,
  total             integer,
  creado_en         timestamptz,
  pagado_en         timestamptz
)
language sql
security definer          -- corre con permisos del dueño, se salta RLS
stable
set search_path = public
as $$
  select
    p.id,
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
  where p.referencia = ref          -- coincidencia exacta, nunca parcial
    and p.estado <> 'pendiente_pago' -- los no pagados no se muestran
  limit 1;
$$;

-- Nadie puede ejecutarla por defecto...
revoke all on function public.seguimiento(text) from public;

-- ...solo los visitantes de la pagina de seguimiento (anon) y el
-- personal ya autenticado.
grant execute on function public.seguimiento(text) to anon, authenticated;


-- ---------------------------------------------------------------
-- COMPROBACION
-- 1) Con una referencia real debe devolver 1 fila:
--      select * from public.seguimiento('TAQ-...');
-- 2) Con una inventada debe devolver 0 filas:
--      select * from public.seguimiento('TAQ-NO-EXISTE');
-- 3) La tabla sigue cerrada para anon (esto NO debe devolver datos
--    desde el navegador con la anon key):
--      select * from public.pedidos;
-- ---------------------------------------------------------------
