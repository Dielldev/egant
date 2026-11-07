import { GitBranch, Library, Search, Undo2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "./Reveal";

const FEATURES: { icon: LucideIcon; title: string; keys?: string[]; body: string }[] = [
  {
    icon: GitBranch,
    title: "Isolated by default",
    body: "Every session can start in its own git worktree on its own branch. Parallel agents never step on each other, or on your checkout.",
  },
  {
    icon: Undo2,
    title: "Revert a turn",
    body: "Per-turn snapshots. When an agent goes the wrong way, roll back exactly one step.",
  },
  {
    icon: Search,
    title: "Find anything",
    keys: ["⌘", "K"],
    body: "Search every conversation and jump straight to the message.",
  },
  {
    icon: Library,
    title: "One library",
    body: "Add MCP servers and skills once. egant writes them into each agent's own config, in that agent's format.",
  },
];

export function Features() {
  return (
    <section className="section" id="features">
      <Reveal className="section-head">
        <p className="eyebrow">The workspace</p>
        <h2>
          Terminals were fine. <span className="dim">Until you had five agents.</span>
        </h2>
      </Reveal>
      <Reveal className="features stagger">
        {FEATURES.map(({ icon: Icon, title, keys, body }) => (
          <article className="feature" key={title}>
            <span className="feature-icon">
              <Icon size={16} strokeWidth={1.75} />
            </span>
            <h3>
              {title}
              {keys && (
                <span className="keys">
                  {keys.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </span>
              )}
            </h3>
            <p>{body}</p>
          </article>
        ))}
      </Reveal>
    </section>
  );
}
