import ampLogo from "../assets/logos/amp.svg?raw";
import antigravityLogo from "../assets/logos/antigravity.svg?raw";
import claudeLogo from "../assets/logos/claude.svg?raw";
import clineLogo from "../assets/logos/cline.svg?raw";
import copilotLogo from "../assets/logos/copilot.svg?raw";
import cursorLogo from "../assets/logos/cursor.svg?raw";
import deepseekLogo from "../assets/logos/deepseek.svg?raw";
import devinLogo from "../assets/logos/devin.svg?raw";
import githubLogo from "../assets/logos/github.svg?raw";
import gooseLogo from "../assets/logos/goose.svg?raw";
import googleLogo from "../assets/logos/google.svg?raw";
import metaLogo from "../assets/logos/meta.svg?raw";
import nousLogo from "../assets/logos/nous.svg?raw";
import openhandsLogo from "../assets/logos/openhands.svg?raw";
import opencodeLogo from "../assets/logos/opencode.svg?raw";
import openaiLogo from "../assets/logos/openai.svg?raw";
import piLogo from "../assets/logos/pi.svg?raw";
import qwenLogo from "../assets/logos/qwen.svg?raw";
import vercelLogo from "../assets/logos/vercel.svg?raw";
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
  vercel: vercelLogo,
  github: githubLogo,
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

export const BRAND_COLORS: Record<string, string> = {
  claude: "#e8835a",
  anthropic: "#e8835a",
  google: "#4285f4",
  gemini: "#4285f4",
  antigravity: "#4285f4",
  openai: "#10a37f",
  codex: "#10a37f",
  opencode: "#8e7cf6",
};

/** Accent for the monogram tile an agent with no vendored mark falls back to.
 * A tinted initial reads as a deliberate placeholder; the default grey letter
 * read as a missing asset. Marks themselves stay monochrome, so the row is one
 * consistent icon system rather than a mix of tinted and untinted art. */
export const TINTS: Record<string, string> = {};

export function providerSvg(provider: string): string | null {
  return LOGOS[provider.toLowerCase()] ?? null;
}

/** Brand mark for a model provider. Unknown providers get an initial tile,
 * so the list never depends on asset coverage. The tile clips its glyph
 * (`overflow-hidden`) so wide wordmarks can never bleed into the row text. */
export function ProviderLogo({
  provider,
  size = 24,
  color,
  className,
}: {
  provider: string;
  size?: number;
  color?: string;
  className?: string;
}) {
  const svg = providerSvg(provider);
  if (!svg) {
    const tile =
      "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)]";
    return (
      <span
        className={`${tile} ${className ?? ""}`}
        style={{
          width: size,
          height: size,
        }}
      >
        <span
          className="font-semibold text-[var(--muted)]"
          style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}
        >
          {provider.slice(0, 1).toUpperCase()}
        </span>
      </span>
    );
  }
  return (
    <span
      className={`provider-logo inline-flex shrink-0 items-center justify-center text-[var(--ink)] ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        color: color ?? "var(--ink)",
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** Bare mark for the picker's provider tabs and inline agent icons. */
export function ProviderGlyph({
  provider,
  size = 16,
  color,
  className,
  wave,
}: {
  provider: string;
  size?: number;
  color?: string;
  className?: string;
  wave?: boolean;
}) {
  const svg = providerSvg(provider);
  if (!svg) {
    return (
      <span
        className={`flex items-center justify-center font-bold text-[var(--ink)] ${wave ? "shimmer" : ""} ${className ?? ""}`}
        style={{ width: size, height: size, color: color ?? "var(--ink)", fontSize: size - 2 }}
      >
        {provider.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  if (wave) {
    const dataUri = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
    return (
      <span
        className={`logo-wave inline-block shrink-0 ${className ?? ""}`}
        style={{
          width: size,
          height: size,
          WebkitMaskImage: dataUri,
          maskImage: dataUri,
        }}
      />
    );
  }
  return (
    <span
      className={`provider-logo inline-flex items-center justify-center text-[var(--ink)] ${className ?? ""}`}
      style={{ width: size, height: size, color: color ?? "var(--ink)" }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
