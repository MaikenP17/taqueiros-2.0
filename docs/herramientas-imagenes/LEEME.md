# Herramientas locales de imagen (apoyo, NO forman parte del proyecto)

Las usó el rebrand a "The Northe Burgers" (docs/multirestaurante.md, seccion 20). Son scripts sueltos de Python 3 con
Pillow que ya estaban en el PC: no se instalan en el proyecto, no estan en package.json y nada del sitio ni de las pruebas
los ejecuta. Se dejan aqui para poder repetir el proceso con otro restaurante sin depender de la memoria de nadie.

| Script | Para que | Uso |
|---|---|---|
| `medir-colores-logo.py` | Mide crema, rojo, marron y mostaza sobre el logo ORIGINAL promediando regiones planas | `python medir-colores-logo.py <logo>` |
| `preparar-logo-e-iconos.py` | Logo recortado al contenido (800 px) e iconos 192 y 512 sobre fondo solido | `python preparar-logo-e-iconos.py <logo> <carpeta de salida>` |
| `preparar-fotos.py` | Fotos a 4:3, 1200x900, JPG < 300 KB; la tabla `FOTOS` dice el encuadre de cada una (y0) | `python preparar-fotos.py <carpeta> <carpeta de revision>` |
| `contraste-wcag.py` | Contraste WCAG de la paleta contra las reglas CSS reales de las 5 paginas | `python contraste-wcag.py <raiz del proyecto>` |

Los colores medidos del logo del demo estan escritos dentro de `preparar-logo-e-iconos.py` (CREMA) y de `contraste-wcag.py`
(PALETA): cambialos por los del restaurante nuevo. NUNCA modifican los originales.
