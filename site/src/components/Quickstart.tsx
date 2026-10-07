import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { QUICKSTART } from "../content";
import { prefersReducedMotion, useInView } from "../useReveal";
import { Reveal } from "./Reveal";

/** Types the quickstart commands out once the terminal scrolls into view. */
function useTyping(lines: string[], start: boolean) {
  const [line, setLine] = useState(0);
  const [col, setCol] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (prefersReducedMotion()) {
      setLine(lines.length);
      return;
    }
    if (line >= lines.length) return;
    const done = col >= lines[line].length;
    const t = window.setTimeout(
      () => (done ? (setLine(line + 1), setCol(0)) : setCol(col + 1)),
      done ? 420 : 24 + Math.random() * 36,
    );
    return () => window.clearTimeout(t);
  }, [start, line, col, lines]);
  return { line, col };
}

export function Quickstart() {
  const [ref, seen] = useInView<HTMLDivElement>(0.4);
  const { line, col } = useTyping(QUICKSTART, seen);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard?.writeText(QUICKSTART.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="section" id="start">
      <Reveal className="section-head">
        <p className="eyebrow">Build from source</p>
        <h2>
          Four commands. <span className="dim">That's it.</span>
        </h2>
        <p className="lead">
          Prefer to build it yourself? You'll need Rust 1.85+, Node 20+, and at least one agent CLI
          on your PATH.
        </p>
      </Reveal>
      <Reveal className="terminal glass">
        <div className="terminal-bar">
          <i />
          <i />
          <i />
          <span>zsh</span>
          <button className="copy" onClick={copy} aria-label="Copy commands">
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="terminal-body" ref={ref}>
          {QUICKSTART.map((cmd, i) =>
            i > line ? null : (
              <div key={cmd}>
                <span className="prompt">❯</span> {i < line ? cmd : cmd.slice(0, col)}
                {i === line && <span className="caret" />}
              </div>
            ),
          )}
          {line >= QUICKSTART.length && (
            <div>
              <span className="prompt">❯</span> <span className="caret" />
            </div>
          )}
        </div>
      </Reveal>
    </section>
  );
}
