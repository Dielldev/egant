import { AlertTriangle, Folder, RotateCw, Search, ShieldOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SHORT_NAMES, fallbackName, variantLabel } from "@egant/lib/agents";
import { MODE_INFO, NUMBERED_MODES } from "@egant/lib/modes";
import { modeLabel, prettyClaudeModelId } from "@egant/lib/transcript";
import { formatContext } from "@egant/lib/types";
import type { AgentModel } from "@egant/lib/types";
import type { MobileSession } from "../api";
import { usePrefs } from "../prefs";
import { CHAT_AGENTS, pickAgent, pickProject, useMobile } from "../store";
import { AgentGlyph } from "./bits";
import { Choice, Group, Sheet } from "./Sheet";

/** What a model reads as: its catalog name when the catalog knows it, else
 * a readable form of its id — or "Default" for the CLI's own pick. A live
 * Claude session reports a fully resolved id the catalog's aliases never
 * match, so the id it asked for is tried as well. */
export function modelName(
  agent: string,
  catalog: AgentModel[] | undefined,
  requested: string | null,
  live?: string | null,
): string {
  const byId = (id: string | null | undefined) => (id ? catalog?.find((m) => m.id === id) : undefined);
  const known = byId(live) ?? byId(requested);
  if (known) return known.name;
  const id = live || requested;
  if (!id) return catalog?.find((m) => m.cliDefault)?.name ?? "Default";
  return agent === "claude" ? prettyClaudeModelId(id) : id;
}

/** The agent, model and effort — of the next chat, or of an open one. A new
 * chat can take any agent the Mac has; an open one keeps its agent, and a
 * switch restarts it on the new model, picking the conversation back up. */
