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
  const sidebarVisible = snapshot?.sidebarVisible ?? true;

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
              {active?.agent && ` · ${agentName(agents, active.agent)}`}
            </span>
          )}
          {active?.busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
          <div data-tauri-drag-region className="h-full flex-1" />
        </div>
      )}
    </div>
  );
}
