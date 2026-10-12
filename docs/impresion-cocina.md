# Impresión automática de comandas en la cocina

Guía de montaje del computador de la cocina. Cuando entra un pedido web
pagado, el panel (`panel.html`) imprime solo su comanda en la impresora
térmica **Digital POS DIG-POS892** (USB, papel de 80 mm, corte automático).

La impresión sale **desde el navegador**: Chrome en Windows, con el
parámetro `--kiosk-printing` (imprime directo a la impresora
predeterminada, sin ventana de diálogo) y el driver de Windows de la
impresora. No se usa WebUSB ni se instala ningún programa extra.

> Esta carpeta (`docs/`) no se publica en el sitio: está en `.vercelignore`.

---

## 0. Antes de empezar: ejecutar el SQL (una sola vez)

El panel necesita dos columnas y dos funciones nuevas en Supabase para
**no imprimir nunca dos veces** un pedido, aunque haya dos pantallas
abiertas o se recargue la página.

1. Entra a Supabase → tu proyecto → **SQL Editor** → **New query**.
2. Abre el archivo `supabase/02-impresion.sql` de este repositorio,
   copia todo su contenido y pégalo.
3. Pulsa **Run**.
4. Al final aparece una tabla de comprobación: **todas** las filas deben
   decir `OK`. Si alguna dice `REVISAR`, no sigas: copia la tabla y
   consúltalo.

Es seguro volver a ejecutarlo. Los pedidos que ya existen al correrlo por
primera vez se marcan como "ya impresos" (la cocina los sacó desde el
POS), para que el primer panel que se abra no intente imprimir todo lo
de la jornada.

Si el SQL todavía no se ha corrido, el panel **sigue funcionando**: en la
pantalla que imprime aparece el aviso *"Falta ejecutar el SQL 02 en
Supabase"* y evita duplicados solo dentro de ese mismo equipo.

Prueba opcional de seguridad (debe terminar en "TODO BLOQUEADO"):

```powershell
node supabase/probar-impresion-rls.js
```

---

## 1. Instalar el driver de la impresora

1. Conecta la DIG-POS892 por USB al computador de la cocina y enciéndela.
2. Instala el **driver de Windows del fabricante (Digital POS)** para la
   DIG-POS892. Usa el instalador que venga con la impresora o el que
   publique el fabricante para ese modelo.
   - Evita el driver genérico "Generic / Text Only": imprime texto plano
     sin tamaños, negrillas ni ñ/tildes confiables.
3. Cuando termine, la impresora debe aparecer en
   **Configuración → Dispositivos → Impresoras y escáneres** (Windows 10;
   en Windows 11: *Bluetooth y dispositivos → Impresoras y escáneres*).

### Preferencias de impresión del driver

Abre las preferencias de la impresora (en la lista de impresoras →
**Preferencias de impresión**) y revisa:

| Ajuste | Valor |
| --- | --- |
| Tamaño de papel | Rollo de **80 mm** (el nombre varía: "80mm", "Roll 80", "80 x 297"…). **El que se probó y funciona: 80 × 297 mm** (ver "Ajustes con los que se probó" abajo) |
| Cortar papel | **Al final de cada documento** (cada ticket es un documento) |
| Márgenes | Los más pequeños que permita (el ticket ya trae margen de página 0; ver 5.2) |
| Densidad / velocidad | La que dé una impresión negra y nítida |

El nombre exacto de cada opción depende del driver. Si algo no aparece,
usa el ticket de prueba (sección 5) para calibrar.

### Ajustes con los que se probó (DIG-POS892)

Estos son los ajustes con los que se hicieron las pruebas de impresión y
con los que el modo de hoja **D** (sección 5.4) funciona bien. Si en otra
impresora o PC algo sale distinto, vuelve primero a estos:

