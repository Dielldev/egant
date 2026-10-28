import { Link } from "react-router-dom";
import { Mark } from "../components/Mark";
import { REPO } from "../content";
import { GUIDES } from "./guides";
import "./../styles.css";

export function GuidesPage() {
  return (
    <>
      <div className="backdrop" aria-hidden>
        <span className="glow glow-a" />
        <span className="glow glow-b" />
      </div>
      <header className="nav glass">
        <Link className="brand" to="/">
          <Mark width={20} />
          egant
        </Link>
        <nav className="nav-links">
          {GUIDES.map((guide) => (
            <a href={`#${guide.id}`} key={guide.id}>
              {guide.nav}
            </a>
          ))}
        </nav>
        <a className="btn btn-primary btn-sm" href="https://github.com/Dielldev/egant/releases/latest">
          Download
        </a>
      </header>
      <main>
        <section className="section guides-intro">
          <p className="eyebrow">Guides</p>
          <h1>
            Common questions, <span className="dim">answered.</span>
          </h1>
          <p className="lead">
            egant isn't in an app store, and it runs agents on your own machine — so a few things
            need one-time setup. These are the guides we point everyone at.
          </p>
          <div className="guides-index">
            {GUIDES.map((guide, i) => (
              <a className="guide-index-card glass" href={`#${guide.id}`} key={guide.id}>
                <span className="step-n">0{i + 1}</span>
                <span>
                  <b>{guide.nav}</b>
                  <br />
                  <span className="dim">{guide.summary}</span>
                </span>
              </a>
            ))}
          </div>
        </section>
        {GUIDES.map((guide) => (
          <section className="section guide" id={guide.id} key={guide.id}>
            <p className="eyebrow">{guide.tag}</p>
            <h2>{guide.title}</h2>
            <p className="lead">{guide.intro}</p>
            <ol className="steps guide-steps">
              {guide.steps.map((step, i) => (
                <li key={i}>
                  <span className="step-n">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    <b>{step.strong}</b> {step.rest}
                  </span>
                </li>
              ))}
            </ol>
            {guide.note && <p className="guide-note dim">{guide.note}</p>}
          </section>
        ))}
        <section className="guides-more">
          <p className="lead">
            Something we didn't cover? Ask on{" "}
            <a className="text-link" href={`${REPO}/issues`}>
              GitHub issues
            </a>{" "}
            — the good ones become new guides here.
          </p>
        </section>
      </main>
      <footer className="footer">
        <span className="brand">
          <Mark width={16} /> egant
        </span>
        <Link to="/">Back to the landing page</Link>
        <a href={REPO}>github.com/Dielldev/egant</a>
      </footer>
    </>
  );
}
