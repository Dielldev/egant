import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Link } from "react-router-dom";
import { DOWNLOADS, REPO, detectOs, type DownloadOs } from "../content";
import { Mark } from "./Mark";
import { Reveal } from "./Reveal";

export function Footer() {
  const [os, setOs] = useState<DownloadOs>(() => detectOs());

  useEffect(() => {
    setOs(detectOs());
  }, []);

  const downloads = [DOWNLOADS[os], ...Object.values(DOWNLOADS)].filter(
    (download, i, all) => all.indexOf(download) === i,
  );

  return (
    <>
      <section className="closing" id="download">
        <Reveal>
          <Mark width={56} wave />
          <h2>
            Stop juggling terminals.
            <br />
            <span className="dim">Start running agents.</span>
          </h2>
          <div className="closing-cta">
            {downloads.map((download, i) => (
              <a
                className={`btn ${i === 0 ? "btn-primary" : "btn-glass"}`}
                href={download.url}
                key={download.os}
              >
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
        <Link to="/guides">Guides</Link>
      </footer>
    </>
  );
}
