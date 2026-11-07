import { AGENTS } from "../content";
import { AgentLogo } from "./AgentLogo";
import { Reveal } from "./Reveal";

export function Agents() {
  return (
    <section className="agents">
      <p className="eyebrow">Works with the agents you already have</p>
      <Reveal as="ul" className="agent-list stagger">
        {AGENTS.map((a) => (
          <li key={a.provider}>
            <AgentLogo provider={a.provider} name={a.name} />
            {a.name}
          </li>
        ))}
      </Reveal>
    </section>
  );
}
