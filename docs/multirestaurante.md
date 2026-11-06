# Multi-restaurante: base de datos (SQL 10) y servidor (SQL 11 + api/)

Taqueiros 2.0 se va a vender como servicio: **una sola base de datos y un solo despliegue para muchos
restaurantes**, con aislamiento estricto de datos. Este documento describe la base ya preparada para eso
(`supabase/10-multirestaurante.sql`), qué había antes, qué decisiones se tomaron y cómo se verifica.

> **Alcance.** Las secciones 1 a 11 describen la base de datos y la seguridad (SQL 10, ya ejecutado y verificado
> en Supabase real). La **sección 12** describe el paso siguiente, ya hecho: el **servidor** (`api/*.js`) sabe de
> qué restaurante es cada petición, filtra siempre por él, usa sus propios secretos y respeta su estado de
> servicio (más `supabase/11-dominios.sql`). La **sección 14** es el paso después: el **frontend público**
> (`index.html`, `pedido.html`, manifest, número de pedido) lee los datos de cada restaurante en vez de llevar los de
> Taqueiros escritos (más `supabase/12-config-publica.sql`). La **sección 15** es el paso después: las páginas **privadas** del
> personal (`panel.html`, `menu-admin.html`, `historial.html`, el pie del ticket, `sw.js`) trabajan solo con el restaurante de su
> dominio, con la membresía verificada y con la marca del restaurante (sin SQL nuevo). La **sección 16** es el paso después: **endurecer la base**
> (`supabase/13-endurecer.sql`: sin valores por defecto de `restaurante_id`, `config` validada en la base, mínimo privilegio) y **mover las fotos de la raíz del bucket**
> (`migrar-fotos-raiz.mjs` + `14-retirar-regla-bucket.sql`). La **sección 17** es el paso después: **agrupar endpoints** (11 → 6 funciones de Vercel, sin cambiar ninguna URL), la **vista previa de enlaces por restaurante** y el formulario
> **"Datos de mi restaurante"** del dueño (`supabase/15-datos-restaurante.sql`, que además valida el horario). Sigue pendiente la interfaz del superadmin (17.9). La **sección 19** es el paso 3A de esa administración: la **base y el servidor del panel de superadmin** (`supabase/16-superadmin.sql`, `api/superadmin.js`), el ciclo de **vigencia** de cada restaurante, el horario con `24:00` y medianoche (`16b`) y el retiro de `?clave=` del cron; la pantalla es el 3B.

Contenido: 1. Inventario anterior · 2. Diseño nuevo · 3. Matriz de permisos · 4. Decisiones ·
5. Qué se conserva para no romper nada · 6. Orden de pasos en Windows · 7. Lo que queda para el siguiente paso ·
8. Qué se probó y qué no · 9. Riesgos · 10. Revisión de seguridad del SQL 10 · 11. Fallo `pg_statistic` ·
12. Servidor multi-restaurante (SQL 11 + api/) · 13. Revisión adversaria del servidor ·
14. Frontend público multi-restaurante (SQL 12) · 15. Paneles del personal por restaurante ·
16. Endurecer la base (SQL 13 y 14) y mover las fotos de la raíz ·
17. Agrupar endpoints, vista previa de enlaces y "Datos de mi restaurante" (SQL 15) · 18. Revisión adversaria de 2B-3, 2B-4 y 2B-5 ·
**19. Panel de superadmin: la base y el servidor (SQL 16, SQL 16b y `api/superadmin.js`)** · 20. Rebrand a The Northe Burgers (SQL 17) · 21. Propuesta de cambio de dominio · **22. Opciones de producto: quitar ingredientes y extras con precio (SQL 18, parte A)**

---

## 1. Inventario de lo que había (reconstruido del repo)

Reconstruido de `supabase/*.sql` y de todo el código que consulta la base. **El repo solo cuenta lo que se
escribió en archivos**: puede haber cosas creadas a mano en el dashboard. Para saberlo con certeza, corre
`supabase/00-inspeccion-esquema.sql` (solo lectura) antes de migrar.

### Tablas (schema `public`)

| Tabla | Para qué | Notas |
|---|---|---|
| `pedidos` | Cada pedido. `id` identity (es el número que ve el cliente y el panel), `referencia` única (`TAQ-<ms>-<hex>`), `estado`, datos del cliente, entrega, `items` jsonb, `subtotal`, `costo_domicilio`, `total`, pago (`estado_pago`, `wompi_*`), tiempos, domicilio (`distancia_km`, `lat`, `lng`, `fuera_de_cobertura`, `barrio_detectado`, `ubicacion_sospechosa`), `alerta_enviada`, `notificacion_ok`, `estado_cambiado_en`, y (SQL 02) `impreso_en`, `reimpresiones`, `reimpreso_en`. | RLS. En Realtime. Constraint `total = subtotal + costo_domicilio`. |
| `categorias` | Categorías del menú. `id` texto (PK), `nombre`, `emoji`, `orden`, `activa`. | RLS. Índice único por nombre normalizado (SQL 01). |
| `productos` | Productos. `id` texto (PK, el mismo que usa el carrito), `precio` entero, `categoria` (FK), `disponible`, `imagen`. | RLS. En Realtime. |
| `configuracion` | Una sola fila (`id = 1`): `horarios` jsonb, `cerrado_temporal`, `mensaje_cerrado`, `hora_corte_jornada` (5 a. m.), `minutos_ocultar_terminados`. | RLS. En Realtime. |
| `salud_notificaciones` | Una sola fila (`id = 1`): cómo salió el último WhatsApp automático. | RLS. En Realtime. |
| `personal` | Usuarios autorizados del panel (`id` → `auth.users`). | RLS sin políticas. **Ningún código la consulta**; solo `es_personal()`. |

No hay tabla de ítems de pedido (van en `pedidos.items`), ni de jornadas, resúmenes o historial: son **funciones**
que calculan sobre `pedidos`. Las tarifas de domicilio y las coordenadas del local están **en el código**
(`api/_domicilio.js` y `index.html`), no en la base.

### Funciones

| Función | Tipo | Quién la usa |
|---|---|---|
| `es_personal()` | SECURITY DEFINER | las políticas antiguas |
| `tocar_actualizado_en()`, `marcar_cambio_de_estado()` | trigger | `pedidos`, `productos`, `configuracion` |
| `proteger_campos_de_pago()` | trigger, **invoker a propósito** | bloquea cambios de dinero desde el navegador |
| `norm_texto()`, `validar_categoria()`, `validar_producto()` | helper / triggers (SQL 01) | menú-admin |
| `jornada_de(momento, corte)` | inmutable | jornada, historial |
| `limites_jornada(fecha)` | SECURITY DEFINER | `panel.html` |
| `resumen_jornada(fecha)`, `buscar_historial(...)`, `jornadas_con_pedidos(limite)` | SECURITY DEFINER | `historial.html` |
| `seguimiento(ref)` | SECURITY DEFINER, **anon** | `pedido.html` |
| `buscar_mis_pedidos(telefono, total)` | SECURITY DEFINER, **anon** | `index.html` |
| `limpiar_pedidos_huerfanos(horas)` | SECURITY DEFINER | cron `/api/keep-alive` (servidor) |
| `reclamar_impresion(id)`, `registrar_reimpresion(id)` | invoker (SQL 02) | `panel.html` |

### Políticas RLS (antes)

* `pedidos`: `personal lee pedidos`, `personal actualiza pedidos` (con `es_personal()`).
* `categorias` / `productos`: lectura para **anon y authenticated** (`using (true)`) + `personal edita ...`.
* `configuracion`: `personal lee / actualiza configuracion`. `salud_notificaciones`: `personal lee salud`.
* `personal`: RLS activo y sin políticas.

### Storage y Realtime

* Bucket `productos` (SQL 01): público, 2 MB, webp/jpeg/png. Cuatro políticas `productos personal sube / ve /
  reemplaza / borra` con `es_personal()`. Las fotos nuevas se suben **planas** (`p-<hex>.<ext>`); las 38 de
  origen son rutas relativas `Recursos/...` del propio sitio (no están en el bucket).
* Publicación `supabase_realtime`: `pedidos`, `productos`, `configuracion`, `salud_notificaciones`. El panel
  escucha `pedidos`, `salud_notificaciones` y `configuracion`.

### Acceso `anon` que existía

1. Lectura directa de `categorias` y `productos` (políticas `using (true)`). **Ninguna página la usa**: el sitio
   lee el menú por `/api/menu` (servidor, llave secreta).
2. Las RPC `seguimiento` y `buscar_mis_pedidos` (esas dos sí las usa el sitio).
3. **Probable, a verificar:** en Supabase, `revoke ... from public` no le quita el permiso de ejecución a `anon`
   (las funciones nuevas se le otorgan por defecto). `limites_jornada`, `resumen_jornada`, `buscar_historial`,
   `jornadas_con_pedidos` y `limpiar_pedidos_huerfanos` solo revocaban a `public`. La sección
   `funciones_que_anon_ejecuta` de la inspección lo confirma o lo descarta.

### Hallazgos de seguridad en lo que había (se cierran con el SQL 10)

* `resumen_jornada`, `buscar_historial` y `jornadas_con_pedidos` eran **SECURITY DEFINER sin comprobar quién
  llamaba** y con `EXECUTE` para `authenticated`. Con el registro público de Auth abierto, **cualquier persona con
  una cuenta recién creada podía leer nombre, teléfono y dirección de todos los clientes** (`buscar_historial`).
  Esto es independiente de multi-restaurante y está abierto en producción hasta correr el SQL 10.
* En `buscar_historial` el filtro por `referencia` nunca filtraba (el parámetro se llamaba igual que la columna y
  la columna ganaba). Ahora funciona.

### Lo que no se puede deducir del repo

Ver la sección 8 y el debrief: tablas/funciones/políticas creadas a mano, si los SQL 01 y 02 ya se corrieron,
los permisos por defecto reales de Supabase, y si hay algo más en el bucket.

---

## 2. Diseño nuevo

### Tablas nuevas (todas con RLS)

| Tabla | Contenido |
|---|---|
| `restaurantes` | `id`, `slug` único (minúsculas, números y guiones; sirve para subdominio), `nombre`, `estado` (`prueba`/`activo`/`suspendido`), `plan` (`completo`/`basico`/`comandas`), `modalidad_pago` (`mensual`/`unico`), `vigente_hasta` (nulo = sin vencimiento), `dias_gracia` (5), `modulos` jsonb (`pasarela`, `seguimiento`, `comandas`, `impresion`, todos activos), `zona_horaria` (`America/Bogota`), `hora_corte_jornada` (5 a. m.), `config` jsonb (vacío; el siguiente paso lo llena), `creado_en`. **Ninguna lógica usa plan, módulos, estado ni vigencia todavía.** |
| `restaurante_secretos` | Una fila por restaurante con las llaves de Wompi (publica/integridad/eventos, test y prod), CallMeBot (teléfono y apikey) y `otros` jsonb. **Sin políticas y sin privilegios para `anon` ni `authenticated`**: solo el servidor. Hoy esos valores viven en variables de entorno de Vercel; el siguiente paso los pasa aquí. Quedó vacía. |
| `miembros` | `(user_id, restaurante_id)` PK, `rol` (`dueno`/`cajero`/`cocina`), `activo`. Lo de `personal` pasó aquí como `dueno` de Taqueiros. |
| `superadmins` | `user_id`. Solo para Carlos. **No se agregó a nadie**: hay un `INSERT` comentado en el SQL. |
| `contadores_pedido` | Contador atómico del número de pedido por restaurante. |
| `tarifas_domicilio` | `(restaurante_id, hasta km, precio)`; `precio` nulo = fuera de cobertura. Cargada con las 5 tarifas del código (2 km $5.000 · 4 km $7.000 · 6 km $9.000 · 8 km $12.000 · +8 km fuera de cobertura). El código **sigue leyendo las suyas**. |

Taqueiros es el restaurante #1: `id = 00000000-0000-4000-8000-000000000001`, slug `taqueiros`, estado `activo`.

### `restaurante_id` en las tablas de negocio

`pedidos`, `categorias`, `productos`, `configuracion` y `salud_notificaciones` (más `tarifas_domicilio` y
`restaurante_secretos`, nuevas). Para las existentes:

* `NOT NULL`, con **valor por defecto transitorio** `restaurante_taqueiros_id()` y FK a `restaurantes`. Las filas
  existentes quedan en Taqueiros **sin ejecutar ningún UPDATE** (ni triggers, ni cambio de `actualizado_en`, ni
  eventos de Realtime).
* Índices: `pedidos (restaurante_id, creado_en desc)`, `(restaurante_id, estado)`, el parcial de alertas por
  restaurante, `categorias (restaurante_id, orden)`, `productos (restaurante_id, categoria, orden)`.
* **Únicos por restaurante:** PK de `categorias` y `productos` pasa a `(restaurante_id, id)`; `productos.categoria`
  es una FK compuesta `(restaurante_id, categoria)`, así un producto **no puede apuntar a una categoría de otro
  restaurante**; el nombre de categoría único (sin mayúsculas ni tildes) es por restaurante.
* `configuracion` y `salud_notificaciones`: la PK pasa a `restaurante_id` (una fila por restaurante). La columna
  `id` **se conserva**: Taqueiros sigue siendo `id = 1` (el código actual consulta `id=eq.1`); los demás
  restaurantes usan `id = 0`, de modo que esas consultas jamás se cruzan con otro restaurante.
* El **alta de un restaurante es automática** (trigger): crea su fila de secretos, contador, configuración
  (horario 11:00–22:00 todos los días) y salud.
* Un registro **no puede cambiar de restaurante** desde el navegador (trigger `*_restaurante_inmutable`).

### Número de pedido por restaurante

`pedidos.numero` + `contadores_pedido`. `siguiente_numero_pedido(restaurante)` hace
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`: dos pedidos simultáneos del mismo restaurante se ponen en fila
sobre la fila del contador y nunca reciben el mismo número. Un trigger lo asigna al insertar; **un cliente no
puede elegir su número**. Para Taqueiros: `numero = id` en todos los pedidos existentes (no cambia ninguno), y el
contador arranca en `max(numero, id, última_secuencia)`, así el siguiente continúa después del último. Mientras
el código siga mostrando `id`, número e id coinciden salvo que se pierda algún id por una inserción fallida
(ver riesgos). Único por `(restaurante_id, numero)`.

`pedidos.reembolsado_en` (timestamptz, nula) quedó creada y protegida contra edición desde el navegador; ningún
código la usa aún.

### Funciones auxiliares de seguridad

`es_superadmin()`, `es_miembro(restaurante_id)`, `rol_en(restaurante_id)` (más `restaurante_actual()` y
`es_servidor()`): `STABLE`, **sin SECURITY DEFINER** (leen `miembros`/`superadmins` con la identidad de quien
pregunta, y esas tablas solo le muestran **sus** filas), `search_path` vacío, nombres calificados, sin `EXECUTE`
para `PUBLIC` ni `anon`, con `EXECUTE` para `authenticated`. En las políticas se usa `(select función(...))`.

`SECURITY DEFINER` solo donde es indispensable, todas con `search_path` vacío: `siguiente_numero_pedido`,
`asignar_numero_pedido` y `aprovisionar_restaurante` (tocan tablas sin política para clientes),
`config_jornada` (verifica la membresía antes de leer la configuración), `buscar_mis_pedidos`, `seguimiento` y
`limpiar_pedidos_huerfanos` (las dos primeras son las puertas públicas, la última solo el servidor) y
`realinear_secuencia_pedidos` (solo el servidor).

### Impresión

`reclamar_impresion` y `registrar_reimpresion` **siguen sin ser SECURITY DEFINER**. Ahora además buscan el pedido
(RLS: solo ve los de su restaurante) y exigen que el usuario sea miembro de ese restaurante con rol dueño, cajero
o cocina; si no, `42501 No autorizado`. La lógica de impresión no cambió.

### Historial, jornada y resumen

Pasaron de DEFINER sin control a **funciones de quien llama** (RLS filtra a su restaurante). Reciben un parámetro
opcional `p_restaurante`; sin él usan el restaurante de la membresía del usuario, así que **el panel actual no
cambia nada**. Si alguien pide un restaurante que no es suyo recibe vacío/`null`.

### Las dos puertas públicas

`seguimiento(ref)` no cambia: referencia exacta (`TAQ-<ms>-<6 hex>`, imposible de adivinar), una fila, sin teléfono ni
correo. `buscar_mis_pedidos(telefono, total)` se acota a un restaurante y tiene **límite de intentos**: 10 consultas por
(restaurante, celular) en 24 h, guardadas en `intentos_buscar_pedido` (sin acceso para clientes). Pasado el límite
responde vacío, que el sitio ya muestra como “No encontramos pedidos”. Sin el límite, quien conoce un celular
probaba totales (pocas centenas de valores) hasta dar con la referencia y `seguimiento` le entregaba la dirección.

### Lo que la migración se niega a dejar pasar

Además de las comprobaciones de tablas y políticas, el SQL 10 se detiene (y revierte) si encuentra en `public`:
una función `SECURITY DEFINER` que no conoce y que `anon` o `authenticated` pueden llamar (aunque sea de otro dueño
y no la pueda revocar), una vista sin `security_invoker` legible por clientes, o un trigger en `auth.users` que
escriba en `personal`, `miembros` o `superadmins` (daría membresía automática a cada cuenta nueva). Además borra
**todas** las firmas de las funciones que reemplaza, y al confirmar avisa a PostgREST que recargue su esquema.

### Storage (fotos)

Rutas nuevas: `{restaurante_id}/archivo`. Políticas: solo un miembro con rol **dueño** (o superadmin) escribe,
reemplaza, lista y borra **dentro de su carpeta**; se rechaza `..`; la lectura sigue pública (bucket público).
`validar_producto` exige que la foto de un producto apunte a la carpeta de **su** restaurante.

**Las fotos existentes no se movieron**: están en la raíz del bucket y sus URLs están guardadas en
`productos.imagen`; mover archivos con SQL no mueve el archivo físico y rompería las URLs. Regla transitoria: la
raíz solo la escribe el dueño de Taqueiros (para que `menu-admin.html` siga subiendo fotos planas). Se retira en
el siguiente paso.

### Realtime

Las cuatro tablas siguen publicadas. Los eventos `INSERT`/`UPDATE` respetan RLS: cada sesión solo recibe filas que
su política de lectura le deja ver (se verifica con sesiones reales en `probar-aislamiento.mjs`). Ver el riesgo
sobre eventos `DELETE` en la sección 9.

---

## 3. Matriz de permisos

`—` = sin acceso. “Servidor” = llave secreta (Vercel, scripts). El superadmin tiene acceso a todo menos a
`restaurante_secretos` y `contadores_pedido`, que solo ve el servidor.

| Recurso | dueño | cajero | cocina | superadmin | anon |
|---|---|---|---|---|---|
| `pedidos` | leer, crear, actualizar, borrar **solo los no cobrados** | leer, crear, actualizar | leer; cambiar **solo el estado** (y marcas de impresión) | todo | — |
| `categorias`, `productos` | todo | leer | — | todo | — |
| `configuracion` | leer, actualizar | leer | — | todo (crear/borrar solo él) | — |
| `salud_notificaciones` | leer | leer | — | todo | — |
| `tarifas_domicilio` | todo | leer | — | todo | — |
| `restaurantes` | leer el suyo; editar `nombre` y `config` | leer el suyo | leer el suyo | todo | — |
| `miembros` | ver su propia fila | ídem | ídem | todo | — |
| `superadmins` | — (cada quien ve solo su fila) | — | — | su propia fila | — |
| `restaurante_secretos`, `contadores_pedido`, `intentos_buscar_pedido` | — | — | — | — | — |
| Fotos (Storage) | escribir/listar/borrar en su carpeta | — | — | todo | solo lectura pública |
| `reclamar_impresion`, `registrar_reimpresion` | su restaurante | su restaurante | su restaurante | todo | — |
| `resumen_jornada`, `buscar_historial`, `jornadas_con_pedidos`, `limites_jornada` | su restaurante | su restaurante | su restaurante | todo | — |
| `seguimiento(ref)`, `buscar_mis_pedidos(...)` | sí | sí | sí | sí | **sí** (únicas puertas públicas; la búsqueda admite 10 consultas por celular y restaurante cada 24 h) |
| `limpiar_pedidos_huerfanos`, `siguiente_numero_pedido`, `realinear_secuencia_pedidos` | — | — | — | — | — (solo servidor) |

Capas extra que no son RLS: triggers que impiden cambiar dinero/`numero`/`reembolsado_en` desde el navegador,
que el dueño cambie plan/estado/vigencia/módulos/slug, que cocina edite algo que no sea el estado, y que
cualquier registro cambie de restaurante.

---

## 4. Decisiones tomadas

1. **Slug con guiones, no guion bajo.** El slug se usará como subdominio y los hostnames no admiten `_`. Los
   restaurantes de prueba usan el prefijo `test-` (no `test_`), más el nombre `PRUEBA-AISLAMIENTO ...` para no
   confundirse nunca con uno real al limpiar.
2. **`anon` ya no toca ninguna tabla.** Se quitó la lectura pública directa de `categorias`/`productos` porque
   ninguna página la usa (el menú sale de `/api/menu`). Quedan dos funciones públicas, acotadas: `seguimiento`
   (referencia exacta, una fila, sin teléfono ni correo) y `buscar_mis_pedidos` (ahora **acotada a un
   restaurante**; por defecto Taqueiros mientras el sitio no mande el restaurante; teléfono + total exacto,
   últimas 24 h, máx. 5 filas). Además se revocó `EXECUTE` a `anon` en **todas** las demás funciones de `public`.
3. **Dueño borra pedidos solo si nunca se cobraron.** La matriz dice “todo”, pero hoy nadie borra pedidos desde el
   navegador a propósito (el historial se conserva). Se mantiene esa garantía.
4. **`configuracion` y `salud`: crear/borrar solo superadmin/servidor.** La fila la crea el alta del restaurante;
   que un dueño pudiera borrarla dejaría el local sin horario. El dueño sí actualiza la configuración.
5. **El dueño edita `nombre` y `config` de su restaurante, no el resto.** Plan, estado, vigencia, módulos, slug,
   zona y hora de corte son comerciales: los cambia Carlos (servidor/superadmin). Se hace con un trigger.
6. **Cocina cambia el estado y nada más** (más las columnas de impresión, porque el PC de la cocina imprime). Un
   trigger lo impone a nivel de columna; RLS por sí sola no puede.
7. **UUID fijo para Taqueiros** y `restaurante_taqueiros_id()` como función constante: el valor por defecto
   transitorio no depende de ninguna tabla.
8. **`personal` se conserva** como tabla legada (no se borra nada). Como ningún código la consulta, no hace falta
   la vista de compatibilidad; en su lugar un trigger refleja en `miembros` lo que se agregue o quite allá. Si algún
   día se agrega “a mano” a alguien como se documentaba antes, sigue funcionando. `es_personal()` se conserva: ahora
   significa “miembro activo de algún restaurante”.
9. **Hora de corte de la jornada:** `restaurantes.hora_corte_jornada` quedó con el valor actual (copia, para el
   siguiente paso), pero las funciones siguen leyendo `configuracion.hora_corte_jornada`, que es la fuente de hoy.
   La zona horaria sigue fija en `America/Bogota` dentro de `jornada_de` (`restaurantes.zona_horaria` no se usa).
10. **`SQL 01` y `SQL 02` quedan absorbidos.** El SQL 10 crea el bucket y las validaciones del 01 y las columnas y
    funciones de impresión del 02 si faltan (con el mismo criterio: los pedidos pagados que ya existían se dan por
    impresos, y sin UPDATE). No hace falta correrlos antes, pero tampoco hay que correrlos **después**.
11. **Secretos por restaurante en columnas** (no en un jsonb único) para que cada llave tenga nombre y se pueda
    auditar. Quedan en texto en la tabla (protegida por RLS sin políticas): ver riesgos.
12. **`realinear_secuencia_pedidos()`**: borrar pedidos de prueba consume ids de la secuencia y el panel actual
    muestra el `id`. Esta función (solo servidor) deja la secuencia en el último id real; la prueba de aislamiento
    la llama al terminar, y solo si no entró ningún pedido real mientras tanto.
13. **Una sola migración atómica con verificación que revierte.** Si cualquiera de las 34 comprobaciones falla,
    toda la transacción se revierte y el error lista cuáles.

---

## 5. Qué se conserva para no romper nada

| Código actual | Cómo sigue funcionando |
|---|---|
| `crear-pedido` / `webhook` / `alertas` / crons (llave secreta) | Insertan sin `restaurante_id` ni `numero`: el defecto transitorio los deja en Taqueiros y el trigger asigna el número. La llave secreta se salta RLS. |
| `/api/estado`, `/api/menu`, `/api/disponibilidad`, validación de precios | Mismas columnas y mismas consultas; `configuracion?id=eq.1` y `salud_notificaciones?id=eq.1` siguen devolviendo una sola fila. |
| `panel.html` | Mismas consultas; el usuario existente es `dueno` de Taqueiros. `limites_jornada()` sin parámetros, `reclamar_impresion`, Realtime: sin cambios. |
| `menu-admin.html` | Inserta categorías y productos sin `restaurante_id` (queda Taqueiros), sube fotos planas a la raíz (regla transitoria), `update/delete ... eq("id")` funcionan. |
| `historial.html` | `resumen_jornada({fecha})`, `jornadas_con_pedidos({limite})`, `buscar_historial({...})` con los mismos nombres de parámetro. |
| `index.html` / `pedido.html` | `buscar_mis_pedidos(telefono, total_pagado)` y `seguimiento(ref)` con los mismos argumentos. |

**Scripts antiguos que ya no aplican:** `supabase/probar-menu-rls.js` y `supabase/probar-publishable.mjs` esperan que
`anon` pueda **leer** el menú directo y fallarán esa parte; es el comportamiento que se quitó a propósito. No se
modificaron para que los commits solo agreguen archivos.

---

## 6. Orden de pasos en Windows

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. La llave secreta (`sb_secret_...`, Supabase → Project
Settings → API Keys) se pide con `Read-Host` y **no se muestra al pegarla**: pégala **UNA sola vez** (clic derecho
**o** Ctrl+V, nunca ambos). Si se pega dos veces, los scripts lo detectan y no hacen nada.

> Los pasos del **servidor** (SQL 11, cargar secretos, pruebas de la API) están en la sección 12.9.

**0. Una sola vez:** `npm i --no-save @supabase/supabase-js@2.117.2` (para la prueba de Realtime).

**0b. Urgente, hoy mismo (antes de todo lo demás).** La inspección mostró que `anon` puede ejecutar
`limpiar_pedidos_huerfanos`: cualquiera sin sesión puede llamarla con `horas = 0` y borrar los pedidos que un
cliente está pagando en ese momento (el webhook de Wompi ya no los encuentra y el pedido pagado nunca llega a la
cocina). El SQL 10 lo cierra, pero mientras tanto ejecuta en el SQL Editor solo esta línea (el servidor usa la llave
secreta y sigue funcionando):

```sql
revoke execute on function public.limpiar_pedidos_huerfanos(integer) from public, anon, authenticated;
```

**1. Inspección (solo lectura).** Supabase → SQL Editor → New query → pega el contenido de
`supabase/00-inspeccion-esquema.sql` → Run. Revisa (o pégame) las filas `tablas_sin_restaurante_id`,
`funciones_que_anon_ejecuta`, `funciones_security_definer`, `firmas_repetidas`, `triggers_en_auth_users`,
`politicas_public`, `politicas_storage` y `sql_pendientes`, y las filas nuevas `objetos_fuera_de_public_con_permisos`,
`catalogo_pg_catalog_con_permisos`, `objetos_de_extensiones_en_public` y `permiso_storage_objects` (sección 11). Si aparece una tabla que
no sea `personal` en `tablas_sin_restaurante_id`, **avísame antes de seguir**.

**2. Respaldo (antes del SQL).**

```powershell
cd "D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0"
$k = Read-Host "Pega la llave SECRETA UNA sola vez (clic derecho O Ctrl+V, no ambos)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/exportar-respaldo.mjs
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Imprime las filas exportadas por tabla y deja todo en `respaldos\<fecha>\` (ignorada por git). Guarda esa carpeta
**fuera** del repositorio: tiene datos de clientes. Si dice “NO coincide” o sale con error, no sigas.

**3. SQL de migración.** En VS Code abre `supabase/10-multirestaurante.sql` → **Ctrl+A, Ctrl+C** (el contenido,
no el nombre del archivo) → SQL Editor → New query → pega → Run. Resultado esperado: una tabla de **34 filas, todas
`OK`**. Si algo falla verás el error con la lista de comprobaciones que fallaron y **no se cambió nada** (todo va en
una transacción). Se puede volver a correr sin dañar nada.

**4. Compatibilidad del código actual (solo lectura).**

```powershell
$k = Read-Host "Pega la llave SECRETA UNA sola vez (clic derecho O Ctrl+V, no ambos)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs
```

**5. Pruebas de aislamiento** (elige un momento tranquilo: durante 1–2 minutos existen categorías y productos de
prueba, apagados, que `/api/menu` devolvería si alguien lo consulta; se borran al terminar).

```powershell
# Reutiliza la variable del paso 4, o vuelve a pedirla:
$k = Read-Host "Pega la llave SECRETA UNA sola vez (clic derecho O Ctrl+V, no ambos)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
# La llave publishable ya esta en supabase-publico.js; solo si quieres usar otra:
# $env:SUPABASE_PUBLISHABLE_KEY = Read-Host "Llave publishable (sb_publishable_...)"
node supabase/probar-aislamiento.mjs
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Imprime PASA/FALLA por prueba, borra todo lo que creó (también si falla o lo interrumpes con Ctrl+C), realinea la
secuencia de ids y sale con código distinto de cero si algo falla. Si dice que no pudo limpiar, vuelve a correrlo:
al empezar barre los restos.

**6. Tests del repo (no tocan la base real).**

```powershell
node --test pruebas/*.test.js          # unitarios (64)
node pruebas/impresion/e2e.js          # panel con Supabase simulado (~3 min, 173 comprobaciones)
```

**7. Recorrido a mano (lo único que ninguna prueba automática reemplaza).** Con la cuenta real del panel:
abrir `panel.html` e iniciar sesión → se ven los pedidos de la jornada · cambiar un pedido de estado ·
interruptor Abierto/Cerrado y volver a abrir · `menu-admin.html`: apagar y volver a prender un producto, subir
una foto de prueba y borrarla · `historial.html`: elegir una fecha y buscar por teléfono · y **un pedido de prueba
completo por el sitio con Wompi en modo test** (aparece en el panel, suena, imprime, y el número es el siguiente
al último).

**8. Superadmin (cuando quieras).** Authentication → Users → copia tu UID. En el SQL Editor ejecuta solo:
`insert into public.superadmins (user_id) values ('TU-UID');`. Activa 2FA en esa cuenta: ve los datos de todos
los clientes.

---

## 7. Lo que queda para el siguiente paso (no se hizo a propósito)

* ~~Quitar `default restaurante_taqueiros_id()` de las columnas `restaurante_id`~~ **Hecho en la sección 16 (SQL 13)**; la función se conserva hasta que desaparezca la tabla legada `personal`.
* API y front multi-restaurante: resolver el restaurante por slug/subdominio; `api/*.js` filtran por
  `restaurante_id`; llaves de Wompi/CallMeBot desde `restaurante_secretos`; tarifas y coordenadas desde
  `tarifas_domicilio` y `restaurantes.config`; el sitio manda `p_restaurante` a `buscar_mis_pedidos`; mostrar
  `numero` en lugar de `id` en panel, ticket, seguimiento y alertas.
* ~~Retirar la regla transitoria de Storage (raíz del bucket)~~ **Hecho en la sección 16** (`migrar-fotos-raiz.mjs` + SQL 14); las fotos nuevas ya van a `{restaurante_id}/` desde la sección 15.
* Aplicar estado/vigencia/plan/módulos (hoy son solo estructura) y `restaurantes.zona_horaria`.
* Alta de miembros y de restaurantes desde un endpoint del servidor (hoy se hace con la llave secreta o SQL).
* ~~`crear-pedido`, webhook y alertas aún no son multi-restaurante~~ **Hecho** (sección 12): el servidor ya filtra
  por restaurante en todos sus endpoints. ~~Las páginas públicas~~ **Hecho** (sección 14: marca, textos, tarifas, llave de
  pago, manifest y número de pedido). ~~El panel~~ **Hecho** (sección 15: panel, menú, historial, ticket y `sw.js` por restaurante, con
  membresía verificada). Lo que sigue pendiente es la **administración** (formulario de configuración, superadmin, 15.11) y retirar los
  valores por defecto transitorios y la regla del bucket.

---

## 8. Qué se probó y qué no

**Probado por mí, en un Postgres 16 local (PGlite) que imita a Supabase** (roles `anon`/`authenticated`/
`service_role`, `auth.uid()`, Storage con `foldername`, publicación Realtime), aplicando primero **todos los SQL
antiguos del repo** (con y sin el 01 y el 02) y luego el 10:

* El SQL 10 corre dos veces seguidas sin error (idempotente) y las 34 comprobaciones dan OK, en los dos escenarios.
* 234 comprobaciones de aislamiento con roles reales y RLS: lectura/inserción/actualización/borrado entre
  restaurantes en cada tabla, cada rol de la matriz, `restaurante_id` ajeno y por defecto, `anon`, sin
  membresía, escalada de privilegios (membresías, superadmins), secretos, impresión, historial, Storage por
  carpeta, números de pedido por restaurante, y lo que hacen el panel, `menu-admin` y el servidor con las mismas
  sentencias que usa el código actual; también `UPDATE`/`DELETE` sin `WHERE`, `upsert` contra filas ajenas y un
  usuario dueño de dos restaurantes.
* 32 pruebas de los hallazgos de la revisión de seguridad y de la visibilidad de errores (`hallazgos.mjs`,
  secciones 10 y 11): 11 fallan con el SQL del commit 43b6567 y las 32 pasan con el corregido.
* `planes.mjs`: el SQL 10 bajo 8 planes distintos del optimizador sobre un simulador que ya se parece a Supabase
  (esquemas `extensions`, `graphql`, `vault`, `realtime`, objetos de `supabase_admin` y de una extensión, permisos
  sobre `pg_catalog`, catálogo grande): con el SQL del commit ac2bab2 fallan 6 de 8 (el error de la sección 11);
  con el corregido pasan los 8, y un lint estático prohíbe volver a armar nombres de relación a mano.
* Revisión por mutación (`mutaciones.mjs`): ver el resultado al final de la sección 10.
* `probar-aislamiento.mjs` completo, contra un servidor falso con la misma lógica de PostgREST/Auth/Storage sobre
  esa base: 227 de 234 pasan; las 7 que no pasan son todas de **Realtime**, que el falso no emula.
* `probar-compatibilidad.mjs` (ejecuta los manejadores reales `api/menu.js`, `estado.js`, `disponibilidad.js` y
  `_precios.js` sin modificarlos): 17/17.
* `exportar-respaldo.mjs`: paginación probada con 2.503 filas y tope de 1.000 por página; detección de pegado doble.
* Tests existentes: 64 unitarios y 173 comprobaciones del e2e del panel, sin cambios.

Todo lo anterior se puede **repetir** (por ejemplo cuando el siguiente paso cambie políticas o funciones) con el
arnés de `pruebas/multirestaurante/` (necesita `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2`):

```powershell
node pruebas/multirestaurante/sim.mjs                 # SQL antiguos + SQL 10 dos veces (34 comprobaciones)
node pruebas/multirestaurante/sim.mjs conPendientes   # igual, con el 01 y el 02 ya corridos
node pruebas/multirestaurante/rls.mjs                 # 234 comprobaciones de aislamiento a nivel SQL
node pruebas/multirestaurante/hallazgos.mjs           # 32 pruebas de los hallazgos de la revision
node pruebas/multirestaurante/planes.mjs              # el SQL bajo 8 planes del optimizador + lint (11 pruebas)
# cualquier suite acepta SQL10_PLAN=sin-nestloop (u otro plan de sim.mjs) para correr bajo ese plan
node pruebas/multirestaurante/mutaciones.mjs          # rompe cada defensa y exige que algo lo detecte (~25 min)
node pruebas/multirestaurante/contra-falso.mjs probar-aislamiento.mjs      # (Realtime falla aqui: no se emula)
node pruebas/multirestaurante/contra-falso.mjs probar-compatibilidad.mjs
```

El falso (`fake-supabase.mjs`) no es PostgREST: cubre lo que usan los scripts (filtros `eq/in/like/is`, insertar,
actualizar, borrar, `rpc`, Auth y Storage) y aplica los roles y RLS igual por petición, pero **no** reproduce los
códigos de error exactos ni los límites reales de Supabase; por eso no sustituye la corrida real.

**Solo se pueden correr contra la base real (pendiente de Carlos):** el SQL 10 sobre el esquema verdadero (por si
hay objetos que el repo no conoce); `probar-aislamiento.mjs` con PostgREST, Auth y Storage reales (códigos HTTP
reales, límites de tamaño/MIME del bucket, política de `storage.objects` con el dueño real de la tabla);
**Realtime con sesiones reales** (que el evento de B no llegue a A); los permisos por defecto reales de Supabase
sobre funciones; si `postgres` puede crear políticas sobre `storage.objects` (si no, el SQL 10 se revierte con
“must be owner”: el SQL 10 lo prueba de verdad y lo dice con el mensaje `MR paso 10 (Storage)`; la inspección muestra la evidencia en `permiso_storage_objects`); el límite de intentos de
`buscar_mis_pedidos` a través del PostgREST real; el recorrido a mano del panel; y un pedido real con Wompi.

---

## 9. Riesgos

1. **El esquema real puede tener objetos que el repo no conoce.** El SQL 10 se detiene (y revierte) si encuentra
   una tabla de `public` sin `restaurante_id` o una función/política que no esperaba; la inspección previa lo
   anticipa.
2. ~~**El servidor aún no es multi-restaurante.**~~ **Resuelto en la sección 12**: `/api/menu`, la validación de
   precios, los cobros y las alertas filtran por restaurante (probado con la batería local y la revisión por mutación).
   Lo que no está resuelto es el front (sección 12.10).
3. **Huecos en los ids.** Cada inserción fallida (también las rechazadas por RLS en las pruebas) consume un id de la
   secuencia. Mientras el código muestre `id`, el panel puede saltar números; `numero` (contador) no salta. La
   prueba realinea la secuencia. En el siguiente paso, mostrar `numero`.
4. **Valor por defecto transitorio:** cualquier código nuevo que olvide `restaurante_id` caería en Taqueiros sin
   avisar. Por eso se retira en el siguiente paso.
5. **Realtime y `DELETE` (aceptado por ahora).** Supabase no aplica RLS a los eventos de borrado: cualquier sesión
   suscrita a una tabla publicada recibe la **llave primaria** de las filas borradas de cualquier restaurante (nunca
   nombre, teléfono ni dirección). Hoy eso es: el `id` de los pedidos sin pagar que borra la limpieza diaria y del
   que borre un dueño, y `(restaurante_id, id)` de los productos borrados (el id es el slug del producto). Se acepta
   porque no expone datos personales y ningún cliente real convive aún. Mitigación mínima para el siguiente paso:
   pasar el panel a canales **privados de Broadcast por restaurante** (`realtime.broadcast_changes` + políticas en
   `realtime.messages`) y sacar `pedidos` y `productos` de la publicación `supabase_realtime`. No está cubierto por
   la prueba.
6. **Secretos en texto en la base.** Protegidos por RLS sin políticas y revocados a clientes, pero visibles para
   quien tenga la llave secreta o acceso al panel de Supabase. Más adelante conviene Supabase Vault o cifrado.
7. **Registro público de Auth:** ya se desactivó. Aunque se reactivara, una cuenta sin membresía no ve ni escribe
   nada (probado), salvo que exista un trigger en `auth.users` que la meta en `personal`/`miembros`: el SQL 10 se
   niega a correr si lo encuentra.
8. **Superadmin = acceso a todos los clientes.** Agrégalo solo cuando lo necesites y con 2FA.
9. **No vuelvas a correr los SQL antiguos** después del 10: recrearían políticas y funciones de un solo restaurante.
10. **Alertas por WhatsApp entre restaurantes (resuelto en la sección 12).** *Descripción del riesgo original:* `/api/alertas` (llave secreta)
    busca pedidos `nuevo` sin avisar de **todos** los restaurantes y avisa al WhatsApp de Taqueiros. Cuando exista un
    segundo restaurante, un dueño o cajero suyo puede crear pedidos (con `alerta_enviada = false`) que terminen como
    mensajes en el WhatsApp de Taqueiros. Hoy no hay otros restaurantes; la API debe filtrar por restaurante y usar
    el CallMeBot de cada uno.
11. **Límite de la búsqueda pública:** es por celular; alguien puede gastar los 10 intentos de un celular ajeno y
    el cliente real quedaría sin buscar ese día (puede abrir su enlace de seguimiento). No frena a quien prueba
    muchos celulares distintos, pero sin el celular correcto no hay nada que encontrar.
12. **Pendientes anteriores que esto no resuelve:** la llave `service_role` legacy que estuvo en el historial del
    repo público (hay que rotarla si no se hizo) y la impresora física nunca probada de punta a punta.

---

## 10. Revisión de seguridad del SQL 10 (antes de correrlo)

Revisión independiente con mentalidad de atacante (dueño o cajero de otro restaurante, cuenta sin membresía,
`anon` con la llave publishable). Cada hallazgo tiene una prueba en `pruebas/multirestaurante/hallazgos.mjs`
que **falla con el SQL del commit 43b6567 y pasa con el corregido**.

| # | Gravedad | Hallazgo | Cómo se explotaba | Corrección |
|---|---|---|---|---|
| P | Crítico, **hoy en producción** | `anon` puede ejecutar `limpiar_pedidos_huerfanos(horas)` | Sin sesión: `rpc/limpiar_pedidos_huerfanos {horas: 0}` borra los pedidos que se están pagando; el webhook no los encuentra y el pedido pagado no llega a la cocina | El SQL 10 la deja solo para el servidor. Mientras no se corra: el `revoke` del paso 0b |
| H1 | Alto | Solo se borraba la firma conocida de las funciones de historial/jornada | Una firma vieja `SECURITY DEFINER` (en producción hubo varias) seguía leyendo los pedidos de todos los restaurantes para cualquier usuario con sesión | Se borran **todas** las firmas de las 5 funciones reemplazadas |
| H1b | Alto | El barrido de `EXECUTE` exceptuaba a `seguimiento` y `buscar_mis_pedidos` **por nombre** | Una firma extra (p. ej. `seguimiento(bigint)` por id) quedaba abierta a `anon`: enumerar direcciones por id secuencial | La excepción es por firma exacta, y la migración se detiene ante cualquier `SECURITY DEFINER` desconocida |
| H2 | Alto | `buscar_mis_pedidos` sin límite de intentos | Conociendo un celular, se prueban totales (en la prueba: 47 intentos) → referencia → `seguimiento` entrega dirección, barrio e indicaciones | 10 consultas por (restaurante, celular) cada 24 h; después responde vacío |
| H3 | Medio | El trigger `personal → miembros` vuelve **dueño de Taqueiros** a quien entre en `personal` | Con un trigger `handle_new_user` en `auth.users` que escriba en `personal` (plantilla común), cada cuenta nueva —incluido el dueño de un cliente nuevo— vería los pedidos de Taqueiros | La migración se detiene si encuentra un trigger así (nuevo en la inspección: `triggers_en_auth_users`) |
| H1c | Medio | La comprobación final ignoraba funciones de otro dueño | En Supabase `postgres` no puede revocar funciones de `supabase_admin`; una de esas abierta a `anon` pasaba sin aviso | La comprobación las cuenta y la migración se detiene |
| H4 | Bajo (hoy no hay vistas) | Ninguna comprobación miraba vistas | Una vista sin `security_invoker` corre como su dueño y salta RLS | La migración se detiene ante una vista así legible por clientes |
| H5 | Bajo | No se avisaba a PostgREST | Se borran y recrean funciones con otra firma; sin recargar, el panel llamaría a la firma vieja (404) | `notify pgrst, 'reload schema'` antes del `commit` |

**Hipótesis revisadas que resultaron no ser huecos** (con prueba que lo confirma en `rls.mjs`):

* La regla transitoria de la raíz del bucket **no** deja a otros dueños sobrescribir, mover ni borrar las fotos de
  Taqueiros: solo un `dueno` **de Taqueiros** puede escribir en la raíz. Tampoco sirven `..`, una barra inicial, la
  carpeta en mayúsculas ni otro bucket.
* Todas las políticas `UPDATE` tienen `WITH CHECK`; además el trigger `*_restaurante_inmutable` impide mover filas
  incluso a quien es dueño de los dos restaurantes.
* Insertar con `restaurante_id` ajeno, o sin él (el defecto transitorio es Taqueiros), se rechaza; un `upsert`
  contra la referencia de un pedido ajeno se rechaza; un `INSERT` rechazado no consume el contador del otro
  restaurante.
* `UPDATE`/`DELETE` **sin `WHERE`** (donde Postgres no aplica la política de lectura) solo tocan filas propias.
* Las funciones de historial y jornada aceptan `p_restaurante`, pero no confían en él: corren como quien llama
  (RLS filtra) y `config_jornada` verifica la membresía; pedir otro restaurante devuelve vacío o `null`.
* `restaurante_secretos`, `contadores_pedido` e `intentos_buscar_pedido`: sin políticas, sin privilegios para
  clientes, ninguna función ni vista los devuelve y no están en Realtime. A futuro conviene Supabase Vault para las
  llaves (Wompi, CallMeBot), leyéndolas solo desde el servidor.
* La función `es_…` que `anon` podía ejecutar en producción es `es_personal()`: solo responde si quien llama está en
  `personal` (para `anon`, siempre `false`). No filtraba datos; el SQL 10 la deja como invoker y sin `anon`.

**Revisión por mutación** (`pruebas/multirestaurante/mutaciones.mjs`): rompe a propósito cada política, trigger,
función y comprobación del SQL 10 y exige que alguna prueba falle o que la migración se detenga. Ver la sección 8
para el resultado.

**Resultado de la revisión por mutación:** 91 mutaciones; **84 detectadas**, **7 equivalentes** y **0 sin detectar** (incluye dos que reintroducen la causa del error de la sección 11). Las
equivalentes son defensas en capas: quitar una sola no cambia lo que un atacante puede hacer porque otra capa cubre lo
mismo (por ejemplo, el `WITH CHECK` de productos y el trigger de restaurante inmutable). En esos casos, la mutación
que quita **las dos capas** sí se detecta. Antes de esta revisión **no se detectaban** (y se agregaron pruebas para):
`UPDATE` de pedidos sin `WITH CHECK` (un pedido podía volver a `pendiente_pago`) y `UPDATE`/`DELETE` sin control en
pedidos, categorías, tarifas y miembros (Postgres no aplica la política de lectura a un `UPDATE`/`DELETE` sin `WHERE`);
la inserción de configuración y el borrado del propio restaurante (se distinguen por el código de error, porque la
llave primaria y las foráneas también los frenan); mover filas siendo dueño de dos restaurantes; y quitar el trigger
de restaurante inmutable.

---

## 11. Fallo en Supabase real: `relation "public.pg_statistic" does not exist`

**Síntoma.** Al correr el SQL 10 en el SQL Editor (con y sin “enable RLS”) falló con
`ERROR: 42P01: relation "public.pg_statistic" does not exist`; se revirtió todo y la base quedó como antes.

**Causa exacta.** La comprobación final “anon: sin privilegios sobre ninguna tabla de negocio” hacía:

```sql
from pg_tables t
where t.schemaname = 'public'
  and has_table_privilege('anon', format('public.%I', t.tablename), 'select,insert,update,delete')
```

Postgres **no garantiza en qué orden evalúa los filtros de un `WHERE`**. `pg_tables` es una vista sobre `pg_class`; el
filtro `schemaname = 'public'` vive en la unión con `pg_namespace`, y la función solo depende de `relname`, así que el
planificador puede evaluarla sobre **todas** las tablas de **todos** los esquemas antes de aplicar el filtro. Para
`pg_statistic` arma `'public.pg_statistic'`, que no existe, y `has_table_privilege` lanza error (a diferencia de
`to_regclass`, que devuelve nulo). En el simulador chico el plan empezaba por `pg_namespace` y nunca llegaba a
`pg_statistic`; en Supabase (muchos esquemas, extensiones, otra estadística) el plan es otro. **No tenía que ver con
permisos sobre `pg_catalog`** (la hipótesis de los permisos no era necesaria: el error ocurre aunque nadie tenga
permiso sobre esas tablas).

**Cómo se reprodujo.** Con `set enable_nestloop = off` el SQL anterior falla en el simulador con el mismo error
(`relation "public.<tabla de otro esquema>" does not exist`; en el simulador sale `public.buckets`). Con el
simulador realista falla en 6 de los 8 planes de `planes.mjs` (y pasa en los otros dos, que es justo lo engañoso).

**Corrección.**

* Todos los barridos de catálogo usan **OID**, no nombres armados: `pg_class c where c.relnamespace = 'public'::regnamespace
  and c.relkind in ('r','p')` + `has_table_privilege('anon', c.oid, …)` (con OID la función no puede fallar), con
  `pg_attribute` en vez de `information_schema` para `restaurante_id`, y `pg_depend` con `classid` para excluir objetos de
  extensiones.
* La comprobación “RLS activo en todas” y “tablas desconocidas” también pasaron a `pg_class` y excluyen objetos de
  extensiones (antes una tabla de extensión sin RLS habría detenido la migración).
* Se agregó `planes.mjs` (planes adversos + lint), que habría atrapado el error antes de entregarlo.
* `00-inspeccion-esquema.sql`: la CTE de tablas filtra primero (`materialized`) y solo después arma nombres y cuenta filas.

**Qué sigue deteniendo la migración (sin debilitar nada).** Funciones `SECURITY DEFINER` desconocidas, vistas sin
`security_invoker`, triggers de `auth.users` con membresía automática y todas las comprobaciones de políticas y
permisos siguen igual; solo cambió *cómo* se recorren los catálogos. Siguen limitadas a objetos de `public` que no son
de una extensión; los barridos de permisos solo tocan funciones que `postgres` puede modificar y la comprobación
final avisa de las que no puede (`H1c`).

**Visibilidad de errores.** El SQL Editor solo muestra el mensaje. Cada bloque `DO` (menos las precondiciones y la
verificación final, que ya tienen su propio mensaje) repite el error como
`MR paso <paso>: <mensaje original> [elemento: <objeto>]` y la transacción se sigue revirtiendo entera. El SQL plano trae
marcadores `-- >>> PASO …` numerados (en VS Code: Ctrl+G con el número de línea y buscar hacia arriba el marcador más
cercano; la lista completa sale con `>>> PASO`). Antes de crear las políticas de Storage, un bloque prueba **de verdad**
si el usuario puede crearlas (crea y borra una política de prueba) y, si no, se detiene con
`MR paso 10 (Storage): este usuario no puede crear políticas en storage.objects (…)`.

**El indicador `puede_crear_politicas_en_storage` era un falso negativo.** Se calculaba con
`pg_has_role(current_user, dueño_de_storage.objects, 'member')`; el SQL 01 ya creó políticas de ese bucket desde el mismo editor,
así que el indicador daba un falso negativo (sin acceso a la base real no pude determinar por qué mecanismo de roles
`postgres` puede hacerlo; por eso ahora se prueba creando una política de prueba en lugar de adivinar). Se eliminó de `sql_pendientes`; el SQL 10 nunca
dependió de él. Ahora la inspección muestra la evidencia (`permiso_storage_objects`): usuario, si es superusuario, dueño
de la tabla, membresías, privilegios y las políticas que ya existen en `storage.objects`.

**Mejoras al simulador (`sim.mjs`).** Roles de Supabase (`supabase_admin`, `supabase_auth_admin`,
`supabase_storage_admin`, `authenticator`); esquemas `extensions`, `graphql`, `graphql_public`, `vault`, `realtime` con tablas
y funciones (algunas de `supabase_admin`) y permisos para `anon`/`authenticated`; permisos de lectura sobre
`pg_catalog.pg_statistic` y `pg_largeobject`; una extensión real (`citext`) instalada en `public`; 25 esquemas de relleno
y `ANALYZE` del catálogo; y los **planes adversos** (`PLANES`, activables con `SQL10_PLAN`).

**Otras diferencias simulador ↔ Supabase revisadas** (y qué se hizo):
* `postgres` es superusuario en el simulador y **no** en Supabase: no se puede reproducir un “must be owner”; se cubre
  con un event trigger que lo simula (`hallazgos.mjs`, [V]) y con la prueba real de permiso del paso 10.
* Dueño de `storage.objects`: en Supabase lo normal es `supabase_storage_admin`; el simulador lo deja de `postgres`.
* Privilegios por defecto (`ALTER DEFAULT PRIVILEGES`): el simulador los imita para `public`; en Supabase también
  aplican a `supabase_admin`. Las funciones de otro dueño en `public` no se pueden revocar: la verificación final las
  detecta.
* Funciones y tablas de extensiones en `public`: excluidas con `pg_depend` (`classid` + `deptype 'e'`); probado con `citext`.
* Event triggers de Supabase (`pgrst_ddl_watch`, `issue_graphql_placeholder`…) corren en cada DDL como `supabase_admin`:
  no se pueden simular aquí; el `notify pgrst, 'reload schema'` final es redundante pero inofensivo.
* Pooler y editor: el script depende de una sola sesión (tablas temporales `_mr_*` y el `select` final tras el
  `commit`). El SQL Editor lo ejecuta como una sola consulta; si en algún entorno el editor partiera el script, la
  tabla final no aparecería (la migración sí quedaría confirmada).
* Opción “Run and enable RLS” del editor: reescribe el script; se recomienda **“Run without RLS”**, porque el propio
  SQL 10 activa RLS en todo y sin que nadie toque el texto.
* `auth.uid()`, claims y roles de PostgREST: se imitan con `request.jwt.claims`; el comportamiento real de las llaves
  nuevas (`sb_publishable_`, `sb_secret_`) solo se confirma con `probar-aislamiento.mjs` contra la base real.

---

## 12. Servidor multi-restaurante (SQL 11 + `api/`)

Hasta la sección 11 la base ya era multi-restaurante pero el servidor no: funcionaba porque todo caía en Taqueiros
(valor por defecto transitorio de `restaurante_id`). Como las API usan la llave secreta (que **se salta RLS**), la base
no las protege de sí mismas: cada consulta del servidor tiene que filtrar por restaurante de forma explícita. Esta
sección es ese trabajo. **Las páginas HTML y `ticket-comanda.js` no se tocaron** y Taqueiros se ve igual en
`taqueiros-2-0.vercel.app`.

### 12.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/11-dominios.sql` (nuevo) | Tabla `restaurante_dominios (host único en minúsculas, restaurante_id, creado_en)`, RLS activo, **sin políticas y sin privilegios para `anon` ni `authenticated`** (solo el servidor la lee). Siembra `taqueiros-2-0.vercel.app` → Taqueiros. Atómico, idempotente, con marcadores `-- >>> PASO n`, bloques `DO` que relanzan el error como `MR paso n: ...`, barridos por OID y 12 comprobaciones OK/FALLA. No toca el valor por defecto transitorio. |
| `api/_restaurante.js` (nuevo) | Resolución del restaurante por petición, caché, estado del servicio, lectura de secretos y modo de cobro. |
| `api/_supabase.js` | **Toda** función de negocio recibe el `restaurante_id` como primer argumento y lo pone en el filtro o en el cuerpo del insert; sin un UUID válido lanza error y no consulta. |
| `api/menu`, `disponibilidad`, `estado`, `crear-pedido`, `generar-firma`, `webhook-wompi`, `alertas`, `keep-alive` | Adaptados (tabla de 12.3). |
| `api/restaurante.js` (nuevo) | Datos públicos del restaurante del host (para el front). |
| `api/reembolso.js` (nuevo) | Registro de `reembolsado_en` (solo dueño o servidor). |
| `supabase/cargar-secretos.mjs` (nuevo) | Pasa las llaves de las variables de entorno a `restaurante_secretos`. |
| `supabase/probar-servidor-multirestaurante.mjs` (nuevo) | Los mismos escenarios que la batería local, contra la base real. |
| `supabase/probar-compatibilidad.mjs` | Actualizado: simula una visita al host de Taqueiros y revisa lo que el servidor nuevo necesita. |
| `pruebas/llave-y-categorias.test.js`, `pruebas/cron.test.js` | Solo se actualizaron las firmas (ahora reciben el restaurante). |

Fuera de `api/` y `supabase/` solo cambiaron `pruebas/` (arnés y pruebas), `docs/` y `.env.example`.

### 12.2 Cómo se resuelve el restaurante (y por qué es seguro)

Orden, y **nada más**:

1. El encabezado **`Host` exacto**, buscado en `restaurante_dominios`.
2. Un **subdominio** bajo `DOMINIO_BASE` (variable de entorno de Vercel) cuyo **único** segmento anterior sea el slug de un
   restaurante. Con `DOMINIO_BASE=midominio.com`: `lostaqueiros.midominio.com` → slug `lostaqueiros`. Dos niveles
   (`x.lostaqueiros.midominio.com`), el dominio pegado sin punto o un sufijo (`...midominio.com.evil.com`) **no** resuelven.
3. **Solo si `VERCEL_ENV` no es `production` Y además `RESTAURANTE_POR_PARAMETRO=1`** (previews y desarrollo local): el
   parámetro `?r=<slug>`, para probar sin dominios. En producción está apagado siempre, y en un preview también salvo que
   se active a propósito (sección 13, H4: los previews de Vercel son públicos y usan la misma base y la misma llave secreta).
   Ni `?r=`, ni cabeceras, ni el cuerpo eligen restaurante.

Por qué es seguro:

* `Host` lo fija la infraestructura (Vercel enruta por el dominio al que entró el cliente). No se lee `x-forwarded-host` ni
  ningún otro encabezado, y **nunca** el cuerpo ni el query en producción. La batería lo prueba con `x-forwarded-host`,
  `x-restaurante`, `origin`, `referer`, `restaurante_id`/`slug`/`host` dentro del body y `?r=` en producción.
* Un host desconocido (o ausente, o con formato raro) responde **404 con el mismo cuerpo** para cualquier endpoint, sin
  decir qué restaurantes existen; los hosts raros ni siquiera llegan a la base (se validan antes de consultar).
* El slug del subdominio se valida contra el formato antes de buscarlo; todo valor que entra a una URL de PostgREST se
  valida (UUID / formato de host / formato de slug), así que no se pueden colar filtros.
* La tabla `restaurante_dominios` no la ve ningún cliente: con la llave publishable nadie averigua qué hosts existen.

**Caché** (memoria de la instancia): 30 s por host/slug, con caché negativa de 10 s (un host inventado no castiga a la
base) y máximo 500 entradas. Guarda solo el restaurante (nunca secretos). `invalidarCache()` / `invalidarCache(id)` la
vacía (hay que llamarla en cualquier código futuro que cambie estado, plan o vigencia). Si Supabase falla, se usa la
**última resolución conocida** (hasta 6 h): el mapa host → restaurante no es secreto y así se conserva la red de seguridad
del menú. Para decidir si se aceptan pedidos, `crear-pedido` relee el restaurante **sin caché**: una suspensión rige en
el acto.

**Transición:** si la tabla `restaurante_dominios` aún no existe (SQL 11 sin correr) y el host es exactamente
`taqueiros-2-0.vercel.app`, se resuelve a Taqueiros con un aviso en el log. Es lo que permite desplegar el código antes del
SQL 11 sin tumbar a Taqueiros. Cualquier otro host sigue dando error.

### 12.3 Inventario de endpoints y cómo filtra cada uno

> Desde la sección 17, los manejadores de `menu`, `estado`, `disponibilidad`, `restaurante`, `manifest`, `alertas` y `keep-alive` viven en `api/_modulos/` (los mismos, movidos de archivo) y los despachan
> `api/publico.js` y `api/cron.js`; **las URL de esta tabla no cambian**.

| Endpoint | Quién llama | Restaurante sale de | Cómo filtra / qué usa |
|---|---|---|---|
| `GET /api/menu` | público | Host | `categorias` y `productos` con `restaurante_id`; copia de respaldo en memoria **por restaurante**; `Cache-Control` del borde + `Vary: Host`. Suspendido sigue mostrando menú. |
| `GET /api/disponibilidad` | público | Host | `productos`/`categorias` agotados/apagados de ese restaurante. |
| `GET /api/estado` | público | Host | `configuracion` por `restaurante_id`, con su zona horaria y su hora de corte; agrega `servicio.sirve`. |
| `POST /api/crear-pedido` | público | Host | Servicio al día (relee sin caché) → horario → `validarItems(rid)` (un producto de otro restaurante cae en `desconocidos`) → domicilio con **sus** `tarifas_domicilio` y **su** ubicación → secretos del restaurante → `insert` con `restaurante_id` explícito; el número lo asigna el trigger con el contador atómico de ese restaurante. |
| `POST /api/generar-firma` | (ninguna página lo usa) | Host | Solo firma un pedido que **existe en ese restaurante**, está pendiente y por el monto guardado (antes firmaba cualquier referencia/monto). |
| `POST /api/webhook-wompi` | Wompi | **El pedido** (por la referencia) | Ver abajo. |
| `GET /api/alertas` | cron | recorre restaurantes | Cada restaurante en servicio: sus pedidos, su contacto, su salud, su `alerta_enviada`. |
| `GET /api/keep-alive` | cron | ninguno | Ping a `restaurantes` (no es tabla de negocio); `limpiar_pedidos_huerfanos` es global a propósito. |
| `GET /api/restaurante` | público (front) | Host | Solo datos públicos (12.7). |
| `POST /api/reembolso` | panel (dueño) | Host | 12.6. |

**Webhook de Wompi.** Es un único endpoint para todos, así que el host no sirve. (1) La referencia del evento identifica el
pedido (única en toda la base) y el pedido trae su `restaurante_id`; (2) la firma se verifica con los secretos **de ese
restaurante**, según el `environment` del evento; (3) todo lo demás (actualizar, avisar) usa ese `restaurante_id`. Un
evento firmado con los secretos del restaurante A sobre un pedido de B responde **401** y no cambia nada. Una referencia
desconocida y una firma mala responden **igual** (401, mismo cuerpo): el endpoint no sirve para averiguar qué referencias
existen. Además (sección 13): el ambiente del evento (`test`/`prod`) debe coincidir con el del pedido y con el modo fijado del
restaurante (si no, 200 e ignorado); el monto se compara en centavos exactos y la moneda debe ser COP; y toda escritura es
condicional (`estado_pago <> aprobado`), así que dos eventos simultáneos avisan una sola vez y un rechazo tardío no deshace
un pago. Un restaurante **suspendido sigue
procesando los pagos ya en curso** (el cliente ya pagó): lo que se corta es crear pedidos nuevos.

**Alertas.** Itera sobre los restaurantes que están sirviendo (activo, prueba o gracia; no suspendidos). Un restaurante sin
contacto se salta y sus pedidos **no** se marcan como avisados; el fallo de uno no detiene a los demás; `notificarWhatsApp`
lanza error si el contacto no es del restaurante del pedido (defensa en profundidad: nunca sale un pedido por el WhatsApp de
otro). El estado de salud (`salud_notificaciones`) se lee y se escribe por `restaurante_id` (ya no `id = 1`). Con muchos
restaurantes (sección 13, H5): solo se avisan pedidos pagados en las **últimas 2 h** (cargarle el contacto a un restaurante
que no lo tenía no le manda un aluvión de pedidos viejos), se revisan **4 restaurantes a la vez** empezando por uno al azar, y
la corrida **no empieza envíos pasados 8 s** (cada envío se acorta a lo que queda); lo que no alcanza sale en la siguiente
pasada. La respuesta informa `sinRevisar`.

**`limpiar_pedidos_huerfanos`**, `seguimiento` y `buscar_mis_pedidos`: el servidor solo llama a la primera, y es un barrido
global que solo toca pedidos que ya nunca se van a cobrar (sin pagar, de más de 24 h) y solo el servidor puede ejecutarla;
`seguimiento` y `buscar_mis_pedidos` las llama el navegador (con su parámetro `p_restaurante`, tarea del front).
**Impresión:** `reclamar_impresion` y `registrar_reimpresion` las llama el panel (ya verifican membresía, SQL 10); el
servidor no las usa y no se tocó nada.

### 12.4 Secretos: de dónde se leen y su forma exacta

Los lee **solo el servidor**, de `restaurante_secretos` (sin políticas: nadie más), **en cada uso** (no se guardan en
caché), y **jamás** se devuelven ni se escriben en logs (la batería busca cada secreto en todas las respuestas y en todo el
log de la corrida).

| Dato | Dónde |
|---|---|
| Secreto de **integridad** de Wompi (firma del checkout) | columnas `wompi_integridad_test` / `wompi_integridad_prod` |
| Secreto de **eventos** de Wompi (firma del webhook) | columnas `wompi_eventos_test` / `wompi_eventos_prod` |
| Llave **pública** de Wompi | columnas `wompi_llave_publica_test` / `wompi_llave_publica_prod` (no la usa el servidor hoy) |
| Llave **privada** de Wompi | `otros.wompi_llave_privada_test` / `otros.wompi_llave_privada_prod` (no la usa el servidor hoy) |
| CallMeBot: teléfono (`57XXXXXXXXXX`) y apikey | columnas `callmebot_telefono`, `callmebot_apikey` |
| **Modo de cobro** | `otros.wompi_modo`: `"test"` o `"produccion"` |

**Modo de cobro.** Antes lo decidía el navegador (`modo` en el body). Un cliente podía pedir `"test"` y pagar con tarjetas de
prueba de Wompi: el webhook de prueba aprobaba el pago y el pedido entraba a cocina gratis. Ahora lo decide el servidor con
`otros.wompi_modo` (el dueño no lo puede editar: `restaurante_secretos` es solo del servidor). Si no está definido, **solo
Taqueiros** conserva lo de siempre (el modo que manda su página); **cualquier otro restaurante no cobra** hasta que se
configure. **Antes de cambiar `WOMPI_MODE` a `"produccion"` en `index.html` es OBLIGATORIO fijarlo** (`cargar-secretos.mjs`
con `WOMPI_MODO=produccion`): sin eso, un cliente puede crear su pedido en modo prueba y pagarlo con una tarjeta de prueba
(sección 13, H1 y pendiente P1).

**Respaldo con variables de entorno, solo Taqueiros.** Si un secreto de Taqueiros no está en `restaurante_secretos`, se usa
la variable de entorno actual (`WOMPI_INTEGRITY_SECRET_*`, `WOMPI_EVENTS_SECRET_*`, `CALLMEBOT_PHONE`, `CALLMEBOT_APIKEY`),
campo por campo y con un aviso en el log (nombre de la variable, nunca el valor). **Nunca** para otro restaurante (probado).
Lo que está en la base manda sobre el entorno. Las variables siguen en Vercel hasta que decidas retirarlas.

### 12.5 Estado del servicio (mensualidad)

`restauranteActivo(restaurante, ahora)` devuelve `activo`, `gracia` o `suspendido`:

* `estado = 'suspendido'` → suspendido (`motivo: suspendido`).
* `vigente_hasta` nulo → activo (sin vencimiento). `prueba` y `activo` sirven.
* Hasta el día de `vigente_hasta` (inclusive) → activo; hasta `vigente_hasta + dias_gracia` → `gracia` (sigue sirviendo);
  después → suspendido (`motivo: vencido`). "Hoy" es la fecha en la **zona horaria del restaurante**.

Suspendido o vencido: `crear-pedido` y `generar-firma` responden **403** con `{"motivo": "servicio_suspendido"}` sin borrar ni
modificar nada; el menú sigue mostrándose; el webhook, las alertas (no se alertan) y los endpoints internos del panel (como
`reembolso`) no se bloquean salvo lo indicado. `/api/estado` y `/api/restaurante` informan `servicio`.

### 12.6 Reembolsos (`pedidos.reembolsado_en`)

`POST /api/reembolso` con `{"referencia": "TAQ-..."}` y la sesión del panel (`Authorization: Bearer <JWT>`). Solo el **dueño
activo** del restaurante del host (o un superadmin) puede; el cajero, la cocina y quien no tenga membresía reciben 403; el
dueño de **otro** restaurante, también. El pedido debe ser de ese restaurante, estar **cancelado** con el pago **aprobado**
y sin fecha de reembolso; repetirlo no cambia la fecha (`yaRegistrado`). El `PATCH` es condicional y atómico: dos llamadas
simultáneas registran una sola fecha. El servidor también puede llamar a `registrarReembolso(rid, referencia)` directamente.
Un cliente con su propia sesión no puede escribir esa columna (lo bloquea el trigger del SQL 10). No hizo falta una función SQL
nueva: así el SQL 10 no cambia (su comprobación rechaza funciones `SECURITY DEFINER` nuevas que clientes puedan llamar).
El panel todavía no lo usa (no se cambió el front).

### 12.7 `/api/restaurante` (datos públicos) y configuración de cada restaurante

Devuelve **solo**: `id`, `slug`, `nombre`, `zona_horaria`, `modulos`, `config` (**únicamente `config.publico`**) y
`servicio {estado: activo|suspendido, sirve, motivo}`. No devuelve plan, modalidad de pago, vigencia, días de gracia, el resto
de `config`, ni nada de `restaurante_secretos` ni de `miembros`. Tampoco dice si el restaurante está **en gracia** (atrasado con
la mensualidad): en gracia responde `activo` (sección 13, H10). Sin caché del borde (es por host).

Claves de `restaurantes.config` (jsonb; el dueño edita `nombre` y `config`):

| Clave | Uso |
|---|---|
| `publico` | Lo que el front puede leer: colores, logo, WhatsApp de contacto, etc. (lo único que sale por `/api/restaurante`) |
| `ubicacion` = `{lat, lng}` | Dónde está el local (origen del domicilio). |
| `domicilio` = `{factor_recorrido, pin_minimo_metros, area:{latMin,latMax,lngMin,lngMax}}` | Opcionales. Sin `area` no se hace la comprobación de "pin fuera del área". |

Un restaurante sin tarifas en `tarifas_domicilio` **o** sin `ubicacion` no ofrece domicilio (400 claro); nunca se inventan
precios. **Transitorio solo para Taqueiros:** mientras su `config` no traiga `ubicacion`, se usan las coordenadas y la caja de
Cúcuta que estaban en el código (hay que cargarlas en `config` en el siguiente paso).

**Tarifas.** Ya no están en el código: salen de `tarifas_domicilio`. Se retiraron `TARIFAS_DOMICILIO` y `RESTAURANTE` de
`api/_domicilio.js` **después** de que una prueba demostrara que la tabla da los mismos precios, distancias y cobertura que
el código antiguo (copia literal de la lógica antigua, 441 puntos de la cuadrícula de Cúcuta + 4 lejanos, los 5 tramos). La
copia de `index.html` (`TARIFAS_DOMICILIO`) **se retiró en la sección 14**: la página lee las tarifas, el origen y el factor
de recorrido de `/api/restaurante`.

**Horario, zona horaria y hora de corte.** `estadoRestaurante(restaurante)` usa la zona de `restaurantes.zona_horaria` y la
hora de corte de `configuracion.hora_corte_jornada` (la que usa el panel; la de `restaurantes` es el respaldo). Un horario que
cruza la medianoche (cierra ≤ abre, p. ej. 18:00–02:00) queda abierto de madrugada hasta el cierre, **sin pasar de la hora de
corte**; con un horario normal (11:00–22:00) el resultado es idéntico al de siempre (probado cada 30 min durante dos días y en
los bordes). La respuesta incluye `jornada` y `horaCorteJornada`.

### 12.8 Dar de alta un restaurante nuevo (receta, con la llave secreta o el SQL Editor)

> *(Desde la sección 19 hay un procedimiento con la API de superadmin, que además deja auditoría: 19.6.)*

1. `insert into public.restaurantes (slug, nombre, estado) values ('lostaqueiros', 'Los Taqueiros ...', 'prueba');`
   (el trigger crea su fila de secretos, contador, configuración y salud).
2. Dominio: `insert into public.restaurante_dominios (host, restaurante_id) values ('pedidos.lostaqueiros.com', '<id>');`
   y agregar ese dominio en Vercel (Project → Settings → Domains). O usar el subdominio `lostaqueiros.<DOMINIO_BASE>`.
3. Secretos: `supabase/cargar-secretos.mjs --slug=lostaqueiros` (incluye `WOMPI_MODO`).
4. Menú (`categorias`, `productos` con su `restaurante_id`), `tarifas_domicilio`, `config.ubicacion`, `configuracion.horarios`.
5. En el panel de Wompi de **ese** restaurante, el webhook apunta a `https://<cualquier dominio del despliegue>/api/webhook-wompi`
   (el endpoint es el mismo para todos; el restaurante sale del pedido).

### 12.9 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` (no se ven al pegarlas): pega
**UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos). Todos los scripts detectan el pegado doble y no hacen nada.

**1. Despliegue.** Al subir el código a `main`, Vercel despliega solo. Taqueiros sigue funcionando aunque el SQL 11 aún no
esté: el host de producción se resuelve por el respaldo transitorio y los secretos salen de las variables de entorno.
Comprueba `taqueiros-2-0.vercel.app` (menú, un pedido de prueba con Wompi sandbox).

**2. SQL 11.** VS Code → abre `supabase/11-dominios.sql` → **Ctrl+A, Ctrl+C** → Supabase → SQL Editor → New query → pega →
**"Run without RLS"**. Resultado esperado: **12 filas, todas `OK`**. Si algo falla, el error dice `MR paso n: ...` o
`LA MIGRACION 11 SE REVIRTIO` y no se cambió nada. Se puede repetir.

**3. Compatibilidad del servidor con la base real (solo lectura).**

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs
```

Esperado: **25 PASAN** (ya sin el aviso de "SQL 11 sin correr").

**4. Cargar los secretos de Taqueiros en la base.** Los valores actuales están en Vercel → Project → Settings → Environment
Variables (botón del ojo). Pega cada uno **una sola vez**; los que no tengas, déjalos vacíos (Enter).

```powershell
function Pedir($nombre, $texto) { $s = Read-Host $texto -AsSecureString; $v = [System.Net.NetworkCredential]::new('', $s).Password; if ($v) { Set-Item "Env:$nombre" $v } }
Pedir WOMPI_INTEGRITY_SECRET_TEST "Secreto de INTEGRIDAD (test)"
Pedir WOMPI_INTEGRITY_SECRET_PROD "Secreto de INTEGRIDAD (prod)"
Pedir WOMPI_EVENTS_SECRET_TEST    "Secreto de EVENTOS (test)"
Pedir WOMPI_EVENTS_SECRET_PROD    "Secreto de EVENTOS (prod)"
Pedir CALLMEBOT_PHONE             "Telefono CallMeBot (57XXXXXXXXXX)"
Pedir CALLMEBOT_APIKEY            "Apikey CallMeBot"
node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar     # que diga "falta en la base"
node supabase/cargar-secretos.mjs --slug=taqueiros
node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar     # ahora todo "ya coincide"
```

(Opcional, cuando decidas el modo de cobro de Taqueiros: `Pedir WOMPI_MODO "test o produccion"` y vuelve a correrlo.)
Después de esto el servidor usa la base y ya no el entorno para Taqueiros. **No borres las variables de Vercel todavía.**
Limpia la sesión: `Remove-Item Env:WOMPI_* , Env:CALLMEBOT_*`.

**5. Prueba del servidor contra la base real.** Crea y borra restaurantes de prueba (`test-srv-...`); no toca Taqueiros (solo lee).
Antes, si las sesiones de usuario vuelven a dar 401, corre `node supabase/diagnosticar-auth.mjs` (12.12): dice qué
combinación de cabeceras acepta Supabase.

```powershell
node supabase/probar-servidor-multirestaurante.mjs
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Esperado: todos `PASA` (≈134), `Limpieza: todo lo creado se borro.` y código de salida 0. Si dice que no pudo limpiar,
vuelve a correrlo: al empezar barre los restos. Con Ctrl+C también limpia.

**6. (Recomendado) Aislamiento de la base, igual que antes.** `node supabase/probar-aislamiento.mjs` (con la llave secreta
en la sesión). El SQL 11 no cambia nada de lo que prueba.

**7. Tests del repo (no tocan la base real).**

```powershell
node --test pruebas/*.test.js                          # unitarios (64)
node pruebas/impresion/e2e.js                          # panel con Supabase simulado (~3 min)
node pruebas/multirestaurante/servidor.mjs             # servidor, Supabase falso (~5 s)
node pruebas/multirestaurante/dominios.mjs             # SQL 11 + revision por mutacion del SQL 11
node pruebas/multirestaurante/cargar-secretos-test.mjs # cargar-secretos.mjs
node pruebas/multirestaurante/mutaciones-servidor.mjs  # revision por mutacion del servidor (~12 min)
```

Necesitan una vez: `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2`.

**8. Recorrido a mano en producción** (lo único que ninguna prueba automática reemplaza): menú, pedido de prueba con Wompi
sandbox (aparece en el panel, suena, imprime, llega el WhatsApp), Reimprimir, historial, menú-admin.

### 12.10 Qué se probó y qué no

**Probado por mí (batería local con el Supabase falso, Postgres 16 real en PGlite con el SQL 10 y el SQL 11):**

* `servidor.mjs`: **145 escenarios** sobre los manejadores reales con dos restaurantes (más otros dos) de menús, tarifas,
  secretos, horarios y zonas distintos: cada host ve solo lo suyo; un producto de A no se pide en B (mismo id, otro precio);
  números de pedido independientes y sin repetirse bajo concurrencia; domicilio distinto por restaurante; un webhook
  firmado con los secretos de A no toca pedidos de B (y al revés); alertas sin cruzar contactos ni salud; host
  desconocido 404; `?r=` solo fuera de producción; cabeceras y body falsos no eligen restaurante; suspendido/vencido/gracia;
  reembolsos por rol; Taqueiros con respaldo de entorno; ningún secreto aparece en respuestas ni en el log; y un **espía de
  URLs** que exige que toda consulta a tablas de negocio lleve el filtro de su restaurante.
* `dominios.mjs`: **35** (SQL 11 dos veces, el SQL 10 después del 11, roles, restricciones, 8 mutaciones del SQL 11).
* `cargar-secretos-test.mjs`: **20** (no imprime valores ni huellas, pegado doble, no pisa sin `--sobrescribir`, `--solo-verificar`).
* `probar-servidor-multirestaurante.mjs` contra el falso: 134 (en modo real se omiten 4 de escribir en Taqueiros y 7 que solo tienen sentido con el falso).
* `probar-compatibilidad.mjs` contra el falso: 25/25.
* Baterías anteriores, con el SQL 11 aplicado y el servidor nuevo (todas siguen verdes): `rls.mjs` 234/234, `hallazgos.mjs` 32/32,
  `planes.mjs` 11/11, `sim.mjs` (34 comprobaciones OK, con y sin `conPendientes`), `probar-aislamiento` contra el falso 227/234 (las 7 que
  fallan son las de Realtime, que el falso no emula: igual que antes), tests unitarios 64/64 y e2e del panel 173/173.

**Revisión por mutación del servidor** (`mutaciones-servidor.mjs`): rompe a propósito cada defensa y exige que alguna prueba
lo detecte. **10** filtros de `restaurante_id` (todas las llamadas a `filtroRestaurante`, que cubren cada endpoint; cada una
se prueba **sin** el espía de URLs, y las 10 se detectan ya por comportamiento), el `restaurante_id` de los inserts, y **96**
defensas más (resolución del host, caché, `?r=`, servicio, secretos, firma del webhook, contactos de alertas, autorización
de reembolsos, tarifas, horarios, respaldo del menú, datos públicos…): **101 detectadas, 6 equivalentes, 0 sobrevivientes**.
Las equivalentes están declaradas con su razón (defensas en capas: p. ej. el `PATCH` del reembolso repite las condiciones de
`reembolso.js`, y quitar las dos juntas **sí** se detecta). Antes de agregar las pruebas del cliente de Supabase, la revisión
mostró que quitar el filtro de `actualizarPedidoPorReferencia`, `marcarReembolsado`, `consultarPedidos` y del contador de
salud solo lo detectaba la prueba de "restaurante inválido" y no un cruce real; y que la prueba de suspensión inmediata no
dejaba al restaurante en caché como activo. Se agregaron esas pruebas.

**Solo se puede probar contra la base real (pendiente de Carlos):** el SQL 11 sobre el esquema verdadero; los códigos de error
reales de PostgREST (la transición sin tabla reconoce `PGRST205` y `42P01`); que `/auth/v1/user` acepte la llave secreta en
`apikey` con el JWT del usuario como Bearer (lo mide `supabase/diagnosticar-auth.mjs`, variante B; ver 12.12; si no
funciona, definir `SUPABASE_PUBLISHABLE_KEY` en Vercel: `api/_sesion.js` la usa si existe); que la caché del borde de Vercel
separe los dominios (se marcó `Vary: Host`; verifícalo con dos dominios antes de vender); un pago real con Wompi y el
WhatsApp real.

### 12.11 Riesgos para los siguientes prompts (páginas públicas y panel)

1. ~~**El front sigue siendo de Taqueiros.**~~ **Resuelto en la sección 14** para `index.html` y `pedido.html`: leen
   `/api/restaurante` (que ahora devuelve tarifas, ubicación y la llave **pública** del modo vigente, guardada en
   `config.publico.wompi`). `panel.html`, `menu-admin.html`, `historial.html` y `marca.js` siguen con la marca escrita (14.11).
2. ~~**`numero` vs `id`.**~~ **Resuelto en la sección 14.7**: WhatsApp, alertas, ticket, tablero, historial y seguimiento
   muestran `numero`.
3. **Valores por defecto transitorios siguen puestos** (`restaurante_id` y la regla del bucket). ~~`menu-admin.html` inserta
   sin `restaurante_id`~~ **Resuelto en la sección 15**: ahora lo manda siempre. Falta retirar el defecto (y entonces cualquier
   inserción que lo olvide falla en vez de caer en Taqueiros): 2B-4, ver 15.11.
4. ~~**El panel usa `restaurante_actual()`** (la primera membresía): un usuario con dos restaurantes necesita un selector.~~ **Resuelto en
   la sección 15**: el panel manda `p_restaurante` y filtra por `restaurante_id`; cada dominio abre su restaurante, sin selector.
5. **Realtime y `DELETE`** (riesgo 5 de la sección 9) sigue igual.
6. **Dominios:** cada dominio nuevo hay que agregarlo en Vercel **y** en `restaurante_dominios`; un preview de Vercel
   (`...vercel.app` distinto) no está registrado y solo sirve con `?r=`, que además exige `RESTAURANTE_POR_PARAMETRO=1`
   en las variables de **Preview** (sección 13, H4).
7. **`modo` de cobro de Taqueiros** sigue lo que mande su página hasta que se fije `otros.wompi_modo`.
8. **`?clave=` del cron** y el defecto transitorio no se retiraron (se pidió dejarlos). *(`?clave=` se retiró en la sección 19.8.)*
9. **Anomalía de `restaurante_dominios` si se borra a mano:** el servidor usa la última resolución conocida hasta 6 h si
   Supabase falla; borrar un dominio no lo "desconecta" al instante en instancias con la caché (30 s) o en caída de la base.

### 12.12 Sesiones de usuario rechazadas contra la base real (causa, arreglo y por qué el falso no lo vio)

**Síntoma.** `probar-servidor-multirestaurante.mjs` contra la base real: 117 PASA y 10 FALLA, todas en REEMBOLSO, todas con
`401 {"error":"Inicia sesión para continuar"}` aunque el token fuera el de un dueño válido. Contra el Supabase falso pasaban.

**Causa (encontrada por lectura de `api/_supabase.js`, línea de `usuarioDeToken`).** Una guarda previa a la red escrita
`/s/.test(t)` en lugar de `/\s/.test(t)`: la barra del escape se perdió (la trampa de escapes de las herramientas ya
documentada) y el código descartaba **todo token que contuviera la letra "s"**. Un JWT real (~800 caracteres en base64url)
casi siempre la contiene (su propio encabezado `eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9` ya la lleva), así que ningún dueño
real pasaba la validación y ni siquiera se llamaba a Supabase. Las otras hipótesis quedaron descartadas por lectura:
la secreta ya iba solo en `apikey` (nunca como Bearer; lo decide `_llave.js`), no se verifica nada con un secreto local,
no se usa supabase-js en el servidor, el script de prueba crea el usuario por la API de administración confirmado y
entra con la publishable, y el 401 sale únicamente de `reembolso.js` cuando el helper devuelve `null`.
(`supabase/diagnosticar-auth.mjs` lo confirma con la base real: imprime si el token real contiene la "s".)

**Por qué el falso no lo detectaba.** Sus tokens eran `tok_<16 hex>`: 20 caracteres de `0-9a-f` y nunca una "s". Además no
imitaba las puertas del gateway real (aceptaba un Bearer desconocido, una `sb_secret_` como Bearer, o un token sin `apikey`).

**Arreglo.**
* `api/_sesion.js` (nuevo, UN solo lugar; lo usará también el panel de superadmin): `usuarioDeSolicitud(req)` /
  `usuarioDeToken(token)` llaman a `GET /auth/v1/user` con `apikey` = la publishable (`SUPABASE_PUBLISHABLE_KEY`, y si falta
  la secreta, **solo en `apikey`**) y `Authorization: Bearer <token del usuario>`. Solo se descartan antes de la red tokens
  vacíos, con espacios en blanco o de más de 4096 caracteres. 400/401/403 de Auth = "sin sesión"; **cualquier otro fallo
  (5xx, red caída, la llave del proyecto rechazada) lanza un error** y `reembolso.js` responde 500 con la causa en el log
  en vez de un 401 que mande al usuario a iniciar sesión otra vez.
* `api/_supabase.js` ya no define `usuarioDeToken`; `api/reembolso.js` usa el helper. Las reglas de autorización (dueño activo
  o superadmin, en el restaurante del host) y los filtros por restaurante no cambiaron.

**El falso miente menos** (`pruebas/multirestaurante/fake-supabase.mjs`): sus tokens tienen forma de JWT real (3 partes
base64url, ~790 caracteres, alg ES256); rechaza con 401 lo que rechaza el gateway real: petición sin `apikey` válida (el
token del usuario solo no basta, un JWT tampoco sirve de `apikey`), una `sb_secret_` como Bearer, un Bearer que no es una sesión
conocida, y un `Authorization` sin la palabra Bearer. **14 pruebas nuevas** (131 -> 145) en `escenarios-servidor.mjs` (grupo reembolso):
token real con "s" aceptado; cabeceras exactas que llegan a Auth (token del usuario en Authorization, llave del proyecto
en apikey, nunca la secreta como Bearer); sin la publishable usa la secreta solo en `apikey`; entradas que no llegan a la red;
token mal firmado = sin sesión; Auth caído / 5xx / llave rechazada = 500; y 4 de "falso realista" (solo con el falso). 11 mutaciones
nuevas en `mutaciones-servidor.mjs` (incluida la causa: `/s/` en lugar de `/\s/`): 11/11 detectadas.

**Diagnóstico con la base real:** `supabase/diagnosticar-auth.mjs` (usuario temporal `test-auth-<hex>@example.invalid`,
confirmado por la API de administración, borrado al terminar). Prueba 11 combinaciones de cabeceras contra `/auth/v1/user`
(A documentada … K), `supabase-js` `auth.getUser` con publishable y con secreta, y el helper real con y sin
`SUPABASE_PUBLISHABLE_KEY`. Imprime solo variante, HTTP y código de error. Se puede probar contra el falso:
`node pruebas/multirestaurante/contra-falso.mjs diagnosticar-auth.mjs`.

**Recomendación independiente del resultado:** define `SUPABASE_PUBLISHABLE_KEY` en Vercel (es la llave pública que ya está
en `supabase-publico.js`): es la forma documentada para validar sesiones y no depende de que la secreta sea aceptada en
`apikey` de Auth.

## 13. Revisión adversaria del servidor (segunda revisión, independiente)

Revisión hecha como atacante (dueño de un restaurante cliente o cliente final malicioso) de todo `api/`, los helpers, las
funciones SQL que llama el servidor, el simulador y las pruebas. Cada hallazgo corregido tiene una prueba en
`pruebas/multirestaurante/escenarios-servidor.mjs` (grupo `adversaria`, prefijo `H<n>`) que **falló antes** de la corrección
y pasa después, y una o más mutaciones en `mutaciones-servidor.mjs`. Nada cambió en las páginas HTML, `ticket-comanda.js` ni la
impresión, y Taqueiros se comporta igual (las únicas diferencias visibles están señaladas abajo).

### 13.1 Hallazgos corregidos (de mayor a menor severidad)

| # | Severidad | Dónde | Qué era y cómo se explotaba | Corrección |
|---|---|---|---|---|
| H1 | **Crítico** (con dinero real) | `api/webhook-wompi.js:149`, `api/generar-firma.js:58` | El webhook elegía el secreto según el `environment` **que trae el evento** y aprobaba cualquier pedido con un evento de prueba bien firmado. (a) Un pedido viejo creado cuando el restaurante estaba en prueba, todavía pendiente tras pasar a producción, se pagaba con una **tarjeta de prueba** y entraba a cocina. (b) `generar-firma` firmaba en prueba un pedido creado en producción (Taqueiros acepta todavía el modo del navegador): se abría el widget con la llave pública de prueba (está en `index.html`), se pagaba con la tarjeta 4242… y Wompi sandbox mandaba un evento de prueba legítimo. | El ambiente del evento debe coincidir con el `wompi_ambiente` del pedido **y** con el modo fijado del restaurante (`otros.wompi_modo`); si no, 200 e ignorado (sin reintentos de Wompi). `generar-firma` responde 409 si el modo pedido no es el del pedido. **Queda abierto** el caso de Taqueiros sin `wompi_modo` (pendiente P1). |
| H4 | **Alto** | `api/_restaurante.js:205` | `?r=<slug>` funcionaba en **cualquier** despliegue que no fuera producción. Los previews de Vercel son públicos por defecto (sus URL salen en los despliegues del repo público) y usan las mismas variables: la misma base y la llave secreta. Cualquiera con la URL de un preview operaba cualquier restaurante con `?r=`: pedidos basura en restaurantes aún no lanzados, enumeración de slugs, y el código de una rama sin revisar corriendo contra la base real. | `?r=` exige además `RESTAURANTE_POR_PARAMETRO=1` (y sigue apagado en producción aunque esté puesta). Ver P2 para cerrar el resto en la configuración de Vercel. |
| H2 | Medio | `api/webhook-wompi.js:168-209`, `api/_supabase.js` (`actualizarPedidoPorReferencia`) | Idempotencia solo por lectura previa. Dos entregas simultáneas del mismo evento aprobado mandaban **la comanda dos veces** (la cocina puede prepararla dos veces); un rechazo que leyó el pedido antes de una aprobación y escribía después dejaba un pedido **en cocina con el pago "rechazado"**. | Todas las escrituras del webhook son condicionales (`estado_pago=neq.aprobado`); si la aprobación no cambió ninguna fila, es un duplicado y no se avisa. |
| H5 | Medio | `api/alertas.js:48-131` | (a) Los pedidos de un restaurante sin contacto nunca se marcan; al cargarle el contacto, el cron le mandaba **todos los pedidos viejos** (10 cada 2 min). (b) Restaurantes en serie con envíos de hasta 8 s: un CallMeBot lento en uno pasaba del límite de Vercel (10 s en Hobby) y los restaurantes siguientes **nunca** recibían alertas (siempre los mismos). | Ventana de 2 h; 4 restaurantes en paralelo empezando por uno al azar; no se empiezan envíos pasados 8 s y cada envío se acorta a lo que queda; lo que falta sale en la siguiente pasada (`sinRevisar` en la respuesta). |
| H6 | Medio (si CallMeBot repite la apikey; no verificado con el servicio real) | `api/_notificar.js:262-270` | El detalle del error de CallMeBot (los últimos 160 caracteres de su respuesta, o el mensaje de un error de red) se guardaba en `salud_notificaciones.ultimo_error` (lo lee **todo** el personal del restaurante, no solo el dueño) y en el log de Vercel. Si traía la apikey, quedaba expuesta (con ella se pueden mandar comandas falsas a ese WhatsApp). | Se tacha la apikey (tal cual y codificada) del detalle antes de guardarlo o imprimirlo. |
| H7 | Medio | `api/crear-pedido.js:43-52`, `api/_notificar.js:130-157` | Un salto de línea en el **nombre** (o en las indicaciones) fabricaba en la comanda de WhatsApp una línea con la forma exacta de un producto (`9x Taco de A — 90.000`): la cocina lo preparaba sin estar pagado. También se aceptaban caracteres invisibles y de dirección (bidi) para disfrazar texto. | Al crear el pedido se quitan controles, ancho cero y bidi de todos los textos; nombre, teléfono, dirección y barrio quedan en una línea; las indicaciones conservan sus saltos (el ticket las imprime como notas) pero en WhatsApp **cada línea** lleva 📝. **Diferencia visible:** una indicación de varias líneas llega a WhatsApp con 📝 en cada línea. |
| H8 | Bajo | `api/crear-pedido.js:130` | Sin tope de líneas por pedido (miles de líneas por petición: base y comandas infladas). Las cantidades sí estaban bien validadas (1 a 50, enteras; ahora con prueba). | Máximo 100 líneas (400). |
| H3 | Bajo (defensa en profundidad) | `api/webhook-wompi.js:183` | El monto se comparaba redondeado a pesos (50 centavos menos pasaban) y no se miraba la moneda. No explotable hoy porque la firma de integridad de Wompi ata monto y moneda. | Centavos exactos y moneda `COP`. |
| H9 | Bajo | `api/_sesion.js:59` | Un token con caracteres fuera de Latin-1 hacía lanzar a `fetch` y el reembolso respondía 500 (con ruido en el log) en vez de 401. | Fuera de ASCII imprimible = sin sesión, sin llegar a la red. |
| H10 | Bajo | `api/restaurante.js:51` | `/api/restaurante` (público) decía `gracia`/`en_gracia`: cualquiera (clientes, competencia) sabía que el restaurante está **atrasado con la mensualidad**. | En gracia responde `activo` (sigue recibiendo pedidos). Si el panel necesita avisar de la gracia, debe salir de un endpoint con sesión. |

**Otras mejoras de las pruebas (no son hallazgos del servidor):** el espía de URLs ahora también rechaza RPC distintas de
`limpiar_pedidos_huerfanos`, filtros `or=`/`and=` y `select` embebidos (joins) — formas de esquivar el filtro que antes no
veía — y cualquier `PATCH` que cambie `restaurante_id` (la llave secreta pasa el trigger que lo impide). El arnés puede retener
una petición a la base (para provocar carreras) y simular errores de red de CallMeBot. Pruebas nuevas de cobertura (pasaban
antes): cantidades inválidas, recorte de textos largos, copia vieja de la resolución vencida a las 6 h, alerta que no se repite,
cron sin `CRON_SECRET`, checksum en mayúsculas (así lo manda Wompi) y de otro largo.

### 13.2 Revisado sin hallazgo

* **Filtro por restaurante:** cada consulta, escritura y RPC de `api/` (incluidos los helpers) lleva `restaurante_id` o es una de
  las excepciones comentadas (búsqueda global por referencia del webhook, `limpiar_pedidos_huerfanos`, tablas que no son de
  negocio). No hay consultas armadas con datos de la petición sin validar ni joins. El servidor no llama `reclamar_impresion`,
  `registrar_reimpresion`, `seguimiento` ni `buscar_mis_pedidos`; las dos primeras dependen de `auth.uid()` y con la llave
  secreta **fallan cerradas** ("No autorizado"): el servidor nunca debe usarlas. `siguiente_numero_pedido` es atómica por
  restaurante y `asignar_numero_pedido` ignora un número que mande un cliente.
* **Resolución del host:** mayúsculas, punto final, puerto, punycode (válido), Unicode/vacío/repetido (404 sin consultar),
  `x-forwarded-host` ignorado, subdominios anidados (404), `DOMINIO_BASE` sin definir (no resuelve por subdominio). La copia
  vieja cuando Supabase falla no salta una suspensión: `crear-pedido` y `generar-firma` releen el restaurante sin caché y, con la
  base caída, fallan (500).
* **Webhook:** secretos del restaurante del pedido, comparación en tiempo constante, referencia desconocida = firma mala (401;
  Wompi reintenta 3 veces y luego desiste, sin efectos), un dueño con sus propios secretos no puede aprobar pedidos de otro.
* **Reembolso y sesión:** autorización contra el restaurante del host (dueño activo o superadmin); cambiar el Host o el cuerpo no
  sirve; doble reembolso imposible; cabeceras `Authorization` repetidas las descarta Node; otros esquemas (Basic) = sin sesión;
  token vencido, de usuario borrado o de sesión cerrada = 401/403 de Auth = sin sesión; 5xx/429/red = 500.
* **Cachés:** el respaldo del menú es por restaurante; las respuestas con datos llevan `Vary: Host` y las de error `no-store`;
  `/api/restaurante` es `no-store`. `sw.js` solo cachea `/Recursos/` y fuentes, por origen (nada de datos ni de `/api/`).
* **Escapes perdidos (como `/s/` por `/\s/`):** se revisaron todas las expresiones regulares de `api/`, `supabase/` y las pruebas
  con un script; la única `/s/` está en `diagnosticar-auth.mjs` y es a propósito. **Trampa nueva encontrada al corregir:** la
  herramienta de edición convirtió escapes `\u200B`–`\uFEFF` en caracteres invisibles **crudos** dentro del fuente (funcionaba
  igual, pero dejaba caracteres bidi ocultos); se reescribieron como escapes y se verificó que ningún archivo los tenga.

### 13.3 Las 6 mutaciones "equivalentes": veredicto

| Mutación | Veredicto |
|---|---|
| `buscarPedidoPorReferenciaGlobal` acepta referencias repetidas | **Confirmada**: `referencia` es `unique` en `schema.sql`. Depende de que la base real tenga esa restricción (ver 13.5, paso 3). |
| `listarRestaurantes` sin orden estable | **Confirmada**: el orden no importa (y ahora el cron empieza por uno al azar a propósito). |
| Subdominio sin validar el formato del slug (una capa) | **Confirmada**: `buscarRestaurantePorSlug` lo vuelve a validar antes de consultar. |
| Subdominio sin validar en ninguna capa | **Confirmada, con matiz**: el valor entra sin codificar a `slug=eq.`, pero solo puede traer `[a-z0-9.-]` (lo garantiza `normalizarHost`) y el `CHECK` del slug prohíbe el punto: ni inyección ni coincidencia. |
| Reembolso sin la comprobación de estado de `reembolso.js` | **Confirmada**: el `PATCH` condicional repite las condiciones; la respuesta sigue siendo 409 (otro texto). |
| Tarifas sin `sort` | **Confirmada**: `order=hasta.asc` sobre `numeric(6,1)` (orden numérico, no de texto). |

Dos candidatas que **parecían** equivalentes no lo eran y ahora tienen prueba: quitar el `toUpperCase()` de la comparación de la
firma rompería **todos** los pagos reales (Wompi manda el checksum en mayúsculas; las pruebas usaban minúsculas) y quitar la
comparación de largos cambia un 401 por un 500. Se declararon 3 equivalentes nuevas, con su razón en el archivo: `Bearer` sin
`^`, un id de Auth que no es UUID y quitar la comprobación de duplicado por lectura del webhook (desde H2 la escritura
condicional es la segunda capa; quitar las dos **sí** se detecta). La corrida también encontró dos pruebas mías que no
distinguían lo que decían probar (alertas en serie y la apikey codificada en la URL); se corrigieron antes de entregar.
Corrida final de `mutaciones-servidor.mjs`: **149 detectadas, 9 equivalentes, 0 sobrevivientes, 0 errores**. Batería local:
`servidor.mjs` 167/167; `probar-servidor-multirestaurante.mjs` contra el falso 154/154.

### 13.4 Pendientes de seguridad

| # | Severidad | Pendiente | Qué hacer |
|---|---|---|---|
| P1 | ~~**Crítico** el día que Taqueiros cobre de verdad~~ **Resuelto en la práctica (sección 14)**; queda un residuo bajo | Taqueiros sin `otros.wompi_modo` sigue aceptando el modo del navegador: un cliente crea el pedido en "pruebas" y lo paga con tarjeta de prueba (el pedido nace en prueba, así que H1 no lo frena). **Ya no hay `WOMPI_MODE` en `index.html`**: la página usa la llave de producción solo si el servidor dice `produccion`, y eso solo ocurre si `otros.wompi_modo` está fijado (y entonces el servidor ignora el modo del navegador). | Para cobrar de verdad: `cargar-secretos.mjs --slug=taqueiros` con `WOMPI_MODO=produccion` (13.5, paso 2, ya **sin** editar `index.html`). Luego retirar del código el respaldo "modo del navegador" de Taqueiros. |
| P2 | **Alto** (configuración) | Los despliegues de Preview reciben la llave secreta y la base real: corren código de cualquier rama contra datos reales, aunque `?r=` ya no esté. | En Vercel → Settings → Environment Variables, dejar `SUPABASE_SERVICE_ROLE_KEY`, `WOMPI_*`, `CALLMEBOT_*` y `CRON_SECRET` **solo en Production**; activar Deployment Protection (Vercel Authentication) para Preview. Si hace falta probar en preview, usar otro proyecto de Supabase. |
| P3 | ~~**Alto** (antes del 2.º restaurante)~~ **Resuelto (sección 14.7)** | `numero` vs `id`: WhatsApp, panel, ticket y seguimiento mostraban `id`. | Hecho: todo lo visible usa `numero` (se prueba con `numero ≠ id`). |
| P4 | Medio | Sin límite de peticiones por IP ni por restaurante en `crear-pedido`/`generar-firma` (ni en `buscar_mis_pedidos`, que inserta un intento por llamada). Un atacante crea miles de pedidos pendientes: consume números de pedido, llena la base compartida (plan gratuito: 500 MB, cae para todos) y multiplica las consultas a Nominatim (riesgo de bloqueo de la IP de Vercel). | Regla de rate limit en el Firewall de Vercel para `/api/crear-pedido` y `/api/generar-firma` (p. ej. 10 por minuto por IP). Decidir el tope por restaurante es de negocio (horas pico). |
| P5 | Medio | Que la caché del borde de Vercel separe dominios (se marcó `Vary: Host`; ya estaba pendiente). | Probar con dos dominios reales antes de vender (`x-vercel-cache` y el menú de cada uno). |
| P6 | Bajo | `wompi_transaction_id` no es único y la firma de Wompi no incluye la referencia: un evento aprobado **real** reenviado con otra referencia del mismo restaurante y el mismo monto la aprobaría. Solo puede hacerlo quien ve los cuerpos de los eventos (Wompi o el propio restaurante, que ya tiene su secreto). | Índice único parcial sobre `wompi_transaction_id`, o consultar la transacción a la API de Wompi antes de aprobar (función nueva). |
| P7 | Bajo | Un evento `VOIDED` (anulación) después de aprobado se ignora como duplicado: el pedido sigue "aprobado". | Decisión de negocio (cómo reflejar anulaciones/reembolsos de Wompi). |
| P8 | Bajo | El webhook espera hasta 8 s a CallMeBot; con Hobby (10 s) puede cortarse: el pedido ya quedó aprobado (el reintento de Wompi se corta como duplicado) pero `notificacion_ok` puede quedar vacío. | Aceptado; el panel es el canal principal. |
| P9 | Bajo | Sesiones para el futuro panel de superadmin: un usuario **baneado** en Auth conserva su token hasta que vence (~1 h); `_sesion.js` no mira MFA (`aal`); si se activan los inicios de sesión anónimos, dan sesiones válidas. | Autorizar siempre por tabla (`superadmins`/`miembros`, se mira en cada petición) y quitar de ahí para revocar al instante; exigir `aal2` en el panel de superadmin. |
| P10 | Bajo | El log de Vercel guarda datos personales (errores de PostgREST con "Failing row contains (...)", nombres y referencias). | Tratar el acceso al log de Vercel como acceso a datos de clientes. |
| P11 | Bajo | Si dos restaurantes cargan el mismo secreto de eventos (misma cuenta de Wompi), cada dueño puede aprobar pedidos del otro. | No compartir cuentas de Wompi entre restaurantes; (futuro) que `cargar-secretos.mjs` avise de secretos repetidos. |
| P12 | Bajo | Con `DOMINIO_BASE` (comodín), subdominios inventados: cada uno es una consulta (caché negativa de 10 s) y desplaza entradas buenas de la caché de 500; y 200/404 revela qué slugs existen (inherente: son sitios públicos). | Aceptado. |
| P13 | Bajo | Ventana de milisegundos entre la relectura del restaurante y el insert: un pedido puede entrar justo al suspender. `seguimiento(ref)` sigue siendo global por referencia (impredecible); `?clave=` del cron sigue aceptándose. *(Retirado en la sección 19.8.)* | Aceptado / tarea del front (ya listados en 12.11). |

### 13.5 Qué correr (Windows) y qué cambia en Vercel

Nada de esto toca la base real salvo el paso 3 (solo lectura) y el 2 (solo cuando decidas cobrar de verdad).

1. **Vercel (P2 y H4):** si alguna vez quieres probar un preview con `?r=`, agrega `RESTAURANTE_POR_PARAMETRO` = `1` **solo**
   en el entorno *Preview*. Revisa que las llaves estén marcadas solo para *Production* (P2).
2. **Antes de cobrar de verdad en Taqueiros (P1):** en PowerShell, en la carpeta del proyecto:

   ```powershell
   $k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
   $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
   $env:WOMPI_MODO = "produccion"
   node supabase/cargar-secretos.mjs --slug=taqueiros --solo-verificar
   node supabase/cargar-secretos.mjs --slug=taqueiros
   Remove-Item Env:WOMPI_MODO, Env:SUPABASE_SERVICE_ROLE_KEY
   ```

   (si dice `DIFERENTE a la base`, repite el último `node` con `--sobrescribir`). Los secretos **prod** de integridad y de
   eventos deben existir (en la base o, para Taqueiros, en las variables de Vercel): sin ellos no se podrá cobrar. Solo
   después cambia `WOMPI_MODE` en `index.html`.
3. **Comprobar la restricción única de `referencia` en la base real** (SQL Editor, "Run without RLS", solo lectura):

   ```sql
   select conname, pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.pedidos'::regclass and contype = 'u';
   ```

   Debe aparecer `UNIQUE (referencia)`.
4. **Prueba del servidor contra la base real** (como en 12.9 paso 5): `node supabase/probar-servidor-multirestaurante.mjs`.
   Ahora son más escenarios (≈154 contra el falso en modo real); todos deben decir `PASA`.

---

## 14. Frontend público multi-restaurante (SQL 12)

Hasta la sección 13 el **servidor** ya era multi-restaurante, pero las páginas públicas seguían siendo de Taqueiros:
tenían escritos a mano su nombre, colores, logo, textos, WhatsApp, coordenadas, tarifas, llave pública de Wompi y
`WOMPI_MODE`, y mostraban `pedidos.id` en vez de `pedidos.numero`. Esta sección es ese trabajo: `index.html`,
`pedido.html`, el manifest de la PWA y todo lo que muestra el número de pedido leen sus datos del restaurante que resuelve
el servidor por el dominio. **Taqueiros se ve igual** (se comprueba, ver 14.10). El panel de administración
(`panel.html`, `menu-admin.html`, `historial.html`, `marca.js`) se adapta en el paso siguiente; aquí solo cambió lo que
muestra el número de pedido.

### 14.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/12-config-publica.sql` (nuevo) | Mezcla en `restaurantes.config` de Taqueiros los valores que estaban escritos a mano (no pisa nada); agrega `pedidos.token_seguimiento` y `pedidos.enlace_por_referencia` (sin `UPDATE`); `seguimiento(ref)` y `buscar_mis_pedidos(...)` devuelven `numero` y el token; trigger que impide cambiar el token desde el navegador. Atómico, idempotente, 24 comprobaciones OK/FALLA, apto para "Run without RLS". |
| `api/_publico.js` (nuevo) | Arma la respuesta pública **campo por campo y validando** (colores `#RRGGBB`, URLs, teléfonos, textos). Es la única puerta de datos hacia el navegador. |
| `api/restaurante.js` | Devuelve marca, textos, contacto, ubicación, tarifas de domicilio, módulos, servicio y el modo/llave **pública** de pago (14.4). |
| `api/_respaldo-taqueiros.js` (nuevo) | La **única** copia que queda en el código de los valores de Taqueiros: solo para Taqueiros y solo para lo que su `config` aún no trae (campo por campo), con aviso en el log. Se puede borrar cuando el SQL 12 esté corrido. |
| `api/manifest.js` (nuevo) + `vercel.json` | El manifest de la PWA es por restaurante: `/manifest.json` se reescribe a `/api/manifest`. El archivo estático `manifest.json` se eliminó (en Vercel un archivo estático gana a una reescritura). |
| `restaurante-publico.js` (nuevo) | Librería compartida por `index.html` y `pedido.html`: carga `/api/restaurante`, **re-valida**, aplica colores y logos, textos neutros, pantalla de "sin restaurante", almacenamiento por restaurante. |
| `index.html`, `pedido.html` | Sin ningún valor de un restaurante escrito. Se pintan con los datos que llegan (14.5). |
| `sw.js` v9 | No precachea nada; el manifest va siempre por la red; sube la versión (14.6). |
| `api/crear-pedido.js` | Además devuelve `tokenSeguimiento` (14.8). Nada más cambió. |
| `api/_notificar.js`, `api/alertas.js` | La comanda y la alerta de WhatsApp llevan `pedidos.numero` (14.7). |
| `ticket-comanda.js`, `panel.html`, `historial.html` | Muestran `numero` (14.7). El diseño del ticket y de la impresión **no** cambió. |

### 14.2 Inventario de los valores de Taqueiros que estaban escritos a mano

| Valor | Antes | Ahora |
|---|---|---|
| Nombre (título, cabecera, pie, alt, mensajes, tooltip del mapa, texto del WhatsApp) | `index.html`, `pedido.html`, `manifest.json` | `restaurantes.nombre` |
| Título y descripción de la página | `index.html` | `config.publico.textos.titulo_pagina` / `descripcion_pagina` (el seguimiento los arma con el nombre) |
| Logo y favicon | `Recursos/logo/logo.png` en 5 sitios | `config.publico.marca.logo` (favicon = logo) |
| Íconos de la PWA | `manifest.json` | `marca.icono_192` / `icono_512` (si faltan, el logo) |
| 10 colores de marca + `texto_tenue` y `positivo_brillo` (pedido) | `:root` de `index.html` y `pedido.html` | `marca.colores.*` → variables CSS. Las transparencias (`rgba(…)`) pasaron a `rgba(var(--x-rgb), …)` con el mismo resultado |
| Colores de las zonas del mapa | `COLORES_ZONA` | `marca.colores_zonas` |
| Emoji (🌮 en confirmación, mapa, carrito vacío, WhatsApp, menú caído, botón "Ver el menú") | repartido en el código | `marca.emoji` (neutro: 🍽️) |
| Eslogan, texto de portada, texto del pie, línea de servicios, cierre del pie, ejemplo de nota | `index.html` | `textos.eslogan`, `tagline`, `descripcion_pie`, `servicios_linea`, `pie_final`, `ejemplo_nota` |
| Banner de abierto/cerrado ("¡Estamos que ardemos!…") | `index.html` | `textos.banner_abierto_*`, `banner_cerrado_*` |
| Tiempos y frases del seguimiento ("Ya está en el comal…") | `pedido.html` | `textos.seguimiento.*` |
| WhatsApp (botones, pie, mensajes, seguimiento) | `WHATSAPP_NUMBER` en 2 páginas | `contacto.whatsapp` |
| Teléfono visible, dirección, dirección corta (retiro), ciudad y región (Wompi), Instagram y TikTok | `index.html`, `pedido.html` | `contacto.*` |
| Coordenadas del local | `RESTAURANTE` | `config.ubicacion` (el mismo dato que ya usaba el servidor) |
| Tarifas de domicilio | `TARIFAS_DOMICILIO` | `tarifas_domicilio` (tabla) → `domicilio.tarifas` |
| Factor de recorrido, área y pin mínimo | `FACTOR_RECORRIDO`, `api/_ubicacion.js` | `config.domicilio` |
| Llave pública de Wompi (test y prod) | `WOMPI_PUBLIC_KEY` | `config.publico.wompi` → solo sale la del modo vigente |
| `WOMPI_MODE` | `index.html` | `restaurante_secretos.otros.wompi_modo` (lo decide el servidor) |
| URL de retorno de Wompi | `https://taqueiros-2-0.vercel.app/?pago=exitoso` | `location.origin + "/?pago=exitoso"` |
| Horarios de respaldo (`SCHEDULE`) | `index.html` | **eliminado**: el horario sale de `/api/estado` (sin respuesta no se inventa) |
| Nombre y descripción de la PWA | `manifest.json` | `/api/manifest` (`config.publico.pwa`, `marca.colores`) |
| Claves de `localStorage` | `taqueiros-*-v1` | `menu-v2`, `carrito-v2`, `seguimiento-v2`, `pedido-pendiente-v2` (genéricas y con el id del restaurante dentro) |

Residuos que **no** son datos de un restaurante y se dejaron (documentados): las tipografías (Anton / Fredoka / Libre
Franklin), unos cuantos grises cálidos de interfaz (`#5a4a3a`, `#8a7a63`, `#6b5c4c`, `#150d0b`, `#e9dcbb`…) que no son
colores de marca, el nombre del objeto global `TAQUEIROS_SUPABASE` (de `supabase-publico.js`, compartido con el panel) y el
pie `LOS TAQUEIROS · PEDIDO WEB` del ticket impreso (`ticket-comanda.js`), que es del panel (paso siguiente).

### 14.3 Forma del JSON de configuración (`restaurantes.config`)

El dueño edita `nombre` y `config`; el resto de la fila es de Carlos. `config` es un objeto; **solo** lo de abajo llega al
navegador, y solo validado. Todo es opcional: lo que falta se ve neutro.

```jsonc
{
  "publico": {                                  // lo que puede ver el navegador
    "marca": {
      "logo": "Recursos/logo/logo.png",         // ruta del sitio o https del Supabase del proyecto (Storage)
      "icono_192": "...", "icono_512": "...",   // PWA; si faltan se usa el logo
      "emoji": "🌮",                            // hasta 8 caracteres
      "colores": {                              // #RRGGBB exacto; lo inválido se descarta
        "primario": "#C1272D", "primario_oscuro": "#8A1B1F", "primario_brillo": "#E14A42",
        "claro": "#F7ECD6", "claro_suave": "#FFF8EA", "oscuro": "#1C1210", "oscuro_2": "#241714",
        "acento": "#E3A008", "positivo": "#5C7A3B", "texto_secundario": "#D9C9A8",
        "texto_tenue": "#B9A88C", "positivo_brillo": "#7FA855"
      },
      "colores_zonas": ["#5C7A3B", "#8FA83F", "#E3A008", "#E07B39"]   // hasta 8
    },
    "textos": {                                 // texto plano de una línea, hasta 400 caracteres
      "titulo_pagina": "...", "descripcion_pagina": "...", "eslogan": "...", "tagline": "...",
      "descripcion_pie": "...", "servicios_linea": "...", "pie_final": "...", "ejemplo_nota": "...",
      "banner_abierto_icono": "🔥", "banner_abierto_titulo": "...",
      "banner_abierto_texto": "Ahorita sí estamos atendiendo pedidos{cierre}. ...",   // {cierre} = " — hoy hasta las 10:30 p. m." o vacío
      "banner_cerrado_icono": "🌮", "banner_cerrado_mensaje": "...",                   // si el dueño no escribió su mensaje de cerrado
      "seguimiento": {                          // pedido.html; hasta 200 caracteres
        "tiempo_nuevo": "...", "tiempo_preparacion": "...", "tiempo_camino": "...",
        "tiempo_recoger": "...", "tiempo_entregado": "...",
        "frase_nuevo": "...", "frase_preparacion": "...", "frase_camino": "...",
        "frase_recoger": "...", "frase_entregado": "..."
      }
    },
    "contacto": {
      "whatsapp": "573125249438",               // solo dígitos (8 a 15); sin él no hay botones de WhatsApp
      "telefono": "+57 312 524 9438", "direccion": "...", "direccion_corta": "...",   // la corta sale en el seguimiento (retiro)
      "ciudad": "...", "region": "...",         // los usa el widget de Wompi
      "instagram": "usuario", "tiktok": "usuario"       // sin @; letras, números, punto y guion bajo
    },
    "wompi": {                                  // llaves PUBLICAS (pub_...): públicas por diseño
      "llave_publica_test": "pub_test_...", "llave_publica_prod": "pub_prod_..."
    },
    "pwa": { "nombre": "Panel Taqueiros", "nombre_corto": "Comandas" }   // manifest; por defecto "Panel <nombre>" / "Comandas"
  },
  "ubicacion": { "lat": 7.8997382, "lng": -72.4968525 },                 // origen del domicilio (no sale tal cual: ver 14.4)
  "domicilio": { "factor_recorrido": 1.3, "pin_minimo_metros": 100,
                 "area": { "latMin": 7.75, "latMax": 8.1, "lngMin": -72.68, "lngMax": -72.35 } }   // ya los usa el servidor
}
```

Reglas: la llave pública del modo vigente solo se entrega si es del tipo del modo (`pub_test_` para prueba, `pub_prod_`
para producción) y el servidor tiene el secreto de integridad para firmar; **nunca** se guarda aquí una llave privada, un
secreto de integridad/eventos ni una apikey (el SQL 12 se detiene si encuentra algo así en la config de Taqueiros). Las
imágenes: ruta relativa del sitio (sin `..`, sin `//`, sin `:`) o `http(s)` del origen del Supabase del proyecto; ninguna
otra. El nombre del restaurante es `restaurantes.nombre` (columna), no va aquí.

### 14.4 `/api/restaurante`: la respuesta

```jsonc
{ "id": "...", "slug": "...", "nombre": "...", "zona_horaria": "America/Bogota", "moneda": "COP",
  "modulos": { "pasarela": true, "seguimiento": true, "comandas": true, "impresion": true },
  "servicio": { "estado": "activo" | "suspendido", "sirve": true, "motivo": null | "servicio_suspendido" },
  "marca": { "logo", "icono_192", "icono_512", "emoji", "colores": {...}, "colores_zonas": [...] },
  "textos": { ..., "seguimiento": {...} },
  "contacto": { "whatsapp", "telefono", "direccion", "direccion_corta", "ciudad", "region", "instagram", "tiktok" },
  "ubicacion": { "lat", "lng" } | null,
  "domicilio": { "ofrece": true, "factor_recorrido": 1.3, "tarifas": [{ "hasta": 2, "precio": 5000 }, ..., { "hasta": 999, "precio": null }] },
  "pago": { "disponible": true, "pasarela": "wompi", "modo": "test" | "produccion" | null, "llave_publica": "pub_..." | null } }
```

* **Nunca** devuelve plan, modalidad de pago, vigencia, días de gracia (en gracia dice `activo`), el resto de `config`,
  ni nada de `restaurante_secretos` (se consulta solo **si hay** modo y secreto de integridad; no se devuelve ni se guarda),
  ni de `miembros`. `Cache-Control: no-store`.
* Un restaurante **sin tarifas o sin ubicación** no ofrece domicilio (`ofrece: false`): la página esconde esa opción.
* **El modo de cobro y la llave los decide el servidor** (`otros.wompi_modo`; `modoDePago` sin el modo del navegador). Para
  Taqueiros sin `wompi_modo` el resultado es `test` (lo mismo que decía `WOMPI_MODE = "pruebas"`). Otro restaurante sin
  `wompi_modo` queda con `pago.disponible = false`: solo se ve el menú y WhatsApp.
* La página manda a `crear-pedido` el mismo modo que el servidor le dijo (nunca uno elegido por ella).

### 14.5 Cómo se pinta el front

1. La página se abre con una **pantalla de carga** (tapa todo) y pide `/api/restaurante`. Si llega: se aplican colores
   (variables CSS), logos, textos, enlaces y módulos, y se quita la pantalla. Un `?r=<slug>` en la URL (previews, ver 12.2)
   se reenvía a todas las llamadas a la API; en producción el servidor lo ignora.
2. Si **falla** (dominio desconocido, servidor caído, respuesta inválida) la pantalla se convierte en un **mensaje neutro**
   ("Este sitio no está disponible" con 404; "No pudimos cargar la página" + *Reintentar* con otro fallo), con paleta neutra
   y sin un solo dato de ningún restaurante, tampoco de Taqueiros. Nunca hay valores por defecto de otro restaurante.
3. **Servicio suspendido:** el menú se ve; se esconden "Pagar en línea" y "Pedir por WhatsApp" y aparece el mensaje neutro
   "Este restaurante no está recibiendo pedidos en este momento." (sin hablar de la mensualidad). `crear-pedido` además
   responde 403 `servicio_suspendido`, y la página lo trata igual.
4. **Módulos** (`modulos`): sin `seguimiento` se esconden "Mi pedido", "¿Buscas tu pedido?", el banner y el enlace de la
   confirmación, y `pedido.html` avisa que no está disponible; sin `pasarela` (o sin llave/secreto) no hay "Pagar en línea";
   sin WhatsApp no hay botones de WhatsApp; sin domicilio configurado no se ofrece domicilio. No se inventan flujos nuevos.
5. **Seguridad.** Todo dato que viene de la base se inserta con `textContent` o con atributos ya validados; nunca con
   `innerHTML` (incluidos el mensaje de "cerrado", los días del horario y el tooltip del mapa, que antes eran HTML crudo).
   Los colores se validan con `^#[0-9A-Fa-f]{6}$` en el servidor **y** en el navegador y se aplican con `setProperty`; las
   imágenes solo son rutas del sitio o del origen del Supabase del proyecto (nada de `javascript:` ni `data:`); WhatsApp,
   redes y llaves por formato. Verificado en el navegador con datos hostiles (14.10).
6. **Almacenamiento del navegador.** `localStorage` es **por origen** (esquema + dominio + puerto): dos restaurantes en dos
   dominios no comparten nada (confirmado en las pruebas con `alfa.localhost` y `beta.localhost`). Aun así el menú de
   respaldo, el carrito, el seguimiento y el resumen del pago pendiente se guardan con el id del restaurante y se descartan si
   no coincide (un mismo origen que sirviera a dos restaurantes, como un preview con `?r=`, tampoco los mezcla). Las claves
   viejas `taqueiros-*-v1` ya no se leen: un cliente con un carrito a medio armar en el momento del despliegue lo verá vacío
   una sola vez.
7. **Lo que cambió a propósito para Taqueiros** (todo lo demás es idéntico): los pedidos *nuevos* se siguen por un enlace con
   token (14.8); sin respuesta de `/api/estado` el banner de horario no se inventa (antes mostraba un horario escrito en el
   código) y se deja pedir (el servidor valida el horario al crear el pedido); el mensaje de "cerrado", los días del horario
   y el nombre ya no se pegan como HTML.

Limitación conocida (**resuelta en la sección 17.3**): el título y la descripción los pone JavaScript, así que una vista previa de enlace (WhatsApp, redes)
que no ejecuta JS veía el título neutro "Pedidos en línea". Ahora los rastreadores reciben la página con las etiquetas `og:` del restaurante.

### 14.6 PWA y service worker

* `/manifest.json` lo sirve `api/manifest.js` según el dominio (nombre, nombre corto, descripción, colores e íconos del
  restaurante, validados igual que en 14.4). Host desconocido: 404 con el mismo cuerpo que el resto. Taqueiros recibe
  **exactamente** el manifest de antes (se compara en las pruebas).
* `sw.js` v9: **no precachea nada** (ni el manifest, que ahora cambia por restaurante, ni un logo fijo); `/manifest.json`,
  `/api/*` (incluidos `/api/restaurante` y `/api/menu`), Supabase y las páginas van **siempre por la red**. Solo se guarda lo
  que se pide bajo `/Recursos/` y las fuentes, y el caché es por origen (un dominio nunca ve el de otro). Al subir la versión
  se borran las cachés `taqueiros-panel-v8` que traían precacheados el manifest y el logo de Taqueiros.
* `panel.html` sigue enlazando `/manifest.json`: no hubo que tocarlo.

### 14.7 Número de pedido: `numero`, no `id`

`id` es la secuencia de **toda** la tabla (compartida por todos los restaurantes); `numero` es el contador de **cada**
restaurante. Con un solo restaurante coinciden (salvo huecos); con el segundo divergen. Ahora todo lo que ven el cliente o el
personal usa `numero` (si una fila no lo trae, por seguridad se usa el `id` para no imprimir `#undefined`); las operaciones
internas siguen usando `id`.

| Dónde | Antes | Ahora |
|---|---|---|
| "¿Buscas tu pedido?" (`buscar_mis_pedidos`) | devolvía `p.id` como `numero` | devuelve `p.numero` (SQL 12) |
| Seguimiento (`seguimiento(ref)` → `pedido.html`) | `p.id` como `numero` | `p.numero` (SQL 12) |
| Comanda de WhatsApp y alerta "sin atender" | `pedido.id` | `pedido.numero` |
| Ticket de comanda, reimpresión, prueba (`ticket-comanda.js`) | `p.id` | `p.numero` |
| Tablero, avisos y cronómetros del panel (`panel.html`) | `p.id` | `p.numero` |
| Historial (`historial.html`; `buscar_historial` ya devolvía la fila completa) | `p.id` | `p.numero` |
| Confirmación del pedido (`index.html`) | muestra la **referencia** (nunca mostró un número) | sin cambio (a propósito: es lo que ve hoy Taqueiros) |

Prueba de que **la impresión no cambió**: `node pruebas/impresion/comparar-tickets.mjs` imprime los mismos 7 tickets
(normal, 12 productos con notas largas, nombres y direcciones largos, ñ y tildes, HTML hostil, reimpresión, prueba) con el
panel de `debc1c5` y con el de ahora y compara el HTML letra por letra: **7 de 7 idénticos** (solo se normalizan las horas).
Además hay pruebas unitarias (con `numero = id` el ticket es idéntico) y el escenario 21 del e2e (con `numero ≠ id` el
tablero, el ticket y la reimpresión muestran el número).

### 14.8 Enlace de seguimiento: decisión

**Hallazgo.** El enlace no usa un id secuencial: usa la referencia `TAQ-<milisegundos>-<6 hex>`. No es adivinable en la
práctica (sin saber el milisegundo exacto hay ≈10¹² combinaciones por minuto), pero solo tiene 24 bits de azar y su
parte temporal es predecible; `seguimiento` no tiene límite de intentos. Severidad: **baja**, pero es la puerta a la
dirección, las indicaciones y los productos de un cliente.

**Corrección aplicada (SQL 12).** `pedidos.token_seguimiento`: 32 caracteres hexadecimales al azar (un UUID v4 sin guiones,
122 bits), único e inmutable desde el navegador. `crear-pedido` lo devuelve (`tokenSeguimiento`), la confirmación, el banner
y "¿Buscas tu pedido?" arman el enlace con él, y `seguimiento(ref)` abre un pedido por su token. **Compatibilidad:**
`pedidos.enlace_por_referencia` vale `true` en los pedidos que ya existían (su enlace de siempre, la referencia, **sigue
funcionando**; además reciben su token) y `false` en los nuevos (la referencia sola ya no abre nada). Las columnas se
agregan sin `UPDATE` (sin triggers ni eventos de Realtime). Ni `seguimiento` ni `buscar_mis_pedidos` cambiaron de firma (el
SQL 10 las conoce por su firma y la comprobación "ninguna función SECURITY DEFINER desconocida" sigue valiendo).

Costos y límites, a la vista: (1) una pestaña de un cliente abierta **antes** del despliegue que cree un pedido después del
SQL 12 verá "No encontramos ese pedido" en el seguimiento hasta recargar (el pedido llega igual al restaurante, y
"¿Buscas tu pedido?" le da el enlace bueno); por eso conviene correr el SQL 12 justo después de desplegar. (2) El personal
del restaurante (que ya ve teléfono y dirección de sus clientes) también lee el token en su panel. (3) No se agregó límite de
intentos a `seguimiento` (con 122 bits no hace falta; el límite por IP sigue siendo el pendiente P4).

### 14.9 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` (no se ven al pegarlas): pega
**UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos). Nada de esto toca la base real salvo el paso 2.

**1. Despliegue.** Al subir a `main`, Vercel despliega solo. Con el SQL 12 sin correr, Taqueiros se ve igual (el servidor usa
sus valores de respaldo y el log avisa `[Publico] Taqueiros usa N valores de respaldo`). Abre
`https://taqueiros-2-0.vercel.app/api/restaurante` (debe mostrar la marca, textos, tarifas y la llave **pública**; ningún
secreto) y `https://taqueiros-2-0.vercel.app/manifest.json`.

**2. SQL 12.** VS Code → abre `supabase/12-config-publica.sql` → **Ctrl+A, Ctrl+C** → Supabase → SQL Editor → New query →
pega → **"Run without RLS"**. Resultado esperado: **24 filas, todas `OK`**. Si algo falla verás `MR paso n: ...` o `LA
MIGRACION 12 SE REVIRTIO` con la lista, y no se cambió nada. Se puede repetir. No vuelvas a correr el SQL 10 después (recrearía
`buscar_mis_pedidos` con su versión anterior; correr el 12 otra vez la repone).

**3. Verificación contra la base real (solo lectura salvo las pruebas que crean y borran sus propios restaurantes).**

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs                    # esperado: 26 PASAN
node supabase/probar-servidor-multirestaurante.mjs         # esperado: todos PASA (≈173), "Limpieza: todo lo creado se borro."
node supabase/probar-aislamiento.mjs                       # esperado: todas PASA (con Realtime real)
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

**4. Recorrido a mano en producción** (lo único que ninguna prueba automática reemplaza): el menú se ve igual que antes
(nombre, logo, colores, pie); armar un pedido y pagarlo con Wompi **sandbox** (la pantalla de confirmación, el enlace de
seguimiento ahora trae un código largo, "Seguir mi pedido" funciona); "¿Buscas tu pedido?" con ese celular y total
(muestra "Pedido #N" con el número de Taqueiros y su enlace abre el seguimiento); en el panel: el pedido aparece con su
número, suena, imprime y **Reimprimir** (mismo ticket); historial y menú-admin. En un equipo con el panel instalado,
recarga una vez: toma `sw.js` v9. En Chrome → F12 → Application → Manifest: nombre `Panel Taqueiros`.

**5. Cuando quieras cobrar de verdad.** Ya **no** se edita `index.html`: el modo lo decide el servidor. Fija
`WOMPI_MODO=produccion` (y los secretos prod) con `cargar-secretos.mjs --slug=taqueiros` como en 13.5 paso 2; la página
pasa sola a la llave `pub_prod_` de `config.publico.wompi`. Mientras no lo fijes, la página (y el servidor) siguen en pruebas.

**6. Dar de alta un restaurante nuevo** (se suma a 12.8): después de crearlo, llenar su `config.publico` con el JSON de 14.3
(en Supabase → Table editor → `restaurantes` → `config`, o con `update public.restaurantes set config = '...'::jsonb where slug = '...'`),
cargar su `tarifas_domicilio`, `wompi_modo` y llaves, y su dominio en `restaurante_dominios` y en Vercel. Con
`config` vacío el sitio funciona y se ve neutro.

### 14.10 Qué se probó y qué no

**Probado por mí (local, sin tocar la base real):**

* `config-publica.mjs` (nuevo): **49** — el SQL 12 sobre una base con el SQL 10 y el 11, dos veces y tras re-correr el 10;
  pedidos existentes intactos (id, numero, `actualizado_en`, sin `UPDATE`); enlaces viejos siguen sirviendo y los nuevos solo con
  token; `numero` y token en `seguimiento`/`buscar_mis_pedidos`; el token no se cambia desde el navegador; la mezcla no pisa
  nada y no toca a otros restaurantes; el JSON del SQL = el de `_respaldo-taqueiros.js`; y **17 mutaciones** del propio SQL 12
  (todas detectadas).
* `servidor.mjs`: **186** (167 de antes, 2 adaptadas al nuevo formato y 19 nuevas: marca/tarifas/llaves de cada restaurante sin
  cruces, datos hostiles, modos de pago y llave del otro modo, sin datos = neutro, respaldo solo de Taqueiros, manifest, número
  en WhatsApp y alertas, token). También pasa con `SQL12_NO=1` (el código nuevo antes del SQL 12).
* `front.mjs` (nuevo, Chrome sin interfaz sobre los manejadores reales y el Supabase falso): **104** — dos restaurantes en dos
  dominios (cada uno su nombre, colores, logo, textos, menú, tarifas, llave y número; ninguno ve datos del otro); dominio
  desconocido y servidor caído = mensaje neutro; **datos hostiles** (HTML, `onerror`, `<script>`, CSS, `javascript:`, bidi en
  nombre, textos, contacto, mensaje de cerrado, horario, menú, frases del seguimiento) no se ejecutan ni se inyectan, **y aunque el
  servidor (o un intermediario) mandara esos datos SIN validar el navegador los descarta** (escenario 3b); suspendido, módulos apagados y
  sin datos; flujo de pago con un Wompi simulado (llave, monto, firma con el secreto del restaurante, redirección al origen,
  enlace con token); almacenamiento por restaurante; y **Taqueiros idéntico** a como estaba en `debc1c5`: 603–627 elementos
  comparados con su texto, atributos y **estilos calculados** en 6 estados de la página (portada, carrito, formulario de pago,
  buscar mi pedido con resultados, seguimiento y cerrado), más las tarifas, coordenadas, llave y modo.
* **Revisión por mutación del frontend** (`mutaciones-front.mjs`, nuevo): rompe a propósito 38 defensas de `index.html`, `pedido.html` y
  `restaurante-publico.js` (cada `textContent` vuelto `innerHTML`, cada validador, el token, `p_restaurante`, el modo de cobro, módulos,
  servicio suspendido, almacenamiento por restaurante…): **36 detectadas, 2 equivalentes declaradas con su razón, 0 sobrevivientes**
  (la primera corrida dejó pasar 2: una prueba cuyo dato hostil no distinguía la defensa —se corrigió— y una defensa en capas).
  **Revisión por mutación del servidor** (`mutaciones-servidor.mjs`, 26 mutaciones nuevas sobre `_publico.js`, `manifest.js`,
  número y token, y las 5 de `restaurante.js` reapuntadas): **25 detectadas, 1 equivalente, 0 sobrevivientes**; la primera pasada dejó
  pasar 3 (URL con usuario y clave, llave de pago con formato roto, y una mutación mal formulada) y se agregaron los datos hostiles
  que faltaban. **La corrida completa de las ~175 mutaciones anteriores del servidor (cuyo código no cambió) no se terminó en esta sesión**: llegó a 111 detectadas y 0 sobrevivientes antes de quedarse sin tiempo. Volver a correrla completa y a solas (`node pruebas/multirestaurante/mutaciones-servidor.mjs`, ~25 minutos) antes de dar por cerrada esta fase.
* `comparar-tickets.mjs`: 7/7 tickets idénticos (14.7). `ticket-comanda.test.js`: 67 unitarias en total (3 nuevas).
  `e2e.js` del panel: **180** comprobaciones (173 de antes + 7 del escenario 21 nuevo, número ≠ id).
* Baterías anteriores, todas verdes: `rls.mjs` 234, `hallazgos.mjs` 32, `planes.mjs` 11, `sim.mjs` (34 OK, con y sin
  `conPendientes`), `dominios.mjs` 35, `cargar-secretos-test.mjs` 20, `probar-compatibilidad` contra el falso 26,
  `probar-servidor-multirestaurante` contra el falso 173 y `probar-aislamiento` contra el falso 231 de 238 (las 7 que fallan son
  las de Realtime, que el falso no emula, igual que antes). Cambiaron solo las que dependían de lo que ahora cambia: las dos
  pruebas del formato de `/api/restaurante`, `probar-compatibilidad` (mismo motivo) y `probar-aislamiento` (un pedido nuevo se
  abre con su token).

**Solo se pueden probar contra la base real o en producción (pendiente de Carlos):** el SQL 12 sobre el esquema verdadero
(paso 2); las tres verificaciones del paso 3; que Vercel respete la reescritura `/manifest.json` → `/api/manifest` (con el
archivo estático ya borrado) y el caché del borde por dominio (P5); el widget **real** de Wompi (las pruebas usan uno
simulado) y un pago sandbox de punta a punta; la impresora física; que `taqueiros-2-0.vercel.app` en el navegador real
(Chrome lo fuerza a HTTPS por la lista HSTS del dominio `.app`, por eso las pruebas usan `taqueiros.localhost` para Taqueiros).

### 14.11 Riesgos y pendientes para el paso siguiente (panel y administración)

1. ~~`panel.html`, `menu-admin.html`, `historial.html`, `marca.js` y el pie del ticket siguen con la marca de Taqueiros escrita.~~
   **Resuelto en la sección 15.** Queda pendiente, para 2B-4, el aviso de **gracia** en el panel (no es público, ver H10): ver 15.11.
2. ~~`menu-admin.html` inserta sin `restaurante_id` y sube las fotos a la raíz del bucket.~~ **Resuelto en la sección 15**: manda
   `restaurante_id` y sube a `{restaurante_id}/`. Falta retirar el defecto transitorio y la regla de la raíz del bucket (2B-4).
3. El dueño ya puede escribir `config.publico` desde su panel (la política de `restaurantes` se lo permite): el panel de
   administración necesita un formulario con las mismas validaciones (colores, URLs, textos). Las del servidor y el navegador
   descartan lo inválido, pero el formulario debería avisar.
4. Con muchos restaurantes, `/api/restaurante` hace dos consultas extra por visita (tarifas y modo de cobro; se pueden pedir en
   paralelo y ya lo están). Si pesa, ponerle un caché de borde corto **después** de verificar `Vary: Host` con dos dominios (P5).
5. ~~Las vistas previas de enlace no ejecutan JavaScript (14.5)~~ **Resuelto en la sección 17.3.**
6. P1 (13.4): el interruptor de producción pasó del navegador al servidor; mientras `otros.wompi_modo` no esté fijado para
   Taqueiros, `crear-pedido` todavía acepta el modo que mande el navegador (la página ya no lo elige). Fijarlo y retirar ese
   respaldo cuando se cobre de verdad.
7. ~~`TAQUEIROS_SUPABASE` (nombre del objeto global) y las tipografías siguen siendo de Taqueiros~~ **Resuelto en la sección 15**
   (`SUPABASE_PUBLICO`; tipografías por restaurante con lista permitida).
8. ~~**Límite de funciones de Vercel:**~~ **Resuelto en la sección 17.2 (ahora son 6 de 12).** *(Texto original:)* `api/manifest.js` era la función número **11** (las que no empiezan con `_`: alertas,
   crear-pedido, disponibilidad, estado, generar-firma, keep-alive, manifest, menu, reembolso, restaurante, webhook-wompi). El plan
   Hobby permite 12 por despliegue: la siguiente que se agregue obliga a juntar endpoints o a cambiar de plan.

---

## 15. Paneles del personal por restaurante (panel, menú, historial, ticket)

Hasta la sección 14 el **servidor** y las **páginas públicas** ya eran por restaurante, pero las páginas **privadas** del
personal (`panel.html`, `menu-admin.html`, `historial.html`, `marca.js`, el pie del ticket y `sw.js`) seguían con la marca de
Taqueiros escrita y asumían un solo restaurante: el panel tomaba "la primera membresía" del usuario, `menu-admin` insertaba sin
`restaurante_id` (caía en Taqueiros por el defecto transitorio) y subía las fotos a la raíz del bucket. Esta sección es ese
trabajo. **No cambia el servidor revisado (webhook, crear-pedido, reembolso, sesión, alertas), ni las URL de servicios externos
(webhook de Wompi, cron), ni la base de datos**: no hay SQL nuevo. **Taqueiros se ve y funciona igual** (se comprueba, ver 15.10).

### 15.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `panel-restaurante.js` (nuevo; **reemplaza a `marca.js`**, que se borra) | Una sola copia para las tres páginas: pide `/api/restaurante` (el servidor decide el restaurante por el **Host**), pinta la marca (nombre, logo, favicon, colores, tipografías de una lista, color de la barra del navegador), comprueba la **membresía** del usuario en ese restaurante antes de pedir un solo dato, muestra el rol, vuelve a comprobarla de vez en cuando y migra las preferencias del equipo. |
| `panel.html`, `menu-admin.html`, `historial.html` | Sin ninguna marca escrita (paleta neutra por defecto + telón de carga, igual que `index.html`/`pedido.html`). Toda consulta, escritura, canal de Realtime y llamada a función SQL lleva el restaurante **explícito** (15.4). Las fotos nuevas van a `{restaurante_id}/`. |
| `ticket-comanda.js` | El pie ya no está escrito: es el nombre del restaurante en mayúsculas + `" · PEDIDO WEB"` (15.6). El diseño y la impresión no cambian (7 de 7 tickets idénticos). |
| `supabase-publico.js` y todas las páginas | `window.TAQUEIROS_SUPABASE` → `window.SUPABASE_PUBLICO` (neutro). Todas piden `supabase-publico.js?v=2`. Los scripts de `supabase/` leen ese archivo con una expresión sobre `url:`/`publishableKey:`, que no cambia. |
| `api/_publico.js`, `restaurante-publico.js` | Campo opcional `marca.tipografia` `{titulos, cuerpo}` con **lista permitida de nombres** (15.5). |
| `sw.js` v10 | Cache con nombre neutro (`panel-estatico-v10`); borra las caches `taqueiros-panel-*` y `panel-estatico-*` anteriores. Sigue sin guardar nada de ningún restaurante (15.7). |
| `pruebas/multirestaurante/panel.mjs` (nuevo) y `realtime-falso.mjs`, `mutaciones-panel.mjs` | Pruebas de navegador con dos restaurantes (15.10). |

### 15.2 Inventario: lo que estaba escrito a mano en las páginas privadas y de dónde sale ahora

| Valor | Antes | Ahora |
|---|---|---|
| Nombre (título de la pestaña, barra, menú lateral, `alt` del logo) | `marca.js` (`"Los Taqueiros"`), `<title>` y `alt` de `menu-admin.html` e `historial.html` | `restaurantes.nombre` → `[data-marca-nombre]` (con `textContent`) y `document.title = "<página> \| <nombre>"` |
| Logo | `Recursos/logo/logo.png` en 6 sitios + `marca.js` | `config.publico.marca.logo` → `[data-marca-logo]` (el `alt` es el nombre, salvo `data-marca-decorativo`) |
| Favicon e ícono de pantalla de inicio | `marca.js` y `<link rel="icon">` | el logo (ruta validada); mientras llega, un ícono provisional vacío evita que Chrome pida `/favicon.ico` |
| `theme-color` (`#C1272D`) | cabecera de las 3 páginas | `marca.colores.primario` |
| Colores (12 en `:root` ×3) y ~60 `rgba(...)` con los colores de la marca | CSS de las 3 páginas | `marca.colores.*` → variables CSS (`--rojo`… y sus `-rgb` para las transparencias). Paleta neutra por defecto |
| Texto secundario (`#B9A88C`) | CSS | `marca.colores.texto_tenue` (en estas páginas el "secundario" es el tenue; si falta, `texto_secundario`) |
| Tercer nivel de superficie `--carbon-3` (`#2E1D19`) | CSS | derivado de `oscuro` y `oscuro_2` (un paso más allá de `oscuro_2` en la misma dirección: con la paleta de Taqueiros da exactamente `#2E1D19`) |
| Tipografías (Anton, Libre Franklin; el `<link>` de Google Fonts ×3) | HTML y CSS | `marca.tipografia` (lista permitida); por defecto las mismas de siempre. `Fredoka` se cargaba pero **ninguna** página privada la usaba: ya no se carga |
| Pie del ticket `LOS TAQUEIROS · PEDIDO WEB` | `ticket-comanda.js` | `nombre.toUpperCase() + " · PEDIDO WEB"` (`TicketComanda.fijarRestaurante(nombre)`) |
| Emoji 🌮 del aviso "Nuevo pedido" | `panel.html` | `marca.emoji` (neutro 🍽️) |
| Ejemplos de búsqueda del historial (`3125249438` = el WhatsApp de Taqueiros, `TAQ-...`) | `historial.html` | textos neutros ("Ej: 3001234567", "Código de referencia"). Es el único cambio visible para el personal de Taqueiros |
| `window.TAQUEIROS_SUPABASE` | `supabase-publico.js` y todas las páginas | `window.SUPABASE_PUBLICO` |
| Claves de `localStorage` `taqueiros-*` (imprimir, sonido, vistos, impresos, depurar, tamaño y hoja del ticket) | panel y ticket | `panel-*-v2:<id del restaurante>` (y `panel-ticket-*-v1` por equipo); las anteriores se **migran** una vez (15.7) |
| Nombre de la cache del service worker | `sw.js` | `panel-estatico-v10` |
| `configuracion`/`salud_notificaciones` por `id = 1` | panel | por `restaurante_id` |
| "La primera membresía" (`limites_jornada()`, `resumen_jornada`, `buscar_historial`, `jornadas_con_pedidos` sin parámetro) | panel e historial | siempre `p_restaurante` = el del dominio |

Lo que **queda a propósito** (no es marca; ver 15.11): la zona horaria `America/Bogota` y el prefijo `+57` de los enlaces `tel:`, algunos
grises/azules de estado (`#6b8fa8`, `#7a6a5c`, `#ffb4ab`, `#150d0b`…) que no son colores de marca, los datos inventados del ticket de
prueba (nombres de productos de ejemplo) y los nombres históricos de las claves del navegador, que la librería nombra **solo** para migrarlas.

### 15.3 Cómo se resuelve el restaurante y cómo se verifica la membresía (y por qué es seguro)

1. Al cargar, la página muestra un **telón** y pide `/api/restaurante` (el servidor lo decide por el `Host`, 12.2; el navegador nunca elige).
   Dominio desconocido → mensaje neutro "Este sitio no está disponible", **sin una sola petición a Supabase** (probado). Servidor caído → mensaje
   neutro con "Reintentar" y **reintento automático cada 8 s** (la cocina no puede quedarse en una pantalla de error).
2. Con el restaurante conocido se pinta la marca y se levanta el telón. Solo entonces se mira la sesión (`getSession`, local).
3. Al iniciar sesión (o al restaurar una guardada) se consulta `miembros` con **la sesión del usuario**:
   `user_id = <él>`, `restaurante_id = <el del dominio>`, `activo = true`. Hay tres resultados:
   * **miembro activo** (`dueno`, `cajero` o `cocina`): entra; el rol aparece en el menú lateral ("Tu rol: Dueño"). **No cambia lo que cada
     rol puede hacer**: eso sigue siendo RLS (cocina, por ejemplo, ve pedidos pero RLS no le entrega menú ni configuración);
   * **no es miembro** (sin fila, membresía inactiva, o es de otro restaurante): "Tu usuario no tiene acceso a este restaurante.", se cierra
     la sesión **solo en ese navegador** (`signOut({scope:"local"})`: el cierre global habría cerrado también la sesión de la cocina de su propio
     restaurante en otros equipos) y no se pide ningún dato (probado: la sesión rechazada solo hizo la consulta de `miembros`);
   * **no se pudo saber** (red, 5xx): **no** es un rechazo ni cierra la sesión: se muestra "No pudimos verificar tu acceso…" y se reintenta solo.
     (Un 503/520 de GET lo reintenta el propio `supabase-js` antes de llegar a la página.)
4. Con el panel abierto, la membresía se vuelve a comprobar cada 10 minutos y al volver a la pestaña si pasaron más de 5: si se la quitaron,
   se borra todo de la pantalla y vuelve al inicio de sesión con el mensaje.
5. Un usuario miembro de **dos restaurantes** entra a cada uno por su dominio (cada dominio es un origen con su propia sesión); no hay selector.

**Por qué es seguro.** La comprobación del navegador **no es lo que protege los datos**: eso lo hace RLS en cada consulta (políticas del SQL 10).
Sirve para (a) no mostrar el panel de un restaurante a quien no es de ahí y (b) que quien es de dos restaurantes vea solo el del dominio. Esto
último es lo delicado: RLS le **deja ver los dos**, así que la separación la hace el `restaurante_id` explícito de cada consulta (15.4). La prueba
`4b` lo demuestra: con la sesión de ese usuario y **sin filtro** la base le entrega los pedidos de los dos restaurantes, y aun así el tablero, el
historial, el resumen, el menú, la configuración, la salud del WhatsApp y los canales de Realtime de cada dominio muestran solo lo suyo. Quien edite
el navegador para saltarse la comprobación no gana nada: RLS sigue mandando. Superadmin que **no** es miembro: hoy tampoco entra (la interfaz de
superadmin es otro paso, 15.11).

### 15.4 Filtro por restaurante en todo el frontend privado

| Página | Qué | Cómo recibe el restaurante |
|---|---|---|
| panel | `limites_jornada` | `p_restaurante` (antes: la primera membresía) |
| panel | lectura de `pedidos` (tablero), sonda `impreso_en` | `.eq("restaurante_id", RID)` |
| panel | cambio de estado de un pedido | `.eq("id", id).eq("restaurante_id", RID)` |
| panel | `configuracion` (leer, interruptor Abierto/Cerrado, horario) y `salud_notificaciones` | `.eq("restaurante_id", RID)` (antes `id = 1`) |
| panel | Realtime: `pedidos`, `salud_notificaciones`, `configuracion` | `filter: "restaurante_id=eq.<RID>"` en cada suscripción **y** el manejador descarta lo que no sea de su restaurante (un pedido sin `restaurante_id` también) |
| panel | `reclamar_impresion(p_id)`, `registrar_reimpresion(p_id)` | deducen el restaurante **del pedido** y exigen membresía con rol dueño/cajero/cocina; el panel solo les pasa ids de su propia lista y `esImprimible` rechaza lo que no sea de su restaurante |
| historial | `jornadas_con_pedidos`, `resumen_jornada`, `buscar_historial` | `p_restaurante` |
| menu-admin | leer categorías y productos | `.eq("restaurante_id", RID)` |
| menu-admin | alta de categoría y de producto | `restaurante_id: RID` en el cuerpo |
| menu-admin | agotar, editar (rápido y formulario), renombrar, ocultar, borrar, **deshacer un alta a medias** | `.eq("id", …).eq("restaurante_id", RID)` (los ids de producto/categoría se repiten entre restaurantes) |
| menu-admin | foto nueva | se sube a `{restaurante_id}/p-<hex>.<ext>`; la lectura de las existentes sigue donde están; solo se intenta borrar una foto de la raíz o de la carpeta propia |

**Funciones SQL revisadas (una por una)** y si necesitan un cambio en la base para 2B-4: **ninguna lo necesita**.

| Función | Cómo recibe/deduce el restaurante | Veredicto |
|---|---|---|
| `limites_jornada(fecha, p_restaurante)` | parámetro; sin él, `restaurante_actual()` (primera membresía) | el panel ya manda el parámetro. `config_jornada` (DEFINER) devuelve vacío si no eres miembro |
| `resumen_jornada(fecha, p_restaurante)`, `buscar_historial(…, p_restaurante)`, `jornadas_con_pedidos(limite, p_restaurante)` | parámetro; mismo respaldo | el historial ya manda el parámetro |
| `reclamar_impresion(p_id)`, `registrar_reimpresion(p_id)` | el restaurante **del pedido** (invoker + RLS + membresía con rol) | seguras tal cual. Un usuario de dos restaurantes **podría** reclamar con ellas un pedido del otro si le pasara el id; el panel no lo hace (lista filtrada + `esImprimible`), y no es un hueco de seguridad (es su propio restaurante). Si algún día se quiere que la base lo impida por dominio, bastaría un parámetro opcional `p_restaurante` |
| `validar_producto` / `validar_categoria` (triggers) | el `restaurante_id` de la fila | ya exigen categoría del mismo restaurante y ruta de foto `{restaurante_id}/…` (la raíz solo para Taqueiros: regla transitoria que **sigue puesta**) |
| `puede_gestionar_fotos(ruta)` (Storage) | primera carpeta de la ruta = restaurante del que eres **dueño** | probado: el dueño de A escribe en `A/…`, no en la raíz ni en `B/…` |

El valor por defecto transitorio de `restaurante_id`, la regla de la raíz del bucket y `?clave=` del cron **no se retiraron** (2B-4).

### 15.5 Tipografías

`restaurantes.config.publico.marca.tipografia = { "titulos": "Bebas Neue", "cuerpo": "Open Sans" }`. Ambos son **nombres** de esta lista
(`api/_publico.js` `FUENTES_PERMITIDAS` y `restaurante-publico.js` `RP.FUENTES`; una prueba compara las dos listas):
Anton, Bebas Neue, Oswald, Montserrat, Poppins, Playfair Display, Fredoka, Lora, Merriweather, Libre Franklin, Open Sans, Nunito, Lato, DM Sans,
Work Sans, Source Sans 3. **Por defecto** (sin elegir) son las de siempre: `titulos = Anton`, `cuerpo = Libre Franklin`. Nunca se usa una URL ni un
nombre libre de la configuración: la dirección de Google Fonts se arma en el navegador solo con la entrada de la lista (con los pesos que esa fuente
sí tiene) y se aplica con `--fuente-titulos` / `--fuente-cuerpo`. Un valor fuera de la lista (un nombre libre, `https://…`, `Anton;} body{display:none}`) se
ignora y quedan las de siempre; el servidor solo emite el campo si hay una elegida válida (para Taqueiros la respuesta es la de antes, sin el campo).
El ticket de la termica **no** usa estas fuentes (Arial, a propósito).

### 15.6 Ticket de comanda: qué cambió y la prueba de que la impresión no cambió

* `TicketComanda.fijarRestaurante(nombre)` (el panel lo llama una vez) y `preparar()` calcula `pie = textoPie(nombre)`: el nombre pasa por `limpiarTexto`
  (como todo lo que viene de la base: sin emojis, controles ni marcas de dirección), se pasa a mayúsculas y se le agrega `" · PEDIDO WEB"`. Sin nombre,
  el pie es solo `PEDIDO WEB` (nunca el de otro restaurante). `opciones.restaurante` manda para una sola impresión.
* Para "Los Taqueiros" el pie es **exactamente** `LOS TAQUEIROS · PEDIDO WEB` (mismos caracteres, `U+00B7`).
* Las claves del tamaño y del modo de hoja pasan a `panel-ticket-tamano-v1` / `panel-ticket-hoja-v1` (se migran los valores guardados).
* **Prueba:** `node pruebas/impresion/comparar-tickets.mjs` (ahora compara contra `1c35320`, el commit anterior a este paso) imprime los mismos 7 tickets
  (normal, 12 productos con notas largas, nombres y direcciones largos, ñ y tildes, HTML hostil, reimpresión, prueba) con el panel de antes y el de ahora
  y compara el HTML **letra por letra**: **7 de 7 idénticos** (solo se normalizan las horas). Además: 5 pruebas unitarias nuevas del pie (nombre normal, sin
  nombre, texto hostil, `opciones.restaurante`, claves neutras) y el escenario `9` del navegador (el ticket de A lleva el pie de A y el de B el de B;
  reimpresión y ticket de prueba, igual).

### 15.7 Preferencias del navegador y service worker

* Las preferencias del panel llevan el id del restaurante: `panel-imprimir-v2:<id>`, `panel-sonido-v2:<id>`, `panel-vistos-v2:<id>`,
  `panel-impresos-local-v2:<id>`, `panel-depurar-conexion-v2:<id>`; el tamaño del ticket y el modo de hoja son del **equipo**
  (`panel-ticket-tamano-v1`, `panel-ticket-hoja-v1`). El bloqueo entre pestañas también (`impresion-local:<id>`).
* **Migración:** la primera vez que se abre el panel nuevo en un equipo, cada valor de las claves `taqueiros-*` se copia a la clave nueva si esta
  no existe (la anterior queda como estaba) y se borra la clave de la sesión propia que ya no se usa. Así el equipo de la cocina **conserva la
  impresión activada**, el sonido, el tamaño y el modo de hoja al actualizar. No se migra si la dirección trae `?r=` (un preview no hereda las
  preferencias de otro restaurante). Los nombres antiguos solo aparecen en `panel-restaurante.js` (8 claves), y una prueba lo exige.
* `sw.js` v10: no precachea nada; panel, `/api/`, `/manifest.json`, Supabase y las páginas van **siempre por la red**; solo guarda archivos
  estáticos de `/Recursos/` y fuentes, en una cache **por origen** (cada restaurante tiene el suyo): no puede servir datos de un restaurante a otro.
  Al activarse borra las caches viejas (`taqueiros-panel-*` y `panel-estatico-*`).
* En la primera visita tras el despliegue el panel se **recarga una vez** (el worker nuevo toma el control; comportamiento de siempre).

### 15.8 Seguridad de lo que llega de la base

Nombre, rol y marca entran con `textContent` o con atributos validados; los colores deben ser `#RRGGBB` exactos (el servidor y el navegador lo
revisan) y se aplican con `setProperty`; las imágenes son rutas del sitio o `http(s)` del origen de Supabase del proyecto (nada de `javascript:` ni
`data:`); las tipografías, nombres de una lista. `panel-restaurante.js` no usa `innerHTML`, `insertAdjacentHTML`, `document.write` ni `eval` (la prueba
`12` lo exige) y ningún dato del restaurante se pega con `innerHTML` en las tres páginas. Se arregló además que el **horario** (que sale de la base y
se escribía dentro de atributos) aceptaba cualquier cadena: ahora solo entra `HH:MM`. Lo que ya existía y se conserva: los datos de los **pedidos** y del
**menú** (clientes, productos, notas) se insertan con `innerHTML` pero **pasando antes por `escapar()`** (escapa `& < > " '`), y el ticket usa
`textContent`; las pruebas con datos hostiles (e2e de la impresión, escenario 14 de `e2e.js`) siguen pasando.

### 15.9 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. **Este paso no trae SQL nuevo** y no toca la base. No pegues ninguna llave en el chat.

**1. Antes de desplegar (una vez, solo lectura):** comprueba que todo el personal de Taqueiros esté en `miembros` (el panel nuevo exige ser miembro
**activo**; el SQL 10 pasó a todos los de `personal` como `dueno`, pero conviene verlo). Supabase → SQL Editor → New query → pega →
**"Run without RLS"**:

```sql
select u.email, m.rol, m.activo
from public.miembros m join auth.users u on u.id = m.user_id
where m.restaurante_id = '00000000-0000-4000-8000-000000000001'
order by m.rol, u.email;
```

Cada persona que usa el panel debe aparecer con `activo = true`. Si falta alguien, agrégalo antes de desplegar (con el UID de Authentication → Users):
`insert into public.miembros (user_id, restaurante_id, rol) values ('<UID>', '00000000-0000-4000-8000-000000000001', 'cajero');` (roles: `dueno`,
`cajero`, `cocina`).

**2. Despliegue.** `git push` a `main` (ya hecho si lees esto en el repositorio); Vercel despliega solo. Abre `https://taqueiros-2-0.vercel.app/panel.html`.

**3. Recorrido a mano en producción** (lo único que ninguna prueba reemplaza):
* `panel.html`: entra con la cuenta de siempre → se ve **igual** que antes; en ☰ aparece "Tu rol: Dueño" bajo "Panel de comandas".
  Cambia un pedido de estado, interruptor Abierto/Cerrado y vuelve a abrir, Sonido, **Reimprimir** (mismo ticket; el pie dice `LOS TAQUEIROS · PEDIDO WEB`).
* **En el computador de la cocina:** recarga una vez (toma `sw.js` v10) y confirma que "Imprimir comandas en esta pantalla" sigue **ACTIVA** y el
  tamaño/modo de hoja son los de siempre (se migran solos). Haz un pedido de prueba con Wompi sandbox: aparece, suena, imprime y llega el WhatsApp.
* `menu-admin.html`: apaga y prende un producto; sube una foto de prueba (queda en `…/storage/v1/object/public/productos/00000000-0000-4000-8000-000000000001/p-….webp`)
  y bórrala; las fotos de siempre se siguen viendo.
* `historial.html`: elige una fecha, mira el resumen y busca por teléfono.
* Un usuario **sin** membresía en Taqueiros (créalo en Authentication si quieres probarlo): debe ver "Tu usuario no tiene acceso a este restaurante." y no ver nada.

**4. Pruebas locales (no tocan la base real):**

```powershell
npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2      # una vez
node --test pruebas/*.test.js                                # unitarias (72)
node pruebas/impresion/e2e.js                                # panel con Supabase simulado (~3 min, 180)
node pruebas/impresion/comparar-tickets.mjs                  # los 7 tickets idénticos (~1 min)
node pruebas/multirestaurante/panel.mjs                      # paginas privadas con 2 restaurantes, supabase-js real, RLS real y Realtime emulado (~1-5 min, 272)
node pruebas/multirestaurante/front.mjs                      # paginas publicas (104)
node pruebas/multirestaurante/servidor.mjs                   # servidor (187)
node pruebas/multirestaurante/mutaciones-panel.mjs           # revision por mutacion de las paginas privadas (~35 min con 3 a la vez)
```

**5. Contra la base real (las mismas de 14.9 paso 3; el servidor casi no cambió: solo el campo opcional `tipografia` de `/api/restaurante`):**

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs                    # esperado: 26 PASAN
node supabase/probar-servidor-multirestaurante.mjs         # esperado: todos PASA (174), "Limpieza: todo lo creado se borro."
node supabase/probar-aislamiento.mjs                       # esperado: todas PASA (con Realtime real)
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

**Si algo falla en producción** (por ejemplo, alguien no está en `miembros` y no puede entrar): vuelve a la versión anterior con
`git revert --no-edit d65d507 bc78966` y `git push`, o agrega la membresía que falta (paso 1). El revert no deshace nada en la base (este paso no la tocó).

### 15.10 Qué se probó y qué no

**Probado por mí (local, sin tocar la base real):**

* `panel.mjs` (nuevo): **272** comprobaciones en Chrome sin interfaz con el `supabase-js` **real**, los manejadores **reales** de `api/`, Postgres 16 (PGlite) con el
  SQL 10, 11 y 12 y sus políticas RLS **reales**, Supabase en **otro origen** (`supabase.localhost`) y un Realtime falso que habla el protocolo del cliente real
  (`realtime-falso.mjs`): la marca de dos restaurantes en las tres páginas (colores, logo, favicon, título, tipografías con la dirección armada desde la
  lista); datos hostiles en la configuración (HTML, CSS, `javascript:`, tipografías fuera de la lista, horario) sin efecto; dominio desconocido y servidor caído
  (sin peticiones, reintento solo); membresía (dueño de A, dueño de B, miembro de ambos con rol distinto en cada uno, cocina, sin membresía, inactiva, y un
  usuario de A por el dominio de B: mensaje, sesión cerrada solo localmente, ni una consulta de datos); fallo de red al verificar (no es rechazo) y membresía
  quitada con el panel abierto; aislamiento con un usuario que RLS deja ver los dos (tablero, configuración, salud del WhatsApp, historial, resumen, búsqueda,
  menú); interruptor y horario que escriben solo en su restaurante; `menu-admin` con **el mismo id de producto y de categoría en los dos restaurantes**
  (agotar, editar rápido y por formulario, renombrar, ocultar, borrar, deshacer un alta a medias: nada toca al otro; cada alta lleva su `restaurante_id`, la foto
  va a `{restaurante_id}/` y nunca a la raíz; RLS de Storage cerrada para la raíz y para la carpeta de otro); Realtime (lo que el navegador pide en el cable,
  que se descarta lo ajeno **aunque llegue** sin filtro, eventos sin `restaurante_id`); impresión por restaurante; preferencias y su migración;
  **Taqueiros idéntico al commit anterior**: 14 pantallas/estados (login, tablero con un pedido de domicilio, menú lateral, horario, impresión, aviso de WhatsApp,
  menú, formulario de producto, historial…) comparando cada elemento con su **estilo calculado** (color, fondo, degradados, fuente, sombra, borde…): **idénticos**
  (diferencias a propósito, normalizadas en la prueba: el rol bajo el menú; los dos ejemplos de búsqueda del historial; el ícono de pantalla de inicio que menú e
  historial no tenían; la tipografía de una cifra del historial que no llevaba tipo genérico de respaldo); y la revisión de archivos (nada de Taqueiros escrito).
* **Revisión por mutación** (`mutaciones-panel.mjs`): 71 mutaciones de las defensas de `panel-restaurante.js`, `restaurante-publico.js`, `panel.html`, `menu-admin.html`, `historial.html`, `ticket-comanda.js` y `sw.js` (cada filtro por restaurante, cada `p_restaurante`, la comprobación de membresía y sus reintentos, el cierre de sesión local, cada filtro y guarda de Realtime, la foto a la carpeta, la migración de claves, la lista de tipografías, la validación de colores…): **65 detectadas, 6 equivalentes declaradas con su razón, 0 sobrevivientes**. La primera corrida dejó pasar 5 (las dos pruebas de "quitar las dos capas de validación" no llegaban al navegador porque el servidor ya descarta lo hostil antes —se agregó el escenario `2b`, que le sirve al navegador datos crudos sin validar—, y la revisión de `sw.js`, que leía el archivo del repositorio en vez de la copia mutada) y una mutación declarada "equivalente" que sí se detectaba. Las equivalentes: los dos filtros de una sola capa de validación (colores y tipografías: la otra capa los cubre; quitadas las dos sí se detectan), `fila.activo` en el navegador (la consulta ya lo pide), un rol desconocido (la base tiene un CHECK con tres roles), el filtro `restaurante_id` en el cambio de estado de un pedido (`pedidos.id` es único en toda la tabla), `esImprimible` (tercera capa) y no intentar borrar una foto de otra carpeta (Storage ya lo prohíbe). Para repetir unas pocas: `node pruebas/multirestaurante/mutaciones-panel.mjs --sin-base --solo="<regex>"`.
* Baterías anteriores, todas verdes: `rls.mjs` 234, `hallazgos.mjs` 32, `planes.mjs` 11, `sim.mjs` (34 OK, con y sin `conPendientes`), `dominios.mjs` 35,
  `config-publica.mjs` 49, `cargar-secretos-test.mjs` 20, `servidor.mjs` 187 (186 + 1 de tipografías), `front.mjs` 104, `probar-compatibilidad` contra el falso 26,
  `probar-servidor-multirestaurante` contra el falso 174, `probar-aislamiento` contra el falso 231 de 238 (las 7 que fallan son las de Realtime, que ese falso no emula,
  igual que antes), unitarias 72, `e2e.js` del panel de la impresión 180 y `comparar-tickets.mjs` 7 de 7. Cambiaron solo las que dependían de lo que cambia:
  `e2e.js` y su servidor falso (ahora entrega `/api/restaurante` armado con el mismo código del servidor, la tabla `miembros`, filtros por restaurante y canales
  con filtro), `front.mjs` (nombre del objeto global, versión del service worker) y `fake-supabase.mjs` (ahora respeta `.single()`).

**Solo se puede probar contra la base real o en producción (pendiente de Carlos):** el inicio de sesión real con tu cuenta y la fila real de `miembros`
(paso 1 de 15.9); que Realtime real acepte el filtro `restaurante_id=eq.<uuid>` en las tres tablas (el protocolo es el estándar de Supabase y el cliente real lo
acepta en la prueba, pero el servidor real lo valida él mismo); la subida real de fotos a `{restaurante_id}/` con las políticas reales (las políticas son las del
SQL 10, que `probar-aislamiento.mjs` ya verifica contra la base real); la **impresora física** y `--kiosk-printing`; Google Fonts reales; el service worker real
instalado en el equipo de la cocina; y que la caché del borde de Vercel separe dominios (P5, sin cambios).

### 15.11 Pendientes y riesgos para el paso siguiente (2B-4)

De 13.4 y 14.11, lo del frontend privado que era de bajo riesgo **se resolvió aquí**: marca de las páginas privadas y del ticket, `menu-admin` con
`restaurante_id` explícito y fotos en carpeta, el panel sin "primera membresía" (ya no hace falta selector: el dominio decide), `TAQUEIROS_SUPABASE` y las
tipografías. **No se hizo, y queda para 2B-4:**

1. ~~**Retirar los valores por defecto transitorios**~~ **Hecho en la sección 16 (SQL 13).** de `restaurante_id` (y `restaurante_taqueiros_id()`). Antes, revisar quién inserta **sin** `restaurante_id`: el
   servidor y las tres páginas privadas ya lo mandan; fallarían los scripts antiguos `supabase/probar-menu-rls.js`, `probar-publishable.mjs` y `probar-impresion-rls.js`
   (ya estaban marcados como obsoletos en la sección 5) y cualquier carga manual.
2. ~~**Regla transitoria del bucket**~~ **Resuelto en la sección 16 (migración de fotos + SQL 14).** (la raíz solo la escribe el dueño de Taqueiros). `menu-admin` ya no escribe en la raíz, pero las ~38 fotos antiguas siguen allí y
   al borrar/cambiar una foto vieja la página intenta borrarla de la raíz: con la regla retirada, ese borrado fallaría en silencio (queda un aviso en consola). Decidir:
   mover las fotos a `{restaurante_id}/` (hay que copiar el archivo con la API de Storage y actualizar `productos.imagen`; con SQL solo no se mueve el archivo) o conservar
   solo el borrado en la raíz.
3. ~~**Formulario de configuración**~~ **Hecho en la sección 17.4 (solo textos, contacto y nombre; la marca sigue siendo del administrador).** *(Texto original:)* (el dueño ya puede escribir `config.publico`): con las mismas validaciones que el servidor y el navegador (colores `#RRGGBB`,
   URLs de logo, textos, WhatsApp) y **selector de las dos tipografías** con la lista de 15.5; que avise lo que se descarta.
4. ~~**Agrupación de endpoints**~~ **Hecha en la sección 17.2 (6 de 12).** *(Texto original:)* siguen siendo **11 de 12** funciones de Vercel Hobby; este paso **no agregó ninguna** (el aviso de gracia, que habría pedido un endpoint
   con sesión, no se hizo: el dueño ya puede leer su fila de `restaurantes` con RLS —incluye `vigente_hasta` y `dias_gracia`— así que se puede mostrar sin función nueva; falta
   decidir quién lo ve y con qué texto). Candidatos a unir: `estado` + `disponibilidad`, `restaurante` + `manifest`, `keep-alive` + `alertas`.
5. ~~**Vista previa de enlaces**~~ **Hecha en la sección 17.3.** *(Texto original:)* sin cambios; las páginas privadas llevan `noindex`. Las públicas siguen con el título neutro hasta que se sirva el HTML desde una función.
6. **Superadmin:** un superadmin que no es miembro de un restaurante hoy **no** entra a su panel (la comprobación es estricta); la interfaz de superadmin deberá traer su
   camino ("entrar como"). Un usuario baneado en Auth conserva su token ~1 h (P9), pero RLS deja de darle datos en cuanto se desactiva su membresía y el panel lo saca
   en ≤ 10 min.
7. **Residuos regionales:** `America/Bogota` (jornada y fechas del panel e historial; `restaurantes.zona_horaria` existe pero `jornada_de` la tiene fija), prefijo `+57` de los
   `tel:`, `es-CO`; y los datos inventados del **ticket de prueba** (nombres de productos de ejemplo, que dejé igual porque la prueba exige que el ticket de Taqueiros no cambie;
   cambiarlos exige actualizar `comparar-tickets.mjs`).
8. **Realtime y `DELETE`:** los eventos de borrado se ignoran (no traen `new`); un pedido borrado sigue en el tablero hasta recargar (como siempre). Los filtros de Realtime no
   se aplican a `DELETE` salvo por clave primaria, por eso el manejador además descarta todo lo que no sea de su restaurante.
9. **Costo por página:** cada carga hace una petición más a `/api/restaurante` y una a `miembros`. Si pesa, cache corto de borde **después** de verificar `Vary: Host` con dos dominios (P5).
10. P1, P2, P4–P8 y P10–P13 de 13.4 no tocan estas páginas y siguen como estaban.

---

## 16. Endurecer la base (SQL 13 y 14) y mover las fotos de la raíz

Hasta la sección 15 el servidor, las páginas públicas y las privadas ya trabajaban por restaurante, pero la base conservaba **residuos
transitorios** del SQL 10 que había que cerrar **antes de dar de alta restaurantes reales**: (1) `restaurante_id` con un valor por defecto
que apuntaba a Taqueiros (un insert que lo olvidara caía en Taqueiros sin avisar), (2) `restaurantes.config` sin ninguna validación en la
base y escribible por el dueño, (3) permisos del dueño sobre su fila sin auditar con precisión, (4) la regla transitoria de Storage que deja
al dueño de Taqueiros escribir en la **raíz** del bucket `productos`, y (5) scripts viejos que insertan sin `restaurante_id`.
Esta sección es ese trabajo. **El SQL 13 no cambia datos ni toca Storage; el 14 retira la regla de la raíz solo después de mover las fotos.**
No cambia la lógica del servidor revisada por Opus, ni las URL de servicios externos, ni `?clave=` del cron.

### 16.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/13-endurecer.sql` (nuevo) | Atómico, idempotente, marcadores `-- >>> PASO n`, bloques `DO` con `MR paso n: ...`, barridos por OID, **35 comprobaciones OK/FALLA**, apto para "Run without RLS". (a) retira el valor por defecto de `restaurante_id` en todas las tablas de negocio (barrido de catálogo); (b) valida `restaurantes.config` con un trigger (16.4) y los rangos de `tarifas_domicilio`; (c) mínimo privilegio (16.5). Antes de activar el trigger comprueba que la config **actual** de Taqueiros pasa y, si no, se detiene listando los problemas. |
| `supabase/13-revertir.sql` (nuevo) | Devuelve el valor por defecto transitorio, quita los triggers y funciones nuevos, repone `proteger_campos_restaurante()` del SQL 10 y el permiso de tarifas del dueño. Idempotente, atómico, 9 comprobaciones. |
| `supabase/migrar-fotos-raiz.mjs` (nuevo) | Mueve las fotos de Taqueiros de la raíz del bucket a `{restaurante_id}/` (16.6). Simulación por defecto. |
| `supabase/14-retirar-regla-bucket.sql` (nuevo) | Retira la regla de la raíz (Storage y `validar_producto`). Se detiene si algún producto aún apunta a una foto de la raíz. 8 comprobaciones. |
| `supabase/14-revertir.sql` (nuevo) | Devuelve la regla de la raíz (por si hay que deshacer la migración de fotos). |
| `supabase/probar-menu-rls.js`, `probar-publishable.mjs`, `probar-impresion-rls.js`, `probar-categoria-apagada.js`, `probar-aislamiento.mjs` | Todo intento de escritura manda `restaurante_id` explícito; expectativas actualizadas a la realidad multi-restaurante (el menú ya no se lee directo, el dueño ya no escribe tarifas, la config se valida). Las cuatro primeras aceptan `SUPABASE_URL` (se pueden correr contra el falso). |
| `supabase/00-inspeccion-esquema.sql` | Dos secciones nuevas: `restaurante_id_con_valor_por_defecto` y `fotos_en_la_raiz_del_bucket`. |
| `supabase/configuracion.sql`, `menu.sql`, `salud-notificaciones.sql` | Marcados **OBSOLETOS** en su encabezado (de antes del multi-restaurante; insertan sin `restaurante_id`, que ya es obligatorio; no se vuelven a correr). |
| `pruebas/multirestaurante/` | `endurecer.mjs` + `mutaciones-13.mjs` (SQL 13), `migrar-fotos.mjs` + `mutaciones-fotos.mjs` (fotos y SQL 14). `fake-supabase.mjs` aplica el SQL 13 (y con `SQL14=1` el 14), guarda el contenido real de los archivos, implementa `copy` y admite cortes de conexión. `escenarios-servidor.mjs`, `rls.mjs` adaptados (16.9). |

### 16.2 Inventario de rutas que insertan (o dependían del valor por defecto) y qué se corrigió

Búsqueda en todo el repositorio de `insert into`, `upsert`, `Prefer: resolution=merge-duplicates`, `POST` a `/rest/v1/<tabla>` y funciones/triggers SQL:

| Dónde | Qué inserta | `restaurante_id` | Acción |
|---|---|---|---|
| `api/_supabase.js` `insertarPedido(rid, …)` (lo usa `crear-pedido.js`) | `pedidos` | explícito (primer argumento, validado como UUID) | ninguna: ya era explícito |
| `menu-admin.html` (2 inserts: categoría y producto) | `categorias`, `productos` | `restaurante_id: RID` | ninguna (sección 15) |
| `panel.html`, `historial.html`, `index.html`, `pedido.html` | ningún insert directo (`index`/`pedido` llaman a `/api/crear-pedido`) | — | ninguna |
| SQL 10: `aprovisionar_restaurante()` (trigger del alta), `personal_a_miembros()`, `siguiente_numero_pedido()`, `buscar_mis_pedidos()` (intentos), siembras de Taqueiros y tarifas | `restaurante_secretos`, `contadores_pedido`, `configuracion`, `salud_notificaciones`, `miembros`, `intentos_buscar_pedido`, `tarifas_domicilio` | explícito (`new.id`, `v_rid` o `restaurante_taqueiros_id()` a propósito) | ninguna. `personal_a_miembros()` usa `restaurante_taqueiros_id()` **a propósito**: `personal` es una tabla legada de Taqueiros |
| SQL 12: `buscar_mis_pedidos()` | `intentos_buscar_pedido` | explícito | ninguna |
| `supabase/configuracion.sql`, `menu.sql`, `salud-notificaciones.sql` | `configuracion`, `categorias`, `productos`, `salud_notificaciones` | **no lo mandan** | históricos de antes del SQL 10: marcados OBSOLETOS (no se vuelven a correr; el simulador los aplica **antes** del SQL 10, cuando la columna no existe) |
| `supabase/probar-menu-rls.js`, `probar-publishable.mjs` | ataques de escritura de `anon` | no lo mandaban | corregidos: ahora lo mandan (la prueba mide los permisos, no un NOT NULL) |
| `supabase/probar-impresion-rls.js` | `PATCH` de ataque sobre `pedidos` | filtro sin restaurante | corregido: filtra por el restaurante del pedido |
| `supabase/probar-categoria-apagada.js` | `categorias`, `productos` de prueba | no lo mandaba (y llamaba a `validarItems(items)` con la firma anterior) | corregido: `restaurante_id` explícito, `validarItems(rid, items)` y `Host` en la llamada a `crear-pedido` |
| `supabase/probar-aislamiento.mjs`, `probar-servidor-multirestaurante.mjs`, `cargar-secretos.mjs`, `probar-compatibilidad.mjs`, `exportar-respaldo.mjs` | pruebas / secretos | explícito o solo lectura | `probar-aislamiento.mjs` actualizado a los permisos nuevos (16.5) |
| `pruebas/multirestaurante/rls.mjs` | ≈40 inserts | 2 dependían del defecto (`T-TAQ-N`, "menu-admin sin restaurante_id") | corregidos; ahora prueban que **falla** sin él |
| `pruebas/multirestaurante/escenarios-servidor.mjs` | restaurantes, menús, pedidos | explícito | sus restaurantes de prueba usaban una config con claves que la base ya no acepta: ahora válida (16.9) |
| simulador (`sim.mjs`) | 5 pedidos antiguos | sin él, **antes** del SQL 10 (no existe la columna) | sin cambio |

Resultado: **ninguna ruta de producción dependía del valor por defecto**; solo scripts y pruebas viejos. Un insert sin `restaurante_id` ahora falla con
`23502` (o con un error de los triggers de validación, que se ejecutan antes: p. ej. `productos` dice "La categoría elegida no existe").

### 16.3 Valores por defecto: qué se retiró

El barrido (`pg_class` + `pg_attribute.atthasdef`, por OID, solo tablas de `public` que no son de una extensión) encontró y retiró el valor por defecto de
**`pedidos`, `categorias`, `productos`, `configuracion` y `salud_notificaciones`**. Siguen `NOT NULL` y con su llave foránea (el SQL lo comprueba para toda tabla con
`restaurante_id`). La función `restaurante_taqueiros_id()` **se conserva**: la usan la regla de la raíz del bucket (hasta el SQL 14), el trigger `personal → miembros` y
`validar_producto` (hasta el 14). Comprobación final con inserts reales que **se deshacen**: para cada tabla, el mismo insert **con** `restaurante_id` funciona (o choca con la
llave primaria, que Postgres evalúa después del NOT NULL) y **sin** él falla. En `pedidos` la prueba usa `id = -1` con `OVERRIDING SYSTEM VALUE`, así no gasta ningún id de la secuencia.

### 16.4 Reglas de validación de `restaurantes.config` (fuente de verdad)

La implementa `public.config_restaurante_errores(config)` (función pura, devuelve la lista de problemas) y el trigger `restaurantes_validar_config` (`BEFORE INSERT OR UPDATE`).
Se valida **siempre** en un `INSERT`; en un `UPDATE` solo si la config cambia (así suspender a un restaurante cuya config guardada es antigua nunca se frena).
Aplica a **todos**: dueño, superadmin, servidor y editor SQL. Error: `23514` con el camino del campo y la regla; **nunca repite el valor** (podría ser un secreto).
Se recorre el JSON entero: cada nodo debe ser una hoja de la tabla, un contenedor de una hoja (objeto) o un elemento de `colores_zonas`; lo demás es "clave desconocida".

**Reglas para todo texto, en cualquier clave:** sin `<` ni `>`; sin valores que parezcan secretos (`prv_`, `test_integrity_`, `prod_integrity_`, `test_events_`, `prod_events_`,
`sb_secret_`, `sb_publishable_`, `apikey`, `api_key`, `service_role`, un JWT `eyJ…`, `-----BEGIN`); sin claves cuyo nombre parezca de un secreto (`secret`, `secreto`, `apikey`,
`password`, `token`, `private`, `service_role`, `integrity`, `webhook`, `bearer`, `credential`…). Tamaño total de la config ≤ 20 000 caracteres.

| Campo (`config.`…) | Regla en la base | Servidor (`api/_publico.js`) y navegador (`restaurante-publico.js`) |
|---|---|---|
| `publico.marca.logo`, `icono_192`, `icono_512` | texto ≤ 500; **ruta relativa** del sitio (`^/?[A-Za-z0-9][A-Za-z0-9_./-]*$`, sin `..` ni `//`) **o** `https://<proyecto>.supabase.co/storage/v1/object/public/…` (sin `..`) | ruta relativa igual; `http(s)` solo del origen exacto de Supabase. **La base es más estricta** (solo https, solo Storage público) |
| `publico.marca.emoji` | texto ≤ 8 | `texto(…, 8)` |
| `publico.marca.colores.*` (12: `primario`, `primario_oscuro`, `primario_brillo`, `claro`, `claro_suave`, `oscuro`, `oscuro_2`, `acento`, `positivo`, `texto_secundario`, `texto_tenue`, `positivo_brillo`) | `^#[0-9A-Fa-f]{6}$` | igual |
| `publico.marca.colores_zonas` | lista de ≤ 8 colores `#RRGGBB` | igual (`slice(0, 8)`) |
| `publico.marca.tipografia.titulos` / `.cuerpo` | una de las **16**: Anton, Bebas Neue, Oswald, Montserrat, Poppins, Playfair Display, Fredoka, Lora, Merriweather, Libre Franklin, Open Sans, Nunito, Lato, DM Sans, Work Sans, Source Sans 3 | `FUENTES_PERMITIDAS` / `RP.FUENTES` (una prueba compara las tres listas) |
| `publico.textos.*` (13: `titulo_pagina`, `descripcion_pagina`, `eslogan`, `tagline`, `descripcion_pie`, `servicios_linea`, `pie_final`, `ejemplo_nota`, `banner_abierto_icono`, `banner_abierto_titulo`, `banner_abierto_texto`, `banner_cerrado_icono`, `banner_cerrado_mensaje`) | texto ≤ 400, **una línea**: sin saltos ni caracteres de control, ancho cero ni marcas bidi; no puede ser una sola "palabra" de ≥ 32 letras/números (parece una clave) | `texto(v, 400)` (el servidor convierte los saltos en espacios; **la base los rechaza**) |
| `publico.textos.seguimiento.*` (10: `tiempo_*`, `frase_*` × nuevo, preparacion, camino, recoger, entregado) | igual, ≤ 200 | `texto(v, 200)` |
| `publico.contacto.whatsapp` | texto ≤ 25 que, quitando espacios, `+`, `(`, `)` y `-`, son 8 a 15 dígitos | igual (el servidor entrega solo los dígitos) |
| `publico.contacto.telefono` | texto ≤ 40 | igual |
| `publico.contacto.direccion`, `direccion_corta` | texto ≤ 200 | igual |
| `publico.contacto.ciudad`, `region` | texto ≤ 80 | igual |
| `publico.contacto.instagram`, `tiktok` | `^@?[A-Za-z0-9._]{1,60}$` | igual (sin `@` al entregarlo) |
| `publico.wompi.llave_publica_test` / `llave_publica_prod` | `^pub_test_[A-Za-z0-9]{10,80}$` / `^pub_prod_[A-Za-z0-9]{10,80}$` (la de un modo **no** vale en el otro) | igual |
| `publico.pwa.nombre` / `nombre_corto` | texto ≤ 45 / ≤ 12 | igual |
| `ubicacion.lat` / `ubicacion.lng` | número en [-90, 90] / [-180, 180]; si hay `ubicacion`, **ambos** | `coordenadasValidas` (acepta números en texto: **la base no**) |
| `domicilio.factor_recorrido` | número en [1, 3] | cualquier número > 0 (**la base es más estricta**) |
| `domicilio.pin_minimo_metros` | número en [0, 5000] | cualquier número ≥ 0 |
| `domicilio.area.latMin` / `latMax` / `lngMin` / `lngMax` | números en rango de latitud / longitud; mín ≤ máx | números cualquiera |
| `tarifas_domicilio` (tabla, no config) | `hasta` en (0, 1000] km; `precio` vacío o en [0, 500 000] | sin tope |

**Regla de oro (la prueba la comprueba con 700 configuraciones al azar):** *todo lo que acepta la base lo entrega el servidor sin recortes ni cambios* (la base es igual o más
estricta; un texto vacío cuenta como ausente y los nombres de la PWA vacíos usan el valor por defecto). Si algún día se agrega un campo, hay que agregarlo en **cuatro** lugares:
la lista `reglas` de `13-endurecer.sql`, `api/_publico.js`, `restaurante-publico.js` y esta tabla (la prueba `endurecer.mjs` compara la lista de la base con la del servidor).
`supabase/13-endurecer.sql` ya comprobó, antes de activarse, que la config real de Taqueiros pasa (y `_respaldo-taqueiros.js` también).

### 16.5 Permisos: auditoría y matriz final

**Cómo se auditó:** catálogo (`has_table_privilege`, `has_column_privilege`, `pg_policies`, `pg_trigger`) + pruebas con roles reales (`anon`, `authenticated` con cada rol,
`service_role`) por SQL y por REST con una sesión real (≈ 420 comprobaciones en `endurecer.mjs`).

**Qué había (SQL 10) y qué cambia:**

| Recurso | Antes | Ahora (SQL 13) |
|---|---|---|
| `restaurantes` | el dueño editaba `nombre` y **toda** la `config`; un trigger con lista de columnas prohibidas (una columna nueva quedaba sin proteger) | lista de **lo permitido**: el dueño solo cambia `nombre` (1–120 caracteres, sin `<`/`>`/controles) y, dentro de `config`, **solo `publico.textos` y `publico.contacto`**. Marca, ubicación, domicilio, llaves públicas y PWA: superadmin o servidor. `id`, `slug`, `estado`, `plan`, `modalidad_pago`, `vigente_hasta`, `dias_gracia`, `modulos`, `zona_horaria`, `hora_corte_jornada`, `creado_en` y cualquier columna futura: bloqueadas. Ninguna pantalla actual necesita que el dueño cambie nada de eso |
| `configuracion` | el dueño cambiaba **cualquier** columna | solo `cerrado_temporal`, `horarios`, `mensaje_cerrado` (lo único que escribe el panel). `hora_corte_jornada`, `minutos_ocultar_terminados`, `id`, `restaurante_id`: superadmin o servidor. Ninguna pantalla escribe las dos primeras |
| `tarifas_domicilio` | el dueño escribía | el dueño y el cajero **solo leen**; escribe superadmin o servidor (ninguna pantalla la escribe; el domicilio es configuración comercial como `config.domicilio`). Para reabrirlo: una política |
| `restaurante_secretos`, `contadores_pedido`, `restaurante_dominios`, `intentos_buscar_pedido`, `personal` | ya sin privilegios ni políticas para clientes | igual, **re-afirmado** (el SQL revoca por si alguien dio un permiso a mano) |
| `miembros`, `superadmins` | ya cerrados | igual (se comprobó: el dueño no agrega, asciende ni borra miembros; no se hace superadmin) |

**Matriz final** (`—` = sin acceso; "servidor" = llave secreta; cualquier escritura de config pasa además por la validación 16.4):

| Recurso | dueño | cajero | cocina | superadmin | servidor | sin membresía | anon |
|---|---|---|---|---|---|---|---|
| `restaurantes` | lee el suyo; edita `nombre` y `publico.textos`/`publico.contacto` | lee el suyo | lee el suyo | todo | todo | — | — |
| `restaurante_secretos`, `contadores_pedido`, `restaurante_dominios`, `intentos_buscar_pedido`, `personal` | — | — | — | — | todo | — | — |
| `miembros` | su fila | su fila | su fila | todo | todo | — | — |
| `superadmins` | — | — | — | su fila (nadie escribe desde el navegador) | todo | — | — |
| `configuracion` | lee; cambia `cerrado_temporal`, `horarios`, `mensaje_cerrado` | lee | — | todo | todo | — | — |
| `tarifas_domicilio` | lee | lee | — | todo | todo | — | — |
| `salud_notificaciones` | lee | lee | — | todo | todo | — | — |
| `pedidos`, `categorias`, `productos` | sin cambios respecto de la sección 3 | | | | | | |
| Storage (fotos) | su carpeta; **la raíz** hasta el SQL 14 solo el dueño de Taqueiros | — | — | todo | todo | — | lectura pública |

### 16.6 Migración de las fotos antiguas (`migrar-fotos-raiz.mjs`) y SQL 14

**Plan.** Las fotos que se subieron antes del multi-restaurante están en la **raíz** del bucket `productos` y su dirección pública está en `productos.imagen`. Mover un archivo con SQL
no mueve el archivo físico, así que se usa la API de Storage. El script (solo para los productos del restaurante `--slug`, por defecto `taqueiros`):

1. **Simulación por defecto** (solo lee): lista cada foto, su destino `{restaurante_id}/archivo`, cuántos productos la usan, y avisa de lo que **no** tocará. No escribe nada (ni base, ni Storage, ni registro).
2. **`--aplicar`** exige antes una **copia de seguridad reciente** hecha con `exportar-respaldo.mjs`: carpeta de `respaldos\` de este mismo proyecto, de menos de 24 h (`--respaldo-max-horas`),
   con todas las tablas coincidiendo con la base, con `productos` y `productos.json`. Si no, no hace nada y dice qué correr.
3. Por cada foto, en este orden y solo si el paso anterior salió bien: **copiar** (API `copy`, nunca pisa un archivo que ya exista) → **actualizar** `productos.imagen` (condicional: solo si el
   producto todavía tiene la dirección antigua; si el dueño la cambió mientras tanto, no se toca) → **verificar** que la dirección pública nueva responde con **exactamente los mismos bytes**
   (SHA-256; si no, devuelve el producto a la dirección antigua y no borra nada) → **borrar** la antigua, solo después de comprobar que ningún producto (de ningún restaurante) la usa.
4. **No toca:** fotos que usa también un producto de otro restaurante, archivos que ningún producto usa, fotos del sitio (`Recursos/…`), carpetas de otros restaurantes, nombres de archivo que
   la base no acepta. Una foto cuyo archivo ya no existe se reporta como **ROTA** (hay que cambiarla en menu-admin; el SQL 14 se detiene mientras un producto la use).
5. **Idempotente y reanudable:** el estado se deduce de Storage y de la base (ayudado por el registro); se puede cortar en cualquier punto y volver a correr. Probado matando el proceso en
   **cada una** de las 10 peticiones que modifican y volviendo a correr (siempre termina bien).
6. **Registro JSON** (`respaldos\migracion-fotos-taqueiros.json`, ignorado por git): mapa antiguo → nuevo, hash, estado y los productos afectados con su dirección antigua. Con
   `--deshacer=<registro>` (simulación) y `--deshacer=<registro> --aplicar` devuelve las fotos a la raíz (necesita antes `14-revertir.sql` si el 14 ya se corrió).
7. `--no-borrar`: copia y cambia las direcciones pero deja las antiguas (una corrida normal después las borra).
8. **La llave** se lee de `SUPABASE_SERVICE_ROLE_KEY` (la que pegas UNA vez con `Read-Host`), se detecta el pegado doble y **nunca se imprime** (ni en errores ni en el registro).

**Cuántas fotos son.** El repositorio sugiere que las ~38 fotos "de origen" son rutas del sitio (`Recursos/…`) y no están en el bucket; solo las subidas con menu-admin antes de la sección 15
están en la raíz. **La simulación lo dice con exactitud** (`Productos de taqueiros: N (…, en la RAIZ del bucket M, …)`); si M = 0 no hay nada que mover y se puede ir directo al SQL 14.

**SQL 14 (`14-retirar-regla-bucket.sql`).** Se corre **solo después** de migrar y verificar. Se detiene (sin cambiar nada) y nombra los productos si alguno aún apunta a una foto de la
raíz (también con `?t=…`). Si pasa: `puede_gestionar_fotos()` ya no tiene el caso "raíz = Taqueiros" (solo la carpeta propia del dueño; el superadmin sigue siendo superadmin) y
`validar_producto()` ya no acepta rutas planas, ni para Taqueiros. No mueve ni borra archivos; los archivos sueltos que queden en la raíz solo los puede borrar el servidor
(la comprobación final los cuenta). Reversa: `14-revertir.sql`.

### 16.7 Cómo revertir cada paso

| Paso | Reversa | Qué deja |
|---|---|---|
| SQL 13 | `supabase/13-revertir.sql` ("Run without RLS") | valor por defecto transitorio otra vez, sin validación de config ni de tarifas, `configuracion` sin guarda de columnas, dueño escribe tarifas y edita toda su config (pero **no** plan/estado/vigencia/módulos/slug, como con el SQL 10) |
| Migración de fotos | `node supabase/migrar-fotos-raiz.mjs --deshacer=<registro> --aplicar` | las fotos vuelven a la raíz con los mismos bytes y los productos a su dirección de siempre |
| SQL 14 | `supabase/14-revertir.sql` | vuelve la regla de la raíz (hace falta antes de deshacer la migración de fotos) |
| Código (scripts y pruebas) | `git revert` de los commits de la sección 16 | los scripts viejos vuelven a insertar sin restaurante |

Ninguna reversa toca datos. Orden inverso: SQL 14 → fotos → SQL 13.

### 16.8 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` (no se ven): pega **UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos); los scripts
detectan el pegado doble y no hacen nada. No pegues ninguna llave en el chat.

**0. Una vez:** `git pull` (ya está en `main`) y `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2` si vas a correr las pruebas locales.

**1. Respaldo** (solo lee; deja `respaldos\<fecha>\`):

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/exportar-respaldo.mjs
```

Esperado: filas por tabla y "Respaldo completo". Si dice "NO coincide", no sigas. (Deja la variable puesta para los pasos 2, 4, 5, 6 y 7; al final `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.)

**2. (Recomendado, solo lectura) Inspección:** SQL Editor → pega `supabase/00-inspeccion-esquema.sql` → Run. Mira las filas nuevas `restaurante_id_con_valor_por_defecto` (deben ser las 5 tablas) y
`fotos_en_la_raiz_del_bucket` (cuántos archivos hay en la raíz y cuántos productos apuntan a ella).

**3. SQL 13.** VS Code → abre `supabase/13-endurecer.sql` → **Ctrl+A, Ctrl+C** → SQL Editor → New query → pega → **"Run without RLS"**. Esperado: **35 filas, todas `OK`**.
Si falla verás `MR paso n: …` o `LA MIGRACION 13 SE REVIRTIO` con la lista, y **no se cambió nada**. Lo más probable: *"La config actual de Taqueiros NO cumple las reglas"* (te dice qué campo; corrígelo
en Table editor → `restaurantes` → `config`) o una tabla que el repo no conoce. Se puede repetir. **Si algo se rompe en producción:** `supabase/13-revertir.sql` (9 filas `OK`).

**4. Pruebas contra la base real** (crean y borran sus propios restaurantes `test-…`; no tocan Taqueiros):

```powershell
node supabase/probar-compatibilidad.mjs                  # esperado: 26 PASAN
node supabase/probar-servidor-multirestaurante.mjs       # esperado: todo PASA (≈174), "Limpieza: todo lo creado se borro."
node supabase/probar-aislamiento.mjs                     # esperado: todo PASA (con Realtime real; ≈259 pruebas)
node supabase/probar-menu-rls.js                         # esperado: "TODO BLOQUEADO"
node supabase/probar-impresion-rls.js                    # esperado: "TODO BLOQUEADO"
```

(`probar-publishable.mjs` no necesita la llave secreta; los 5 de arriba sí.) Si algo falla, **no sigas**: pégame la línea `FALLA`.

**5. Recorrido a mano** (lo único que ninguna prueba reemplaza): panel (cerrar/abrir el local, horario y mensaje de cerrado), menu-admin (agotar un producto, subir una foto de prueba y borrarla),
un pedido con Wompi sandbox (llega, suena, imprime), Reimprimir, historial.

**6. Migración de fotos, simulación** (no cambia nada):

```powershell
node supabase/migrar-fotos-raiz.mjs
```

Esperado: `SIMULACION`, "Productos de taqueiros: N (…, en la RAIZ del bucket M, …)" y una línea `mf… -> {restaurante_id}/mf…` por foto. Si M = 0 (**Nada que hacer**), pasa al paso 9.
Si hay `ROTA` o `SALTA`, léelas antes de seguir.

**7. Migración de fotos, de verdad** (hace falta el respaldo del paso 1, de menos de 24 h):

```powershell
node supabase/migrar-fotos-raiz.mjs --aplicar
```

Esperado: una línea `OK` por foto y `Resumen: M movida(s) … 0 con error`. Si se corta, **vuelve a correr el mismo comando** (retoma). Registro: `respaldos\migracion-fotos-taqueiros.json`.

**8. Verificación:** `node supabase/migrar-fotos-raiz.mjs` otra vez → "Nada que hacer". Abre menu-admin y el menú público: las fotos se ven igual. (Si no: `--deshacer=respaldos\migracion-fotos-taqueiros.json --aplicar`.)

**9. SQL 14** (solo si el paso 8 dijo "Nada que hacer" y no quedan `ROTA`): `supabase/14-retirar-regla-bucket.sql` → "Run without RLS". Esperado: **8 filas `OK`**. Si dice *"Todavía hay N producto(s) que apuntan a una foto de la RAIZ"*,
te los nombra: arréglalos (cambia o quita la foto en menu-admin) o vuelve al paso 7. Después, en menu-admin sube una foto de prueba y bórrala: va a `{restaurante_id}/`. **Reversa:** `supabase/14-revertir.sql`.

**10.** `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.

### 16.9 Qué se probó y qué no

**Probado por mí (local, Postgres 16 real en PGlite con los SQL 10 a 13, sin tocar la base real):**

* `endurecer.mjs` (nuevo): **426**. El SQL 13 corre dos veces (35 comprobaciones OK cada una) sin tocar ningún dato; **la sonda de comportamiento** con roles reales (`anon`,
  `authenticated` como dueño / cajero / cocina / sin membresía, `service_role`, superadmin): ninguna tabla conserva el valor por defecto y un insert **sin** `restaurante_id` falla en las 5 tablas
  (como servidor, dueño y superadmin); **110 configuraciones hostiles rechazadas** (claves desconocidas a cualquier nivel, tipos, largos, colores, URLs `http`/`javascript:`/`data:`/`..`/`//`/otros dominios,
  tipografías fuera de la lista, HTML, saltos de línea, ancho cero y bidi, secretos `prv_`/`sb_secret_`/`test_integrity_`/`prod_events_`… en cualquier campo, claves con nombre de secreto, coordenadas,
  factor, área incoherente, config enorme) y 30 válidas aceptadas (incluye las 16 tipografías y la config real de Taqueiros); los mensajes de error **no repiten el valor**; el trigger rechaza hostiles también al
  servidor y al superadmin, en INSERT y UPDATE, y no frena un cambio de estado cuando la config guardada es antigua; el dueño: **no** cambia `id`, `slug`, `estado`, `plan`, `modalidad_pago`,
  `vigente_hasta`, `dias_gracia`, `modulos`, `zona_horaria`, `hora_corte_jornada`, `creado_en` (ni mezclándolos con el nombre), **no** cambia marca, ubicación, domicilio, llaves ni PWA, **sí** cambia el nombre,
  `publico.textos` y `publico.contacto`, y dentro de su zona tampoco guarda HTML, secretos ni textos largos; ni cajero, cocina, dueño de otro restaurante ni sin membresía tocan `restaurantes`; superadmin y
  servidor sí (con config válida); `restaurante_secretos`, `contadores_pedido`, `restaurante_dominios`, `intentos_buscar_pedido` y `personal` cerradas a cada rol (4 operaciones × 6 roles); `miembros` y `superadmins`
  (el dueño no agrega, asciende ni borra miembros ni se hace superadmin); `configuracion` por columna; `tarifas_domicilio` (dueño y cajero solo leen; rangos); los flujos con `restaurante_id` explícito
  (menu-admin, crear-pedido, webhook, alertas, panel, impresión, historial, seguimiento). **Por REST directo con la sesión real de un dueño** (PostgREST falso sobre la misma base): 403 `42501` al cambiar plan, estado,
  vigencia, módulos, slug, hora de corte, marca, ubicación, secretos, dominios, contadores, miembros o tarifas; 400 `23514` con HTML o un secreto en un texto; sí puede cerrar/abrir el local.
  Propiedades: 700 configuraciones al azar (todo lo que acepta la base lo entrega el servidor sin recortes), 150 claves inventadas (siempre rechazadas), 34 campos × 9 secretos y × 4 formas de HTML (ninguno se guarda), y las
  reglas del SQL = las claves que lee `api/_publico.js` = las 16 tipografías del servidor y del navegador. Escenarios: se detiene sin cambiar nada si la config de Taqueiros no cumple las reglas o si una tabla admite
  nulos; barre una tabla desconocida y no toca otros esquemas; el SQL 10 y el 12 se pueden volver a correr después; `13-revertir.sql` y volver a aplicar el 13.
* **Revisión por mutación del SQL 13** (`endurecer.mjs --mutaciones`, `mutaciones-13.mjs`): **111 mutaciones** (cada lista de columnas permitidas, cada zona de la config, cada regla de validación, cada política, cada
  trigger, cada guarda de servidor/superadmin, cada `revoke`): **104 detectadas, 7 equivalentes declaradas con su razón, 0 sin detectar**. La primera pasada dejó pasar 18: 13 eran mutaciones mal armadas
  (el `$'` de un reemplazo se interpretaba como patrón) o que reventaban la sonda (se corrigió el arnés), y 5 mostraron pruebas que faltaban (la clave con nombre de secreto, un dueño que agrega textos a una config
  sin `publico`, un cambio **real** de la hora de corte por servidor/superadmin, un esquema sin paréntesis como `javascript:x`). **Las equivalentes:** el tope de profundidad del recorrido y el de 20 000
  caracteres (solo acotan trabajo: lo que los pasa trae algo que otra regla ya rechaza), precio negativo y km cero en tarifas (la tabla ya tiene `CHECK`), cambiar el `id` del restaurante (RLS `WITH CHECK` y la
  llave primaria), la guarda de un `publico` que no es objeto (se rechaza igual con otro error) y el `revoke ... anon` de una función de trigger (no da acceso a nada). Un hallazgo real de la sonda **antes** de entregar:
  tres mensajes de la validación (`ubicacion`/`area`) hacían `text[] || 'literal'`, que Postgres interpreta como arreglo y revienta ("malformed array literal"); se corrigió con `::text` y la autoprueba de la
  propia migración ahora cubre esas ramas.
* `migrar-fotos.mjs` (nuevo): **126**, corriendo el script de verdad como proceso aparte contra el Storage falso con contenido real: llave (sin llave, pegada dos veces, publicable); simulación que no escribe nada (ni una
  petición que modifique); `--aplicar` sin respaldo / viejo / de otro proyecto / que no coincide / sin `productos` / futuro; migración con los **mismos bytes**, foto compartida por dos productos, orden copia → producto →
  borrado; no toca la foto de otro restaurante, la compartida, la suelta, las del sitio ni la rota; registro; segunda corrida sin peticiones que modifiquen; **cortes de conexión y procesos matados** en 5 puntos
  y un **barrido que mata el proceso en cada una de las 10 peticiones que modifican** (siempre termina bien al volver a correr); verificación que falla (devuelve el producto y no borra), copia corrupta, destino con otro
  archivo, destino ya correcto, producto que cambió de foto mientras corría, otro producto que empieza a usar la antigua, borrado que dice OK y no borra, pendiente del registro, `--no-borrar`, deshacer (simulación,
  aplicar, con el SQL 14 puesto, registro ajeno), slug; el **SQL 14** (se detiene y nombra los productos, también con `?t=`; después el dueño de Taqueiros ya no escribe en la raíz pero sí en su carpeta; el trigger de productos
  rechaza rutas planas; idempotente) y `14-revertir.sql`. **Revisión por mutación del script** (`mutaciones-fotos.mjs`): **37 mutaciones: 35 detectadas, 2 equivalentes (con su razón), 0 sin detectar** (la primera
  pasada dejó 4: se agregaron pruebas de "no menciona las fotos ya movidas", del borrado que dice OK y no borra, del pendiente sin copia completa; la mutación de la comprobación de usos del pendiente es equivalente porque `grupos.has` ya la cubre).
* `inspeccion.mjs` (nuevo): 4 — las dos secciones nuevas de la inspección.
* Baterías anteriores, **todas verdes**: unitarias **72**, `e2e.js` del panel **180**, `comparar-tickets.mjs` **7 de 7**, `panel.mjs` **272**, `front.mjs` **104**, `servidor.mjs` **187**, `rls.mjs` **237** (234 + 3 nuevas;
  `SQL13_NO=1` la corre como antes: 234), `hallazgos.mjs` 32, `planes.mjs` 11, `sim.mjs` 34 OK (con y sin `conPendientes`), `dominios.mjs` 35, `config-publica.mjs` 49, `cargar-secretos-test.mjs` 20,
  `probar-compatibilidad` contra el falso **26**, `probar-servidor-multirestaurante` contra el falso **174** (con la validación **activa**), `probar-aislamiento` contra el falso **252 de 259** (las 7 que fallan son las de
  Realtime, que el falso no emula, igual que antes), `probar-menu-rls`, `probar-impresion-rls` y `probar-categoria-apagada` contra el falso: todo bloqueado / en orden. `mutaciones-servidor.mjs` (el servidor no
  cambió; cambiaron sus escenarios): **174 detectadas, 10 equivalentes (declaradas), 0 sobrevivientes, 0 errores**.
* Cambió lo esperado solo en: `rls.mjs` (los 2 tests que dependían del valor por defecto, el dueño ya no escribe tarifas, la config del dueño), `probar-aislamiento.mjs` (lo mismo + 24 pruebas nuevas del SQL 13),
  `escenarios-servidor.mjs` (sus restaurantes de prueba ahora tienen una config **válida**; las pruebas de "dato hostil en la config" siguen corriendo en la batería local, donde se apaga **solo** el trigger de validación con
  `levantar({ validarConfig: false })`, y contra la base real pasan a comprobar que la base **rechaza** ese dato con `23514` sin cambiar nada), y los scripts viejos de 16.2.

**Solo se puede probar contra la base real (pendiente de Carlos):** el SQL 13 y el 14 sobre el esquema verdadero (por si hay tablas/políticas que el repo no conoce: la inspección del paso 2 lo anticipa); que
`has_table_privilege`/`atthasdef` se comporten en Supabase como en PGlite (son catálogo estándar); `probar-aislamiento.mjs` completo con Realtime real y códigos HTTP reales de PostgREST; que la API `copy` de Storage real se
comporte como el falso (no pisa un destino existente → 409; copia el contenido y el tipo) y que `DELETE /storage/v1/object/productos` con `{prefixes:[…]}` borre de verdad; la lectura pública real de las
direcciones nuevas; el recorrido a mano del panel y de menu-admin; un pago real con Wompi.

### 16.10 Riesgos y pendientes para el prompt siguiente (2B-5) y la revisión de Opus

1. ~~**Agrupación de endpoints**~~ **Hecha en la sección 17.2.** *(Texto original:)* siguen siendo **11 de 12** funciones de Vercel Hobby; esta fase no agregó ninguna. Candidatos: `estado` + `disponibilidad`, `restaurante` + `manifest`, `keep-alive` + `alertas`. Al unir
   endpoints, el espía de URLs y el arnés (`escenarios-servidor.mjs`) llaman a los manejadores por nombre de archivo (`M.restaurante`, `M.manifest`…): habrá que actualizarlos.
2. ~~**Formulario de datos del restaurante (2B-5)**~~ **Hecho en la sección 17.4.** *(Texto original:)* el dueño **solo** puede escribir `nombre`, `config.publico.textos` y `config.publico.contacto`; la marca, tipografías, ubicación, domicilio, llaves públicas y PWA
   requieren superadmin o servidor (una función de servidor con sesión; `api/_sesion.js` ya existe). El formulario puede usar `public.config_restaurante_errores(config)` (RPC; lo pueden llamar `authenticated` y el
   servidor) para **avisar antes de guardar** con los mismos mensajes. Si se quiere que el dueño edite la marca: ampliar la lista `#- '{publico,textos}' #- '{publico,contacto}'` del trigger (una línea) **y** decidir
   si pasa por `api/` con auditoría. El texto de un campo vacío cuenta como ausente (no es un error).
3. ~~**Vista previa de enlaces**~~ **Hecha en la sección 17.3.** *(Texto original:)* sin cambios; sigue pendiente servir el HTML desde una función que inyecte `<title>` y `og:` (agregaría una función de Vercel: ver el punto 1).
4. **Valores que aceptan las dos capas:** si el formulario guarda un texto con salto de línea o una URL `http`, la base lo rechaza (el servidor los toleraba). Cualquier campo nuevo se agrega en cuatro lugares (16.4).
5. **`restaurante_taqueiros_id()` sigue existiendo** (trigger `personal → miembros`, `validar_producto` hasta el 14 y la regla de la raíz hasta el 14). Después del SQL 14 solo la usa `personal_a_miembros()`: se puede
   borrar junto con la tabla legada `personal` cuando ya no se use.
6. **Tablas privadas nuevas:** cualquier tabla nueva con `restaurante_id` nace sin valor por defecto (bien) pero **con privilegios de Supabase para `anon`/`authenticated`** (`ALTER DEFAULT PRIVILEGES`): el SQL que la cree
   debe revocarlos y activar RLS; las comprobaciones "anon sin privilegios sobre ninguna tabla" y "RLS en todas" del 10, 11, 13 y 14 la detendrían.
7. ~~**`configuracion.horarios` y `mensaje_cerrado`**~~ **Validados en la base desde la sección 17.5 (SQL 15).** *(Texto original:)* los escribe el dueño sin validación de forma en la base (solo `HH:MM` en el navegador y el parseo del servidor). No es una superficie nueva, pero es la única
   escritura de JSON libre que le queda al dueño: candidata a una validación parecida a la de `config`.
8. **Archivos sueltos en la raíz del bucket** (fotos subidas y reemplazadas antes de la sección 15 que ningún producto usa): después del SQL 14 solo el servidor puede borrarlos; no estorban. El script los cuenta y no los toca.
9. **Realtime y `DELETE`, el registro público de Auth, el límite de peticiones (P4), Preview de Vercel (P2) y `?clave=`** del cron: sin cambios (secciones 9, 13 y 15).
10. **Para la revisión de Opus:** (a) el barrido `atthasdef` ignora tablas de extensiones; (b) `proteger_campos_restaurante()` pasó de lista de columnas prohibidas a lista de permitidas (`to_jsonb(new) - permitidas`):
    comparar contra tipos que `to_jsonb` formatea distinto (hoy `time`, `date`, `jsonb`, `timestamptz` son estables); (c) el SQL 13 vuelve a definir la función del SQL 10 — **no vuelvas a correr el SQL 10 después**
    (la comprobación 20 lo detecta y el 13 se reaplica); (d) `13-endurecer.sql` hace `INSERT`s de prueba dentro de subtransacciones que se deshacen (`pedidos` con `id = -1`); no gasta ids ni números de pedido, pero sí toma los
    bloqueos normales de esas tablas por milisegundos; (e) el script de fotos usa la llave de servicio para `copy`/`DELETE` de Storage y para `PATCH productos`; el `PATCH` es condicional por la dirección antigua.

**Para repetir las pruebas de esta sección** (necesitan una vez `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2`):

```powershell
node pruebas/multirestaurante/endurecer.mjs                  # SQL 13: sonda, REST, escenarios, propiedades (426, ~25 s)
node pruebas/multirestaurante/endurecer.mjs --mutaciones     # ademas, la revision por mutacion (111 mutaciones, ~10 min)
node pruebas/multirestaurante/migrar-fotos.mjs               # migracion de fotos y SQL 14 (126, ~25 s)
node pruebas/multirestaurante/mutaciones-fotos.mjs --paralelo=2   # revision por mutacion del script de fotos (37, ~5 min)
node pruebas/multirestaurante/inspeccion.mjs                 # secciones nuevas de la inspeccion (4)
node pruebas/multirestaurante/rls.mjs                        # 237 con el SQL 13 (SQL13_NO=1: 234 como antes)
node pruebas/multirestaurante/contra-falso.mjs probar-aislamiento.mjs   # etc.: cualquier script de supabase/ contra el falso
```

---

## 17. Agrupar endpoints, vista previa de enlaces y "Datos de mi restaurante" (SQL 15)

Tres cosas de estructura y presentación que quedaban después de la sección 16: (1) **Vercel Hobby permite 12 funciones por despliegue y ya se usaban 11**, y el
panel de superadmin que viene necesita espacio; (2) al pegar el enlace de un restaurante en WhatsApp o Instagram la tarjeta decía el título neutro "Pedidos en línea"
(las vistas previas no ejecutan JavaScript); (3) el dueño no tenía un formulario para el nombre, los textos y el contacto de su restaurante, aunque la base (SQL 13) ya le
permite escribir justo eso. **Ninguna URL externa cambia, Taqueiros se ve y funciona igual, y la lógica revisada por Opus (webhook, crear-pedido, reembolso, sesión,
alertas) solo se mueve de archivo o no se toca.**

### 17.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `api/publico.js`, `api/cron.js`, `api/_despacho.js` (nuevos) | Dos funciones de Vercel que **despachan** a módulos. `_despacho.js` es la única lógica: elige el módulo por el último segmento del path, o por `_ruta`. |
| `api/_modulos/*.js` | `menu`, `estado`, `disponibilidad`, `restaurante`, `manifest`, `alertas` y `keep-alive`: **los mismos manejadores de siempre, movidos con `git mv`**; solo cambiaron las rutas de sus `require` (`./_x.js` → `../_x.js`). Más `vista-previa.js` (nuevo, 17.3). |
| `vercel.json` | 8 reescrituras (cada URL de siempre → su función agrupada), 3 redirecciones por User-Agent (vista previa) y `functions.includeFiles` para que la vista previa lea `index.html` y `pedido.html`. |
| `api/_publico.js` | `datosVistaPrevia()` (título, descripción, imagen y color de la vista previa; mismos validadores que `/api/restaurante`). Nada más cambió. |
| `datos-restaurante.js` (nuevo), `panel.html`, `panel-restaurante.js` | El formulario "Datos de mi restaurante" y su opción del menú lateral (solo dueño). `PR.mostrarRol()` ahora también muestra u oculta lo marcado con `data-solo-rol`. |
| `supabase/15-datos-restaurante.sql`, `15-revertir.sql` (nuevos) | La función `guardar_datos_restaurante`, la validación del horario y del mensaje de cerrado (pendiente 16.10-7). |
| `supabase/13-endurecer.sql` | **Solo el dato de una prueba interna**: el insert de control sobre `configuracion` ahora copia el horario de Taqueiros en vez de usar `'{}'`, para que el SQL 13 se pueda volver a correr después del 15 (el trigger nuevo rechaza `'{}'`). No cambia nada de lo que hace el SQL 13. |
| `supabase/probar-compatibilidad.mjs`, `probar-servidor-multirestaurante.mjs` | La primera llama a `api/publico.js` con las URL de siempre; la segunda acepta `VIA=despachador` o `VIA=reescrita` para correr sus escenarios a través de los despachadores. |
| `pruebas/` | `agrupacion.mjs`, `vista-previa.mjs`, `vercel-emulador.mjs`, `mutaciones-agrupacion.mjs`, `datos-restaurante.mjs`, `reglas-navegador.mjs`, `mutaciones-15.mjs`, `datos-restaurante.test.js`, escenario 13 de `panel.mjs` y 34 mutaciones nuevas en `mutaciones-panel.mjs`. El arnés llama ahora a los módulos y, además, a través de los despachadores. |

### 17.2 Agrupar endpoints

Vercel cuenta **una función por cada archivo de `api/` que no empiece por guion bajo** (en cualquier nivel). Lo que vive bajo un nombre con `_` (los helpers y `_modulos/`) no cuenta.

| Antes (11) | Después |
|---|---|
| `api/menu.js`, `estado.js`, `disponibilidad.js`, `restaurante.js`, `manifest.js` | módulos en `api/_modulos/` → función **`api/publico.js`** |
| `api/alertas.js`, `keep-alive.js` | módulos en `api/_modulos/` → función **`api/cron.js`** |
| `api/crear-pedido.js`, `generar-firma.js`, `reembolso.js`, `webhook-wompi.js` | **sin tocar** (sus propias funciones) |

**Resultado: 6 funciones de 12** (`crear-pedido`, `cron`, `generar-firma`, `publico`, `reembolso`, `webhook-wompi`). Quedan 6 libres para el superadmin. *(Desde la sección 19, `api/superadmin.js` es la 7.ª: 7 de 12.)* Una prueba falla si
alguna vez pasan de 7 (`agrupacion.mjs`, A1) y otra exige que sean exactamente estas 6 (A2), para que sumar una sea una decisión y no un descuido.

**Por qué esas cuatro no se agruparon.** Son las de dinero y autorización (revisadas por Opus). Moverlas no liberaba más espacio del necesario y cada cambio ahí es riesgo: la URL de
Wompi (`/api/webhook-wompi`) queda **literalmente el mismo archivo**. Candidatos para agrupar más adelante, si hiciera falta: `crear-pedido` + `generar-firma` + `reembolso`.

**Tabla de reescrituras** (`vercel.json`; el método, las cabeceras, el cuerpo y el resto de la consulta —`?r=`, `?clave=`— pasan intactos):

| URL externa (no cambia) | Quién la usa | Reescritura | Función → módulo |
|---|---|---|---|
| `/api/menu` | páginas públicas | `/api/publico?_ruta=menu` | `publico` → `menu` |
| `/api/estado` | `index.html` | `/api/publico?_ruta=estado` | `publico` → `estado` |
| `/api/disponibilidad` | `index.html` | `/api/publico?_ruta=disponibilidad` | `publico` → `disponibilidad` |
| `/api/restaurante` | páginas públicas y privadas | `/api/publico?_ruta=restaurante` | `publico` → `restaurante` |
| `/manifest.json` | `panel.html` (PWA) | `/api/publico?_ruta=manifest` | `publico` → `manifest` |
| `/api/manifest` | (compatibilidad) | `/api/publico?_ruta=manifest` | `publico` → `manifest` |
| `/api/alertas` | cron-job.org (`Authorization: Bearer`; `?clave=` se retiró en 19.8) | `/api/cron?_ruta=alertas` | `cron` → `alertas` |
| `/api/keep-alive` | cron-job.org **y el cron de Vercel** (`vercel.json` → `crons`) | `/api/cron?_ruta=keep-alive` | `cron` → `keep-alive` |
| `/api/webhook-wompi`, `/api/crear-pedido`, `/api/generar-firma`, `/api/reembolso` | Wompi, páginas, panel | — (archivos propios) | las mismas funciones de siempre |

Además, 3 **redirecciones** por User-Agent para la vista previa (17.3).

**Cómo elige el módulo `_despacho.js`** (en este orden y nada más):
1. El **último segmento del path** si es una ruta conocida (`/api/menu` → `menu`) o el alias `manifest.json`. Si Vercel entrega la URL original, esto basta; y como **manda sobre el parámetro**,
   `/api/menu?_ruta=restaurante` sigue siendo el menú.
2. Si no, el parámetro `_ruta` que puso la reescritura, leído de `req.query` o de la propia URL (cubre que `req.url` traiga la dirección reescrita).
3. Sin ninguna: `404 {"error":"No encontrado"}` (el mismo cuerpo que un host desconocido). Las rutas se buscan en un `Set` y la tabla de nombres no tiene prototipo, así que `constructor`,
   `__proto__` o `toString` no son rutas.

Elegir otro módulo con `?_ruta=` solo da acceso a *otro endpoint de la misma función* con exactamente sus mismas protecciones (el host del restaurante, la autorización del cron):
`publico` no sirve alertas ni keep-alive, y `cron` no sirve el menú (prueba B5).

**El comportamiento es idéntico — cómo se demuestra.** `agrupacion.mjs`, sección C: el mismo guion de **98 escenarios** (menú, estado, disponibilidad, datos públicos y manifest de 4
restaurantes y de un host desconocido; los dos crons con Bearer, en minúsculas, con `?clave=` buena y mala, vacía, con Basic y con las dos a la vez; crear-pedido válido, agotado,
de otro restaurante, con el precio manipulado, sin cuerpo, suspendido, domicilio con y sin cobertura; generar-firma; webhook con firma buena, de otro restaurante, mala, de monto
distinto, de ambiente equivocado, repetido y rechazo tardío; reembolso sin sesión; suspensión y reactivación) se ejecuta contra **el código del commit anterior (`d689d4d`, sacado de
git)** y contra el actual, cada uno con **su propia base** (Postgres 16 real) sembrada igual y **pasando por `vercel.json`** (`vercel-emulador.mjs`). Se comparan el código de estado, el
cuerpo y **todas las cabeceras** de cada respuesta —los que no modifican nada, con las dos formas en que Vercel puede entregar la URL (la original y la reescrita)— y, al final, las dos bases
(pedidos, salud del WhatsApp, contadores) y los avisos de WhatsApp enviados. Solo se normalizan los valores que cambian por diseño en cada corrida (referencias `TAQ-<ms>-<hex>`, tokens, fechas).
Además los 187 escenarios de `servidor.mjs` pasan **tres veces**: contra los módulos, contra los despachadores con la URL original y con la reescrita (`--via=`). `B1` prueba que cada URL
externa llega al módulo correcto (con módulos-testigo) con su método, `Authorization` y consulta, entregada de 4 formas.

**Lo que ninguna prueba local puede asegurar (se mira en producción, 17.8):** que Vercel entregue `req.url` y `req.query` como se documenta (por eso el despachador acepta las dos formas y la
prueba exige las cuatro combinaciones); que, si la consulta original y la del destino repiten un nombre, gane el destino (el despachador no depende de eso: el path manda); y que el cron de
Vercel (`/api/keep-alive`) pase por la reescritura como cualquier petición. Es una petición HTTP normal a la URL de producción, igual que la de cron-job.org.

### 17.3 Vista previa de enlaces por restaurante

**Qué pasaba.** Los rastreadores de WhatsApp, Instagram/Facebook, Telegram, X, Slack, LinkedIn y Discord piden la página **una vez**, no ejecutan JavaScript y arman la tarjeta con las
etiquetas del HTML. `index.html` es un archivo estático igual para todos y el nombre lo pone JavaScript: la tarjeta decía "Pedidos en línea".

**Diseño pedido** (que las personas sigan recibiendo el HTML estático y solo los rastreadores, por User-Agent, reciban el HTML con los datos inyectados, con una regla de reescritura) **y por qué no se
puede tal cual.** La documentación de Vercel (vercel.json → `rewrites`) dice: *"The `source` property should NOT be a file because precedence is given to the filesystem prior to rewrites being applied"*.
`/` es un archivo (`index.html`), así que una reescritura condicionada por User-Agent **nunca se evaluaría**. Las alternativas: (a) `routes` (legado): corre antes del sistema de archivos, pero la
documentación dice que `routes` no revisa el sistema de archivos por defecto y hay reportes de 404 en todos los archivos estáticos: **si fallara, rompería el sitio de todos**; (b) renombrar las
páginas estáticas para que `/` no sea un archivo y reescribir *para todos*: obliga a mover `index.html` y `pedido.html` y **toca a las personas**; (c) Routing Middleware: sería otra función de Vercel.

**Diseño elegido: redirección temporal (307) condicionada por User-Agent.** Las redirecciones se evalúan **antes** que el sistema de archivos (documentado: *"redirects are always processed before rewrites"*),
solo coinciden con rastreadores y, si la regla no funcionara en producción, **lo peor que pasa es que la tarjeta sigue neutra** (nada se rompe para nadie):

```
rastreador:  GET /            -> 307 Location: /api/publico?_ruta=vista-previa&_pagina=index
             GET /api/publico?... (UA de rastreador) -> 200 index.html con title, description y og:* del restaurante del Host
persona:     GET /            -> el archivo estático de siempre (sin pasar por ninguna función; index.html no cambió ni un byte)
```

Las reglas son para `/`, `/index.html` (menú) y `/pedido.html` (seguimiento: título "Sigue tu pedido | Nombre", sin copiar la referencia ni el token del enlace). User-Agent: `WhatsApp`, `facebookexternalhit`,
`Facebot`, `meta-externalagent`, `meta-externalfetcher` (Facebook e Instagram), `TelegramBot`, `Twitterbot` (X), `Slackbot`, `Slack-ImgProxy`, `LinkedInBot`, `Discordbot`. La misma lista está en `vercel.json` y en el módulo
(una prueba exige que sean idénticas, 6c). **No está "Instagram"** a propósito: es el navegador interno de la app (las *personas* que entran por el enlace de la biografía); la tarjeta de Instagram la arma el
rastreador de Meta. Tampoco Googlebot (ejecuta JavaScript). El módulo repite la comprobación (sin distinguir mayúsculas) y **a una persona que llegue a la función le responde 302 a la página normal**: aunque la
regla de Vercel fuera demasiado ancha, nunca se le sirve algo raro a una persona.

**Qué recibe el rastreador:** la propia `index.html` (o `pedido.html`) con el `<title>` cambiado y estas etiquetas agregadas al comienzo de la cabeza: `description`, `theme-color`, `og:site_name`, `og:type=website`,
`og:locale=es_CO`, `og:title`, `og:description`, `og:url` (`https://<host>/` o `/pedido.html`), `og:image` + `og:image:alt`, `twitter:card=summary`, `twitter:title`, `twitter:description`, `twitter:image`.
Título y descripción son los mismos que pinta la página (`titulo_pagina`/`descripcion_pagina`, o el nombre y "Pide en línea en <nombre>."). **La imagen** es el logo (o el ícono de 512, o el de 192) como URL
**absoluta https**: una ruta del sitio se completa con el host; una URL del Storage esperado se deja tal cual; todo lo demás (http, `//`, `javascript:`, `data:`, otros orígenes, usuario:clave) no sale.

**Seguridad.** Todo valor sale de `_publico.js` (mismas listas y validadores que `/api/restaurante`) y **se escapa** (`& < > " '`) para HTML y atributos; hay un test con un valor hostil en *cada* campo (3j) y 12 mutaciones
sobre el escape. Un host desconocido, una base caída, una página ilegible o cualquier excepción devuelven **la página neutra de siempre** (el archivo tal cual, o una página mínima con "Pedidos en línea" si ni se puede leer):
nunca datos de otro restaurante. El restaurante sale **solo del Host**, con la misma resolución de la sección 12.2.

**Riesgos de caché y cómo se resuelven.**

| Riesgo | Resolución |
|---|---|
| Que la CDN guarde la variante del rastreador y se la sirva a una persona (o la de un restaurante a otro) | La respuesta lleva `Cache-Control: private, no-store` y `Vary: Host, User-Agent`: **ninguna caché compartida la guarda**. Se descartó un `s-maxage` corto: el ahorro sería casi nulo (una invocación por cada rastreo) y el riesgo no. |
| Que la CDN guarde la *redirección* de un rastreador y se la sirva a personas | Las redirecciones de `vercel.json` se evalúan en cada petición, no son una respuesta guardada. Aun así, si ocurriera, la persona recibiría la página con etiquetas, que es la página completa y funciona; además el módulo la devuelve a `/`. |
| Que un rastreador reciba el archivo estático guardado en la CDN | La redirección va **antes** del sistema de archivos. Si no se aplicara, el rastreador ve lo de siempre (tarjeta neutra), no un error. |
| Suplantar el User-Agent | Cualquiera puede pedir la variante con `curl -A WhatsApp`: solo contiene datos que `/api/restaurante` ya entrega públicamente. Cada rastreo cuesta una invocación (la resolución del host sí se guarda 30 s); no hay límite de peticiones (pendiente P4). |
| Datos viejos | El servidor guarda **30 s** en memoria el restaurante de cada host (12.2): lo que el dueño edita se ve en el sitio y en la vista previa en ≤ 30 s. **WhatsApp, además, guarda la tarjeta de un enlace por días**: para verla de nuevo hay que cambiar el enlace (`?v=2`) o usar el depurador. |

### 17.4 "Datos de mi restaurante" (formulario del dueño)

En el menú lateral del panel (☰) aparece **"Datos de mi restaurante"**, **solo para el rol dueño**. Abre una ventana con 32 campos en 5 grupos. **No se editan aquí** (son del administrador y la base se lo
impide al dueño): colores, logo, tipografías, ubicación, domicilio, módulos, plan, estado, vigencia, llaves de pago y PWA.

| Grupo | Campos (regla de la base, docs 16.4) |
|---|---|
| Tu restaurante | **Nombre** (1 a 120; sin `<` `>` ni controles) |
| Contacto | WhatsApp (8 a 15 dígitos; se admiten espacios, `+`, paréntesis y guiones, **se guardan solo los números**), teléfono (≤ 40), dirección (≤ 200), dirección corta (≤ 200), ciudad (≤ 80), región (≤ 80), Instagram y TikTok (usuario `[A-Za-z0-9._]` ≤ 60, **se guarda sin @**) |
| Textos de tu página | título y descripción de la página (salen en la vista previa), eslogan, frase de portada, texto y cierre del pie, línea de servicios, ejemplo de nota (≤ 400 cada uno) |
| Avisos de abierto y cerrado | ícono, título y mensaje del aviso de abierto (escribe `{cierre}` para la hora de cierre), ícono y mensaje del de cerrado (≤ 400) |
| Seguimiento del pedido | 5 tiempos y 5 frases (≤ 200) |

**Reglas de todo texto** (idénticas a la base): una sola línea; sin `<` ni `>`; sin caracteres de control, de ancho cero ni marcas bidi; no puede parecer un secreto (`prv_`, `sb_secret_`, JWT, `apikey`...);
no puede ser una sola palabra de 32 o más letras/números. **Lo vacío borra el campo.**

**Cómo valida antes de guardar.** (1) En el navegador, con las mismas reglas; dice **en español qué campo falla y por qué**, lo marca (`aria-invalid`) y no manda nada. (2) Le pregunta a la base con la
config candidata (`public.config_restaurante_errores`, SQL 13): es la misma función del trigger, así que el aviso es el de la base; si lo que falla está *fuera* del formulario (por ejemplo un logo viejo
inválido) lo dice y pide avisar al administrador. (3) **Avisa de lo que se ajusta** (el WhatsApp queda solo en números, el usuario sin @, los saltos de línea pasan a espacios, los invisibles se quitan): deja
en el formulario exactamente lo que se guardará y pide pulsar Guardar otra vez. La prueba `reglas-navegador.mjs` compara el veredicto del navegador con el de la base en **14 415 combinaciones** de campo y valor
(hostiles, límites, emojis, secretos, números, usuarios, ruido): ninguna difiere.

**Cómo se evita perder claves y pisar ediciones.**
* **No se pierde ninguna otra clave de la config.** El formulario manda **solo los campos que cambiaron**, cada uno como `{campo, antes, despues}`, a `public.guardar_datos_restaurante(p_restaurante, p_cambios)`.
  La función toma el candado de la fila (`SELECT … FOR UPDATE`), modifica *esas rutas* dentro de la base (`jsonb_set` / `#-`) y guarda: no reemplaza la config entera, así que la marca, la ubicación, el domicilio,
  las llaves y el resto de los textos quedan EXACTAMENTE igual (comprobado campo por campo; y un campo que la persona no tocó no se manda aunque la copia guardada tenga espacios de más).
* **No se pisan cambios simultáneos.** Cada campo se compara con el valor que la persona *vio* ("antes"). Si otra persona ya lo cambió, la función **no guarda NADA** y devuelve los campos en conflicto con su
  valor actual; el formulario marca esos campos ("Otra persona cambió este dato… ahora dice «…»"), conserva lo que se escribió, actualiza los campos que la persona no tocó y pide revisar y pulsar Guardar otra vez
  (ahí sí reemplaza, a sabiendas). Dos ediciones de campos *distintos* se suman sin conflicto. El candado de la fila serializa a dos que lleguen a la vez: la segunda lee lo que guardó la primera.

**Quién puede.** La función exige ser el **dueño de ese restaurante** (o superadmin / servidor) y es **`SECURITY INVOKER`**: corre con los permisos de quien la llama, así que RLS y el trigger del SQL 13 siguen siendo
la defensa de fondo. Un cajero, la cocina, el dueño de *otro* restaurante, alguien sin membresía y `anon` reciben `42501` aunque fabriquen la llamada o hagan el `UPDATE` directo; un dueño que mande campos de la marca,
el plan, el estado, la vigencia, los módulos, el slug, las llaves, la ubicación o el domicilio recibe `22023` (no están en la lista cerrada) o `42501` (por `UPDATE` directo). Para los demás roles la opción además
**se esconde** (y `DatosRestaurante.abrir()` revisa el rol otra vez); esconderla es comodidad, no seguridad.

**Si falta el SQL 15** el formulario abre y carga, y al guardar dice "Falta activar esta función en la base de datos (el SQL 15)": no se pierde nada. Lo ya guardado se ve en el sitio público en ≤ 30 s (caché del servidor).

### 17.5 SQL 15 (`supabase/15-datos-restaurante.sql`)

Atómico, idempotente, con marcadores `-- >>> PASO n`, bloques `DO` que relanzan el error como `MR paso n: …`, barridos de catálogo por OID, **30 comprobaciones `OK`/`FALLA`**, apto para "Run without RLS".

1. **PASO 0** precondiciones: los SQL 10 a 13 aplicados (en especial el trigger `proteger_campos_restaurante` del 13) y la foto de las tablas para comprobar que no cambió ningún dato.
2. **PASO 1: horario y mensaje de cerrado validados en la base** (el pendiente 16.10-7). `public.configuracion_errores(horarios, mensaje, validar_horarios, validar_mensaje)` (función pura) y el trigger
   `configuracion_validar`. Reglas: `horarios` es una **lista de exactamente 7 días**, cada uno **con las claves `dia` (texto 1 a 20, sin `<` `>` ni controles), `abre` y `cierra` (`HH:MM` de 00:00 a 23:59; `cierra` también
   `24:00`) y `activo` (booleano)**, sin otras claves; `mensaje_cerrado` ≤ 300 caracteres, sin `<` `>`, sin controles ni invisibles (**sí** admite el salto de línea). Aplica a todos los roles. En un `INSERT` se revisa todo; en un
   `UPDATE` **solo lo que cambia** (cerrar o abrir el local nunca se frena por un horario viejo). **Antes de activarlo comprueba que el horario y el mensaje actuales de Taqueiros las cumplen y, si no, se detiene
   sin cambiar nada diciendo qué día y qué campo corregir** (`horarios.2.abre`: el 0 es Domingo y el 6 Sábado); los demás restaurantes solo se informan.
3. **PASO 2: `public.guardar_datos_restaurante`** (17.4), con lista cerrada de 32 campos, hasta 40 cambios por llamada, `search_path` fijo, `revoke` a `public` y `anon`, `grant` a `authenticated` y `service_role`.
4. **PASO 3** comprobaciones, entre ellas pruebas con un restaurante de prueba que **se deshace** (aplica, conflicto, borrar, campos no permitidos, pedidos mal formados, valores no válidos, sin membresía, `anon`) y las de seguridad:
   las funciones nuevas no son `SECURITY DEFINER`, `anon` no ejecuta ninguna, `anon` solo ejecuta `seguimiento` y `buscar_mis_pedidos`, RLS en todas las tablas, y ninguna fila cambió.

**Reversa:** `supabase/15-revertir.sql` (6 filas `OK`): quita el trigger y las tres funciones; no toca datos ni el SQL 13. El formulario mostrará que falta la función; el horario deja de validarse.

**Nota sobre el SQL 13:** se puede volver a correr después del 15 (se probó). Antes fallaba su prueba interna de `configuracion` (insertaba `'{}'`); ahora copia el horario de Taqueiros.

### 17.6 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` (no se ven): pega **UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos). No pegues ninguna llave en el chat.

**1. El despliegue ya ocurrió** (el `git push` a `main` despliega solo). Antes de tocar la base, haz las comprobaciones de **17.8** (A: funciones, URL, crons; B: vista previa). Con el SQL 15 sin correr, todo funciona igual;
solo el formulario nuevo dirá que falta la función al guardar.

**2. Respaldo** (solo lee):

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/exportar-respaldo.mjs
```

Esperado: filas por tabla y "Respaldo completo". Si dice "NO coincide", no sigas.

**3. SQL 15.** VS Code → abre `supabase/15-datos-restaurante.sql` → **Ctrl+A, Ctrl+C** → Supabase → SQL Editor → New query → pega → **"Run without RLS"**. Esperado: **30 filas, todas `OK`**. Si falla verás `MR paso n: …` o
`LA MIGRACION 15 SE REVIRTIO` con la lista, y **no se cambió nada**. Lo más probable: *"El horario o el mensaje de cerrado ACTUALES de Taqueiros no cumplen las reglas nuevas"* con la lista de qué día y campo corregir
(Table editor → `configuracion` → la fila de Taqueiros → `horarios`). Se puede repetir. **Si algo se rompe:** `supabase/15-revertir.sql` (6 filas `OK`).

**4. Pruebas contra la base real** (crean y borran sus propios restaurantes `test-…`; no tocan Taqueiros):

```powershell
node supabase/probar-compatibilidad.mjs                  # esperado: 26 PASAN (ahora pasa por api/publico.js)
node supabase/probar-servidor-multirestaurante.mjs       # esperado: todo PASA (174), "Limpieza: todo lo creado se borro."
$env:VIA = "despachador"; node supabase/probar-servidor-multirestaurante.mjs   # lo mismo, a través de api/publico.js y api/cron.js (174)
Remove-Item Env:VIA
node supabase/probar-aislamiento.mjs                     # esperado: todo PASA (con Realtime real; ≈259)
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

**5. Recorrido a mano** (17.8, parte C): entra al panel como dueño, ☰ → "Datos de mi restaurante".

**6. Pruebas locales** (no tocan la base real; una vez `npm i --no-save @electric-sql/pglite@0.2.17 @supabase/supabase-js@2.117.2`):

```powershell
node --test pruebas/*.test.js                             # unitarias (86)
node pruebas/multirestaurante/agrupacion.mjs              # 17.2: conteo, URL -> modulo, equivalencia contra d689d4d (32, ~10 s)
node pruebas/multirestaurante/vista-previa.mjs            # 17.3 (57, ~5 s)
node pruebas/multirestaurante/servidor.mjs                # 187; tambien --via=despachador y --via=reescrita
node pruebas/multirestaurante/datos-restaurante.mjs       # SQL 15 + formulario vs base (76, ~90 s); --mutaciones agrega la revision por mutacion
node pruebas/multirestaurante/panel.mjs                   # paginas privadas con 2 restaurantes (331, ~5 min); SOLO="^13\." corre solo el formulario
node pruebas/multirestaurante/mutaciones-agrupacion.mjs   # revision por mutacion de despachadores, reescrituras y vista previa (~10 min)
node pruebas/multirestaurante/mutaciones-15.mjs           # revision por mutacion del SQL 15 (~15 min)
```

### 17.7 Qué se probó y qué no

**Probado por mí (local, sin tocar la base real; Postgres 16 real en PGlite con los SQL 10 a 13 y 15, roles reales y RLS):**

* `agrupacion.mjs` (nuevo, **32**): conteo de funciones (exactamente las 6 y nunca más de 7), cada URL externa llega al módulo correcto (módulos-testigo; 13 URL × 4 formas de entregar la URL; `?_ruta=` hostil, `__proto__`, `constructor`...), y la
  **equivalencia contra el commit `d689d4d`**: 98 escenarios × (código de estado + cuerpo + todas las cabeceras), más el estado final de las dos bases y los avisos de WhatsApp. Cero diferencias.
* `vista-previa.mjs` (nuevo, **57**): dos restaurantes con su título, descripción e imagen (y 40 peticiones en paralelo sin cruces); 11 User-Agent de rastreadores × 3 rutas; 7 clases de personas/herramientas (incluye el navegador de Instagram y
  Googlebot) reciben el archivo estático, que es **byte a byte el del commit anterior**; datos hostiles escapados o descartados (con un valor hostil en *cada* campo); host desconocido, base caída, módulo roto, página ilegible o con otra forma → la página
  neutra; cabeceras; la misma lista de rastreadores en `vercel.json` y en el módulo; la página inyectada es la estática con solo lo agregado.
* `servidor.mjs` (**187**) contra los módulos, contra los despachadores con la URL original y con la reescrita. `probar-servidor-multirestaurante.mjs` contra el falso: **174** en los tres modos. `probar-compatibilidad`: **26** (ahora por `api/publico.js`).
* `datos-restaurante.mjs` (nuevo, **76**): el SQL 15 dos veces (30 comprobaciones `OK`), sin cambiar ningún dato; el dueño edita los 32 campos, no pierde claves, dos ediciones no se pisan (conflicto con el mismo campo; se suman con campos distintos);
  cajero, cocina, dueño de otro restaurante, sin membresía y `anon` rechazados (también por `UPDATE` directo); 30 campos fuera de la lista, 15 pedidos mal formados y 17 valores no válidos rechazados (también para el servidor); horarios y
  mensajes hostiles rechazados para dueño, superadmin y servidor; cerrar/abrir el local no se frena por un horario viejo; el SQL se detiene sin cambiar nada si el horario de Taqueiros no cumple (y dice día y campo) o si falta el SQL 13;
  convive con el SQL 14; la reversa; el SQL 13 se puede volver a correr después. **`reglas-navegador.mjs`: 14 415 combinaciones** de campo y valor con el mismo veredicto en el navegador y en la base, y lo que arma el formulario lo guarda la función tal cual.
* `datos-restaurante.test.js` (nuevo, **12**) y el total de unitarias: **86**.
* **`panel.mjs` (Chrome + `supabase-js` real + RLS real + Realtime emulado): 331**, con el **escenario 13 nuevo (59 comprobaciones, dos restaurantes)**: el dueño ve la opción y cajero/cocina no (aunque llamen al formulario desde la consola);
  cajero, cocina y el dueño de otro restaurante no pueden guardar fabricando la llamada ni por `UPDATE` directo; el dueño que fabrique plan, estado, vigencia, módulos, slug, marca, llaves, ubicación o domicilio es rechazado y **ni A ni B cambian
  en nada**; el dueño edita nombre, título, eslogan, seguimiento y teléfono: queda en la base, **no se pierde ninguna otra clave**, se manda solo lo que cambió, el nombre se ve de inmediato y **se refleja en `/api/restaurante`, el manifest y la página
  pública**; valores inválidos con mensaje en español y sin llamar a la base; ajustes avisados antes de guardar; **dos pestañas** (conflicto: no se pisa y no se guarda nada de la segunda; campos distintos: se suman); una config vieja inválida fuera del
  formulario; un nombre hostil guardado antes se muestra como texto; cancelar con cambios, Escape, perder el rol con el formulario abierto; sin errores de JavaScript. Revisadas a ojo las capturas a 1280 y 390 px (`CAPTURAS=<carpeta>`).
* **Revisión por mutación** (rompe una defensa a la vez y exige que algo la detecte): despachadores, reescrituras y vista previa **102 mutaciones: 99 detectadas, 3 equivalentes, 0 sin detectar**; SQL 15 **81: 65 detectadas, 16 equivalentes, 0**;
  formulario (navegador, menú y rol) **34: 31 detectadas, 3 equivalentes, 0**; páginas privadas anteriores **71: 64 / 7 / 0**; servidor **184: 174 / 10 / 0**; SQL 13 (`endurecer.mjs --mutaciones`) 536 pruebas, 0 fallas.
  La primera pasada dejó pasar 7 mutaciones del SQL 15 y 2 de la vista previa y obligó a agregar pruebas: el escape del `og:image` y del `og:url` (3j/3k), el nombre del día con caracteres de control, editar los 32 campos de una vez,
  un valor guardado con espacios de más, el servidor llamando con un restaurante que no existe, el mensaje claro del paso 0 y del paso 1.2. Las equivalentes están declaradas con su razón en cada archivo de mutaciones (casi todas son defensa en capas:
  por ejemplo, el `grant` a `authenticated` ya lo dan los privilegios por defecto de Supabase, o `req.query._ruta` y el alias `manifest.json` se cubren entre sí: quitando los dos juntos **sí** se detecta).
* Baterías anteriores, **todas verdes**: `e2e.js` del panel **180**, `comparar-tickets.mjs` **7 de 7**, `front.mjs` **104**, `rls.mjs` **237**, `hallazgos.mjs` **32**, `planes.mjs` **11**, `sim.mjs` **34 OK** (con y sin `conPendientes`), `dominios.mjs` **35**,
  `config-publica.mjs` **49**, `cargar-secretos-test.mjs` **20**, `endurecer.mjs` **426**, `migrar-fotos.mjs` **126**, `inspeccion.mjs` **4**, `probar-aislamiento` contra el falso **252 de 259** (las 7 que fallan son las de Realtime, que el falso no emula, igual
  que antes), `probar-menu-rls`, `probar-impresion-rls` y `probar-categoria-apagada` en orden. **Cambió lo esperado solo en:** `e2e.js` (el orden de las opciones del menú ahora incluye "Datos de mi restaurante", que ve el dueño de esa prueba),
  `front.mjs` (apaga el trigger del horario porque guarda a propósito un mensaje hostil) y `panel.mjs` (lo mismo para el horario hostil y la comparación "Taqueiros idéntico" ignora la opción nueva del menú).

**Solo se puede probar contra la base real o en producción (pendiente de Carlos):** el SQL 15 sobre el esquema verdadero (incluye que el horario real de Taqueiros pase las reglas: si no, el SQL lo dice y no cambia nada) y los scripts de `supabase/`;
que **Vercel real** se comporte como documenta (17.8: funciones = 6, `req.url`/`req.query` tras la reescritura, el cron de Vercel por la reescritura, la redirección por User-Agent en `/`, `includeFiles`); los depuradores de enlaces y WhatsApp real; un pago con
Wompi sandbox de punta a punta (el webhook es el mismo archivo de siempre); la impresora física; y el recorrido del formulario con tu cuenta real.

### 17.8 Qué comprobar en producción apenas termine el despliegue

Lo único que ninguna prueba local reemplaza (Vercel real). En PowerShell (usa `curl.exe`, no `curl`, que en Windows es un alias de otro comando). `$h` es el dominio de Taqueiros.

**A. Las funciones, las URL y los crons**

```powershell
$h = "https://taqueiros-2-0.vercel.app"
curl.exe -s -o NUL -w "menu:           %{http_code} %{content_type}`n" "$h/api/menu"          # 200 application/json
curl.exe -s -o NUL -w "estado:         %{http_code}`n" "$h/api/estado"                          # 200
curl.exe -s -o NUL -w "disponibilidad: %{http_code}`n" "$h/api/disponibilidad"                  # 200
curl.exe -s -o NUL -w "restaurante:    %{http_code}`n" "$h/api/restaurante"                     # 200
curl.exe -s -D - -o NUL "$h/manifest.json" | Select-String "HTTP/|content-type"                 # 200 application/manifest+json
curl.exe -s "$h/api/restaurante" | ConvertFrom-Json | Select-Object nombre, slug                # el nombre y slug de Taqueiros
curl.exe -s -i "$h/api/alertas"    | Select-String "HTTP/|No autorizado"                        # 401 {"error":"No autorizado"}
curl.exe -s -i "$h/api/keep-alive" | Select-String "HTTP/|No autorizado"                        # 401
curl.exe -s -i -X POST "$h/api/webhook-wompi" -H "Content-Type: application/json" -d "{}"       # 200 {"received":true} (como siempre; NO 404 ni 405)
```

Los dos crons con credencial (el secreto se pide una sola vez y no queda en el historial):

```powershell
$s = Read-Host "CRON_SECRET (UNA sola vez)" -AsSecureString
$e = [System.Net.NetworkCredential]::new('', $s).Password
curl.exe -s -H "Authorization: Bearer $e" "$h/api/keep-alive"          # {"ok":true,"momento":"...","huerfanosBorrados":...}
curl.exe -s -o NUL -w "alertas con Bearer:  %{http_code}`n" -H "Authorization: Bearer $e" "$h/api/alertas"   # 200
curl.exe -s -o NUL -w "alertas con ?clave=: %{http_code}`n" "$h/api/alertas?clave=$e"                        # (desde la sección 19.8 esto da 401: ?clave= se retiró)
Remove-Variable e, s
```

* Vercel → proyecto → **Deployments** → el último → **Functions** (o el log del *build*): deben ser **6** (`publico`, `cron`, `crear-pedido`, `generar-firma`, `reembolso`, `webhook-wompi`).
* Vercel → **Settings → Cron Jobs** → `/api/keep-alive` → **Run**: en los logs debe salir `[KeepAlive] Supabase respondio…` y 200 (es la prueba de que el cron de Vercel pasa por la reescritura).
* cron-job.org: el siguiente disparo de `/api/alertas` y `/api/keep-alive` debe quedar en 200 (su historial). **No cambies sus URL.**
* Wompi (sandbox): un pedido de punta a punta (llega al panel, suena, imprime, llega el WhatsApp). Es la prueba de que `/api/webhook-wompi` sigue entregando.
* Taqueiros se ve igual: menú, pedido, seguimiento, panel con impresión automática y Reimprimir, historial, resumen, menu-admin.

**B. La vista previa de enlaces** (si algo de esto falla, no se rompió nada: la tarjeta sigue neutra; ver el plan B en 17.9)

```powershell
# Un rastreador: 307 hacia la funcion...
curl.exe -s -D - -o NUL -A "WhatsApp/2.23.20.0" "$h/" | Select-String "HTTP/|location"          # HTTP/2 307 + location: /api/publico?_ruta=vista-previa&_pagina=index
# ...y, siguiendo la redireccion (-L), la pagina con las etiquetas del restaurante
curl.exe -sL -A "WhatsApp/2.23.20.0" "$h/" | Select-String '<title>|og:|twitter:|theme-color|name="description"'
curl.exe -sL -D - -o NUL -A "facebookexternalhit/1.1" "$h/" | Select-String "HTTP/|cache-control|vary|x-vista-previa"
#   esperado al final: 200, cache-control: private, no-store, vary: Host, User-Agent, x-vista-previa: restaurante
# Una persona: el HTML estatico de siempre (sin x-vista-previa, sin redireccion)
curl.exe -s -D - -o NUL -A "Mozilla/5.0 (Windows NT 10.0) Chrome/120" "$h/" | Select-String "HTTP/|x-vista-previa|cache-control"
curl.exe -s -A "Mozilla/5.0 (Windows NT 10.0) Chrome/120" "$h/" | Select-String "<title>"       # <title>Pedidos en línea</title>
# El navegador de Instagram es una persona (no debe redirigir)
curl.exe -s -D - -o NUL -A "Mozilla/5.0 (iPhone) Instagram 300.0" "$h/" | Select-String "HTTP/"  # HTTP/2 200
# El seguimiento: titulo propio y la referencia NO aparece
curl.exe -sL -A "Twitterbot/1.0" "$h/pedido.html?ref=TAQ-123-abcdef" | Select-String "<title>|og:url"
```

Depuradores (así lo ve cada red): **Facebook/Instagram** → [Sharing Debugger](https://developers.facebook.com/tools/debug/) → pega `https://taqueiros-2-0.vercel.app/` → *Scrape Again* (muestra el título, la
descripción, la imagen y la "ruta de redirección"); **LinkedIn** → [Post Inspector](https://www.linkedin.com/post-inspector/); **Telegram** → pega el enlace en *Mensajes guardados*; **Discord** → pégalo en un canal
privado; **WhatsApp** → mándalo a tu propio chat (**WhatsApp guarda la tarjeta de cada enlace por días: agrégale `?v=2` para forzar una nueva**); **X**: ya no hay validador, se ve al publicar. Con un segundo restaurante
registrado (17.9), repite con su dominio: cada uno debe mostrar su nombre y su logo.

**C. El formulario** (con tu usuario dueño, en `https://taqueiros-2-0.vercel.app/panel.html`)

1. ☰ → **Datos de mi restaurante**: abre con el nombre, el contacto y los textos de siempre. Con el SQL 15 sin correr dirá "Falta activar esta función…" al guardar.
2. Cambia solo el **eslogan**, **Guardar** → "Datos guardados". En ≤ 30 s `https://taqueiros-2-0.vercel.app/` muestra el eslogan nuevo. Déjalo como estaba.
3. WhatsApp con espacios y `+` → avisa que se guardarán solo los números. Un texto con `<b>` → se rechaza en español. Cancelar con cambios → pide confirmar.
4. Con un usuario **cajero** o **cocina**: la opción no aparece en ☰.
5. Dos pestañas con el formulario abierto: guarda un campo en la primera y el *mismo* campo en la segunda → avisa que otra persona lo cambió y no pisa nada.

**D. Si algo sale mal:** el deploy se revierte con `git revert --no-edit <hash> && git push` (los hashes están en el debrief) y, para la base, `supabase/15-revertir.sql`. Ninguna reversa toca datos.

### 17.9 Riesgos y pendientes (para la revisión de Opus de 2B-3, 2B-4 y 2B-5, y para el panel de superadmin)

1. **Vercel no se pudo probar aquí.** El enrutador está emulado según la documentación (`vercel-emulador.mjs`: redirects → sistema de archivos → rewrites). Los supuestos que solo producción confirma están en 17.2 y 17.8:
   forma de `req.url`/`req.query` tras una reescritura (el despachador acepta las dos), el cron de Vercel pasando por la reescritura, y que las `redirects` con `has` por `user-agent` se apliquen a `/`.
   **Plan B de la vista previa** si el curl del paso B no redirige: (a) mover `index.html` y `pedido.html` a una carpeta (p. ej. `paginas/`) y reescribir `/`, `/index.html`, `/pedido.html` hacia allá *para todos*, con la regla
   por User-Agent *antes*; así `/` deja de ser un archivo y la reescritura sí se evalúa (cambia dónde viven los archivos y exige tocar las pruebas que los leen); o (b) Routing Middleware (una función más).
2. **El despachador (`_despacho.js`)** es lo nuevo con más superficie. Revisar: que el path mande sobre `_ruta`, que los nombres con prototipo no cuenten, que `cron` y `publico` no se sirvan mutuamente, y que `autorizadoCron` siga
   leyendo `?clave=` de `req.url` (ahí `?clave=` viaja intacto por la reescritura; Vercel conserva la consulta original).
3. **Vista previa:** es una función pública sin caché, invocable con solo cambiar el User-Agent (cuesta una invocación; la resolución del host sí se guarda 30 s). No hay límite de peticiones (P4 sigue pendiente). Lee `index.html` y
   `pedido.html` del disco (`includeFiles`): si alguien las reorganiza, `inyectar` devuelve `null` y se sirve la página tal cual (una prueba, 7c, avisa).
4. **`guardar_datos_restaurante`:** `SECURITY INVOKER`; la defensa real es RLS + `proteger_campos_restaurante` (SQL 13). Si algún día se amplía lo que el trigger deja escribir al dueño, esta función sigue acotada a su lista de 32 campos. Aceptan
   la función `authenticated` (por privilegios por defecto y grant explícito) y `service_role`; un **superadmin** también puede usarla (no es miembro: pasa por `es_superadmin()`). Los 32 campos están en **cuatro lugares** que una prueba compara
   (la lista del SQL, `datos-restaurante.js`, las reglas del SQL 13 y esta documentación).
5. **Horario:** el trigger nuevo también rechaza al servidor y al superadmin un horario de otra forma (exactamente 7 días con `dia/abre/cierra/activo`). `aprovisionar_restaurante()` crea uno válido. Un restaurante cuyo horario *actual* no cumpla solo se
   informa al aplicar el SQL (se valida cuando cambie su horario). El panel actual (`horariosBtn`) escribe exactamente esa forma.
6. **Caché de 30 s** (`_restaurante.js`): lo que edita el dueño tarda hasta 30 s en verse en el sitio, el manifest y la vista previa (por instancia). Si molesta, el formulario podría llamar a un endpoint que invalide la caché (agregaría un endpoint con sesión).
7. **Panel de superadmin** *(base y servidor hechos en la sección 19; la pantalla es el 3B)*: había 6 funciones libres. `api/_sesion.js` ya existe; el panel actual **no deja entrar a un superadmin que no sea miembro** (15.3), así que la interfaz deberá traer su camino de "entrar como". `guardar_datos_restaurante`
   y `config_restaurante_errores` ya le sirven al superadmin; **la marca, la ubicación, el domicilio y las llaves** siguen sin formulario (solo SQL o `UPDATE` con la llave de servidor): un formulario de superadmin deberá escribirlos por una función
   propia (con auditoría) y validar con `config_restaurante_errores`.
8. **Para agrupar más** (si hiciera falta espacio): `crear-pedido` + `generar-firma` + `reembolso` → una función `pedidos`; el despachador ya lo permite. No se hizo para no tocar la lógica de dinero.
9. Sin cambios: `?clave=` del cron (se mantiene), el defecto transitorio ya retirado en la 16, Realtime y `DELETE`, P1 (`wompi_modo` de Taqueiros antes de cobrar de verdad), P2/P4–P13.

---

## 18. Revisión adversaria de 2B-3, 2B-4 y 2B-5 (independiente)

Revisión hecha como atacante (dueño, cajero o cocina de un restaurante cliente, dueño de **otro** restaurante, cliente final, rastreador falso) del
despachador, la vista previa, el formulario del dueño, el SQL 13/14/15, la sesión, los campos de configuración y el respaldo de Taqueiros, leyendo el
código y comprobando cada hallazgo con una prueba que **falla antes** de la corrección y pasa después. No se ejecutó SQL contra la base real ni se
usó ninguna llave real. **No hay SQL nuevo**: ninguno de los hallazgos corregidos lo necesitaba, y los que lo necesitarían esperan tu decisión (18.2).

### 18.1 Hallazgos

| # | Severidad | Dónde | Qué pasa (cómo se explota) | Estado | Prueba |
|---|---|---|---|---|---|
| R1 | **Media** | `api/_modulos/alertas.js` (envío de la alerta) | `notificarWhatsApp` **no lanza**: si CallMeBot no encola el mensaje (tiempo agotado, apikey inválida = 203, 500, red caída) devuelve `{enviado:false}`. El cron marcaba `alerta_enviada = true` igual, contra lo que decía su propio comentario: el aviso de un pedido pagado y sin atender **se perdía para siempre** con cualquier fallo pasajero de CallMeBot (y con un CallMeBot lento, el envío cortado por tiempo también quedaba marcado). | **Corregido** (`e12f25e`): solo se marca lo enviado; lo demás sale en la siguiente pasada (sigue acotado por la ventana de 2 h y 10 por restaurante). | `servidor.mjs`: "una alerta que CallMeBot NO entregó (203, 500 o red caída) no se marca…" y H5 (solo se marca lo que terminó). Mutaciones R1 (2, detectadas). |
| R4 | **Media** (error de operación; fuga de datos entre restaurantes) | `supabase/cargar-secretos.mjs` | Lee variables con los **mismos nombres** que las de Taqueiros en Vercel. Si quedaban puestas en la sesión de PowerShell (12.9 paso 4) al cargar un restaurante nuevo, este recibía los secretos de Wompi de Taqueiros (cada uno podría aprobar pedidos del otro: P11) y su CallMeBot (las comandas, con nombre, teléfono y dirección de los clientes del nuevo, llegarían al WhatsApp de Taqueiros). El servidor no lo podía impedir: para él son "secretos del restaurante". | **Corregido** (`f6044bd`): compara en memoria con los demás restaurantes y no guarda **nada** (sale 2); `--solo-verificar` lo avisa (sale 1). CallMeBot compartido a propósito (mismo dueño): `--permitir-repetidos`. Wompi repetido: nunca. No imprime nada del valor. | `cargar-secretos-test.mjs`: 5 pruebas R4 (20 → 25). |
| R3 | Baja-media | `panel.html` (guardar horario) | Desde el SQL 15 la base rechaza un mensaje de cerrado de más de 300 caracteres, con `<`/`>` o con controles (p. ej. un tabulador pegado). El panel lo mandaba igual y solo decía "No se pudo guardar el horario": el dueño **no podía guardar su horario** ni saber por qué. | **Corregido** (`8fcd060`): revisa largo y `< >` antes de mandar y, si la base responde `23514`, dice el motivo. Sin cambios en el HTML visible (sw.js no guarda `panel.html`: sin versión nueva). | `panel.mjs` escenario 5 (4 pruebas R3) y 2 mutaciones en `mutaciones-panel.mjs` (detectadas). |
| R5 | Media | `supabase/10-multirestaurante.sql:1508` (`mr_pedidos_insert`) | El **dueño y el cajero** pueden insertar pedidos directamente por REST con `estado_pago = 'aprobado'`, el total y los productos que quieran: ventas "pagadas" falsas que cuentan en el resumen de la jornada y el historial, y comandas que el panel muestra (y puede imprimir) en cocina. Es de su propio restaurante (no cruza a otro: el `WITH CHECK` exige su rol en **ese** `restaurante_id`), pero ninguna pantalla inserta pedidos (16.2). `rls.mjs` lo trata como diseño ("cajero A crea pedidos"). | **Necesita tu decisión**: si no habrá pedidos de mostrador, retirar la política (o dejarla solo con `estado_pago = 'pendiente'`). Es un SQL 16 de 3 líneas con su reversa; no lo escribí para no cambiar un diseño probado sin tu visto bueno. | — |
| R6 | Baja | `supabase/10-multirestaurante.sql` (`mr_pedidos_update` + `proteger_campos_de_pago`) | Cocina, cajero y dueño pueden cambiar, en pedidos de **su** restaurante, columnas que el panel nunca escribe: datos del cliente, `wompi_ambiente`, `pagado_en`, `alerta_enviada`, `notificacion_ok`… (lo de dinero, número, referencia y reembolso sí está bloqueado). Con `wompi_modo` fijado el webhook ya no se deja engañar por `wompi_ambiente`. | **Necesita tu decisión**: lista de **lo permitido** como la del SQL 13 (`estado` y lo que escriben `reclamar_impresion`/`registrar_reimpresion`). Toca la impresión, por eso no lo hice. | — |
| R7 | Baja | `panel.html` (`horaValida`, guardar horario), `index.html` (`formatHour`) | La base (SQL 15) y el servidor (`_horario.js`) aceptan `cierra = "24:00"` y horarios que cruzan la medianoche (18:00–02:00), pero el panel no: un `<input type="time">` no puede mostrar `24:00` (queda vacío) y al guardar **se convierte en 22:00 sin avisar**; un horario de medianoche no se deja guardar ("la hora de cierre debe ser posterior"), ni siquiera para cambiar solo el mensaje; y la página pública muestra `24:00` como "12:00 p.m." (mediodía). Hoy solo se llega ahí si tú cargas ese horario por SQL. | **Necesita tu decisión**: (a) prohibir `24:00` en el SQL (usar 23:59) y no ofrecer medianoche, o (b) que el panel y la página los soporten. | — |
| R8 | Baja | `13-endurecer.sql` (`c_control`), `15-datos-restaurante.sql`, `datos-restaurante.js` | Los separadores de línea Unicode `U+2028`/`U+2029` no están en la lista de "controles e invisibles": la base y el formulario los aceptan en un texto de "una línea", y el servidor los convierte en espacio (`\s`), lo que rompe la regla de oro de 16.4 ("lo que acepta la base sale igual"). Sin efecto de seguridad (todo sale escapado o con `textContent`). | **Solo reportado**: el arreglo es agregar `chr(8232)`/`chr(8233)` en los 4 lugares (SQL 13 y 15 → SQL 16 que redefine `config_restaurante_errores`). | — |
| R9 | Sospecha (no demostrable sin la base real) | `api/_sesion.js:71` | Si el gateway real responde `401 … "Invalid API key"` a un `Authorization: Bearer sb_…` fabricado, el helper lo toma por "llave del proyecto rechazada" y `reembolso` responde **500** en vez de 401. El falso responde "Invalid JWT" (401) a ese caso. | **Solo reportado**. Verificar con `diagnosticar-auth.mjs` (la variante con la secreta como Bearer); si da "api key", descartar antes de la red los tokens que empiezan por `sb_` (un JWT real empieza por `eyJ`). | — |
| R10 | Sospecha baja | `14-retirar-regla-bucket.sql:115` (`validar_producto`) | Es la única función de 2B-4 con `set search_path = public` en vez de `''`. Solo sería explotable si `anon`/`authenticated` pudieran crear objetos en `public` (Postgres 15+ y Supabase no lo permiten por defecto). | **Solo reportado**. Comprobar (solo lectura): `select has_schema_privilege('authenticated','public','CREATE'), has_schema_privilege('anon','public','CREATE');` → deben ser `false`, `false`. | — |

### 18.2 Revisado sin hallazgo (con la lectura concreta)

1. **Despachador** (`_despacho.js`, `publico.js`, `cron.js`). El último segmento del path manda sobre `_ruta` (`/api/menu?_ruta=restaurante` es el menú); `_ruta` solo se acepta si está en el `Set` de **esa** función, y la tabla de nombres es `Object.create(null)`, así que `__proto__`, `constructor`, `toString` o `hasOwnProperty` no resuelven (y `rutas[nombre]` solo se indexa con un nombre ya validado). `publico` y `cron` tienen conjuntos disjuntos: `/api/cron?_ruta=menu` y `/api/publico?_ruta=alertas` son 404. Un `_ruta` repetido llega como arreglo en `req.query` (se ignora) y de la URL se toma el primero: en el peor caso es otro endpoint **de la misma función**, con sus mismas protecciones, y se guarda en la caché del borde con **su propia URL** (no envenena `/api/menu`). `?clave=` sigue funcionando (lo lee `autorizadoCron` de `req.url`; las reescrituras conservan la consulta); las respuestas de los crons no llevan `Cache-Control` público, así que Vercel no las guarda. La clave **sí** queda en el log de Vercel y en el historial de cron-job.org, como siempre (por eso se recomienda pasar cron-job.org a `Authorization: Bearer` y después retirar `?clave=`).
2. **Vista previa.** Solo usa `_publico.js` (lo mismo que `/api/restaurante`): ni plan, ni vigencia, ni gracia, ni secretos, ni el resto de `config`. Todo valor pasa por `esc()` (`& < > " '`); un salto de línea en un atributo no rompe nada y `texto()` ya los vuelve espacio; `inyectar` arma la página con `slice` (sin `$&` de `replace`). `_pagina` es una lista cerrada (`pedido`, o si no `index`): no lee otro archivo; la redirección a una persona va a una ruta fija (`/` o `/pedido.html`), nunca a un dato de la petición. `Cache-Control: private, no-store` + `Vary: Host, User-Agent` en la página, y `private, no-store` en el 302 a personas. La 307 de Vercel no es "cacheable por heurística" (RFC 9111) y en producción llega con `Cache-Control: public, max-age=0, must-revalidate` (comprobado después del despliegue de esta sección): ninguna caché intermedia se la sirve a otra persona sin volver a preguntar.
3. **Formulario del dueño.** `guardar_datos_restaurante` es `SECURITY INVOKER` con `search_path = ''` y nombres calificados; exige `rol_en(p_restaurante) = 'dueno'` (membresía **activa** de ese restaurante), superadmin o servidor, y además RLS (`USING`/`WITH CHECK`) y el trigger `proteger_campos_restaurante` (lista de lo permitido) siguen mandando. Lista cerrada de 32 campos; cada cambio solo admite `campo`, `antes`, `despues` (texto o null); 40 cambios como máximo; la config entera ≤ 20 000 caracteres (la valida el trigger); un dueño de otro restaurante recibe 42501. Las claves con prototipo no significan nada en SQL y el formulario lee los campos de una lista fija. `SELECT … FOR UPDATE` serializa dos guardados: el segundo relee lo que dejó el primero y, si un campo cambió, no guarda nada. `configuracion_errores` / `validar_configuracion` no son `DEFINER` y tienen `search_path` fijo.
4. **Matriz de mínimo privilegio** (además de R5/R6): ninguna política permite insertar o actualizar con el `restaurante_id` de otro restaurante (todas atan el rol al `restaurante_id` de la fila; `bloquear_cambio_restaurante` impide moverla); `restaurante_secretos`, `contadores_pedido`, `restaurante_dominios`, `intentos_buscar_pedido` y `personal` sin privilegios para clientes; `siguiente_numero_pedido` y `realinear_secuencia_pedidos` solo `service_role`. Las funciones `SECURITY DEFINER` (`siguiente_numero_pedido`, `asignar_numero_pedido`, `aprovisionar_restaurante`, `config_jornada`, `realinear_secuencia_pedidos`, `seguimiento`, `buscar_mis_pedidos`) no escriben en `restaurantes`, `configuracion` ni `pedidos` con datos de quien llama. Esto importa porque `es_servidor()` y `proteger_campos_de_pago()` tratan `current_user = postgres` como servidor: **regla para el futuro**, ninguna función `DEFINER` nueva debe escribir en esas tablas con datos del cliente. Storage: `puede_gestionar_fotos` exige que la primera carpeta sea un restaurante del que eres dueño activo; la raíz da `foldername[1] = null` (no coincide) y `..` se rechaza; `UPDATE` (mover) revisa el destino con `WITH CHECK`.
5. **Sesión.** El restaurante sale del Host (`exigirRestaurante`) y la autorización se mira contra **ese** `restaurante_id` (`miembros` con `rol = dueno` y `activo`); cajero y cocina reciben 403; el panel consulta `miembros` con el id que devolvió `/api/restaurante`, y RLS es la defensa de fondo. Un token manipulado o vencido es 401 (H9 y las pruebas de 12.12), salvo la sospecha R9.
6. **Campos de configuración.** `publico`, `ubicacion` y `domicilio` coinciden en la base (`13-endurecer.sql`), el servidor (`_publico.js`, `_ubicacion.js`, `_domicilio.js`), el navegador (`restaurante-publico.js`, `panel-restaurante.js`) y el formulario (`datos-restaurante.js`; una prueba compara las listas). **Lugares que la tabla de 16.4 no nombraba**: `datos-restaurante.js` (los 32 campos del dueño), `_respaldo-taqueiros.js` y la mezcla del SQL 12 (valores de Taqueiros), y para `horarios`/`mensaje_cerrado`: el SQL 15, `_horario.js`, `panel.html` (escribe) e `index.html` (muestra). Diferencias encontradas: R3 (corregida), R7 y R8.
7. **Respaldo con variables de entorno.** En el servidor solo aplica si `restaurante.id` es exactamente el de Taqueiros (`conRespaldoEnv`, `modoDePago`, `_ubicacion.js`, `_domicilio.js`, `configEfectiva`), y ese `id` sale de la base (del Host o del pedido, nunca del navegador) y nadie puede cambiarlo (trigger + llave primaria). El único camino para que otro restaurante "cayera" en esas variables era el script de carga: R4, corregido.
8. **Plan B de la vista previa (17.9-1): sigue siendo viable.** Las páginas solo usan rutas relativas (`restaurante-publico.js?v=2`, `Recursos/…`, `pedido.html?ref=…`) que el navegador resuelve contra la URL (`/`), no contra la carpeta del archivo, así que moverlas a `paginas/` y reescribir `/`, `/index.html` y `/pedido.html` hacia allá *para todos* no rompe nada. Lo que habría que tocar: la regla por User-Agent va **primero** en `rewrites` (se evalúan en orden), `functions.includeFiles` y `leerPagina` pasan a `paginas/`, y las pruebas que leen `index.html`/`pedido.html` de la raíz (`front.mjs`, `vista-previa.mjs`, `agrupacion.mjs`). `/paginas/index.html` quedaría accesible directamente (sin daño). `sw.js` sigue en la raíz (su alcance no cambia).

### 18.3 Pendientes A–D

**A. H5 de alertas (`escenarios-servidor.mjs`).** El CallMeBot "lento" adelantaba el reloj simulado 4 s por envío **sin respetar el corte** que el servidor le pone a cada envío (`tiempoMaximoMs`, como haría `fetch`): con dos envíos el tiempo simulado ya era 8 s y cualquier latencia real de la base (desde el PC) lo llevaba a ~9,2 s o más. Ahora el CallMeBot lento **espera 4 s de verdad** y se corta con la señal del servidor, y se mide con el reloj real. Lo que exige no se debilitó, se reforzó: B recibe su aviso en la primera pasada, A hace **a lo sumo 2 intentos**, el segundo **se corta** (no termina), solo se marca lo que terminó y la segunda pasada completa los 6; la corrida dura < 10 s (localmente ~7,5 s; contra la base real se espera ~8 s, porque después del corte no queda trabajo de red).
**B. Realtime (`probar-aislamiento.mjs`).** Ahora (1) le pasa el token a Realtime antes de unirse, (2) después de `SUBSCRIBED` espera el mensaje de sistema de `postgres_changes` (`status: ok`, que es cuando la replicación ya escucha; si ese Realtime no lo manda, 3 s de margen) y (3) repite el control positivo **hasta 3 rondas** con pedidos nuevos, hasta que cada dueño vea un INSERT suyo. El aislamiento se evalúa sobre **todos** los eventos de **todas** las rondas: un solo evento de B en A falla igual que antes. Las mismas 7 pruebas.
**C. Límite de peticiones (propuesta, sin implementar).**

| Opción | Cómo | Costo en Vercel | Costo en Supabase | Pro / contra |
|---|---|---|---|---|
| 1. Firewall de Vercel (regla de rate limit) | Regla por IP para `/api/crear-pedido`, `/api/generar-firma`, `/api/publico` (vista previa) | 0 funciones | 0 | Sin código y corta **antes** de invocar la función. Hay que confirmar en tu panel si el plan Hobby trae reglas de *rate limit* (las condiciones del Firewall sí; el límite puede ser de Pro). No sirve para `buscar_mis_pedidos` ni `seguimiento` (van directo a Supabase). |
| 2. Memoria de la instancia | Contador por IP (y por restaurante) en un `Map` del módulo, ventana de 1 min | 0 | 0 | Gratis y sin latencia, pero cada instancia cuenta por su lado y un arranque en frío lo borra: frena a un abusador torpe, no a uno distribuido. Bueno para la vista previa. |
| 3. Tabla en Supabase + función atómica | `limites_peticiones (clave, ventana, n)` con PK `(clave, ventana)` y `consumir_cupo(clave, limite, segundos)` (`INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n`), solo `service_role`, sin políticas. Claves: `ip:<hash de x-real-ip>` y `rid:<restaurante>`. La limpieza de ventanas viejas la hace `keep-alive` | 0 funciones nuevas | 1 tabla + 1 función; 1 consulta más (~20–60 ms) por petición protegida | Cuenta global y exacta. Para `buscar_mis_pedidos` (que ya limita por celular con `intentos_buscar_pedido`) se le puede agregar dentro un tope por restaurante; el tope por IP ahí depende de la IP que Supabase pase en `request.headers` (hay que comprobar que no la pueda fijar el cliente). |

**Recomendación:** 1 si tu plan lo incluye (cero código) **y** 3 para `crear-pedido` y `generar-firma` (las que escriben y consumen números de pedido), con 10/min por IP y un tope generoso por restaurante (p. ej. 300 por 10 min, decisión de negocio por las horas pico); 2 para la vista previa. Ninguna agrega funciones de Vercel (seguirían 6 de 12) ni servicios de pago.

**D. Modo de cobro (sin cambiar nada).** Hoy lo decide `modoDePago()` (`api/_restaurante.js:357`): si `restaurante_secretos.otros.wompi_modo` es `test` o `produccion`, manda eso y se ignora el navegador; si no está, **solo para Taqueiros** se usa el `modo` que manda el cuerpo de `crear-pedido`/`generar-firma` (`"produccion"` → producción, cualquier otra cosa → prueba); otro restaurante sin `wompi_modo` no cobra. **El navegador todavía puede elegirlo para Taqueiros**, pero hoy no es explotable: lo que el servidor le dice a la página es `test`, y quien fuerce `"produccion"` paga de verdad (con la llave y el secreto de producción) o recibe 500 si no hay secreto prod; el caso peligroso (pagar en prueba un pedido de producción) ya lo cierran H1 y el `wompi_modo` fijado. **Cambio mínimo propuesto**, para después de que cargues `WOMPI_MODO=produccion`: en `modoDePago`, cambiar `return modoDelCliente === "produccion" ? "produccion" : "test";` por `return "test";` (el modo deja de depender del cuerpo; `crear-pedido` y `generar-firma` no cambian de contrato: el campo `modo` se sigue aceptando y se ignora) y ajustar las pruebas de `escenarios-servidor.mjs` que hoy esperan el modo del navegador para Taqueiros. Más adelante, retirar el respaldo entero y exigir `wompi_modo` también a Taqueiros.

### 18.4 Qué correr (Windows)

No hay SQL nuevo que correr. Contra la base real (crean y borran sus propios restaurantes de prueba; no tocan Taqueiros):

```powershell
$k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/probar-compatibilidad.mjs                                        # esperado: 26 PASAN
node supabase/probar-servidor-multirestaurante.mjs                             # esperado: 175 PASAN (antes 174: +1 de R1)
$env:VIA = "despachador"; node supabase/probar-servidor-multirestaurante.mjs   # 175; la H5 debe durar ~8 s (antes ~9,2 s)
Remove-Item Env:VIA
node supabase/probar-aislamiento.mjs                                           # esperado: 259/259 (Realtime con confirmacion y reintento)
node supabase/diagnosticar-auth.mjs                                            # R9: mira la variante con la secreta como Bearer
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

Y en el SQL Editor (solo lectura, R10): `select has_schema_privilege('authenticated','public','CREATE'), has_schema_privilege('anon','public','CREATE');` → `false`, `false`.
**Cuando cargues secretos de un restaurante nuevo:** abre una ventana nueva de PowerShell (o `Remove-Item Env:WOMPI_*, Env:CALLMEBOT_*` antes); si quedaron los de otro, `cargar-secretos.mjs` ahora se detiene y lo dice (R4).

### 18.5 Qué se probó (local, sin tocar la base real)

Todas verdes: unitarias **86**, `agrupacion.mjs` **32**, `vista-previa.mjs` **57**, `servidor.mjs` **188** (187 + 1 de R1; también 188 con `--via=despachador` y `--via=reescrita`),
`datos-restaurante.mjs` **76**, `rls.mjs` **237**, `hallazgos.mjs` **32**, `planes.mjs` **11**, `sim.mjs` **34 OK** (con y sin `conPendientes`), `dominios.mjs` **35**, `config-publica.mjs` **49**,
`cargar-secretos-test.mjs` **25** (20 + 5 de R4), `endurecer.mjs` **426**, `migrar-fotos.mjs` **126**, `inspeccion.mjs` **4**, `front.mjs` **104**, `panel.mjs` **335** (331 + 4 de R3), `e2e.js` **180**,
`comparar-tickets.mjs` **7 de 7 idénticos**; contra el falso: `probar-compatibilidad` **26**, `probar-servidor-multirestaurante` **175**, `probar-aislamiento` **252 de 259** (las 7 de Realtime, que el falso
no emula, como siempre), `probar-menu-rls` y `probar-impresion-rls` "TODO BLOQUEADO", `probar-categoria-apagada` "Todo en orden". Mutaciones de lo que cambió: alertas (`mutaciones-servidor.mjs --solo=alertas`)
**11 detectadas, 0 sobrevivientes** (incluye las 2 nuevas; "avisa aunque no haya contacto" pasó a equivalente declarada: desde R1 es defensa en capas), y las 2 nuevas del panel, detectadas.
Cada prueba nueva se corrió también contra el código anterior y **falla** (R1: 2 pruebas; R3: 4; R4: 5).

### 18.6 Riesgos que se aceptan de forma explícita y lo que sigue pendiente

* R5, R6, R7: esperan tu decisión (18.1). R8 y la propuesta D: listas para un paso siguiente. R9 y R10: verificar con la base real (18.4).
* `?clave=` del cron queda en el log de Vercel y en cron-job.org (se mantiene a propósito; recomendación en 18.2-1). *(Retirado en la sección 19.8.)*
* El límite de peticiones (P4) sigue sin implementar (propuesta C).
* Una alerta que falla ahora se reintenta cada pasada del cron mientras el pedido siga sin atender dentro de la ventana de 2 h (máximo 10 por restaurante por pasada): con una apikey inválida, CallMeBot recibe esos intentos (antes recibía uno). Es lo que pedía el diseño ("un fallo de envío permite reintentar").
* `Vary: Host` del borde (P5), Preview de Vercel (P2), Realtime y `DELETE`, P6–P13: sin cambios.

---

## 19. Panel de superadmin: la base y el servidor (SQL 16, SQL 16b y `api/superadmin.js`) — paso 3A de 3B

Taqueiros se vende por mensualidad: un cliente lo pide, se le habilita el sistema creándole usuario y contraseña, y el restaurante entra y crea sus productos. Hasta la
sección 18 todo lo del restaurante estaba hecho (base, servidor, páginas públicas, panel del dueño) pero **dar de alta a un cliente, cobrarle la mensualidad y
suspenderlo** se hacía a mano con SQL. Esta sección es la **base de datos y el servidor** de esa administración (3A). **La pantalla (`superadmin.html`) es el paso 3B y
no existe todavía**; hasta entonces el superadmin opera con la API (19.6). **Ningún SQL de esta sección se aplicó a la base real**: viven en archivos numerados con su
reversa y los aplicas tú (19.10).

### 19.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/16-superadmin.sql` y `16-revertir.sql` (nuevos) | Vigencia (`calcular_vigencia`, `vigencia_restaurante`), tabla de auditoría de solo agregar (`auditoria_superadmin`) y 15 funciones de superadmin (`sa_*`) que solo el servidor puede llamar. Atómico, idempotente, marcadores `-- >>> PASO n`, bloques `DO` con `MR paso n: …`, barridos por OID, **25 comprobaciones OK/FALLA**, apto para "Run without RLS". Reversa: 6 comprobaciones. |
| `supabase/16b-horario.sql` y `16b-revertir.sql` (nuevos) | La regla del horario con `24:00` y medianoche aplicada en la base (19.7). **Independiente del 16** (cualquier orden); necesita el 15. 15 comprobaciones; reversa: 7. |
| `api/superadmin.js` (nuevo; **la 7.ª de las 12 funciones de Vercel**) | El servidor del panel de superadmin (19.5). `api/_auth-admin.js` (nuevo, `_` = no cuenta) crea usuarios en Auth y genera la clave temporal. `api/_supabase.js` gana `llamarFuncionSuperadmin` (solo acepta nombres `sa_*`). |
| `api/_restaurante.js`, `api/_modulos/menu.js` | `restauranteActivo` devuelve además `vigencia` (prueba / activo / gracia / vencido / suspendido) con los días restantes; el menú avisa `servicio.sirve = false` **solo** cuando el servicio no está al día (19.3). |
| `api/_sesion.js` | Una llave de proyecto (`sb_secret_…`, `sb_publishable_…`) como Bearer es "sin sesión" sin llegar a la red (R9 de la sección 18). |
| `api/_cron.js` | `?clave=` retirado: solo `Authorization: Bearer` (19.8). |
| `horario-regla.js` (nuevo), `panel.html`, `index.html`, `api/_horario.js` | La regla del horario (19.7). `panel.html` además gana la barra de aviso de la suscripción (19.3). `sw.js` v11. |
| `supabase/crear-superadmin.mjs`, `supabase/probar-superadmin.mjs` (nuevos) | Dar de alta a un superadmin; las pruebas del panel de superadmin contra la base real. |
| `pruebas/` | `superadmin.mjs`, `escenarios-superadmin.mjs`, `sql16.mjs`, `crear-superadmin-test.mjs`, `horario-regla.test.js`; grupo `vigencia` en `escenarios-servidor.mjs`; escenario 14 en `panel.mjs`; el Supabase falso carga el 16 y el 16b y ya rechaza un correo repetido como Auth real (422). |

### 19.2 Modelo de superadmin

* **Quién es superadmin:** un usuario de Supabase Auth cuyo id está en `public.superadmins` (hoy vacía). **Nadie más.** Se agrega con `node supabase/crear-superadmin.mjs <correo>` (19.10);
  el SQL 10 no agregó a nadie y el 16 tampoco.
* **Cómo opera:** **solo** a través de `POST /api/superadmin`. El navegador no habla con la base para nada de esto: las funciones `sa_*` no tienen `EXECUTE` para `anon`, `authenticated` ni `PUBLIC`
  (solo `service_role`), de modo que ni siquiera el superadmin puede llamarlas desde su propia sesión (probado). Un dueño, un cajero, una cocina, alguien sin membresía y `anon` jamás pueden llamar nada de superadmin.
* **Dos comprobaciones, en cada petición:** (1) `api/superadmin.js` valida el JWT con `api/_sesion.js` (el helper de siempre) y mira la tabla `superadmins` **en cada petición** (no se guarda en memoria: quitarlo de la tabla lo saca al
  instante aunque su token siga vivo); sin sesión o con un token falso, vencido o manipulado → **401** (nunca 500); con sesión pero sin ser superadmin → **403**. (2) Cada función SQL recibe como primer argumento al
  superadmin que actúa (`p_actor`) y **lo primero que hace** es `exigir_superadmin(p_actor)` (`42501 No autorizado` si no está en la tabla); recién después hace algo y deja la constancia.
* **Límite de intentos fallidos** (sin infraestructura nueva): 10 intentos fallidos (401 o 403) desde la misma IP en 10 minutos → **429** con `Retry-After`. Es **en la memoria de cada instancia** de Vercel: frena a quien prueba tokens o cuentas
  a mano, no a un ataque distribuido. **El inicio de sesión (correo y contraseña) no pasa por aquí sino por Supabase Auth**, que tiene sus propios límites (Dashboard → Authentication → Rate Limits): no se puede limitar desde este código sin
  poner un intermediario. Lo que sí se protege es este endpoint. Reportado como pendiente en 19.12.
* **MFA (P9 de 13.4):** esta función no mira el nivel `aal2`. Activa la verificación en dos pasos en las cuentas de superadmin (un superadmin ve y administra **todos** los restaurantes); exigirla en el servidor queda para el 3B.

### 19.3 El ciclo de vigencia

Se calcula **al consultar** (sin cron) con `restaurantes.estado`, `vigente_hasta` y `dias_gracia`, en la **zona horaria del restaurante** (el día de `vigente_hasta` todavía se sirve completo). `vigente_hasta` nulo = sin vencimiento (**Taqueiros queda así y no cambia**).
El estado `vencido` y el `gracia` **no se guardan**: salen de la cuenta. La columna `estado` solo vale `prueba`, `activo` o `suspendido` (este último lo pone Carlos a mano).

| Vigencia | Cuándo | Recibe pedidos y firmas | Menú (`/api/menu`) | `/api/estado` y `/api/restaurante` | Webhook de Wompi y reembolso | Panel del dueño |
|---|---|---|---|---|---|---|
| **prueba** | `estado = prueba` y (`vigente_hasta` nulo o hoy ≤ `vigente_hasta`) | sí | igual que siempre | `servicio.sirve = true` | funcionan | sin aviso |
| **activo** | `estado = activo` y (nulo o hoy ≤ `vigente_hasta`) | sí | igual que siempre | `sirve = true` | funcionan | sin aviso |
| **gracia** | `vigente_hasta` ya pasó pero hoy ≤ `vigente_hasta + dias_gracia` | **sí** (todo funciona) | igual que siempre | **dice "activo"**: que un restaurante esté atrasado no es público (H10 de la sección 13) | funcionan | **barra de aviso** al dueño: "Tu suscripción venció el … Tienes N días para renovarla…" (el último día: "Hoy es el último día…") |
| **vencido** | pasó la gracia | **no**: `crear-pedido` y `generar-firma` responden **403** `{motivo: "servicio_suspendido"}`, sin crear ni cambiar nada | se sigue viendo, con `servicio: { sirve: false, motivo: "servicio_suspendido" }` | `sirve = false`, `motivo = servicio_suspendido` (neutro) | **funcionan siempre** (un pago que ya iba en camino nunca se pierde; el dueño registra sus reembolsos) | el dueño **entra igual** al panel y al historial; barra roja: "…el servicio está suspendido: tus clientes no pueden hacer pedidos" |
| **suspendido** | `estado = suspendido` (a mano) | **no** (igual que vencido) | igual que vencido | igual que vencido | funcionan siempre | igual; barra roja "El servicio de tu restaurante está suspendido…" |
| **sin vencimiento** | `vigente_hasta` nulo | sí | igual que siempre | `sirve = true` | funcionan | sin aviso |

* **La página pública** (`index.html`) muestra el mensaje **neutro** "Servicio no disponible por el momento." en el banner y en el aviso; no dice el motivo (ni menciona pagos) y esconde los botones de pedir. El 403 del servidor lleva el mismo `motivo` para vencido y suspendido.
  Nunca aparecen las palabras vencido, gracia, pago ni mensualidad en lo público (se prueba para cada estado).
* **Una sola consulta por petición:** `crear-pedido` y `generar-firma` releen el restaurante **sin caché** y calculan la vigencia **una vez** (`exigirServicio`); `menu`, `estado` y `restaurante` la calculan sobre el restaurante resuelto
  (caché de 30 s por instancia; la API de superadmin invalida la caché de la instancia que atendió el cambio, las demás se enteran en ≤ 30 s, y pedir **siempre** rige en el acto).
* **Dos implementaciones, una sola cuenta:** `public.calcular_vigencia` (SQL, la usa el panel del dueño con `vigencia_restaurante`) y `restauranteActivo` (servidor). Una prueba las compara en **5184 combinaciones** (estado, fecha, gracia, zona horaria incluidas
  Tokio y Auckland, y 6 instantes alrededor de la medianoche): idénticas.
* **`vigencia_restaurante(p_restaurante)`** es `SECURITY INVOKER`: manda RLS. Un miembro ve la vigencia de **su** restaurante; cualquier otro recibe `null`; `anon` no puede ejecutarla. El panel la llama al entrar (y cada 30 minutos) y solo pinta la barra si el rol es **dueño**.
  Si el SQL 16 no está, la llamada falla en silencio y no hay barra (probado: el panel abre igual).

### 19.4 Las funciones SQL y la auditoría

Todas las `sa_*` son `SECURITY DEFINER` con `search_path` fijo, `EXECUTE` solo para `service_role`, y **primer argumento `p_actor`** (el superadmin). Validan todo (los mensajes de error no repiten el valor recibido) y **dejan una fila en la auditoría**.

| Función | Qué hace |
|---|---|
| `sa_listar_restaurantes(actor)` | Todos los restaurantes con su vigencia calculada, dominios y cuántos miembros activos tienen. |
| `sa_detalle_restaurante(actor, restaurante)` | Uno: config, dominios, miembros (con correo), tarifas, vigencia y **si cada secreto está puesto (sí/no)**. |
| `sa_crear_restaurante(actor, slug, nombre, dominio?, zona?, plan?, modalidad?, vigente_hasta?, dias_gracia?, modulos?, config?)` | Alta. Slug validado **tal cual** (2 a 40, minúsculas/números/guiones; reservados: `api`, `www`, `admin`, `superadmin`…), dominio único, zona real, plan y modalidad de la lista, `dias_gracia` 0–60, módulos, `config` validada con las reglas del SQL 13. **Estado inicial `prueba`**; vigencia por defecto **hoy + 14 días**. El alta automática (SQL 10) crea contador de pedidos, secretos (vacíos), configuración (11:00–22:00) y salud del WhatsApp; **tarifas vacías**. |
| `sa_actualizar_restaurante(actor, restaurante, cambios)` | `nombre`, `estado` (`prueba`/`activo`/`suspendido`), `plan`, `modalidad_pago`, `vigente_hasta` (`null` = sin vencimiento), `dias_gracia`, `modulos` (se mezclan), `zona_horaria`. Cualquier otro campo → 22023. Audita antes/después. |
| `sa_registrar_pago(actor, restaurante, meses, monto?, referencia?, nota?)` | Extiende `vigente_hasta` N meses (1–36): **desde hoy si ya venció, desde la vigencia actual si sigue vigente**. Una `prueba` pasa a `activo`. Uno `suspendido` a mano **sigue suspendido** (avisa). Sin vencimiento → 22023 (no se le pone un reloj por accidente). 31 ene + 1 mes = 28 feb. |
| `sa_editar_config(actor, restaurante, cambios)` | `marca`, `wompi` (llaves **públicas**), `pwa`, `contacto`, `textos` (dentro de `config.publico`), `ubicacion`, `domicilio`. Cada sección **reemplaza** la anterior (`null` la borra); el resto de la config queda; se valida con `config_restaurante_errores` (SQL 13). |
| `sa_guardar_tarifas(actor, restaurante, tarifas)` | Reemplaza **todas** las tarifas de domicilio (`[]` = sin domicilio). Máx. 20 tramos, `hasta` > 0 y ≤ 1000 km con un decimal, `precio` 0–500 000 o `null` (fuera de cobertura). |
| `sa_agregar_dominio` / `sa_quitar_dominio` | `restaurante_dominios`. |
| `sa_asignar_miembro` / `sa_quitar_miembro` | `miembros` (rol `dueno`, `cajero` o `cocina`; el usuario tiene que existir en Auth). |
| `sa_registrar_usuario(actor, usuario, correo, restaurante?)` | Solo deja la constancia de que se creó un usuario (el usuario se crea en Auth, fuera de Postgres). **Nunca** la contraseña. |
| `sa_guardar_secretos(actor, restaurante, valores, sobrescribir?, permitir_repetidos?)` | **Solo escritura** (19.5). |
| `sa_estado_secretos(actor, restaurante)` | Sí/no por secreto y el modo de cobro (`test`/`produccion`, que no es un secreto). |
| `sa_listar_auditoria(actor, restaurante?, limite?, antes_de?)` | La auditoría, la más reciente primero. |

**Ayudas internas** (nadie las puede ejecutar, ni siquiera `service_role`; solo las llaman las `sa_*` desde dentro): `exigir_superadmin`, `auditar_superadmin`, `sa_texto_raro`, `sa_zona_valida`, `sa_estado_secretos_interno`.

**La tabla `auditoria_superadmin` es de solo agregar**, en tres capas: (1) RLS activo y **ninguna política**; (2) **ningún privilegio** para `anon`, `authenticated` **ni `service_role`** (Supabase le da todos por defecto: se le revocan); (3) triggers que rechazan
`UPDATE`, `DELETE` y `TRUNCATE` **incluso al dueño de la tabla** (el rol del SQL Editor). Solo se escribe con `auditar_superadmin`, que además rechaza un resumen con pinta de secreto o de más de 4000 caracteres.
Cada fila: quién (`actor` + correo), cuándo, restaurante (`id` + `slug`, sin llave foránea: **sobrevive aunque se borre el restaurante o el usuario**), acción y un resumen (`antes`/`después`, nombres de campo, montos y referencias de pagos…) **sin secretos**.
Residuo aceptado: un dueño de la base con permisos de DDL puede deshabilitar los triggers o borrar la tabla; la protección es contra el cliente, la API y los errores.

### 19.5 `POST /api/superadmin`

Cuerpo `{ "accion": "…", …datos }`, cabecera `Authorization: Bearer <JWT del superadmin>`; respuesta `{ ok: true, … }` o `{ error, codigo? }`. Siempre `Cache-Control: no-store`. Solo `POST` (otro método → 405).
Acciones (17): `yo`, `listar_restaurantes`, `detalle_restaurante`, `crear_restaurante`, `actualizar_restaurante`, `registrar_pago`, `editar_config`, `guardar_tarifas`, `agregar_dominio`, `quitar_dominio`, `buscar_usuario`, `crear_usuario`, `asignar_miembro`, `quitar_miembro`,
`guardar_secretos`, `estado_secretos`, `listar_auditoria`. Cada una rechaza campos de más (400). El servidor **solo habla con la base por cuatro caminos**: validar la sesión (`/auth/v1/user`), mirar `superadmins`, las funciones `sa_*` y la API de administración de Auth; una prueba lo exige.
Códigos: 400 (dato no válido; el mensaje dice qué, sin repetir el valor), 401, 403, 404 (restaurante o usuario inexistente), 409 (slug/dominio/correo repetido o secreto repetido), 429, 500 (mensaje genérico; al log solo el nombre de la acción, el HTTP y el código: nunca el cuerpo de la petición ni un detalle de la base).

* **`crear_usuario { email, restaurante_id?, rol? }`** crea el usuario con la API de administración de Auth (correo confirmado, sin enviar nada) y una **contraseña temporal fuerte** (20 caracteres: mayúsculas, minúsculas, dígitos y símbolos, sin caracteres ambiguos, `crypto.randomInt`)
  que **se muestra una sola vez** en la respuesta y no se guarda, ni se imprime, ni va a la auditoría. Con `restaurante_id` y `rol` lo asigna; si la asignación falla, **borra el usuario recién creado** (todo o nada). Un correo que ya existe → 409 (se usa `buscar_usuario` + `asignar_miembro`).
  Entrega la contraseña por un canal privado y pídele a la persona que la cambie al entrar.
* **`guardar_secretos { restaurante_id, valores: { campo: valor }, sobrescribir?, permitir_repetidos? }`** — Wompi (`wompi_llave_publica_test|prod`, `wompi_integridad_test|prod`, `wompi_eventos_test|prod`, `wompi_llave_privada_test|prod`), CallMeBot (`callmebot_telefono`, `callmebot_apikey`) y el modo de cobro (`wompi_modo`),
  los mismos campos y reglas de `supabase/cargar-secretos.mjs` (sin espacios, teléfono solo dígitos, modo `test`/`produccion`, **detección del secreto pegado dos veces**). **Solo escritura**: no existe ninguna acción que lea un secreto, y la respuesta dice únicamente,
  por campo, `guardado` / `ya_coincide` / `ya_existe_otro_valor` (hay uno distinto y no se pidió sobrescribir) / `repetido_en_otro_restaurante`, más el sí/no de cada secreto. Un valor vacío nunca borra uno existente.
  **Regla R4 (no repetir entre restaurantes):** si un valor ya lo tiene **otro** restaurante en ese campo, **no se guarda nada de la llamada** (409, los demás campos quedan `no_guardado`); CallMeBot repetido solo con `permitir_repetidos` (un dueño con dos restaurantes y un teléfono); un secreto de Wompi repetido, **nunca**.
  Los valores no salen en ninguna respuesta, ni en el log, ni en la auditoría (se prueba buscándolos en todo, incluidos los errores).
* **Cache:** después de cambiar un restaurante o sus dominios, la instancia que atendió la acción invalida su caché de restaurantes.

### 19.6 Dar de alta un restaurante nuevo, paso a paso

Hasta que exista `superadmin.html` (3B) se hace con la API. **Una vez:** tu usuario superadmin (19.10 pasos 3–4). En PowerShell, en la carpeta del proyecto (la contraseña se pide con `Read-Host`; nada queda en el historial):

```powershell
$url = "https://<tu-proyecto>.supabase.co"                  # SUPABASE_URL
$pub = "<llave publishable: la de supabase-publico.js>"      # no es secreta
$base = "https://taqueiros-2-0.vercel.app"                   # cualquier dominio de este despliegue
$s = Read-Host "Contrasena de superadmin" -AsSecureString
$login = Invoke-RestMethod -Method Post -Uri "$url/auth/v1/token?grant_type=password" -Headers @{ apikey = $pub } -ContentType "application/json" `
  -Body (@{ email = "tu-correo@dominio.com"; password = [System.Net.NetworkCredential]::new('', $s).Password } | ConvertTo-Json)
$token = $login.access_token                                  # dura ~1 hora: si da 401, repite estas lineas
function sa($c) { Invoke-RestMethod -Method Post -Uri "$base/api/superadmin" -Headers @{ Authorization = "Bearer $token" } -ContentType "application/json; charset=utf-8" `
  -Body ([Text.Encoding]::UTF8.GetBytes(($c | ConvertTo-Json -Depth 8))) }
function Secreto($t) { [System.Net.NetworkCredential]::new('', (Read-Host $t -AsSecureString)).Password }
(sa @{ accion = "yo" })                                       # debe decir es_superadmin = True
```

1. **Crear el restaurante** (estado `prueba`, 14 días):
   `$r = sa @{ accion="crear_restaurante"; slug="lostaqueiros"; nombre="Los Taqueiros del Norte"; dominio="pedidos.lostaqueiros.com"; plan="completo"; modalidad_pago="mensual"; dias_gracia=5 }; $id = $r.restaurante.id`
   (sin `dominio`, el restaurante solo se alcanza por `<slug>.<DOMINIO_BASE>`). El alta deja contador de pedidos, secretos vacíos, configuración y salud; tarifas vacías.
2. **Dominio en Vercel:** Project → Settings → Domains → agrega `pedidos.lostaqueiros.com` y apunta el DNS donde Vercel diga. Más dominios: `sa @{ accion="agregar_dominio"; restaurante_id=$id; host="www.lostaqueiros.com" }`.
3. **Usuario del dueño** (con contraseña temporal): `$u = sa @{ accion="crear_usuario"; email="dueno@lostaqueiros.com"; restaurante_id=$id; rol="dueno" }; $u.password_temporal` → entrégala por un canal privado (se muestra **una sola vez**).
   Cajero o cocina: lo mismo con `rol="cajero"` o `"cocina"`. Para alguien que ya existe: `buscar_usuario` y `asignar_miembro`.
4. **Marca, ubicación y contacto:** `sa @{ accion="editar_config"; restaurante_id=$id; cambios=@{ marca=@{ colores=@{ primario="#C1272D" }; logo="Recursos/lostaqueiros/logo.png"; emoji="🌮" }; ubicacion=@{ lat=7.89; lng=-72.50 }; domicilio=@{ factor_recorrido=1.3 }; contacto=@{ whatsapp="573001112233" } } }`
   (reglas de `docs` 16.4; lo no válido se rechaza con el motivo y no cambia nada).
5. **Tarifas de domicilio** (sin ellas el restaurante no ofrece domicilio): `sa @{ accion="guardar_tarifas"; restaurante_id=$id; tarifas=@(@{hasta=2;precio=5000}, @{hasta=4;precio=7000}, @{hasta=999;precio=$null}) }`.
6. **Secretos** (Wompi del restaurante y CallMeBot; cada uno se pide sin eco y no se guarda en ningún archivo):
   `sa @{ accion="guardar_secretos"; restaurante_id=$id; valores=@{ wompi_llave_publica_test=(Secreto "Llave publica test"); wompi_integridad_test=(Secreto "Integridad test"); wompi_eventos_test=(Secreto "Eventos test"); callmebot_telefono=(Secreto "Telefono CallMeBot"); callmebot_apikey=(Secreto "Apikey CallMeBot"); wompi_modo="test" } }`
   Cuando cobre de verdad: lo mismo con los `_prod` y `wompi_modo="produccion"`. Para que la página ofrezca el pago también hay que poner las llaves **públicas** en la config: `editar_config` con `wompi=@{ llave_publica_test="pub_test_…"; llave_publica_prod="pub_prod_…" }`.
   Comprueba con `sa @{ accion="estado_secretos"; restaurante_id=$id }` (solo sí/no).
7. **Wompi:** en el panel de Wompi de **ese** restaurante, el webhook de eventos apunta a `https://<cualquier dominio del despliegue>/api/webhook-wompi` (el mismo para todos).
8. **El dueño entra** a `https://pedidos.lostaqueiros.com/panel.html` con su correo y la contraseña temporal; crea sus categorías y productos en `menu-admin.html`, ajusta su horario y "Datos de mi restaurante" en el panel.
9. **Comprobar:** abre el dominio (menú del restaurante, no el de Taqueiros), haz un pedido de prueba con Wompi en modo `test` (aparece en su panel con su número 1 y avisa a **su** WhatsApp).
10. **Activar y cobrar:** cuando pague, `sa @{ accion="registrar_pago"; restaurante_id=$id; meses=1; monto=150000; referencia="REC-001" }` (pasa de `prueba` a `activo` y extiende la vigencia). Suspender: `actualizar_restaurante` con `cambios=@{ estado="suspendido" }`; reactivar: `estado="activo"`.

### 19.7 Horario con `24:00` y medianoche (pendiente R7 de la sección 18)

**Regla única** (`horario-regla.js`, `supabase/16b-horario.sql`, `api/_horario.js`, `index.html`, `panel.html`; una prueba compara la base y la regla en **864 combinaciones** y otra el servidor minuto a minuto):

1. `abre` es `HH:MM` de 00:00 a 23:59. 2. `cierra` es `HH:MM` de 00:00 a 23:59, **o `24:00`**.
3. **`24:00` = cierra a la medianoche** de ese día (las 12:00 a. m. del siguiente). `00:00` a `24:00` = abierto todo el día.
4. **Si `cierra` < `abre`** (ej. 18:00 a 02:00) el horario **cruza la medianoche**: la madrugada cuenta para la jornada del día anterior y llega hasta la hora de cierre, **pero nunca más allá de la hora de corte de la jornada** (`configuracion.hora_corte_jornada`, 05:00 por defecto).
   El servidor siempre cortó ahí; ahora **la base y el panel lo exigen** para que nadie crea que cierra a las 06:00 y cierre a las 05:00. Bajar la hora de corte por debajo de un cierre de madrugada existente también se rechaza.
5. **`cierra` = `abre` en un día activo no vale** (¿cerrado o 24 horas?). Para 24 horas: 00:00 a 24:00. 6. Un día desmarcado está cerrado y sus horas no se revisan.

Qué cambió: **panel** — la casilla "24:00" junto a la hora de cierre (un `<input type="time">` no puede mostrar `24:00`: antes quedaba vacío y **se guardaba 22:00 sin avisar**), el cierre de madrugada ya se deja guardar, y los rechazos dicen el motivo en español;
**página pública** — `24:00` se muestra "12:00 a.m. (medianoche)" (antes "12:00 p.m.", el mediodía); **servidor** — igual al mostrar la hora en sus mensajes (la lógica de abierto/cerrado no cambió: ya aceptaba ambos casos);
**base (16b)** — `configuracion_errores` gana la hora de corte (la de 4 parámetros sigue existiendo y usa 05:00) y `validar_configuracion` se la pasa; el 16b se detiene, sin cambiar nada, si el horario **actual** de Taqueiros no cumple (y dice qué día corregir; los demás restaurantes solo se informan).
No se tocó la regla de `U+2028/2029` (R8): sigue pendiente (19.12).

### 19.8 Los crons solo con `Authorization: Bearer`

cron-job.org ya usa la cabecera. `api/alertas` y `api/keep-alive` aceptan **solo** `Authorization: Bearer <CRON_SECRET>`; **`?clave=` responde 401 aunque la clave sea la correcta** (el cron propio de Vercel ya manda la cabecera). Pruebas actualizadas (`cron.test.js`, el grupo `alertas` de `escenarios-servidor.mjs`
y la equivalencia contra `d689d4d` de `agrupacion.mjs`, que ahora **exige** el 401 donde ese commit daba 200). Si en cron-job.org alguna tarea vieja aún usara `?clave=`, dejará de funcionar: revisa que las dos tengan la cabecera.
La clave puede seguir en el historial de cron-job.org y en el log de Vercel de antes del cambio: **rótala** (`CRON_SECRET` en Vercel y la cabecera en cron-job.org) si te preocupa.

### 19.9 Cómo revertir

| Paso | Reversa | Qué deja |
|---|---|---|
| SQL 16 | `supabase/16-revertir.sql` ("Run without RLS") | Borra las funciones `sa_*`, las ayudas internas y las de vigencia. **La tabla de auditoría se borra solo si está vacía**; con filas se **conserva** (con sus triggers) y el resultado lo dice (borrarla a propósito: `drop table public.auditoria_superadmin; drop function public.auditoria_solo_agregar();`). No toca datos de negocio, restaurantes creados ni superadmins. `api/superadmin.js` deja de funcionar y el panel del dueño deja de mostrar la barra. |
| SQL 16b | `supabase/16b-revertir.sql` | Devuelve `configuracion_errores` (4 parámetros) y `validar_configuracion` **exactamente** como el SQL 15. |
| Código | `git revert` de los commits del paso (lista en 19.12) | `?clave=` vuelve a aceptarse, etc. |

### 19.10 Pasos en Windows (orden exacto)

Abre PowerShell en `D:\PAGINAS WEB!!!!!!\TAQUEIROS 2.0`. Las llaves se piden con `Read-Host` y se pegan **UNA sola vez** (clic derecho **o** Ctrl+V, nunca ambos). No pegues ninguna llave en el chat.

1. **El despliegue ya ocurrió** (`git push` a `main`). Antes de tocar la base: Taqueiros se ve y se comporta igual; solo la página pública de un restaurante vencido o suspendido mostraría "Servicio no disponible por el momento.". Con el SQL 16 sin correr, todo lo anterior funciona y `api/superadmin.js` responde 500 en las acciones que necesitan la base.
2. **Respaldo** (solo lee): `node supabase/exportar-respaldo.mjs` (con la llave en la sesión, como en 17.6). Si dice "NO coincide", no sigas.
3. **SQL 16.** VS Code → abre `supabase/16-superadmin.sql` → Ctrl+A, Ctrl+C → Supabase → SQL Editor → New query → pega → **"Run without RLS"**. Esperado: **25 filas, todas `OK`**. Si algo falla verás `MR paso n: …` o `LA MIGRACION 16 SE REVIRTIO` y no se cambió nada. Se puede repetir.
4. **SQL 16b** (el horario; necesita el 15): igual con `supabase/16b-horario.sql`. Esperado: **15 filas `OK`**. Si dice que el horario **actual de Taqueiros** no cumple la regla, corrige el día que nombra (panel → Horarios, o Table editor → `configuracion`) y repite.
5. **Tu usuario superadmin:** Supabase → Authentication → Users → **Add user** (tu correo, una contraseña larga y única, "Auto Confirm User"). Activa la verificación en dos pasos en esa cuenta. Después:
   ```powershell
   $k = Read-Host "Llave SECRETA (UNA sola vez)" -AsSecureString
   $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
   node supabase/crear-superadmin.mjs tu-correo@dominio.com        # esperado: "Agregado a superadmins y verificado."
   node supabase/crear-superadmin.mjs tu-correo@dominio.com --solo-verificar   # "Es superadmin."
   ```
6. **Pruebas contra la base real** (crean y borran sus propios restaurantes `mr16-prueba*` y usuarios `*@prueba-superadmin.example.com`; Taqueiros solo se lee):
   ```powershell
   node supabase/probar-superadmin.mjs                            # esperado: 50 PASA, "Limpieza: todo lo creado se borro"
   node supabase/probar-compatibilidad.mjs                        # esperado: 26 PASAN
   node supabase/probar-servidor-multirestaurante.mjs            # esperado: todo PASA (191; incluye los 15 escenarios nuevos de vigencia)
   $env:VIA = "despachador"; node supabase/probar-servidor-multirestaurante.mjs; Remove-Item Env:VIA
   node supabase/probar-aislamiento.mjs                           # esperado: todas PASA (con Realtime real)
   Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
   ```
   La auditoría conserva una fila por cada acción de la prueba (superadmins y restaurantes `mr16-*`): es de solo agregar a propósito; ignórala.
7. **Variables de entorno en Vercel:** **ninguna nueva es obligatoria.** `api/superadmin.js` usa `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_PUBLISHABLE_KEY` (esta última ya recomendada en 12.12; si falta, valida la sesión con la secreta solo en `apikey`). `CRON_SECRET` sigue igual. Comprueba que `SUPABASE_SERVICE_ROLE_KEY` y `CRON_SECRET` sigan **solo en Production** (P2).
8. **En producción** (lo que ninguna prueba local reemplaza): `curl.exe -s -o NUL -w "%{http_code}" -X POST https://taqueiros-2-0.vercel.app/api/superadmin` → **401**; con `?clave=` en `/api/alertas` → **401** y con la cabecera → 200; que el panel de Taqueiros no muestre ninguna barra; y que Vercel liste **7 funciones** (Deployments → Functions).

### 19.11 Qué se probó y qué no

**Probado (local, sin tocar la base real; Postgres 16 real en PGlite con los SQL 10 a 13, 15, 16 y 16b, roles reales y RLS):**

* **`superadmin.mjs` (nuevo, 50)** — el manejador **real** de `api/superadmin.js` y los públicos contra el Supabase falso: un anon, un dueño, un cajero, una cocina, alguien sin membresía, el dueño de otro restaurante y 20 tokens falsos o manipulados
  no pueden ejecutar **ninguna** de las 17 acciones (401 o 403, nunca 500) y **no cambia nada**; la llave de servicio y la publishable no son una sesión; el límite de intentos (429, otra IP no afectada); las funciones `sa_*` y la auditoría cerradas por la API real a todos
  (incluido el propio superadmin desde su navegador y la llave de servicio para escribir en la auditoría); **alta de `mr16-prueba`** con dominio, usuario dueño (clave temporal que inicia sesión) y secretos; su menú **no se mezcla** con el de Taqueiros; estados, pagos, config,
  tarifas, dominios y miembros; la regla R4; **ningún secreto, clave temporal ni token** en respuestas, log ni auditoría; Taqueiros con la **misma huella** (fila, configuración, secretos, tarifas, dominios, miembros y pedidos) al terminar.
* **`sql16.mjs` (nuevo, 48)** — el SQL 16 y el 16b dos veces, sin cambiar datos, sus reversas (la auditoría se conserva si tiene filas), el orden, las precondiciones; **`calcular_vigencia` = `restauranteActivo` en 5184 combinaciones**; permisos con **roles reales**: ninguna de las 17 funciones
  la ejecuta anon, un dueño, un cajero, una cocina, alguien sin membresía ni el superadmin como usuario (`permission denied`); el servidor con un actor que no es superadmin recibe 42501; la auditoría no se puede leer, escribir, actualizar, borrar ni vaciar ni siquiera con el rol dueño de la tabla;
  `vigencia_restaurante` por rol; la regla del horario de la base = `horario-regla.js` en 864 combinaciones.
* **Vigencia por estado** (grupo `vigencia` de `servidor.mjs`, 15): prueba, prueba sin vencimiento, activo, último día, gracia, último día de gracia, vencido, prueba vencida, suspendido (con y sin fecha) y sin vencimiento — en cada uno: `menu`, `estado`, datos públicos, `crear-pedido`, `generar-firma`,
  `webhook-wompi` (siempre aprueba el pago que ya iba en camino) y `reembolso` (siempre funciona); el aviso público nunca revela el motivo; un cambio rige en el acto; la gracia no se ve desde fuera; **Taqueiros no cambia**. `panel.mjs` escenario 14 (14 comprobaciones, Chrome): la barra de la suscripción para el dueño en
  gracia, vencida y suspendida; ni el cajero, ni la cocina, ni otro restaurante, ni Taqueiros la ven; el dueño suspendido sigue entrando; sin el SQL 16 no se rompe nada.
* **Otras nuevas o ampliadas:** `crear-superadmin-test.mjs` 13, `horario-regla.test.js` 12 (la regla, el formato, la página pública y el servidor minuto a minuto), `cron.test.js` 13 (`?clave=` correcta → 401), R7 en el navegador (7 comprobaciones en `panel.mjs`), la inspección con la sección `sql_15_16_aplicados` (6).
* **Baterías anteriores, todas verdes** (con el SQL 16 y 16b cargados en el falso; el servidor también con ellos omitidos): unitarias `node --test pruebas/*.test.js` **99**, `agrupacion.mjs` **32** (ahora 7 funciones), `vista-previa.mjs` **57**, `servidor.mjs` **204** (también con `--via=despachador`, `--via=reescrita` y con `SQL16_NO`/`SQL16B_NO`),
  `datos-restaurante.mjs` **76**, `rls.mjs` **237**, `hallazgos.mjs` **32**, `planes.mjs` **11**, `sim.mjs` **34 OK** (con y sin `conPendientes`), `dominios.mjs` **35**, `config-publica.mjs` **49**, `cargar-secretos-test.mjs` **25**, `endurecer.mjs` **426**, `migrar-fotos.mjs` **126**,
  `front.mjs` **104**, `panel.mjs` **356**, `e2e.js` **180**, `comparar-tickets.mjs` **7 de 7 idénticos**; contra el falso: `probar-compatibilidad` **26**, `probar-servidor-multirestaurante` **191** (también con `VIA=despachador`), `probar-superadmin` **50**, `probar-aislamiento` **252 de 259**
  (las 7 que fallan son las de Realtime, que el falso no emula, igual que antes), `probar-menu-rls` y `probar-impresion-rls` "TODO BLOQUEADO", `probar-categoria-apagada` "Todo en orden". **Cambió lo esperado solo en:** `agrupacion.mjs` (la equivalencia contra `d689d4d` exige el 401 de `?clave=` y el `servicio` del menú suspendido; son 7 funciones),
  `vista-previa.mjs` (2d: `index.html` es el de antes más los 4 cambios a propósito), `front.mjs` (el mensaje neutro y `24:00` como medianoche) y `panel.mjs` (la casilla `24:00` y el `value` de la hora de cierre); el escenario "alertas del horario con corte 01:00" ahora comprueba que la base lo rechaza (23514).
* **Revisión por mutación del paso** (`mutaciones-16.mjs`): **77 mutaciones: 70 detectadas, 7 equivalentes declaradas con su razón, 0 sin detectar** (más un control: la copia limpia pasa todas las suites). Rompe a propósito, una por una, la comprobación de superadmin en cada función (y con actor nulo), los permisos de las funciones (a authenticated, a anon, las internas al servidor), cada defensa de la auditoría (privilegios de service_role, los tres triggers, RLS, el filtro de secretos), la cuenta de la vigencia (gracia, último día, prueba, zona horaria), la regla R4 y las demás reglas de los secretos, el límite de intentos, la comprobación de la tabla superadmins, el método, los campos de más, la clave temporal, la invalidación de la caché, la sesión con una llave sb_, el 401 de `?clave=`, la regla del horario (cierre igual, corte, 24:00, el formato en tres sitios) y la vigencia del servidor y del menú. **La primera pasada dejó pasar 4** y obligó a reforzar dos pruebas (la clave temporal ahora se mide estadísticamente en 300 claves; la caché se calienta con un menú y el cambio de la API tiene que verse enseguida, porque `crear-pedido` la invalida por su cuenta y lo tapaba) y a declarar dos equivalentes: el slug (la tabla tiene el mismo CHECK) y comprobar el restaurante antes de crear el usuario (el borrado del usuario si falla la asignación cubre lo mismo; quitadas las dos juntas sí se detecta). Equivalentes declaradas: esas dos, `asignar_miembro` con cualquier rol (el CHECK de la tabla), los detalles en un error de la base (no traen datos) y un 500 con el mensaje (ninguna prueba lo provoca con un secreto dentro), el borrado del usuario recién creado (solo falla en una carrera de milisegundos) y `llamarFuncionSuperadmin` con cualquier nombre (ninguna entrada del cliente llega ahí). Se repite con `node pruebas/multirestaurante/mutaciones-16.mjs` (~7 minutos).

**Solo se puede probar contra la base real o en producción (pendiente de Carlos):** los SQL 16 y 16b sobre el esquema verdadero (en especial que el horario real de Taqueiros cumpla la regla nueva; si no, el 16b lo dice y no cambia nada); `supabase/probar-superadmin.mjs` con PostgREST y Auth reales (códigos HTTP reales, la API de administración de Auth y las reglas de contraseña del proyecto, que `crear_usuario` cumple con su clave de 20 caracteres);
que `anon` y `authenticated` reciban de verdad `permission denied` en las funciones `sa_*` y en la auditoría (el simulador reproduce los privilegios por defecto de Supabase, pero no los event triggers de `supabase_admin`); R9/R10 (18.4) y la caché del borde (P5); Vercel real (7 funciones) y la barra del panel con una cuenta real.

### 19.12 Decisiones, riesgos aceptados y pendientes

**Decisiones donde el pedido no definía algo** (todas reversibles):
1. **Auditoría en una tabla propia** (`auditoria_superadmin`) y no un jsonb en `restaurantes`: se puede dar el permiso de leerla a otros sin dar el de escribirla, y sobrevive al restaurante. `sa_registrar_pago` **no** crea una tabla de pagos: la constancia del pago (meses, monto, referencia, vigencia anterior y nueva) está en la auditoría; si luego quieres reportes de ingresos conviene una tabla `pagos`.
2. **Las funciones reciben `p_actor`** (el servidor la llama con la llave de servicio, que no tiene `auth.uid()`): son tan seguras como la llave de servicio, que ya lo puede todo; lo que añaden es la comprobación en la base, la auditoría y que ningún cliente pueda llamarlas. `exigir_superadmin` y `auditar_superadmin` no las ejecuta nadie.
3. **El menú sigue viéndose** en un restaurante vencido o suspendido (como ya decía 12.5) y avisa con `servicio.sirve = false`; no se oculta el menú ni se devuelve un error.
4. **Slug estricto** (una mayúscula se rechaza, no se corrige en silencio); dominio sí se pasa a minúsculas. Vigencia por defecto del alta: **14 días**. `registrar_pago` sin vencimiento se rechaza; `suspendido` a mano no se reactiva con un pago.
5. **Cada sección de `editar_config` reemplaza la anterior** (no se mezclan campos sueltos): la pantalla del 3B enviará la sección completa. `wompi` (llaves públicas) se edita aquí porque es `config.publico.wompi`; las llaves **secretas** solo por `guardar_secretos`.
6. **Los separadores `U+2028/2029` (R8)** se rechazan en los textos nuevos de `sa_*` (`sa_texto_raro`), pero la regla de `config_restaurante_errores` (SQL 13) no se tocó.
7. **Mensaje neutro único** "Servicio no disponible por el momento." en la página pública; el texto del 403 del servidor (`"Este restaurante no está recibiendo pedidos en este momento."`) no cambió para no mover el contrato de `crear-pedido`.

**Riesgos aceptados / pendientes:**
* **Límite de intentos en memoria** (19.2): no cubre el inicio de sesión (lo limita Supabase Auth) ni un ataque distribuido. Mitigación: MFA en las cuentas de superadmin y revisar Authentication → Rate Limits. **MFA/`aal2` no se exige** en el servidor (3B).
* **Un superadmin que es miembro de ningún restaurante no entra al panel del dueño** (15.3): el "entrar como" es del 3B.
* La **auditoría** protege contra el cliente y la API, no contra quien tenga DDL en la base (puede quitar los triggers). Las acciones del script `crear-superadmin.mjs` (operador, con la llave de servicio) **no** quedan en ella.
* **Caché de restaurantes de 30 s por instancia**: un cambio de vigencia/estado hecho por la API se ve en el menú y en los datos públicos de otras instancias en ≤ 30 s; pedir y firmar rigen en el acto.
* **R5, R6, R8, D (18.1, 18.3), P1, P2, P4–P13 y R9/R10** siguen como estaban (R9 queda cubierto en el código; falta confirmarlo con la base real). El límite de peticiones (propuesta C) sigue sin implementar.
* `crear_usuario` entrega la contraseña temporal en la respuesta HTTP (una vez, `no-store`): quien tenga el token del superadmin la ve. No hay forzado de cambio de contraseña (Supabase no lo ofrece sin una pantalla propia).
* `registrar_pago` no es idempotente a propósito (cada llamada extiende): si repites la llamada por error, queda registrado dos veces y se corrige con `actualizar_restaurante`.

## 20. Rebrand del restaurante demo a "The Northe Burgers" (SQL 17) y cómo repetirlo para otro restaurante

El restaurante demo (id `00000000-0000-4000-8000-000000000001`, el que se llamaba **Los Taqueiros**) pasa a ser **The Northe Burgers**, una marca ficticia de comida rápida estilo street: nombre,
textos, colores, logo, íconos, menú y fotos nuevos, en todo lo que ve un cliente, el dueño o el personal. Se hace **sobre el mismo restaurante** (conserva el id y el slug) y se hizo, a propósito, **sin
tocar la lógica** de pedidos, pagos, Realtime, impresión, seguimiento, sesiones, vigencia ni seguridad. **Ningún SQL de esta sección se aplicó a la base real**: viven en `supabase/17-rebrand-northe.sql` y
`supabase/17-revertir.sql` y los aplicas tú (20.11). Mientras no los apliques, el sitio sigue viéndose como Taqueiros: **lo que está en la base manda** (12.5, 14.4), y el código nuevo solo cambia el respaldo.

### 20.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `supabase/17-rebrand-northe.sql` y `17-revertir.sql` (nuevos) | El rebrand en la base y su reversa exacta (20.8). Independientes de los SQL 16 y 16b (cualquier orden); necesitan los SQL 10 a 13. |
| `supabase/subir-fotos-northe.mjs` (nuevo) | Sube las 13 fotos y las asigna a sus productos. Por defecto simula (20.8). |
| `api/_respaldo-taqueiros.js` | Valores nuevos (marca, textos, redes, PWA). **No se renombró** el archivo ni `CONFIG_TAQUEIROS`. Debe ser igual al estado final SQL 12 + SQL 17 (una prueba lo exige). |
| `Recursos/logo/northe-logo.png`, `northe-icono-192.png`, `northe-icono-512.png` (nuevos) | Logo recortado e íconos de la PWA (20.6). Los archivos viejos (`logo.png`, `icono-*.png`, `Recursos/tacos/…`) **se quedan**: la base los usa hasta aplicar el SQL 17 y la reversa los necesita. |
| `api/crear-pedido.js`, `api/reembolso.js` | La referencia de los pedidos nuevos empieza por **`PED-`** (antes `TAQ-`), 20.5. |
| `api/_notificar.js` | El aviso de CallMeBot dice 🍔 (antes 🌮). |
| `ticket-comanda.js` | El ticket de prueba usa productos de Northe (Big Norte, Full Norte, Coca-Cola). |
| `restaurante-publico.js` | El favicon prefiere `icono_192` (cuadrado) antes que el logo. |
| `index.html` | Botones de redes sin salto con la constante `REDES_ENLAZAN` (20.7) y 11 colores de texto que no cumplían contraste. `pedido.html` y `panel.html`: 3 colores de texto. |
| `sw.js` | v12 (no precachea nada: no había lista que revisar). |
| `.gitignore` | `Recursos/NORTHE-NUEVO/` (originales pesados; las fotos viven en Supabase Storage). |
| `pruebas/` | `rebrand-northe.mjs` (nueva), `textos-visibles.mjs` (nueva), `config-taqueiros-original.json` (los valores originales fijados), y los ajustes a propósito de 20.12. |

### 20.2 La marca y la paleta

**Logo** (`Recursos\NORTHE-NUEVO\logo northe.jpg.jpeg`, JPG de **1792×2400** y 1.9 MB, sin versión PNG ni fondo transparente): "THE" pequeño negro, "NORTHE" en bloque rojo condensado con contorno marrón y sombra
mostaza, "Burgers" en script crema; sin mascota. **Colores medidos sobre el original**, promediando regiones planas (no un píxel): crema **#FFEBC6** (4 parches de fondo, desviación ≤ 1.3), rojo **#C92423**
(596 000 píxeles planos), marrón **#220F08** (420 000) y mostaza **#EEA927** (94 000 píxeles, desviación 3–8 niveles: medición fiable, no hizo falta el valor de reserva).

| Clave (`publico.marca.colores`) | Valor | Variable CSS |
|---|---|---|
| `primario` / `primario_oscuro` / `primario_brillo` | `#C92423` / `#8E1B1A` / `#E8514A` | `--rojo` / `--rojo-oscuro` / `--rojo-brillo` |
| `claro` / `claro_suave` | `#FFEBC6` / `#FFF6E3` | `--crema` / `--crema-suave` |
| `oscuro` / `oscuro_2` | `#220F08` / `#2E160D` | `--carbon` / `--carbon-2` (el panel deriva `--carbon-3`) |
| `acento` | `#EEA927` | `--mostaza` |
| `positivo` / `positivo_brillo` | `#5C7A3B` / `#7FA855` (los de siempre) | `--verde` / `--verde-brillo` |
| `texto_secundario` / `texto_tenue` | `#E6D3AE` / `#BFA987` | `--texto-secundario` / `--texto-tenue` |
| `colores_zonas` | los de siempre | (mapa de zonas) |

**Contraste WCAG AA (≥ 4.5:1), calculado con un script local de apoyo** (sin dependencias, fuera del proyecto) que lee las reglas CSS de las 5 páginas y resuelve las variables con esta paleta:
botón primario (`claro_suave` sobre `primario`) **5.20**, hover **8.42**; texto principal sobre `oscuro` **15.75** y sobre `oscuro_2` **14.51**; secundario **12.54 / 11.56**; tenue **8.11 / 7.47**;
`primario_brillo` sobre `oscuro` **5.01** y sobre `oscuro_2` **4.61** (el primer valor propuesto, `#E14A42`, daba **4.03** sobre `oscuro_2` y se subió a `#E8514A`); `acento` sobre `oscuro` **9.07**;
`oscuro` sobre `claro_suave` **17.15**; `primario` y `primario_oscuro` como texto sobre `claro_suave` **5.20 / 8.42**; `positivo` sobre `claro_suave` **4.54**; `positivo_brillo` sobre `oscuro` **6.70**.
`primario` **no** debe usarse como texto sobre oscuro (3.30): el CSS no lo hace (solo `.flecha` sobre fondo claro; sobre oscuro usa `--rojo-brillo`). Resultado del barrido final: **0 reglas que fallen en toda superficie**.

**Marrones escritos a mano en `index.html`**: los cálculos dicen qué se cambia y qué no (el criterio del pedido: solo si chocan con la marca o no cumplen contraste):

| Valor | Dónde | Contraste | Decisión |
|---|---|---|---|
| `#5a4a3a` (14 usos), `#e9dcbb`, `#e2d4b4` (fondos de carga), `#8a6205`, `#c0392b`, `#a33`, `#8a2820`, `#3f5a24` | tarjetas y avisos sobre fondo crema | 4.6 a 8.5 | **Se quedan**: son marrones cálidos de la misma familia que el logo y cumplen. |
| `#150d0b` | pie y final del degradado de portada | decorativo | **Se queda** (marrón casi negro, vecino de `#220F08`). |
| `#8a7a63` (10 usos: unidad, "sin resultados", ayudas…) | texto sobre crema | **4.08** | **Cambiado** a `rgba(var(--carbon-rgb), .68)` (≈ 6.2:1), una variable que ya existía. |
| `#6b5c4c` (`.copy` del pie, 2 en `pedido.html`, 1 en `panel.html`) | texto sobre fondo oscuro | **2.6 – 3.0** | **Cambiado** a `--texto-tenue` (y `--texto-secundario` en el panel, que ya recibe el tono tenue de la marca). `--texto-tenue` se agregó como variable neutra a `index.html` (en `pedido.html` ya existía). |

Los azules de estado del panel (`entregado`, botón de mapa) son colores de **estado**, no de marca: no se tocan. El panel ya derivaba `--carbon-3` de `oscuro`/`oscuro_2`, así que sus superficies salen marrones solas.
**Tipografía:** no se tocó (Anton para títulos y Libre Franklin para el cuerpo son los valores por defecto y combinan con el bloque condensado del logo); no se agregó ninguna clave.

### 20.3 El menú y las descripciones ajustadas a las fotos

Categorías y orden: 1 Hamburguesas 🍔, 2 Hot dogs 🌭, 3 Papas 🍟, 4 Bebidas 🥤 (ids `nb-hamburguesas`, `nb-hot-dogs`, `nb-papas`, `nb-bebidas`). Precios en pesos colombianos, enteros: Big Norte 26 000, Crispy Norte 22 000,
Lil Norte 18 000; Classic Norte 12 000, Smoky Norte 15 000, Full Norte 18 000; Creamy Norte 14 000, Dirty Norte 17 000, Chori Norte 19 000; Agua 3 000, Coca-Cola 4 500, Pepsi 4 500, Sprite 4 500 (total 177 500).
Ids de producto `nb-big-norte` … `nb-sprite`. En este esquema los ids son **por restaurante** (la llave es `(restaurante_id, id)`, SQL 10 paso 4.1), no globales; el prefijo `nb-` se usa igual para no mezclarse con los viejos y para reconocerlos.

Se **abrió cada foto** y se comparó con la descripción propuesta; las descripciones de hot dogs y papas eran suposiciones. Los nombres coinciden con los banderines de todas las fotos. Cambios (lo mínimo, sin inventar ingredientes):

| Producto | Antes | Después | Qué muestra la foto |
|---|---|---|---|
| Crispy Norte | …salsa BBQ y lechuga fresca. | Pollo crispy bien dorado, queso, tocineta y salsa BBQ. | sin lechuga; sí queso, tocineta y salsa |
| Classic Norte | Salchicha, queso, papitas trituradas y salsas de la casa. | Salchicha clásica con mostaza y salsas de la casa. | solo mostaza y salsa roja |
| Smoky Norte | Salchicha ahumada con tocineta, queso y salsa BBQ. | Salchicha ahumada con salsa BBQ, cebolla morada encurtida y cebolla crujiente. | sin queso; cebolla morada y crujiente (el resto no se nombra) |
| Full Norte | El más cargado: salchicha, tocineta, queso, papitas y todas las salsas. | El más cargado: salchicha con cebolla crujiente, vegetales picados y todas las salsas. | sin tocineta, queso ni papitas |
| Creamy Norte | Papas crinkle con salsa de queso cremosa. | Papas crinkle con pollo, cebolla, rúgula y salsa cremosa. | lleva pollo, cebolla y rúgula |
| Dirty Norte | Papas crinkle con queso, tocineta y salsa picante. | Papas crinkle con carne en tiras, rúgula y salsa blanca. | sin tocineta; carne en tiras y salsa blanca |
| Coca-Cola | Personal, bien fría. | Lata 350 ml, bien fría. | una lata de 350 ml |
| Pepsi, Sprite | Personal, bien fría. | Lata, bien fría. | latas |
| Big Norte, Lil Norte, Chori Norte, Agua | (sin cambio) | (sin cambio) | coinciden (Agua: botella Cristal de 600 ml) |

(Decisión de Carlos: Smoky Norte **no** menciona carne desmechada aunque la foto parezca mostrarla.)

### 20.4 Los textos finales (para aprobar)

Tono street, desenfadado, español de Colombia, sin mexicano. Conservan los marcadores (`{cierre}`) y los tiempos de siempre. Están en `api/_respaldo-taqueiros.js` y en el SQL 17 (una prueba exige que sean idénticos):

* **Nombre:** The Northe Burgers · **PWA:** "Panel The Northe Burgers" / "Comandas" · **Redes:** Instagram y TikTok `thenorthe.burgers` (inventadas; los botones no llevan a ninguna parte, 20.7).
* **Título de página:** "The Northe Burgers | Burgers con actitud de calle en Cúcuta" · **Descripción:** "The Northe Burgers — hamburguesas smash, hot dogs cargados y papas crinkle en Cúcuta. Pide en línea y recibe tu pedido por WhatsApp."
* **Eslogan:** "Burgers · Hot Dogs · Papas" · **Tagline:** "Street food con actitud: hamburguesas smash, hot dogs cargados y papas que no se olvidan. Pide en dos clics y recíbelo por WhatsApp."
* **Pie:** "Hamburguesas smash, hot dogs cargados y papas crinkle hechos con receta propia, en el corazón de Cúcuta. Pide en línea y te lo llevamos hasta la puerta." · **Servicios:** "🛵 Domicilio gratis · 🥡 Para llevar · 🍽️ En el local" (sin cambio) · **Pie final:** "Cúcuta, Colombia. Burgers con actitud de calle 🍔" · **Nota de ejemplo:** "Ej: sin cebolla, extra salsa, tocarle el timbre..."
* **Banners:** abierto 🔥 "¡La plancha está prendida!" / "Ahorita sí estamos atendiendo pedidos{cierre}. ¡Antójate y pide ya! 🍔" · cerrado 🍔 "Por hoy ya apagamos la plancha."
* **Seguimiento:** "Suele estar listo en 25 – 40 minutos" · "Ya está en la plancha, unos 15 – 25 minutos más" · "El domiciliario va en camino, 10 – 20 minutos" · "¡Ya puedes pasar por él!" · "¡Buen provecho! 🍔" · frases "¡Recibimos tu pedido! 🍔", "Lo estamos preparando 🔥", "¡Va en camino! 🛵", "¡Tu pedido está listo! 🥡", "¡Entregado! 🎉".
* **Ticket impreso:** el pie sale solo del nombre: "THE NORTHE BURGERS · PEDIDO WEB". **Aviso de CallMeBot:** "🍔 *NUEVO PEDIDO PAGADO*".

**No se tocan** (decisión de Carlos): WhatsApp, teléfono, dirección, ciudad, región, ubicación (lat/lng), domicilio, horario (sigue 00:00–23:59; lo cambiará a mano), `cerrado_temporal`, `mensaje_cerrado` y las llaves públicas de Wompi. Los **30 pedidos de prueba** se conservan como historial.

### 20.5 Lo que no cambia, y el slug

**Identificadores técnicos que siguen diciendo "taqueiros"** (no son marca; renombrarlos rompería cosas): `RESTAURANTE_TAQUEIROS_ID` y `HOSTS_TRANSITORIOS_TAQUEIROS` (`api/_restaurante.js`), `CONFIG_TAQUEIROS` y el archivo
`api/_respaldo-taqueiros.js`, `ORIGEN_TAQUEIROS` (`api/_domicilio.js`), `restaurante_taqueiros_id()` (SQL 10 y siguientes), `migracion-fotos-taqueiros.json`, las llaves del navegador `taqueiros-panel-*`,
`taqueiros-pedidos-vistos-v1`… (`panel-restaurante.js`), los prefijos de caché de `sw.js`, el perfil `C:\TaqueirosPanel`, `--slug=taqueiros` por defecto en los scripts, el User-Agent `Taqueiros/1.0` de `api/_ubicacion.js`
y los textos de prueba (`lostaqueiros`, `taqueiros.localhost`…). **Opinión:** conviene renombrar más adelante, y solo el código interno (las constantes y el archivo, una sola vez, con las pruebas verdes); **no** las llaves del
navegador (borrarían las preferencias de impresión de los equipos ya instalados), ni los prefijos de `sw.js` (si cambian, `sw.js` ya sabe borrar los viejos), ni el slug.

**Por qué es seguro dejar el slug `taqueiros` y qué riesgo tendría cambiarlo.** Para el cliente el slug **no se ve**: el restaurante se resuelve por el **host** (`restaurante_dominios`, 11) y el slug solo lo leen la comparación de
`--slug=` en los scripts y, si algún día se usa `DOMINIO_BASE`, el subdominio (`taqueiros.midominio.com`). Cambiarlo: (a) rompería `taqueiros.localhost` y los fixtures de las pruebas internas y el valor por defecto de los scripts
(`--slug=taqueiros`); (b) si hubiera un `DOMINIO_BASE`, cambiaría la dirección del subdominio y mataría los enlaces ya compartidos; (c) el slug se valida como único y estricto (19.4), y un `update` a mano en el momento
equivocado deja al restaurante sin resolverse hasta corregirlo. Ganar, no gana nada visible.

**Prefijo de la referencia (`PED-`).** El cliente ve la referencia (pantalla de confirmación, mensaje de WhatsApp, página de seguimiento). Llevaba la marca (`TAQ-…`) escrita en un archivo **compartido por todos los restaurantes**,
así que ahora es neutra: `PED-<milisegundos>-<hex>`. Se comprobó con búsqueda en `api/`, SQL (`seguimiento`, `buscar_mis_pedidos`, `enlace_por_referencia`), pruebas y front que **nada valida el prefijo**: `seguimiento()` y
`buscar_mis_pedidos` comparan la referencia **completa**; `pedido.html` acepta `^[A-Za-z0-9_-]{6,80}$`. Los pedidos anteriores (`TAQ-…`) conservan su referencia y se siguen abriendo por su enlace actual (probado, `rebrand-northe.mjs` A16 y F7).
Wompi recibe una referencia nueva por cada pago, así que no hay nada guardado allí que dependa del prefijo.

### 20.6 Las imágenes

Con **Python + Pillow** (ya instalados en el PC; nada se agregó al proyecto; los scripts usados están en `docs/herramientas-imagenes/`, que no forma parte del sitio ni de las pruebas) a partir de los originales, **sin modificarlos**:
* `northe-logo.png`: recortado al **contenido** con un margen del 5 % (queda casi cuadrado, 1.15:1: el encabezado lo muestra en una caja de 44×44 px y el original, con tanto fondo vacío, se vería diminuto), fondo crema, **800 px de ancho**, paleta de 40 colores tras aplanar el ruido del JPG con una mediana: **160 KB**.
* `northe-icono-192.png` (6 KB) y `northe-icono-512.png` (41 KB): cuadrados, fondo crema sólido, logo centrado ocupando como máximo el **68 %** del lado (margen de seguridad ≥ 16 % por lado).
* **Favicon:** el código ya ponía el logo como favicon y borraba cualquier `<link rel="icon">` fijo del HTML; no hay clave de config para un favicon propio. Se cambió **una línea** de `restaurante-publico.js` para que prefiera `icono_192` (cuadrado). **No se generaron** archivos `northe-favicon-32.png` ni de 180 px: nada los usaría (el sitio no usa `apple-touch`).
* **Fotos de producto** (13, en `Recursos/NORTHE-NUEVO/listas/`, fuera de git): los originales son verticales 3:4 (1792×2400, 2.4–3 MB) y el sitio las muestra en cajas **4:3** con `object-fit: cover`, o sea que solo se vería la franja central. Se **recortó cada una a 4:3
  eligiendo el encuadre a mano** (ventana de 1792×1344 px que deja entero el producto; en las hamburguesas y hot dogs el banderín con el nombre queda cortado o a medias, el producto no) y se bajó a **1200×900, JPG q86, entre 50 y 230 KB** (tope pedido: 300; el bucket acepta 2 MB). Las **4 bebidas** no caben enteras en 4:3 sin cortar la lata
  o la botella: se extendió el lienzo a los lados con el propio fondo del estudio (columnas del borde estiradas, desenfocadas y fundidas con un degradado de 220 px, sin costura) para que se vean completas. Nombres sin espacios: `big-norte.jpg`, `crispy-norte.jpg`, `lil-norte.jpg`, `classic-norte.jpg`, `smoky-norte.jpg`, `full-norte.jpg`, `creamy-norte.jpg`, `dirty-norte.jpg`, `chori-norte.jpg`, `agua.jpg`, `coca-cola.jpg`, `pepsi.jpg`, `sprite.jpg`.
* **No se generó** la imagen de vista previa 1200×630 (queda pendiente, 20.10).

### 20.7 Botones de redes sin salto (`REDES_ENLAZAN`)

Las cuentas `thenorthe.burgers` son inventadas: un enlace real llevaría al cliente a la cuenta de otra persona. Los botones de Instagram y TikTok del pie **se ven** (icono y nombre de usuario en el tooltip y para lectores de pantalla) pero **no llevan a ninguna parte**:
se dibujan **sin `href`** (no hay clic ni navegación). El cambio es de **presentación y mínimo**: una constante en `index.html` y una función (`crearBotonRed`). **No toca la config ni ninguna regla de validación de la base** (el usuario `thenorthe.burgers` cumple la regla `usuario` de siempre).
El WhatsApp del pie **no** se afecta: es un número real y siempre enlaza.

```js
const REDES_ENLAZAN = false;   // index.html, justo encima de crearBotonRed()
```

* **Cómo se reactiva:** cambiar `false` por `true` en esa línea (una sola palabra) y desplegar. Con `true` cada botón abre `https://instagram.com/<usuario>` y `https://tiktok.com/@<usuario>` en una pestaña nueva. La prueba `rebrand-northe.mjs` (F1–F5) ejecuta la función real con `false` y con `true`.
* **Alcance:** la constante es **global**: afecta a **todos** los restaurantes del sitio (hoy solo existe el demo). **Hay que reactivarla ANTES de vender a un segundo restaurante** (o, mejor, cambiarla por una clave de la config de cada restaurante, p. ej. `publico.contacto.redes_enlazan`, lo que sí exigiría tocar las reglas de la base, 20.10); si no, sus clientes verán botones de redes que no hacen nada.
* Cuando el demo tenga cuentas reales: poner el usuario real en la config (formulario "Datos de mi restaurante") y reactivar la constante.

### 20.8 El SQL 17, su reversa y las fotos

**`supabase/17-rebrand-northe.sql`** (idempotente y atómico, `begin … commit`, marcadores `>>> PASO`, "Run without RLS", resultado final de **23 filas "OK"**):
0. Precondiciones: se detiene con un mensaje claro, sin cambiar nada, si faltan tablas o `restaurante_id` (SQL 10), si no existe el restaurante demo, si **no se llama "Los Taqueiros" ni "The Northe Burgers"** (alguien lo renombró) o si falta `config.publico` (SQL 12). Foto del "antes": huellas de pedidos, configuración, el resto de la config del demo, columnas del demo, productos viejos, otros restaurantes, tarifas, secretos y dominios.
1. A la categoría **vieja** cuyo nombre choca con una nueva (hoy **"Bebidas"**; la base no admite dos con el mismo nombre en un restaurante) se le agrega **" (Taqueiros)"** (una sola vez, la 2.ª corrida no lo repite). La reversa lo quita.
2. `nombre` y `config.publico`: solo se sobrescriben `marca` (sin `tipografia`), `textos`, `contacto.instagram` y `contacto.tiktok`, y `pwa`; el trigger de validación del SQL 13 revisa el resultado completo (el editor SQL corre como `postgres`, que `es_servidor()` reconoce, así que la protección del dueño no estorba).
3. Crea las 4 categorías y los 13 productos (**sin foto**). Re-ejecutar **no** pisa `productos.imagen` ni `disponible`, y **no actualiza filas que no cambian** (`on conflict … do update … where … is distinct from`: ni mueve `actualizado_en` ni dispara Realtime).
4. **Desactiva** (`activa = false`) todas las categorías viejas. No borra nada y **no toca el estado "agotado"** de los productos viejos: el sitio oculta los productos de una categoría apagada y el servidor rechaza pedirlos (`categoria_apagada`, 12.5).
5. Comprobaciones (si alguna falla, **todo se revierte**): config exacta, textos sin mexicano, config válida, 4 categorías y 13 productos con su precio, descripción y orden, ninguna categoría vieja activa, el menú visible son **exactamente** los 13, y **huellas iguales** de todo lo que no debía cambiar.

**Qué ve el cliente entre el SQL y la subida de fotos:** el menú nuevo completo con las tarjetas **sin foto** (el sitio ya las dibuja así: `card no-image`, sin imagen). No se rompe nada; el menú se cachea hasta 5 minutos.

**`supabase/17-revertir.sql`:** nombre y config originales (los del SQL 12, copia fiel del commit `947b164`), y para los productos de Northe: **se borra** un `nb-*` solo si **ningún pedido** lo referencia (los pedidos guardan `{id, nombre, precio}` dentro de `items`, sin llave foránea; se busca el id ahí, solo en los pedidos de este restaurante); un producto referenciado se **conserva**, y su categoría queda **apagada** con " (Northe)" al final.
Las categorías viejas se **encienden todas** (también una que hubiera estado apagada a propósito antes del SQL 17: no se guarda cuál) y pierden " (Taqueiros)". **Nunca toca pedidos.** Las fotos de Northe quedan huérfanas en Storage (no estorban; se pueden borrar a mano).

**`supabase/subir-fotos-northe.mjs`** (mismo patrón que `migrar-fotos-raiz.mjs`): **por defecto solo simula**; con `--aplicar` sube. Lee `Recursos/NORTHE-NUEVO/listas/`; tabla fija archivo → id de producto; sube al bucket `productos` **solo bajo `{restaurante_id}/`** con `upsert`; **aborta sin hacer nada** si el SQL 17 no se aplicó (faltan productos `nb-*`) o si un archivo local falta, no es JPG o pesa ≥ 2 MB; asigna `productos.imagen` (la dirección pública exacta que acepta el trigger) solo si el producto sigue sin foto o con la misma (una foto ajena se **respeta**; `--forzar` la reemplaza); verifica por la lectura pública que cada foto responde **200 con los mismos bytes**; nunca imprime la llave; es seguro de repetir.

**Camino alternativo (si el script diera problemas): subir las fotos a mano desde `menu-admin.html`.** Con el dueño de Northe: (1) abre `menu-admin.html` e inicia sesión; (2) busca el producto (por ejemplo "Big Norte") y pulsa su lápiz de editar; (3) en "Foto" elige el archivo de `Recursos\NORTHE-NUEVO\listas\` (`big-norte.jpg`…); (4) guarda y comprueba que la tarjeta muestra la foto; (5) repite con los 13 productos. El panel las sube a `{restaurante_id}/` por el mismo camino seguro y las valida igual.

### 20.9 Cómo repetirlo para otro restaurante

**Datos que se piden** (por restaurante): nombre; logo original (idealmente PNG con fondo transparente o un JPG grande; se mide el color sobre el original); colores (se miden del logo: fondo, primario, oscuro, acento); eslogan y frase de portada; textos del sitio y del seguimiento
(en el tono de la marca); WhatsApp, teléfono, dirección, ciudad, ubicación (lat/lng), horario y domicilio (**no son marca: se conservan o se piden aparte**); usuarios de redes **reales** (o los provisionales con la constante apagada); el menú (categorías en orden con emoji, productos con nombre, descripción y precio entero) y **una foto por producto**.

**Orden de pasos:**
1. **Respaldo** de la base (`node supabase/exportar-respaldo.mjs`, copia fuera del repositorio) y una etiqueta de git que permita volver atrás (aquí: `taqueiros-final`).
2. **Medir** colores y **probar contraste** (script local, 20.2); decidir qué marrones fijos del HTML chocan.
3. **Generar las imágenes** (logo recortado, íconos 192/512, fotos 4:3 < 300 KB con nombres sin espacios) en archivos **nuevos** (nunca sobrescribir los viejos).
4. **Mirar cada foto** contra su descripción y ajustar lo que la foto contradiga.
5. **Código:** `api/_respaldo-taqueiros.js` solo si es el restaurante demo; para un restaurante nuevo **no hace falta tocar código**: su config vive en la base (alta con `sa_crear_restaurante` y `sa_editar_config`, 19.6).
6. **SQL:** para el demo, `17-rebrand-northe.sql` y su reversa; para otro restaurante existente, copiar el 17 y cambiar (a) el id, (b) los valores de `_mr17_valores`, `_mr17_menu` y `_mr17_categorias`, (c) los nombres esperados de la precondición, (d) el prefijo de los ids (`nb-` por uno propio) y (e) los valores originales de la reversa, **sacándolos de la base real** (no de memoria).
7. **Fotos:** copiar `subir-fotos-northe.mjs` con su tabla de archivo → producto, `--slug=<slug>`, simular, aplicar. Si falla, a mano desde `menu-admin.html` (20.8).
8. **Pruebas:** las suites de 20.12 (la del rebrand sirve de plantilla) y las reales de 20.11.
9. **Reactivar las redes** (`REDES_ENLAZAN`, 20.7) y fijar `wompi_modo` del restaurante (pendiente P1, secciones 13 y 14) **antes de cobrar**.

**Archivos y SQL que se tocan:** el respaldo, las imágenes de `Recursos/`, `sw.js` (subir la versión), los marrones del HTML si chocan y el SQL del restaurante; **nunca** la lógica, la config de otro restaurante ni los pedidos.

### 20.10 Imagen de vista previa 1200×630 (pendiente: qué haría falta)

Hoy la tarjeta de WhatsApp/Instagram usa el **logo** (`marca.logo || marca.icono_512 || marca.icono_192`, `datosVistaPrevia` en `api/_publico.js`). Para usar una imagen propia 1200×630 haría falta:
* **Clave de config:** `publico.marca.imagen_og` (clase `url`: ruta relativa del sitio o https del Storage, ≤ 500 caracteres) y el archivo `northe-og.png` (logo centrado sobre crema con margen).
* **Validación en SQL:** agregar `('publico.marca.imagen_og', 'url', null, 500)` a la lista `reglas` de `config_restaurante_errores` (SQL 13). Si no, el trigger responde "clave desconocida" y **no deja guardar** la clave (tampoco `sa_editar_config`). La función es la más delicada de la base (valida secretos, HTML y formas): se haría con un **SQL 18** que la recree entera con ese único cambio mecánico y su reversa, y la batería `endurecer.mjs` (426) comparando ambas versiones con las mismas entradas.
* **Cambio de contrato (aditivo):** `/api/restaurante` y `/api/manifest` ganarían `marca.imagen_og` (campo opcional; el front la ignora si no la conoce); `marcaPublica` en `api/_publico.js` tendría que dejarla pasar (hoy lista las claves una por una); `datosVistaPrevia` la preferiría al logo y `vista-previa.js` añadiría `og:image:width/height` y cambiaría `twitter:card` de `summary` a `summary_large_image`. Hay que actualizar `vista-previa.mjs` (57) y las listas de claves de `endurecer.mjs`.
* **Riesgo:** **bajo en el resultado, medio en el proceso**: lo delicado es reescribir la función de validación (un error la dejaría rechazando toda config o aceptando de más), y el contrato de la vista previa (57 pruebas fijan su forma). Se mitiga con SQL aparte + reversa + pruebas existentes comparando versiones.
* **Alternativa sin riesgo:** hacer que `datosVistaPrevia` prefiera `icono_512` (cuadrado, ya existe) al logo: una línea de código, sin SQL ni claves nuevas; WhatsApp muestra bien una miniatura cuadrada. No se hizo porque cambia el comportamiento ya cubierto por las 57 pruebas.

### 20.11 Pasos para Carlos en Windows (orden exacto) y pasos externos

**Aplicar** (cada paso espera tu captura antes del siguiente):
1. **Respaldo** (ya hecho antes de empezar; repítelo si pasó más de un día): `node supabase/exportar-respaldo.mjs` con la llave cargada así: `$k = Read-Host "Llave SECRETA" -AsSecureString` y `$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password`; al final `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.
2. **SQL 17:** Supabase → SQL Editor → New query → pega `supabase/17-rebrand-northe.sql` → **"Run without RLS"**. Debes ver **23 filas OK** (la fila "informativo" dice "13 de 13 sin foto"). Si falla dice "EL REBRAND 17 SE REVIRTIO" con la lista y **no cambia nada**.
3. **Fotos, simulación:** con la llave cargada, `node supabase/subir-fotos-northe.mjs`. Debes ver las 13 fotos con su peso y "Resumen: 13 por subir".
4. **Fotos, de verdad:** `node supabase/subir-fotos-northe.mjs --aplicar`. Debes ver 13 líneas `OK`, "13 subida(s) y asignada(s), 0 con error". Quita la llave: `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.
5. **Mira el sitio** (Ctrl+F5; el menú puede tardar hasta 5 minutos): marca nueva, colores, 13 fotos, "Panel The Northe Burgers" al instalar. **Deshacer:** `supabase/17-revertir.sql` (mismas reglas) y, si quieres, `git revert` de los commits del rebrand.

**Pruebas reales después** (con la llave cargada): `node supabase/probar-compatibilidad.mjs` (26), `node supabase/probar-servidor-multirestaurante.mjs` (191; también con `$env:VIA = "despachador"`), `node supabase/probar-aislamiento.mjs` (259; si solo fallan las de Realtime con "sin control positivo" es la inestabilidad conocida: repetir una vez). Además un **pedido de prueba con Wompi sandbox** que llegue al panel e imprima el ticket con el pie **"THE NORTHE BURGERS · PEDIDO WEB"**, y la **vista previa de WhatsApp** enviando el enlace con un parámetro nuevo (`?v=3`) para saltar la memoria de WhatsApp.

**Pasos externos al código** (no se hicieron ni se pueden hacer desde aquí): **Wompi** (nombre del comercio: se cambia en el panel de Wompi; en sandbox puede no estar disponible, comprobarlo); **cron-job.org** (título del trabajo de alertas: solo ese; **no** tocar "Luna Rosa keep-alive", que apunta a OTRO proyecto de Supabase); **CallMeBot** (el nombre visible solo si lo usas); **la PWA ya instalada en el PC del local** (desinstalar y volver a instalar para ver el nombre e ícono nuevos; el perfil `C:\TaqueirosPanel` se queda como está); **vista previa de WhatsApp** (`?v=3`). Todo lo demás (GitHub, Vercel, la dirección `taqueiros-2-0.vercel.app`) **queda tal cual** por decisión tomada (21).

### 20.12 Qué se probó y qué no

* **Nuevas:** `pruebas/multirestaurante/rebrand-northe.mjs` (SQL 17 y reversa sobre Postgres 16 real —PGlite— con y sin los SQL 16/16b, idempotencia, huellas de todo lo que no debe cambiar, config final = respaldo del código, pedido que referencia un producto nuevo, precondiciones, el script de fotos como proceso aparte contra el Supabase falso con Storage, `REDES_ENLAZAN` en `false` y `true`, `PED-`, documentación) y `textos-visibles.mjs` (ningún texto visible dice ya Taqueiros, tacos, birria, comal ni lo mexicano).
* **Ajustadas a propósito** (nada se debilitó): `config-publica.mjs` ya no exige que el respaldo sea idéntico al SQL 12: compara el SQL 12 contra los valores originales fijados (`config-taqueiros-original.json`, copia del respaldo de `947b164`) **y** SQL 12 + SQL 17 contra el respaldo nuevo (49 → 52). `agrupacion.mjs` enmascara `PED-` y `TAQ-`. El servidor falso respeta `x-upsert` en la subida a Storage. **Los demás ajustes, uno por uno, con su razón (todos son cambios deliberados del rebrand; la igualdad exacta se conserva y solo se excusa lo listado):**
  * `escenarios-servidor.mjs` (204, igual que antes): el respaldo del código ahora es la marca nueva (colores, logo, emoji, tagline, redes); el restaurante "sin datos" no debe recibir **nada** del demo (se agregaron los marcadores de la marca nueva a la comprobación de fuga); la API y el manifest de Taqueiros aceptan **la marca anterior** (base con SQL 12), **la nueva** (después del SQL 17) o la de transición (código nuevo y base sin SQL 12), siempre coherente con el nombre. Se corre además con `SQL12_NO=1` (204).
  * `agrupacion.mjs` (32): enmascara `PED-`/`TAQ-` y el emoji del encabezado del aviso de CallMeBot (🌮 → 🍔); es lo único que cambia entre el código de antes y el de ahora.
  * `vista-previa.mjs` (57): 1g lee los valores originales fijados (la base de la prueba trae el SQL 12); 2d sigue exigiendo que `index.html` y `pedido.html` sean los de antes **byte a byte**, salvo los 4 cambios del paso 3A y los del rebrand (10 colores `#8a7a63`, `.copy`, `--texto-tenue`, los 2 botones de redes, el bloque de `REDES_ENLAZAN`, y 2 colores de `pedido.html`), cada uno contado exactamente.
  * `front.mjs` (104): los botones de redes (visibles, sin enlace; solo el WhatsApp enlaza); `sw.js` v12; la comparación "Taqueiros idéntico" excusa únicamente el contraste (`rgb(138,122,99)`→`rgba(28,18,16,.68)`, `rgb(107,92,76)`→`rgb(185,168,140)`), las redes sin `href` y el favicon `icono_192`; y las páginas públicas no pueden llevar escrita la marca nueva.
  * `panel.mjs` (356): `sw.js` v12; la comparación excusa solo el color de `.col-vacia`; las páginas privadas no pueden llevar escrita la marca nueva. `mutaciones-panel.mjs`: la mutación de la versión de `sw.js` apunta a v12.
  * `e2e.js` (180): el punto "sin conexión" del panel pasa de `rgb(225,74,66)` a `rgb(232,81,74)` (el rojo vivo de la marca nueva; el panel de la prueba toma su marca del respaldo).
  * `comparar-tickets.mjs` (7 de 7): el ticket de prueba se compara con los productos de muestra cambiados a propósito (8 reemplazos exactos); ahora además muestra las líneas que difieren.
  * `supabase/probar-compatibilidad.mjs` (26 contra el falso): acepta cada marca solo junto con su nombre ("Los Taqueiros" + `#C1272D` o "The Northe Burgers" + `#C92423`), así sirve antes y después del SQL 17.
  * **Números finales:** unitarias 99, `superadmin` 50, `sql16` 48, `crear-superadmin-test` 13, `servidor` 204 (también por despachador y con `SQL12_NO=1`), `agrupacion` 32, `vista-previa` 57, `front` 104, `panel` 356, `e2e` 180, `rls` 237, `endurecer` 426, `migrar-fotos` 126, `datos-restaurante` 76, `config-publica` **52** (antes 49: +3, SQL 12 + SQL 17), `dominios` 35, `hallazgos` 32, `planes` 11, `sim` 34 (×2), `cargar-secretos-test` 25, `inspeccion` 6, `comparar-tickets` 7 de 7; contra el falso: `probar-compatibilidad` 26, `probar-servidor-multirestaurante` 191 (también por despachador), `probar-superadmin` 50, `probar-aislamiento` 252 de 259 (las 7 de Realtime fallan localmente por diseño); **nuevas:** `rebrand-northe` **78** y `textos-visibles` **10**.
* **Solo se puede probar contra la base real:** el SQL 17 sobre el esquema verdadero (en especial que **"Bebidas" sea la única categoría vieja que choque** y que el nombre actual sea exactamente "Los Taqueiros"), la subida de fotos al Storage real (límite de 2 MB, tipos permitidos), y la apariencia en producción.

### 20.13 Decisiones y riesgos

1. **Desactivar = apagar la categoría**, no tocar `productos.disponible` (que significa "agotado"): así no se pierde ningún estado y la reversa es solo volver a encender.
2. **El 17 vuelve a encender sus categorías siempre** y **no** toca `imagen` ni `disponible` al re-ejecutarse. La reversa tampoco cambia `disponible`: un producto con pedidos queda en una categoría apagada, no "agotado", y el 17 lo recupera entero al volver a correr.
3. **La reversa enciende todas las categorías viejas**, también una apagada a propósito antes (20.8).
4. **Constante global de redes** (20.7): hay que reactivarla antes del segundo restaurante.
5. **Las fotos de las bebidas llevan fondo extendido** (20.6) en vez de recorte; si se prefiere recorte duro, se regeneran con `docs/herramientas-imagenes/preparar-fotos.py` poniendo una fila de recorte en vez de `None`.
6. **Fotos en 4:3**: los banderines con el nombre de las hamburguesas y hot dogs quedan cortados; el producto no.
7. **Sin imagen 1200×630 ni favicon propio** (20.6, 20.10).

### 20.14 Estilo claro y minimalista del sitio público y logo con fondo transparente (`TEMA_CLARO`)

El sitio público (menú, carrito, formularios, confirmación y seguimiento) pasa de oscuro (fondo marrón con degradado y rayas, logo dentro de una caja crema) a **claro y minimalista**: fondo crema liso, encabezado con solo el logo transparente, portada sin cajas, tarjetas claras con borde fino y sombra suave, botones rojos con texto crema. El **panel de comandas, `menu-admin.html` e `historial.html` siguen oscuros** (los usa el personal en la cocina). **No hay SQL nuevo** (el último sigue siendo el 17), no se tocó lógica (pedidos, pagos, Realtime, impresión, seguimiento, sesiones, vigencia, horarios, redes, contratos de API) y no hay dependencias ni funciones de Vercel nuevas (siguen 7 de 12).

**Sobre el mockup.** El encargo decía que la fuente de verdad visual era `Recursos\NORTHE-NUEVO\mockup\mockup-inicio.png`. Ese archivo es **idéntico byte a byte al logo transparente** (mismo MD5, `e02f7720a2f12337c6f85c3a9b8d4418`, y el mismo tamaño de 1 797 822 bytes): se copió el logo con otro nombre y no trae el diseño. Se trabajó, por tanto, **solo con la descripción escrita del encargo** (versión móvil de la portada) y se extendió el mismo criterio al resto. **Pendiente:** que Carlos mande el mockup real y se compare contra las capturas (20.14.7); si difiere, son ajustes de CSS dentro del bloque del tema, sin tocar nada más.

#### 20.14.1 El interruptor y cómo apagarlo

Una constante, al inicio de `<body>` (antes de la pantalla de carga, para que no haya un parpadeo oscuro al abrir), en `index.html` y otra igual en `pedido.html`:

```js
const TEMA_CLARO = true;
if(TEMA_CLARO) document.body.classList.add("tema-claro");
```

* **Apagarlo** = cambiar `true` por `false` **en las dos páginas** (una prueba exige que valgan lo mismo) y subir los dos archivos. No hay que tocar nada más: **todo** el CSS claro cuelga de la clase `tema-claro` (una prueba comprueba que cada regla del bloque empieza por `.tema-claro`) y el estilo oscuro de antes queda tal cual. Apagado, el sitio es **idéntico al de antes** (se comprueba con `vista-previa.mjs` 2d, byte a byte, y con `front.mjs` 5, comparando 600 elementos con estilos calculados contra el commit anterior).
* El estilo **no sale de la base de datos**: los *colores* sí (`config.publico.marca.colores`), el *diseño* no. Por eso el interruptor afecta a **todos** los restaurantes que sirva este sitio.
* Los colores salen de las variables que ya existían (`--rojo`, `--crema`, `--crema-suave`, `--carbon`, `--mostaza`, `--verde` y sus `-rgb`); el bloque no escribe ningún color nuevo a mano salvo el verde oscuro de texto `#3f5a24`, que ya estaba en la página. `--texto-secundario` y `--texto-tenue` son **claros** (nacieron para fondo oscuro): en el tema claro solo se usan en el pie.

#### 20.14.2 Qué cambió, archivo por archivo

| Archivo | Cambio |
|---|---|
| `index.html` | Interruptor al inicio de `<body>` y un bloque de CSS al final de `<style>` (95 reglas, todas bajo `.tema-claro`). Nada más. |
| `pedido.html` | Lo mismo (interruptor propio, igual al de `index.html`; 40 reglas). Una regla pisa con `!important` el color claro en línea que `mostrarAviso()` pone al título del aviso "No encontramos ese pedido" (pensado para fondo oscuro). |
| `Recursos/logo/northe-logo.png` | Reemplazado por el logo **con transparencia real**, recortado (900 px de ancho, 72 KB). **Mismo nombre**: la base y el respaldo no cambian. |
| `Recursos/logo/northe-icono-192.png`, `northe-icono-512.png` | Rehechos desde el logo transparente **sobre crema sólido** `#FFEBC6`, con margen seguro del 15 %. Mismo nombre. |
| `api/_publico.js` | La imagen de la vista previa de WhatsApp prefiere `icono_512` (fondo crema) al logo (una línea; el contrato no cambia). |
| `panel-restaurante.js`, `panel.html` | El favicon y el `apple-touch-icon` del panel y el ícono de la notificación de pedido nuevo prefieren `icono_192` (fondo sólido) al logo. |
| `sw.js` | **v13** (20.14.5). |
| `docs/herramientas-imagenes/preparar-logo-transparente.py` | El script que genera el logo y los íconos (20.14.4). |
| `pruebas/multirestaurante/` | `tema-claro.mjs` (nueva), `capturas-tema.mjs` (herramienta de capturas, no es una prueba) y los ajustes de 20.14.8. |

**Páginas del personal (`panel.html`, `menu-admin.html`, `historial.html`):** no se les cambió el estilo. El logo transparente trae texto negro y crema y sobre el marrón no se leería, pero **todos los sitios donde sale ya lo ponían sobre un chip crema redondeado** (`background:var(--crema)` y 4 px de relleno: la pantalla de entrada, la barra superior y el menú lateral), así que se lee bien sin tocar CSS (una prueba lo exige para cada `img`).

#### 20.14.3 Decisiones donde el encargo no lo definía

| Tema | Decisión |
|---|---|
| Pie de página | **Se queda oscuro** (marrón de la marca), como ancla visual; su logo va en un chip crema por lo ya dicho. Con el color del `<body>` oscuro hubo que darle `color:var(--texto-claro)` al pie (sin eso, el nombre y las redes quedaban oscuro sobre oscuro: lo encontró la prueba de contraste en el navegador). |
| Frase larga de la portada ("Street food con actitud…") | **Se dejó**, pequeña (13.6 px) y discreta, en marrón oscuro al 78 %, entre el logo y los botones. El mockup no la muestra: **Carlos decide si la quita** (se apaga con `ocultarSiVacio` poniendo el texto `tagline` vacío en la config, o con un `display:none` en el bloque). |
| "Desliza" (flecha animada del final de la portada) | Se **oculta** en el tema claro (no está en el diseño y sobra en una portada minimalista). |
| Aviso de abierto / cerrado | **Abierto:** claro, con una línea verde de 3 px debajo (el verde sólido competía con la portada). **Cerrado:** mostaza sólido con texto oscuro, porque ese sí tiene que verse. Solo cambió su aspecto, no su lógica. |
| Botones al pasar el mouse | `--rojo-oscuro` (no `--rojo-brillo`: con texto crema daba ≈ 3.5:1 y no cumple AA). |
| Botones secundarios | Con borde y texto marrón oscuro (`btn-secondary`, "Copiar link", "Usar mi ubicación", "Volver al menú" de la confirmación); los primarios, rojos. |
| Nombre en texto del encabezado | Se esconde **solo cuando hay logo** (`:has(img[src])`): sigue en el DOM como texto para lectores de pantalla (y el logo lleva el nombre como `alt`). Un restaurante **sin logo** sigue viendo su nombre escrito. Con un navegador sin `:has()` (muy viejos) el nombre se vería junto al logo: degradación aceptable. |
| Íconos de la PWA y favicon | Fondo crema sólido (un logo transparente con texto negro no se lee sobre el fondo oscuro de la pestaña ni sobre el blanco o negro de WhatsApp o iOS). |
| Vista previa de WhatsApp | `icono_512` primero, luego el logo, luego `icono_192`. Se comprueba con `vista-previa.mjs`. |

#### 20.14.4 El logo transparente: verificación, cómo se generó y cómo repetirlo

* **Verificación del alfa** (el original de Carlos, `Recursos\NORTHE-NUEVO\northe_burgers_logo_transparente.png`, 1701×1464): canal alfa **real** (RGBA): **34.2 % de los píxeles con alfa 0**, las esquinas y los bordes con alfa 0, **0.27 % de semitransparentes** (el suavizado normal del borde) y la caja del contenido ocupa casi todo el lienzo. Sobre fondo crema los bordes salen limpios (sin cuadriculado, sin halos claros); sobre fondo oscuro se ve bien el rojo, el contorno y la sombra mostaza, pero **"THE" y la parte crema de "Burgers" se pierden** (texto negro y crema): por eso en el panel va sobre un chip crema. Si el alfa hubiera sido falso, el script se detiene y lo dice.
* **Cómo se generó** (Python 3 + Pillow, ya instalados en el PC; no se agregó nada al proyecto; el original **no se modifica**):

```powershell
python docs\herramientas-imagenes\preparar-logo-transparente.py "Recursos\NORTHE-NUEVO\northe_burgers_logo_transparente.png" "Recursos\logo"
```

  El script comprueba el alfa, recorta a la caja del alfa con un margen del 2 %, escala a 900 px de ancho máximo y guarda `northe-logo.png` con paleta de 256 colores con alfa (**72 KB**, antes 160 KB); genera `northe-icono-192.png` (6.9 KB) y `northe-icono-512.png` (40 KB) sobre `#FFEBC6` con el logo ocupando el 70 % del lado (margen seguro del 15 % por lado). **Antes** de reemplazar se guardaron los tres archivos anteriores en `Recursos/NORTHE-NUEVO/anterior/` (carpeta ignorada por git; para volver atrás, copiarlos de vuelta a `Recursos/logo/`).
* **Para otro restaurante:** (1) pide el logo en PNG con transparencia **real** (no un JPG ni un "PNG" con el cuadriculado dibujado); (2) cambia la constante `CREMA` del script por el color `claro` del restaurante; (3) corre el comando con sus rutas y nombra los archivos como diga su `config.publico.marca`; (4) mira el resultado sobre su color claro **y** sobre su color oscuro: si el logo lleva texto oscuro, el panel ya lo pone en chip; si lleva texto claro, se perdería sobre el crema de este tema (20.14.9).

#### 20.14.5 Caché: por qué sw.js v13 y por qué no hizo falta un nombre nuevo

Los archivos de logo cambian de contenido **con el mismo nombre**. Se revisó quién los puede tener guardados: `vercel.json` **no** pone `Cache-Control` a `/Recursos` (Vercel sirve estáticos con `max-age=0, must-revalidate`: el navegador revalida) y **solo `panel.html` registra el service worker** (el sitio público no). `sw.js` guarda lo que se pide bajo `/Recursos/` (primero la caché), así que el panel instalado podría seguir viendo el logo viejo: subir la versión a **v13** borra las cachés v12 y obliga a reinstalar el worker. Costo: una recarga más en el panel ya abierto. Por eso **no se usó un nombre nuevo ni SQL** (la opción con `northe-logo-t.png` y un `18-logo-transparente.sql` con su reversa se descartó: no hay riesgo real de logo viejo pegado). Una prueba exige que `vercel.json` siga sin caché larga y que el sitio público siga sin registrar el worker.

#### 20.14.6 Contraste y accesibilidad

Calculado con los colores de la marca (script local de apoyo, y en el navegador con los estilos calculados; `tema-claro.mjs` y `front.mjs` 10). Mínimo 4.5:1 en texto y 3:1 en componentes:

| Pareja | Contraste |
|---|---|
| Eslogan: `primario` sobre `claro` | 4.77 |
| Botón primario: `claro_suave` sobre `primario` / sobre `primario_oscuro` (hover) | 5.20 / 8.42 |
| `oscuro` sobre `claro` / sobre `claro_suave` | 15.75 / 17.15 |
| Precio: `primario_oscuro` sobre `claro_suave` | 8.42 |
| Descripciones `#5a4a3a` sobre `claro_suave` / `claro` | 7.90 / 7.25 |
| Frase de la portada (oscuro al 78 %) sobre `claro` | 8.45 |
| Textos secundarios (oscuro al 68 % / 70 %) | 6.22 / 6.01 |
| Verde oscuro de texto `#3f5a24` sobre `claro_suave` | 7.24 |
| Aviso de cerrado: `oscuro` sobre `acento` | 8.1 |
| Pie: `claro_suave` / `acento` / `texto_secundario` / `texto_tenue` sobre `oscuro` | 17.15 / 9.07 / 12.54 / 8.11 |
| Borde de los campos (oscuro al 55 %) sobre blanco | 4.12 |
| Aro de foco: `oscuro` sobre `claro` | 15.75 |

Además: **foco visible** (aro de 3 px oscuro; mostaza en el pie), **tamaños táctiles de 44 × 44 px** en lo que se toca (carrito, categorías, "Mi pedido", botones, "+", "−", cerrar, redes), **sin desborde horizontal** a 360, 390, 768 y 1280 px (también con el carrito abierto) y el cajón del carrito sin sombra cuando está cerrado (la sombra se asomaba por el borde derecho).

#### 20.14.7 Capturas

`pruebas/multirestaurante/capturas-tema.mjs` (herramienta, no cuenta como prueba) levanta el sitio con la base falsa y el SQL 17 aplicado, abre Chrome y guarda PNG en **`Recursos\NORTHE-NUEVO\capturas\`** (ignorada por git): portada, página completa, menú con fotos, modal de producto, barra flotante, carrito, formulario de entrega (dos posiciones), "¿Buscas tu pedido?", pie, aviso de cerrado (portada y carrito) y seguimiento (con y sin pedido), en 390 y 1280 px. Con `TEMA=oscuro` se capturan con el interruptor apagado, para comparar. Uso: `node pruebas/multirestaurante/capturas-tema.mjs`.

#### 20.14.8 Qué se probó y qué cambió en las pruebas

* **Nuevas:** `tema-claro.mjs` (interruptor igual en las dos páginas, todo el CSS bajo la clase, sin colores nuevos, alfa real del logo, íconos opacos con margen del 15 %, páginas del personal oscuras con chip, favicon, vista previa con ícono, contraste AA, `sw.js` v13, documentación) y el escenario 10 de `front.mjs` (en el navegador: portada, encabezado, tarjetas, modal, carrito, formulario, aviso de cerrado, sin logo, sin desbordes, seguimiento, contraste medido y tamaños táctiles).
* **Ajustadas a propósito** (sin debilitar nada): `vista-previa.mjs` 2d (el HTML estático es el de antes **más** el bloque de CSS y el interruptor, byte a byte; cualquier otra diferencia falla) y 1g/3h (la imagen es el ícono de 512); `front.mjs` 5 (compara contra el commit anterior **con el interruptor apagado**, con una copia de las páginas servida en otro puerto) y `sw.js` v13; `panel.mjs` (`sw.js` v13; el favicon es el ícono de 192, lo único que se excusa en la comparación con el commit anterior) y su mutación de `sw.js` (`mutaciones-panel.mjs`); `rebrand-northe.mjs` F9 (la v12 sigue documentada y la actual es la v13).
* **Números finales** (línea base del rebrand → ahora): unitarias 99 (igual), `superadmin` 50, `sql16` 48, `crear-superadmin-test` 13, `servidor` 204 (también por despachador y con `SQL12_NO=1`), `agrupacion` 32, `vista-previa` 57 (mismo número: 2d, 1g y 3h se ajustaron, no se agregaron), **`front` 138** (antes 104: **+34** del escenario 10 nuevo; el escenario 5 sigue con sus 600 elementos comparados y los mismos números), `panel` 356, `e2e` 180, `rls` 237, `endurecer` 426, `migrar-fotos` 126, `datos-restaurante` 76, `config-publica` 52, `dominios` 35, `hallazgos` 32, `planes` 11, `sim` 34, `cargar-secretos-test` 25, `inspeccion` 6, `rebrand-northe` 78, `textos-visibles` 10, `comparar-tickets` 7 de 7; contra el falso: `probar-compatibilidad` 26, `probar-servidor-multirestaurante` 191 (también por despachador), `probar-superadmin` 50 y `probar-aislamiento` 252 de 259 (las 7 de Realtime fallan localmente con el falso por diseño); **nueva:** `tema-claro` **43**. Aparte, `python docs/herramientas-imagenes/contraste-wcag.py .` (el barrido de las reglas CSS reales contra la paleta) da **"FALLAN SEGURO: 0"**.
* **Lo que solo se ve con ojos** (por eso las capturas): la composición, el equilibrio de espacios y la comparación con el mockup real.

#### 20.14.9 Riesgos y pendientes

1. **El tema es del código, no de la base: afecta a todos los restaurantes.** Antes de vender a un segundo restaurante hay que **decidir** si el estilo claro se queda para todos, o si se hace una clave de configuración (por ejemplo `publico.marca.tema`) y el interruptor deja de ser una constante. Mientras tanto, apagarlo es cambiar `true` por `false` en las dos páginas (20.14.1).
2. **La paleta de otro restaurante puede no cumplir AA** en este tema (por ejemplo un `primario` muy claro con texto crema, o un `claro` muy oscuro): los contrastes se calcularon con la paleta de Northe. Para un restaurante nuevo, correr `docs/herramientas-imagenes/contraste-wcag.py` y `tema-claro.mjs` con sus colores.
3. **Un logo con texto claro** se perdería sobre el crema (este tema pone el logo directo sobre el fondo claro, sin chip); el de Northe lleva texto oscuro.
4. **Mockup real pendiente** (arriba): las diferencias con la descripción son ajustes de CSS.
5. **Ver el cambio:** Ctrl + F5 en el computador; en el celular, cerrar y volver a abrir el navegador. La app del panel ya instalada puede tardar en actualizar el ícono (el worker v13 se instala al abrirla; si no cambia, desinstalar y volver a instalar).
6. **Pruebas reales que siguen pendientes** (20.11): `probar-compatibilidad`, `probar-servidor-multirestaurante`, `probar-aislamiento`, el pedido de Wompi sandbox con el pie nuevo del ticket y la vista previa de WhatsApp con `?v=3` (ahora con el ícono de 512 sobre crema), y después la verificación del 3A.

## 21. PROPUESTA de cambio de dominio (no se ejecuta)

**Esto es una propuesta: no se hizo nada de lo que sigue (NO se ejecuta).** Hoy el sitio vive en `taqueiros-2-0.vercel.app`; el restaurante demo ya es "The Northe Burgers" y esa dirección lo delata. Cambiar a un dominio propio (por ejemplo `pedidos.thenorthe.co`) es posible sin tocar el código, pero **hay partes fuera del código que dependen de la dirección** y por eso se decidió dejarlo para después.

### 21.1 Qué depende de la dirección actual

| Dónde | Qué depende | Qué pasa si no se actualiza |
|---|---|---|
| `restaurante_dominios` (SQL 11) | El restaurante se resuelve por el **host** de cada petición. | Un host que no está en la tabla da "Sitio no disponible" (404 neutro) en todo el sitio, la API y el panel. |
| `api/_restaurante.js` (`HOSTS_TRANSITORIOS_TAQUEIROS`) | Solo vale mientras la tabla `restaurante_dominios` no existe (transitorio). No es necesario cambiarlo si la tabla ya está. | Nada, si el SQL 11 está aplicado. |
| **Webhook de Wompi** (panel de Wompi → "URL de eventos") | Apunta a `https://taqueiros-2-0.vercel.app/api/webhook-wompi`. | Los pagos aprobados **no llegarían al servidor**: pedidos pagados que no aparecen en el panel. **Lo más delicado.** |
| **cron-job.org** (alertas y keep-alive) | Las URL de los trabajos llevan el host y la cabecera `Authorization: Bearer`. | Las alertas de pedidos sin atender y el keep-alive dejarían de correr. (El cron propio de `vercel.json` es relativo: no cambia.) |
| Redirección de Wompi | `index.html` usa `location.origin`: se adapta sola. | Nada. |
| Vistas previas (`og:url`, `og:image`) | Se arman con el host de la petición. | Nada; pero WhatsApp/Instagram **guardan** la vista previa del enlace viejo. |
| **Enlaces ya entregados** | Enlaces de seguimiento con token en chats de clientes y la biografía de redes. | Siguen funcionando **mientras la dirección vieja responda**. |
| **Navegador, por origen** (PWA instalada, `localStorage`, caché de `sw.js`, perfil de Chrome del local) | Cada dirección es un origen distinto. | En la nueva, el panel pide iniciar sesión otra vez, se pierden las preferencias de impresión del equipo (hay que reconfigurar el perfil `C:\TaqueirosPanel`) y hay que reinstalar la PWA. |
| Supabase Auth → URL Configuration (si se usa Site URL/redirects) | Solo si se activó. | Inicios de sesión que redirigen mal. |
| `DOMINIO_BASE` (variable de Vercel) | Solo para subdominios `<slug>.<base>`; hoy vacía. | Nada. |

### 21.2 Orden seguro, con reversa en cada paso

1. **Antes:** respaldo de la base y anotar los valores actuales (URL del webhook y de los trabajos de cron-job.org).
2. **Dominio en Vercel:** Project → Settings → Domains → agregar `pedidos.thenorthe.co`, apuntar el DNS (CNAME) y esperar el certificado. **Dejar el dominio `taqueiros-2-0.vercel.app` como alias** (no quitarlo): ambos funcionan. *Reversa: quitar el dominio nuevo.*
3. **Base:** agregar el host nuevo a `restaurante_dominios` **sin quitar el viejo** (`insert … on conflict do nothing`, restaurante demo). Probar `/api/restaurante` y el sitio en el host nuevo. *Reversa: borrar esa fila.*
4. **Pruebas en el dominio nuevo, con los dos dominios activos:** `probar-compatibilidad`, `probar-servidor-multirestaurante` y un pedido real de sandbox completo (pago → panel → ticket).
5. **Wompi:** actualizar la **URL de eventos** al dominio nuevo (en sandbox primero, luego producción) y hacer un pago de prueba; comprobar que el pedido llega. *Reversa: volver a poner la URL anterior (sigue respondiendo).*
6. **cron-job.org:** editar la URL de cada trabajo (alertas y keep-alive; **no** "Luna Rosa keep-alive") y usar "Run now". *Reversa: la URL anterior.*
7. **Vistas previas y enlaces cacheados:** compartir el enlace nuevo con un parámetro (`?v=3`); en la biografía de las redes y en el mensaje de WhatsApp poner el dominio nuevo; probar el depurador de Facebook/Meta para refrescar `og:*`. **No** romper los enlaces viejos: dejar el alias vivo **mucho tiempo** (los de seguimiento con token ya están en chats de clientes).
8. **Equipos del local:** reinstalar la PWA desde el dominio nuevo, volver a iniciar sesión y reconfigurar la impresión del perfil de Chrome; reconfigurar sonido y tamaño de ticket.
9. **Recién al final y solo si se quiere:** redirigir el dominio viejo al nuevo (redirección 308 en Vercel), **después** de comprobar que Wompi y cron-job.org ya usan el nuevo y que los pedidos pendientes de pago cerraron. Mientras exista una sola URL guardada en algún tercero con el dominio viejo, **no** se quita.

**Riesgos y por qué esta propuesta no se ejecuta ahora:** (a) el webhook de Wompi es lo único que, si se olvida, **pierde pagos** sin que el cliente lo note; (b) renombrar el proyecto de Vercel o cambiar la dirección rompería cron, webhook, `restaurante_dominios` y las vistas previas a la vez (por eso el pedido fue: **no** renombrar ni cambiar `taqueiros-2-0.vercel.app`); (c) las preferencias por navegador se pierden al cambiar de origen. Beneficio: una dirección que ya no diga "taqueiros" y un dominio propio para vender a un segundo restaurante (cada uno con el suyo, 11).

---

## 22. Opciones de producto: quitar ingredientes y extras con precio (SQL 18) — parte A de B

**Qué es.** Que cada producto permita lo típico de comidas rápidas: **quitar** ingredientes ("sin cebolla", gratis) y **agregar extras** con precio ("queso extra +$2.000"). Esta es la **parte A**: la **base de datos y el servidor**, con su seguridad y sus pruebas. **No se tocó ninguna pantalla** (`index.html`, `panel.html`, `historial.html`, `menu-admin.html`, `pedido.html`, el ticket): la **parte B** (modal del producto, carrito, mensaje de WhatsApp, ticket impreso, panel, historial y menu-admin) viene aparte. Hasta que exista la parte B, ningún navegador manda opciones: todo pedido real sigue siendo **idéntico** al de siempre.

**Regla de oro (no negociable).** El precio **siempre** lo calcula el servidor desde la base, en el instante del pedido. El navegador manda solo **ids de opción**, jamás nombres ni precios. La caché del menú (60 s) **nunca** es fuente de precios.

### 22.1 Qué se entregó

| Archivo | Qué es |
|---|---|
| `supabase/18-opciones-producto.sql` (nuevo, **sin aplicar**) | Crea `public.producto_opciones` (RLS, políticas, triggers, límites), siembra las opciones del demo y se comprueba solo (**46 comprobaciones OK/FALLA**). Atómico, idempotente, marcadores `-- >>> PASO`, "Run without RLS". |
| `supabase/18-revertir.sql` (nuevo) | Borra la tabla y sus dos funciones. Los pedidos no se tocan (guardan su propia copia). Dice cuántas filas de opciones se perdieron. |
| `api/_precios.js` | `validarItems`: valida `opciones` de cada ítem y calcula **precio unitario = base + extras**. Guarda la copia (`precio_base`, `opciones`). Tope del subtotal (sin desbordar la columna `integer`). |
| `api/_menu.js` | `leerOpcionesActivas` (menú) y `leerOpcionesParaCobrar` (cobro, sin caché). Si la tabla no existe, el menú sigue y el pedido sin opciones ni se entera. |
| `api/crear-pedido.js` | Una sola línea: responde con el código propio (400 / 503) cuando las opciones fallan; lo demás sigue en 409 como siempre. |
| `supabase/probar-opciones.mjs` (nuevo) | Prueba contra la base **real** (sesiones reales, restaurantes propios `test-opc-…`, se limpia solo, no crea pedidos). |
| `pruebas/…` | `opciones.mjs` (SQL 18 con roles reales), `opciones-precios.test.js` (unitarias), `mutaciones-opciones.mjs` (revisión por mutación), grupo `opciones` de `escenarios-servidor.mjs`, escenario 15 de `panel.mjs`, una prueba más en `front.mjs`, dos en `ticket-comanda.test.js`; `fake-supabase.mjs` aplica el SQL 18 (`SQL18_NO=1` lo omite). |

### 22.2 El modelo: `public.producto_opciones`

| Columna | Tipo | Regla |
|---|---|---|
| `restaurante_id` | `uuid` | NOT NULL, **sin valor por defecto** (un insert que lo olvide falla), llave foránea a `restaurantes` |
| `producto_id` | `text` | el producto; **llave foránea compuesta** `(restaurante_id, producto_id) → productos (restaurante_id, id)` con **ON DELETE CASCADE** (una opción jamás puede apuntar al producto de otro restaurante) |
| `id` | `text` | `^[a-z0-9][a-z0-9-]{0,59}$` ("sin-cebolla", "extra-queso"); único **dentro del producto** |
| `tipo` | `text` | `'quitar'` o `'extra'` |
| `nombre` | `text` | 1 a 40 caracteres, sin espacios en los extremos, **sin controles, sin invisibles (ancho cero, BOM), sin marcas bidireccionales y sin `<` ni `>`** |
| `precio` | `integer` | pesos, 0 a 50.000; **un `quitar` vale siempre 0** (CHECK) |
| `orden` | `integer` | por defecto 0 (los `quitar` de la semilla van en 0-9; los extras, desde 10) |
| `activa` | `boolean` | por defecto `true`; apagarla la saca del menú y el servidor deja de aceptarla |

Llave primaria `(restaurante_id, producto_id, id)`. **Máximo 12 opciones por producto** (cuentan las apagadas; un trigger con candado `pg_advisory_xact_lock` impide que dos altas simultáneas pasen de 12). Triggers: `producto_opciones_restaurante_inmutable` (el **mismo** `bloquear_cambio_restaurante()` de productos y categorías) y `producto_opciones_validar` (nombre, tipo, precio, tope de 12, y **el producto y el id no se pueden cambiar** — los pedidos guardan una copia con ese id —; para cambiarlos se borra y se crea otra). Las reglas más graves están **dos veces** (trigger y CHECK): con el trigger apagado, los CHECK solos frenan `quitar` con precio, precios fuera de 0-50.000, tipo, id, y nombre con bidi/HTML/vacío/largo/espacios de borde (el SQL y `opciones.mjs` lo prueban). **No** está en la publicación de Realtime (nadie se suscribe a esta tabla).

### 22.3 Permisos (misma matriz de productos y categorías, sección 3 y 16.5)

| | dueño | cajero | cocina | superadmin | servidor | sin membresía / dueño inactivo | anon |
|---|---|---|---|---|---|---|---|
| `producto_opciones` | lee y escribe **solo las de su restaurante** | lee las de su restaurante | — | todo | todo | — | **—** |

El rol se mide **en cada fila** (`rol_en(restaurante_id)`): ser dueño de A y solo cajero de B no da permiso de escribir en B. `authenticated` no puede `TRUNCATE`, ni `REFERENCES`, ni `TRIGGER`. **Decisión que se aparta del encargo:** el encargo pedía "lectura pública (anon y authenticated) de las opciones activas". **No se hizo** porque contradice una invariante ya probada (SQL 10 y 13: *anon no tiene privilegios sobre ninguna tabla de negocio y ninguna política alcanza a anon*; tests `rls`, `endurecer`, `probar-aislamiento` y las propias comprobaciones del SQL 10/11/18) y no hace falta: el menú público **lo entrega el servidor** (`/api/menu`, que lee con la llave secreta y solo muestra las opciones **activas**, igual que con productos). Si más adelante se quisiera leer directo desde el navegador, bastaría una política `select to anon` con `activa` y producto/categoría activos, pero **rompería esa invariante y sus pruebas**. La cocina tampoco lee la tabla (igual que `productos`): su ticket sale de la copia que guarda el pedido, no de esta tabla.

### 22.4 El contrato del pedido (aditivo y retrocompatible)

Cada ítem de `items` puede traer:

```json
{ "id": "nb-big-norte", "cantidad": 2, "precio": 26000, "opciones": ["sin-cebolla", "extra-queso"] }
```

* `opciones` es **opcional**: ausente, `null` o `[]` = comportamiento de siempre, **byte a byte** (el ítem guardado tiene las 4 claves `id, nombre, cantidad, precio`, y el servidor **ni consulta** la tabla de opciones).
* Es un **arreglo de textos** (ids), **máximo 12**, **sin repetidos**, cada uno con la forma de un id (`^[a-z0-9][a-z0-9-]{0,59}$`). Cualquier otra cosa (texto suelto, número, booleano, `null`, objeto —aunque traiga `{id, nombre, precio}` puestos por el cliente—, lista anidada, mayúsculas, espacios, salto de línea, caracteres invisibles, 61 caracteres, `__proto__`) → **400** con el mensaje genérico *"Alguna de las opciones elegidas no es válida o ya no está disponible. Actualiza la página e intenta de nuevo."* **antes** de tocar la base.
* **`precio` (el que el navegador dice estar mostrando) sigue siendo el precio BASE del producto**, como hoy. Mandar el precio con extras se detecta como cambio de precio (409, `preciosCambiados`). La parte B debe seguir mandando el base.
* Lo que el cliente intente poner de más (`precio_base`, `nombre`, precios de opciones, `total`, `subtotal`…) **se ignora**: manda la base.

### 22.5 Reglas de validación y cálculo del precio (`api/_precios.js`)

Por cada ítem que pide opciones, el servidor lee de la base (sin caché, **una sola consulta** por pedido, filtrada por restaurante y por los productos del pedido que existen en el catálogo) y exige que **cada** opción:

1. **exista** y sea **de ese producto de ese restaurante** (la opción de otro producto —aunque esté en el mismo pedido, en la línea de otro producto— y la de otro restaurante se rechazan; el mismo id en dos restaurantes se cobra al precio de cada uno);
2. esté **activa**;
3. sea usable aunque la base "no tuviera sus CHECK": tipo `quitar`/`extra`, **precio número entero** 0-50.000 (un `null`, `""` o `true` **no** se convierte en 0), un `quitar` con precio ≠ 0 se rechaza, y el nombre —saneado— no puede quedar vacío.

Si algo no cuadra, **todo el pedido** se rechaza (400 genérico, sin decir cuál opción ni por qué, y no queda pedido): nunca se cobra "a medias". Precedencia: producto desconocido (409) → agotado/categoría apagada/precio cambiado (409) → opciones inválidas (400). Si las opciones no se pueden leer: tabla ausente → **400** *"Las opciones de producto todavía no están disponibles. Haz tu pedido sin opciones."*; cualquier otro fallo de la base → **503** *"No pudimos confirmar las opciones en este momento…"*.

**Precio unitario = precio base + suma de los extras** (los `quitar` no suman). Subtotal = Σ unitario × cantidad. Se rechaza un subtotal mayor a 2.000.000.000 ("Total inválido") para que nunca desborde la columna `integer` (hoy el máximo alcanzable sin opciones es 1.500.000.000; con 12 extras de 50.000 se podía pasar).

### 22.6 Qué se guarda en el pedido

En la copia de cada ítem (columna `pedidos.items`, jsonb), **sin tocar las columnas existentes**:

```json
{ "id": "nb-big-norte", "nombre": "Big Norte", "cantidad": 2,
  "precio": 28000,          // precio unitario FINAL (con extras): todo lo que ya suma ítems sigue cuadrando
  "precio_base": 26000,     // sin extras
  "opciones": [ { "id": "sin-cebolla", "tipo": "quitar", "nombre": "Sin cebolla", "precio": 0 },
                { "id": "extra-queso", "tipo": "extra",  "nombre": "Queso extra",  "precio": 2000 } ] }
```

Es una **copia tomada de la base en ese momento** (nombre saneado: controles, ancho cero y bidi se vuelven espacio, máximo 40) y sale ordenada como en el menú (`orden`, luego `id`). Borrar o cambiar después una opción **no altera** los pedidos viejos. No existe ningún trigger ni CHECK sobre la forma o el tamaño de `items` (se revisó el inventario de inserts de la sección 16.2 y los SQL 10, 12, 13, 15 y 16: solo `proteger_campos_de_pago` impide *cambiar* `items` desde el navegador, y sigue igual), así que no hubo que ajustar nada en la base. Los pedidos existentes no se tocan y se leen igual.

### 22.7 El menú público

`/api/menu` (módulo `api/_modulos/menu.js` → `leerMenu`) devuelve, **por producto que tenga opciones ACTIVAS**, `opciones: [{ id, tipo, nombre, precio, orden }]` (ordenadas, sin `restaurante_id`, `activa` ni `producto_id`). Es **aditivo**: un producto sin opciones queda **exactamente** como siempre (sin la clave) y el resto del contrato no cambia. Respeta la caché de 60 s, el `Vary: Host`, el respaldo en memoria (que ahora también guarda las opciones) y la regla de servicio (un restaurante suspendido sigue mostrando su menú; lo que se bloquea es pedir). Si la tabla no existe (antes del SQL 18) o no se puede leer, **el menú sale igual, sin opciones** (nunca se cae por esto). El precio de un extra que se ve en el menú puede tener hasta 60 s de retraso; **no importa**, porque al crear el pedido el servidor lee el precio de la base.

### 22.8 Lugares que suman o muestran ítems (revisados uno por uno)

Se buscaron con `grep` todas las multiplicaciones precio × cantidad y las lecturas de `items` en `api/`, las páginas y el SQL. La prueba **E1/E2 de `opciones.mjs`** deja la lista cerrada: si aparece un lugar nuevo que multiplique un precio por una cantidad, la prueba falla hasta que se revise.

| Lugar | Qué hace con los ítems | Con extras |
|---|---|---|
| `api/_precios.js` | **Único** sitio que arma el precio: unitario = base + extras; subtotal Σ unitario × cantidad | calcula bien (probado con cantidad 3, dos líneas del mismo producto, 12 opciones) |
| `api/crear-pedido.js` | `total = subtotal + domicilio`; firma y guarda ese total; no vuelve a recorrer ítems | correcto; el domicilio no depende de los extras |
| `api/generar-firma.js` | firma el `total` **guardado** del pedido (no suma ítems) | correcto (el monto sin extras da 404) |
| `api/webhook-wompi.js` | compara el monto pagado con el `total` **guardado**; no recorre ítems | correcto (pagar el monto sin extras → "monto no coincide", no entra a cocina) |
| `api/reembolso.js` | no compara montos; marca `reembolsado_en` de un pedido cancelado y cobrado | correcto |
| `api/_notificar.js` (WhatsApp del servidor) | `precio × cantidad` con el precio **guardado** (final) | **suma bien**; **no muestra** las opciones todavía (parte B) |
| `supabase/…` resumen de jornada | suma `total` y `subtotal` **guardados** y cuenta `cantidad` por nombre; ninguna función SQL toca `precio` de ítems | correcto (prueba F3) |
| `panel.html` (tarjeta y ticket), `historial.html`, `pedido.html`, `index.html` (resumen y confirmación) | `precio × cantidad` con el precio **guardado** | **suman bien**; no muestran las opciones todavía (parte B). Pruebas con ítems nuevos: panel 15a-d, historial 15c, seguimiento (front), ticket (unitarias) |
| `ticket-comanda.js` | solo lee `nombre`, `cantidad` y notas; ignora las claves que no conoce | no se rompe; **el ticket impreso aún no imprime las opciones** (parte B) |
| `index.html` carrito del navegador (`p.price*qty`, 3 sitios) | suma por **precio base** | **pendiente de la parte B** (hoy no ofrece opciones, así que coincide con lo que cobra el servidor; la prueba E1 lo deja anotado como PENDIENTE) |

### 22.9 Antes de correr el SQL 18 (la tabla no existe)

Todo sigue funcionando y se probó (`SQL18_NO=1`, y las pruebas "[tabla ausente]" del grupo `opciones`): el pedido sin opciones funciona **exactamente igual** y no consulta la tabla; el menú responde 200 sin la clave `opciones`; un pedido **con** opciones responde **400** con un mensaje claro y genérico (sin nombres de tabla ni códigos de error) y no deja pedido. Si la tabla existe pero la base falla al leerla: el menú sale sin opciones, el pedido con opciones responde 503 y el pedido sin opciones no se entera.

### 22.10 Las opciones propuestas (semilla del demo) — **Carlos debe aprobarlas o cambiarlas ANTES de aplicar el SQL**

Salen de las descripciones **reales** de los 13 productos (SQL 17). Se puede quitar lo que la descripción menciona y que **no** es el producto base; nunca la carne, el pollo, la salchicha, el chorizo, el pan ni las papas. Los extras y sus precios son **de ejemplo**. Total: **57 opciones** (21 "quitar" y 36 extras).

| Producto | Quitar (gratis) | Extras (precio) |
|---|---|---|
| Big Norte ($26.000) | Sin queso · Sin salsa rosa | Queso extra +$2.000 · Tocineta extra +$3.000 · Carne smash extra +$6.000 · Salsa extra +$1.000 |
| Crispy Norte ($22.000) | Sin queso · Sin tocineta · Sin salsa BBQ | Queso extra +$2.000 · Tocineta extra +$3.000 · Pollo crispy extra +$5.000 · Salsa extra +$1.000 |
| Lil Norte ($18.000) | Sin tocineta · Sin salsa picante | Queso extra +$2.000 · Tocineta extra +$3.000 · Carne smash extra +$6.000 · Salsa extra +$1.000 |
| Classic Norte ($12.000) | Sin mostaza · Sin salsas | Salchicha extra +$3.500 · Queso extra +$2.000 · Tocineta extra +$3.000 · Salsa extra +$1.000 |
| Smoky Norte ($15.000) | Sin salsa BBQ · Sin cebolla morada · Sin cebolla crujiente | Salchicha extra +$3.500 · Queso extra +$2.000 · Tocineta extra +$3.000 · Salsa extra +$1.000 |
| Full Norte ($18.000) | Sin cebolla crujiente · Sin vegetales · Sin salsas | Salchicha extra +$3.500 · Queso extra +$2.000 · Tocineta extra +$3.000 · Salsa extra +$1.000 |
| Creamy Norte ($14.000) | Sin cebolla · Sin rúgula · Sin salsa cremosa | Queso extra +$2.000 · Tocineta extra +$3.000 · Pollo crispy extra +$5.000 · Salsa extra +$1.000 |
| Dirty Norte ($17.000) | Sin rúgula · Sin salsa blanca | Queso extra +$2.000 · Tocineta extra +$3.000 · Pollo crispy extra +$5.000 · Salsa extra +$1.000 |
| Chori Norte ($19.000) | Sin salsas | Queso extra +$2.000 · Tocineta extra +$3.000 · Chorizo extra +$3.500 · Salsa extra +$1.000 |
| Agua, Coca-Cola, Pepsi, Sprite | (sin opciones) | (sin opciones) |

Para cambiar algo: editar la lista del **paso 0.2** de `18-opciones-producto.sql` (una fila por opción: producto, id, tipo, nombre, precio, orden) **antes** de correrlo. Detalles de la semilla: `ON CONFLICT DO NOTHING` — volver a correr el archivo **no duplica** y **no pisa** lo que el dueño haya cambiado (un precio, una opción apagada); lo que haya **borrado** de la semilla **vuelve**; lo que haya agregado se conserva. Las bebidas no llevan opciones.

### 22.11 Cómo aplicar y revertir el SQL 18 (Windows)

1. **Respaldo** (solo lee): `node supabase/exportar-respaldo.mjs` con la llave cargada así: `$k = Read-Host "Llave SECRETA" -AsSecureString` y `$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password`. Si dice "NO coincide", no sigas. Copia la carpeta de `respaldos\` fuera del repositorio.
2. **Aplicar:** en Supabase → SQL Editor → New query, pega **todo** `supabase/18-opciones-producto.sql` y pulsa **"Run without RLS"**. Debes ver **46 filas, todas "OK"** (la última parte son las comprobaciones "sin cambios: …"). Si algo falla dice `EL SQL 18 SE REVIRTIO` y lista qué; la base queda como estaba. Se puede correr dos veces sin problema.
3. **Probar contra la base real** (con la llave todavía cargada): `node supabase/probar-opciones.mjs`. Debes ver **38 PASAN, 0 FALLAN** y al final `Limpieza: todo lo creado se borro.` Luego `node supabase/probar-compatibilidad.mjs` (26) y `node supabase/probar-servidor-multirestaurante.mjs` (**195 si el SQL 18 aún no está aplicado, 249 con él** —247 antes de la revisión de 22.17—; también con `$env:VIA = "despachador"`). Quita la llave: `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.
4. **Revertir** (solo si hace falta): pega `supabase/18-revertir.sql` y "Run without RLS". Debes ver todo "OK" y una fila informativa con cuántas filas de opciones se perdieron (si quieres conservarlas, antes: `select * from public.producto_opciones order by restaurante_id, producto_id, orden;` y guarda el resultado). Los pedidos no se tocan.

`probar-opciones.mjs` crea sus propios restaurantes (`test-opc-<código>-a` y `-b`, apagados, sin dominio) y usuarios (`@opciones.example.com`), prueba permisos por rol con la llave publicable (lo que usa el navegador), reglas (13 rechazos 23514, tope de 12), el cálculo (llamando a las funciones reales del servidor), el menú y que **el demo no cambió**; no crea, cambia ni borra ningún pedido (ni en el demo ni en ninguno). Si la tabla no existe, sale con código 2 explicando qué correr, sin crear nada. Si lo interrumpes con Ctrl+C, limpia lo que alcanzó a crear (y al empezar barre restos de una corrida anterior).

### 22.12 Pruebas locales (números)

| Batería | Línea base | Ahora | Por qué cambia |
|---|---|---|---|
| unitarias (`node --test pruebas/*.test.js`) | 99 | **120** | +19 de `opciones-precios.test.js` (nuevo) y +2 en `ticket-comanda.test.js` (ítems nuevos y viejos mezclados) |
| `servidor.mjs` (también `--via=despachador` y `--via=reescrita`) | 204 | **260** | +56 del grupo nuevo `opciones`; con `SQL18_NO=1` (tabla ausente): **208** (+4) |
| `front.mjs` | 138 | **139** | +1: el seguimiento de un pedido con opciones |
| `panel.mjs` | 356 | **360** | +4: escenario 15 (tablero e historial con ítems nuevos) |
| contra el falso: `probar-servidor-multirestaurante` (también por despachador) | 191 | **247** | +56 (el mismo grupo); sin el SQL 18: **195** (+4). **Es lo que debe dar en la base real: 195 antes de aplicar el SQL 18 y 247 después** |
| `tema-claro.mjs` | 43 | 43 | igual; la prueba 3h ("no hay SQL nuevo de este cambio") se ajustó **a propósito**: ya existe un `18-*` pero es el de opciones, no del estilo claro |
| **nuevas:** `opciones.mjs` / `probar-opciones.mjs` (contra el falso) / `mutaciones-opciones.mjs` | — | **75** / **38** / **102 mutaciones** | pruebas nuevas |
| sin cambio | | | superadmin 50, sql16 48, crear-superadmin-test 13, agrupacion 32, vista-previa 57, e2e 180, rls 237, endurecer 426, migrar-fotos 126, datos-restaurante 76, config-publica 52, dominios 35, hallazgos 32, planes 11, sim 34, cargar-secretos-test 25, inspeccion 6, rebrand-northe 78, textos-visibles 10, comparar-tickets 7 de 7, probar-compatibilidad 26, probar-superadmin 50, probar-aislamiento 252 de 259 (las 7 de Realtime fallan localmente con el falso, por diseño) |

Comandos nuevos: `node pruebas/multirestaurante/opciones.mjs` (~17 s), `node pruebas/multirestaurante/servidor.mjs --grupo=opciones` (~4 s), `node --test pruebas/opciones-precios.test.js`, `node pruebas/multirestaurante/contra-falso.mjs probar-opciones.mjs`, `SQL18_NO=1 node pruebas/multirestaurante/servidor.mjs` (el código nuevo antes de correr el SQL 18), `node pruebas/multirestaurante/mutaciones-opciones.mjs --paralelo=3` (~15 min).

**Qué cubren las nuevas.** `opciones.mjs` (75): A) el SQL 18 y su reversa corren dos veces, no cambian ninguna fila de negocio, conviven con los SQL 15, 16, 16b y 17 (antes o después) y con la reversa del 17, se detienen con un mensaje claro sin el SQL 10 o sin el menú del 17 y se revierten solos si una comprobación falla; B) la semilla (57, cada "quitar" nombra algo que la descripción real menciona, ninguno quita el producto base, precios, volver a correr no pisa); C) permisos con usuarios reales (dueño, cajero, cocina, dueño inactivo, sin membresía, superadmin, anon, servidor; dos restaurantes que no se ven ni se tocan; TRUNCATE denegado; dueño de A y cajero de B); D) reglas con el rol del dueño y con el trigger apagado; E) ningún lugar del código suma con el precio base; F) ítems nuevos y viejos se leen igual (ticket, jornada, seguimiento). Grupo `opciones` de `servidor.mjs` (56): precio, guardado, webhook, firma, reembolso, domicilio, 26 rechazos, ignorar lo inyectado, precedencias, sin caché, menú, tabla ausente, fallo de la base. `opciones-precios.test.js` (19): lo que la base real impide provocar (filas corruptas: `quitar` con precio, extra negativo, `null`, nombre solo de invisibles, desborde del subtotal).

### 22.13 Revisión por mutación (`mutaciones-opciones.mjs`)

**102 mutaciones** (50 del servidor —precio, validación, aislamiento y menú— y 52 del SQL 18 y su reversa): **92 detectadas, 10 equivalentes (cada una con su razón), 0 sobrevivientes** (más un control: el código original pasa todo antes de empezar). Servidor: 44 detectadas y 6 equivalentes. SQL: 48 y 4. Rompe, entre otras cosas: el cálculo (ignorar extras, restarlos, no multiplicar por la cantidad, cobrar el base, guardar el base como `precio`), cada regla de la forma del contrato, aceptar opciones apagadas / de otro producto / de otro restaurante / mal formadas, descartar una opción mala en silencio, el tope del subtotal, el saneado del nombre, el código 400/503, consultar otro restaurante, mostrar las apagadas en el menú, exponer columnas internas, y en el SQL: sin RLS, cajero o cocina con permisos, anon con lectura, un `default` en `restaurante_id`, FK sin cascada, PK sin restaurante, cada CHECK, el nombre con bidi / HTML / controles, el tope de 12, la identidad inmutable, triggers que no se crean, `SECURITY DEFINER`, EXECUTE para anon, semilla que pisa / inventa un ingrediente / quita la carne / siembra bebidas, comprobaciones que no revierten, y la reversa (no borra, borra de más, no se puede repetir).

**Lo que la revisión encontró y se corrigió:** (1) *un error real del código*, antes de la revisión por mutación, con las pruebas unitarias: `Number(null)` es 0, así que una fila con precio `null` pasaba como un **extra gratis**; ahora se exige un número entero de verdad; (2) la primera pasada completa dejó sobrevivir una mutación del servidor —la opción de un producto pedida en la línea de **otro producto del mismo pedido** (el mapa de opciones se aplanaba y se aceptaba)—: se agregó una prueba de escenarios y una unitaria; (3) en el SQL, quitar el GRANT EXECUTE explícito a `authenticated` no cambia nada (Supabase ya se lo da por defecto): se declaró equivalente y se agregó la mutación que **sí** le quita el permiso (detectada); (4) las comprobaciones propias del SQL no probaban los CHECK *solos* (el trigger los tapaba): se agregó la prueba "CHECK sin trigger" dentro del SQL.

**Las 10 equivalentes (no cambian lo que un atacante puede lograr):** servidor — (a) los `quitar` también suman su precio (`copiaDeOpcion` ya rechaza un `quitar` con precio ≠ 0); (b) descartar la opción mala y aceptar la línea (la comparación `elegidas.length !== idsOpciones.length` la rechaza igual: defensa en capas); (c) calcular `total` de otra forma al principio de `crear-pedido.js` (se pisa más abajo con `subtotal + costoDomicilio`); (d) pedir `select=*` en el menú (cada opción se arma campo por campo: nada interno llega); (e) no mirar el restaurante al pegar las opciones al producto (la lectura ya es del restaurante); (f) `precio` del menú sin `Number()` (PostgREST ya manda números). SQL — (g) el trigger sin el chequeo de `quitar` con precio y (h) sin el del rango de precio (los CHECK dicen lo mismo; la prueba "CHECK sin trigger" lo comprueba por separado); (i) quitar el candado del tope de 12 (PGlite no puede provocar dos transacciones simultáneas; se revisa por lectura y con `probar-opciones.mjs` en la base real); (j) omitir el GRANT EXECUTE a `authenticated` (ya lo tiene por defecto).

### 22.14 Decisiones donde el encargo no lo definía

* **anon no lee la tabla** (22.3): se aparta del texto del encargo para no romper la invariante del SQL 10/13; el menú público lo entrega el servidor.
* **La cocina no lee la tabla**, como con `productos`. Si la parte B necesitara que la cocina o el cajero la lean desde el navegador, es una política de una línea.
* **`precio` mostrado = precio base** (22.4), para no cambiar el significado del campo actual ni la lógica de `preciosCambiados`.
* **Un `quitar` no se puede convertir en pagado ni un extra en `quitar` con precio** (CHECK); tampoco se puede mover una opción de producto o cambiarle el id.
* **`<` y `>` prohibidos en el nombre** de una opción (defensa extra: el nombre irá a páginas, tickets y mensajes; la parte B igual debe insertarlo con `textContent`).
* **Tope del subtotal** de 2.000.000.000 (evita un 500 por desborde del `integer`); no cambia nada de lo alcanzable hoy.
* **La semilla es ON CONFLICT DO NOTHING** (no pisa cambios del dueño). El SQL 18 **exige** el menú del SQL 17 (los 13 productos `nb-*`) y se detiene nombrando los que falten.
* **Categoría "hot dogs":** el encargo la llamó `nb-hotdogs`; en la base real es `nb-hot-dogs`. La semilla no depende de las categorías (solo de los ids de producto).
* **El simulador general** (`fake-supabase.mjs`) crea los 13 productos `nb-*` como andamio, corre el SQL 18 y los quita: así todas las baterías tienen la tabla (vacía) sin cambiar el menú de Taqueiros que usan casi todas.

### 22.15 Riesgos conocidos y qué revisar con Opus 5.5 en esfuerzo High

1. **Cálculo de precio** (`api/_precios.js`): revisar que *ningún* camino cobre con el precio base cuando hay opciones y que el redondeo/tope no cambie lo de hoy.
2. **Validación de opciones**: la estrictitud del contrato (¿conviene aceptar un objeto `{id}` en el futuro? hoy se rechaza a propósito) y el mensaje genérico.
3. **RLS de la tabla**: revisar las cuatro políticas y el trigger del tope de 12 (candado `pg_advisory_xact_lock`; la concurrencia real **no** se puede probar en PGlite —un solo proceso—: se comprueba por lectura y con `probar-opciones.mjs` contra la base real).
4. **Staleness del menú (60 s)**: si el dueño sube el precio de un extra, un cliente con el menú viejo verá el precio anterior y el servidor cobrará el nuevo; Wompi muestra el monto real antes de pagar, pero la parte B debería comparar el `total` que devuelve `crear-pedido` con el que mostró y avisar. Apagar una opción deja de aceptarla de inmediato (400 genérico) aunque el menú en caché todavía la ofrezca hasta 60 s.
5. **El ticket y el WhatsApp del servidor aún no muestran las opciones** (parte B). Mientras la interfaz no mande opciones, no pasa; pero si alguien llamara a la API a mano con opciones, el pedido se cobraría bien y la cocina vería solo "2x Big Norte" sin la nota. **No desplegar la interfaz de opciones sin el ticket.**
6. **Reversa y datos**: revertir pierde las opciones cargadas (no los pedidos). `ON DELETE CASCADE`: borrar un producto borra sus opciones; la reversa del SQL 17 (que borra los productos nuevos) también las borra.
7. **`index.html` (carrito):** suma por precio base; es lo correcto *hoy*, y es lo primero que la parte B debe cambiar.

### 22.16 Qué sigue

1. **Revisión de seguridad** de esta parte A (22.15). *Hecha: 22.17.*
2. **PARTE B** (interfaz del cliente): modal del producto, carrito, mensaje de WhatsApp, ticket impreso, panel, historial y menu-admin (alta/edición/apagado de opciones por el dueño). Incluir ahí además el arreglo del aviso de abierto que hoy termina en "p.m.." con dos puntos. *Hecha: 22.18.*
3. Después, las pruebas reales del rebrand y la verificación del 3A.

### 22.17 Revisión adversaria de la parte A (independiente)

**Veredicto.** No se encontró ningún camino para **cobrar menos** de base + extras, ni para usar, leer o escribir una opción, producto o pedido de **otro restaurante**. El dinero lo decide un solo lugar (`validarItems`) con datos de la base leídos sin caché; el webhook, la firma y el reembolso trabajan con el `total` guardado; la tabla tiene RLS por fila, llave foránea compuesta y ningún acceso para `anon`. Se corrigió **un defecto real** (H1: un nombre de opción con emoji tumbaba los pedidos) y se reforzaron las pruebas donde una mutación sobrevivía. **No hay SQL nuevo** que correr.

**Cómo se revisó (todo local; ni la base real ni llaves):** lectura completa de `_precios.js`, `_menu.js`, `crear-pedido.js`, `generar-firma.js`, `webhook-wompi.js`, `reembolso.js`, `_notificar.js`, `_supabase.js`, `_restaurante.js`, el SQL 18 y su reversa, y de cada lugar que muestra ítems; un banco de ataques contra el Supabase falso (1.122 ítems hostiles combinando 22 formas de `opciones`, 17 de `cantidad` y 9 de `precio`: en los 90 aceptados lo cobrado fue **siempre** (base + extras) × cantidad); una prueba **diferencial** del `_precios.js` anterior a las opciones contra el actual con **20.000 pedidos sin opciones**: **0 diferencias** (mismos campos, orden, tipos, totales, mensajes y excepciones); y 36 mutaciones propias sobre lo que la revisión por mutación de 22.13 no rompía.

#### Hallazgos

| # | Severidad | Estado de la prueba | Dónde | Qué pasa | Estado |
|---|---|---|---|---|---|
| H1 | **Media** | CONFIRMADO (banco de ataques + Postgres) | `api/_precios.js` `nombreSaneado` | La base mide el nombre en **caracteres** (`char_length` ≤ 40) y el servidor lo recortaba en **unidades UTF-16** (`slice(0, 40)`). Un nombre válido como `Queso doble cheddar madurado extra 🧀🧀🧀🧀` (39 caracteres, 43 unidades) quedaba con **medio emoji**; `JSON.stringify` lo escribe como un sustituto suelto y **Postgres rechaza ese JSON**: **todo pedido con esa opción respondía 500** ("No pudimos iniciar el pago") y el cliente no sabía por qué. Nunca cobraba mal (fallaba cerrado), pero una opción legítima del dueño dejaba de venderse. | **Corregido**: el recorte cuenta caracteres (`Array.from`). Pruebas: unitaria y escenario del grupo `opciones` (fallan antes, pasan después). |
| H2 | Baja | CONFIRMADO | `opcion_nombre_valido` (SQL 18) y `nombreSaneado` | La lista de "invisibles" no es completa: la base acepta, y la copia del pedido conserva, `U+061C` (marca bidi árabe), `U+2065`, `U+00AD` (guion suave), rellenos invisibles (`U+3164`), etiquetas `U+E0000-E007F` y `U+FFF9-FFFB`; y un nombre hecho **solo** de espacio duro (`U+00A0`) pasa la base pero el servidor lo deja vacío y **rechaza** toda opción así (400). Solo lo puede escribir el **dueño en su propio restaurante**, y todo se muestra escapado. Es la misma familia que R8 (18.1). | Pendiente (sin SQL nuevo en esta revisión): cerrarlo junto con R8 en un SQL futuro y, en la parte B, que `menu-admin` lo valide antes de guardar (regla S6). |
| H3 | Baja | CONFIRMADO (PGlite) | SQL 18, paso 5 (semilla) | El trigger del tope de 12 corre **antes** del `ON CONFLICT DO NOTHING`: si el dueño llenó a 12 un producto sembrado, **volver a correr** el SQL 18 se detiene con "Un producto no puede tener más de 12 opciones" (todo se revierte, no daña nada). | Aceptado: el SQL 18 ya está aplicado y no hay que volver a correrlo. Si algún día hiciera falta, primero borrar una opción de ese producto. |
| H4 | Baja | CONFIRMADO (lectura + el mismo mecanismo de H1) | `api/crear-pedido.js` `limpiar()` (preexistente) | Los datos del **cliente** (nombre 120, dirección 200, indicaciones 400…) se recortan igual, por unidades UTF-16, y `index.html` no pone `maxlength`: unas indicaciones largas con un emoji justo en el borde dan 500. Solo afecta el pedido de ese cliente. | Pendiente (una línea: recortar con `Array.from`, como H1). No se tocó porque no es de opciones y es baja. |
| H5 | Media (diseño; para la parte B) | CONFIRMADO (prueba existente "el menú que el cliente ya tenía… se cobra con el de la base") | contrato de `crear-pedido` | Para el precio **base** hay `preciosCambiados` (409 y aviso); para los **extras no**: si el dueño sube un extra mientras el cliente tiene el menú en caché (≤ 60 s), el servidor cobra el precio nuevo **sin avisar**. Es correcto (el servidor manda) y Wompi muestra el monto real antes de pagar, pero el cliente vería un total en el carrito y otro en Wompi. | Pendiente de la **parte B** (regla C2 abajo). No hace falta cambiar el servidor. |
| H6 | Baja / informativa | CONFIRMADO (medido) | abuso | 100 líneas × 12 extras: el pedido pendiente guarda 132 KB de texto en `items` (3,6 KB comprimido en la base) contra 7 KB sin opciones; tarda ~60 ms y hace **una** consulta de opciones por pedido (sin N+1). Sin límite de peticiones (propuesta C de 18.3, pendiente), alguien podría llenar la base más rápido que antes; la limpieza borra los pendientes a las 24 h. | Aceptado; lo cierra el límite de peticiones (18.3-C). |
| H7 | Informativa | Lectura | `leerOpcionesActivas` / `leerOpcionesParaCobrar` | Sin paginación: con más de 1.000 filas (tope de PostgREST; ≥ 84 productos con 12 opciones cada uno) el menú perdería opciones y el cobro **rechazaría** (falla cerrado). Igual que `productos` hoy. | Aceptado. |
| H8 | Informativa | Lectura | `/api/menu` | El menú entrega el nombre **tal como está en la base** y el pedido guarda el **saneado**; solo difieren en lo de H2 y en espacios dobles. | Aceptado (la parte B muestra con `textContent`). |
| H9 | Informativa (recordatorio, preexistente) | Lectura | `modoDePago` (18.3-D) | Mientras el demo no tenga `wompi_modo` fijado, el modo de cobro lo sigue proponiendo el navegador. Con Wompi en sandbox no hay dinero real. | **Antes de cobrar en real**: fijar `wompi_modo` (pendiente P1 de la sección 13). |
| H10 | Informativa (preexistente, R5) | Lectura | `mr_pedidos_insert` | Dueño y cajero pueden insertar pedidos por REST con el `items` que quieran, incluidas "opciones" inventadas que **no** pasan las reglas del nombre. | Sigue esperando la decisión de R5. Consecuencia para la parte B: la copia del pedido es **texto no confiable** (regla S1). |
| H11 | Informativa | Lectura | `generar-firma.js` | Acepta formas raras del monto (`"2400000.0"`, `[2400000]`) que valen lo mismo y firma esa cadena; no baja el monto (Wompi compara el que recibe). Ninguna página lo usa. | Aceptado. |

**Revisado sin hallazgo:** ids repetidos, con mayúsculas, espacios, invisibles, `__proto__`/`constructor`, números, objetos, listas anidadas, `false`/`0`/`""`, más de 12 (todo 400 antes de tocar la base); la misma opción o el mismo producto en varias líneas (cada línea se cobra sola); cantidades como texto, decimales, negativas, enormes, `Infinity` (409 o el número exacto); claves extra del cliente (ignoradas); precio de opción nulo, texto, decimal o fuera de rango en la base (rechazado); fallo de la base al leer productos, categorías u opciones (nunca 200); tope del subtotal sin desbordar el `integer` (≤ 2.000.000.000 + domicilio ≤ 500.000 < 2.147.483.647); el webhook exige centavos exactos y COP; generar-firma solo firma el total guardado de un pedido pendiente de ese restaurante; reembolso no compara montos; aislamiento por Host, por id ajeno y por la llave foránea compuesta; RLS por fila (`rol_en(restaurante_id)`), sin `SECURITY DEFINER`, `search_path` fijo, sin `anon`, fuera de Realtime; tope de 12 con candado (`pg_advisory_xact_lock` antes del `count`, en una función `VOLATILE`: cada sentencia ve lo confirmado por la otra transacción) y un insert de 13 filas en una sola sentencia se rechaza entero; el producto, el id y el restaurante de una opción no se pueden cambiar; cascada solo dentro del restaurante.

#### El contrato "estricto" (hoy se rechaza `{id}`)

**Recomendación: mantenerlo estricto.** (1) La parte B todavía no existe: no hay ningún cliente que romper, y el que se escriba manda texto. (2) Aceptar objetos invita a que alguien lea después `nombre` o `precio` del objeto "porque ya viene": hoy es imposible porque el servidor ni lo mira. (3) Un error 400 inmediato y siempre igual hace que un fallo de la parte B se vea en la primera prueba, en vez de cobrar una opción de menos en silencio. (4) Si algún día hace falta más información por opción (cantidad de un extra, por ejemplo), se agrega **otra clave** (`extras_v2`) con su propia validación, sin cambiar el significado de `opciones`. La única "trampa" posible es una PWA vieja en caché que mandara otra forma, y no existe: ninguna versión publicada manda `opciones`.

#### Pruebas que pasaban por una razón equivocada, y mutaciones

Mis 36 mutaciones: 22 detectadas, 13 sobrevivían y 1 mal definida. Las que sobrevivían y su arreglo:

| Mutación que sobrevivía | Qué significa | Ahora |
|---|---|---|
| el webhook compara con el **subtotal** | Nada probaba un pedido **con domicilio** pagado sin el domicilio | Escenario nuevo: pagar solo el subtotal no aprueba; el total exacto sí |
| tope del subtotal a 2.200.000.000 o 3.000.000.000 | La prueba usaba 4.500.000.000: no miraba el borde | Unitaria con el borde exacto (2.000.000.000 pasa; 1 peso más y 2.147.483.648 no) |
| la lista `in.()` sin codificar | La prueba decía "codificados" pero sus ids no tenían `&`, `#`, `%` ni `+` | Unitaria con un id `h&restaurante_id=eq.x#i %+` (y que no cuele otro filtro) |
| saneado sin C1 / sin U+2060-2064 | Ninguna prueba los usaba | Unitaria rango por rango |
| `false`, `0`, `""` valen como "sin opciones" | El contrato estricto no lo vigilaba | Unitaria |
| tope de 12 sin filtro de restaurante (SQL) | Con el dueño, RLS lo tapaba (solo ve sus filas) | `opciones.mjs` D7c: otro restaurante con el mismo id de producto carga sus 12 (escribe el servidor, que ve todo) |
| el tope de 12 frena también las ediciones (SQL) | Con 12 opciones el dueño no podría ni cambiar un precio | `opciones.mjs` D7b |
| el nombre acepta U+2060-2064 / U+2066-2069 (SQL) | D1 no los probaba | D1 ahora prueba 22 reglas (antes 17) |
| saneado sin BOM | — | **Equivalente**: `U+FEFF` ya es espacio para `\s` |
| id de producto sin recortar al buscar sus opciones | — | **Equivalente**: solo un id con espacios de borde, y el pedido se rechaza (nunca cobra de menos) |

Todas quedaron en `mutaciones-opciones.mjs` (más la de H1): **115 mutaciones, 103 detectadas, 12 equivalentes (cada una con su razón), 0 sobrevivientes** (servidor 59: 51 + 8; SQL 56: 52 + 4).

#### Reglas de salida para la parte B

El nombre de una opción llega a: menú público, modal y carrito (`index.html`), confirmación y WhatsApp del cliente, seguimiento (`pedido.html`), panel y su ticket de texto, ticket impreso (`ticket-comanda.js`), historial, WhatsApp del servidor (`_notificar.js`, CallMeBot) y `menu-admin`.

* **S1. Siempre texto, nunca HTML.** Insertar con `textContent`, o con el `esc()`/`escapar()` que ya tiene cada página (escapa `& < > " '`). Nunca `innerHTML` con el nombre crudo, ni dentro de un atributo sin escapar. Vale también para lo que sale de `pedidos.items`: por H10 esa copia **no es confiable**.
* **S2. Una línea.** Al pintar o enviar, convertir saltos y separadores (`\r`, `\n`, `U+2028`, `U+2029`) en espacio: un salto fabricaría en la comanda una línea con forma de producto.
* **S3. Quitar invisibles al mostrar** (además de lo que ya quita la base): `U+061C`, `U+200B-200F`, `U+202A-202E`, `U+2060-206F`, `U+FEFF`, `U+00AD`, `U+E0000-E007F`, `U+FFF9-FFFB`. El ticket ya quita varios (`SIMBOLOS`), pero **no** `U+2066-2069` ni `U+061C`: agregarlos ahí.
* **S4. Largo.** Cortar por **caracteres** (`Array.from(t).slice(0, n)`), nunca `t.slice(0, n)` (H1). En el ticket térmico, dejar que el nombre envuelva en vez de cortarlo.
* **S5. WhatsApp / CallMeBot.** Sin `$` en el texto que va a CallMeBot (lo corrompe, ver `_notificar.js`); no poner el nombre entre `*`, `_` o `~` sin limpiarlos (formato de WhatsApp); armar la URL **solo** con `encodeURIComponent`; y acotar el mensaje (por ejemplo, máximo 6 opciones por línea y "+N más") para no pasar el largo de URL de CallMeBot con pedidos grandes.
* **S6. Emojis y comida.** El ticket térmico **borra los emojis**: un "Sin 🧅" se imprimiría "Sin". `menu-admin` debe **rechazar** (o advertir) nombres de opción que con `limpiarTexto` del ticket queden vacíos o distintos, y los que tengan los caracteres de H2. Un "quitar" mal impreso es un problema de alergias, no de estética.
* **S7. Los quitar se imprimen distinto** de los extras ("SIN cebolla" en mayúscula o con prefijo fijo; "+ Queso extra"): en la cocina se leen en un segundo.
* **S8. Los precios salen del servidor.** Nada de la parte B calcula un precio con datos de opciones que no vengan del menú (para mostrar) o de la copia guardada (para el ticket, el panel y el historial). `precio` de la copia ya es el unitario **final**.

#### Recomendaciones de diseño para el carrito y el total

* **C1. La línea del carrito es producto + opciones**, no solo el producto: la llave debe ser `id` + opciones **ordenadas** (dos hamburguesas con distintas opciones son dos líneas). Al servidor se manda `precio` = **precio base** (como hoy) y `opciones` = lista de ids.
* **C2. Comparar el total (H5).** Después de `crear-pedido`, comparar `total` (y `subtotal`) con lo que el carrito mostraba. Si es distinto, **no abrir Wompi en silencio**: mostrar "El precio de un extra cambió: el total ahora es $X" con dos botones (*Pagar $X* / *Revisar mi pedido*). **No** reintentar en bucle recargando el menú: la caché del menú puede seguir vieja hasta 60 s y el cliente quedaría atrapado; el valor bueno es el que devolvió el servidor.
* **C3. El 400 de opciones** (opción apagada o inexistente) debe recargar el menú y llevar al cliente al carrito con el aviso genérico; el servidor no dice cuál falló a propósito.
* **C4. Lo que se guarda en el navegador** para la confirmación y el WhatsApp del cliente (hoy `items` con `p.price`) debe incluir las opciones y el **total del servidor**, no el recalculado.

#### Pruebas (local) después de esta revisión

Cambian, a propósito: **unitarias 120 → 121** (`opciones-precios.test.js` 19 → 20: la prueba de H1; las demás se reforzaron dentro de pruebas existentes); **`servidor.mjs` 260 → 262** (y por despachador y reescrita: el escenario de H1 y el del webhook con domicilio; con `SQL18_NO=1` sigue en **208**); **contra el falso `probar-servidor-multirestaurante` 247 → 249** (corre los mismos escenarios: **es lo que debe dar en la base real**); **`opciones.mjs` 75 → 77** (D7b y D7c; D1 ahora prueba 22 reglas y D11 cuenta por restaurante). Mutaciones: 102 → **115**. **Sin cambios:** superadmin 50, sql16 48, crear-superadmin-test 13, agrupacion 32, vista-previa 57, front 139, tema-claro 43, panel 360, e2e 180, rls 237, endurecer 426, migrar-fotos 126, datos-restaurante 76, config-publica 52, dominios 35, hallazgos 32, planes 11, sim 34 OK, cargar-secretos-test 25, inspeccion 6, rebrand-northe 78, textos-visibles 10, comparar-tickets 7 de 7 idénticos; contra el falso: probar-compatibilidad 26, probar-opciones 38, probar-superadmin 50, probar-aislamiento 252 de 259 (las 7 de Realtime, que el falso no emula, como siempre).

**Qué correr en la base real (opcional, con la llave cargada como en 22.11):** `node supabase/probar-servidor-multirestaurante.mjs` → **249 PASAN** (el escenario de H1 crea y borra su propia opción con emoji en un restaurante de prueba). No hay SQL que aplicar.

### 22.18 PARTE B: la interfaz de las opciones de producto (cliente, carrito, mensajes, ticket, panel, historial y menu-admin)

**Qué es.** La pantalla de lo que la parte A dejó listo en la base y en el servidor: el cliente **quita** ingredientes (gratis) y **agrega** extras (con precio) en cada producto; eso viaja bien en el pedido, el WhatsApp, el ticket de cocina, el seguimiento, el panel y el historial; y el dueño administra sus opciones desde `menu-admin.html`. **No hay SQL nuevo** (la tabla, los permisos y el cálculo del precio son los de 22.2 a 22.7). **El servidor no cambió de contrato ni de cálculo:** solo se tocó `api/_notificar.js` (las opciones en el mensaje de CallMeBot) y una línea de `api/crear-pedido.js` (el arreglo H4). `/api/crear-pedido` ya devolvía `subtotal` y `total` (los del servidor): **no hizo falta ningún campo nuevo** para avisar de un precio cambiado.

#### 22.18.1 Qué se cambió, archivo por archivo

| Archivo | Qué hace ahora |
|---|---|
| `opciones-texto.js` (**nuevo**, `window.OpcionesTexto` y `require()`) | **Una sola copia** de las reglas de texto (S1 a S5) y de las claves de las líneas del carrito: `limpiar`, `paraMensaje`, `etiquetas`/`resumen`/`parentesis`, `claveLinea`/`leerClave` y `motivoNombreInvalido` (la validación del dueño). Lo cargan `index.html`, `pedido.html`, `panel.html`, `historial.html` y `menu-admin.html`. El servidor tiene **su propia copia** de las dos funciones que usa (`api/_notificar.js`: `textoOpcion`, `parentesisOpciones`; no carga archivos de la raíz porque un `require` roto tumbaría el webhook de pagos) y una prueba (`opciones-texto.test.js`, con 3.000 casos al azar) exige que las dos copias den **exactamente lo mismo**. |
| `index.html` | Modal con dos grupos (**"Quítale algo"** y **"Agrégale extras"**) y el botón *Agregar al carrito — $X* que se actualiza en vivo; carrito por **líneas** (producto + opciones); las opciones bajo cada línea; mensajes de WhatsApp con las opciones; aviso de **precio cambiado** (C2) y manejo del 400 de opciones (C3); la confirmación y el WhatsApp de copia llevan las opciones y el total del servidor (C4); y el arreglo del aviso de abierto ("p.m.."). |
| `ticket-comanda.js` | Bajo cada item: `SIN: queso, salsa rosa` y un `+ Tocineta extra` por línea, en negrita; el ticket de prueba trae un item con opciones. |
| `panel.html`, `historial.html`, `pedido.html` | Las opciones bajo cada item, **como texto** (nunca HTML). Un pedido antiguo sin opciones se ve idéntico. |
| `menu-admin.html` | Hoja **"Opciones de {producto}"**: lista, agregar (quitar/extra, nombre, precio solo para extras), editar nombre y precio, apagar/encender, subir/bajar, eliminar; tope de 12; validación **igual o más estricta que la base**; los rechazos de la base se muestran en español. |
| `api/_notificar.js` | El mensaje de CallMeBot lleva las opciones en la **misma línea** del item: `2x Big Norte (Sin queso, + Queso extra) — 62.000`. |
| `api/crear-pedido.js` | **H4:** los datos del cliente se recortan por **caracteres completos** (antes por unidades UTF-16: un emoji en el borde daba 500). Exporta `limpiar` solo para la prueba. |
| `sw.js` | **v14** (refresca la caché del panel instalado; el HTML y los scripts siguen yendo a la red). |

#### 22.18.2 Cómo lo ve el cliente

* **Producto con opciones** (las activas que trae `/api/menu`): el **"+"** de la tarjeta, o la tarjeta, **abre el modal**; no suma directo. En la tarjeta, una burbuja dice cuántas unidades de ese producto lleva el carrito (de una o varias líneas).
* **Modal.** Dos `<fieldset>` con su `<legend>` ("Quítale algo", gratis; "Agrégale extras", con `+$2.000`). Cada opción es una **casilla real** (`<input type=checkbox>` dentro de su `<label>`): se marca con el dedo, con el teclado (espacio) y la lee un lector de pantalla ("Queso extra más $2.000"). Cada fila mide **al menos 48 px**; el botón principal y la X, al menos 44 px; el foco del teclado se ve (aro de 3 px). El botón **"Agregar al carrito — $X"** muestra *base + extras marcados* (los "quitar" no suman). Se cierra con la X, con Escape y tocando fuera, y el foco vuelve al botón que lo abrió.
* **No pierde lo marcado por accidente.** Lo marcado de cada producto queda en **memoria** (`borradorOpciones`) al cerrar el modal con la X, Escape o tocando fuera: al volver a abrir **el mismo producto** sigue marcado. Se borra al agregar al carrito (y al recargar la página).
* **Producto sin opciones** (las bebidas): todo igual que antes (el "+" suma directo, su control de cantidad, su modal de siempre).
* El estilo es el de siempre: el modal es crema en los dos temas (claro `TEMA_CLARO` y oscuro); se probó en 360, 390, 768 y 1280 px con el contraste AA medido en el navegador.

#### 22.18.3 El carrito: la clave de las líneas (C1)

El carrito sigue siendo `{ clave: cantidad }`, pero la **clave** ahora es **producto + opciones**:

| Caso | Clave |
|---|---|
| producto sin opciones (y **cualquier carrito guardado por la versión anterior**) | `nb-big-norte` (el id, igual que siempre) |
| con opciones | `nb-big-norte|extra-queso,extra-tocineta,sin-queso` (los ids de opción **ordenados** y sin repetir) |

* Las **mismas opciones marcadas en otro orden dan la misma clave**: se juntan en una línea (cantidad + 1). **Otro conjunto de opciones es otra línea** (también "ninguna": un Big Norte con y otro sin opciones son dos líneas).
* En el navegador se guardan **solo ids**. Nombres y precios se leen del menú que está en memoria (`lineaDe(clave)`): el precio unitario *para mostrar* es `precio base + extras`, y el subtotal, `unitario × cantidad`.
* **Un carrito antiguo** (`{"big":2,"lil":1}`) se lee tal cual (sus claves ya son claves válidas). Las claves rotas (mayúsculas, espacios, `big|` vacía, más de 12 opciones) se **descartan** al cargar; un producto que ya no existe se retira con el aviso de siempre.
* **Una opción que ya no existe o está apagada.** Cuando llega un menú **fresco del servidor**, cada línea cuyas opciones ya no estén en el menú se **quita entera** con un aviso amable ("Quitamos de tu carrito: Big Norte… Agrégalo de nuevo con las opciones de hoy"). **No se le quita solo esa opción**: sería cambiarle el pedido en silencio (un "sin cebolla" que desaparece lo pagaría con cebolla, y eso es un asunto de alergias). Si el menú viene de la copia vieja del navegador no se toca nada (el servidor decide al pagar, ver C3).
* Al servidor viaja, por línea: `{ id, cantidad, precio: <precio BASE>, opciones: [ids] }`; la clave `opciones` **no se manda** si la línea no tiene (el pedido sin opciones es **idéntico** byte a byte al de antes). Nunca nombres ni precios de opciones.

#### 22.18.4 Precio que cambió (H5, C2) y opciones rechazadas (C3)

`/api/crear-pedido` crea el pedido (pendiente de pago) y responde `{ referencia, total, subtotal, firma, … }` **antes** de abrir Wompi. Qué se hace con eso:

1. **El navegador compara** `total` y `subtotal` del servidor con los del carrito (`subtotal` + el domicilio que mostraba). Si coinciden, abre Wompi como siempre.
2. Si **no coinciden** (típico: el dueño subió un extra y el menú del cliente tenía hasta 60 s de retraso) **no se abre Wompi en silencio**: sale un aviso (*"El precio subió / bajó"*) con el monto nuevo y **dos botones**:
   * **Pagar $X:** sigue con **ese mismo pedido** (su referencia y su firma): Wompi recibe el monto del servidor. **No se crea otro pedido.** Si el cliente aceptó un total distinto del que veía, la confirmación muestra el total del servidor y una línea **"Ajuste de precios $N"** para que los renglones cuadren con el total.
   * **Revisar mi pedido** (o Escape): se abre el carrito con un aviso fijo ("El total confirmado por el restaurante es $X…") y se vuelve a pedir el menú **una sola vez** para que el carrito muestre los precios al día. **No se recarga en bucle** (la copia del menú puede seguir vieja un minuto: el valor bueno es el que devolvió el servidor). Tocar **fuera** del aviso no lo cierra: hay que elegir.
3. **Lo que queda atrás en "Revisar":** el pedido ya creado se queda **sin pagar** (`pendiente_pago`: nunca llega al panel ni a la cocina; la limpieza lo borra a las 24 h, igual que cuando alguien cierra el widget de Wompi). Si el cliente vuelve a pagar se crea uno nuevo y **solo ese** se paga. Es el costo de no haber cambiado el servidor.
4. **C3 (opciones rechazadas).** Si una opción se apagó o se borró después de cargar el menú, el servidor responde **400** con el aviso genérico (no dice cuál, a propósito) y no deja pedido. El navegador muestra ese aviso, abre el carrito y vuelve a pedir el menú **una vez**; la revisión de 22.18.3 quita la línea que ya no se puede pedir. El 503 ("no pudimos confirmar las opciones") solo avisa para reintentar.

#### 22.18.5 Formatos de salida

| Dónde | Formato |
|---|---|
| Pantalla (carrito, confirmación, panel, historial, seguimiento) | `Sin queso · Sin salsa rosa · + Queso extra · + Tocineta extra` (lo que se quita, como lo escribió el dueño; los extras con `+ `), bajo el nombre del producto. |
| **WhatsApp del cliente** y de **copia del pedido pagado** (`index.html`) | Una línea por item: `- 2x Big Norte (Sin queso, + Queso extra) - $62.000`. Sin opciones sale **exactamente** como siempre. |
| **WhatsApp / CallMeBot del restaurante** (`api/_notificar.js`) | `2x Big Norte (Sin queso, + Queso extra) — 62.000`. Sin `$` (CallMeBot lo corrompe), sin `* _ ~` ni comilla invertida (formato de WhatsApp), una sola línea, **máximo 6 etiquetas** y luego `+N más`. |
| **Ticket impreso de 80 mm** (`ticket-comanda.js`) | Bajo el producto, en negrita: `SIN: queso, salsa rosa` (el "Sin " del nombre se quita) y **una línea `+ Tocineta extra` por cada extra**, con sangría francesa (si el nombre envuelve, la segunda línea queda bajo el texto). El nombre **no se corta a 40**: envuelve (tope de 60 caracteres completos y de 12 opciones). Sin emojis ni invisibles (la impresora los borra y un "Sin 🧅" saldría "Sin"). La hoja de estilos de las opciones **solo se agrega al ticket cuando algún producto trae opciones**: un ticket sin opciones sale **byte a byte igual** (`comparar-tickets`: 7 de 7). |
| Texto del ticket del panel (el que se copia) | Las opciones en su propia línea, indentada, bajo el producto. |

#### 22.18.6 `menu-admin`: administrar las opciones

En la edición rápida de cada producto (y en el formulario completo) hay un botón **"Opciones: quitar y extras…"** que abre la hoja del producto. **Mismo camino que los productos:** la sesión del dueño y las reglas de la base (RLS); **nunca la llave de servicio**; cada lectura, alta, cambio y borrado lleva `restaurante_id` y `producto_id`; "Guardado" solo aparece cuando la base devolvió la fila. Quien hoy no puede editar productos (el cajero) ve **"Tu usuario no tiene permiso para hacer este cambio."** y no se escribe nada.

* **Agregar:** tipo (*Quitar algo (gratis)* / *Extra con precio*), nombre y, solo para extras, el precio. El id sale del nombre (`sin-queso`); el orden, al final de su grupo (los quitar de 0 a 9, los extras desde 10, como la semilla).
* **Editar:** nombre y precio (el tipo y el id **no** se cambian: para eso se elimina y se crea otra). **Apagar/encender** (interruptor): una opción apagada no se ofrece ni se acepta. **Subir/bajar** dentro de su grupo (se reasignan los números de orden). **Eliminar** (pregunta antes; los pedidos ya hechos no se tocan).
* **Reglas del formulario (iguales o más estrictas que la base):** nombre de 1 a 40 caracteres **completos**; sin `<` ni `>`; sin caracteres de control, invisibles ni de dirección (bidi); **sin emojis ni símbolos** (©, ®, flechas, dingbats…) porque la impresora de la cocina no los imprime y la opción saldría mal en el papel; sin repetir un nombre del mismo producto; un "quitar" vale siempre $0; un extra va de **$1 a $50.000** (la base acepta también $0; aquí es más estricto), en **números enteros** (se aceptan `2500`, `2.500` y `$2.500`; `2,5` o `2.5` se rechazan en vez de convertirse en silencio en $25); máximo 12 por producto (cuentan las apagadas).
* **Los rechazos de la base** (`23514`, con el texto en español que ya escribe el SQL 18: *"El nombre de la opción tiene caracteres no permitidos"*, *"Un producto no puede tener más de 12 opciones"*…) se muestran tal cual; un `42501` dice *"Tu usuario no tiene permiso…"*; un CHECK suelto, con palabras simples.
* **Seguridad (S1):** todo texto que viene de la base se pinta con `textContent` (la lista) o como atributo escapado (`aria-label`); nunca con `innerHTML`.

#### 22.18.7 Los dos arreglos pequeños

* **Aviso de abierto con dos puntos ("p.m..").** La hora de cierre termina en punto (`10:00 p.m.`) y la plantilla suele poner otro justo después de `{cierre}`. En `renderStatusBanner` (`index.html`): si el cierre ya termina en punto, se quita el que viene pegado; si no (`12:00 a.m. (medianoche)`), el punto de la plantilla se queda. Solo toca ese punto; no se tocó la base ni la lógica del horario. Prueba: escenario 11 de `front.mjs` (con cierre `11:59 p.m.` y con `24:00`).
* **H4** (`api/crear-pedido.js`, `limpiar`): recorte por caracteres (`Array.from`), igual que `api/_precios.js`. Prueba: `crear-pedido-limpiar.test.js` (falla con el recorte anterior —un `slice(0, n)` deja media pareja suelta—, pasa con el de ahora; además se rompe a propósito en la revisión por mutación).

#### 22.18.8 Cumplimiento de las reglas de salida (S1 a S8) y de carrito (C1 a C4)

| Regla | Dónde se cumple | Prueba que lo demuestra |
|---|---|---|
| **S1** texto, nunca HTML | `index.html` (modal y carrito con `textContent`, confirmación con `esc`), `pedido.html`/`panel.html`/`historial.html` (`escapar`), `menu-admin.html` (`textContent`, atributos), `ticket-comanda.js` (`textContent`), `opciones-texto.js` (solo devuelve texto) | front 11 (opción con `<img onerror>` en el menú, el carrito, la confirmación y el seguimiento); panel 16c–16e, 16j (tablero e historial con la copia hostil de un pedido) y 17x–17y (menu-admin); e2e 22 (el ticket escapa el HTML); mutaciones de `innerHTML` / sin `esc` |
| **S2** una línea | `OpcionesTexto.limpiar` (CR, LF, U+2028/2029 → espacio); `textoOpcion` (servidor); `limpiarTexto` (ticket) | `opciones-texto.test.js`; panel 16c (un salto de línea no fabrica una línea "9x Falso — 90.000"); `notificar`: un solo renglón con forma de producto |
| **S3** quitar invisibles | `INVISIBLES` (opciones-texto.js y copia del servidor); `SIMBOLOS` del ticket ahora quita también U+2066-2069, U+2065-206F, U+061C, U+00AD, rellenos U+115F/1160/3164/FFA0, U+180E, U+FFF9-FFFB y etiquetas U+E0000-E007F | `opciones-texto.test.js` (uno por uno); `ticket-comanda.test.js`; e2e 22 y los fixtures `09-...` |
| **S4** largo por caracteres | `Array.from(...).slice(...)` en `limpiar`, `textoOpcion`, `recortarCaracteres` (ticket) y `limpiar` de `crear-pedido.js` (H4); el ticket **envuelve** en vez de cortar | las mismas + `crear-pedido-limpiar.test.js` |
| **S5** WhatsApp / CallMeBot | `paraMensaje` y `parentesis` (sin `$ * _ ~` ni comilla invertida, máximo 6 etiquetas + `+N más`); la URL se arma solo con `encodeURIComponent` (ya era así) | `opciones-texto.test.js` (incluida la **paridad** servidor/navegador con 3.000 casos); front 11 (WhatsApp con `Salsa *$especial* _x_`) |
| **S6** menu-admin rechaza lo que el ticket imprime mal | `OpcionesTexto.motivoNombreInvalido` (emojis y símbolos, `<>`, invisibles, 40, vacío, espacio duro) + repetidos + rango y enteros del precio | panel 17o (11 rechazos), 17p (cero escrituras), 17q–17r; `opciones-texto.test.js` |
| **S7** los "quitar" se imprimen distinto | ticket: `SIN: …` (una línea, negrita) vs. `+ …` (una por extra, negrita, sangría) | `ticket-comanda.test.js`; e2e 22; `comparar-tickets` (fixtures 08–10 contra el HTML esperado) |
| **S8** los precios salen del servidor | el navegador solo **muestra** precios del menú y manda ids; el ticket, el panel, el historial y los mensajes usan la copia guardada (`precio` final); **no se tocó el cálculo** | front 11 (los totales); `servidor.mjs` (262, sin cambios); `probar-opciones` |
| **C1** la línea es producto + opciones | `claveLinea` / `leerClave` y `lineaDe`; el servidor recibe el precio **base** | `opciones-texto.test.js`; front 11 (juntar, separar, otro orden, carrito antiguo) |
| **C2** comparar el total (H5) | `iniciarPagoWompi` + `preguntarPrecioCambiado` | front 11 (aviso con $28.500, dos botones, no abre Wompi, Escape = revisar, no crea otro pedido, tocar fuera no decide) |
| **C3** el 400 de opciones | rama `400/503` de `iniciarPagoWompi` + `revisarOpcionesDelCarrito` | front 11 (opción apagada: aviso genérico, se lleva al carrito, la línea se quita, no queda pedido) |
| **C4** lo guardado lleva opciones y el total del servidor | `pedido` guardado en `PENDING_ORDER_KEY` (con `opciones` y `ajuste`) | front 11 (confirmación y WhatsApp de copia) |

#### 22.18.9 Pruebas (números) y revisión por mutación

| Batería | Línea base (22.17) | Ahora | Por qué cambia |
|---|---|---|---|
| unitarias (`node --test pruebas/*.test.js`) | 121 | **155** | +17 `opciones-texto.test.js` (nuevo: reglas de texto, claves de línea, validación del dueño, **paridad** servidor/navegador con 3.000 casos y el mensaje de CallMeBot), +5 `crear-pedido-limpiar.test.js` (nuevo: H4), +12 en `ticket-comanda.test.js` (SIN/extras, emojis e invisibles, tope de 12 y de 60 caracteres, hoja de estilos solo con opciones, `pintar` con un documento falso y el ticket de prueba) |
| `servidor.mjs` (también `--via=despachador` y `--via=reescrita`) | 262 | 262 | igual (con `SQL18_NO=1`: 208, igual). **No se tocó el servidor de cobro.** |
| `front.mjs` | 139 | **208** | +69: escenario 11 (modal y precio en vivo, accesibilidad, borrador, juntar y separar líneas, carrito antiguo, opción apagada, mensajes de WhatsApp, precio cambiado C2, 400 de opciones C3, nombres hostiles, seguimiento, aviso "p.m.." y 360/390/768/1280 px en claro y oscuro). Ajustado **a propósito**: `<script>` permitidos 6 → 7; los 4 bloques ocultos nuevos se excusan en la comparación de Taqueiros; sw v14 |
| `panel.mjs` | 360 | **413** | +53: escenario 16 (tablero, texto del ticket e historial con items nuevos, viejos y hostiles) y 17 (menu-admin: alta, edición, apagar, ordenar, eliminar, tope de 12, validaciones, rechazos de la base, escape de HTML, aislamiento entre restaurantes y cajero). Ajustado **a propósito**: el botón nuevo "Opciones: quitar y extras" se excusa en la comparación de Taqueiros; sw v14 |
| `e2e` de impresión (`pruebas/impresion/e2e.js`) | 180 | **193** | +13: escenario 22 (ticket con opciones: SIN y extras, sin emojis ni invisibles, ticket largo, medido a 80 mm) |
| `comparar-tickets.mjs` | 7 de 7 | **7 de 7** + 3 nuevos | los 7 tickets de siempre salen **idénticos** (el ticket de prueba solo difiere en el item con opciones que se le agregó a propósito, y eso se resta exacto); los 3 tickets nuevos (con opciones, sin emojis, largo) se comparan con el HTML esperado guardado en `pruebas/impresion/esperado/` |
| `vista-previa.mjs` | 57 | 57 | la prueba 2d ahora compara el **diff exacto** de `index.html`/`pedido.html` contra el guardado en `pruebas/multirestaurante/esperado/` (antes copiaba los cambios; con tantos, es más fiel) |
| `opciones.mjs` | 77 | 77 | E1, E2 y F1 ajustadas **a propósito**: las pendientes "parte B" de 22.8 ya están hechas (el carrito suma con el precio unitario con extras; el ticket imprime las opciones) |
| `tema-claro.mjs`, `rebrand-northe.mjs` | 43 / 78 | 43 / 78 | solo la comprobación de la versión de `sw.js` (v13 → v14) |
| sin cambio | | | superadmin 50, sql16 48, crear-superadmin-test 13, agrupacion 32, rls 237, endurecer 426, migrar-fotos 126, datos-restaurante 76, config-publica 52, dominios 35, hallazgos 32, planes 11, sim 34 OK, cargar-secretos-test 25, inspeccion 6, textos-visibles 10; contra el falso: probar-compatibilidad 26, probar-servidor-multirestaurante 249, probar-opciones 38, probar-superadmin 50, probar-aislamiento 252 de 259 (las 7 de Realtime fallan localmente con el falso, por diseño) |

**Revisión por mutación** (`node pruebas/multirestaurante/mutaciones-opciones-ui.mjs`, 3 en paralelo; `--validar=1` solo comprueba que cada mutación esté bien escrita): **116 mutaciones** (59 sobre las funciones puras `opciones-texto.js`, `api/_notificar.js`, `api/crear-pedido.js` y `ticket-comanda.js`; 37 sobre `index.html` y `pedido.html` con el navegador; 20 sobre `panel.html`, `historial.html` y `menu-admin.html`). Rompe a propósito: el total del carrito sin extras, el precio del botón del modal, el borrador, juntar líneas, lo que se manda al servidor (sin ids, con objetos, con otro precio), la comparación del total (C2: no compara, "Revisar" que paga, Escape, monto viejo, aviso tapado por el formulario), el 400 de opciones (C3), la retirada de líneas con opciones apagadas, el carrito antiguo, los dos WhatsApp, el arreglo de "p.m..", cada `textContent`→`innerHTML`/sin `escapar`, cada regla de `limpiar`/`paraMensaje`/`motivoNombreInvalido`, cada rango de invisibles, el corte por unidades UTF-16 (modal, servidor, ticket y H4), la hoja de estilos del ticket, cada validación y cada filtro por restaurante de `menu-admin`. **Resultado: 112 detectadas, 4 equivalentes (cada una con su razón), 0 sobrevivientes.**
La primera pasada dejó **7 sobrevivientes**, que se arreglaron y se volvieron a correr (las 4 siguen siendo equivalentes por su razón): (1) el corte por unidades UTF-16 del nombre en el servidor y en el ticket (faltaban pruebas con un emoji —o una letra de otro plano— justo en el borde); (2) la hoja de estilos del ticket "siempre/nunca" (faltaba probar `pintar` sin navegador); (3) el botón **"Revisar mi pedido"** nunca se pulsaba en las pruebas (solo Escape); (4) una comprobación del nombre vacío que hoy no se alcanza (equivalente: otra la frena antes); (5) las claves rotas del carrito (equivalente: `purgarCarritoHuerfano` las retira con su aviso).
**Equivalentes:** (a) `index.html`, filtro de nombres vacíos del menú (las opciones apagadas ni llegan en `/api/menu`); (b) C2 comparando solo el subtotal (el total es subtotal + domicilio y el domicilio lo calcula el servidor con la misma regla); (c) `opciones-texto.js`, el chequeo `limpiar(t) === ""` del nombre del dueño (un nombre solo de espacios o solo de invisibles ya lo frena otro chequeo); (d) claves rotas del carrito (las retira `purgarCarritoHuerfano`).

**Lo que las capturas encontraron.** Una captura del aviso de precio cambiado mostró que quedaba **tapado por el formulario de entrega** (mismo `z-index` y el formulario va después en el HTML): ninguna prueba lo veía porque solo miraba la clase `open`. Se le dio `z-index:600` y se agregó una prueba que mide con `elementFromPoint` qué hay bajo el botón "Pagar" (y una mutación que la rompe).

#### 22.18.10 Decisiones donde el encargo no lo definía, y riesgos conocidos

* **El pedido que queda sin pagar en "Revisar mi pedido"** (22.18.4): se dejó así para **no cambiar el servidor**; un pedido `pendiente_pago` nunca llega al panel ni a la cocina y se limpia a las 24 h. Si algún día molesta, la salida es un endpoint que cancele el pendiente (cambio de servidor, aparte).
* **Una opción apagada quita la línea entera** (no solo la opción): por alergias (22.18.3).
* **Borrador del modal solo en memoria** (no en `localStorage`): sobrevive a un cierre accidental, no a recargar. Menos estado guardado, menos casos raros.
* **`opciones-texto.js` es un archivo nuevo que cargan 5 páginas** (`?v=1`): si un navegador se quedara con una página vieja en caché, esa página no tendría `window.OpcionesTexto` y fallaría. Las páginas van siempre por la red y `sw.js` (v14) no guarda scripts, así que no pasa; si se cambia el archivo, subir el `?v=`.
* **Copia del servidor** de las reglas de texto: dos copias pueden separarse; la prueba de paridad lo vigila.
* **Los extras con $0** no se pueden crear desde `menu-admin` (aunque la base los acepta): es más estricto a propósito (un extra gratis es un "quitar" al revés).
* **Las capturas** (`Recursos/NORTHE-NUEVO/capturas/opciones-*.png`, carpeta ignorada por git) se generan con `CAPTURAS=<carpeta>` en `front.mjs` y `panel.mjs`.
* **Pendientes que siguen** (22.17): H2 (la lista de invisibles de la **base**: la interfaz ya los rechaza y los quita al mostrar, pero la base aún los acepta si alguien escribe por REST), H5 resuelto aquí (C2), R5 (dueño/cajero pueden insertar pedidos por REST), H9 (`wompi_modo` de Taqueiros antes de cobrar en real).

#### 22.18.11 Qué correr (Windows) tras el despliegue

1. Ver el sitio en el celular y en el computador (Ctrl+F5): abrir Big Norte → debe salir el modal con "Quítale algo" y "Agrégale extras".
2. Pedido de prueba **con opciones** (con el restaurante abierto) y Wompi sandbox: debe llegar al panel con las opciones bajo el producto.
3. Imprimir el ticket real en la DIG-POS892: revisar que **"SIN:"** y **"+"** salgan claros y que el pie no se corte.
4. Vista previa de WhatsApp: pegar `…/?v=3` en un chat.
5. Con la llave cargada (Read-Host): `probar-compatibilidad` (26), `probar-servidor-multirestaurante` (249; también con `$env:VIA = "despachador"`), `probar-opciones` (38) y `probar-aislamiento` (259; si solo fallan las de Realtime con "sin control positivo", repetir una vez). Quitar la llave: `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.

---

## 23. Verificación en dos pasos (MFA) obligatoria para el superadmin y lecturas de «entrar como» (SQL 19) — paso 3B, parte 1 de 2

Hasta la sección 19 el servidor del superadmin dejaba entrar a cualquiera cuyo id estuviera en `public.superadmins` y tuviera una sesión válida. Un superadmin ve y administra **todos** los restaurantes: si alguien roba o adivina su contraseña, lo tiene todo. Esta parte hace dos cosas, **solo en el servidor y la base** (la pantalla `superadmin.html` es la parte 2, después de una revisión de seguridad independiente):

1. **MFA obligatoria**: todas las acciones de `api/superadmin.js` exigen que la sesión se haya verificado con un segundo factor TOTP (nivel de garantía **aal2**).
2. **Lecturas de solo lectura para «entrar como»**: el superadmin puede *mirar* un restaurante (pedidos, menú, configuración, resumen) **sin suplantar a nadie** y sin escribir nada.

**El SQL 19 (`supabase/19-superadmin-lectura.sql`) está escrito y probado en el Supabase falso, pero NO se aplicó a la base real**: lo aplicas tú (23.6). El servidor nuevo funciona igual **antes** de aplicarlo (las lecturas avisan que falta el SQL 19; todo lo demás responde como siempre).

### 23.1 Qué cambió

| Pieza | Cambio |
|---|---|
| `api/_sesion.js` | Nuevas `sesionDeToken` / `sesionDeSolicitud` / `nivelDeGarantia`: además del id, dicen el **aal** (`aal1` o `aal2`). `usuarioDeToken` / `usuarioDeSolicitud` siguen devolviendo `{ id }` (reembolso no cambia). |
| `api/superadmin.js` | Exige aal2 en todo menos `mi_estado`; 5 acciones nuevas (`mi_estado`, `ver_pedidos`, `ver_menu`, `ver_config`, `ver_resumen`: **22 en total**); constancia acotada de los rechazos por falta de MFA. Sigue siendo **una sola función de Vercel (la 7.ª de 12)**; sin dependencias nuevas. |
| `supabase/19-superadmin-lectura.sql` y `19-revertir.sql` (nuevos, **sin aplicar**) | 5 funciones `sa_*` (`sa_ver_pedidos`, `sa_ver_menu`, `sa_ver_config`, `sa_ver_resumen`, `sa_registrar_rechazo_mfa`) y 1 ayuda interna (`auditar_lectura_superadmin`). Atómico, idempotente, marcadores `-- >>> PASO`, **14 comprobaciones OK/FALLA** (reversa: 5). Necesita el SQL 16; **no** necesita el 16b; el 18 es opcional. |
| `supabase/16-superadmin.sql` (una comprobación) | «Hay 15 funciones `sa_*`» ya no cuenta las 5 del 19. Sin esto, **volver a correr el 16 con el 19 puesto se habría revertido**. No cambia nada del SQL ya aplicado. |
| `supabase/quitar-mfa.mjs` (nuevo) | Herramienta de **operador** para borrar los factores MFA de un usuario si pierde el celular (23.7). |
| `supabase/probar-superadmin.mjs` (ahora con MFA real) y `probar-superadmin-mfa.mjs` (nuevo) | Pruebas contra la base real: enrolan un TOTP **de verdad** por las rutas de Auth y calculan el código con `node:crypto` (23.9). |
| Pruebas | `pruebas/mfa.test.js` (TOTP contra los vectores del RFC 6238 y lectura del aal), `sql19.mjs`, `mutaciones-mfa.mjs`; el Supabase falso ahora emula `aal1`/`aal2` y `/auth/v1/factors`. |

### 23.2 Cómo se lee el aal — la decisión

**El problema.** `GET /auth/v1/user` (lo que hacía `api/_sesion.js`) devuelve *el usuario*, no *la sesión*: **no dice el aal**. Según la documentación de Supabase, el nivel vive en los claims del JWT de acceso: `aal` (`aal1` o `aal2`; «los JWT sin claim `aal` están en `aal1`») y `amr` (lista de `{ method, timestamp }`, p. ej. `totp`, `password`).

**Lo que se hace** (en este orden, y no en otro):

1. Supabase Auth valida **ese mismo token** (firma, caducidad, sesión viva) con la llamada de siempre. Si no lo valida → `null` → **401**. Un JWT con la carga cambiada, sin firma, con `alg: none` o con el `aal` maquillado **falla aquí**, porque su firma ya no coincide.
2. **Solo entonces** se lee la carga (base64url) de ese token ya aceptado. No hace falta volver a verificar la firma: es byte por byte el token que Auth acaba de aceptar. El aal **nunca** sale de un cuerpo, cabecera o parámetro que mande el cliente, ni de un token que Auth no haya aceptado.
3. Defensa en profundidad: es **aal2** solo si (a) el `sub` de la carga es el mismo id que devolvió Auth, (b) `aal` es exactamente `"aal2"` y (c) `amr` es una lista con un método TOTP. **Cualquier otra cosa es aal1** (carga ilegible, claim ausente, tipo raro, `amr` solo con contraseña…): se falla hacia lo estricto. Nunca lanza una excepción.

**Alternativas descartadas.**

| Alternativa | Por qué no |
|---|---|
| Verificar el JWT localmente con las claves públicas del proyecto (JWKS) | Habría que traer y cachear claves, soportar su rotación y el algoritmo (ES256/RS256) con `node:crypto`: más código de seguridad propio, y se pierde lo que Auth sí comprueba (que la sesión siga viva y no esté cerrada). El `GET /user` ya hace todo eso. |
| Llamar a un endpoint de Auth que diga el nivel | No existe uno que no pase por la sesión del propio usuario; el JWT es la fuente documentada. |
| Aceptar el `aal` de un campo del cuerpo o de una cabecera | Lo controla el cliente: sería una escotilla. Hay pruebas que mandan `aal: "aal2"` en cabecera y cuerpo y comprueban que no cambia nada. |

**Límites conocidos.** (1) ~~Supabase documenta que al borrar un factor verificado cierra todas las sesiones~~ **INCORRECTO en la práctica** (revisión adversaria, 23.13 R1): el código de Supabase Auth **no** cierra las sesiones al borrar un factor, solo las baja a aal1 para el próximo refresco, y el token aal2 ya emitido sigue siendo aceptado por `GET /user` hasta que caduca. **Corregido:** además de los claims, el servidor exige que el usuario **todavía** tenga un factor TOTP verificado (paso 4 de `api/_sesion.js`). (2) Si Supabase cambiara el nombre del método en `amr` (hoy `totp`; se acepta también `mfa/totp`), el superadmin quedaría **bloqueado** (falla hacia lo estricto), no abierto: la prueba real (23.9) lo detectaría al instante.

### 23.3 Qué responde el servidor (el orden no cambia)

| Situación | Respuesta | Cuenta como intento fallido (429 a los 10) |
|---|---|---|
| Sin sesión, token inválido, vencido o manipulado | **401** `{ error: "Inicia sesión para continuar" }` | sí |
| Sesión válida, **no es superadmin** (dueño, cajero, cocina, sin membresía; con aal1 **o** aal2) | **403** `{ error: "No autorizado" }` — **idéntico** con aal1 y con aal2 (mismo cuerpo, mismas cabeceras, mismas peticiones a Supabase); el aal ni se mira | sí |
| **Superadmin con aal1** (sin MFA), cualquier acción salvo `mi_estado`, aunque el cuerpo esté roto o la acción no exista | **403** `{ error: "Activa o confirma la verificación en dos pasos", codigo: "mfa_requerida", aal: "aal1" }` | **no** (ya entró con contraseña: no se bloquea a sí mismo) |
| **Superadmin con aal2** | la acción (con sus 400/404/409 de siempre) | — |
| `mi_estado` de un superadmin (aal1 o aal2) | **200** `{ ok: true, es_superadmin: true, aal: "aal1"\|"aal2", mfa_requerida: true }` | — |
| `mi_estado` de quien no es superadmin | el mismo **403 genérico** de arriba (no se filtra quién es superadmin) | sí |
| Método distinto de POST | 405 | — |

Un superadmin sin MFA **no aprende nada**: ni siquiera si la acción existe o si el cuerpo es válido (siempre el mismo 403). Los 17 códigos y mensajes de antes no cambian con aal2.

**Sin escotillas.** No hay variable de entorno, parámetro ni cabecera que apague la MFA. **No se exige MFA** al dueño, cajero ni cocina (siguen entrando con contraseña a su panel), ni a ningún otro endpoint (webhook, cron, `crear-pedido`, `generar-firma`, `reembolso`, panel): hay pruebas para cada uno. *Cambiado en la revisión adversaria (23.13 R2):* `reembolso` ya **no** acepta a un superadmin sin MFA: el camino del superadmin exige aal2 (el del dueño no cambia y sigue sin MFA).

### 23.4 Las 22 acciones de `api/superadmin.js`

| Acción | aal1 | aal2 |
|---|---|---|
| `mi_estado` | 200 (estado) | 200 (estado) |
| `yo`, `listar_restaurantes`, `detalle_restaurante`, `crear_restaurante`, `actualizar_restaurante`, `registrar_pago`, `editar_config`, `guardar_tarifas`, `agregar_dominio`, `quitar_dominio`, `buscar_usuario`, `crear_usuario`, `asignar_miembro`, `quitar_miembro`, `guardar_secretos`, `estado_secretos`, `listar_auditoria` (las 17 de la sección 19) | 403 `mfa_requerida` | como antes |
| `ver_pedidos`, `ver_menu`, `ver_config`, `ver_resumen` (nuevas, **necesitan el SQL 19**) | 403 `mfa_requerida` | 200, o 503 «falta aplicar el SQL 19» si aún no está |

### 23.5 Las lecturas de «entrar como»

Todas reciben `restaurante_id` (UUID; en mayúsculas se acepta y se pasa a minúsculas). **Rechazos sin filtrar nada:** id ausente, `null`, vacío, texto, número, booleano, lista, objeto, con espacios, con inyección o sin guiones → **400** con un mensaje fijo (el servidor ni llama a la base); un UUID bien formado que no existe → **404** «No existe ese restaurante». Campos de más → 400.

| Acción | Parámetros | Devuelve |
|---|---|---|
| `ver_pedidos` | `modo` `"jornada"` (por defecto: la jornada actual con el corte del restaurante, como el panel) o `"recientes"`; `limite` 1–**100** (50 por defecto); `antes_de` (id) | `{ modo, jornada: {fecha, inicio, fin, hora_corte}\|null, pedidos: [...], devueltos, hay_mas, siguiente }`. Pagina así: pide la siguiente con `antes_de = siguiente`. Cada pedido: 26 campos (id, número, referencia, estado, pago, tipo, **cliente: nombre, teléfono, correo, dirección, barrio, indicaciones**, **items con sus opciones**, subtotal, domicilio, total, distancia, método de pago, fechas, reembolso, impresión). **NO** trae el token de seguimiento ni las coordenadas. |
| `ver_menu` | — | `{ menu: { categorias, productos, opciones, totales, truncado } }` con **todo, también lo inactivo / agotado / apagado**. Topes: 200 categorías, 1000 productos, 5000 opciones (`truncado: true` si se cortó alguna). Sin el SQL 18, `opciones` sale vacío. |
| `ver_config` | — | `{ restaurante: {...} }`: lo de `detalle_restaurante` (config pública, vigencia, dominios, **miembros con rol y correo**, tarifas, **secretos como sí/no**) más `horario` (horarios, cerrado temporal, mensaje, corte, minutos de ocultar). |
| `ver_resumen` | — | `{ resumen: { restaurante, jornada, mes, catalogo } }`: pedidos, vendidos (pago aprobado y no cancelado, la misma definición del panel), ventas, ticket promedio, cancelados, por estado y por tipo; el mes se corta **en la zona horaria del restaurante**; conteos del catálogo. |

**Nunca** devuelven secretos (llaves de Wompi, API key de CallMeBot…) ni tokens: las funciones ni siquiera nombran la tabla de secretos. **Nunca escriben** en tablas de negocio: lo único que escriben es una fila de auditoría.

### 23.6 El SQL 19 — qué correr y qué debes ver

1. **Respaldo** (opcional pero recomendado): `node supabase/exportar-respaldo.mjs`.
2. Supabase → **SQL Editor → New query** → pega el contenido de `supabase/19-superadmin-lectura.sql` → **«Run without RLS»**.
3. Debes ver **14 filas, todas `OK`** (la última dice cuántas funciones `sa_*` hay: 20, y cuántos superadmins). Si alguna dice `FALLA`, o el editor muestra `LA MIGRACION 19 SE REVIRTIO`, no quedó nada cambiado: pega el mensaje.
4. **Reversa** (solo si algo se rompe): `supabase/19-revertir.sql` → **5 filas `OK`**. Borra las 6 funciones y deja intactas las 15 del SQL 16 y **toda** la auditoría. Si algún día también reviertes el 16, hazlo después.

Funciones y reglas (todas `SECURITY DEFINER`, `search_path` vacío, **sin `EXECUTE` para `anon`, `authenticated` ni `PUBLIC`**; solo `service_role`):

- Lo **primero** que hacen es `exigir_superadmin(p_actor)` (42501 si no está en `superadmins`); después validan el restaurante (P0002) y los parámetros (22023).
- Sin SQL dinámico; sin `insert`/`update`/`delete`/`truncate`/`merge`/`copy`/`execute` (la comprobación final lee el código fuente de cada función para comprobarlo); la ayuda interna `auditar_lectura_superadmin` no la ejecuta nadie, ni el servidor.
- Orden de aplicación: **después del 16** (y del 18 si lo usas); independiente del 16b.

### 23.7 Auditoría de las lecturas y de los rechazos

**Lecturas.** Cada lectura deja una fila (quién, cuándo, restaurante, acción, `actor_email`, `restaurante_slug`) con un resumen de **solo conteos y parámetros** (`modo`, `limite`, `pagina_inicial`, `devueltos`, `productos`…): jamás nombres, teléfonos, correos de clientes, direcciones, secretos ni tokens (hay pruebas que siembran esos datos y buscan sus huellas en la auditoría).

*Regla contra la inundación:* se registra la **primera** lectura de cada combinación *(superadmin, acción, restaurante, modo)* y **no** las repetidas dentro de **10 minutos** (paginar, refrescar). *Por qué:* paginar 5000 pedidos serían 100 filas sin información nueva; lo que importa es quién miró qué restaurante y cuándo. *Costo asumido:* un superadmin comprometido podría paginar todo el historial de un restaurante en una ventana con una sola constancia. Está acotado por la MFA, por el tope de 100 por página, y porque cada ventana nueva o cada otro restaurante deja su fila; el `devueltos` de esa primera fila no cuenta las páginas siguientes. *(Para revisar con Opus: si se prefiere contar páginas, habría que guardar un contador en otra tabla, porque la de auditoría es de solo agregar.)* Si la auditoría falla, la lectura **no se entrega** (misma transacción).

**Rechazos por falta de MFA.** Un superadmin **real** rechazado por no tener MFA deja **una** fila `rechazo_mfa` por superadmin cada **15 minutos** (la base lo decide, así que vale aunque haya varias instancias de Vercel; el servidor además evita llamarla de más). Guarda solo el nivel (`aal1`), el *nombre* de la acción pedida **si es una acción conocida** (si no, `null`) y la ventana. Los rechazos de quien **no** es superadmin no se registran aquí (siguen contando para el límite de IP y quedan en el log de Vercel sin datos). *Por qué así y no "uno por intento":* una pantalla que reintente llenaría la auditoría de ruido; una por ventana alcanza para ver que *alguien con la contraseña de un superadmin está llamando sin MFA*, que es lo único que interesa. Si el SQL 19 falta, la constancia se omite (solo queda una línea en el log) y la respuesta 403 no cambia.

### 23.8 Si Carlos pierde el celular

No hay botón, variable ni parámetro que apague la MFA en el servidor (a propósito). La salida es **borrar los factores de ese usuario** en Supabase Auth; entonces entra solo con su contraseña (aal1) y puede enrolar uno nuevo.

**Lo que está confirmado en la documentación de Supabase:** la API de administración `auth.admin.mfa.deleteFactor` (borra un factor de un usuario) — <https://supabase.com/docs/reference/javascript/auth-admin-mfa-deletefactor>. *(Esa página dice además que «cierra todas sus sesiones» si el factor estaba verificado; el código de Supabase Auth no lo hace: ver 23.13 R1.)* Un usuario solo puede quitar su propio factor (`mfa.unenroll`) si ya está en aal2, es decir, justo lo que perdió.

**Lo que NO pude confirmar:** que el Dashboard (Authentication → Users → el usuario) tenga un botón para quitar factores MFA de un usuario; no lo encontré en la documentación oficial, así que **no lo cites como pasos**. (Ojo: lo que sí circula en foros de Supabase sobre «quitar el MFA» es la MFA de la *cuenta del Dashboard de Supabase*, otra cosa distinta: ahí solo ayuda el soporte de Supabase.)

**Pasos (herramienta propia, usa la API documentada):**

1. Abre PowerShell en la carpeta del proyecto y carga la llave: `$k = Read-Host "Llave SECRETA" -AsSecureString` y luego `$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password`.
2. `node supabase/quitar-mfa.mjs tu-correo@dominio.com` — **solo muestra** los factores (tipo, estado, un trozo del id). Debes ver al menos uno.
3. `node supabase/quitar-mfa.mjs tu-correo@dominio.com --confirmar` — los borra.
4. `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`.
5. Inicia sesión solo con la contraseña y vuelve a activar la verificación en dos pasos en cuanto la pantalla del superadmin exista (parte 2).

*Requisito de seguridad:* quien tiene la llave de servicio ya puede hacerlo todo, por eso esto es una herramienta de operador y **no** una acción de la API.

### 23.9 Ajustes manuales de Auth en Supabase (para Carlos; no se tocó la configuración)

Esto **no es código**. Los nombres de pantalla son los de la documentación oficial; donde no pude confirmar un nombre exacto, lo digo.

1. **Límites de intentos.** Dashboard → **Authentication → Rate Limits** (confirmado en la documentación). Defaults: inicio de sesión/token **150 por 5 min por IP**; registro/otros **30 por 5 min por IP**; **verificar o desafiar MFA: 15 por minuto por IP y NO se puede cambiar**. Revisa que no estén en valores enormes. *(La documentación no dice qué límites cambian entre plan gratuito y Pro; no lo pude confirmar.)*
2. **Cerrar el registro público.** El ajuste se llama **«Allow new users to sign up»**; la documentación lo lista entre las opciones generales de la sección Auth del Dashboard, pero **no da el nombre exacto de la pantalla** (puede estar en *Authentication → Sign In / Providers* o en una pestaña de ajustes generales de Authentication; recórrelas y busca ese nombre — no te lo puedo asegurar). Apágalo: los restaurantes los das de alta tú (el superadmin crea los usuarios con `crear_usuario`, que usa la API de administración y **no** necesita el registro público). Verifica que `crear_usuario` sigue funcionando después de apagarlo (debería).
3. **Contraseña mínima.** La documentación dice que el largo mínimo y los tipos de caracteres se configuran en los ajustes de Auth del proyecto, en el proveedor **Email** (Authentication → Sign In / Providers → Email); no da un nombre de campo más preciso. Recomendado: **mínimo 12 caracteres** y exigir letras y dígitos. Las contraseñas temporales que genera el servidor (20 caracteres, 4 clases) cumplen cualquier regla razonable.
4. **Confirmación de correo.** **«Confirm email»**, en el proveedor Email (Authentication → Sign In / Providers → Email). Déjala encendida: `crear_usuario` crea los usuarios ya confirmados por la API de administración, así que no estorba.
5. **MFA con TOTP habilitado.** La documentación apunta a la sección **Multi-Factor** de Authentication (`/auth/mfa`) y dice que ahí se controla el acceso a las APIs de enrolar, desafiar y verificar; **no dice cuál es el interruptor ni su nombre exacto**. Comprueba que TOTP esté habilitado para enrolar y verificar (por defecto lo está); si no, ni el superadmin podrá activar su MFA y las pruebas reales (`probar-superadmin*.mjs`) fallarán al enrolar.
6. **Plan gratuito frente a Pro** (lo confirmado): «protección contra contraseñas filtradas» (*leaked password protection*) es **solo Pro o superior**; el TOTP no tiene costo extra en la documentación consultada (la MFA por teléfono sí aparece como complemento aparte; **no la usamos**). Todo lo demás de esta lista existe en el plan gratuito según lo que pude ver, **salvo lo que arriba marqué como no confirmado**.

### 23.10 Pruebas

**Locales (Supabase falso con `aal1`/`aal2` reales y el flujo `/auth/v1/factors`):** el TOTP lo calcula `pruebas/multirestaurante/totp.js` (RFC 6238, sin dependencias, verificado con los vectores oficiales de SHA-1/256/512).

| Batería | Antes | Ahora | Por qué cambia |
|---|---|---|---|
| unitarias (`node --test pruebas/*.test.js`) | 155 | **171** | +16 de `mfa.test.js`: vectores RFC 6238 (6), base32/TOTP (3), lectura del aal (4) y «sin escotillas» (3: el servidor no lee ninguna variable de entorno ni más cabeceras que las de la IP) |
| `superadmin.mjs` | 50 | **81** | los 50 de antes (ahora con sesiones aal2 reales; el de «17 acciones» pasó a 22) + 13 de MFA + 18 de lecturas/auditoría |
| `superadmin.mjs --sin-sql19` | — | **65** | nuevo: el servidor nuevo contra una base sin el SQL 19 (50 + 13 MFA + 2) |
| `sql19.mjs` | — | **44** | nuevo: SQL 19, reversa, permisos por rol, lecturas, no-escritura, auditoría |
| `quitar-mfa-test.mjs` | — | **11** | nuevo: la recuperación de 23.8 de punta a punta (TOTP real, borrar el factor, sesión aal2 cerrada, vuelve a entrar con uno nuevo) |
| `sql16.mjs` (48), `crear-superadmin-test` (13), servidor (262 / 208 sin SQL 18 / despachador), agrupación, vista previa, front, tema claro, panel, e2e, rls, endurecer, migrar-fotos, datos-restaurante, config-publica, dominios, hallazgos, planes, sim, cargar-secretos, inspección, rebrand, textos-visibles, opciones, comparar-tickets | — | **sin cambios** | |
| contra el falso: `probar-compatibilidad` / `probar-servidor` / `probar-opciones` / `probar-superadmin` / `probar-aislamiento` | 26 / 249 / 38 / 50 / 252 de 259 | **26 / 249 / 38 / 50 / 252 de 259** | sin cambios (las 7 de Realtime fallan en el falso por diseño) |
| `probar-superadmin-mfa.mjs` contra el falso | — | **31** | nuevo (12 de MFA + 18 de lecturas + Taqueiros intacto) |

*Revisión por mutación* (`node pruebas/multirestaurante/mutaciones-mfa.mjs --paralelo=3`, ~5 min): **95 mutaciones: 91 detectadas, 4 equivalentes declaradas, 0 sin detectar** (más el control: la copia limpia pasa todas las suites). Cubre la lectura del aal (no mirar el claim, no comparar el `sub`, no exigir TOTP en `amr`, fallar hacia aal2 ante una carga ilegible, confiar en un JWT que Auth rechazó), el orden y el código de las respuestas, la «escotilla» por variable de entorno o por cabecera, el no-superadmin que se distingue por su aal, la constancia del rechazo, los límites y la validación de cada lectura, `exigir_superadmin`, los permisos, la ventana de auditoría (sin ventana, 1 s, 30 min, sin modo, sin restaurante, sin superadmin), los datos personales en la auditoría, el corte de la jornada, el mes en la zona del restaurante y la reversa. Una primera pasada dejó **1 sobreviviente** (`sa_registrar_rechazo_mfa` guardando el nivel que mande el cliente): la prueba E9 estaba mal escrita (usaba un usuario que no era superadmin); se corrigió la prueba, no el código. Equivalentes declaradas: (1) comparar el `sub` sin pasarlo a minúsculas (Auth ya lo entrega en minúsculas); (2) aceptar un `amr` que no es lista (`.some()` falla y el `catch` devuelve aal1); (3) no poder reiniciar la memoria del límite (solo cambia lo que la prueba reinicia; la base deduplica por su cuenta); (4) tomar el actor del cuerpo (el campo se rechaza antes con 400 y la función SQL vuelve a exigir superadmin).

**Contra la base REAL (las corres tú, con la llave cargada por `Read-Host`; ninguna toca el demo ni tu cuenta):**

1. Antes, aplica el **SQL 19** (23.6). Sin él, `probar-superadmin-mfa.mjs` se detiene con un mensaje claro y no hace nada.
2. `node supabase/probar-superadmin.mjs` → **50 PASAN, 0 FALLAN** y «Limpieza: todo lo creado se borró». (Ahora cada superadmin de prueba usa un TOTP real, así que **esto ya prueba que el proyecto tiene la MFA habilitada**.)
3. `node supabase/probar-superadmin-mfa.mjs` → **31 PASAN, 0 FALLAN** y la misma limpieza. Crea usuarios `@prueba-superadmin.example.com` y restaurantes `mr16-prueba*` (con 125 pedidos de prueba), enrola factores TOTP reales, comprueba aal1 → 403 `mfa_requerida`, aal2 → pasa, y las lecturas con su auditoría sin datos personales. Los secretos TOTP y los tokens viven solo en memoria. Lo único que **no** se borra son unas pocas filas de auditoría (de solo agregar, con slug `mr16-prueba…`: se ignoran).

### 23.11 Riesgos conocidos y para revisar con Opus 5.5 (esfuerzo High)

1. **Lectura del aal** (23.2): ¿es suficiente confiar en que `GET /auth/v1/user` valida el mismo token que luego se decodifica? ¿Conviene además verificar por JWKS? ¿Qué pasa con tokens aal2 emitidos antes de borrar un factor?
2. **Enumeración de superadmins**: el 403 genérico es idéntico (cuerpo, cabeceras, peticiones), pero **el tiempo de respuesta** de un superadmin sin MFA incluye (una vez por ventana) la llamada de la constancia a la base: diferencia medible en milisegundos. Y `mi_estado` es la única acción que responde distinto a un superadmin con aal1 (por diseño).
3. **Fugas en las lecturas**: `ver_pedidos` devuelve `items` tal cual los guardó el servidor (JSON que **no es de fiar**, docs 22.17 H10: la pantalla debe pintarlo como texto) y datos personales de clientes (por diseño: es «entrar como»). `ver_config` devuelve la config pública completa (incluidas las llaves públicas de Wompi, que no son secretos).
4. **Auditoría**: una sola constancia por ventana de 10 min (23.7); `reembolso` sigue aceptando a un superadmin con cualquier aal; la constancia de rechazo no incluye IP.
5. **Límite de intentos en memoria**: sigue siendo por instancia de Vercel (frena pruebas a mano, no un ataque distribuido). La MFA de Supabase tiene su propio límite fijo (15 por minuto por IP).
6. **Carlos queda sin acceso a la API hasta la parte 2**: su cuenta (`themaikenpro@gmail.com`) no tiene MFA todavía y ahora la API la rechaza con `mfa_requerida`. Es lo que se pidió; la pantalla de la parte 2 trae el alta del factor con QR.

### 23.12 Qué queda para la parte 2

Revisión de seguridad independiente de esto → `superadmin.html`: inicio de sesión, **activar MFA con QR**, alta de restaurantes con planes, vigencia, dominios, usuarios, secretos de solo escritura y «entrar como» de solo lectura (usando las 4 lecturas de aquí, que ya existen) → ensayo con un segundo restaurante.

### 23.13 Revisión adversaria del 3B-1 (independiente, antes de la parte 2)

Revisión hecha como atacante, **sin tocar la base real ni usar llaves reales**: lectura del código, del código fuente de Supabase Auth (GitHub `supabase/auth`), de la documentación oficial, pruebas locales y mutaciones. Cada hallazgo dice si se **reprodujo** (CONFIRMADO) o es solo posible (PLAUSIBLE).

**Respuesta corta.** No se encontró forma de saltarse la MFA desde fuera, ni de hacerse pasar por superadmin, ni de leer un restaurante sin dejar fila de auditoría, ni de sacar un secreto. Sí se encontraron **dos huecos de severidad media**, ya corregidos: un token con MFA seguía valiendo como MFA **hasta 1 hora** después de quitar el factor (R1), y el reembolso dejaba pasar a un superadmin **sin** MFA (R2).

| # | Severidad | Evidencia | Dónde | Qué pasa | Estado |
|---|---|---|---|---|---|
| R1 | **Media** | CONFIRMADO (con el código de antes, el token viejo da **200** después de quitar el factor) | `api/_sesion.js` (`sesionDeToken`) | Borrar el factor (`quitar-mfa.mjs` o `deleteFactor`) **no** invalida el JWT aal2 ya emitido: Supabase Auth solo baja la sesión a aal1 para el próximo refresco (`adminUserDeleteFactor` → `DowngradeSessionsToAAL1`, sin cerrar sesiones) y `GET /user` no compara el `aal` del token con el de la sesión. Quien tuviera ese token seguía siendo superadmin con MFA hasta que caducara (1 h por defecto). La referencia de Supabase dice que «cierra todas las sesiones»; el código no lo hace. | **Corregido**: aal2 exige además que la **misma** respuesta de `GET /auth/v1/user` traiga un factor `totp` en estado `verified` (sin llamadas extra) |
| R2 | **Media** | CONFIRMADO (con el código de antes, un superadmin aal1 pasaba el permiso: 404 del pedido en vez de 403) | `api/reembolso.js` | Con **solo la contraseña** de un superadmin se podía marcar como reembolsado un pedido cancelado y cobrado de **cualquier** restaurante (por su dominio), sin MFA y sin auditoría. No mueve dinero, pero deja un registro falso («ya se devolvió») que el dueño puede creer. | **Corregido**: el camino del superadmin exige aal2; el del dueño no cambia (sin MFA) |
| H1 | Baja (pruebas) | CONFIRMADO | `pruebas/multirestaurante/fake-supabase.mjs` | El Supabase falso **borraba los tokens** al quitar un factor (más permisivo que el real) y así escondía R1; tampoco devolvía `factors` en `/auth/v1/user`. | **Corregido**: el falso ahora hace lo mismo que el real |
| R3 | Baja | PLAUSIBLE (por diseño) | SQL 19, `auditar_lectura_superadmin` | Un superadmin **con MFA** comprometido puede paginar todo el historial de un restaurante en 10 min con **una sola** fila de auditoría (su `devueltos` cuenta solo la 1.ª página). No se esquiva con parámetros (solo cuentan acción, restaurante y modo) ni con carreras (dos peticiones a la vez dejan **dos** filas, no cero), y queda al menos una fila cada 10 min de actividad. Ese mismo atacante ya puede hacer cosas peores que sí quedan registradas. | Aceptado. Mitigación barata para un SQL futuro (19b): incluir `pagina_inicial` en la clave de la ventana (paginar deja una 2.ª fila) |
| R4 | Baja | CONFIRMADO (conocido) | `api/superadmin.js` | El límite de 10 fallos por IP es en memoria de cada instancia de Vercel: no frena un ataque distribuido. La adivinanza del código TOTP la limita Supabase (15 por minuto por IP, no se puede cambiar). | Aceptado |
| R5 | Baja | — | `supabase/quitar-mfa.mjs` | `--confirmar` no pide reescribir el correo. Primero se corre sin `--confirmar` (muestra los factores), solo afecta al usuario de ese correo exacto y nunca imprime secretos. | Aceptado |
| R6 | Informativa | CONFIRMADO | `api/superadmin.js` | La diferencia de milisegundos del superadmin sin MFA **no es explotable**: para verla hay que tener la contraseña de esa misma cuenta, y con ella `mfa_requerida` ya lo dice en el cuerpo (por diseño: la pantalla lo necesita). Nadie puede averiguar si **otra** cuenta es superadmin. | Sin cambio |
| R7 | Informativa | — | `api/_sesion.js` | `amr` en formato de cadenas (solo con un *custom access token hook*, que no usamos) o una sesión aal2 conseguida con un **código de recuperación** (`mfa/recovery_code`, función experimental de Supabase desde Auth v2.197.0) cuentan como **aal1**: bloquea, no abre. Para recuperar el acceso se usa `quitar-mfa.mjs` (23.8). | Sin cambio |
| R8 | Informativa | NO CONFIRMADO | Supabase Auth | La página de límites lista `/user` en el grupo de 30 por 5 min por IP; no aclara si cuenta el `GET` que hace el servidor. Si pasara, el servidor responde 500 «No se pudo validar la sesión» (no abre nada). | Vigilar en la parte 2 |
| R9 | Informativa | — | `pruebas/multirestaurante/totp.js` | El TOTP de pruebas acepta 7–8 dígitos y reusar un código: solo lo usa el falso; en la base real verifica Supabase. | Sin cambio |
| R10 | Informativa | — | SQL 19 | Datos personales de clientes en `ver_pedidos` y correos de miembros en `ver_config`: por diseño («entrar como»). `items` es JSON que **no es de fiar** (22.17 H10). La jornada usa `America/Bogota` como el panel; el mes, la zona del restaurante. | Reglas para la parte 2 (abajo) |

**Lo que se comprobó y está bien** (sin hallazgo): el token que se decodifica es **byte por byte** el que Auth acaba de aceptar; un token vencido, con la firma cambiada, `alg: none`, de otro proyecto o con el `sub` cambiado no pasa de Auth (401); el de una sesión **cerrada** tampoco: `GET /user` exige que exista la sesión del claim `session_id` (código fuente: `session_not_found`); los claims anidados (`user_metadata.aal`) se ignoran; `aal` se compara exacto. No hay otra ruta hacia `api/superadmin.js` (ni `vercel.json` ni el despachador la alcanzan); todo método que no sea `POST` (también `OPTIONS`, `HEAD`, `PUT`) da 405 antes de mirar nada; un cuerpo roto, vacío o con una acción inventada da el mismo 403 sin MFA. Las 5 funciones del SQL 19: `SECURITY DEFINER`, `search_path` vacío, sin `EXECUTE` para `anon`, `authenticated` ni `PUBLIC`, lo primero es `exigir_superadmin(p_actor)`, sin SQL dinámico; `p_actor` solo lo pone el servidor (desde la sesión); el id del restaurante se valida como UUID antes de llamar a la base; `antes_de` solo filtra dentro del restaurante pedido; no sale ningún secreto ni token de seguimiento. La auditoría sigue de solo agregar con sus 3 disparadores; volver a correr el 16 con el 19 puesto es seguro (pruebas A5 y A6 de `sql19.mjs`) y el 16 sigue independiente del 16b. Las herramientas no imprimen secretos ni códigos y las pruebas reales solo tocan usuarios `@prueba-superadmin.example.com` y restaurantes `mr16-prueba*`.

**Pruebas nuevas** (fallan con el código de antes y pasan con el de ahora): `mfa.test.js` (+1: `tieneTotpVerificado`), `superadmin.mjs` (+2: «quitar el factor» y «reembolso»; también corren **contra la base real** en `probar-superadmin-mfa.mjs`), `quitar-mfa-test.mjs` (la prueba del token viejo ahora exige 403 `mfa_requerida`; antes exigía un 401 que solo pasaba con el falso). Revisión por mutación: ver 23.14.

**Verificación de la documentación de Supabase** (corrige 23.2, 23.8 y 23.9):

| Afirmación | Veredicto |
|---|---|
| `aal` vale `aal1`/`aal2`; un JWT sin `aal` está en `aal1` | CONFIRMADA (JWT fields; MFA) |
| `amr` es una lista de `{ method, timestamp }` con `totp`, `password`… | CONFIRMADA (JWT fields). Formato de cadenas solo con *hooks* (tipos de supabase-js 2.117) |
| `deleteFactor` borra un factor de un usuario | CONFIRMADA |
| …y «cierra todas sus sesiones» | **INCORRECTA en la práctica**: lo dice la referencia, pero el código de Auth solo baja la sesión a aal1 y el token sigue vivo hasta caducar (la guía de MFA: baja a aal1 «solo después del intervalo de refresco») → R1 |
| Un usuario solo quita su propio factor verificado (`unenroll`) estando en aal2 | CONFIRMADA (tipos de supabase-js) |
| El Dashboard tiene un botón para quitar el MFA de un usuario | NO CONFIRMADA (el artículo «Lost access» es de la cuenta de **Supabase**, no de los usuarios del proyecto) |
| Límites: token 150 / 5 min por IP; registro y otros 30 / 5 min; verify 30 / 5 min; MFA 15 / min por IP **sin poder cambiarse**; en Authentication → Rate Limits | CONFIRMADA (con ráfagas de 30). Diferencias por plan: NO CONFIRMADA (la página no dice nada) |
| «Allow new users to sign up» existe y, apagado, solo entran usuarios existentes | CONFIRMADA. Pantalla exacta: NO CONFIRMADA (la doc enlaza a la sección Auth del proyecto) |
| Largo mínimo y caracteres de la contraseña: proveedor Email | CONFIRMADA |
| «Confirm email» está en el proveedor Email | CONFIRMADA |
| TOTP habilitado por defecto y gratis | CONFIRMADA («enabled on all Supabase projects by default»). Nombre exacto del interruptor: NO CONFIRMADO (existe el modo «Verification Disabled») |
| Protección de contraseñas filtradas: Pro o superior | CONFIRMADA |
| MFA por teléfono es un complemento de pago | CONFIRMADA (75 USD al mes el primer proyecto) |

**Pasos manuales corregidos para Carlos** (lo demás de 23.9 queda igual):

* **Si pierdes el celular**: 23.8 sigue valiendo. Ahora, en cuanto `quitar-mfa.mjs --confirmar` borra el factor, cualquier token anterior deja de contar como MFA en el servidor **al instante**.
* **Si sospechas que alguien robó tu sesión o tu contraseña**: (1) borra el factor con `quitar-mfa.mjs`; (2) **cambia la contraseña** (Supabase termina las sesiones al cambiarla, y el servidor rechaza los tokens de sesiones terminadas); (3) vuelve a activar la MFA; (4) revisa la auditoría (`listar_auditoria`) desde la pantalla.

**Reglas de salida y de diseño para la parte 2 (`superadmin.html`)**

1. **Todo dato que venga de la base se pinta como texto** (`textContent`, nunca `innerHTML` ni plantillas con HTML): nombres de restaurantes, productos y opciones, `items` de los pedidos, datos de clientes, correos de miembros y mensajes de error. Enlaces solo a dominios propios y con `rel="noopener"`.
2. **Sesión en el navegador**: supabase-js con almacenamiento en `sessionStorage` (no `localStorage`), para que cerrar la pestaña cierre la sesión; nunca tokens en cookies propias, en la URL ni en el log. Cabeceras propias para esa página: CSP sin scripts de terceros (salvo supabase-js fijado por versión) y `frame-ancestors 'none'`.
3. **MFA**: al entrar, llamar a `mi_estado`. Si `aal` es `aal1`: sin factor verificado, mostrar el alta con QR (`mfa.enroll`) y verificar; con factor, pedir el código (`challenge` + `verify`). Si cualquier acción responde 403 con `codigo: "mfa_requerida"`, volver a esa pantalla (sin reintentar en bucle). El secreto del QR no se guarda en ningún lado.
4. **Alta de restaurantes**: confirmar el slug antes de crear (no se cambia después); la contraseña temporal de `crear_usuario` se muestra **una vez**, en un cuadro que no se puede volver a abrir, y nunca va al log.
5. **Secretos**: campos de **solo escritura** (`type=password`, `autocomplete=off`); al guardar se limpia el campo y solo se muestra sí/no por secreto (`estado_secretos`).
6. **«Entrar como»**: una franja fija «Viendo X — solo lectura» y ningún botón que escriba; paginar con `antes_de = siguiente`; avisar si `truncado`.
7. Repetir las pruebas reales (`probar-superadmin.mjs` y `probar-superadmin-mfa.mjs`) después de cada cambio del servidor.

Sources: [JWT fields](https://supabase.com/docs/guides/auth/jwt-fields) · [MFA](https://supabase.com/docs/guides/auth/auth-mfa) · [TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp) · [admin deleteFactor](https://supabase.com/docs/reference/javascript/auth-admin-mfa-deletefactor) · [código: adminUserDeleteFactor](https://github.com/supabase/auth/blob/master/internal/api/admin.go) · [código: DowngradeSessionsToAAL1](https://github.com/supabase/auth/blob/master/internal/models/factor.go) · [código: sesión desde el JWT](https://github.com/supabase/auth/blob/master/internal/api/auth.go) · [código: usuario con factores](https://github.com/supabase/auth/blob/master/internal/models/user.go) · [Sessions](https://supabase.com/docs/guides/auth/sessions) · [Rate limits](https://supabase.com/docs/guides/auth/rate-limits) · [General configuration](https://supabase.com/docs/guides/auth/general-configuration) · [Password security](https://supabase.com/docs/guides/auth/password-security) · [MFA por teléfono (precio)](https://supabase.com/docs/guides/platform/manage-your-usage/advanced-mfa-phone) · [Lost access (cuenta de Supabase)](https://supabase.com/docs/guides/troubleshooting/lost-accessforgot-the-mfa-device-nAPT-7) · [Códigos de recuperación](https://supabase.com/docs/reference/javascript/auth-mfa-recovery-codes-verify) · [Auth v2.197.0](https://github.com/supabase/auth/releases/tag/v2.197.0)

### 23.14 Pruebas después de la revisión adversaria

| Batería | Antes | Ahora | Por qué cambia |
|---|---|---|---|
| unitarias (`node --test pruebas/*.test.js`) | 171 | **172** | +1 `tieneTotpVerificado` (R1) |
| `superadmin.mjs` | 81 | **84** | +3: quitar el factor deja el token viejo sin MFA (R1), reembolso de un superadmin sin MFA (R2), la base falla al mirar `superadmins` → 500 (mutación sobreviviente) |
| `superadmin.mjs --sin-sql19` | 65 | **68** | las mismas 3 (están en el grupo de MFA) |
| `quitar-mfa-test.mjs` | 11 | **11** | la prueba del token viejo ahora exige 403 `mfa_requerida` (antes un 401 que solo daba el falso) |
| `sql19.mjs` | 44 | **44** | C10 ahora comprueba que el horario de `ver_config` es el del restaurante pedido (mutación sobreviviente) |
| `probar-superadmin-mfa.mjs` contra el falso | 31 | **33** | +2 (R1 y R2); el de la base que falla solo corre con el falso |
| sql16 48, crear-superadmin 13, servidor 262 (despachador 262; 208 con `SQL18_NO=1`), agrupación 32, vista previa 57, front 208, tema claro 43, panel 414, e2e 193, rls 237, endurecer 426, migrar-fotos 126, datos-restaurante 76, config-publica 52, dominios 35, hallazgos 32, planes 11, sim 34, cargar-secretos 25, inspección 6, rebrand 78, textos-visibles 10, opciones 77, comparar-tickets 7 + 3; contra el falso: compatibilidad 26, servidor 249, opciones 38, superadmin 50, aislamiento 252 de 259 | — | **sin cambios** | (las 7 de Realtime siguen fallando con el falso, por diseño) |

*Revisión por mutación* (`node pruebas/multirestaurante/mutaciones-mfa.mjs --paralelo=3`): se agregaron 12 mutaciones (las dos correcciones, el factor sin verificar o de otro tipo, el dueño al que se le exigiera MFA en el reembolso —detectada por `servidor.mjs --grupo=reembolso`—, y rincones que la lista no tocaba: horario, mes y catálogo de **otro** restaurante, y «si la base falla al mirar superadmins, se deja pasar»). Primera pasada: **107 mutaciones, 101 detectadas, 4 equivalentes (las mismas de 23.10), 2 sin detectar** (el horario de otro restaurante y la falla de la base: el código estaba bien, pero ninguna prueba lo vigilaba). Con las dos pruebas nuevas: **0 sin detectar**.

**Contra la base REAL (las corres tú):** `node supabase/probar-superadmin.mjs` → **50**, y `node supabase/probar-superadmin-mfa.mjs` → **33** (antes 31). Las dos nuevas confirman en Supabase real que (1) después de borrar el factor por la API de administración, el token de antes ya no cuenta como MFA, y (2) un superadmin sin MFA no pasa el permiso del reembolso.


---

## 24. La pantalla de superadministración (`superadmin.html`) — paso 3B, parte 2 de 2

La parte 1 (sección 23) dejó el servidor listo: 22 acciones en `api/superadmin.js`, MFA obligatoria (aal2) y las lecturas de «entrar como». Esta parte es **la pantalla** con la que Carlos opera todo sin escribir comandos: entrar y activar la verificación en dos pasos, ver los restaurantes, darlos de alta, cobrar, suspender, cargar secretos y mirar un restaurante en solo lectura. **No hay SQL nuevo, ni cambios en `api/`, ni funciones nuevas de Vercel** (siguen 7 de 12).

### 24.1 Qué es y cómo se llega

* **Dirección:** `/superadmin.html` del mismo despliegue (por ejemplo `https://taqueiros-2-0.vercel.app/superadmin.html`). **Ninguna otra página enlaza a ella** (una prueba lo comprueba en todos los archivos del sitio, el service worker y `api/`) y lleva `noindex`.
* **Archivos:** `superadmin.html` (solo el esqueleto), `superadmin.css`, y cinco scripts propios: `superadmin.js` (núcleo: sesión, MFA, cliente de la API, lista y auditoría), `superadmin-alta.js` (asistente de alta), `superadmin-detalle.js` (las pestañas del restaurante), `superadmin-lectura.js` («entrar como») y `superadmin-inicio.js` (arranque). Reutiliza `supabase-publico.js` (URL y llave **publicable**; la secreta no llega nunca al navegador).
* **Sin dependencias:** HTML/CSS/JS puro. **No usa `supabase-js`**: el inicio de sesión, la renovación del token y la MFA hablan con las rutas de Supabase Auth por `fetch` (`/token`, `/user`, `/factors`, `…/challenge`, `…/verify`, `/logout`). *Por qué:* así la política de seguridad puede ser `script-src 'self'` (nada de CDN ni de scripts en línea) y no hay una librería de terceros en la página que maneja todos los restaurantes.
* **Aspecto:** oscuro y sobrio, sin la marca de ningún restaurante. Usa la tipografía del sistema a propósito (la política de seguridad no permite cargar fuentes de terceros).

### 24.2 Entrar y activar la verificación en dos pasos (paso a paso)

1. Abre `/superadmin.html`, escribe tu correo y tu contraseña. Si la contraseña es mala, o si el usuario existe pero **no es superadmin**, el mensaje es **exactamente el mismo** («No pudimos iniciar sesión con esos datos…») y a un no-superadmin se le cierra la sesión sin pistas.
2. **Primera vez (sin factor):** la pantalla pide el alta de la verificación: instala **Google Authenticator, Microsoft Authenticator o Authy** en el celular, escanea el QR (o escribe la clave a mano; hay botón «Copiar clave») y escribe el número de 6 dígitos. El QR es un `<img>` con el SVG que devuelve Supabase (nunca se inyecta como HTML); la clave y el QR se borran de la pantalla al terminar y no se guardan en ningún lado.
3. **Las veces siguientes:** pide el código de la app (campo numérico de 6 dígitos con `autocomplete="one-time-code"`).
4. Con aal2 confirmado por el servidor (`mi_estado`) se carga la lista. **Nada de administración se pide antes** (una prueba lo exige).
5. **Sesión:** vive en `sessionStorage` (se pierde al cerrar la pestaña; nunca en `localStorage`, cookies ni URL). El token se renueva solo cuando faltan menos de 90 s; si la renovación baja a aal1 vuelve a pedir el código. Si no puede renovar, el encabezado muestra «La sesión vence en m:ss». «Cerrar sesión» cierra la sesión en Supabase y vacía la pantalla y el almacenamiento (*precisiones de la revisión, 24.13:* cierra **todas** las sesiones de esa cuenta, también otras pestañas; «Duplicar pestaña» en el navegador copia la sesión; el portapapeles **no** se vacía; y `sessionStorage` lo puede leer cualquier página del **mismo dominio** abierta después en **esa misma pestaña**: cierra sesión antes de usar la pestaña para otra cosa).
6. **Errores del servidor:** `mfa_requerida` → pantalla del código **sin reintentar en bucle** (mientras se pide el código la pantalla no llama a la API aunque se pulsen botones); `401` → inicio de sesión; `429` → aviso y espera (no vuelve a llamar hasta que pase `Retry-After`).
7. **Si pierdes el celular:** el enlace «Perdí mi celular» explica que **no se recupera desde la pantalla** (a propósito) sino con `node supabase/quitar-mfa.mjs` (pasos de 23.8).

### 24.3 Mapa de la pantalla: qué botón usa qué acción

| Pantalla | Botón o sección | Acción del servidor |
|---|---|---|
| Entrar | Después de la contraseña / el código | `mi_estado` (la única que acepta aal1) |
| Restaurantes | Lista, «Actualizar» | `listar_restaurantes` |
| Nuevo restaurante | «Comprobar si ya existe» (paso 3) | `buscar_usuario` |
| | «Crear restaurante» (paso 5) | `crear_restaurante`, luego `crear_usuario` (o `asignar_miembro` si el correo ya existe) |
| Detalle | Abrir un restaurante | `detalle_restaurante` |
| Resumen y vigencia | «Registrar pago» | `registrar_pago` |
| | «Suspender» / «Reactivar», «Guardar cambios» (plan, modalidad, módulos, gracia, zona, vencimiento, nombre) | `actualizar_restaurante` |
| Dominios | Agregar / Quitar | `agregar_dominio` / `quitar_dominio` |
| Usuarios | Crear usuario nuevo | `crear_usuario` |
| | Ya tiene cuenta / Cambiar rol | `buscar_usuario` + `asignar_miembro` |
| | Quitar | `quitar_miembro` |
| Marca y datos | Marca, Contacto, Ubicación, Domicilio, App del panel, Wompi (llaves públicas), Textos | `editar_config` (cada tarjeta manda **su sección completa**) |
| | Tarifas de domicilio | `guardar_tarifas` |
| Secretos | «Guardar secretos» | `guardar_secretos` (el sí/no sale de `detalle_restaurante`) |
| Entrar como | Resumen / Pedidos / Menú / Configuración | `ver_resumen` / `ver_pedidos` (con `antes_de`) / `ver_menu` / `ver_config` |
| Auditoría | Global y pestaña de cada restaurante | `listar_auditoria` (con `restaurante_id` y `antes_de`) |

No se usan `yo` ni `estado_secretos` (el detalle ya trae lo mismo). **No se cambió ninguna acción del servidor.** Lo único que el servidor no hace y la pantalla resuelve: el filtro por *acción* de la auditoría se aplica en el navegador sobre las filas ya cargadas (el servidor filtra por restaurante y pagina por `antes_de`).

### 24.4 Dar de alta un restaurante, paso a paso

En «Nuevo restaurante» (seis pasos; nada se crea hasta el 5):

1. **Datos.** Nombre y *nombre corto* (se sugiere desde el nombre y se puede editar). **El nombre corto no se puede cambiar después sin trabajo técnico** (la pantalla lo avisa y exige confirmarlo en el paso 5). Casilla «Es un restaurante de prueba»: antepone un prefijo (`prueba-` por defecto) para poder encontrarlo y borrarlo luego (24.9).
2. **Plan y modalidad.** Plan (Básico, Completo, Solo comandas) con los **precios de referencia a la vista** (solo texto; el servidor no los usa), módulos resultantes (editables), modalidad mensual o pago único, días de prueba (14 por defecto), días de gracia (5) y zona horaria (America/Bogota).
3. **Dueño.** Su correo; «Comprobar si ya existe» (`buscar_usuario`). Si ya tiene cuenta, solo se le da acceso (no se toca su contraseña).
4. **Dirección web.** Tres opciones: *dominio propio* (se registra al crear), *subdominio automático* (solo muestra la dirección `nombre-corto.tudominio.com` que le tocaría; **hoy `DOMINIO_BASE` está vacía**, así que no funciona hasta configurarla) o *decidirlo después*.
5. **Confirmar.** Resumen y casilla «entiendo que el nombre corto no se podrá cambiar». El botón se bloquea mientras trabaja (un triple clic crea **un solo** restaurante). Si algo falla a medias (por ejemplo el usuario), recuerda lo ya hecho y el botón reintenta **solo lo que falta**.
6. **Entrega.** La **contraseña temporal** (20 caracteres) se muestra **una sola vez**, en un cuadro marcado, con «Copiar»; se borra sola a los 3 minutos, al pulsar «Ya la copié» o al salir de la vista, y no queda en el DOM, el almacenamiento, la consola ni la auditoría. *Precisiones (24.13 R4, R6 y R8):* los «3 minutos» son 180 tics del reloj de la pestaña: si el computador se suspende o el navegador congela la pestaña, al volver sigue en pantalla el tiempo que le faltaba; si en ese momento la pantalla vuelve a pedir el código de la app, al confirmarlo el asistente vuelve a empezar y la contraseña se pierde; y lo que copias queda en el portapapeles (y en el historial de Windows, Win+V, si lo tienes activo) hasta que copies otra cosa. Botón «Copiar mensaje para WhatsApp» (dirección, panel, correo y la contraseña **solo mientras sigue en pantalla**; después el mensaje dice que se envía por aparte).

**Lo que se hace FUERA de la pantalla (Vercel y DNS):**

* *Dominio propio:* Vercel → Project → Settings → Domains → agregar la dirección; crear en el DNS el registro que Vercel indique; esperar a que Vercel lo marque válido. **Comprobar:** abrir la dirección en el navegador; si ves el menú del restaurante, funciona.
* *Subdominio automático:* registro comodín `*.tudominio.com` en el DNS; agregar `*.tudominio.com` en Vercel → Domains; variable `DOMINIO_BASE=tudominio.com` (solo Production) en Vercel → Settings → Environment Variables y **volver a desplegar**. Comprobar abriendo `nombre-corto.tudominio.com`.
* Después: colores, tarifas y llaves de Wompi/CallMeBot en el detalle del restaurante; el webhook de Wompi de **ese** restaurante apunta al mismo `/api/webhook-wompi` (19.6 paso 7).

### 24.5 Cambiar planes, cobrar y suspender

* **Planes** (decisión final, solo como referencia en pantalla): Básico $400.000 único o $40.000/mes (menú con pedido a WhatsApp, sin pasarela, seguimiento ni panel de comandas); Completo $2.500.000 único o $150.000/mes; Solo comandas $800.000 único o $100.000/mes (el menú como extra: $200.000 único o $20.000/mes). Cada plan fija los **módulos** por defecto (`pasarela`, `seguimiento`, `comandas`, `impresion`); hoy el sistema **aplica de verdad** la pasarela y el seguimiento (`api/_publico.js`, `index.html`, `pedido.html`); comandas e impresión quedan anotados.
* **Registrar pago:** meses (1 a 36), monto, referencia y nota opcionales. La pantalla explica cómo cuenta (*vencido o en gracia: desde hoy; vigente: se suma a su fecha*), muestra la nueva fecha estimada y pide una confirmación aparte; un doble clic registra **un** pago. Una prueba pasa a activo. Para un restaurante **sin vencimiento** el botón está apagado: primero ponle una fecha en «Cambiar plan y vigencia».
* **Pago único:** al cobrarlo, marca «Sin vencimiento» en «Cambiar plan y vigencia».
* **Suspender / Reactivar:** con confirmación; reactivar deja elegir Activo o En prueba. Un suspendido a mano sigue suspendido aunque pague (19.3).
* **Colores de estado:** prueba (azul), activo (verde), gracia (ámbar), vencido (rojo), suspendido (rosa), siempre con su texto.

### 24.6 «Entrar como» (solo lectura)

Desde la pestaña «Entrar como» → «Mirar este restaurante». Una **franja fija** arriba dice «Modo solo lectura: estás viendo [nombre]. No puedes cambiar nada aquí.» y la vista **no contiene ningún formulario, campo de texto, enlace ni botón que escriba**: solo botones de navegación y «Cargar más». Solo llama a `ver_resumen`, `ver_pedidos` (jornada o recientes, 25 por página, con `antes_de`), `ver_menu` (con lo inactivo y agotado) y `ver_config`; la función `SA.apiLectura` rechaza cualquier otra acción. Nombres de clientes, direcciones, productos y opciones (los `items` de un pedido llegan **sin sanear**, 22.17 H10) se pintan como texto; los caracteres invisibles y de dirección se cambian por un cuadrito visible. No abre el panel real ni usa la sesión de nadie. Cada consulta deja una constancia en la auditoría (solo conteos, sin datos de clientes; una por ventana de 10 minutos, 23.7).

### 24.7 Modelo de seguridad

| Capa | Qué hace |
|---|---|
| **Cabeceras** (`vercel.json`, solo para `/superadmin.html` y sus 6 archivos) | CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' <Supabase>; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'` (sin `unsafe-inline` ni `unsafe-eval`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Permissions-Policy` y `Cross-Origin-Opener-Policy`. Los scripts y el CSS reciben las 4 últimas. **Ninguna otra ruta** (ni `/api`) recibe nada de esto; los `rewrites`, `redirects`, `crons` y `functions` quedan idénticos. Si cambia el proyecto de Supabase hay que cambiar su dirección **también** en la CSP (una prueba compara `vercel.json` con `supabase-publico.js`). |
| **Solo en su dirección exacta** (24.13 R1) | `superadmin-inicio.js` solo arranca si la dirección es exactamente `/superadmin.html` (si no, se va a ella antes de mostrar nada) y no arma nada dentro de un marco. *Por qué:* Vercel **no** pone las cabeceras de arriba en `/%73uperadmin.html`, `/superadmin.htm%6c` o `/superadmin.html%2f`, que sirven el mismo archivo. |
| **Nada de HTML con datos** | Todo se arma con `createElement` y `textContent`; no existe `innerHTML`, `eval`, `document.write`, `localStorage`, `document.cookie` ni `console.*` en ningún `superadmin*.js` (prueba de código) **y**, como esa prueba se esquiva escribiendo `el["inner"+"HTML"]`, la prueba de navegador además vigila en tiempo real cualquier uso de esos sumideros (24.13 I). |
| **Sesión** | `sessionStorage` por pestaña; sin tokens en URL, cookies ni consola. |
| **Solo escritura** | Los secretos nunca se leen: la pantalla solo sabe «Cargado: Sí/No». Al guardar (y aunque falle) los campos se vacían, no se muestran valores ni en la respuesta, el DOM, el almacenamiento, la consola ni la auditoría; un valor que otro restaurante ya usa se rechaza. |
| **Confirmaciones** | Pago, suspender, quitar dominio, quitar usuario y guardar secretos piden confirmación explícita; los botones se bloquean mientras envían. |
| **El servidor manda** | Aunque la pantalla se saltara una regla, `api/superadmin.js` vuelve a exigir sesión, superadmin y aal2 **en cada petición** (23.3) y la base valida todo. |

**¿Qué pasa si `/superadmin.html` se abre desde el dominio de un restaurante?** Todos los dominios del despliegue sirven los mismos archivos estáticos, así que `https://pedidos.restaurante.com/superadmin.html` **carga la pantalla** (es solo código, **ninguna información**: la lista de restaurantes solo llega con sesión de superadmin + MFA). `api/superadmin.js` es global y no mira el dominio, de modo que también funcionaría desde ahí, con las mismas exigencias. Riesgos reales: (1) una pantalla de acceso de administración visible bajo un dominio ajeno; (2) `sessionStorage` es por origen y por pestaña: una sesión abierta *en ese dominio* sería accesible para los scripts de ese mismo origen que se abran después **en la misma pestaña** (*corregido en 24.13:* las páginas públicas **sí** corren scripts de terceros: `index.html` carga Leaflet desde unpkg y el widget de Wompi, y `panel.html`, `menu-admin.html` e `historial.html` cargan supabase-js desde jsDelivr). **Recomendación (no implementada, para no arriesgar los dominios existentes):** entrar siempre por un dominio exclusivo de administración y, cuando exista, mandar `/superadmin.html` de los demás dominios a ese (24.13, punto 7). *Corregido en 24.13:* una regla de `rewrites` **no** sirve para esto, porque en Vercel el archivo estático tiene prioridad sobre los `rewrites`; hay que usar `redirects`.

### 24.8 Si se pierde el celular

No se arregla desde la pantalla. Pasos (23.8): (1) `$k = Read-Host "Llave SECRETA" -AsSecureString` y `$env:SUPABASE_SERVICE_ROLE_KEY = …`; (2) `node supabase/quitar-mfa.mjs tu-correo` (solo muestra); (3) `node supabase/quitar-mfa.mjs tu-correo --confirmar`; (4) `Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY`; (5) entra solo con la contraseña y activa la verificación con el celular nuevo. Si sospechas que robaron tu sesión: borra los factores, **cambia la contraseña** y revisa la auditoría.

### 24.9 Limpiar un restaurante de prueba

No existía una forma segura (ni la API ni la pantalla pueden borrar restaurantes, a propósito). Nuevo: `supabase/borrar-restaurante-prueba.mjs`, herramienta de operador:

```powershell
$k = Read-Host "Llave SECRETA" -AsSecureString
$env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node supabase/borrar-restaurante-prueba.mjs prueba-casa-rivo              # SIMULA: cuenta las filas y no borra nada
node supabase/borrar-restaurante-prueba.mjs prueba-casa-rivo --aplicar    # pide escribir el nombre corto completo
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

**Se niega siempre** a: el demo (por su id `00000000-0000-4000-8000-000000000001`), un restaurante cuyo nombre corto no empiece por el prefijo de prueba (`prueba-`; se cambia con `--prefijo=xxx-`, mínimo 4 caracteres y terminado en guion), y cualquiera con **pedidos pagados** (`estado_pago` aprobado o con fecha de pago; se le pregunta a la base con un filtro, porque Supabase corta cada consulta en 1000 filas, y el borrado de pedidos además excluye los pagados: 24.13 R3). Solo borra filas con `restaurante_id` de ese restaurante y su fila; **no** toca la auditoría, los usuarios de Authentication ni las fotos del almacenamiento. Pruebas: `node pruebas/multirestaurante/borrar-prueba-test.mjs` (32 comprobaciones desde 24.13).

### 24.10 Pruebas

| Batería | Cómo | Resultado |
|---|---|---|
| Navegador de la pantalla (Chrome + el manejador real de `api/superadmin.js` + el Supabase falso con MFA) | `node pruebas/multirestaurante/superadmin-pantalla.mjs` | **365** desde 24.13 (antes 353) comprobaciones (20 escenarios: cabeceras y código, inicio de sesión, MFA, mfa_requerida/401/429, sesión, lista, alta, errores del alta, detalle, dominios y usuarios, marca, secretos, entrar como, auditoría, renovación de sesión, 390/1280 px y foco) |
| Borrado de pruebas | `node pruebas/multirestaurante/borrar-prueba-test.mjs` | **32 comprobaciones** (31 antes de 24.13) |
| Revisión por mutación | `node pruebas/multirestaurante/mutaciones-pantalla.mjs --paralelo=3` | **61 mutaciones: 55 detectadas, 6 equivalentes declaradas con su razón (4 son defensas repetidas en dos capas y 2 son «vaciar dos veces»), 0 sin detectar; la primera pasada dejó 15 sin detectar: 9 eran el script de borrado (el arnés no usaba la copia mutada), 2 regex mal escritas, 1 dato de prueba sin invisibles y 1 comprobación que fallaba al azar (la contraseña temporal con `&` salía escapada en `outerHTML`: ahora se busca en `textContent`)** |
| Las de siempre | ver 24.11 | sin cambios, salvo lo explicado |

Capturas (390 y 1280 px) en `Recursos/NORTHE-NUEVO/capturas/superadmin-*.png` (carpeta ignorada por git; se regeneran con la prueba).

### 24.11 Decisiones, riesgos conocidos y pendientes

**Decisiones donde el pedido no definía algo:** (1) sin `supabase-js`: Auth por `fetch` (política de seguridad estricta); (2) cinco scripts en vez de uno (cada uno es una parte de la pantalla y las cabeceras cubren todos); (3) la etiqueta «Demo» **no se muestra**: el servidor no marca al demo y no se escriben ids a mano (un restaurante sin vencimiento dice «Sin vencimiento»); (4) el usuario del dueño se crea al **confirmar** (paso 5), no en el 3, porque `crear_usuario` necesita que el restaurante exista; (5) los módulos de cada plan viven en la pantalla (`superadmin-alta.js`) y se mandan al servidor; los precios son solo texto; (6) cada tarjeta de «Marca y datos» manda su sección completa conservando lo que la pantalla no muestra; (7) `vigente_hasta` del alta se calcula como hoy (Bogotá) + días de prueba y se manda como fecha.

**Riesgos y pendientes:**
* Las **cabeceras** se comprobaron con las pruebas locales; la comprobación real es con `curl` en producción (24.12).
* La pantalla es **tan segura como la cuenta**: MFA activa, contraseña larga y única, y los ajustes manuales de Supabase de 23.9 / 23.13 (cerrar el registro público, contraseña mínima de 12, revisar los límites de Auth).
* `crear_usuario` entrega la contraseña temporal en la respuesta (una vez, `no-store`): quien tenga el token de superadmin la ve; no hay cambio forzado de contraseña.
* El filtro por acción de la auditoría solo ve las filas ya cargadas.
* **Siguiente:** revisión de seguridad independiente de la pantalla (Opus 5.5, esfuerzo High), ensayo con un segundo restaurante real (decidir antes la dirección web), el Plan Básico y la preparación de producción.

### 24.12 Después del despliegue (sin credenciales)

```powershell
curl.exe -s -I https://taqueiros-2-0.vercel.app/superadmin.html          # 200 y las cabeceras de 24.7
curl.exe -s -I https://taqueiros-2-0.vercel.app/index.html               # SIN esas cabeceras
curl.exe -s -o NUL -w "%{http_code}" -X POST https://taqueiros-2-0.vercel.app/api/superadmin                       # 401
curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Authorization: Bearer falso" https://taqueiros-2-0.vercel.app/api/superadmin   # 401
curl.exe -s -o NUL -w "%{http_code}" https://taqueiros-2-0.vercel.app/api/superadmin                               # 405
```

Ojo (24.13 R1): `curl.exe -s -I https://taqueiros-2-0.vercel.app/%73uperadmin.html` responde **200 sin** esas cabeceras (es un comportamiento de Vercel). Eso es esperado: la pantalla se va sola a `/superadmin.html` antes de mostrar nada.

### 24.13 Revisión adversaria de la pantalla y del script de limpieza (independiente)

Revisión hecha como atacante, **sin llaves reales ni tocar la base real**: lectura de todo el código (`superadmin*.js/html/css`, `vercel.json`, `api/superadmin.js`, `supabase/borrar-restaurante-prueba.mjs`, `sw.js`), peticiones **GET sin credenciales** a producción para las cabeceras, el Supabase falso, Chrome real con las pruebas del repo y mutaciones. CONFIRMADO = reproducido (con una prueba que fallaba antes) o demostrado en producción; PLAUSIBLE = posible, no reproducido.

**Respuesta corta.** No se encontró forma de inyectar código en la pantalla con datos de la base o del servidor (todo se pinta como texto; el QR es una imagen), ni de escribir algo desde «entrar como», ni de sacar un secreto. Sí aparecieron **tres huecos de severidad media, ya corregidos**: las cabeceras de seguridad se podían esquivar con una dirección codificada (R1), el asistente de alta podía dar el restaurante nuevo a la **cuenta equivocada** si el correo se corregía mientras se comprobaba (R2), y el script de limpieza podía **borrar pedidos pagados** si el restaurante tenía más de 1000 pedidos (R3).

| # | Severidad | Evidencia | Dónde | Qué pasa | Estado |
|---|---|---|---|---|---|
| R1 | **Media** | CONFIRMADO en producción (`curl`) | `vercel.json` + Vercel | Vercel busca el archivo con la ruta **decodificada** pero elige las cabeceras con la ruta **cruda**: `/%73uperadmin.html`, `/superadmin.htm%6c` y `/superadmin.html%2f` sirven la pantalla **funcionando** con 200 y **sin** CSP, sin `X-Frame-Options` y sin `no-store` (también `/superadmin.html/`, aunque ahí no cargan sus scripts). Quien mande ese enlace anula la CSP y puede meter la pantalla en un marco. Ninguna regla de `vercel.json` cubre todas las codificaciones. | **Corregido**: `superadmin-inicio.js` solo arranca en `/superadmin.html` exacto (si no, `location.replace` a esa dirección, que sí lleva las cabeceras) y no arma nada dentro de un marco |
| R2 | **Media** | CONFIRMADO (prueba 20: con el código de antes, la base dejó como dueña a la cuenta del primer correo) | `superadmin-alta.js`, paso 3 | Escribes un correo que ya existe, pulsas «Comprobar si ya existe», lo corriges **mientras la consulta va en camino** (red lenta) y sigues: la respuesta vieja quedaba guardada y el paso 5 hacía `asignar_miembro` con el id de la **primera** cuenta, mostrando el correo nuevo en el resumen y en el mensaje de WhatsApp. Esa otra persona (por ejemplo el dueño de otro restaurante) quedaba de dueña del restaurante nuevo. | **Corregido**: se descarta una respuesta cuyo correo ya no es el escrito, el paso 3 solo da por comprobado el correo **exacto** que se comprobó, y el paso 5 se niega si no coinciden |
| R3 | **Media** | CONFIRMADO (prueba nueva con el tope de 1000 filas de Supabase: el script de antes borró todo, el pagado incluido) | `supabase/borrar-restaurante-prueba.mjs` | Supabase devuelve como mucho **1000 filas por consulta** («Max rows»). El script bajaba la lista de pedidos y buscaba pagados en ella: con más de 1000 pedidos podía no ver uno pagado y **borrarlo**. | **Corregido**: le pregunta a la base con un filtro (`estado_pago=eq.aprobado` y `pagado_en=not.is.null`, `limit=1`), y el `DELETE` de pedidos además excluye los pagados (si uno se pagara justo en ese instante, queda y el borrado del restaurante falla sin tocarlo). La simulación dice «1000 o más» cuando corresponde |
| I | Baja (pruebas) | CONFIRMADO | `superadmin-pantalla.mjs`, `fake-supabase.mjs` | Tres falsos **más permisivos** que lo real: el sitio de prueba ponía las cabeceras mirando la ruta decodificada (escondía R1); el Supabase falso no tenía tope de filas (escondía R3); y la prueba «sin innerHTML/eval» busca palabras, así que `el["inner"+"HTML"]` o un alias de `insertAdjacentHTML` **la esquivaban** (una mutación así sobrevivió). | **Corregido**: el sitio de prueba imita a Vercel, el falso acepta `falso.maxFilas` y `not.is.null`, y la prueba de navegador instala una **trampa** que registra cualquier uso real de `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `createContextualFragment`, `DOMParser`, `srcdoc`, `eval`, `Function` y `setTimeout` con texto |
| R4 | Baja | CONFIRMADO (lectura de código) | `superadmin-alta.js`, `superadmin-detalle.js` (`cajaClave`) | La contraseña temporal se borra tras **180 tics** de un `setInterval`, no a una hora fija: si el computador se suspende o el navegador congela la pestaña, al volver sigue visible el tiempo que faltaba. Hace falta acceso físico a la pantalla. | Pendiente (cambio pequeño: hora límite con `Date.now()` y revisar al volver a la pestaña) |
| R5 | Baja | PLAUSIBLE | `superadmin.js` (sesión en `sessionStorage`) | La sesión **aal2** (con su token de renovación) vive en el `sessionStorage` de la pestaña, que es por **origen**: si en esa misma pestaña, sin cerrar sesión, abres `/` o `/panel.html` del **mismo dominio**, los scripts de terceros de esas páginas (unpkg, Wompi, jsDelivr) o un XSS futuro podrían leerla. Necesita un script malicioso en esas páginas. | Pendiente: lo resuelve el **dominio de administración aparte** (punto 7); mientras tanto, cerrar sesión antes de usar la pestaña para otra cosa |
| R6 | Baja | CONFIRMADO (lectura de código) | `superadmin.js` (`entrarALaApp` → `recargarVista`) | Si la pantalla pide otra vez el código (aal1 o `mfa_requerida`) mientras se ve la contraseña temporal del paso 6, al confirmarlo el asistente se reinicia y la contraseña se pierde (el restaurante y el usuario ya existen; hay que crear otro usuario o restablecer la contraseña). | Pendiente (entra con el arreglo (4), «regenerar la contraseña temporal») |
| R7 | Baja | CONFIRMADO (lectura de código) | `superadmin-alta.js`, paso 5 | Si el restaurante se creó y el usuario falló, el botón «Atrás» que ya estaba pintado sigue activo: se puede volver y cambiar nombre, nombre corto o dirección, y el resumen y el mensaje de WhatsApp mostrarían datos que **no** son los creados (en el servidor no cambia nada: el restaurante ya existe). | Pendiente (bloquear esos pasos una vez creado) |
| R8 | Baja | PLAUSIBLE | «Copiar clave» (MFA), «Copiar» contraseña, «Copiar mensaje» | Lo copiado (incluida la **semilla TOTP** del alta de MFA) queda en el portapapeles y, con el historial de Windows activo (Win+V), ahí sigue. La pantalla no avisa. | Pendiente: escanear el QR en vez de copiar la semilla y desactivar el historial del portapapeles en ese equipo |
| R9 | Baja | PLAUSIBLE | `superadmin-detalle.js` (secretos) | Los campos de secretos usan `autocomplete="new-password"`: Chrome puede ofrecer «sugerir contraseña segura» o «guardar contraseña» y llevar un secreto al gestor del navegador si se acepta. | Pendiente: no aceptar esas ofertas en esa pantalla |
| R10 | Informativa | CONFIRMADO | `superadmin.js` | Un estado o acción llamado `constructor` o `__proto__` (los valores vienen de la base, con `CHECK`) mostraría el texto de una función como etiqueta. Solo texto; no inyecta nada. | Sin cambio |
| R11 | Informativa | — | `vercel.json` | La CSP podría añadir **Trusted Types** (`require-trusted-types-for 'script'; trusted-types 'none'`): en Chrome convertiría cualquier sumidero de HTML en error. El código actual no usa ninguno. | Opcional |
| R12 | Informativa | CONFIRMADO (lectura de código) | `superadmin-alta.js` | Si la respuesta de `crear_restaurante` se pierde en la red **después** de crearse, el reintento da 409 «ya existe ese nombre corto» y el restaurante queda sin dueño (se agrega en su pestaña Usuarios). No se crean dos. | Sin cambio |

**Lo que se comprobó y está bien** (sin hallazgo): **XSS**: cada salida al DOM pasa por `textContent` o nodos de texto (incluidos los mensajes de error del servidor, los `items` de pedidos sin sanear, la auditoría y la configuración aplanada); `h()` rechaza `style`, `href`, `src`, `srcdoc` y similares y nunca pone `on*` como atributo; no hay enlaces, `target=_blank` ni URLs armadas con datos; el QR es un `<img>` con `data:image/svg+xml` (un SVG como imagen no ejecuta scripts ni carga nada; la CSP lo permite con `img-src data:`); `el.style.*` solo recibe colores ya validados como `#RRGGBB` (la CSP no bloquea CSSOM). **CSP**: sintaxis correcta, sin `unsafe-*`, sin estilos ni scripts en línea en el HTML; los formularios no tienen `name`, así que un envío nativo no pondría nada en la URL. **Sesión y MFA**: sin bucles (`mfaEnCurso`), 401/403/429 manejados, el código TOTP no se guarda ni se registra, la clave del QR se borra, el no-superadmin recibe el mismo mensaje y se cierra su sesión. **«Entrar como»**: solo `SA.apiLectura` (lista blanca de 4 lecturas), sin campos ni formularios, la barra con la navegación y «Cerrar sesión» se oculta, el id es el del detalle; no hay estado compartido con las pestañas de escritura. **Secretos**: `type=password`, nunca se rellenan, se vacían antes de esperar la respuesta y en éxito y en error; «Reemplazar» y «Permitir repetidos» empiezan apagados y se apagan después de cada intento. **Escrituras**: un solo envío en todas (botón bloqueado; el pago con su bandera); el servidor valida **todo** lo que valida la pantalla (nombre 1 a 120 sin `<>` ni invisibles, nombre corto y lista de reservados idénticos, zona, correo, meses 1 a 36, monto, referencia y nota; colores, tarifas y config en los SQL 13 y 16). La pantalla es más estricta solo en los días de prueba (0 a 90; el servidor acepta cualquier fecha válida y solo lo llama un superadmin con MFA). **`sw.js`** no toca la pantalla (no intercepta navegaciones ni `.html` y solo guarda `/Recursos/`). **Script de borrado**: el nombre corto se valida con `^[a-z0-9]+(-[a-z0-9]+)*$` y va con `encodeURIComponent` (no se puede meter `or=`, comas, paréntesis, comodines, mayúsculas, espacios ni Unicode en el filtro de PostgREST); el id que devuelve la base se valida como UUID; el demo se rechaza por id; cada `DELETE` lleva `restaurante_id=eq.<id>`; `--aplicar` sin escribir el nombre corto exacto no borra; no imprime la llave (solo la lee del entorno); si falla a la mitad se puede repetir (lo ya borrado no vuelve; el restaurante sigue y el siguiente intento continúa); no toca auditoría, usuarios de Authentication ni fotos (y lo dice al final). **Archivos servidos**: ningún secreto, llave de servicio ni URL interna en los archivos de la pantalla (solo la URL y la llave **publicable** de `supabase-publico.js`).

**Fuera de alcance (anotados por Carlos, no se tocaron):** (1) «SIN Sin tocineta» repetido en los pedidos de «entrar como»; (2) la columna «Restaurante» de la auditoría con el nombre corto; (3) «Ver resumen» en JSON crudo; (4) botón para regenerar la contraseña temporal.

**Verificación de la documentación (sección 24) contra el código y la documentación oficial**

| Afirmación | Veredicto |
|---|---|
| 24.2: mensaje idéntico para contraseña mala y para quien no es superadmin; a este se le cierra la sesión | CONFIRMADA (código y prueba 2) |
| 24.2: el QR es un `<img>` con el SVG de Supabase; la clave también llega para escribirla a mano | CONFIRMADA (Supabase: «returns an SVG QR code which you can convert into a data URL that you can place in an `<img>` tag», y devuelve «a QR code and a secret») |
| 24.2: sesión en `sessionStorage`, se pierde al cerrar la pestaña | CONFIRMADA, con matices: «Duplicar pestaña» la copia y otras páginas del mismo dominio en esa pestaña la pueden leer (R5) |
| 24.2: «Cerrar sesión» cierra la sesión en Supabase | CONFIRMADA: el alcance por defecto es **global** (todas las sesiones de esa cuenta). Supabase aclara que el token de acceso sigue válido hasta su `exp`, pero `api/superadmin.js` lo rechaza igual porque `GET /auth/v1/user` exige que la sesión exista (23.13) |
| 24.4: la contraseña temporal se borra sola a los 3 minutos | **PARCIAL**: son 180 tics de la pestaña (R4); texto corregido |
| 24.4: un triple clic crea un solo restaurante; el reintento hace solo lo que falta | CONFIRMADA (pruebas 10 y 11) |
| 24.7: las cabeceras protegen `/superadmin.html` y ninguna otra ruta las recibe | **INCORRECTA en parte**: con `%xx` la pantalla llegaba sin ellas (R1, corregido en la pantalla). Que ninguna otra ruta las recibe: CONFIRMADA en producción. Que `source` distingue mayúsculas y que con `trailingSlash` sin definir `/x/` sirve lo mismo que `/x`: CONFIRMADA (documentación de Vercel). Lo de `%xx` no está documentado: comprobado con `curl` |
| 24.7: «prueba de código» sin `innerHTML`/`eval` | **INCORRECTA como garantía**: se esquivaba con corchetes; ahora hay trampa en el navegador (I) |
| 24.7: «hoy las páginas públicas no corren scripts de terceros» | **INCORRECTA** (unpkg, Wompi, jsDelivr); corregido |
| 24.7: limitar la pantalla con una regla de `rewrites` con `has`/`missing` sobre `host` | **INCORRECTA**: en Vercel «precedence is given to the filesystem prior to rewrites being applied»; se usa `redirects`, que se procesan antes (este proyecto ya usa `redirects` con `has` sobre archivos estáticos) |
| 24.9: se niega siempre con pedidos pagados | **INCORRECTA antes de R3** (más de 1000 pedidos); CONFIRMADA ahora. El tope de 1000 filas por defecto de Supabase: CONFIRMADA |
| 24.9: no toca auditoría, usuarios de Authentication ni fotos | CONFIRMADA (código y prueba) |
| 24.3: mapa de botones y acciones | CONFIRMADA (cada botón llama a la acción de la tabla) |

**Pasos manuales de Carlos (corregidos):** los de 24.8 y 24.9 no cambian (el script de borrado se usa igual). Nuevos: (1) usa la pantalla **solo** en `https://taqueiros-2-0.vercel.app/superadmin.html` y **cierra sesión** antes de usar esa pestaña para otra cosa (R5); (2) escanea el QR en vez de «Copiar clave», y si copias la contraseña temporal, copia luego cualquier otro texto para sacarla del portapapeles (R8); (3) en la pestaña Secretos, rechaza si Chrome ofrece guardar o sugerir una contraseña (R9).

**Dominio de administración (recomendación).** *Cambio mínimo, cuando exista* (por ejemplo `admin.tu-dominio.com`): agregarlo en Vercel → Settings → Domains de este proyecto y poner **al principio** de `redirects` en `vercel.json`:

```json
{ "source": "/superadmin.html", "missing": [{ "type": "host", "value": "admin\\.tu-dominio\\.com" }], "destination": "https://admin.tu-dominio.com/superadmin.html", "permanent": false }
```

Gracias a R1, cualquier variante (`/%73uperadmin.html`…) termina en `/superadmin.html`, así que esa regla las cubre todas. *Ventajas:* la sesión del superadmin queda en un **origen propio** que ninguna página pública ni panel comparte (cierra R5) y la pantalla deja de verse bajo los dominios de los restaurantes. *Riesgos:* un error en `value` (es una expresión regular) haría un bucle de redirecciones o dejaría a Carlos sin pantalla: probarlo en una vista previa de Vercel antes de `main`; la CSP no cambia (`connect-src 'self'` sigue siendo el mismo despliegue). *Cuándo:* antes de dar de alta al segundo restaurante real, junto con la decisión del dominio (sección 21).

Sources: [Vercel: vercel.json (headers, case sensitivity, trailingSlash, rewrites y filesystem, redirects antes que rewrites)](https://vercel.com/docs/project-configuration/vercel-json) · [Supabase: MFA TOTP (QR SVG en `<img>`, secret)](https://supabase.com/docs/guides/auth/auth-mfa/totp) · [Supabase: Signing out (alcance global por defecto; los access tokens siguen hasta `exp`)](https://supabase.com/docs/guides/auth/signout) · [Supabase JS signOut](https://supabase.com/docs/reference/javascript/auth-signout) · [Supabase: tope de 1000 filas por defecto](https://supabase.com/docs/reference/javascript/v0/delete) · [Por qué una consulta de Supabase devuelve solo 1000 filas](https://subtracker.io/build/postgrest-pagination-row-limit)

### 24.14 Pruebas después de la revisión adversaria

| Batería | Antes | Ahora | Por qué cambia |
|---|---|---|---|
| `superadmin-pantalla.mjs` | 353 | **365** | +11 del escenario 20 (R1: tres direcciones con `%xx` llegan sin cabeceras y la pantalla se va a `/superadmin.html`, y en un marco no arma nada; R2: la respuesta vieja de `buscar_usuario` ya no decide el dueño, comprobado en la base) y +1 de la trampa de sumideros (I). El sitio de prueba ahora elige las cabeceras por la ruta **cruda**, como Vercel |
| `borrar-prueba-test.mjs` | 31 | **32** | +1 (R3): 1001 pedidos sin pagar y uno pagado al final, con el tope de 1000 filas de Supabase: se niega y no borra nada |
| `mutaciones-pantalla.mjs` | 61 (55 + 6 equivalentes) | **70: 62 detectadas, 8 equivalentes, 0 sin detectar** | +7 de R1, R2 y R3, +2 de I (`innerHTML` con corchetes; alias de `insertAdjacentHTML`), 2 del borrado reescritas (cambió el texto). Primera pasada: **1 sin detectar** (el alias de `insertAdjacentHTML`): por eso se agregó la trampa. Equivalentes nuevas: descartar la respuesta vieja de R2 sola (el paso 3 vuelve a comprobar) y el `DELETE` de pedidos que excluye pagados (solo cubre un pago en ese mismo instante) |
| unitarias 172, superadmin 84 (68 sin SQL 19), servidor 262, tema claro 43, e2e 193; contra el falso: compatibilidad 26, servidor 249, opciones 38, superadmin 50, superadmin-mfa 33, aislamiento 252 de 259 | — | **sin cambios** | (las 7 de Realtime fallan con el falso, por diseño; son las mismas 7) |

**Sin SQL nuevo, sin cambios en `api/` ni en `vercel.json`, siguen 7 de 12 funciones.** Archivos de producción tocados: `superadmin-inicio.js`, `superadmin-alta.js` (ambos solo los sirve Vercel a quien abre la pantalla) y `supabase/borrar-restaurante-prueba.mjs` (solo corre en el computador de Carlos).
