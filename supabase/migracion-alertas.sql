-- =============================================================
-- LOS TAQUEIROS 2.0 — Alerta de pedidos sin atender
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- PARA QUE SIRVE
-- Un pedido pagado que nadie ve es el peor escenario posible. Esta
-- columna marca los pedidos por los que YA se aviso al WhatsApp del
-- restaurante, para no mandar la misma alerta una y otra vez.
--
-- Seguro de re-ejecutar.
-- =============================================================

alter table public.pedidos
  add column if not exists alerta_enviada boolean not null default false;

-- El cron busca pedidos en estado 'nuevo' que todavia no se avisaron.
-- Este indice hace que esa consulta sea inmediata aunque crezca la
-- tabla, y solo ocupa espacio para las filas que interesan.
create index if not exists pedidos_pendientes_alerta_idx
  on public.pedidos (pagado_en)
  where estado = 'nuevo' and alerta_enviada = false;

-- Comprobacion
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'pedidos'
  and column_name = 'alerta_enviada';
