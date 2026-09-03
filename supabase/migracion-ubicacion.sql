-- =============================================================
-- LOS TAQUEIROS 2.0 — Verificacion del punto de entrega
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- PARA QUE SIRVE
-- Un pin mal marcado hace que se cobre $5.000 de domicilio cuando
-- eran $12.000. Estas columnas guardan senales para que el panel
-- avise "verificar ubicacion" ANTES de despachar.
--
-- Seguro de re-ejecutar.
-- =============================================================

alter table public.pedidos
  -- Barrio que OpenStreetMap reporta para las coordenadas del pin.
  -- Se compara con el barrio que escribio el cliente: si no se
  -- parecen, el panel lo marca para revisar.
  -- Queda null si el geocodificador no responde (es mejor esfuerzo,
  -- nunca bloquea la creacion del pedido).
  add column if not exists barrio_detectado text,

  -- Motivo por el que el pedido quedo marcado para revisar.
  -- null = la ubicacion no levanta sospechas.
  add column if not exists ubicacion_sospechosa text;

-- Comprobacion
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'pedidos'
  and column_name in ('barrio_detectado','ubicacion_sospechosa')
order by column_name;