export function ModelSheet({
  open,
  onClose,
  session,
}: {
  open: boolean;
  onClose: () => void;
  session?: MobileSession;
}) {
  const prefAgent = usePrefs((s) => s.agent);
  const prefModels = usePrefs((s) => s.models);
  const prefVariants = usePrefs((s) => s.variants);
  const setPrefs = usePrefs((s) => s.set);
  const defaultAgent = useMobile((s) => s.defaultAgent);
  const agents = useMobile((s) => s.agents);
  const catalogs = useMobile((s) => s.models);
  const errors = useMobile((s) => s.modelErrors);
  const loadModels = useMobile((s) => s.loadModels);
  const loadAgents = useMobile((s) => s.loadAgents);
  const setSessionModel = useMobile((s) => s.setSessionModel);
  const [applying, setApplying] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const agent = session ? session.agent : pickAgent(prefAgent, defaultAgent);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    void loadModels(agent);
    if (!session) void loadAgents();
  }, [open, agent, session, loadModels, loadAgents]);

  const catalog = catalogs[agent];
  const current = session ? (session.requestedModel ?? "") : (prefModels[agent] ?? "");
  const currentVariant = session ? (session.variant ?? "") : (prefVariants[agent] ?? "");
  const selected =
    catalog?.find((m) => m.id === current) ??
    (current === "" ? catalog?.find((m) => m.cliDefault) : undefined);
  const variants = selected?.variants ?? [];
  const locked = session != null && (session.busy || applying != null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!catalog || !q) return catalog ?? [];
    return catalog.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.providerName.toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const pickModel = async (id: string) => {
    const model = catalog?.find((m) => m.id === id);
    const keep = currentVariant && model?.variants.includes(currentVariant) ? currentVariant : "";
    if (!session) {
      setPrefs({
        models: { ...prefModels, [agent]: id },
        variants: { ...prefVariants, [agent]: keep },
      });
      onClose();
      return;
    }
    if (locked || id === current) {
      if (id === current) onClose();
      return;
    }
    setApplying(id);
    const ok = await setSessionModel(session.id, id || null, keep || null);
    setApplying(null);
    if (ok) onClose();
  };

  const pickVariant = async (variant: string) => {
    if (!session) {
      setPrefs({ variants: { ...prefVariants, [agent]: variant } });
      return;
    }
    if (locked || variant === currentVariant) return;
    setApplying(`effort:${variant}`);
    await setSessionModel(session.id, current || null, variant || null);
    setApplying(null);
  };

  const status = agents?.find((a) => a.id === agent);

  return (
    <Sheet open={open} onClose={onClose} title={session ? "Model" : "New chat"} tall={(catalog?.length ?? 0) > 6}>
      {session ? (
        <div className="mx-1 mb-4 flex items-start gap-3 rounded-[18px] bg-[var(--raised-2)]/60 p-3.5">
          <span className="mt-0.5">
            <AgentGlyph agent={session.agent} size={18} />
          </span>
          <div className="min-w-0 flex-1 text-[13px] leading-[18px] text-[var(--muted)]">
            <div className="text-[15px] font-medium text-[var(--ink)]">{fallbackName(session.agent)}</div>
            {session.busy
              ? "Wait for this turn to finish to switch models."
              : "Switching restarts the agent on the new model and picks the conversation back up."}
          </div>
        </div>
      ) : (
        <div className="mb-4 px-1">
          <div className="grid grid-cols-3 gap-1 rounded-[16px] bg-[var(--raised-2)]/70 p-1">
            {CHAT_AGENTS.map((id) => {
              const info = agents?.find((a) => a.id === id);
              const missing = info != null && !info.installed;
              const active = id === agent;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={missing}
                  onClick={() => setPrefs({ agent: id })}
                  className={`press flex h-11 items-center justify-center gap-2 rounded-[12px] text-[14px] font-medium transition-colors disabled:opacity-35 ${
                    active
                      ? "bg-[var(--stage)] text-[var(--ink)] shadow-[0_1px_4px_rgba(0,0,0,0.2)]"
                      : "text-[var(--muted)]"
                  }`}
                >
                  <AgentGlyph agent={id} size={15} />
                  {SHORT_NAMES[id] ?? fallbackName(id)}
                </button>
              );
            })}
          </div>
          {status && status.installed && !status.connected && (
            <div className="mt-2 flex items-center gap-1.5 px-2 text-[12.5px] text-amber-600 dark:text-amber-300">
              <AlertTriangle size={13} strokeWidth={2} />
              {fallbackName(agent)} isn't signed in on your Mac.
            </div>
          )}
        </div>
      )}

      {variants.length > 0 && (
        <div className="mb-4">
          <div className="px-4 pb-1.5 text-[13px] font-medium text-[var(--muted)]">Effort</div>
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {["", ...variants].map((variant) => {
              const active = variant === currentVariant;
              const label =
                variant === ""
                  ? selected?.defaultVariant
                    ? `Default (${variantLabel(selected.defaultVariant)})`
                    : "Default"
                  : variantLabel(variant);
              return (
                <button
                  key={variant || "default"}
                  type="button"
                  disabled={locked && applying !== `effort:${variant}`}
                  onClick={() => void pickVariant(variant)}
                  className={`press h-9 shrink-0 rounded-full px-4 text-[14px] font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-[var(--ink)] text-[var(--stage)]"
                      : "bg-[var(--raised-2)] text-[var(--ink)]"
                  } ${applying === `effort:${variant}` ? "animate-pulse" : ""}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {catalog && catalog.length > 12 && (
        <label className="mx-1 mb-3 flex h-11 items-center gap-2 rounded-[14px] bg-[var(--raised-2)]/70 px-3">
          <Search size={16} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${catalog.length} models`}
            className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
          />
        </label>
      )}

      {catalog ? (
        <Group>
          {query.trim() === "" && (
            <Choice
              label="Default"
              detail={
                catalog.find((m) => m.cliDefault)
                  ? `${catalog.find((m) => m.cliDefault)?.name} — the CLI's own pick`
                  : `Whatever ${fallbackName(agent)} picks`
              }
              selected={current === ""}
              disabled={locked && applying !== ""}
              trailing={applying === "" ? <Spinner /> : undefined}
              onClick={() => void pickModel("")}
            />
          )}
          {filtered.map((model) => (
            <Choice
              key={model.id}
              label={model.name}
              detail={
                (agent === "opencode" || agent === "antigravity") && model.providerName
                  ? `${model.providerName}${model.description && model.description !== model.providerName ? ` · ${model.description}` : ""}`
                  : model.description || undefined
              }
              selected={model.id === current}
              disabled={locked && applying !== model.id}
              trailing={
                applying === model.id ? (
                  <Spinner />
                ) : formatContext(model.maxContext || model.context) ? (
                  <span className="shrink-0 rounded-md bg-[var(--raised-2)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--muted)]">
                    {formatContext(model.maxContext || model.context)}
                  </span>
                ) : undefined
              }
              onClick={() => void pickModel(model.id)}
            />
          ))}
          {filtered.length === 0 && query.trim() !== "" && (
            <div className="px-4 py-6 text-center text-[14px] text-[var(--muted)]">No models match.</div>
          )}
        </Group>
      ) : errors[agent] ? (
        <div className="flex flex-col items-center gap-3 px-6 py-8 text-center text-[14px] text-[var(--muted)]">
          <span>Couldn't load {fallbackName(agent)}'s models: {errors[agent]}</span>
          <button
            type="button"
            onClick={() => void loadModels(agent, true)}
            className="press flex h-9 items-center gap-2 rounded-full bg-[var(--raised-2)] px-4 text-[14px] text-[var(--ink)]"
          >
            <RotateCw size={14} strokeWidth={2} /> Try again
          </button>
        </div>
      ) : (
        <Group>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-col gap-2 border-b border-[var(--hairline)] px-4 py-3.5 last:border-b-0">
              <div className="h-3.5 w-32 animate-pulse rounded-full bg-[var(--raised-2)]" />
              <div className="h-3 w-52 animate-pulse rounded-full bg-[var(--raised-2)]/70" />
            </div>
          ))}
        </Group>
      )}
    </Sheet>
  );
}

