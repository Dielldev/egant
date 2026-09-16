import { Check, ChevronDown, Search, Star, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../lib/api";
import { shouldOpenUpward } from "../lib/popover";
import type { AgentModel } from "../lib/types";
import {
  selectNextAgent,
  selectNextModel,
  selectNextVariant,
  starKey,
  useEgant,
} from "../store";
import { ProviderGlyph, ProviderLogo } from "./ProviderLogo";

/** Which agent (and model) the next session starts with. Sits in the launch
 * composer; existing sessions keep the agent they started with.
 *
 * Layout mirrors the reference: a provider tab strip (★ + agents) with a
 * sliding underline, a search field, a scrollable model list with logos /
 * descriptions / ⌘-hints / star toggles, and a fixed Reasoning footer for
 * models that advertise variants. The menu is a fixed height so showing
 * reasoning never pushes the list up — the list just scrolls. The whole menu
 * is one opaque pane (`isolate` + high z) so the launch-screen labels can
 * never bleed through it. */

const RUNNABLE = ["claude", "codex", "opencode"] as const;

export const AGENT_PROVIDER: Record<string, string> = {
  claude: "claude",
  codex: "openai",
  opencode: "opencode",
};

export const AGENT_ACCENT: Record<string, string> = {
  claude: "#e8835a",
  codex: "#b9b9c4",
  opencode: "#8e7cf6",
};

const VARIANT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  "x-high": "X-High",
  x_high: "X-High",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

export function variantLabel(id: string): string {
  if (!id) return "";
  return (
    VARIANT_LABELS[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1)
  );
}

export function agentName(
  agents: { id: string; name: string }[],
  id: string | null | undefined,
): string {
  if (!id) return "Claude Code";
  return agents.find((a) => a.id === id)?.name ?? fallbackName(id);
}

export function fallbackName(id: string): string {
  switch (id) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    default:
      return id;
  }
}

