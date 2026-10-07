import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { DOWNLOAD } from "../content";
import { Mark } from "./Mark";

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`nav glass ${scrolled ? "nav-scrolled" : ""}`}>
      <a className="brand" href="#top">
        <Mark width={20} />
        egant
      </a>
      <nav className="nav-links">
        <a href="#features">Features</a>
        <a href="#tour">Tour</a>
        <a href="#themes">Themes</a>
        <a href="#phone">Phone</a>
        <a href="#start">Build it</a>
      </nav>
      <a className="btn btn-primary btn-sm" href={DOWNLOAD.url}>
        <Download size={14} />
        Download
      </a>
    </header>
  );
}