function Spinner() {
  return (
    <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[var(--faint)] border-t-[var(--ink)]" />
  );
}

/** How much the agent may do without asking. Bypass sits apart from the
 * rest, the way the desktop's menu keeps it behind a divider. */
export function ModeSheet({
  open,
  onClose,
  agent,
  mode,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  agent: string;
  mode: string;
  onPick: (mode: string) => void;
}) {
  const info = MODE_INFO[agent];
  const pick = (next: string) => {
    onPick(next);
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Permissions">
      <Group>
        {NUMBERED_MODES.map((m) => (
          <Choice
            key={m}
            label={modeLabel(m)}
            detail={info?.[m]}
            selected={mode === m}
            onClick={() => pick(m)}
          />
        ))}
      </Group>
      <Group note="Runs every command and edit without asking. Only for work you'd let it do unattended.">
        <Choice
          leading={<ShieldOff size={18} strokeWidth={2} className="text-[var(--danger)]" />}
          label="Bypass permissions"
          danger
          selected={mode === "bypassPermissions"}
          onClick={() => pick("bypassPermissions")}
        />
      </Group>
    </Sheet>
  );
}

/** Where a new chat runs: one of the projects open on the Mac. */
export function ProjectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = useMobile((s) => s.projects);
  const sessions = useMobile((s) => s.sessions);
  const refreshProjects = useMobile((s) => s.refreshProjects);
  const preferred = usePrefs((s) => s.project);
  const setPrefs = usePrefs((s) => s.set);

  // A folder opened on the Mac since the phone last looked.
  useEffect(() => {
    if (open) void refreshProjects();
  }, [open, refreshProjects]);

  const recent = pickProject(null, projects, sessions);
  const counts = new Map<number, number>();
  for (const session of sessions) counts.set(session.projectId, (counts.get(session.projectId) ?? 0) + 1);
  const pick = (project: number | null) => {
    setPrefs({ project });
    onClose();
  };
  const current = preferred != null && projects.some((p) => p.id === preferred) ? preferred : null;

  return (
    <Sheet open={open} onClose={onClose} title="Project">
      {projects.length === 0 ? (
        <div className="px-6 py-10 text-center text-[14px] leading-relaxed text-[var(--muted)]">
          No projects are open in egant on your Mac. Open a folder there and it shows up here.
        </div>
      ) : (
        <>
          <Group>
            <Choice
              label="Most recent"
              detail={recent ? `Right now: ${recent.name}` : undefined}
              selected={current == null}
              onClick={() => pick(null)}
            />
          </Group>
          <Group label="On your Mac">
            {projects.map((project) => (
              <Choice
                key={project.id}
                leading={<ProjectIcon />}
                label={project.name}
                detail={chatsLabel(counts.get(project.id) ?? 0)}
                selected={current === project.id}
                onClick={() => pick(project.id)}
              />
            ))}
          </Group>
        </>
      )}
    </Sheet>
  );
}

function chatsLabel(n: number): string {
  if (n === 0) return "No chats yet";
  return n === 1 ? "1 chat" : `${n} chats`;
}

/** A project is a folder on the Mac; this is its mark wherever the phone
 * names one. */
export function ProjectIcon({ size = 18 }: { size?: number }) {
  return <Folder size={size} strokeWidth={1.9} className="shrink-0" />;
}
