import { providerSvg } from "@egant/components/ProviderLogo";

/** A provider's vendored mark, monochrome, or its initial when there is none. */
export function AgentLogo({ provider, name }: { provider: string; name: string }) {
  const svg = providerSvg(provider);
  if (!svg) return <span className="agent-logo agent-initial">{name[0]}</span>;
  return <span className="agent-logo" dangerouslySetInnerHTML={{ __html: svg }} />;
}