| Dónde | Ajuste | Valor probado |
| --- | --- | --- |
| Driver instalado | Nombre | **80mm Series Printer** |
| Preferencias de impresión → pestaña **Configuración** | Tamaño de papel (hoja del driver) | **80 × 297 mm** |
| Preferencias de impresión → pestaña **Configuración** | Cortar papel | **Cut at end of document** (corta una sola vez, al final del documento) |
| Chrome | Parámetro | `--kiosk-printing` (sección 3) |

No cambies el tamaño de hoja del driver a otro alto "para ahorrar papel":
con hojas más cortas que 297 mm el driver baja la hoja desde el borde y
deja de 6 a 9 cm de blanco arriba (sección 5.4).

---

## 2. Dejarla como impresora predeterminada

`--kiosk-printing` imprime a la impresora **predeterminada**.

1. **Configuración → Dispositivos → Impresoras y escáneres**.
2. Baja y **desactiva** "Permitir que Windows administre mi impresora
   predeterminada" (si no, Windows la cambia según la última usada).
3. Pulsa la DIG-POS892 → **Establecer como predeterminada**.

---

## 3. Acceso directo de Chrome con `--kiosk-printing`

1. Clic derecho en el escritorio → **Nuevo → Acceso directo**.
2. En "Ubicación del elemento" pega (todo en una línea):

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing --user-data-dir="C:\TaqueirosPanel" --app=https://taqueiros-2-0.vercel.app/panel.html
   ```

   - Si el sitio en producción usa otra dirección, cámbiala en `--app=`.
   - Si Chrome está en `Program Files (x86)`, ajusta la ruta.
3. Nómbralo **"Panel Taqueiros (cocina)"** y termina.

Por qué cada parte:

- `--kiosk-printing`: imprime sin diálogo. **Solo funciona si Chrome se
  inicia con él.** Si Chrome ya estaba abierto, la ventana nueva se une
  al Chrome que ya corría y el parámetro se ignora. Por eso el acceso
  directo usa su propia carpeta:
- `--user-data-dir="C:\TaqueirosPanel"`: un perfil de Chrome **exclusivo**
  del panel. Garantiza que arranque con el parámetro, y deja guardados
  ahí la sesión y el interruptor de impresión. Úsalo **siempre** desde
  este acceso directo; si abren el panel desde otro Chrome, el interruptor
  aparecerá apagado y se imprimirá con diálogo.
- `--app=...`: ventana sin barra de direcciones ni pestañas, difícil de
  cerrar por accidente.

### Paso obligatorio en cada PC nueva: apagar "Encabezados y pies de página"

Hazlo **una sola vez por equipo, antes del primer arranque**; sin esto
Chrome puede dibujar fecha, título, URL y "1/1" en el ticket (sección 5.2).

1. Cierra el panel de la cocina si estaba abierto.
2. Abre Chrome **sin** `--kiosk-printing`, con el mismo perfil de la
   cocina, escribiendo esto en *Win + R* (o en un símbolo del sistema):

   ```
   chrome.exe --user-data-dir="C:\TaqueirosPanel" https://taqueiros-2-0.vercel.app/panel.html
   ```

   (Si `chrome.exe` no se reconoce, usa la ruta completa:
   `"C:\Program Files\Google\Chrome\Application\chrome.exe"`.)
3. Con esa ventana en primer plano, pulsa **Ctrl + P**.
4. En el diálogo abre **Más ajustes** y **desmarca "Encabezados y pies de
   página"**.
5. **Cierra el diálogo sin imprimir** (Cancelar o Esc) y cierra Chrome.

Chrome recuerda la opción en el perfil `C:\TaqueirosPanel`. Después abre
el panel con el acceso directo de la cocina e imprime el ticket de prueba
para confirmar que no sale ni encabezado ni pie.

### Primer arranque

1. Abre el acceso directo, inicia sesión con el usuario del panel (la
   sesión queda guardada en ese perfil).
2. Activa **"Imprimir comandas en esta pantalla"** (arriba). El
   indicador debe pasar a **ACTIVA**. Ese interruptor se guarda **solo
   en este equipo**: no lo actives en otros computadores ni en el celular.
3. Opcional: para que arranque con Windows, copia el acceso directo a
   `shell:startup` (Win + R → `shell:startup`).

> Si al imprimir sale el diálogo de impresión de Chrome, es porque el
> panel no se abrió con `--kiosk-printing`: cierra **todas** las ventanas
> de ese perfil y vuelve a abrir con el acceso directo.

---

## 4. Que el equipo no se duerma ni oculte la ventana

Para que se imprima, el equipo debe estar encendido, con internet, y la
ventana del panel **visible**.

**Reposo de Windows**
1. **Configuración → Sistema → Inicio/apagado y suspensión** (Windows 10;
   en Windows 11: *Sistema → Energía y batería*).
2. Pantalla y suspensión: **Nunca** apagar la pantalla y **Nunca**
   suspender (en corriente).
3. Panel de control → Opciones de energía → Cambiar la configuración del
   plan → Cambiar la configuración avanzada → **Configuración de USB →
   Suspensión selectiva de USB → Deshabilitada** (evita que Windows
   duerma el puerto de la impresora).
4. **Windows Update**: define "horas activas" que cubran el horario del
   local para que no se reinicie en pleno servicio.

**Ventana visible**
- No minimizar el panel ni dejarlo tapado por otras ventanas. Chrome
  puede considerar "oculta" una ventana minimizada o cubierta por completo,
  y en ese estado el panel **espera** a que vuelva a verse antes de imprimir
  (la comanda queda pendiente, no se pierde).
- El panel pide al navegador mantener la pantalla encendida mientras la
  impresión automática está activa (Wake Lock). Es un refuerzo, no
  reemplaza los ajustes de reposo de arriba.

---

## 5. Comprobar con el ticket de prueba

1. En el panel, pulsa el engranaje **⚙️** (junto al interruptor de
   impresión).
2. Revisa que "Base de datos" diga **Lista** y "Pantalla encendida" diga
   que se mantiene encendida.
3. Pulsa **Imprimir ticket de prueba**.

Debe salir un solo ticket, marcado **TICKET DE PRUEBA**, con un nombre y
una dirección muy largos, ñ y tildes. Comprueba:

- [ ] Ningún texto se corta a la izquierda ni a la derecha.
- [ ] Las **ñ** y las tildes salen bien (María, Muñoz, Peña, ñoños).
- [ ] La franja "DOMICILIO · WEB · PAGADO" y el número se leen a un metro.
- [ ] El nombre de cada producto se lee de lejos.
- [ ] **No hay encabezado ni pie** de Chrome (ni fecha y título arriba, ni URL y "1/1" abajo).
- [ ] El corte cae **debajo** de la línea final, sin comerse texto.
- [ ] No sale papel en blanco extra después del ticket (unos 4–5 mm bajo "LOS TAQUEIROS · PEDIDO WEB", más ~3 cm que avanza la propia impresora hasta la cuchilla: son normales, sección 5.3).
- [ ] El ticket arranca a ~1 cm del borde del papel, sin 6–9 cm de blanco arriba (modo de hoja **D**, sección 5.4).
- [ ] El texto tiene un tamaño cómodo; si no, cámbialo en **Tamaño del ticket** (sección 5.1).

| Si ocurre… | Prueba… |
| --- | --- |
| Sale el diálogo de Chrome | El panel no se abrió con `--kiosk-printing` (sección 3) |
| Texto cortado a los lados | Preferencias del driver: papel de 80 mm y márgenes mínimos |
| ~3 cm de blanco al final | Es normal: distancia del cabezal a la cuchilla (sección 5.3) |
| Mucho más blanco al final | Tamaño de papel del driver: la hoja de 80 × 297 mm de la sección 1; el driver recorta el blanco del final |
| Blanco de 6 a 9 cm **arriba** | El modo de hoja no es D: ⚙️ → *Modo de hoja* → D (sección 5.4) |
| Un pedido sale en dos hojas | Si tiene más de ~20 productos es lo esperado (sección 5.5); si es corto, revisa que el tamaño de hoja del driver sea 297 mm |
| No corta | "Cortar papel" del driver en "Al final de cada documento" |
| El corte se come la última línea | Subir `MARGEN_INFERIOR_MM` en `ticket-comanda.js` (sección 5.3) |
| Aparece encabezado o pie de Chrome | Sección 5.2: revisar el margen de página y, si hace falta, apagarlo en el perfil |
| El texto sale muy grande o muy chico | **Tamaño del ticket** en ⚙️ (sección 5.1) |
| Imprime en otra impresora | Sección 2: predeterminada y administración automática desactivada |

### 5.1 Tamaño del ticket

En **⚙️ → Tamaño del ticket** se elige **Pequeño / Normal / Grande**. Se
guarda **solo en ese equipo** (en el navegador del perfil
`C:\TaqueirosPanel`) y lo usan todas las impresiones de esa pantalla:
comandas automáticas, **Reimprimir** y el ticket de prueba. Si el navegador
no puede guardarlo, queda en **Pequeño**.

| Tamaño | Escala del texto | Para qué |
| --- | --- | --- |
| **Pequeño** (por defecto) | 0,75 | Uso diario; menos papel (el que se vio mejor en la DIG-POS892) |
| Normal | 0,85 | Un poco más grande |
| Grande | 1,00 | El diseño original; cocina con poca luz o vista cansada |

(Un equipo que ya tenía guardado Normal o Grande lo conserva: el cambio de
valor por defecto solo afecta a los equipos que no habían elegido.)

La escala multiplica **todas** las fuentes por igual (variable CSS
`--escala`), así que la jerarquía no cambia: número de pedido, cantidad
(`2x`) y nombre del producto siguen siendo lo más grande; dirección, notas y
datos del cliente, más chicos. Los bordes y separadores no se escalan.

Después de cambiarlo, pulsa **Imprimir ticket de prueba** para verlo.

### 5.2 Encabezado y pie de Chrome

Chrome, al imprimir, agrega por su cuenta un encabezado (fecha, hora y
título de la página) y un pie (URL y número de página). **No son parte del
ticket**: se dibujan en el *margen de página*, y el ticket los elimina
declarando ese margen en cero:

```css
@page { size: 80mm <alto>mm; margin: 0; }
```

- El margen de página es **0**; el aire del ticket lo pone el **contenido**:
  3 mm arriba, y la columna de 72 mm **centrada** en los 80 mm (4 mm por
  lado). Abajo, ver 5.3.
- Se verificó en el motor de Chrome que con ese CSS el PDF sale **idéntico**
  con el encabezado/pie activados y desactivados (= no se dibuja ninguno), y
  que con el margen por defecto sí se dibujan.
  `node pruebas/impresion/generar-pdfs.js` repite esa comprobación.
- Además, mientras dura la impresión, la misma regla `@page` se repite en
  el documento del panel (el que contiene al marco oculto) y se retira
  después. Es una segunda barrera por si el motor de impresión leyera la
  regla del documento padre y no la del marco.

> **Si algún día vuelve a aparecer encabezado o pie, revisa ese margen
> primero:** `@page{...margin:0...}` en `PLANTILLA` y en `ajustarPagina`
> (`ticket-comanda.js`), y que nadie le haya puesto `padding` lateral al
> `body` ni cambiado `margin:0`. Un margen de página distinto de 0 hace que
> Chrome los dibuje.

**Aunque el CSS esté bien, Chrome los dibuja** (se vio con la DIG-POS892 al
imprimir desde el marco oculto con `--kiosk-printing`) mientras la opción
siga marcada en el perfil. Por eso apagarlos es un **paso obligatorio en
cada PC nueva** (sección 3, "Paso obligatorio en cada PC nueva"):

1. **Por perfil (el paso obligatorio):** con el panel cerrado, abre
   `chrome.exe --user-data-dir="C:\TaqueirosPanel" https://taqueiros-2-0.vercel.app/panel.html`
   **sin** `--kiosk-printing`, pulsa `Ctrl+P`, abre **Más ajustes**,
   desmarca **Encabezados y pies de página** y cierra el diálogo sin
   imprimir. Chrome recuerda esa opción en el perfil. Vuelve a abrir con el
   acceso directo de la cocina e imprime el ticket de prueba para
   confirmarlo.
