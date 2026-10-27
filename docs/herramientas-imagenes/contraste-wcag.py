"""Contraste WCAG de la paleta propuesta contra las reglas CSS reales de las paginas.

Uso: python contraste.py <carpeta del proyecto> [paleta.json]
Sin dependencias. Resuelve var(--x) con la paleta, mira hex literales, y reporta las parejas < 4.5:1.
Reglas con color y fondo declarados: pareja exacta. Reglas con solo color: se compara con la superficie
claro_suave (si el texto es oscuro) o con oscuro (si el texto es claro): es una aproximacion, se marca (~).
"""
import re, sys, json, os

PALETA = {
    "primario": "#C92423", "primario_oscuro": "#8E1B1A", "primario_brillo": "#E8514A",
    "claro": "#FFEBC6", "claro_suave": "#FFF6E3", "oscuro": "#220F08", "oscuro_2": "#2E160D",
    "acento": "#EEA927", "positivo": "#5C7A3B", "positivo_brillo": "#7FA855",
    "texto_secundario": "#E6D3AE", "texto_tenue": "#BFA987",
}
if len(sys.argv) > 2:
    PALETA.update(json.load(open(sys.argv[2])))

VAR = {
    "--rojo": "primario", "--rojo-oscuro": "primario_oscuro", "--rojo-brillo": "primario_brillo",
    "--crema": "claro", "--crema-suave": "claro_suave", "--carbon": "oscuro", "--carbon-2": "oscuro_2",
    "--mostaza": "acento", "--verde": "positivo", "--verde-brillo": "positivo_brillo",
    "--texto-secundario": "texto_secundario", "--texto-tenue": "texto_tenue", "--texto-claro": "claro",
}


def lum(h):
    h = h.lstrip("#")
    if len(h) == 3: h = "".join(c * 2 for c in h)
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a, b):
    la, lb = lum(a), lum(b)
    if la < lb: la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)


def resolver(v):
    v = v.strip().lower()
    m = re.search(r"var\((--[a-z0-9-]+)", v)
    if m and m.group(1) in VAR and "rgba" not in v:
        return PALETA[VAR[m.group(1)]]
    m = re.fullmatch(r"#([0-9a-f]{3}|[0-9a-f]{6})", v)
    if m: return "#" + m.group(1)
    if v == "white": return "#ffffff"
    if v == "black": return "#000000"
    return None


def reglas(css):
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for m in re.finditer(r"([^{}@][^{}]*)\{([^{}]*)\}", css):
        yield m.group(1).strip(), m.group(2)


def decl(cuerpo, prop):
    m = re.search(r"(?:^|;|\s)" + prop + r"\s*:\s*([^;]+)", cuerpo)
    return m.group(1).strip() if m else None


def fondo_de(cuerpo):
    for p in ("background-color", "background"):
        v = decl(cuerpo, p)
        if v:
            for tok in re.findall(r"var\(--[a-z0-9-]+\)|#[0-9a-fA-F]{3,6}\b", v):
                c = resolver(tok)
                if c: return c
    return None


base = sys.argv[1]
malas, ambiguas = [], []
for archivo in ("index.html", "pedido.html", "panel.html", "menu-admin.html", "historial.html"):
    html = open(os.path.join(base, archivo), encoding="utf-8").read()
    estilos = chr(10).join(re.findall(r"<style[^>]*>(.*?)</style>", html, flags=re.S))
    for sel, cuerpo in reglas(estilos):
        c = decl(cuerpo, "color")
        txt = resolver(c) if c else None
        if not txt: continue
        bg = fondo_de(cuerpo)
        if bg:
            r = ratio(txt, bg)
            if r < 4.5: malas.append((r, archivo, sel[:60], c, txt, bg))
        else:
            r_osc = ratio(txt, PALETA["oscuro_2"]); r_cla = ratio(txt, PALETA["claro_suave"])
            if max(r_osc, r_cla) < 4.5: malas.append((max(r_osc, r_cla), archivo, sel[:60], c, txt, "ninguna superficie"))
            elif min(r_osc, r_cla) < 4.5: ambiguas.append((min(r_osc, r_cla), archivo, sel[:60], c, txt, "oscura" if r_osc < r_cla else "clara"))

malas.sort(); ambiguas.sort()
print(f"FALLAN SEGURO: {len(malas)}")
for r, a, s_, c, txt, bg in malas:
    print(f"{r:4.2f}  {a:15} {s_:60} {c[:24]:24} {txt} sobre {bg}")
print(f"{chr(10)}PASAN SOLO SOBRE UNA SUPERFICIE (revisar a mano): {len(ambiguas)}")
for r, a, s_, c, txt, sup in ambiguas:
    print(f"{r:4.2f}  {a:15} {s_:60} {c[:24]:24} {txt}  falla sobre superficie {sup}")

print()
print("PAREJAS CLAVE")
clave = [
    ("boton primario: claro_suave sobre primario", "claro_suave", "primario"),
    ("boton primario hover: claro_suave sobre primario_oscuro", "claro_suave", "primario_oscuro"),
    ("texto principal: claro sobre oscuro", "claro", "oscuro"),
    ("texto principal: claro sobre oscuro_2", "claro", "oscuro_2"),
    ("secundario sobre oscuro", "texto_secundario", "oscuro"),
    ("secundario sobre oscuro_2", "texto_secundario", "oscuro_2"),
    ("tenue sobre oscuro", "texto_tenue", "oscuro"),
    ("tenue sobre oscuro_2", "texto_tenue", "oscuro_2"),
    ("primario como texto sobre oscuro (debe usarse primario_brillo)", "primario", "oscuro"),
    ("primario_brillo sobre oscuro", "primario_brillo", "oscuro"),
    ("primario_brillo sobre oscuro_2", "primario_brillo", "oscuro_2"),
    ("acento sobre oscuro", "acento", "oscuro"),
    ("oscuro sobre acento (boton mostaza)", "oscuro", "acento"),
    ("oscuro sobre claro_suave (tarjeta)", "oscuro", "claro_suave"),
    ("oscuro sobre claro", "oscuro", "claro"),
    ("primario sobre claro_suave (precio/titulo en tarjeta)", "primario", "claro_suave"),
    ("primario_oscuro sobre claro_suave", "primario_oscuro", "claro_suave"),
    ("positivo_brillo sobre oscuro", "positivo_brillo", "oscuro"),
    ("positivo sobre claro_suave", "positivo", "claro_suave"),
    ("claro_suave sobre positivo", "claro_suave", "positivo"),
]
for n, a, b in clave:
    r = ratio(PALETA[a], PALETA[b])
    print(f"{r:5.2f}  {'OK ' if r >= 4.5 else 'FALLA'}  {n}  ({PALETA[a]} / {PALETA[b]})")
