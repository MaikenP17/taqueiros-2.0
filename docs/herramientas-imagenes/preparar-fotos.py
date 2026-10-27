"""Fotos de producto -> 4:3, 1200x900, JPG < 300 KB, en Recursos/NORTHE-NUEVO/listas/ (originales intactos).

Uso: python fotos.py <carpeta NORTHE-NUEVO> <carpeta hojas de revision>
Cada foto original es vertical 1792x2400. y0 = fila (en px del original) donde empieza la ventana 4:3 de
1792x1344: se eligio mirando cada foto. "extender" = bebidas: se escala la foto completa al alto de la
ventana y los lados se rellenan con las columnas del borde (el fondo es un degradado liso).
"""
import sys, os
from PIL import Image, ImageFilter, ImageDraw

raiz, hojas = sys.argv[1], sys.argv[2]
listas = os.path.join(raiz, "listas")
os.makedirs(listas, exist_ok=True)
os.makedirs(hojas, exist_ok=True)

W, H = 1792, 2400
VENT_H = 1344                       # 1792 * 3/4
SALIDA = (1200, 900)

# archivo original, nombre final, y0 (None = extender)
FOTOS = [
    ("burguers/big norte.jpg",     "big-norte.jpg",     650),
    ("burguers/crispy norte.jpg",  "crispy-norte.jpg",  560),
    ("burguers/lil norte.jpg",     "lil-norte.jpg",     650),
    ("hotdogs/classic norte.jpg",  "classic-norte.jpg", 680),
    ("hotdogs/smoky norte.jpg",    "smoky-norte.jpg",   570),
    ("hotdogs/full norte.jpg",     "full-norte.jpg",    650),
    ("Papas/creamy norte.jpg",     "creamy-norte.jpg",  600),
    ("Papas/dirty norte.jpg",      "dirty-norte.jpg",   600),
    ("Papas/chori norte.jpg",      "chori-norte.jpg",   600),
    ("bebidas/agua.jpg",           "agua.jpg",          None),
    ("bebidas/cocacola.jpg",       "coca-cola.jpg",     None),
    ("bebidas/pepsi.jpg",          "pepsi.jpg",         None),
    ("bebidas/sprite.jpg",         "sprite.jpg",        None),
]
if len(sys.argv) > 3:                       # ajuste fino: nombre=y0,nombre=y0
    for par in sys.argv[3].split(","):
        n, v = par.split("=")
        FOTOS = [(a, b, int(v) if b == n else y) for a, b, y in FOTOS]


def extender(im):
    """Foto completa, centrada, con los lados rellenos con el fondo y fundidos con la foto.

    El fondo del estudio es un degradado liso con vineta: se estiran las columnas del borde, se desenfocan
    fuerte y la foto se pega encima con un fundido horizontal de 220 px para que no quede ninguna costura."""
    esc = VENT_H / H
    ancho = round(W * esc)
    chica = im.resize((ancho, VENT_H), Image.LANCZOS)
    x0 = (W - ancho) // 2
    fondo = Image.new("RGB", (W, VENT_H))
    izq = chica.crop((0, 0, 6, VENT_H)).resize((x0 + 6, VENT_H), Image.BILINEAR)
    der = chica.crop((ancho - 6, 0, ancho, VENT_H)).resize((W - x0 - ancho + 6, VENT_H), Image.BILINEAR)
    fondo.paste(izq, (0, 0))
    fondo.paste(der, (x0 + ancho - 6, 0))
    # el relleno continua el degradado hacia el centro: se mezcla con una version muy desenfocada de la foto
    centro = chica.filter(ImageFilter.GaussianBlur(70))
    fondo.paste(centro, (x0, 0))
    fondo = fondo.filter(ImageFilter.GaussianBlur(40))
    # mascara: opaca en el centro, transparente en los bordes de la foto (fundido de 220 px)
    f = 220
    masc = Image.new("L", (ancho, VENT_H), 255)
    rampa = Image.linear_gradient("L").rotate(90, expand=True).resize((f, VENT_H))   # 0 -> 255 de izq. a der. (comprobado)
    masc.paste(rampa, (0, 0))                                          # borde izquierdo: transparente -> opaco
    masc.paste(rampa.transpose(Image.FLIP_LEFT_RIGHT), (ancho - f, 0))  # borde derecho: opaco -> transparente
    fondo.paste(chica, (x0, 0), masc)
    return fondo


def guardar(img, ruta, tope_kb=290):
    for q in (86, 82, 78, 74, 70, 66):
        img.save(ruta, "JPEG", quality=q, optimize=True, progressive=True, subsampling="4:2:0")
        kb = os.path.getsize(ruta) / 1024
        if kb < tope_kb:
            return q, kb
    return q, kb


filas = []
for rel, nombre, y0 in FOTOS:
    im = Image.open(os.path.join(raiz, rel)).convert("RGB")
    assert im.size == (W, H), (rel, im.size)
    ventana = extender(im) if y0 is None else im.crop((0, y0, W, y0 + VENT_H))
    final = ventana.resize(SALIDA, Image.LANCZOS)
    q, kb = guardar(final, os.path.join(listas, nombre))
    print(f"{nombre:18} y0={'ext' if y0 is None else y0:>4}  {SALIDA[0]}x{SALIDA[1]}  q={q}  {kb:5.0f} KB")
    filas.append((nombre, final))

# hojas de revision (fuera del repo): 3 por fila
for i in range(0, len(filas), 3):
    grupo = filas[i:i + 3]
    hoja = Image.new("RGB", (3 * 400 + 20, 300), "white")
    for j, (n, f) in enumerate(grupo):
        t = f.resize((400, 300))
        d = ImageDraw.Draw(t); d.rectangle((0, 0, 110, 14), fill="black"); d.text((3, 1), n, fill="white")
        hoja.paste(t, (j * 410, 0))
    hoja.save(os.path.join(hojas, f"revision_{i // 3}.jpg"), quality=85)