2. **Por política (opcional, complementa a la 1):** en el Registro, clave
   `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome`, valor `DWORD`
   `PrintHeaderFooter` = `0` (requiere administrador). Aplica a todos los
   perfiles del equipo.

Confírmalo siempre con el ticket de prueba: el motor de impresión de
Chrome sin impresora (los PDF de `pruebas/impresion/`) no reproduce este
comportamiento del equipo real.

### 5.3 Papel en blanco al final

Debajo de la última línea el ticket deja **`MARGEN_INFERIOR_MM` = 4 mm**
(constante en `ticket-comanda.js`, `padding` inferior del `body`). En el
modo D (el definitivo, sección 5.4) la hoja que se pide es siempre de
297 mm y el contenido queda pegado arriba; el driver **recorta solo el
blanco del final de la hoja**, así que el papel que sale es el ticket más
ese margen más la distancia a la cuchilla.

- **Los ~3 cm de blanco al final son normales**: es la distancia física
  entre el cabezal de impresión y la cuchilla de la impresora. La impresora
  tiene que avanzar el papel esos centímetros para que el corte caiga
  *debajo* de la última línea. No son un error del ticket ni se arreglan
  por software.
- Ese margen de 4 mm es solo aire. **Más margen = más papel gastado en
  cada ticket.**
