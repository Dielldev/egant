import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./mobile.css";

// The app is exactly as tall as what the phone leaves visible, so the
// composer sits right on top of the keyboard instead of under it. iOS never
// shrinks the layout viewport for the keyboard — only the visual one.
function syncViewport(): void {
  const viewport = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty("--app-height", `${Math.round(viewport?.height ?? window.innerHeight)}px`);
  root.setProperty("--app-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
}
window.visualViewport?.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("scroll", syncViewport);
window.addEventListener("resize", syncViewport);
syncViewport();

// The desktop's default palette is its dark one; a phone in light mode gets
// the desktop's light palette.
const light = window.matchMedia("(prefers-color-scheme: light)");
function syncTheme(): void {
  const html = document.documentElement;
  if (light.matches) html.dataset.palette = "zeron-light";
  else delete html.dataset.palette;
  html.dataset.theme = light.matches ? "light" : "dark";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", light.matches ? "#f2f2f5" : "#0d0d0d");
}
light.addEventListener("change", syncTheme);
syncTheme();

// Lets the app open with the Mac out of reach, to say so. Only where a
// service worker is allowed at all: HTTPS (through Tailscale) or this
// machine's own loopback.
if ("serviceWorker" in navigator && window.isSecureContext && !import.meta.env.DEV) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
