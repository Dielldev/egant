# Vendored brand marks

Each `.svg` here is one coding agent's or model provider's own mark, used to
identify that product in the agent list and model picker.

The marks added for the Agents tab — `amp`, `antigravity`, `cline`, `copilot`,
`cursor`, `devin`, `goose`, `nous`, `openhands`, `pi`, `qwen` — come from
**lobe-icons**, which is MIT licensed:

<https://github.com/lobehub/lobe-icons>

They are single-path, `currentColor` monochrome glyphs on a 24×24 viewBox and
are vendored byte-for-byte, so refreshing one is a re-download:

```bash
curl -sL -o src/assets/logos/<name>.svg \
  "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/<name>.svg"
```

`nous.svg` is lobe's `nousresearch` icon under its egant vendor key.

Agents lobe-icons has no mark for — Aider, Auggie, Codebuff, Continue, Crush,
Factory Droid, Plandex — deliberately fall back to the tinted monogram tile in
`ProviderLogo`, rather than shipping an approximation of someone's logo.

## MIT License (lobe-icons)

Copyright (c) 2023 LobeHub

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