- Si el corte se come "LOS TAQUEIROS · PEDIDO WEB", sube la constante (prueba
  con 8) y sube el `?v=` del `<script>` en `panel.html`. Nada más.

### 5.4 Modo de hoja: D es el recomendado para la DIG-POS892

**Resultado de las pruebas en la DIG-POS892** (driver "80mm Series Printer",
hoja del driver 80 × 297 mm, "Cut at end of document", Chrome con
`--kiosk-printing`):

| Modo | Qué hizo el equipo real |
| --- | --- |
| **D** (`@page 80mm 297mm`, contenido pegado arriba) con tamaño *Pequeño* | **Funciona.** El ticket arranca a ~1 cm del borde; aprobado. |
| **A** y **C** (hoja más corta que 297 mm) | El driver baja la hoja desde el borde y deja de **6 a 9 cm de blanco arriba**. |
| **B** (`size:auto`) | Sale igual que D: Chrome ignora `size:auto`. |

**Por qué D es el definitivo:**

1. **El driver trabaja con una hoja de 297 mm** (la de sus preferencias,
   ver sección 1). Cuando Chrome le pide una hoja más corta, el driver baja
   esa hoja desde el borde: de ahí el blanco arriba en A y C (es lo que se
   observó; el driver no documenta el porqué). Pidiéndole exactamente
   297 mm no hay nada que bajar y el contenido queda pegado arriba.
