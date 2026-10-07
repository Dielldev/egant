import { useEffect, useState } from "react";
import { SHOWCASE } from "../content";
import { prefersReducedMotion, useInView } from "../useReveal";
import { Reveal } from "./Reveal";

const STEP_MS = 6000;

/** A tabbed tour of the app: one glass frame, screenshots cross-fading inside
 * it, advancing on its own until someone picks a tab or hovers the frame. */
export function Showcase() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const auto = seen && !paused && !prefersReducedMotion();

  useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => setActive((i) => (i + 1) % SHOWCASE.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [auto, active]);

  const shot = SHOWCASE[active];

  return (
    <section className="section" id="tour">
      <Reveal className="section-head">
        <p className="eyebrow">Inside egant</p>
        <h2>
          Built like a real desktop app. <span className="dim">Because it is one.</span>
        </h2>
      </Reveal>

      <Reveal className="showcase">
        <div className="tabs glass" role="tablist">
          {SHOWCASE.map((s, i) => (
            <button
              key={s.label}
              role="tab"
              aria-selected={i === active}
              className={i === active ? "on" : ""}
              onClick={() => {
                setActive(i);
                setPaused(true);
              }}
            >
              {s.label}
              {i === active && auto && (
                <span className="tab-progress" style={{ animationDuration: `${STEP_MS}ms` }} />
              )}
            </button>
          ))}
        </div>

        <div
          className="showcase-frame glass"
          ref={ref}
          onPointerEnter={() => setPaused(true)}
          onPointerLeave={() => setPaused(false)}
        >
          {SHOWCASE.map((s, i) => (
            <img
              key={s.label}
              src={s.src}
              alt={s.alt}
              loading="lazy"
              className={i === active ? "on" : ""}
              aria-hidden={i !== active}
            />
          ))}
        </div>

        <div className="showcase-caption" key={shot.label}>
          <h3>{shot.title}</h3>
          <p>{shot.body}</p>
        </div>
      </Reveal>
    </section>
  );
}
