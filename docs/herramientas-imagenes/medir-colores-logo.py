import sys, statistics
from PIL import Image, ImageFilter

ruta = sys.argv[1]
im = Image.open(ruta).convert("RGB")
W, H = im.size
print("tamano", W, H)

def hexa(c): return "#%02X%02X%02X" % tuple(int(round(v)) for v in c)

def mediana(pix):
    return tuple(statistics.median(p[i] for p in pix) for i in range(3))

def media(pix):
    n = len(pix)
    return tuple(sum(p[i] for p in pix) / n for i in range(3))

def dispersion(pix):
    return tuple(statistics.pstdev([p[i] for p in pix]) for i in range(3))

# --- CREMA: cuatro parches grandes de fondo, lejos del texto
parches = [(40, 40, 400, 400), (W - 440, 40, W - 40, 400), (40, H - 440, 400, H - 40), (W - 440, H - 440, W - 40, H - 40)]
crema = []
for i, (a, b, c, d) in enumerate(parches):
    px = list(im.crop((a, b, c, d)).getdata())
    print(f"  parche crema {i}: media {hexa(media(px))}  desv {tuple(round(x,1) for x in dispersion(px))}")
    crema += px
print("CREMA mediana", hexa(mediana(crema)), " media", hexa(media(crema)))

# --- Para el resto: pixeles 'planos' (no en un borde) clasificados por rango de color
borde = im.filter(ImageFilter.FIND_EDGES).convert("L")
dat = list(im.getdata())
bor = list(borde.getdata())
plano = [dat[i] for i in range(len(dat)) if bor[i] < 6]
print("pixeles planos", len(plano), "de", len(dat))

def clase(p):
    r, g, b = p
    if r > 150 and g < 80 and b < 80 and r - g > 90: return "rojo"
    if r < 70 and g < 45 and b < 40: return "marron"
    if r > 215 and 150 < g < 205 and b < 100: return "mostaza"
    return None

cl = {"rojo": [], "marron": [], "mostaza": []}
for p in plano:
    k = clase(p)
    if k: cl[k].append(p)
for k, px in cl.items():
    if not px:
        print(k.upper(), "sin muestras"); continue
    print(f"{k.upper():8} n={len(px):8} mediana {hexa(mediana(px))}  media {hexa(media(px))}  desv {tuple(round(x,1) for x in dispersion(px))}")
