import { AGENTS } from "../content";
import { AgentLogo } from "./AgentLogo";
import { Reveal } from "./Reveal";

export function Agents() {
  // Doubled so the strip can loop by sliding exactly half its width.
  const row = [...AGENTS, ...AGENTS];
  return (
    <Reveal as="section" className="agents">
      <p className="eyebrow">Works with the agents you already have</p>
      <div className="marquee">
        <div className="marquee-track">
          {row.map((a, i) => (
            <div className="agent glass" key={i} aria-hidden={i >= AGENTS.length}>
              <AgentLogo provider={a.provider} name={a.name} />
              {a.name}
              <span className={`tag ${a.kind === "chat" ? "tag-chat" : ""}`}>{a.kind}</span>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
