import claudeLogo from "../assets/logos/claude.svg?raw";
import deepseekLogo from "../assets/logos/deepseek.svg?raw";
import googleLogo from "../assets/logos/google.svg?raw";
import metaLogo from "../assets/logos/meta.svg?raw";
import opencodeLogo from "../assets/logos/opencode.svg?raw";
import openaiLogo from "../assets/logos/openai.svg?raw";
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
    return (
      <span className={tile} style={{ width: size, height: size }}>
        <span className="text-[11px] font-semibold text-[var(--muted)]">
          {provider.slice(0, 1).toUpperCase()}
        </span>
      </span>
    );
  }
  return (
    <span className={`${tile} text-[var(--muted)]`} style={{ width: size, height: size }}>
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
