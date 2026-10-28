import { useState } from "react";
import { providerSvg } from "./ProviderLogo";

export const MCP_DOMAINS: Record<string, string> = {
  playwright: "playwright.dev",
  context7: "upstash.com",
  supabase: "supabase.com",
  vercel: "vercel.com",
  sentry: "sentry.io",
  stripe: "stripe.com",
  figma: "figma.com",
  linear: "linear.app",
  slack: "slack.com",
  cloudflare: "cloudflare.com",
  netlify: "netlify.com",
  chrome_devtools: "developer.chrome.com",
  atlassian: "atlassian.com",
  notion: "notion.com",
  notra: "usenotra.com",
  clerk: "clerk.com",
  planetscale: "planetscale.com",
  neon: "neon.tech",
  bigquery: "cloud.google.com",
  hugging_face: "huggingface.co",
  exa: "exa.ai",
  parallel: "parallel.ai",
  openrouter: "openrouter.ai",
  resend: "resend.com",
  posthog: "posthog.com",
  honeycomb: "honeycomb.io",
  graphos: "apollographql.com",
  dev_manager: "bloop.ai",
  sanity: "sanity.io",
  amplitude: "amplitude.com",
  asana: "asana.com",
  clickup: "clickup.com",
  microsoft_learn: "microsoft.com",
  jam: "jam.dev",
  webflow: "webflow.com",
  cloudinary: "cloudinary.com",
  wordpress: "wordpress.com",
  canva: "canva.com",
  miro: "miro.com",
  intercom: "intercom.com",
  make: "make.com",
  aws_marketplace: "aws.amazon.com",
  motherduck: "motherduck.com",
  magic_patterns: "magicpatterns.com",
  wix: "wix.com",
  devrev: "devrev.ai",
  prisma: "prisma.io",
  railway: "railway.com",
  mongodb: "mongodb.com",
  monday: "monday.com",
  shopify: "shopify.com",
  graphite: "graphite.com",
  executor: "executor.sh",
  axiom: "axiom.co",
  azure: "azure.microsoft.com",
};

export function getMcpLogoUrl(params: {
  id?: string | null;
  name?: string | null;
  url?: string | null;
  docsUrl?: string | null;
}): string | null {
  const { id, name, url, docsUrl } = params;
  const key = (id || "").toLowerCase().replace(/[^a-z0-9]/g, "_");
  const normName = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "_");
  const domain = MCP_DOMAINS[key] || MCP_DOMAINS[normName];

  if (domain && domain !== "bloop.ai") {
    return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=64`;
  }

  for (const u of [url, docsUrl]) {
    if (!u) continue;
    try {
      const parsed = new URL(u);
      if (parsed.hostname.includes("github.com")) {
        const parts = parsed.pathname.split("/").filter(Boolean);
        if (parts.length >= 1) {
          return `https://github.com/${parts[0]}.png`;
        }
      } else {
        const parts = parsed.hostname.split(".");
        const root = parts.slice(-2).join(".");
        return `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${root}&size=64`;
      }
    } catch {
      // not a valid URL
    }
  }

  return null;
}

export function resolveSkillVendor(
  source?: string | null,
  agents?: string[],
  name?: string | null,
): { vendor?: string; logoUrl?: string } | null {
  const src = (source || "").toLowerCase();

  // 1. Check known company/provider sources
  if (src.includes("anthropic") || src.includes("claude")) return { vendor: "claude" };
  if (src.includes("vercel")) return { vendor: "vercel" };
  if (src.includes("openai")) return { vendor: "openai" };
  if (src.includes("google") || src.includes("gemini")) return { vendor: "google" };
  if (src.includes("meta") || src.includes("facebook")) return { vendor: "meta" };
  if (src.includes("cloudflare")) {
    return {
      logoUrl:
        "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://cloudflare.com&size=64",
    };
  }
  if (src.includes("supabase")) {
    return {
      logoUrl:
        "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://supabase.com&size=64",
    };
  }
  if (src.includes("microsoft") || src.includes("azure")) {
    return {
      logoUrl:
        "https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://microsoft.com&size=64",
    };
  }
  if (src.includes("github")) return { vendor: "github" };
  if (src.includes("deepseek")) return { vendor: "deepseek" };
  if (src.includes("qwen")) return { vendor: "qwen" };
  if (src.includes("antigravity")) return { vendor: "antigravity" };
  if (src.includes("cursor")) return { vendor: "cursor" };

  // 2. Canonical ecosystem framework names
  const n = (name || "").toLowerCase();
  if (n.startsWith("nextjs") || n.startsWith("next.js") || n.includes("nextjs")) {
    return { vendor: "vercel" };
  }
  if (n.startsWith("claude") || n.includes("claude-")) {
    return { vendor: "claude" };
  }

  // 3. For any other GitHub owner (owner/repo)
  if (source && source.includes("/")) {
    const owner = source.split("/")[0].trim();
    if (owner && /^[a-zA-Z0-9_-]+$/.test(owner)) {
      return { logoUrl: `https://github.com/${owner}.png` };
    }
  }

  // 4. If source is missing/local and the skill is tied specifically to one agent
  if (!source && agents && agents.length === 1) {
    const agent = agents[0].toLowerCase();
    if (["claude", "cursor", "codex", "opencode", "antigravity"].includes(agent)) {
      return { vendor: agent === "codex" ? "openai" : agent };
    }
  }

  return null;
}

function ImageTile({
  src,
  size,
}: {
  src: string;
  size: number;
}) {
  const [error, setError] = useState(false);
  if (error) return null;

  return (
    <img
      src={src}
      alt=""
      className="shrink-0 rounded-md object-contain"
      style={{ width: size, height: size }}
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}

export function McpLogo({
  id,
  name,
  url,
  docsUrl,
  size = 28,
}: {
  id?: string | null;
  name?: string | null;
  url?: string | null;
  docsUrl?: string | null;
  size?: number;
}) {
  const logoUrl = getMcpLogoUrl({ id, name, url, docsUrl });
  if (!logoUrl) return null;

  return <ImageTile src={logoUrl} size={size} />;
}

export function SkillLogo({
  source,
  name,
  agents,
  size = 28,
}: {
  source?: string | null;
  name?: string | null;
  agents?: string[];
  size?: number;
}) {
  const resolved = resolveSkillVendor(source, agents, name);
  if (!resolved) return null;

  if (resolved.vendor) {
    const svg = providerSvg(resolved.vendor);
    if (svg) {
      return (
        <span
          className="flex shrink-0 items-center justify-center text-[var(--ink)]"
          style={{
            width: size,
            height: size,
          }}
        >
          <span className="provider-logo" dangerouslySetInnerHTML={{ __html: svg }} />
        </span>
      );
    }
  }

  if (resolved.logoUrl) {
    return <ImageTile src={resolved.logoUrl} size={size} />;
  }

  return null;
}
