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
> **"Datos de mi restaurante"** del dueño (`supabase/15-datos-restaurante.sql`, que además valida el horario). Sigue pendiente la interfaz del superadmin (17.9).

Contenido: 1. Inventario anterior · 2. Diseño nuevo · 3. Matriz de permisos · 4. Decisiones ·
5. Qué se conserva para no romper nada · 6. Orden de pasos en Windows · 7. Lo que queda para el siguiente paso ·
8. Qué se probó y qué no · 9. Riesgos · 10. Revisión de seguridad del SQL 10 · 11. Fallo `pg_statistic` ·
12. Servidor multi-restaurante (SQL 11 + api/) · 13. Revisión adversaria del servidor ·
14. Frontend público multi-restaurante (SQL 12) · 15. Paneles del personal por restaurante ·
16. Endurecer la base (SQL 13 y 14) y mover las fotos de la raíz ·
**17. Agrupar endpoints, vista previa de enlaces y "Datos de mi restaurante" (SQL 15)**

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
8. **`?clave=` del cron** y el defecto transitorio no se retiraron (se pidió dejarlos).
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
| P13 | Bajo | Ventana de milisegundos entre la relectura del restaurante y el insert: un pedido puede entrar justo al suspender. `seguimiento(ref)` sigue siendo global por referencia (impredecible); `?clave=` del cron sigue aceptándose. | Aceptado / tarea del front (ya listados en 12.11). |

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

**Resultado: 6 funciones de 12** (`crear-pedido`, `cron`, `generar-firma`, `publico`, `reembolso`, `webhook-wompi`). Quedan 6 libres para el superadmin. Una prueba falla si
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
| `/api/alertas` | cron-job.org (`Authorization: Bearer` o `?clave=`) | `/api/cron?_ruta=alertas` | `cron` → `alertas` |
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
curl.exe -s -o NUL -w "alertas con ?clave=: %{http_code}`n" "$h/api/alertas?clave=$e"                        # 200 (la compatibilidad sigue)
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
7. **Panel de superadmin:** hay 6 funciones libres. `api/_sesion.js` ya existe; el panel actual **no deja entrar a un superadmin que no sea miembro** (15.3), así que la interfaz deberá traer su camino de "entrar como". `guardar_datos_restaurante`
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
2. **Vista previa.** Solo usa `_publico.js` (lo mismo que `/api/restaurante`): ni plan, ni vigencia, ni gracia, ni secretos, ni el resto de `config`. Todo valor pasa por `esc()` (`& < > " '`); un salto de línea en un atributo no rompe nada y `texto()` ya los vuelve espacio; `inyectar` arma la página con `slice` (sin `$&` de `replace`). `_pagina` es una lista cerrada (`pedido`, o si no `index`): no lee otro archivo; la redirección a una persona va a una ruta fija (`/` o `/pedido.html`), nunca a un dato de la petición. `Cache-Control: private, no-store` + `Vary: Host, User-Agent` en la página, y `private, no-store` en el 302 a personas. La 307 de Vercel no es "cacheable por heurística" (RFC 9111) sin `max-age`; en el paso B de 17.8 conviene mirar que no traiga `max-age` mayor que 0.
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
* `?clave=` del cron queda en el log de Vercel y en cron-job.org (se mantiene a propósito; recomendación en 18.2-1).
* El límite de peticiones (P4) sigue sin implementar (propuesta C).
* Una alerta que falla ahora se reintenta cada pasada del cron mientras el pedido siga sin atender dentro de la ventana de 2 h (máximo 10 por restaurante por pasada): con una apikey inválida, CallMeBot recibe esos intentos (antes recibía uno). Es lo que pedía el diseño ("un fallo de envío permite reintentar").
* `Vary: Host` del borde (P5), Preview de Vercel (P2), Realtime y `DELETE`, P6–P13: sin cambios.
