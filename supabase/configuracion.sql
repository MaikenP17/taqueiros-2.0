-- =============================================================
-- LOS TAQUEIROS 2.0 — Configuracion del restaurante (horarios)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
--
-- PARA QUE SIRVE
-- Impedir que alguien pague a las 2 de la manana cuando no hay
-- nadie cocinando. El horario vive aqui (no en el codigo) para que
-- el dueno pueda cambiarlo desde el panel sin tocar nada.
--
-- Seguro de re-ejecutar: no borra ni pisa la configuracion que ya
-- exista.
-- =============================================================

create table if not exists public.configuracion (
  -- Tabla de una sola fila: siempre id = 1.
  id smallint primary key default 1,

  -- Horario por dia de la semana. El indice del arreglo coincide
  -- con Date.getDay() de JavaScript: 0 = domingo ... 6 = sabado.
  -- Formato de cada dia:
  --   { "dia": "Lunes", "abre": "11:00", "cierra": "22:00", "activo": true }
  -- 'activo' en false = ese dia no se abre (dia de descanso).
  horarios jsonb not null,

  -- Interruptor manual: cierra YA, sin importar el horario.
  -- Sirve para cuando se llenan de pedidos o cierran por algo.
  cerrado_temporal boolean not null default false,

  -- Mensaje que ve el cliente cuando esta cerrado. Si queda vacio,
  -- la pagina arma uno solo con la hora de apertura.
  mensaje_cerrado text,

  actualizado_en timestamptz not null default now(),

  -- Blindaje: impide que se creen mas filas por error.
  constraint configuracion_una_sola_fila check (id = 1)
);

-- Valores iniciales: todos los dias de 11:00 a 22:00.
-- El dueno los ajusta despues desde el panel.
insert into public.configuracion (id, horarios, cerrado_temporal, mensaje_cerrado)
values (
  1,
  '[
    {"dia":"Domingo",   "abre":"11:00","cierra":"22:00","activo":true},
    {"dia":"Lunes",     "abre":"11:00","cierra":"22:00","activo":true},
    {"dia":"Martes",    "abre":"11:00","cierra":"22:00","activo":true},
    {"dia":"Miércoles", "abre":"11:00","cierra":"22:00","activo":true},
    {"dia":"Jueves",    "abre":"11:00","cierra":"22:00","activo":true},
    {"dia":"Viernes",   "abre":"11:00","cierra":"22:00","activo":true},
    {"dia":"Sábado",    "abre":"11:00","cierra":"22:00","activo":true}
  ]'::jsonb,
  false,
  null
)
on conflict (id) do nothing;   -- si ya existe, se respeta lo configurado

-- actualizado_en se refresca solo (reutiliza el trigger que ya existe)
drop trigger if exists configuracion_actualizado_en on public.configuracion;
create trigger configuracion_actualizado_en
  before update on public.configuracion
  for each row execute function public.tocar_actualizado_en();


-- ---------------------------------------------------------------
-- SEGURIDAD (RLS)
-- Misma regla que la tabla de pedidos: solo el personal autorizado.
-- El cliente NO lee esta tabla directamente; se entera del horario
-- a traves de /api/estado, que corre en el servidor.
-- ---------------------------------------------------------------
alter table public.configuracion enable row level security;

drop policy if exists "personal lee configuracion" on public.configuracion;
create policy "personal lee configuracion"
  on public.configuracion for select
  to authenticated
  using ( public.es_personal() );

drop policy if exists "personal actualiza configuracion" on public.configuracion;
create policy "personal actualiza configuracion"
  on public.configuracion for update
  to authenticated
  using ( public.es_personal() )
  with check ( public.es_personal() );

-- Sin politica de INSERT ni DELETE: la fila es unica y ya existe.


-- ---------------------------------------------------------------
-- REALTIME
-- Para que si alguien cierra el local desde otro dispositivo, los
-- demas paneles lo vean al instante.
-- ---------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.configuracion;
exception
  when duplicate_object then null;
end;
$$;


-- ---------------------------------------------------------------
-- COMPROBACION
-- ---------------------------------------------------------------
select id, cerrado_temporal, jsonb_array_length(horarios) as dias_configurados
from public.configuracion;