2. **El driver recorta solo el blanco del final de la hoja.** Con D el
   papel que sale es el ticket más una cola corta, no 297 mm de papel.
3. Al final siempre quedan **~3 cm de blanco**: es la distancia entre el
   cabezal y la cuchilla (sección 5.3). Es normal.

D es el modo **por defecto**: un equipo sin valor guardado, o con un valor
inválido, usa D. Un equipo que ya eligió otro modo conserva el suyo. En el
selector del panel (⚙️ → *Modo de hoja*) D dice *«recomendado para la
DIG-POS892»*; A, B y C siguen disponibles solo como opciones de prueba.

**Lo que se revisó en el código** cuando se vio el blanco arriba: nada del
ticket lo centra ni lo estira (sin `min-height`, `height:100vh`, flex
vertical ni `margin:auto` vertical; el `body` solo se centra a lo ancho).
Se imprime únicamente el iframe oculto de `imprimir()`. El centrado lo hace
el driver con las hojas más cortas que la suya.

#### Modo de hoja (⚙️ → *Modo de hoja*)

Se guarda **por equipo** (en el navegador del perfil `C:\TaqueirosPanel`);
si no hay nada guardado o el valor no es válido, es **D**. Lo usan por igual
las comandas, las reimpresiones, el ticket de prueba y la hoja de
calibración. Solo cambia el largo de hoja que se le pide a Chrome: el
contenido del ticket es idéntico.

