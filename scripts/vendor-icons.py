"""Vendors the Antigravity Icons Supercharged (gray) set into one TSX module.

See `src/components/icons/LICENSE.md` for where the pack comes from and how to
unpack it. Reads the unpacked extension (`ICON_PACK`, default /tmp/agpack/out/extension)
and emits:
  - a glyph table (deduplicated: the six `image-*` icons are one glyph in six
    colours), with single-colour icons rewritten to `currentColor`
  - the pack's own file-extension and file-name mappings, filtered to the
    icons we kept
"""

import json
import os
import re
import xml.etree.ElementTree as ET

PACK = os.environ.get("ICON_PACK", "/tmp/agpack/out/extension")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "src/components/icons/antigravity.tsx")

# Heavy brand artwork (multi-kilobyte gradients and logo detail) we leave out;
# the files that used them fall back to the generic document/text icons.
DROP = {
    "archive", "svelte", "bun", "editorconfig", "yarn", "pdf", "csv",
    "docker-pink", "vscode-icon", "prettier", "font",
}
# `archive` is 28 KB of gradients; the pack's own `compressed` is 1 KB and says
# the same thing.
REPLACE = {"archive": "compressed", "docker-pink": "docker", "csv": "text"}
SIZE_LIMIT = 2600
# Worth their weight in this app specifically: it is a Rust project driven by
# Claude Code, so `Cargo.toml`'s neighbours and `CLAUDE.md` are everyday rows.
KEEP_OVER_LIMIT = {"rust", "sass", "database", "docker", "go", "claude"}

ATTR = {
    "stroke-width": "strokeWidth",
    "stroke-linejoin": "strokeLinejoin",
    "stroke-linecap": "strokeLinecap",
    "stroke-miterlimit": "strokeMiterlimit",
    "stroke-opacity": "strokeOpacity",
    "stroke-dasharray": "strokeDasharray",
    "stroke-dashoffset": "strokeDashoffset",
    "fill-rule": "fillRule",
    "fill-opacity": "fillOpacity",
    "clip-rule": "clipRule",
    "clip-path": "clipPath",
    "stop-color": "stopColor",
    "stop-opacity": "stopOpacity",
    "gradientUnits": "gradientUnits",
    "gradientTransform": "gradientTransform",
    "xlink:href": "xlinkHref",
    "xml:space": "xmlSpace",
    "class": "className",
}
SKIP_ATTR = {"xmlns", "xmlns:xlink", "version", "id-ref"}

theme = json.load(open(f"{PACK}/symbol-icon-theme.json"))
defs = theme["iconDefinitions"]


def icon_path(name):
    for sub in ("files", "folders"):
        p = f"{PACK}/icons/{sub}/{name}.svg"
        if os.path.exists(p):
            return p
    return None


def wanted(name):
    if name in DROP:
        return False
    p = icon_path(name)
    if not p:
        return False
    body = open(p).read()
    # A `<style>` block's class names are global once the icon is on the page,
    # so two icons could style each other. Text content we simply don't emit.
    if "<style" in body or "class=" in body or re.search(r"<(text|title|tspan)\b", body):
        return False
    if name in KEEP_OVER_LIMIT:
        return True
    return os.path.getsize(p) <= SIZE_LIMIT


# --- which icons survive -----------------------------------------------------
requested = set()
for table in ("fileExtensions", "fileNames"):
    requested.update(theme[table].values())
requested.update(["document", "text", "folder", "folder-closed", "compressed"])

kept = {}
for name in sorted(requested):
    target = REPLACE.get(name, name)
    if wanted(target):
        kept[name] = target

# --- parse, recolour, dedupe -------------------------------------------------
HEX = re.compile(r"#[0-9A-Fa-f]{3,8}")


def colours(node):
    found = set()
    for key in ("fill", "stroke", "stop-color"):
        value = node.get(key)
        if value and HEX.fullmatch(value.strip()):
            found.add(value.strip())
    for child in node:
        found |= colours(child)
    return found


def emit(node, indent, mono, prefix):
    tag = node.tag.split("}")[-1]
    attrs = []
    for key, value in node.attrib.items():
        key = key.split("}")[-1]
        if key in SKIP_ATTR:
            continue
        if key == "id":
            value = f"{prefix}-{value}"
        elif "url(#" in value:
            value = re.sub(r"url\(#([^)]+)\)", lambda m: f"url(#{prefix}-{m.group(1)})", value)
        elif mono and key in ("fill", "stroke", "stop-color") and HEX.fullmatch(value.strip()):
            value = "currentColor"
        if key == "style":
            # JSX wants an object. These are only ever a `mask-type` or a
            # single fill, and an empty one is dropped outright.
            declarations = [d for d in (part.strip() for part in value.split(";")) if d]
            if not declarations:
                continue
            pairs = []
            for declaration in declarations:
                prop, _, setting = declaration.partition(":")
                head, *rest = prop.strip().split("-")
                pairs.append(f'{head + "".join(w.capitalize() for w in rest)}: "{setting.strip()}"')
            attrs.append("style={{ " + ", ".join(pairs) + " }}")
            continue
        attrs.append(f'{ATTR.get(key, key)}="{value}"')

    pad = " " * indent
    head = f"{pad}<{tag}" + ("".join(f" {a}" for a in attrs) if attrs else "")
    children = list(node)
    if not children:
        return head + " />"
    inner = "\n".join(emit(child, indent + 2, mono, prefix) for child in children)
    return f"{head}>\n{inner}\n{pad}</{tag}>"


glyphs = {}          # glyph source -> glyph id
icons = {}           # icon name -> (glyph id, colour or None)
order = []

