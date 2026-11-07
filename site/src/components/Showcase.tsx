import { useState } from "react";
import { SHOWCASE } from "../content";
import { Reveal } from "./Reveal";
import { ScrollFrame } from "./ScrollFrame";

/** A tour of the app: pick a stop on the left, see it on the right. */
export function Showcase() {
  const [active, setActive] = useState(0);

  return (
    <section className="section" id="tour">
      <Reveal className="section-head">
        <p className="eyebrow">Inside egant</p>
        <h2>
          Built like a real desktop app. <span className="dim">Because it is one.</span>
        </h2>
      </Reveal>

      <Reveal className="tour">
        <div className="tour-list" role="tablist">
          {SHOWCASE.map((s, i) => (
            <button
              key={s.label}
              role="tab"
              aria-selected={i === active}
              className={i === active ? "on" : ""}
              onClick={() => setActive(i)}
            >
              <span className="tour-label">{s.label}</span>
              {i === active && (
                <span className="tour-body">
                  <b>{s.title}</b> {s.body}
                </span>
              )}
            </button>
          ))}
        </div>

        <ScrollFrame className="frame tour-frame">
          {SHOWCASE.map((s, i) => (
            <img key={s.label} src={s.src} alt={s.alt} loading="lazy" hidden={i !== active} />
          ))}
        </ScrollFrame>
      </Reveal>
    </section>
  );
}