| Modo | `@page` que se pide | `html` / `body` | Para qué |
| --- | --- | --- | --- |
| **A** Altura medida | `size:80mm <alto>mm; margin:0` con `<alto>` = lo que mide el ticket, redondeado al mm superior | alto fijo `<alto>mm` y `overflow:hidden` | Prueba. Con la DIG-POS892 deja 6–9 cm de blanco arriba |
| **B** Automático | `size:80mm auto; margin:0` | `height:auto` | Prueba. Chrome ignora `auto`: sale como D |
| **C** Altura medida + 1 mm | Como A pero `<alto>` + 1 mm | `height:auto` y `overflow:hidden` | Prueba. Igual que A |
| **D** Hoja fija (por defecto) | `size:80mm 297mm; margin:0` | `height:auto`; el contenido queda pegado arriba | **El de uso diario.** Pedidos de más de una hoja: ver 5.5 |

> Nota: en el motor de Chrome (PDF) `size:80mm auto` **no se respeta**: el
> PDF del modo B sale en tamaño Carta (215,9 × 279,4 mm). Es normal; en la
> impresora real decide el driver. El modo B existe para ver justo eso.

#### Hoja de calibración (⚙️ → *Imprimir hoja de calibración*)

Pasa por el **mismo camino** que una comanda (mismo iframe, misma regla
`@page` y mismo modo). Dibuja, con `position:fixed` (no mueve nada):

- **Marco de 1 mm** con el tamaño de la **página solicitada** (80 mm × el alto
  del modo). Su borde de abajo lleva el rótulo *FIN DE LA PAGINA SOLICITADA*.
- **Línea gruesa (2 mm) arriba y abajo de la página real**, es decir, de la
  hoja que Chrome está usando de verdad (`top:0` y `bottom:0`).
- **Regla** a la izquierda: marca cada **10 mm**, más larga y con número cada
  **50 mm**. Se mide desde la línea gruesa de arriba.
- Texto grande: `MODO: <modo> · ALTO SOLICITADO: <X> mm · ANCHO: 80 mm`
  (en modo B, `ALTO SOLICITADO: AUTO`), más el alto de contenido medido.

**Cómo leer la foto del papel**

| Qué se ve | Qué significa |
| --- | --- |
| La línea gruesa de abajo cae justo en el borde del marco | La página que usa Chrome mide lo solicitado: el alto sí se respeta |
| La línea gruesa de abajo cae **mucho más abajo** que el marco (p. ej. el marco termina en 150 mm y la línea en 297 mm) | Chrome/el driver usan una hoja más larga que la pedida: no respetan el alto de `@page` |
| Hay blanco **antes** de la línea gruesa de arriba | La página pedida está centrada o desplazada dentro de la hoja física |
| Sale el encabezado o el pie de Chrome | `@page{margin:0}` no se está aplicando (ver 5.2) |
| Salen dos hojas | La página real es más corta que el contenido (probar C) |
| La regla marca 297 en la línea de abajo en el modo D y el ticket de prueba queda arriba sin blanco antes | El driver respeta la hoja fija y no centra; el sobrante queda abajo |

**Orden sugerido de pruebas** (solo si cambia la impresora o el driver, o
si en otro equipo el ticket vuelve a salir con blanco arriba; con la
DIG-POS892 y los ajustes de la sección 1 ya está resuelto: D). Anota qué
número de regla cae en la línea gruesa de abajo y cuánto blanco hay arriba,
en cada modo:

1. Modo **D** → imprimir la hoja de calibración y un ticket de prueba
   (referencia).
