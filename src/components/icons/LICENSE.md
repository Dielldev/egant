# Vendored file-type icons

`antigravity.tsx` is generated, not written. Its artwork is the
**Antigravity Icons Supercharged — gray version** icon theme (v0.9.2), which is
itself built on **vscode-symbols**; both are MIT.

| | |
|---|---|
| Pack | <https://marketplace.visualstudio.com/items?itemName=davidbabel.antigravity-icons-supercharged-gray> |
| Pack source | <https://github.com/DavidBabel/antigravity-icons-supercharged> |
| Base set | <https://github.com/miguelsolorio/vscode-symbols> |

## What the generator changes

`scripts/vendor-icons.py` reads the unpacked extension and writes one TSX
module. It is not a straight copy:

- **Single-colour icons become `currentColor`**, with the colour moved into the
  icon table. That is what lets the six `image-*` variants share one glyph, and
  what lets the tree tint folders with the palette instead of the pack's fixed
  slate. Multi-colour marks (the npm hexagon, the Ruby gem) keep their own fills.
- **Ids are prefixed with the icon's name.** Two icons on screen at once would
  otherwise resolve each other's gradients and clip paths, since ids are
  document-global.
- **Each icon keeps its own `viewBox`.** Most of the pack is 24×24; a handful of
  imported logos are not, and drawing those on a 24×24 canvas would crop them.
- **Some icons are left out**: artwork that needs a `<style>` block (its class
  names would leak to the whole document), and a handful of multi-kilobyte
  gradient logos that are not worth the bundle — `archive` alone is 28 KB, so
  the pack's own 1 KB `compressed` stands in for it. Anything left out falls
  back to the generic document icon, which is what an unmapped extension gets
  anyway.

The extension and filename tables are the pack's own, filtered to the icons that
survived, so a `.tsx` here gets the icon it would get in the editor.

## Regenerating

```bash
curl -sSL -o /tmp/ext.vsix \
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/davidbabel/vsextensions/antigravity-icons-supercharged-gray/0.9.2/vspackage"
gunzip -c /tmp/ext.vsix > /tmp/ext.zip && unzip -q -o /tmp/ext.zip -d /tmp/agpack/out
ICON_PACK=/tmp/agpack/out/extension python3 scripts/vendor-icons.py
```

## MIT License

Copyright (c) 2020-22 Miguel Solorio

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
