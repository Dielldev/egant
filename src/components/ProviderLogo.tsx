import ampLogo from "../assets/logos/amp.svg?raw";
import antigravityLogo from "../assets/logos/antigravity.svg?raw";
import claudeLogo from "../assets/logos/claude.svg?raw";
import clineLogo from "../assets/logos/cline.svg?raw";
import copilotLogo from "../assets/logos/copilot.svg?raw";
import cursorLogo from "../assets/logos/cursor.svg?raw";
import deepseekLogo from "../assets/logos/deepseek.svg?raw";
import devinLogo from "../assets/logos/devin.svg?raw";
import gooseLogo from "../assets/logos/goose.svg?raw";
import googleLogo from "../assets/logos/google.svg?raw";
import metaLogo from "../assets/logos/meta.svg?raw";
import nousLogo from "../assets/logos/nous.svg?raw";
import openhandsLogo from "../assets/logos/openhands.svg?raw";
import opencodeLogo from "../assets/logos/opencode.svg?raw";
import openaiLogo from "../assets/logos/openai.svg?raw";
import piLogo from "../assets/logos/pi.svg?raw";
import qwenLogo from "../assets/logos/qwen.svg?raw";
import xLogo from "../assets/logos/x.svg?raw";

const LOGOS: Record<string, string> = {
  // Claude models use the Claude starburst, never the Anthropic "A".
  claude: claudeLogo,
  anthropic: claudeLogo,
  openai: openaiLogo,
  codex: openaiLogo,
  opencode: opencodeLogo,
  google: googleLogo,
  gemini: googleLogo,
  meta: metaLogo,
  llama: metaLogo,
  deepseek: deepseekLogo,
  xai: xLogo,
  x: xLogo,
  grok: xLogo,
  // Agent marks for the Agents tab. Vendored from lobe-icons — see
  // ../assets/logos/LICENSE.md.
  amp: ampLogo,
  antigravity: antigravityLogo,
  cline: clineLogo,
  copilot: copilotLogo,
  cursor: cursorLogo,
  devin: devinLogo,
  goose: gooseLogo,
  nous: nousLogo,
  openhands: openhandsLogo,
  pi: piLogo,
  qwen: qwenLogo,
};

/** Accent for the monogram tile an agent with no vendored mark falls back to
 * (Aider, Auggie, Codebuff, Continue, Crush, Droid, Plandex). A tinted
 * initial reads as a deliberate placeholder; the default grey letter read as
 * a missing asset. Marks themselves stay monochrome, so the row is one
 * consistent icon system rather than a mix of tinted and untinted art. */
const TINTS: Record<string, string> = {
  aider: "#4ea87a",
  augment: "#7c6cf6",
  charm: "#e86fb0",
  codebuff: "#e0954a",
  continue: "#5b8def",
  factory: "#dd7455",
  plandex: "#3fbfae",
};

export function providerSvg(provider: string): string | null {
  return LOGOS[provider.toLowerCase()] ?? null;
}

/** Brand mark for a model provider. Unknown providers get an initial tile,
 * so the list never depends on asset coverage. The tile clips its glyph
 * (`overflow-hidden`) so wide wordmarks can never bleed into the row text. */
export function ProviderLogo({ provider, size = 26 }: { provider: string; size?: number }) {
  const svg = providerSvg(provider);
  const tile =
    "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)]";
  if (!svg) {
    // The letter scales with the tile, so a 48px tile in the agent sheet
    // isn't a lone 11px character floating in a box.
    const tint = TINTS[provider.toLowerCase()];
    return (
      <span
        className={tile}
        style={{
          width: size,
          height: size,
          ...(tint
            ? {
                color: tint,
                background: `color-mix(in srgb, ${tint} 14%, transparent)`,
                borderColor: `color-mix(in srgb, ${tint} 30%, transparent)`,
              }
            : null),
        }}
      >
        <span
          className={tint ? "font-semibold" : "font-semibold text-[var(--muted)]"}
          style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}
        >
          {provider.slice(0, 1).toUpperCase()}
        </span>
      </span>
    );
  }
  return (
    // color-mix rather than a Tailwind opacity modifier: `--ink` is a plain
    // custom property, not a registered Tailwind colour, so `/85` on it is
    // not guaranteed to compile.
    <span
      className={tile}
      style={{
        width: size,
        height: size,
        color: "color-mix(in srgb, var(--ink) 85%, transparent)",
      }}
    >
      <span className="provider-logo" dangerouslySetInnerHTML={{ __html: svg }} />
    </span>
  );
}

/** Bare mark for the picker's provider tabs — no tile, just the glyph, so
 * the tab strip matches the reference (icons + sliding underline). */
export function ProviderGlyph({
  provider,
  size = 16,
  color,
}: {
  provider: string;
  size?: number;
  color?: string;
}) {
  const svg = providerSvg(provider);
  if (!svg) {
    return (
      <span
        className="flex items-center justify-center font-bold"
        style={{ width: size, height: size, color, fontSize: size - 2 }}
      >
        {provider.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <span
      className="provider-logo inline-flex items-center justify-center"
      style={{ width: size, height: size, color }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