2. Modo **A** → imprimir la hoja de calibración.
3. Modo **B** y modo **C** → imprimir la hoja de calibración.
4. Elegir el modo con el que el papel salga más corto y sin blanco arriba, y
   dejarlo guardado. Si ninguno lo logra, el largo lo está fijando el driver:
   revisar en *Preferencias de impresión* el tamaño de papel (debe ser la
   hoja de 80 × 297 mm de la sección 1) y, para el encabezado y pie, la
   sección 5.2.

Esto solo se puede confirmar **imprimiendo**: en el motor de Chrome sin
impresora (los PDF de `pruebas/impresion/`) cada modo sale como se pide, que
no es lo mismo que lo que hace la impresora.

### 5.5 Pedidos largos (más de una hoja de 297 mm)

En modo D la hoja es de 297 mm: con el tamaño *Pequeño* caben unos 20 productos con algunas notas (más si no llevan notas).
Un pedido más largo se parte en hojas, y esa partición es **limpia**:

- **Ningún producto se corta**: cada producto (con sus notas), el bloque
  de *Notas del pedido*, el bloque de totales (productos, domicilio, TOTAL,
  forma de pago y pie "LOS TAQUEIROS · PEDIDO WEB") y el bloque de datos
  del cliente (cliente, teléfono, dirección, barrio y avisos) van enteros
  en una hoja. Se logra con `break-inside: avoid` y, además, el corte lo
  calcula `ticket-comanda.js` (`repartirHojas` / `paginarHojas`) para que
  caiga siempre entre productos.
- **Cada hoja después de la primera empieza con una línea pequeña
  `#<número> · continuación`** (por ejemplo `#087 · continuación`), para
  saber de qué pedido es esa tira de papel.
- **"Cut at end of document" corta una sola vez, al final del documento**:
  las hojas del pedido salen seguidas, en el mismo papel, y la cuchilla
  actúa tras la última. Hay que arrancarlas/leerlas en orden; la línea de
  continuación está justo para eso.
- El corte deja 5 mm de seguridad al fondo de cada hoja (4 mm del margen
  inferior + 1 mm de holgura) para que el redondeo de Chrome nunca abra una
  hoja de más. Por eso una hoja puede quedar con algo de blanco abajo.
- Solo aplica al modo D. En A, B y C no se parte (son modos de prueba).

Se verifica con `node pruebas/impresion/ticket-largo.js`: imprime a PDF
pedidos de 20 a 60 productos con el Chrome real, lee el texto de cada hoja
y comprueba que no haya productos partidos, que cada hoja siguiente lleve
su línea de continuación y que no sobre ninguna hoja. Deja de ejemplo
`pruebas/impresion/ticket-pedido-largo-pequeno.pdf` (30 productos, 2 hojas).

> **Qué solo se confirma imprimiendo:** que el driver entregue las dos
> hojas seguidas sin recortar el blanco que queda al pie de la primera, y
> que la cuchilla corte una sola vez al final. El PDF solo prueba lo que
> hace el motor de Chrome.

## 6. Cómo funciona en el día a día

- **Pedido pagado entra** → suena como siempre y, en la pantalla de
  cocina, se imprime solo, una vez.
- **Varios pedidos a la vez** → se imprimen en orden de llegada, uno por
  ticket, con una pausa corta (2,5 s) para que la impresora corte entre
  uno y otro.
- **Al abrir el panel o reconectarse** → imprime los pedidos pagados,
  activos y de la jornada en curso que no se hayan impreso. Si hay **más
  de 5**, no los imprime todos: muestra un aviso con el número y el botón
  **Imprimir pendientes**.
- **Nunca se imprimen solos** los pedidos entregados, cancelados ni los
  que no se han pagado.
- **Reimprimir**: cada tarjeta tiene un botón **🖨️ Reimprimir**. El ticket
  sale marcado **REIMPRESIÓN** y no cambia la marca de impresión
  original. Funciona en cualquier pantalla, esté o no activo el
  interruptor.
