import { Check, ChevronLeft, ChevronRight, CornerDownLeft, Search, Star, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { prettyClaudeModelId } from "../lib/transcript";
import { formatContext } from "../lib/types";
import type { AgentModel } from "../lib/types";
import { starKey, useEgant } from "../store";
import { AGENT_ACCENT, AGENT_PROVIDER, agentName, variantLabel } from "./AgentPicker";
import { ProviderGlyph, ProviderLogo } from "./ProviderLogo";

/** Same threshold as the launch picker: short catalogs open as a bare list. */
const SEARCH_THRESHOLD = 10;
const NO_MODELS: AgentModel[] = [];

type Row = { kind: "default"; key: string } | { kind: "model"; key: string; model: AgentModel };

/** The effort levels worth offering for `modelId` (`""` is the CLI default).
 * With the default picked there is no model to ask, so the model the CLI
 * would choose stands in, and failing that a ladder the whole catalog shares —
 * never a guess that could hand the CLI a level the model rejects. */
function effortLadder(catalog: AgentModel[], modelId: string): string[] {
  const picked = catalog.find((m) => m.id === modelId);
  if (picked) return picked.variants;
  if (modelId !== "" || catalog.length === 0) return [];
  const cliDefault = catalog.find((m) => m.cliDefault);
  if (cliDefault) return cliDefault.variants;
  const first = catalog[0].variants;
  const shared = catalog.every(
    (m) => m.variants.length === first.length && m.variants.every((v, i) => v === first[i]),
  );
  return shared ? first : [];
}

/** The model badge in a running session's composer — `Big Pickle  X-High` —
 * and the menu that switches it.
 *
 * The launch picker chooses what the *next* session starts with; this one
 * moves the session in front of you, so it has no agent tabs (the agent is
 * fixed once the conversation exists) and every pick takes effect on the
 * spot: the backend resumes the same conversation on the new model. It opens
 * upward, since it sits at the foot of the window. */
export function SessionModelPicker({
  sessionId,
  agent,
  compact,
}: {
  sessionId: number;
  agent: string;
  /** Drops the effort label when the composer is too tight to fit both. */
  compact?: boolean;
}) {
  const session = useEgant((s) => s.snapshot?.sessions.find((x) => x.id === sessionId));
  const transcript = useEgant((s) => s.transcripts[sessionId]);
  const agents = useEgant((s) => s.agents);
  const cached = useEgant((s) => s.modelCache[agent]);
  const warmModels = useEgant((s) => s.warmModels);
  const starredModels = useEgant((s) => s.starredModels);
  const badModels = useEgant((s) => s.snapshot?.badModels?.[agent]);
  const setSessionModel = useEgant((s) => s.setSessionModel);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"models" | "effort">("models");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [effortCursor, setEffortCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  /** A model picked on the list whose effort is being chosen next. Applied
   * once, with the effort — or with the one it would keep, if the menu
   * closes first — so a switch restarts the agent once, not twice. */
  const [pending, setPending] = useState<{ model: string; variant: string } | null>(null);
  const [pos, setPos] = useState({ bottom: 0, left: 0, width: 360, maxHeight: 440 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const effortRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const catalog = cached ?? NO_MODELS;
  const busy = transcript?.state === "running" || transcript?.state === "awaiting_permission";
  const currentModel = session?.modelOverride ?? "";
  const currentVariant = session?.variant ?? "";

  // The badge needs the catalog to turn an id into a name, whether or not
  // the menu is ever opened.
  useEffect(() => {
    if (cached == null) void warmModels(agent);
  }, [agent, cached, warmModels]);

  const apply = async (model: string, variant: string) => {
    if (model === currentModel && variant === currentVariant) return;
    setSwitching(true);
    try {
      await setSessionModel(sessionId, model, variant);
    } finally {
      setSwitching(false);
    }
  };

  const close = () => {
    if (pending) void apply(pending.model, pending.variant);
    setPending(null);
    setOpen(false);
  };
  // The outside-click and Escape listeners below outlive this render.
  const closeRef = useRef(close);
  closeRef.current = close;

  const place = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(360, window.innerWidth - 16);
    // Right-aligned to the badge, which sits at the composer's right end,
    // then clamped back onto the window when the composer is narrow.
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPos({
      bottom: window.innerHeight - rect.top + 8,
      left,
      width,
      maxHeight: Math.max(200, Math.min(440, rect.top - 16)),
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        closeRef.current();
      }
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    setQuery("");
    setView("models");
    setPending(null);
    place();
    // Refresh behind the list rather than in front of it: a cached catalog
    // opens instantly, an empty one says it's loading.
    if (cached == null) setLoading(true);
    void warmModels(agent).finally(() => setLoading(false));
    setOpen(true);
  };

  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const matches =
      needle === ""
        ? catalog
        : catalog.filter((m) =>
            `${m.name} ${m.id} ${m.providerName} ${m.description}`.toLowerCase().includes(needle),
          );
    const starred = matches.filter((m) => starredModels[starKey(agent, m.id)]);
    const rest = matches.filter((m) => !starredModels[starKey(agent, m.id)]);
    const out: Row[] = [];
    if (needle === "" || "default".startsWith(needle)) out.push({ kind: "default", key: "__default" });
    for (const m of [...starred, ...rest]) out.push({ kind: "model", key: m.id, model: m });
    return out;
  }, [catalog, needle, starredModels, agent]);

  // Opens on what's running; a filter jumps to the best match.
  useEffect(() => {
    if (!open) return;
    if (needle !== "") {
      setCursor(0);
      return;
    }
    const at = rows.findIndex((row) =>
      row.kind === "model" ? row.model.id === currentModel : currentModel === "",
    );
    setCursor(at >= 0 ? at : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, needle, rows.length]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // The effort screen edits the pending pick when there is one, otherwise
  // what's running.
  const effortModel = pending?.model ?? currentModel;
  const effortVariant = pending?.variant ?? currentVariant;
  const variants = useMemo(() => effortLadder(catalog, effortModel), [catalog, effortModel]);
  const effortModelRow =
    catalog.find((m) => m.id === effortModel) ??
    (effortModel === "" ? catalog.find((m) => m.cliDefault) : undefined);

  useEffect(() => {
    if (!open) return;
    if (view === "effort") {
      const shown = effortVariant || effortModelRow?.defaultVariant || "";
      const at = variants.indexOf(shown);
      setEffortCursor(at >= 0 ? at : 0);
      menuRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, open]);

  useEffect(() => {
    if (view === "effort") effortRefs.current[effortCursor]?.scrollIntoView({ block: "nearest" });
  }, [view, effortCursor]);

  const pickRow = (row: Row) => {
    const model = row.kind === "model" ? row.model.id : "";
    const ladder = effortLadder(catalog, model);
    // An effort the new model doesn't take would be passed as a flag the CLI
    // rejects, so it falls back to the model's own default.
    const variant = ladder.includes(currentVariant) ? currentVariant : "";
    if (ladder.length > 0) {
      setPending({ model, variant });
      setView("effort");
      return;
    }
    setPending(null);
    setOpen(false);
    void apply(model, variant);
  };

  const pickVariant = (variant: string) => {
    const model = pending?.model ?? currentModel;
    setPending(null);
    setOpen(false);
    void apply(model, variant);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (view === "effort") {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setEffortCursor((c) =>
          variants.length === 0 ? 0 : (c + step + variants.length) % variants.length,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const variant = variants[effortCursor];
        if (variant) pickVariant(variant);
      } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
        e.preventDefault();
        setPending(null);
        setView("models");
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (rows.length === 0 ? 0 : (c + step + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row) pickRow(row);
    } else if (e.key === "Escape" && query !== "") {
      // Clear the filter first; the window-level listener closes on the next.
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  // What the badge reads. A live Claude session reports its fully-resolved id
  // (`claude-opus-5-20260101[1m]`), which the catalog's short aliases never
  // match — so the requested id is tried too, then Claude's own id shape.
  const liveModel = transcript?.model ?? null;
  const shownModel =
    (liveModel && catalog.find((m) => m.id === liveModel)) ||
    (currentModel !== "" ? catalog.find((m) => m.id === currentModel) : undefined) ||
    (liveModel == null && currentModel === "" ? catalog.find((m) => m.cliDefault) : undefined);
  const agentDisplay = agentName(agents, agent);
  const modelName =
    shownModel?.name ??
    (liveModel ? (agent === "claude" ? prettyClaudeModelId(liveModel) : liveModel) : null) ??
    (currentModel || agentDisplay);
  const effortLabel = variantLabel(currentVariant || shownModel?.defaultVariant || "");
  const contextLabel = session?.context ? formatContext(session.context) : "";

  const searchShown = query !== "" || catalog.length > SEARCH_THRESHOLD;
  rowRefs.current.length = rows.length;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        disabled={busy || switching}
        aria-expanded={open}
        title={
          busy
            ? "Switch models once this turn finishes"
            : `${modelName}${effortLabel ? ` · ${effortLabel}` : ""}${contextLabel ? ` · ${contextLabel}` : ""} — click to switch`
        }
        onClick={toggle}
        className={`flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full px-2.5 py-1.5 transition-colors duration-150 disabled:cursor-default ${
          open ? "bg-[var(--hover)]" : "enabled:hover:bg-[var(--hover)]"
        } ${switching ? "opacity-60" : ""}`}
      >
        <span
          key={`${currentModel}:${currentVariant}`}
          className="model-switch flex min-w-0 items-center gap-2"
        >
          <ProviderGlyph
            provider={AGENT_PROVIDER[agent] ?? agent}
            size={16}
            color={AGENT_ACCENT[agent]}
          />
          <span className="truncate text-[14px] font-semibold whitespace-nowrap text-[var(--ink)]">
            {modelName}
          </span>
          {effortLabel && !compact && (
            <span className="shrink-0 text-[14px] font-medium whitespace-nowrap text-[var(--muted)]">
              {effortLabel}
            </span>
          )}
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onMouseUp={(e) => {
              if (view === "effort") menuRef.current?.focus();
              else if (e.target !== inputRef.current) inputRef.current?.focus();
            }}
            // Portaled with viewport coordinates: the composer's
            // `backdrop-filter` would otherwise clip an absolutely-positioned
            // menu to its own box.
            style={{
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              transformOrigin: "bottom right",
            }}
            className="menu menu-pop-up fixed z-[100] flex flex-col overflow-hidden rounded-2xl p-2 outline-none"
          >
            {view === "effort" ? (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setPending(null);
                    setView("models");
                  }}
                  className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--hover)]"
                >
                  <ChevronLeft size={14} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                  {effortModelRow ? (
                    <ProviderLogo provider={effortModelRow.provider} size={22} />
                  ) : (
                    <ProviderGlyph
                      provider={AGENT_PROVIDER[agent] ?? agent}
                      size={20}
                      color={AGENT_ACCENT[agent]}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">
                    {effortModelRow?.name ?? (effortModel || agentDisplay)}
                  </span>
                </button>
                <div className="mx-1 my-1.5 shrink-0 border-t border-[var(--border)]" />
                <div className="shrink-0 px-2 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)]">
                  REASONING
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {variants.map((variant, index) => {
                    const checked = (effortVariant || effortModelRow?.defaultVariant) === variant;
                    const highlighted = effortCursor === index;
                    return (
                      <button
                        key={variant}
                        ref={(el) => {
                          effortRefs.current[index] = el;
                        }}
                        type="button"
                        onClick={() => pickVariant(variant)}
                        onMouseMove={() => setEffortCursor(index)}
                        style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
                        className={`row-in flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[7px] text-left ${
                          highlighted ? "bg-[var(--hover)]" : ""
                        }`}
                      >
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] text-[var(--ink)] ${
                            checked ? "font-semibold" : ""
                          }`}
                        >
                          {variantLabel(variant)}
                        </span>
                        {effortModelRow?.defaultVariant === variant && (
                          <span className="shrink-0 rounded bg-[var(--bubble)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                            Default
                          </span>
                        )}
                        <span className="flex w-4 shrink-0 items-center justify-center">
                          {checked ? (
                            <Check size={14} strokeWidth={2} className="check-pop text-[var(--ink)]" />
                          ) : highlighted ? (
                            <CornerDownLeft size={12} strokeWidth={2} className="text-[var(--faint)]" />
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1.5 shrink-0 border-t border-[var(--border)] px-1.5 pt-1.5 text-[10px] text-[var(--faint)]">
                  ↑↓ browse · ⏎ select · ← back
                </div>
              </>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-2 px-2 pt-1 pb-1.5">
                  <ProviderGlyph
                    provider={AGENT_PROVIDER[agent] ?? agent}
                    size={14}
                    color={AGENT_ACCENT[agent]}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--faint)]">
                    Switch model · {agentDisplay}
                  </span>
                </div>
                <div className={searchShown ? "mb-1 shrink-0" : "h-0 shrink-0 overflow-hidden opacity-0"}>
                  <div className="flex items-center gap-2 rounded-lg bg-[var(--card)] px-2.5 py-1.5">
                    <Search size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                    <input
                      ref={inputRef}
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search models…"
                      spellCheck={false}
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
                    />
                  </div>
                </div>
                <div role="listbox" className="min-h-0 flex-1 overflow-y-auto">
                  {loading && catalog.length === 0 ? (
                    <div className="px-2.5 py-3 text-[12px] text-[var(--faint)]">Loading models…</div>
                  ) : rows.length === 0 ? (
                    <div className="px-2.5 py-3 text-[12px] text-[var(--faint)]">No models match.</div>
                  ) : (
                    rows.map((row, index) => {
                      const highlighted = cursor === index;
                      const checked =
                        row.kind === "model" ? row.model.id === currentModel : currentModel === "";
                      const bad = row.kind === "model" && (badModels ?? []).includes(row.model.id);
                      const starred =
                        row.kind === "model" && starredModels[starKey(agent, row.model.id)];
                      const cliDefault = catalog.find((m) => m.cliDefault);
                      return (
                        <div
                          key={row.key}
                          ref={(el) => {
                            rowRefs.current[index] = el;
                          }}
                          role="option"
                          aria-selected={checked}
                          onClick={() => pickRow(row)}
                          onMouseMove={() => setCursor(index)}
                          title={bad ? "Failed earlier this session — may still be worth retrying" : undefined}
                          style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
                          className={`row-in flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[7px] ${
                            highlighted ? "bg-[var(--hover)]" : ""
                          } ${bad ? "opacity-60" : ""}`}
                        >
                          <span className="flex w-6 shrink-0 items-center justify-center">
                            {row.kind === "model" ? (
                              <ProviderLogo provider={row.model.provider} size={22} />
                            ) : (
                              <ProviderGlyph
                                provider={AGENT_PROVIDER[agent] ?? agent}
                                size={18}
                                color={AGENT_ACCENT[agent]}
                              />
                            )}
                          </span>
                          <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                            <span
                              className={`shrink-0 truncate text-[13px] text-[var(--ink)] ${
                                checked ? "font-semibold" : "font-medium"
                              }`}
                            >
                              {row.kind === "model" ? row.model.name : "Default"}
                            </span>
                            {bad && (
                              <TriangleAlert size={11} strokeWidth={2} className="shrink-0 text-amber-400/90" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--faint)]">
                              {row.kind === "model"
                                ? row.model.description || row.model.providerName
                                : cliDefault
                                  ? `${cliDefault.name} — whatever ${agentDisplay} picks`
                                  : `Whatever ${agentDisplay} picks`}
                            </span>
                          </span>
                          {starred && (
                            <Star size={11} strokeWidth={2} className="shrink-0 fill-amber-300 text-amber-300" />
                          )}
                          {row.kind === "model" && (
                            <span className="shrink-0 text-[10px] text-[var(--faint)] tabular-nums">
                              {formatContext(row.model.maxContext || row.model.context)}
                            </span>
                          )}
                          <span className="flex w-4 shrink-0 items-center justify-center">
                            {checked ? (
                              <Check size={14} strokeWidth={2} className="check-pop text-[var(--ink)]" />
                            ) : highlighted ? (
                              <CornerDownLeft size={12} strokeWidth={2} className="text-[var(--faint)]" />
                            ) : null}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
                {/* Effort alone, without re-picking the model first. */}
                {effortLadder(catalog, currentModel).length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setPending(null);
                      setView("effort");
                    }}
                    className="mt-1 flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border-t border-[var(--border)] px-2 pt-2 pb-1.5 text-left hover:bg-[var(--hover)]"
                  >
                    <span className="shrink-0 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)]">
                      REASONING
                    </span>
                    <span className="min-w-0 flex-1 truncate text-right text-[12px] text-[var(--ink)]">
                      {effortLabel || "Default"}
                    </span>
                    <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                  </button>
                )}
                <div className="mt-1.5 shrink-0 border-t border-[var(--border)] px-1.5 pt-1.5 text-[10px] text-[var(--faint)]">
                  ↑↓ browse · ⏎ switch · the conversation carries over
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
