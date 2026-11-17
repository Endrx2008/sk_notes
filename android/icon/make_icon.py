#!/usr/bin/env python3
"""Draws the sk_notes icon for Android: the scorpion of Skorpion OS rising from an open book.

    python3 make_icon.py        (needs rsvg-convert, package librsvg2-bin)

Sources: skorpion_logo.svg (the Skorpion OS logo, by the project) and the book drawn here.
Outputs:
  sk_notes.svg                         the whole icon (also the logo shown inside the app)
  foreground.svg, monochrome.svg       layers of the adaptive launcher icon (108 dp canvas)
  ../app/res/mipmap-*/…png             the layers and a plain icon at every screen density
"""
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
RES = HERE.parent / "app" / "res"
WEB = HERE.parent / "web"

ORANGE = "#e05c00"
BG = "#0d0d0d"
PAGE = "#f2ede6"
PAGE_SHADE = "#d8d0c4"
LINE = "#b9b0a3"
COVER = "#9c3f00"

# the scorpion: every path of the logo, in one colour
logo = (HERE / "skorpion_logo.svg").read_text(encoding="utf-8")
paths = [re.search(r'\sd="([^"]+)"', p, re.S).group(1) for p in re.findall(r"<path\b[^>]*?/>", logo, re.S)]
assert len(paths) > 40, "skorpion_logo.svg: paths not found"
# bounding box of the drawing inside its 960×560 page (measured from a render)
SX0, SY0, SW, SH = 268.5, 25.0, 423.0, 511.5


def scorpion(cx, top, height, fill):
    k = height / SH
    tx = cx - (SX0 + SW / 2) * k
    ty = top - SY0 * k
    body = "".join(f'<path fill-rule="evenodd" d="{" ".join(d.split())}"/>' for d in paths)
    return f'<g fill="{fill}" transform="translate({tx:.3f} {ty:.3f}) scale({k:.5f})">{body}</g>'


def book(cx, top, half, mono=False):
    """An open book seen from the front: two pages curving up from the spine, a cover under them."""
    def page(sign, inset=0.0, drop=0.0):
        x = lambda d: cx + sign * d  # noqa: E731
        y0 = top + drop
        return (f"M{x(inset):.1f} {y0 + 14:.1f} C{x(18):.1f} {y0 + 1:.1f} {x(half * .62):.1f} {y0 - 4:.1f} {x(half):.1f} {y0 + 3:.1f} "
                f"L{x(half):.1f} {y0 + 40:.1f} C{x(half * .62):.1f} {y0 + 33:.1f} {x(18):.1f} {y0 + 38:.1f} {x(inset):.1f} {y0 + 52:.1f} Z")
    if mono:
        return f'<path d="{page(-1, 3)} {page(1, 3)}"/>'
    lines = ""
    for sign in (-1, 1):
        for i, frac in enumerate((0.34, 0.56, 0.78)):
            x1, x2 = cx + sign * 16, cx + sign * (half - 12)
            y = top + 14 + i * 9
            lines += f'<path d="M{x1:.1f} {y + 4:.1f} Q{(x1 + x2) / 2:.1f} {y - 5:.1f} {x2:.1f} {y - 1:.1f}" fill="none" stroke="{LINE}" stroke-width="2.4" stroke-linecap="round"/>'
    return (f'<path d="{page(-1, 0, 7)} {page(1, 0, 7)}" fill="{COVER}" transform="translate(0 0)"/>'
            f'<path d="{page(-1)}" fill="{PAGE}"/><path d="{page(1)}" fill="{PAGE_SHADE}"/>{lines}'
            f'<path d="M{cx} {top + 14} L{cx} {top + 52}" stroke="{LINE}" stroke-width="2"/>')


def art(mono=False):
    # everything stays inside the circle of radius 132 around (216, 216): the part of an
    # adaptive icon every launcher shows
    return book(216, 262, 92, mono) + scorpion(216, 96, 186, "#000000" if mono else ORANGE)


def svg(inner, size=432, extra=""):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">{extra}{inner}</svg>\n'


foreground = svg(art())
monochrome = svg(f'<g fill="#000000">{art(True)}</g>')
# the whole icon: rounded square, the drawing a little bigger than inside the launcher mask
whole = svg(f'<rect width="432" height="432" rx="96" fill="{BG}"/><rect x="6" y="6" width="420" height="420" rx="90" fill="none" stroke="#2a2a2a" stroke-width="3"/>'
            f'<g transform="translate(216 220) scale(1.32) translate(-216 -216)">{art()}</g>')
(HERE / "foreground.svg").write_text(foreground, encoding="utf-8")
(HERE / "monochrome.svg").write_text(monochrome, encoding="utf-8")
(HERE / "sk_notes.svg").write_text(whole, encoding="utf-8")
(WEB / "logo.svg").write_text(whole, encoding="utf-8")


def render(src, dest, px):
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsvg-convert", "-w", str(px), "-h", str(px), str(src), "-o", str(dest)], check=True)


for name, dp in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)):
    d = RES / f"mipmap-{name}"
    render(HERE / "foreground.svg", d / "ic_launcher_foreground.png", round(108 * dp))
    render(HERE / "monochrome.svg", d / "ic_launcher_monochrome.png", round(108 * dp))
    render(HERE / "sk_notes.svg", d / "ic_launcher.png", round(48 * dp))
render(HERE / "sk_notes.svg", HERE / "sk_notes-512.png", 512)
print("icon written")