- Con el interruptor **apagado** (por defecto), esa pantalla no imprime
  nada sola.

---

## 7. Límites que hay que conocer

- **El computador de la cocina debe estar encendido, con Chrome abierto
  y la ventana visible.** El panel es una página web: no imprime desde un
  servidor. Si el equipo está apagado o dormido, nada sale.
- **Sin internet no llegan pedidos nuevos ni se reclama la impresión.**
  Al volver la conexión, el panel recarga y imprime lo que quedó
  pendiente (más de 5 → aviso con botón). Los pedidos siguen guardándose
  en Supabase aunque el panel esté caído.
- **Si se cae la impresora o se acaba el papel**, el navegador igual
  entrega el trabajo y el panel no se entera: el pedido queda marcado
  como impreso. Hay que usar **Reimprimir**. El panel solo avisa si el
  navegador mismo lanza un error.
- **Cancelar el diálogo** (en un equipo sin `--kiosk-printing`) también
  deja el pedido como impreso. Mismo remedio: Reimprimir.
- **Dos pantallas de cocina** no duplican: la base entrega cada pedido a
  una sola. Pero solo con el SQL 02 ejecutado; sin él, cada equipo evita
  duplicados solo para sí mismo.
- Los pedidos de **antes** de ejecutar el SQL 02 se consideran impresos.
- El panel conserva la sesión; si Supabase la expira, hay que volver a
  entrar para que sigan saliendo comandas.

## 8. Qué se guarda en la base

| Columna (`pedidos`) | Significado |
| --- | --- |
| `impreso_en` | Cuándo salió la impresión automática. `null` = pendiente |
| `reimpresiones` | Cuántas veces se usó "Reimprimir" |
| `reimpreso_en` | La última reimpresión |

Solo el personal autorizado (tabla `personal`) puede llamar
`reclamar_impresion` y `registrar_reimpresion`; el público anónimo no.
Ninguna de las dos devuelve datos de clientes.

## 9. Para quien mantiene el código

- Ticket: `ticket-comanda.js` (se carga desde `panel.html`; si cambia,
  sube el `?v=` del `<script>` y la versión de `sw.js`). Sus constantes
  de diseño: `ANCHO_PAGINA_MM`, `ANCHO_UTIL_MM`, `MARGEN_SUPERIOR_MM`,
  `MARGEN_INFERIOR_MM` y `ESCALAS`. La hoja se pide con `planHoja` /
  `ajustarHoja` (modos A–D, sección 5.4; el defecto es D) y la hoja de
  calibración con `imprimirCalibracion`. Los pedidos de más de una hoja se
  parten con `repartirHojas` / `paginarHojas` (sección 5.5); si agregas un
  bloque nuevo al ticket que no deba partirse, añádelo a la regla
  `break-inside:avoid` de `ESTILOS`.
- PDF del pedido largo (modo D, 30 productos) y su verificación con el
  texto de cada hoja: `node pruebas/impresion/ticket-largo.js` (necesita
  Chrome y `pdftotext`).
- PDFs de ejemplo (3 tamaños × prueba y pedido típico) en
  `pruebas/impresion/ticket-*.pdf`; se regeneran con
  `node pruebas/impresion/generar-pdfs.js`, que además comprueba 1 página,
  80 mm de ancho y ausencia de encabezado/pie. Se piden en modo A (hoja
  del alto del ticket) para poder comparar los tamaños de texto; el modo D
  de producción da hojas de 297 mm casi vacías. Son una vista del **motor
  de Chrome**, no del papel real.
- Lógica de cola e impresión automática: sección "IMPRESION AUTOMATICA
  DE COMANDAS" de `panel.html`.
- Pruebas: `node --test pruebas/ticket-comanda.test.js` (rápida) y
  `node pruebas/impresion/e2e.js` (navegador sin interfaz con Supabase
  simulado, ~2 minutos). Ver el encabezado de `e2e.js` para guardar los
  tickets y las capturas.
