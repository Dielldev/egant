import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { QUICKSTART } from "../content";
import { Reveal } from "./Reveal";

export function Quickstart() {
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
          Prefer to build it yourself? You'll need Rust 1.88+, Node 20+, and at least one agent CLI
          on your PATH.
        </p>
      </Reveal>
      <Reveal className="terminal">
        <div className="terminal-bar">
          <span>zsh</span>
          <button className="copy" onClick={copy} aria-label="Copy commands">
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <Reveal className="terminal-body stagger">
          {QUICKSTART.map((cmd) => (
            <div key={cmd}>
              <span className="prompt">❯</span> {cmd}
            </div>
          ))}
        </Reveal>
      </Reveal>
    </section>
  );
}
