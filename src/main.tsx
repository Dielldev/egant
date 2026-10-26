import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { installSoundUnlock } from "./lib/notify";
import { installTitlebarDragHandler, isLinux, isWindows } from "./lib/platform";
import { useEgant } from "./store";

// Tag the document before the first React paint so platform glass CSS applies
// immediately — no transparent "desktop hole". Windows starts solid and
// switches once `sync_window_appearance` reports which native backdrop took.
if (isLinux()) {
  document.documentElement.dataset.platform = "linux";
} else if (isWindows()) {
  document.documentElement.dataset.platform = "windows";
  document.documentElement.dataset.windowGlass = "false";
}

installTitlebarDragHandler();
installSoundUnlock();

if (import.meta.env.DEV) {
  // Testing hook only: lets Playwright seed snapshots and transcripts so the
  // panes can be screenshotted without a backend. Never set in production.
  (window as unknown as { __egant: typeof useEgant }).__egant = useEgant;
}

// No StrictMode: its dev-only double-mount would subscribe the `session-event`
// stream twice and fold every delta twofold.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
