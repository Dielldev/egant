import type { PointerEvent, ReactNode } from "react";
import { LibrarySync, RevertTurn, SearchPalette, Worktrees } from "./FeatureVisuals";
import { Reveal } from "./Reveal";

/** Moves the card's soft highlight to follow the pointer. */
function track(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
}

function Card({
  wide = false,
  delay = 0,
  visual,
  title,
  keys,
  children,
}: {
  wide?: boolean;
  delay?: number;
  visual: ReactNode;
  title: string;
  keys?: string[];
  children: ReactNode;
}) {
  return (
    <Reveal as="article" delay={delay} className={`bento-card glass ${wide ? "wide" : ""}`}>
      <div className="bento-inner" onPointerMove={track}>
        <div className="bento-visual">{visual}</div>
        <div className="bento-text">
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
          <p>{children}</p>
        </div>
      </div>
    </Reveal>
  );
}

export function Features() {
  return (
    <section className="section" id="features">
      <Reveal className="section-head">
        <p className="eyebrow">The workspace</p>
        <h2>
          Terminals were fine. <span className="dim">Until you had five agents.</span>
        </h2>
      </Reveal>
      <div className="bento">
        <Card wide visual={<Worktrees />} title="Isolated by default">
          Every session can start in its own git worktree on its own branch. Parallel agents never
          step on each other, or on your checkout.
        </Card>
        <Card delay={90} visual={<RevertTurn />} title="Revert a turn">
          Per-turn snapshots. When an agent goes the wrong way, roll back exactly one step.
        </Card>
        <Card visual={<SearchPalette />} title="Find anything" keys={["⌘", "K"]}>
          Search every conversation and jump straight to the message.
        </Card>
        <Card wide delay={90} visual={<LibrarySync />} title="One library">
          Add MCP servers and skills once. egant writes them into each agent's own config, in that
          agent's format.
        </Card>
      </div>
    </section>
  );
}
