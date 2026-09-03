-- =============================================================
-- LOS TAQUEIROS 2.0 — Salud del WhatsApp automatico
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- EL PROBLEMA
-- CallMeBot es un servicio gratuito de un particular. Ya se cayo una
-- vez. Si falla en silencio, el restaurante cree que le van a avisar
-- de los pedidos y no le avisan.
--
-- QUE HACE ESTO
-- Guarda como salio el ultimo envio. El panel lo lee y muestra un
-- aviso cuando el WhatsApp automatico no esta funcionando, para que
-- el restaurante sepa que en ese momento solo puede confiar en la
-- pantalla.
--
-- Seguro de re-ejecutar.
-- =============================================================

-- 1) MARCA POR PEDIDO ------------------------------------------------
-- Permite ver despues de que pedidos no se aviso.
alter table public.pedidos
  add column if not exists notificacion_ok boolean;


-- 2) ESTADO GLOBAL ---------------------------------------------------
create table if not exists public.salud_notificaciones (
  id              smallint primary key default 1,

  ultimo_intento  timestamptz,
  ultimo_ok       boolean,          -- salio bien el ultimo envio?
  ultimo_error    text,             -- que dijo el servicio si fallo
  fallos_seguidos integer not null default 0,

  constraint salud_una_sola_fila check (id = 1)
);

insert into public.salud_notificaciones (id, fallos_seguidos)
values (1, 0)
on conflict (id) do nothing;


-- 3) SEGURIDAD -------------------------------------------------------
-- El panel (personal autorizado) la lee. Escribirla es cosa del
-- servidor, que se salta RLS con la service_role key.
alter table public.salud_notificaciones enable row level security;

drop policy if exists "personal lee salud" on public.salud_notificaciones;
create policy "personal lee salud"
  on public.salud_notificaciones for select
  to authenticated
  using ( public.es_personal() );


-- 4) REALTIME --------------------------------------------------------
-- Para que el aviso del panel aparezca sin recargar.
do $$
begin
  alter publication supabase_realtime add table public.salud_notificaciones;
exception
  when duplicate_object then null;
end;
$$;


-- Comprobacion
select * from public.salud_notificaciones;
