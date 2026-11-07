import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Link } from "react-router-dom";
import { DOWNLOADS, HERO_IMAGE, REPO, detectOs, type DownloadOs } from "../content";
import { leaveProgress, useScrollProgress } from "../useReveal";
import { GithubIcon } from "./GithubIcon";

export function Hero() {
  const [os, setOs] = useState<DownloadOs>(() => detectOs());

  useEffect(() => {
    setOs(detectOs());
  }, []);

  // The visitor's own OS first.
  const downloads = [DOWNLOADS[os], ...Object.values(DOWNLOADS)].filter(
    (download, i, all) => all.indexOf(download) === i,
  );
  const primary = DOWNLOADS[os];
  const card = useScrollProgress<HTMLDivElement>(leaveProgress, 0);

  return (
    <section className="hero" id="top">
      <div className="hero-card" ref={card}>
        <div className="hero-media">
          <img className="hero-img" src={HERO_IMAGE} alt="" />
        </div>
        <div className="hero-content">
          <h1>
            Every coding agent. <span>One window.</span>
          </h1>
          <p className="hero-sub">
            A native desktop app for the agent CLIs you already use — worktrees, diffs, terminals
            and git beside the chat. Local, no account, no proxy.
          </p>
          <div className="hero-cta">
            {downloads.map((download, i) => (
              <a
                className={`btn ${i === 0 ? "btn-light" : "btn-ghost-light"}`}
                href={download.url}
                key={download.os}
              >
                <Download size={15} /> {download.label}
              </a>
            ))}
            <a className="btn btn-ghost-light" href={REPO}>
              <GithubIcon /> Source
            </a>
          </div>
        </div>
      </div>
      <p className="hero-note">
        {primary.detail} · {primary.note} ·{" "}
        <Link to={primary.guide} className="text-link">
          {primary.guideLabel}
        </Link>
      </p>
    </section>
  );
}
