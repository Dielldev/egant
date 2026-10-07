import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { RotateCcw } from "lucide-react";
import { prefersReducedMotion } from "../useReveal";
import { AgentLogo } from "./AgentLogo";
import { Mark } from "./Mark";

/** Overlay position for an HTML element sitting on an SVG coordinate. */
const at = (x: number, y: number, w: number, h: number): CSSProperties => ({
  left: `${(x / w) * 100}%`,
  top: `${(y / h) * 100}%`,
});

/* ---------- worktrees ---------- */

const WT_W = 600;
const WT_H = 240;
const MAIN_Y = 205;
const BRANCH_END = 430;
const BRANCHES = [
  { provider: "claude", name: "Claude Code", branch: "claude/checkout-flow", y: 40, from: 60 },
  { provider: "codex", name: "Codex", branch: "codex/flaky-tests", y: 100, from: 130 },
  { provider: "opencode", name: "opencode", branch: "opencode/dark-mode", y: 160, from: 200 },
];
const branchPath = (from: number, y: number) =>
  `M${from} ${MAIN_Y} C ${from + 45} ${MAIN_Y}, ${from + 25} ${y}, ${from + 80} ${y} H ${BRANCH_END}`;

/** Three agents, three worktrees, three branches — and main left alone. */
export function Worktrees() {
  return (
    <div className="viz" style={{ aspectRatio: `${WT_W} / ${WT_H}` }}>
      <svg viewBox={`0 0 ${WT_W} ${WT_H}`} className="viz-svg">
        <path d={`M20 ${MAIN_Y} H580`} className="wt-main" />
        <text x="20" y={MAIN_Y + 24} className="viz-label">
          main · your checkout, untouched
        </text>
        {BRANCHES.map((b, i) => {
          const d = branchPath(b.from, b.y);
          return (
            <g key={b.branch} style={{ "--d": `${i * 0.25}s` } as CSSProperties}>
              <circle cx={b.from} cy={MAIN_Y} r="4" className="wt-root" />
              <path d={d} pathLength={1} className="wt-branch" />
              <text x={b.from + 92} y={b.y - 12} className="viz-label wt-label">
                {b.branch}
              </text>
              {[150, 230].map((dx) =>
                b.from + dx < BRANCH_END - 20 ? (
                  <circle key={dx} cx={b.from + dx} cy={b.y} r="4" className="wt-commit" />
                ) : null,
              )}
              <circle r="3" className="wt-pulse">
                <animateMotion dur="3.2s" begin={`${i * 0.9}s`} repeatCount="indefinite" path={d} />
              </circle>
            </g>
          );
        })}
      </svg>
      {BRANCHES.map((b, i) => (
        <div
          key={b.provider}
          className="viz-chip wt-tip"
          style={{ ...at(BRANCH_END + 14, b.y, WT_W, WT_H), animationDelay: `${0.9 + i * 0.25}s` }}
        >
          <AgentLogo provider={b.provider} name={b.name} />
          <span className="viz-name">{b.name}</span>
          <span className="live-dot" />
        </div>
      ))}
    </div>
  );
}

/* ---------- revert a turn ---------- */

const TURNS = [
  { label: "Scaffold checkout route", add: 48, del: 3 },
  { label: "Wire up Stripe client", add: 31, del: 0 },
  { label: "Rewrite the whole cart", add: 390, del: 212 },
];

/** A turn goes sideways, gets reverted, and the session carries on. */
export function RevertTurn() {
  return (
    <div className="viz revert">
      {TURNS.map((t, i) => (
        <div key={t.label} className={`turn ${i === TURNS.length - 1 ? "turn-bad" : ""}`}>
          <span className="turn-n">T{i + 1}</span>
          <span className="turn-label">{t.label}</span>
          <span className="turn-diff">
            <i>+{t.add}</i> <s>−{t.del}</s>
          </span>
        </div>
      ))}
      <div className="revert-row">
        <span className="revert-btn">
          <RotateCcw size={12} /> Revert turn 3
        </span>
        <span className="revert-done">Restored to T2 ✓</span>
      </div>
    </div>
  );
}

