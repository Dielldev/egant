import { Download } from "lucide-react";
import { DOWNLOADS, REPO } from "../content";
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
          <div className="closing-cta">
            {Object.values(DOWNLOADS).map((download) => (
              <a className="btn btn-primary" href={download.url} key={download.os}>
                <Download size={15} /> {download.label}
              </a>
            ))}
          </div>
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
