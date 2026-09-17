"""Renders the bundle icons in `src-tauri/icons` from `src/assets/logo.svg`.

The mark is the single source of truth: this reads its polygons straight out of
the SVG so the dock icon and the in-app loader can never drift apart. Run it
after editing the mark:

    python3 scripts/make-icons.py

Emits the five files `tauri.conf.json` bundles, plus `icon-1024.png` as the
master. The tile keeps the silhouette the app shipped with — full-bleed, corner
radius 232/1024 — so only the artwork inside it changes.
"""

import os
import re
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG = os.path.join(ROOT, "src/assets/logo.svg")
OUT = os.path.join(ROOT, "src-tauri/icons")

# Drawn at 1024 and resampled down: the mark is all long diagonals, and
# rasterising each size on its own leaves them visibly chewed at 32px.
MASTER = 1024
RADIUS = 232
# How much of the tile's width the mark spans. The source artwork sits at 50%
# with a lot of air; a dock icon wants it closer to the edges than that.
COVERAGE = 0.60
TILE = (6, 6, 6, 255)
MARK = (255, 255, 255, 255)
# 4x supersampling before the downsample — the diagonals are the whole mark.
SS = 4

PNGS = {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256}
# The sizes `iconutil` expects in an .iconset, by file name.
ICONSET = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
ICO = [16, 24, 32, 48, 64, 128, 256]


def polygons(svg):
    """The mark's paths as point lists, in viewBox units.

    Only the subset of path syntax `logo.svg` uses — absolute M/L/H/V/Z over
    straight edges. Anything curved would need a real SVG parser instead.
    """
    box = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).split()]
    out = []
    for d in re.findall(r'\sd="([^"]+)"', svg):
        pts, cur = [], [0.0, 0.0]
        for cmd, args in re.findall(r"([MLHVZmlhvz])([^MLHVZmlhvz]*)", d):
            if cmd in "mlhvz":
                raise SystemExit(f"{SVG}: relative path command {cmd!r} is not supported")
            nums = [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", args)]
            if cmd in "ML":
                for i in range(0, len(nums), 2):
                    cur = [nums[i], nums[i + 1]]
                    pts.append(tuple(cur))
            elif cmd == "H":
                for v in nums:
                    cur[0] = v
                    pts.append(tuple(cur))
            elif cmd == "V":
                for v in nums:
                    cur[1] = v
                    pts.append(tuple(cur))
        out.append(pts)
    return out, box[2], box[3]


def master():
    """The 1024 tile, antialiased by drawing big and resampling once."""
    paths, vw, vh = polygons(open(SVG).read())
    n = MASTER * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle((0, 0, n - 1, n - 1), radius=RADIUS * SS, fill=TILE)

    scale = MASTER * COVERAGE / vw * SS
    dx = (n - vw * scale) / 2
    dy = (n - vh * scale) / 2
    for path in paths:
        draw.polygon([(x * scale + dx, y * scale + dy) for x, y in path], fill=MARK)
    return img.resize((MASTER, MASTER), Image.LANCZOS)


def main():
    img = master()
    img.save(os.path.join(OUT, "icon-1024.png"))
    for name, size in PNGS.items():
        img.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, name))

    # Windows. Pillow writes every size into the one .ico.
    img.save(os.path.join(OUT, "icon.ico"), sizes=[(s, s) for s in ICO])

    # macOS. `iconutil` ships with Xcode's command line tools and is the only
    # thing that writes a .icns Finder and the dock will both accept.
    if shutil.which("iconutil") is None:
        raise SystemExit("iconutil not found — icon.icns left as it was")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.mkdir(iconset)
        for name, size in ICONSET:
            img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", os.path.join(OUT, "icon.icns")],
            check=True,
        )
    print(f"wrote {len(PNGS) + 3} icons to {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