for name in sorted(set(kept.values())):
    tree = ET.parse(icon_path(name))
    root = tree.getroot()
    palette = colours(root)
    mono = len(palette) == 1
    colour = next(iter(palette)) if mono else None
    body = "\n".join(emit(child, 4, mono, f"ag-{name}") for child in root)
    glyph = glyphs.get(body)
    if glyph is None:
        glyph = name
        glyphs[body] = glyph
        order.append((glyph, body))
    # Most of the pack is 24×24; a handful of imported logos are not, and
    # drawing those on a 24×24 canvas would crop them.
    box = (root.get("viewBox") or "0 0 24 24").strip()
    icons[name] = (glyph, colour, None if box == "0 0 24 24" else box)

# --- the pack's own mappings, filtered --------------------------------------
extensions = {
    ext: kept[icon]
    for ext, icon in sorted(theme["fileExtensions"].items())
    if icon in kept
}
# The pack spells some names as they appear on disk (`README.md`, `AGENTS.md`)
# and others in lower case. Lowering them all matches how the lookup reads a
# filename; where two spellings collide they name the same icon, and this
# asserts that stays true rather than silently picking one.
filenames = {}
for fname, icon in sorted(theme["fileNames"].items()):
    if icon not in kept:
        continue
    key = fname.lower()
    if key in filenames and filenames[key] != kept[icon]:
        raise SystemExit(f"{key}: {filenames[key]} vs {kept[icon]}")
    filenames[key] = kept[icon]

lines = []
w = lines.append
w("// Antigravity Icons Supercharged (gray) — the file-type icons, vendored.")
w("//")
w("// Generated from the published extension, not hand-written: the glyphs are")
w("// the pack's own 24×24 artwork and the extension/filename tables below are")
w("// its own mappings, so a `.tsx` here gets the same icon it gets in the")
w("// editor. Single-colour icons are rewritten to `currentColor` and their")
w("// colour moved into `ICONS`, which lets the six `image-*` variants share one")
w("// glyph; multi-colour marks keep their own fills. Ids inside an icon are")
w("// prefixed with its name, so two icons on screen can't resolve each other's")
w("// clip paths.")
w("//")
w("// MIT — Copyright (c) 2020-22 Miguel Solorio (vscode-symbols), and DavidBabel")
w("// (antigravity-icons-supercharged). Full notice in ./LICENSE.md.")
w("//")
w("// Regenerating: unpack the .vsix and re-run the generator described in")
w("// LICENSE.md; nothing in this file should be edited by hand.")
w("")
w('import type { ReactElement } from "react";')
w("")
w("/** Icon artwork, keyed by the pack's icon name. */")
w("const GLYPHS: Record<string, ReactElement> = {")
for glyph, body in order:
    w(f'  "{glyph}": (')
    w("    <>")
    w(body)
    w("    </>")
    w("  ),")
w("};")
w("")
w("/** Icon name to [glyph, colour, viewBox]. A colour is present only where")
w(" * the pack's icon is a single colour; multi-colour marks carry their own.")
w(" * A viewBox is present only where it isn't the usual 24×24. */")
w("const ICONS: Record<string, [string, string?, string?]> = {")
for name in sorted(icons):
    glyph, colour, box = icons[name]
    tail = ""
    if box:
        tail = f', "{colour or ""}", "{box}"'
    elif colour:
        tail = f', "{colour}"'
    w(f'  "{name}": ["{glyph}"{tail}],')
w("};")
w("")
w("/** The pack's file-extension table (without the leading dot). */")
w("export const ICON_BY_EXTENSION: Record<string, string> = {")
for ext, icon in extensions.items():
    w(f'  "{ext}": "{icon}",')
w("};")
w("")
w("/** The pack's whole-filename table, which wins over the extension. */")
w("export const ICON_BY_FILENAME: Record<string, string> = {")
for fname, icon in filenames.items():
    w(f'  "{fname}": "{icon}",')
w("};")
w("")
w('export const DEFAULT_FILE_ICON = "document";')
w('export const FOLDER_ICON = "folder-closed";')
w('export const FOLDER_OPEN_ICON = "folder";')
w("")
w("/** True when the pack has artwork under this name. */")
w("export function hasIcon(name: string): boolean {")
w("  return name in ICONS;")
w("}")
w("")
w("/** One icon from the pack, at `size` pixels. Folders and other single-colour")
w(" * icons take `color` when given, which is how the tree keeps them in step")
w(" * with the palette instead of the pack's fixed slate. */")
w("export function AntigravityIcon({")
w("  icon,")
w("  size = 16,")
w("  color,")
w("}: {")
w("  icon: string;")
w("  size?: number;")
w("  color?: string;")
w("}) {")
w("  const [glyph, own, box] = ICONS[icon] ?? ICONS[DEFAULT_FILE_ICON];")
w("  // An empty colour slot only exists to carry a viewBox past it.")
w("  return (")
w("    <svg")
w("      width={size}")
w("      height={size}")
w('      viewBox={box || "0 0 24 24"}')
w('      fill="none"')
w('      className="shrink-0"')
w("      // `currentColor` in the artwork resolves to this; multi-colour marks")
w("      // ignore it entirely.")
w("      style={{ color: color ?? own }}")
w('      aria-hidden="true"')
w("    >")
w("      {GLYPHS[glyph]}")
w("    </svg>")
w("  );")
w("}")
w("")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w").write("\n".join(lines))

print("glyphs:", len(order), "| icons:", len(icons))
print("extensions:", len(extensions), "| filenames:", len(filenames))
print("bytes:", os.path.getsize(OUT))
print("dropped:", sorted(requested - set(kept)))