/* ---------- ⌘K search ---------- */

const QUERY = "stripe";
const RESULTS = [
  { title: "Add checkout flow", before: "…wire up ", after: " in test mode, then run…", when: "2d" },
  { title: "Fix payments test", before: "…mock the ", after: " client so the suite…", when: "5d" },
  { title: "Webhooks", before: "…verify the ", after: " signing secret before…", when: "1w" },
];

/** Types a query, shows the hits, clears, and goes again. */
export function SearchPalette() {
  const [typed, setTyped] = useState(prefersReducedMotion() ? QUERY.length : 0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    // Type, hold on the results, then clear and start over.
    const delay = typed < QUERY.length ? 140 : 3200;
    const t = window.setTimeout(() => {
      if (typed < QUERY.length) setTyped(typed + 1);
      else {
        setTyped(0);
        setTick((n) => n + 1);
      }
    }, typed === 0 ? 700 : delay);
    return () => window.clearTimeout(t);
  }, [typed, tick]);

  const ready = typed >= 3;
  const word = "Stripe";

  return (
    <div className="viz palette">
      <div className="palette-input">
        <kbd>⌘K</kbd>
        <span>{QUERY.slice(0, typed)}</span>
        <span className="caret" />
      </div>
      <div className={`palette-results ${ready ? "on" : ""}`}>
        {RESULTS.map((r, i) => (
          <div key={r.title} className={`palette-row ${i === 0 ? "sel" : ""}`} style={{ transitionDelay: `${i * 70}ms` }}>
            <span className="palette-title">{r.title}</span>
            <span className="palette-snippet">
              {r.before}
              <mark>{word}</mark>
              {r.after}
            </span>
            <span className="palette-when">{r.when}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- library sync ---------- */

const LIB_W = 600;
const LIB_H = 220;
const HUB = { x: 290, y: 110 };
const SERVERS = [
  { name: "Playwright", y: 45 },
  { name: "Context7", y: 110 },
  { name: "Supabase", y: 175 },
];
const TARGETS = [
  { provider: "claude", name: "Claude Code", file: ".claude.json", y: 30 },
  { provider: "codex", name: "Codex", file: "config.toml", y: 83 },
  { provider: "opencode", name: "opencode", file: "opencode.json", y: 137 },
  { provider: "antigravity", name: "Antigravity", file: "mcp_config.json", y: 190 },
];
const SERVER_X = 150;
const TARGET_X = 420;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;

/** Servers go into the Library once and fan out to every agent's own config. */
export function LibrarySync() {
  return (
    <div className="viz" style={{ aspectRatio: `${LIB_W} / ${LIB_H}` }}>
      <svg viewBox={`0 0 ${LIB_W} ${LIB_H}`} className="viz-svg">
        {SERVERS.map((s) => (
          <path key={s.name} d={curve(SERVER_X, s.y, HUB.x - 30, HUB.y)} className="lib-line" />
        ))}
        {TARGETS.map((t, i) => {
          const d = curve(HUB.x + 30, HUB.y, TARGET_X, t.y);
          return (
            <g key={t.provider}>
              <path d={d} className="lib-line" />
              <circle r="3" className="wt-pulse">
                <animateMotion dur="2.4s" begin={`${i * 0.45}s`} repeatCount="indefinite" path={d} />
              </circle>
            </g>
          );
        })}
      </svg>
      {SERVERS.map((s) => (
        <div key={s.name} className="viz-chip lib-server" style={at(SERVER_X, s.y, LIB_W, LIB_H)}>
          <span className="lib-initial">{s.name[0]}</span>
          <span className="viz-name">{s.name}</span>
        </div>
      ))}
      <div className="lib-hub" style={at(HUB.x, HUB.y, LIB_W, LIB_H)}>
        <Mark width={26} wave />
      </div>
      {TARGETS.map((t) => (
        <div key={t.provider} className="viz-chip lib-target" style={at(TARGET_X, t.y, LIB_W, LIB_H)}>
          <AgentLogo provider={t.provider} name={t.name} />
          <span className="lib-file viz-name">{t.file}</span>
        </div>
      ))}
    </div>
  );
}
