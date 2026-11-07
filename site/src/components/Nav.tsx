import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Mark } from "./Mark";
import { ScrollProgress } from "./ScrollProgress";
import { ThemeToggle } from "./ThemeToggle";

const SECTIONS = [
  ["features", "Features"],
  ["tour", "Tour"],
  ["themes", "Themes"],
  ["phone", "Phone"],
] as const;

export function Nav() {
  const [active, setActive] = useState("");

  // Highlights the link for whichever section is crossing the middle of the screen.
  useEffect(() => {
    const ids = [...SECTIONS.map(([id]) => id), "start"];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  const cls = (id: string) => (active === id ? "on" : undefined);

  return (
    <header className="nav">
      <div className="nav-in">
        <a className="brand" href="#top">
          <Mark width={20} />
          egant
        </a>
        <nav className="nav-links">
          {SECTIONS.map(([id, label]) => (
            <a href={`#${id}`} className={cls(id)} key={id}>
              {label}
            </a>
          ))}
          <Link to="/guides">Guides</Link>
          <a href="#start" className={cls("start")}>
            Build it
          </a>
        </nav>
        <div className="nav-end">
          <ThemeToggle />
          <a className="btn btn-primary btn-sm" href="#download">
            Download
          </a>
        </div>
      </div>
      <ScrollProgress />
    </header>
  );
}
