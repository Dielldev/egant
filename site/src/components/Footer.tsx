import { ArrowRight } from "lucide-react";
import { REPO } from "../content";
import { Mark } from "./Mark";
import { Reveal } from "./Reveal";

export function Footer() {
  return (
    <>
      <section className="closing">
        <Reveal>
          <Mark width={56} wave />
          <h2>
            Stop juggling terminals.
            <br />
            <span className="dim">Start running agents.</span>
          </h2>
          <a className="btn btn-primary" href={REPO}>
            Get egant on GitHub <ArrowRight size={15} />
          </a>
        </Reveal>
      </section>
      <footer className="footer">
        <span className="brand">
          <Mark width={16} /> egant
        </span>
        <span>Tauri · Rust · React — everything runs on your machine.</span>
        <a href={REPO}>github.com/Dielldev/egant</a>
      </footer>
    </>
  );
}
