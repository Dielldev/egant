import { useEffect, useRef } from "react";
import { ArrowRight } from "lucide-react";
import { HERO_SHOT, REPO } from "../content";
import { prefersReducedMotion } from "../useReveal";
import { GithubIcon } from "./GithubIcon";
import { Mark } from "./Mark";

const HEADLINE = ["Every", "coding", "agent.", "One", "window."];

export function Hero() {
  const frame = useRef<HTMLDivElement>(null);

  // The screenshot starts tipped back and settles flat as you scroll into it.
  useEffect(() => {
    const el = frame.current;
    if (!el || prefersReducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const p = Math.min(1, window.scrollY / (window.innerHeight * 0.55));
      el.style.setProperty("--tilt", `${(1 - p) * 16}deg`);
      el.style.setProperty("--scale", `${0.92 + p * 0.08}`);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section className="hero" id="top">
      <div className="hero-mark intro" style={{ animationDelay: "0ms" }}>
        <Mark width={72} wave />
      </div>
      <h1 className="hero-title">
        {HEADLINE.map((word, i) => (
          <span className="word" key={i}>
            <span style={{ animationDelay: `${150 + i * 70}ms` }} className={i > 2 ? "dim" : ""}>
              {word}
            </span>
          </span>
        ))}
      </h1>
      <p className="hero-sub intro" style={{ animationDelay: "650ms" }}>
        A native desktop app for the agent CLIs you already use — with worktrees, diffs, terminals
        and git right beside the chat. Styled the way you like it. Local, no account, no proxy.
      </p>
      <div className="hero-cta intro" style={{ animationDelay: "800ms" }}>
        <a className="btn btn-primary" href="#start">
          Get started <ArrowRight size={15} />
        </a>
        <a className="btn btn-glass" href={REPO}>
          <GithubIcon /> View source
        </a>
      </div>

      <div className="hero-stage intro" style={{ animationDelay: "1000ms" }}>
        <div className="hero-frame glass" ref={frame}>
          <img src={HERO_SHOT.src} alt={HERO_SHOT.alt} />
          <div className="status-pill glass">
            <span className="pulse" />
            <span className="shimmer">Pick an agent · Claude Code, Codex, opencode…</span>
          </div>
        </div>
      </div>
    </section>
  );
}
