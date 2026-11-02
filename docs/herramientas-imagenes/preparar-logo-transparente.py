"""Genera el logo del sitio (PNG con transparencia real) y los iconos de la PWA a partir de un logo transparente.

Uso: python preparar-logo-transparente.py <logo_transparente.png> <carpeta_salida>

  northe-logo.png         recortado al contenido (caja del alfa) con un margen pequeno, 900 px de ancho como maximo,
                          conserva el canal alfa (el sitio claro lo pone directo sobre el crema, sin caja)
  northe-icono-192.png    iconos cuadrados sobre crema SOLIDO (el logo lleva texto negro y crema: sobre un fondo
  northe-icono-512.png    oscuro o blanco de WhatsApp / de la pestana no se leeria), logo con margen seguro del 15 %

Antes de generar comprueba que el alfa sea REAL (no un cuadriculado pintado): esquinas transparentes y un
porcentaje alto de pixeles con alfa 0. Si no lo es, se detiene. NUNCA modifica el original.
"""
import sys, os
from PIL import Image

origen, salida = sys.argv[1], sys.argv[2]
os.makedirs(salida, exist_ok=True)

CREMA = (0xFF, 0xEB, 0xC6)          # color claro del restaurante (config.publico.marca.colores.claro)

im = Image.open(origen).convert("RGBA")
W, H = im.size
alfa = im.getchannel("A")
datos = list(alfa.getdata())
transp = sum(1 for v in datos if v == 0) / len(datos)
esquinas = [alfa.getpixel(c) for c in ((0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1))]
print("original", im.size, "transparente %.1f %%" % (100 * transp), "esquinas", esquinas)
if transp < 0.05 or any(v != 0 for v in esquinas):
    sys.exit("El alfa NO parece real (esquinas opacas o casi nada transparente): no se genera nada.")

caja = alfa.point(lambda v: 255 if v > 8 else 0).getbbox()
lado = max(caja[2] - caja[0], caja[3] - caja[1])
m = round(lado * 0.02)               # margen del 2 % para que el borde del dibujo no quede pegado al limite
rec = (max(0, caja[0] - m), max(0, caja[1] - m), min(W, caja[2] + m), min(H, caja[3] + m))
logo = im.crop(rec)
print("contenido", caja, "recorte", rec, logo.size, "aspecto %.3f" % (logo.size[0] / logo.size[1]))


def guardar(img, ruta):
    """Paleta de 256 colores con alfa (cuantizacion FASTOCTREE, sin tramado): PNG liviano sin perder el borde."""
    q = img.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    q.save(ruta, optimize=True)
    return os.path.getsize(ruta)


# --- Logo del sitio
w = min(900, logo.size[0])
sitio = logo.resize((w, round(logo.size[1] * w / logo.size[0])), Image.LANCZOS)
ruta = os.path.join(salida, "northe-logo.png")
print("northe-logo.png", sitio.size, guardar(sitio, ruta) // 1024, "KB")


# --- Iconos cuadrados: crema solido, logo centrado con margen seguro del 15 % por lado (70 % del lado)
def icono(lado_px, nombre):
    lienzo = Image.new("RGBA", (lado_px, lado_px), CREMA + (255,))
    maximo = round(lado_px * 0.70)
    esc = maximo / max(logo.size)
    tam = (round(logo.size[0] * esc), round(logo.size[1] * esc))
    pieza = logo.resize(tam, Image.LANCZOS)
    lienzo.alpha_composite(pieza, ((lado_px - tam[0]) // 2, (lado_px - tam[1]) // 2))
    ruta = os.path.join(salida, nombre)
    n = lienzo.convert("RGB").quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    n.save(ruta, optimize=True)
    print(nombre, lienzo.size, "logo", tam, os.path.getsize(ruta) // 1024, "KB")


icono(192, "northe-icono-192.png")
icono(512, "northe-icono-512.png")