export function AgentPicker() {
  const agents = useEgant((s) => s.agents);
  const snapshot = useEgant((s) => s.snapshot);
  const composerAgent = useEgant((s) => s.composerAgent);
  const composerModel = useEgant((s) => s.composerModel);
  const composerVariant = useEgant((s) => s.composerVariant);
  const setComposerAgent = useEgant((s) => s.setComposerAgent);
  const setComposerModel = useEgant((s) => s.setComposerModel);
  const setComposerVariant = useEgant((s) => s.setComposerVariant);
  const refresh = useEgant((s) => s.refresh);
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const verifyAgents = useEgant((s) => s.verifyAgents);
  const models = useEgant((s) => s.models);
  const modelsAgent = useEgant((s) => s.modelsAgent);
  const modelsLoading = useEgant((s) => s.modelsLoading);
  const fetchModels = useEgant((s) => s.fetchModels);
  const enabledAgents = useEgant((s) => s.enabledAgents);
  const defaultModels = useEgant((s) => s.defaultModels);
  const defaultVariants = useEgant((s) => s.defaultVariants);
  const starredModels = useEgant((s) => s.starredModels);
  const toggleStarred = useEgant((s) => s.toggleStarred);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  // Bumped on every tab switch so the list replays its stagger animation.
  const [listToken, setListToken] = useState(0);
  // Model id that just got picked — replays the select pulse.
  const [justPicked, setJustPicked] = useState<string | null>(null);
  // The composer sits at the bottom of the window on the launch screen, so
  // the menu's usual `top-full` would render mostly (or entirely) below the
  // visible window. Measured on open, not tracked live — see `shouldOpenUpward`.
  const [openUpward, setOpenUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const effective = selectNextAgent(snapshot, composerAgent);
  const visibleAgents: string[] = useMemo(() => {
    const enabled = RUNNABLE.filter((id) => enabledAgents[id] ?? true);
    const list: string[] = enabled.length > 0 ? [...enabled] : [...RUNNABLE];
    // The effective agent always keeps its tab — otherwise disabling the
    // current agent would leave the strip with no active tab.
    if (!list.includes(effective)) list.unshift(effective);
    return list;
  }, [enabledAgents, effective]);

  // The tab the list shows. Favorites is a filter view; agent tabs switch
  // the effective agent outright.
  const activeTab = favOnly ? "favorites" : effective;

  const current = agents.find((a) => a.id === effective);
  const badModelIds = snapshot?.badModels?.[effective] ?? [];
  const defaultAgent = snapshot?.settings.defaultAgent ?? "claude";
  const effectiveModelId = selectNextModel(composerModel, defaultModels, effective);
  const effectiveVariant = selectNextVariant(
    composerVariant,
    defaultVariants,
    effective,
  );
  // Prefetch the catalog so the composer badge renders even
  // before the menu opens. Curated lists are instant; opencode is CLI-cached.
  useEffect(() => {
    if (modelsAgent !== effective && !modelsLoading) void fetchModels(effective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective]);

  const toggleMenu = () => {
    if (!open) {
      setQuery("");
      setFavOnly(false);
      // A live recheck, not the cached presence list: this menu is exactly
      // where a stale "connected" dot (credentials file present, token
      // actually expired) would send someone into a session that fails.
      void verifyAgents();
      void fetchModels(effective);
      setOpenUpward(shouldOpenUpward(rootRef, Math.min(440, window.innerHeight * 0.5)));
    }
    setOpen((o) => !o);
  };

  const switchAgent = (id: string) => {
    setFavOnly(false);
    setListToken((t) => t + 1);
    if (id !== effective) {
      setComposerAgent(id === defaultAgent ? null : id);
      setComposerModel("");
      setComposerVariant("");
      void fetchModels(id);
    }
  };

  const showFavorites = () => {
    setFavOnly(true);
    setListToken((t) => t + 1);
    void fetchModels(effective);
  };

  const pickModel = (model: AgentModel | null) => {
    const id = model?.id ?? "";
    setComposerModel(id);
    if (!model || !model.variants.includes(composerVariant)) {
      setComposerVariant("");
    }
    if (model) {
      setJustPicked(model.id);
      window.setTimeout(() => setJustPicked((p) => (p === model.id ? null : p)), 450);
    }
    if (!model || model.variants.length === 0) setOpen(false);
  };

  const pickVariant = (variant: string) => {
    // Tapping the settings default clears the override so the picker keeps
    // following Settings > Agents.
    const def = (defaultVariants[effective] ?? "").trim();
    if (variant === def && composerVariant !== "") {
      setComposerVariant("");
    } else {
      setComposerVariant(variant);
    }
    setOpen(false);
  };

  const rememberDefault = async () => {
    try {
      await api.setDefaultAgent(effective);
      setComposerAgent(null);
      await refresh();
      await fetchAgents();
    } catch {
      // The error toast carries it; the menu just closes.
    }
    setOpen(false);
  };

  const fresh = modelsAgent === effective;
  const needle = query.trim().toLowerCase();

  const baseList = useMemo(() => {
    if (!fresh) return [];
    if (!favOnly) return models;
    return models.filter((m) => starredModels[starKey(effective, m.id)]);
  }, [fresh, favOnly, models, starredModels, effective]);

  const visible = useMemo(() => {
    if (needle === "") return baseList;
    return baseList.filter((m) =>
      `${m.name} ${m.id} ${m.providerName} ${m.description}`
        .toLowerCase()
        .includes(needle),
    );
  }, [baseList, needle]);

  const exactMatch = visible.some((m) => m.id.toLowerCase() === needle);
  const selectedModel = models.find((m) => m.id === effectiveModelId) ?? null;
  // When the effective model isn't in the fresh catalog (custom id or the
  // settings default), still show its reasoning if we know variants for it.
  const reasoningVariants = selectedModel?.variants ?? [];

  const onMenuKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
      const index = Number(e.key) - 1;
      if (index < visible.length) {
        e.preventDefault();
        pickModel(visible[index]);
      }
    }
  };

  const status = current;
  const installed = status?.installed ?? true;

  // Model + reasoning only — no context in this picker.
  const variantBadge = effectiveVariant ? variantLabel(effectiveVariant) : "";
  const pickedTitle =
    effectiveModelId === ""
      ? `${current?.name ?? fallbackName(effective)} — CLI default. Click to change.`
      : `${selectedModel?.name ?? effectiveModelId}${variantBadge ? ` · ${variantBadge}` : ""} — click to change.`;

  return (
    <div ref={rootRef} className="relative isolate shrink-0">
      <button
        type="button"
        title={pickedTitle}
        onClick={toggleMenu}
        className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-[var(--muted)] hover:bg-[rgba(255,255,255,0.08)] hover:text-[var(--ink)]"
      >
        {effectiveModelId === "" ? (
          <span
            key={`${effective}:default`}
            className="model-switch inline-flex items-center gap-1.5"
          >
            <ProviderGlyph
              provider={AGENT_PROVIDER[effective] ?? effective}
              size={14}
              color={AGENT_ACCENT[effective]}
            />
            <span className="font-medium whitespace-nowrap text-[var(--ink)]">
              {current?.name ?? fallbackName(effective)}
            </span>
          </span>
        ) : (
          <span
            key={`${effective}:${effectiveModelId}:${effectiveVariant}`}
            className="model-switch inline-flex min-w-0 items-center gap-2"
          >
            <ProviderGlyph
              provider={AGENT_PROVIDER[effective] ?? effective}
              size={18}
              color={AGENT_ACCENT[effective]}
            />
            <span className="truncate text-[14px] font-semibold whitespace-nowrap text-[var(--ink)]">
              {selectedModel?.name ?? effectiveModelId}
            </span>
            {variantBadge && (
              <span className="truncate text-[13px] font-normal whitespace-nowrap text-[var(--muted)]">
                {variantBadge}
              </span>
            )}
          </span>
        )}
        {effectiveModelId === "" && current?.connected && (
          <span
            className="h-1.5 w-1.5 rounded-full bg-emerald-400"
            title="Logged in"
          />
        )}
        <ChevronDown size={12} strokeWidth={2} />
      </button>

      {open && (
        <div
          onKeyDown={onMenuKeyDown}
          style={{ transformOrigin: openUpward ? "bottom left" : "top left" }}
          className={`menu absolute left-0 z-[80] flex h-[min(440px,50vh)] w-[340px] flex-col overflow-hidden rounded-2xl p-2 ${
            openUpward ? "menu-pop-up bottom-full mb-2" : "menu-pop top-full mt-2"
          }`}
        >
          {/* Provider tab strip — ★ + agents, sliding underline. */}
          <div className="flex shrink-0 items-center gap-0.5 border-b border-[var(--border)] px-1 pb-0">
            <TabButton
              active={activeTab === "favorites"}
              title="Starred models"
              onClick={showFavorites}
            >
              <Star
                size={15}
                strokeWidth={2}
                className={
                  activeTab === "favorites"
                    ? "fill-amber-300 text-amber-300"
                    : "text-[var(--faint)]"
                }
              />
            </TabButton>
            {visibleAgents.map((id) => {
              const s = agents.find((a) => a.id === id);
              const ok = s?.installed ?? true;
              return (
                <TabButton
                  key={id}
                  active={activeTab === id}
                  title={
                    s
                      ? `${s.name} — ${ok ? (s.connected ? (s.email ?? "Logged in") : "Not logged in") : (s.installHint ?? "Not installed")}`
                      : fallbackName(id)
                  }
                  dim={!ok}
                  onClick={() => switchAgent(id)}
                >
                  <span className="relative flex items-center">
                    <ProviderGlyph
                      provider={AGENT_PROVIDER[id] ?? id}
                      size={16}
                      color={AGENT_ACCENT[id]}
                    />
                    {s?.connected && (
                      <span className="absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full border border-[#141418] bg-emerald-400" />
                    )}
                  </span>
                </TabButton>
              );
            })}
            <div className="ml-auto flex items-center gap-1.5 pr-1 pb-1.5 text-[11px] text-[var(--faint)]">
              <span className="max-w-[140px] truncate">
                {favOnly
                  ? "Starred"
                  : (current?.name ?? fallbackName(effective))}
              </span>
              {!installed && (
                <span className="text-amber-400/90">not installed</span>
              )}
            </div>
          </div>

          {/* Search */}
          <div className="shrink-0 pt-2">
            <div className="flex items-center gap-2 rounded-lg bg-[rgba(255,255,255,0.05)] px-2.5 py-2">
              <Search
                size={13}
                strokeWidth={2}
                className="shrink-0 text-[var(--faint)]"
              />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
              />
              {query !== "" && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="shrink-0 cursor-pointer text-[11px] text-[var(--faint)] hover:text-[var(--ink)]"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Model list — the only scrolling region. Fixed flex-1 so long
            catalogs scroll here without moving the menu. */}
          <div
            key={`${activeTab}:${listToken}`}
            className="mt-1 min-h-0 flex-1 overflow-y-auto"
          >
            {modelsLoading || !fresh ? (
              <div className="px-2.5 py-3 text-[12px] text-[var(--faint)]">
                Loading models…
              </div>
            ) : !installed ? (
              <div className="px-2.5 py-3 text-[12px] leading-relaxed text-[var(--muted)]">
                {status?.installHint ?? "This agent isn't installed."}
              </div>
            ) : (
              <>
                {!favOnly && (
                  <ModelRow
                    index={-1}
                    name="Default"
                    description="The CLI default"
                    checked={effectiveModelId === ""}
                    picked={false}
                    onClick={() => pickModel(null)}
                  />
                )}
                {visible.map((model, index) => {
                  const starred = !!starredModels[starKey(effective, model.id)];
                  const checked = effectiveModelId === model.id;
                  const bad = badModelIds.includes(model.id);
                  return (
                    <ModelRow
                      key={model.id}
                      index={index}
                      name={model.name}
                      description={model.description || model.providerName}
                      logo={
                        <ProviderLogo provider={model.provider} size={28} />
                      }
                      hint={index < 9 ? `⌘${index + 1}` : undefined}
                      checked={checked}
                      picked={justPicked === model.id}
                      starred={starred}
                      bad={bad}
                      onToggleStar={() => toggleStarred(effective, model.id)}
                      onClick={() => pickModel(model)}
                    />
                  );
                })}
                {needle !== "" && !exactMatch && !favOnly && (
                  <button
                    type="button"
                    onClick={() => {
                      setComposerModel(query.trim());
                      setComposerVariant("");
                      setOpen(false);
                    }}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--hover)]"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]">
                      Use{" "}
                      <span className="font-mono text-[var(--ink)]">
                        {query.trim()}
                      </span>
                    </span>
                  </button>
                )}
                {visible.length === 0 && (
                  <div className="px-2.5 py-3 text-[12px] text-[var(--faint)]">
                    {favOnly
                      ? "No starred models yet — hover a model and tap ★."
                      : needle !== ""
                        ? "No models match."
                        : "No models found."}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Reasoning — fixed footer. The model list above is flex-1 and
            scrolls, so showing this never moves the menu's top edge. */}
          {selectedModel !== null && reasoningVariants.length > 0 && (
            <div className="shrink-0">
              <div className="mx-1 my-1.5 border-t border-[var(--border)]" />
              <div className="max-h-[160px] overflow-y-auto">
                <div className="px-2.5 pt-1 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)]">
                  REASONING
                </div>
                {reasoningVariants.map((variant) => {
                  const isDefault =
                    (defaultVariants[effective] ?? "").trim() === variant;
                  const isChecked = effectiveVariant === variant;
                  return (
                    <button
                      key={variant}
                      type="button"
                      onClick={() => pickVariant(variant)}
                      className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left transition-colors duration-150 ${
                        isChecked
                          ? "bg-[var(--selected)]"
                          : "hover:bg-[var(--hover)]"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">
                        {variantLabel(variant)}
                      </span>
                      {isDefault && (
                        <span className="shrink-0 rounded bg-[var(--selected)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                          Default
                        </span>
                      )}
                      {isChecked && (
                        <Check
                          size={14}
                          strokeWidth={2}
                          className="check-pop shrink-0 text-[var(--ink)]"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {effective !== defaultAgent && !favOnly && (
            <>
              <div className="mx-1 my-1.5 shrink-0 border-t border-[var(--border)]" />
              <button
                type="button"
                onClick={() => void rememberDefault()}
                className="w-full shrink-0 cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-xs text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
              >
                Use {current?.name ?? effective} by default
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  title,
  dim,
  onClick,
  children,
}: {
  active: boolean;
  title?: string;
  dim?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`relative flex cursor-pointer items-center justify-center rounded-t-md px-3 pt-1.5 pb-2 transition-colors duration-150 ${
        dim ? "opacity-45" : ""
      } ${active ? "text-[var(--ink)]" : "text-[var(--faint)] hover:text-[var(--muted)]"}`}
    >
      {children}
      <span
        className={`absolute right-2 bottom-0 left-2 h-[2px] rounded-full transition-all duration-200 ${
          active ? "bg-[#8e7cf6] opacity-100" : "bg-transparent opacity-0"
        }`}
      />
    </button>
  );
}

function ModelRow({
  index,
  name,
  description,
  logo,
  hint,
  checked,
  picked,
  starred,
  bad,
  onToggleStar,
  onClick,
}: {
  index: number;
  name: string;
  description?: string;
  logo?: React.ReactNode;
  hint?: string;
  checked: boolean;
  picked?: boolean;
  starred?: boolean;
  /** Failed with a model/catalog-shaped error earlier this session — still
   * pickable (the failure could be transient, or fixed by then), just
   * flagged so the same wall isn't hit twice without warning. */
  bad?: boolean;
  onToggleStar?: () => void;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={bad ? "Failed earlier this session — may still be worth retrying" : undefined}
      style={index >= 0 ? { animationDelay: `${Math.min(index, 8) * 22}ms` } : undefined}
      className={`row-in group flex w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${
        checked ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
      } ${picked ? "row-picked" : ""} ${bad ? "opacity-60" : ""}`}
    >
      <span className="shrink-0">{logo}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="shrink-0 truncate text-[13px] font-medium text-[var(--ink)]">
          {name}
        </span>
        {bad && (
          <TriangleAlert
            size={11}
            strokeWidth={2}
            className="shrink-0 text-amber-400/90"
          />
        )}
        {description && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--faint)]">
            {bad ? "Failed earlier this session" : description}
          </span>
        )}
      </span>
      {hint && (
        <span className="shrink-0 rounded bg-[var(--selected)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--faint)]">
          {hint}
        </span>
      )}
      {onToggleStar && (
        <button
          type="button"
          title={starred ? "Unstar" : "Star"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
          className={`shrink-0 cursor-pointer rounded p-0.5 transition-opacity duration-150 ${
            starred
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <Star
            size={13}
            strokeWidth={2}
            className={
              starred
                ? "fill-amber-300 text-amber-300"
                : "text-[var(--faint)] hover:text-amber-300"
            }
          />
        </button>
      )}
      {checked && (
        <Check
          size={14}
          strokeWidth={2}
          className="check-pop shrink-0 text-[var(--ink)]"
        />
      )}
    </div>
  );
}
