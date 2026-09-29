import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";
import { installSoundUnlock } from "./lib/notify";
import { installTitlebarDragHandler, isLinux } from "./lib/platform";
import { useEgant } from "./store";

// Tag the document before the first React paint so Linux glass CSS (opaque
// window + solid fills) applies immediately — no transparent "desktop hole".
if (isLinux()) {
  document.documentElement.dataset.platform = "linux";
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
