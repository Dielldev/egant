"""Renders the installer window's backdrop (src-tauri/dmg/background.png).

Run `python3 src-tauri/dmg/make_background.py` after changing the layout, and
keep the numbers in tauri.macos.conf.json (window size, icon positions) in
step with the constants here. Drawn at 3x and downsampled for smooth edges.

The backdrop is the landing page's sky wallpaper, blurred and darkened, with a
glass panel behind the two icons. Finder draws icon labels white in dark mode
and black in light mode, so this is built for dark mode.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

HERE = Path(__file__).parent
WALLPAPER = HERE.parent.parent / "site/src/assets/shots/wall-sky.jpg"

W, H = 660, 400  # window content size, in points
APP_X, APPS_X, ICON_Y = 180, 480, 170  # icon centres; match tauri.macos.conf.json
S = 3


def font(size, bold=False):
    return ImageFont.truetype("/System/Library/Fonts/HelveticaNeue.ttc", size * S, index=1 if bold else 0)


def centered(d, text, cy_pt, size, fill, bold=False):
    f = font(size, bold)
    d.text((W * S / 2, cy_pt * S), text, font=f, fill=fill, anchor="mm")


img = ImageOps.fit(Image.open(WALLPAPER).convert("RGB"), (W * S, H * S)).filter(ImageFilter.GaussianBlur(14 * S))
img = Image.blend(img, Image.new("RGB", img.size, (8, 8, 12)), 0.45)
d = ImageDraw.Draw(img, "RGBA")

# Glass panel behind the icons.
d.rounded_rectangle([34 * S, 56 * S, (W - 34) * S, (H - 96) * S], radius=26 * S,
                    fill=(255, 255, 255, 22), outline=(255, 255, 255, 45), width=S)

# Dashed path from the app to Applications, ending in a chevron.
col = (255, 255, 255, 200)
y = ICON_Y * S
x, x1 = (APP_X + 84) * S, (APPS_X - 92) * S
while x < x1 - 12 * S:
    d.rounded_rectangle([x, y - 1.5 * S, x + 9 * S, y + 1.5 * S], radius=1.5 * S, fill=col)
    x += 17 * S
h = 11 * S
pts = [(x1 - h, y - h), (x1, y), (x1 - h, y + h)]
d.line(pts, fill=col, width=3 * S, joint="curve")
for px, py in pts:
    d.ellipse([px - 1.5 * S, py - 1.5 * S, px + 1.5 * S, py + 1.5 * S], fill=col)

centered(d, "Drag egant into Applications", 342, 14, (255, 255, 255, 240), bold=True)
centered(d, "every coding agent, one native desktop", 364, 11, (255, 255, 255, 150))

out = HERE / "background.png"
img.resize((W, H), Image.LANCZOS).save(out)
print("wrote", out)
