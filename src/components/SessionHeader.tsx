import { PanelRight, PanelRightClose } from "lucide-react";
import { useEgant } from "../store";
import { AGENT_ACCENT, AGENT_PROVIDER, agentName } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";
import { WindowBar } from "./WindowBar";

/** The line across the top of the stage: which conversation this is, and where
 * it runs. It replaced a tab strip — the sidebar already lists every session,
 * so a second list of the same thing was the window saying it twice. Draws no
 * background of its own, so the stage runs to the top of the window.
 *
 * With the sidebar hidden the stage becomes the leftmost column, so the title
 * bar's buttons move here with it — otherwise there would be no way back to
 * the sidebar. `bare` is the launch screen, which has nothing to name yet. */
export function SessionHeader({ bare }: { bare?: boolean }) {
  const snapshot = useEgant((s) => s.snapshot);

  const active = snapshot?.sessions.find((s) => s.id === snapshot?.activeSession);
  const project = snapshot?.projects.find((p) => p.id === active?.projectId);
  const agents = useEgant((s) => s.agents);
  const catalog = useEgant((s) => s.catalog);
  const sidebarVisible = snapshot?.sidebarVisible ?? true;
  // The catalog names every agent, including the ones with no harness behind
  // them; `agentName` alone would print a bare `goose` for a CLI session.
  const agentLabel = active?.agent
    ? (catalog.find((c) => c.id === active.agent)?.name ?? agentName(agents, active.agent))
    : "";

  return (
    <div className="flex w-full shrink-0 flex-col">
      {!sidebarVisible && <WindowBar />}
      {bare ? (
        // The strip still has to exist with the sidebar open: it is the only
        // drag region up here, and it holds the stage clear of the traffic
        // lights the sidebar would otherwise be under.
        sidebarVisible && <div data-tauri-drag-region className="h-[38px] w-full" />
      ) : (
        <div
          data-tauri-drag-region
          className="flex h-[38px] w-full min-w-0 items-center gap-2 px-4"
        >
          <ProviderGlyph
            provider={AGENT_PROVIDER[active?.agent ?? ""] ?? active?.agent ?? "claude"}
            size={14}
            color={active?.agent ? AGENT_ACCENT[active.agent] : undefined}
          />
          <span className="max-w-[45%] shrink-0 truncate text-[13px] font-medium text-[var(--ink)]">
            {active?.title ?? "No conversation"}
          </span>
          {project && (
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--faint)]">
              {project.name} @ {snapshot?.machineName ?? ""}
              {agentLabel !== "" &&
                ` · ${agentLabel}${active?.kind === "cli" ? " CLI" : ""}`}
            </span>
          )}
          {active?.busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
          {/* Stops short of the panel button so the title can't run under it. */}
          <div data-tauri-drag-region className="h-full flex-1" />
          <div className="w-7 shrink-0" />
        </div>
      )}
      {/* Pinned to the stage's top-right corner rather than placed in a row:
        it has to be reachable in all four combinations of launch screen and
        hidden sidebar, and those rows are not all the same row. */}
      <div className="absolute top-[7px] right-3 z-20">
        <PanelButton />
      </div>
    </div>
  );
}

/** The way into the workspace panel: the project's files, or a shell in it.
 * A plain toggle — what the panel should hold is a question the panel itself
 * asks, with two buttons, the first time it opens. */
function PanelButton() {
  const panelOpen = useEgant((s) => s.panelOpen);
  const togglePanel = useEgant((s) => s.togglePanel);

  return (
    <button
      type="button"
      title={panelOpen ? "Hide files and terminals · ⌘J" : "Files and terminals · ⌘J"}
      onClick={() => togglePanel()}
      className={`cursor-pointer rounded-md p-1.5 hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
        panelOpen ? "text-[var(--ink)]" : "text-[var(--muted)]"
      }`}
    >
      {panelOpen ? (
        <PanelRightClose size={15} strokeWidth={2} />
      ) : (
        <PanelRight size={15} strokeWidth={2} />
      )}
    </button>
  );
}
