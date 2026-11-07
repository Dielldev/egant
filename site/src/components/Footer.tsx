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
  const primary = DOWNLOADS[os];

  return (
    <>
      <section className="closing" id="download">
        <Reveal>
          <h2>
            Stop juggling terminals. <span className="dim">Start running agents.</span>
          </h2>
          <div className="closing-cta">
            {downloads.map((download, i) => (
              <a
                className={`btn ${i === 0 ? "btn-primary" : "btn-outline"}`}
                href={download.url}
                key={download.os}
              >
                <Download size={15} /> {download.label}
              </a>
            ))}
          </div>
          <p className="hero-note">
            {primary.detail} · {primary.note} ·{" "}
            <Link to={primary.guide} className="text-link">
              {primary.guideLabel}
            </Link>
          </p>
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
