import { PanelRight, PanelRightClose } from "lucide-react";
import { modShortcut } from "../lib/platform";
import { selectOnLaunchScreen, useEgant } from "../store";
import { log } from "../lib/logger";
import { AGENT_ACCENT, AGENT_PROVIDER, agentName } from "./AgentPicker";
import { EditableTitle } from "./EditableTitle";
import { ProviderGlyph } from "./ProviderLogo";
import { WindowBar } from "./WindowBar";
import { WorktreeChip } from "./Worktree";

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
  const selected = snapshot?.projects.find((p) => p.id === snapshot?.activeProject);
  // Single source of truth: the header names the conversation in front of you,
  // falling back to the selected project when there is no conversation yet
  // (fresh folder like `meme-cam`, or a file open beside the launch screen).
  // After the backend invariant (activeSession always belongs to
  // activeProject, or activeSession is None) these two agree whenever both
  // exist — if they ever diverge again, the session wins here because the
  // transcript on screen is what the name must describe.
  const project =
    snapshot?.projects.find((p) => p.id === active?.projectId) ?? selected ?? null;
  if (
    active &&
    snapshot?.activeProject != null &&
    active.projectId !== snapshot.activeProject
  ) {
    log.error(
      "store",
      `project/session mismatch: sidebar on project ${snapshot.activeProject} but active session ${active.id} belongs to ${active.projectId}`,
    );
  }
  const agents = useEgant((s) => s.agents);
  const catalog = useEgant((s) => s.catalog);
  const renameSession = useEgant((s) => s.renameSession);
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
        sidebarVisible && (
          <div data-tauri-drag-region className="h-[38px] w-full" />
        )
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
          {active ? (
            <EditableTitle
              title={active.title}
              hint="Double-click to rename"
              onRename={(title) => void renameSession(active.id, title)}
              className="max-w-[45%] shrink-0 cursor-default truncate text-[13px] font-medium text-[var(--ink)]"
              inputClassName="w-[45%] max-w-[420px] shrink-0 rounded-md border border-[var(--accent)]/60 bg-[rgba(0,0,0,0.2)] px-1.5 text-[13px] font-medium text-[var(--ink)] outline-none"
            />
          ) : (
            <span className="max-w-[45%] shrink-0 truncate text-[13px] font-medium text-[var(--ink)]">
              No conversation
            </span>
          )}
          {project && (
            <span
              data-tauri-drag-region
              className="min-w-0 flex-1 truncate text-xs text-[var(--faint)]"
            >
              {project.name} @ {active?.device ?? snapshot?.machineName ?? ""}
              {agentLabel !== "" &&
                ` · ${agentLabel}${active?.kind === "cli" ? " CLI" : ""}`}
            </span>
          )}
          {/* A session in a worktree is not in the folder its project names,
            and the header is the one line that says where it is. */}
          {active?.worktree && <WorktreeChip worktree={active.worktree} />}
          {active?.busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
          {/* Stops short of the panel button so the title can't run under it. */}
          <div data-tauri-drag-region className="h-full flex-1" />
          <div data-tauri-drag-region className="h-full w-7 shrink-0" />
        </div>
      )}
      {/* Pinned to the stage's top-right corner rather than placed in a row:
        it has to be reachable with the sidebar shown or hidden, and those
        rows are not the same row. Absent on the launch screen. */}
      <PanelButtonSlot />
    </div>
  );
}

/** Where `PanelButton` sits, or nothing at all on the launch screen: there is
 * no workspace to browse before a conversation exists, so the panel is not
 * offered there (and App.tsx hides it if it was open). */
function PanelButtonSlot() {
  const onLaunchScreen = useEgant(selectOnLaunchScreen);
  if (onLaunchScreen) return null;
  return (
    <div className="absolute top-[7px] right-3 z-20">
      <PanelButton />
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
      title={
        panelOpen
          ? `Hide files and terminals · ${modShortcut("J")}`
          : `Files and terminals · ${modShortcut("J")}`
      }
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
