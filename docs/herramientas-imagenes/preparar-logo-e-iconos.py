"""Genera el logo del sitio y los iconos de la PWA a partir del logo original (sin tocar el original).

Uso: python logo_iconos.py <logo_original> <carpeta_salida>
"""
import sys, os
from PIL import Image, ImageChops, ImageFilter

origen, salida = sys.argv[1], sys.argv[2]
os.makedirs(salida, exist_ok=True)

CREMA = (0xFF, 0xEB, 0xC6)          # medido sobre el original
im = Image.open(origen).convert("RGB")
W, H = im.size

# Caja del contenido: todo lo que se aleja del crema de fondo
fondo = Image.new("RGB", im.size, CREMA)
dif = ImageChops.difference(im, fondo).convert("L").point(lambda v: 255 if v > 40 else 0)
caja = dif.getbbox()
print("original", im.size, "contenido", caja, "->", caja[2] - caja[0], "x", caja[3] - caja[1])

# Recorte con un margen del 5 % del lado mayor
lado = max(caja[2] - caja[0], caja[3] - caja[1])
m = round(lado * 0.05)
rec = (caja[0] - m, caja[1] - m, caja[2] + m, caja[3] + m)
# crop() rellena con negro fuera de la imagen: se pega sobre un lienzo crema para que el margen sea simetrico
logo = Image.new("RGB", (rec[2] - rec[0], rec[3] - rec[1]), CREMA)
logo.paste(im.crop((max(0, rec[0]), max(0, rec[1]), min(W, rec[2]), min(H, rec[3]))), (max(0, -rec[0]), max(0, -rec[1])))
# El JPG original trae ruido de compresion en las zonas planas; una mediana lo aplana sin redondear los bordes
logo = logo.filter(ImageFilter.MedianFilter(5))
print("recorte", rec, logo.size, "aspecto %.3f" % (logo.size[0] / logo.size[1]))


def a_paleta(img, colores=40):
    """Paleta adaptativa sin tramado: aplana el ruido del JPG y deja un PNG liviano."""
    return img.quantize(colors=colores, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


# --- Logo del sitio: ancho maximo 800 px
w = 800
alto = round(logo.size[1] * w / logo.size[0])
sitio = logo.resize((w, alto), Image.LANCZOS)
ruta = os.path.join(salida, "northe-logo.png")
a_paleta(sitio).save(ruta, optimize=True)
print("northe-logo.png", sitio.size, os.path.getsize(ruta) // 1024, "KB")


# --- Iconos cuadrados: crema solido, logo centrado ocupando como mucho el 68 % del lado
def icono(lado_px, nombre):
    lienzo = Image.new("RGB", (lado_px, lado_px), CREMA)
    maximo = round(lado_px * 0.68)            # margen de seguridad >= 16 % por cada lado
    esc = maximo / max(logo.size)
    tam = (round(logo.size[0] * esc), round(logo.size[1] * esc))
    pieza = logo.resize(tam, Image.LANCZOS)
    lienzo.paste(pieza, ((lado_px - tam[0]) // 2, (lado_px - tam[1]) // 2))
    ruta = os.path.join(salida, nombre)
    a_paleta(lienzo).save(ruta, optimize=True)
    print(nombre, lienzo.size, "logo", tam, os.path.getsize(ruta) // 1024, "KB")


icono(192, "northe-icono-192.png")
icono(512, "northe-icono-512.png")
