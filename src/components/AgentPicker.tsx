import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  MessageSquare,
  Search,
  ShieldCheck,
  ShieldOff,
  Star,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { api } from "../lib/api";
import { fitBelow } from "../lib/popover";
import { formatContext } from "../lib/types";
import type { AgentModel } from "../lib/types";
import {
  selectNextAgent,
  selectNextModel,
  selectNextVariant,
  starKey,
  useEgant,
  usesChatUi,
} from "../store";
import { ProviderGlyph, ProviderLogo } from "./ProviderLogo";

/** Which agent, model and effort the next session starts with. Sits in the
 * launch composer; existing sessions keep what they started with.
 *
 * Two screens, as Claude Code's own picker has: the agent is a named segmented
 * control across the top (not an icon-only strip you have to decode), the
 * catalog is a keyboard-driven list under it, and picking a model that
 * advertises reasoning variants swaps the whole popover to a separate effort
 * screen — its own back header, its own list, sized to its own content —
 * rather than crowding effort into the model list. The effort screen is also
 * reachable directly, through the row at the foot of the model list, so
 * changing effort alone doesn't mean re-picking the model first.
 *
 * Everything is reachable from the keys: type to filter (the search field only
 * appears once there is enough catalog to be worth searching), ↑↓ to move, ⏎
 * to pick, ⇥ to change agent, ← to come back from the effort screen. Each list
 * opens with the cursor already on what is in force, so ↓ steps off the
 * current choice rather than off the top of the list.
 *
 * The whole menu is one opaque pane (`isolate` + high z) so the launch-screen
 * labels can never bleed through it. */

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

/** Tab labels. The full names ("Claude Code") don't fit three-across, and the
 * CLI is what's being picked, so the CLI's short name is the honest label. */
const SHORT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
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

/** One selectable line in the list. Headings aren't rows — they're drawn
 * between them — so an index into this array is always something ⏎ can pick,
 * which is what keeps the arrow keys honest. */
type Row =
  | { kind: "default"; key: string }
  | { kind: "model"; key: string; model: AgentModel; starred: boolean }
  | { kind: "custom"; key: string; id: string };

/** Above this many models the list stops being scannable and the search field
 * earns its place. Claude (7) and Codex (8) open as a bare list; opencode's
 * live catalog runs to hundreds and opens with search. Typing reveals the
 * field either way — the input is always mounted and focused. */
const SEARCH_THRESHOLD = 10;

/** One shared empty catalog, so "not loaded yet" keeps a stable identity and
 * the list memos don't rebuild on every render while a fetch is in flight. */
const NO_MODELS: AgentModel[] = [];

/** How often opening the menu is allowed to spend a CLI spawn per agent on
 * rechecking logins. Module-level on purpose: the throttle belongs to the
 * window, not to a mounted picker. */
const VERIFY_EVERY_MS = 60_000;
let lastVerified = 0;

export function AgentPicker() {
  const agents = useEgant((s) => s.agents);
  const snapshot = useEgant((s) => s.snapshot);
  const composerAgent = useEgant((s) => s.composerAgent);
  const composerModel = useEgant((s) => s.composerModel);
  const composerVariant = useEgant((s) => s.composerVariant);
  const setComposerAgent = useEgant((s) => s.setComposerAgent);
  const setComposerModel = useEgant((s) => s.setComposerModel);
  const setComposerVariant = useEgant((s) => s.setComposerVariant);
  const composerBypass = useEgant((s) => s.composerBypass);
  const setComposerBypass = useEgant((s) => s.setComposerBypass);
  const refresh = useEgant((s) => s.refresh);
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const verifyAgents = useEgant((s) => s.verifyAgents);
  const models = useEgant((s) => s.models);
  const modelsAgent = useEgant((s) => s.modelsAgent);
  const modelsLoading = useEgant((s) => s.modelsLoading);
  const fetchModels = useEgant((s) => s.fetchModels);
  const warmModels = useEgant((s) => s.warmModels);
  const enabledAgents = useEgant((s) => s.enabledAgents);
  const defaultModels = useEgant((s) => s.defaultModels);
  const defaultVariants = useEgant((s) => s.defaultVariants);
  const starredModels = useEgant((s) => s.starredModels);
  const toggleStarred = useEgant((s) => s.toggleStarred);
  const openSettings = useEgant((s) => s.openSettings);
  // `agentCatalog`, not `catalog` — in this file `catalog` is the model
  // list for the current agent.
  const agentCatalog = useEgant((s) => s.catalog);
  const fetchCatalog = useEgant((s) => s.fetchCatalog);
  const chatUiAgents = useEgant((s) => s.chatUiAgents);
  const setChatUi = useEgant((s) => s.setChatUi);
  const askCliLaunch = useEgant((s) => s.askCliLaunch);

  const [open, setOpen] = useState(false);
  // "models" is the catalog screen; "effort" is the separate reasoning screen
  // a model with variants swaps in after it's picked.
  const [view, setView] = useState<"models" | "effort">("models");
  const [query, setQuery] = useState("");
  /** Index into `rows` the keyboard is on. Mouse movement adopts it too, so
   * there is only ever one highlight to reason about. */
  const [cursor, setCursor] = useState(0);
  /** The same, for the effort screen's own list. */
  const [effortCursor, setEffortCursor] = useState(0);
  // Bumped on every agent switch so the list replays its stagger.
  const [listToken, setListToken] = useState(0);
  // A ceiling, not a height: a short catalog draws a short menu instead of
  // padding 440px of empty pane under seven rows. The menu always drops
  // downward — see `fitBelow` — so this is the room under the trigger.
  const [menuMaxHeight, setMenuMaxHeight] = useState(440);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const effortRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
    // Anything else this machine has installed gets a tab too, so an agent
    // you installed in Settings is visible from the composer instead of
    // silently missing. It can't run a turn until egant has a harness for
    // it, which `DRIVABLE` is what marks — see `switchAgent`.
    for (const entry of agentCatalog) {
      if (entry.installed && !list.includes(entry.id)) list.push(entry.id);
    }
    return list;
  }, [agentCatalog, enabledAgents, effective]);

  /** Agents egant can actually run a turn against. The rest are listed but
   * open their Settings sheet rather than becoming the composer's agent — a
   * tab that silently failed on send would be worse than no tab. */
  const isDrivable = (id: string) => (RUNNABLE as readonly string[]).includes(id);

  const current = agents.find((a) => a.id === effective);
  const badModelIds = snapshot?.badModels?.[effective] ?? [];
  const defaultAgent = snapshot?.settings.defaultAgent ?? "claude";
  const effectiveModelId = selectNextModel(composerModel, defaultModels, effective);
  const effectiveVariant = selectNextVariant(
    composerVariant,
    defaultVariants,
    effective,
  );
  const settingsVariant = (defaultVariants[effective] ?? "").trim();
  const settingsModel = (defaultModels[effective] ?? "").trim();

  // Prefetch the catalog so the composer badge renders even before the menu
  // opens. Curated lists are instant; opencode is CLI-cached.
  useEffect(() => {
    // A CLI agent has no catalog to prefetch — `list_models` only knows the
    // harnessed ones, and asking it about `goose` is an error toast.
    if (!isChat(effective)) return;
    if (modelsAgent !== effective && !modelsLoading) void fetchModels(effective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective]);

  const toggleMenu = () => {
    if (!open) {
      setQuery("");
      setView("models");
      // A live recheck, not the cached presence list: this menu is exactly
      // where a stale "connected" dot (credentials file present, token
      // actually expired) would send someone into a session that fails. It
      // spawns a CLI per agent, though, so it runs at most once a minute
      // rather than on every open of a menu people open constantly.
      if (Date.now() - lastVerified > VERIFY_EVERY_MS) {
        lastVerified = Date.now();
        void verifyAgents();
      }
      // Cheap, and it's what decides which installed agents get a tab.
      void fetchCatalog();
      if (isChat(effective)) void fetchModels(effective);
      // The tabs the user hasn't clicked yet get fetched in the background,
      // so switching to one lands on a list instead of a spinner. An agent
      // with no CLI on this device has nothing to list, so it isn't asked,
      // and neither is one egant has no harness to list models through.
      for (const id of visibleAgents) {
        const status = agents.find((a) => a.id === id);
        if (id !== effective && isDrivable(id) && isChat(id) && (status?.installed ?? true)) {
          void warmModels(id);
        }
      }
      setMenuMaxHeight(fitBelow(rootRef, Math.min(440, window.innerHeight * 0.5)));
    }
    setOpen((o) => !o);
  };

  /** Whether picking this agent would start a chat session or open its own
   * CLI. Both halves of the answer live in the store — see `usesChatUi`. */
  const isChat = (id: string) => usesChatUi(agentCatalog, chatUiAgents, id);

  /** `chat` defaults to what the store says, but a caller that has *just*
   * changed the preference has to say so: the store's update is not visible
   * in this render's closure, so reading it here would use the old value. */
  const switchAgent = (id: string, chat: boolean = isChat(id)) => {
    // Not a chat agent — either egant has no harness for it, or its chat UI
    // has been turned off here. Either way the pick is a CLI session, and
    // the dialog is what confirms it.
    if (!chat) {
      // Remembered as the composer's agent even though the session it starts
      // is a terminal: cancelling the dialog should leave the picker showing
      // what was just picked, not silently snap back.
      setComposerAgent(id === defaultAgent ? null : id);
      setOpen(false);
      askCliLaunch(id);
      return;
    }
    // Chat-capable per the catalog but with no harness wired here: the
    // Settings sheet is the honest destination.
    if (!isDrivable(id)) {
      setOpen(false);
      openSettings("agents", id);
      return;
    }
    setListToken((t) => t + 1);
    if (id !== effective) {
      setComposerAgent(id === defaultAgent ? null : id);
      setComposerModel("");
      setComposerVariant("");
      // A filter typed against one catalog rarely means anything in the next.
      setQuery("");
      void fetchModels(id);
    }
    inputRef.current?.focus();
  };

  /** Turns the chat UI on or off for one agent. Off is a request to run the
   * CLI, so it goes straight to the launch dialog rather than leaving the
   * composer in a mode nothing has explained yet. */
  const toggleChatUi = (id: string, on: boolean) => {
    setChatUi(id, on);
    if (on) {
      switchAgent(id, true);
      return;
    }
    setComposerAgent(id === defaultAgent ? null : id);
    setOpen(false);
    askCliLaunch(id);
  };

  /** `⌘[`/`⌘]` walks only the agents a turn can actually go to, so the
   * cycle never lands on a tab that would bounce to Settings, or on one
   * that would throw a launch dialog up mid-cycle. */
  const cycleAgent = (step: number) => {
    const runnable = visibleAgents.filter((id) => isDrivable(id) && isChat(id));
    if (runnable.length === 0) return;
    const at = runnable.indexOf(effective);
    const next = runnable[(at + step + runnable.length) % runnable.length];
    if (next && next !== effective) switchAgent(next);
  };

  const fresh = modelsAgent === effective;
  const catalog = fresh ? models : NO_MODELS;
  const needle = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (needle === "") return catalog;
    return catalog.filter((m) =>
      `${m.name} ${m.id} ${m.providerName} ${m.description}`
        .toLowerCase()
        .includes(needle),
    );
  }, [catalog, needle]);

  // Starred models ride at the top of the same list rather than behind a
  // separate ★ tab: one list, no mode to be in, and the models someone
  // actually uses are the first thing under the cursor.
  const { rows, starredAt, othersAt } = useMemo(() => {
    const starred: AgentModel[] = [];
    const rest: AgentModel[] = [];
    for (const m of matches) {
      if (starredModels[starKey(effective, m.id)]) starred.push(m);
      else rest.push(m);
    }
    const out: Row[] = [];
    // Clearing the override means "follow Settings > Agents", so a Default row
    // is only honest while Settings isn't pinning a model for this agent —
    // otherwise it would be a row that resolves to something else. When one is
    // pinned, that model's own row carries the • marker instead.
    if (settingsModel === "" && (needle === "" || "default".startsWith(needle))) {
      out.push({ kind: "default", key: "__default" });
    }
    // Headings are drawn *before* these two indices rather than occupying
    // rows of their own, so ↑↓ never lands on something ⏎ can't pick.
    const starredAt = starred.length > 0 ? out.length : -1;
    for (const m of starred) out.push({ kind: "model", key: m.id, model: m, starred: true });
    const othersAt = starred.length > 0 && rest.length > 0 ? out.length : -1;
    for (const m of rest) out.push({ kind: "model", key: m.id, model: m, starred: false });
    if (needle !== "" && !matches.some((m) => m.id.toLowerCase() === needle)) {
      out.push({ kind: "custom", key: "__custom", id: query.trim() });
    }
    return { rows: out, starredAt, othersAt };
  }, [matches, starredModels, effective, needle, query, settingsModel]);

  // Where the cursor lands whenever the list is rebuilt: on the choice in
  // force when browsing, on the best match when filtering.
  useEffect(() => {
    if (needle !== "") {
      setCursor(0);
      return;
    }
    const at = rows.findIndex((row) =>
      row.kind === "model"
        ? row.model.id === effectiveModelId
        : row.kind === "default" && effectiveModelId === "",
    );
    setCursor(at >= 0 ? at : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effective, needle, rows.length, open]);

  useEffect(() => {
    rowRefs.current[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const pickModel = (model: AgentModel | null) => {
    setComposerModel(model?.id ?? "");
    // An effort the new model doesn't advertise would be sent as a flag the
    // CLI rejects, so it goes back to the agent's default.
    if (!model || !model.variants.includes(composerVariant)) setComposerVariant("");
    if (model && model.variants.length > 0) {
      // Hand off to the effort screen — the model is already chosen, so
      // closing here would be closing halfway through the decision.
      setView("effort");
      return;
    }
    setOpen(false);
  };

  const pickRow = (row: Row) => {
    if (row.kind === "default") pickModel(null);
    else if (row.kind === "model") pickModel(row.model);
    else {
      setComposerModel(row.id);
      setComposerVariant("");
      setOpen(false);
    }
  };

  const selectedModel = catalog.find((m) => m.id === effectiveModelId) ?? null;
  // What "Default" actually runs, where the CLI is willing to say. Codex
  // reports it in its own catalog; Claude and opencode don't, and the row
  // stays the honest "whatever it picks".
  const cliDefaultModel = catalog.find((m) => m.cliDefault) ?? null;
  // Effort levels to offer. A picked model carries its own; with the CLI
  // default picked there is no model to ask, so the agent's own fixed ladder
  // stands in — but only when the whole catalog agrees on one, which is true
  // of Claude (`--effort`) and Codex (`model_reasoning_effort`) and false of
  // opencode, where effort is per-model and guessing would offer levels the
  // chosen model doesn't take.
  const variants = useMemo(() => {
    if (selectedModel) return selectedModel.variants;
    if (catalog.length === 0) return [];
    // With "Default" picked there is no model to ask, so the efforts of the
    // model the CLI would actually choose are the right ones to offer.
    const cliDefault = catalog.find((m) => m.cliDefault);
    if (cliDefault) return cliDefault.variants;
    // Nothing says which model that is (Claude, opencode). A shared ladder is
    // still safe to offer — Claude's whole catalog takes the same `--effort`
    // levels — but a per-model one isn't, and guessing there would offer
    // levels the chosen model rejects.
    const first = catalog[0].variants;
    const shared = catalog.every(
      (m) =>
        m.variants.length === first.length && m.variants.every((v, i) => v === first[i]),
    );
    return shared ? first : [];
  }, [selectedModel, catalog]);

  const pickVariant = (variant: string) => {
    // Landing back on the Settings default clears the override, so the picker
    // keeps following Settings > Agents rather than freezing today's value.
    setComposerVariant(variant === settingsVariant ? "" : variant);
    setOpen(false);
  };

  // Entering the effort screen puts its cursor on the effort in force, and
  // hands the keys to whichever element that screen actually has — there is no
  // search field on it to hold focus.
  useEffect(() => {
    if (!open) return;
    if (view === "effort") {
      const at = variants.indexOf(effectiveVariant);
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (view === "effort") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setEffortCursor((c) => (variants.length === 0 ? 0 : (c + 1) % variants.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setEffortCursor((c) =>
          variants.length === 0 ? 0 : (c - 1 + variants.length) % variants.length,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const variant = variants[effortCursor];
        if (variant) pickVariant(variant);
      } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
        // Back to the catalog, which is where this screen came from. Escape is
        // deliberately left alone: it closes the whole menu from either
        // screen, the way it always has.
        e.preventDefault();
        e.stopPropagation();
        setView("models");
      }
      return;
    }
    if (e.key === "ArrowDown" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c + 1) % rows.length));
    } else if (e.key === "ArrowUp" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setCursor((c) => (rows.length === 0 ? 0 : (c - 1 + rows.length) % rows.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row) pickRow(row);
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycleAgent(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape" && query !== "") {
      // Clearing the filter first, closing second — the window-level handler
      // would otherwise swallow the whole menu on the first press.
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  const installed = current?.installed ?? true;
  const connected = current?.connected ?? true;
  // A CLI agent has no login state egant tracks — `pi` reports "not signed
  // in" forever — so the sign-in half of this only applies to chat agents.
  // Whether the binary is there still matters, and the launch dialog says so
  // too, but flagging it here is what keeps "Start" from being a dead end.
  const notice = !installed
    ? (current?.installHint ?? `${fallbackName(effective)} isn't installed on this device.`)
    : !connected && isChat(effective)
      ? `${current?.name ?? fallbackName(effective)} isn't signed in on this device.`
      : null;

  const searchShown = query !== "" || catalog.length > SEARCH_THRESHOLD;
  const variantBadge = effectiveVariant ? variantLabel(effectiveVariant) : "";
  const pickedTitle = !isChat(effective)
    ? `${agentCatalog.find((c) => c.id === effective)?.name ?? fallbackName(effective)} — runs in its own terminal. Click to change.`
    : effectiveModelId === ""
      ? `${current?.name ?? fallbackName(effective)} — CLI default. Click to change.`
      : `${selectedModel?.name ?? effectiveModelId}${variantBadge ? ` · ${variantBadge}` : ""} — click to change.`;

  rowRefs.current.length = rows.length;

  return (
    <div ref={rootRef} className="relative isolate shrink-0">
      <button
        type="button"
        title={pickedTitle}
        aria-expanded={open}
        onClick={toggleMenu}
        className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors duration-150 ${
          open
            ? "bg-[var(--hover)] text-[var(--ink)]"
            : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        }`}
      >
        <span
          key={`${effective}:${effectiveModelId}:${effectiveVariant}`}
          className="model-switch flex min-w-0 items-center gap-2"
        >
          <ProviderGlyph
            provider={AGENT_PROVIDER[effective] ?? effective}
            size={16}
            color={AGENT_ACCENT[effective]}
          />
          <span className="truncate text-[14px] font-semibold whitespace-nowrap text-[var(--ink)]">
            {/* A CLI agent's model is its own business, so the trigger names
              the agent instead of a model egant didn't choose. */}
            {!isChat(effective)
              ? (agentCatalog.find((c) => c.id === effective)?.name ??
                current?.name ??
                fallbackName(effective))
              : effectiveModelId === ""
                ? (current?.name ?? fallbackName(effective))
                : (selectedModel?.name ?? effectiveModelId)}
          </span>
          {!isChat(effective) ? (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[13px] text-[var(--muted)]">
              <TerminalSquare size={12} strokeWidth={2} />
              CLI
            </span>
          ) : (
            variantBadge && (
              <span className="shrink-0 text-[13px] whitespace-nowrap text-[var(--muted)]">
                {variantBadge}
              </span>
            )
          )}
        </span>
        {notice !== null && (
          <TriangleAlert size={12} strokeWidth={2} className="shrink-0 text-amber-400/90" />
        )}
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={`shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="dialog"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onMouseUp={(e) => {
            // Clicking a star, a tab or an effort row moves focus off whatever
            // was holding the keys, so it's handed straight back — the input
            // on the catalog screen, the menu itself on the effort one.
            if (view === "effort") menuRef.current?.focus();
            else if (e.target !== inputRef.current) inputRef.current?.focus();
          }}
          style={{ maxHeight: menuMaxHeight, transformOrigin: "top left" }}
          className="menu menu-pop absolute top-full left-0 z-[80] mt-2 flex w-[420px] flex-col overflow-hidden rounded-2xl p-2 outline-none"
        >
          {view === "effort" ? (
            <>
              {/* Reasoning — its own screen, separate from the catalog, sized
                to its own content rather than sharing the list's scroll
                region. */}
              <button
                type="button"
                onClick={() => setView("models")}
                className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--hover)]"
              >
                <ChevronLeft size={14} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                {(selectedModel ?? cliDefaultModel) ? (
                  <ProviderLogo provider={(selectedModel ?? cliDefaultModel)!.provider} size={22} />
                ) : (
                  <ProviderGlyph
                    provider={AGENT_PROVIDER[effective] ?? effective}
                    size={20}
                    color={AGENT_ACCENT[effective]}
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">
                  {(selectedModel ?? cliDefaultModel)?.name ??
                    (effectiveModelId || (current?.name ?? fallbackName(effective)))}
                </span>
              </button>
              <div className="mx-1 my-1.5 shrink-0 border-t border-[var(--border)]" />
              <div className="shrink-0 px-2 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)]">
                REASONING
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {variants.map((variant, index) => {
                  // Settings' pin wins the label when there is one; otherwise
                  // the model's own default effort is the thing worth marking,
                  // since that is what an unset effort actually runs at.
                  const modelDefault =
                    (selectedModel ?? cliDefaultModel)?.defaultVariant ?? "";
                  const isDefault =
                    settingsVariant !== ""
                      ? settingsVariant === variant
                      : modelDefault === variant;
                  const isChecked = effectiveVariant === variant;
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
                          isChecked ? "font-semibold" : ""
                        }`}
                      >
                        {variantLabel(variant)}
                      </span>
                      {isDefault && (
                        <span className="shrink-0 rounded bg-[var(--bubble)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
                          Default
                        </span>
                      )}
                      <span className="flex w-4 shrink-0 items-center justify-center">
                        {isChecked ? (
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
          {/* Agent — named segments, because which CLI runs the turn is the
            first thing being chosen and an icon alone doesn't say it. */}
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto rounded-xl bg-[var(--card)] p-1">
            {visibleAgents.map((id) => {
              const s = agents.find((a) => a.id === id);
              const entry = agentCatalog.find((c) => c.id === id);
              const drivable = isDrivable(id);
              const ok = s?.installed ?? entry?.installed ?? true;
              const live = s?.connected ?? false;
              const chat = isChat(id);
              const active = id === effective && drivable;
              const name = s?.name ?? entry?.name ?? fallbackName(id);
              // Only an agent egant *has* a harness for can be toggled — for
              // the rest the CLI isn't a preference, it's the only way to run
              // them, and a switch that can't move is worse than none.
              const toggleable = entry?.chatUi ?? RUNNABLE.includes(id as (typeof RUNNABLE)[number]);
              return (
                // A wrapper, not the button itself: the chat-UI switch is its
                // own control and cannot be nested inside the tab's button.
                <div key={id} className="group relative flex shrink-0">
                  <button
                    type="button"
                    onClick={() => switchAgent(id)}
                    title={
                      !chat
                        ? `${name} — runs as a CLI in its own terminal.`
                        : !drivable
                          ? `${name} — installed, but egant can't run it in chat yet. Opens its settings.`
                          : s
                            ? `${name} — ${ok ? (live ? (s.email ?? "Signed in") : "Not signed in") : (s.installHint ?? "Not installed")}`
                            : name
                    }
                    className={`flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors duration-150 ${
                      active
                        ? "bg-[var(--selected)] text-[var(--ink)]"
                        : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                    } ${ok && (drivable || !chat) ? "" : "opacity-50"}`}
                  >
                    <ProviderGlyph
                      provider={AGENT_PROVIDER[id] ?? entry?.vendor ?? id}
                      size={15}
                      color={AGENT_ACCENT[id]}
                    />
                    <span className="truncate text-[12px] font-medium">
                      {SHORT_NAMES[id] ?? entry?.name ?? fallbackName(id)}
                    </span>
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        // A tab egant can't drive isn't "signed out" — it has no
                        // login state to report at all, so it gets the neutral
                        // dot rather than the amber "not signed in" one.
                        !chat || !drivable || !ok
                          ? "bg-[var(--faint)]"
                          : live
                            ? "bg-emerald-400"
                            : "bg-amber-400/80"
                      }`}
                    />
                  </button>
                  {toggleable && (
                    // Sits over the tab's status dot, which is why the dot is
                    // the thing it replaces: the strip is three tabs across a
                    // 330px menu and there is no room for a second column.
                    // Always drawn once the chat UI is *off*, so a tab that
                    // will open a terminal says so without being hovered.
                    <button
                      type="button"
                      title={
                        chat
                          ? `Using egant's chat UI for ${name} — switch to its own CLI`
                          : `Running the ${name} CLI — switch back to egant's chat UI`
                      }
                      aria-pressed={chat}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleChatUi(id, !chat);
                      }}
                      className={`absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md transition-opacity duration-150 ${
                        chat
                          ? "text-[var(--faint)] opacity-0 group-hover:opacity-100 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                          : "bg-[var(--bubble)] text-[var(--ink)] opacity-100"
                      }`}
                    >
                      {chat ? (
                        <MessageSquare size={11} strokeWidth={2.2} />
                      ) : (
                        <TerminalSquare size={11} strokeWidth={2.2} />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Only when something is actually wrong — and it's the fix, not a
            label: the trip to Settings is the whole reason to show it. */}
          {notice !== null && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings(installed ? "accounts" : "agents");
              }}
              className="mt-1.5 flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/10 px-2.5 py-1.5 text-left text-[11px] text-amber-200 hover:bg-amber-400/15"
            >
              <TriangleAlert size={12} strokeWidth={2} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{notice}</span>
              <span className="shrink-0 font-medium underline underline-offset-2">
                {installed ? "Sign in" : "Install"}
              </span>
            </button>
          )}

          {/* A CLI agent has no model list to draw: egant isn't choosing the
            model, the CLI's own picker is. So the pane below the tabs stops
            being a catalog and becomes the one thing there is to do. */}
          {!isChat(effective) && (
            <div className="mt-1.5 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--ink)]">
                <TerminalSquare size={13} strokeWidth={2} className="shrink-0" />
                {current?.name ?? agentCatalog.find((c) => c.id === effective)?.name ??
                  fallbackName(effective)}{" "}
                runs in a terminal
              </div>
              <p className="mt-1 text-[11px] leading-[1.5] text-[var(--faint)]">
                Its own prompt and model picker take over — egant opens it in this
                project and keeps the files and changes panel beside it.
              </p>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  askCliLaunch(effective);
                }}
                className="mt-2.5 w-full cursor-pointer rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90"
              >
                Open terminal
              </button>
            </div>
          )}

          {/* The input is always mounted and always focused — it is what makes
            the arrow keys and ⏎ work — but it only takes up room once there
            is a catalog worth filtering, or once something has been typed. */}
          <div
            className={
              searchShown && isChat(effective)
                ? "mt-1.5 shrink-0"
                : "h-0 shrink-0 overflow-hidden opacity-0"
            }
          >
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
              {query !== "" && (
                <span className="shrink-0 rounded bg-[var(--bubble)] px-1.5 py-0.5 text-[10px] text-[var(--faint)]">
                  esc
                </span>
              )}
            </div>
          </div>

          {/* Chat UI toggle — always visible above the model list for
            chat-capable agents. On by default; turning it off asks for the
            agent's own CLI instead. */}
          {(() => {
            const entry = agentCatalog.find((c) => c.id === effective);
            const toggleable =
              entry?.chatUi ?? (RUNNABLE as readonly string[]).includes(effective);
            if (!toggleable) return null;
            const chat = isChat(effective);
            const label = current?.name ?? entry?.name ?? fallbackName(effective);
            return (
              <div className="mt-1.5 flex shrink-0 items-center gap-2.5 rounded-lg bg-[var(--card)] px-2.5 py-2">
                {chat ? (
                  <MessageSquare size={14} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
                ) : (
                  <TerminalSquare size={14} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ink)]">
                  {chat ? "Chat UI" : `Go to ${label} CLI`}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={chat}
                  title={
                    chat
                      ? `Chat UI on — switch to the ${label} CLI`
                      : "Chat UI off — switch back to Chat UI"
                  }
                  onClick={() => toggleChatUi(effective, !chat)}
                  className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-0.5 ${
                    chat ? "justify-end bg-[var(--toggle-on)]" : "justify-start bg-[var(--bubble)]"
                  }`}
                >
                  <span
                    className={`h-4 w-4 rounded-full ${
                      chat ? "bg-[var(--toggle-knob)]" : "bg-[var(--faint)]"
                    }`}
                  />
                </button>
              </div>
            );
          })()}

          {/* Bypass permissions — for before a session exists to toggle it
            on. Applied to the session the moment it's created (see
            `applyComposerBypass` in the store); only offered where it means
            anything — a chat session egant actually drives. Same neutral
            switch as the Chat UI toggle above, not a warning color: this is
            an ordinary setting, not something to alarm over. */}
          {isChat(effective) && isDrivable(effective) && (
            <div className="mt-1.5 flex shrink-0 items-center gap-2.5 rounded-lg bg-[var(--card)] px-2.5 py-2">
              {composerBypass ? (
                <ShieldOff size={14} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
              ) : (
                <ShieldCheck size={14} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
              )}
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--ink)]">
                Bypass permissions
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={composerBypass}
                title={
                  composerBypass
                    ? "The next session starts without asking — click to ask normally"
                    : "Start the next session without asking for permission"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  setComposerBypass(!composerBypass);
                }}
                className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-0.5 ${
                  composerBypass
                    ? "justify-end bg-[var(--toggle-on)]"
                    : "justify-start bg-[var(--bubble)]"
                }`}
              >
                <span
                  className={`h-4 w-4 rounded-full ${
                    composerBypass ? "bg-[var(--toggle-knob)]" : "bg-[var(--faint)]"
                  }`}
                />
              </button>
            </div>
          )}

          {/* The catalog — the only scrolling region in the menu. */}
          <div
            key={`${effective}:${listToken}`}
            role="listbox"
            className="mt-1 min-h-0 flex-1 overflow-y-auto"
          >
            {!isChat(effective) ? null : modelsLoading && catalog.length === 0 ? (
              <div className="px-2.5 py-3 text-[12px] text-[var(--faint)]">Loading models…</div>
            ) : !installed ? (
              // The hint itself is in the banner above; repeating it here
              // would just say the same sentence twice.
              <div className="px-2 py-3 text-[12px] text-[var(--faint)]">
                No catalog until the CLI is installed.
              </div>
            ) : rows.length === 0 ? (
              <div className="px-2.5 py-3 text-[12px] text-[var(--faint)]">
                {needle !== "" ? "No models match." : "No models found."}
              </div>
            ) : (
              rows.map((row, index) => {
                const heading =
                  index === starredAt ? "STARRED" : index === othersAt ? "ALL MODELS" : null;
                return (
                  <div key={row.key}>
                    {heading && (
                      <div className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)]">
                        {heading}
                      </div>
                    )}
                    {row.kind === "custom" ? (
                      <ListRow
                        innerRef={(el) => (rowRefs.current[index] = el)}
                        index={index}
                        highlighted={cursor === index}
                        checked={false}
                        name={`Use “${row.id}”`}
                        description="Run this id as typed"
                        onHover={() => setCursor(index)}
                        onClick={() => pickRow(row)}
                      />
                    ) : row.kind === "default" ? (
                      <ListRow
                        innerRef={(el) => (rowRefs.current[index] = el)}
                        index={index}
                        highlighted={cursor === index}
                        checked={effectiveModelId === ""}
                        logo={
                          <ProviderGlyph
                            provider={AGENT_PROVIDER[effective] ?? effective}
                            size={20}
                            color={AGENT_ACCENT[effective]}
                          />
                        }
                        name="Default"
                        description={
                          cliDefaultModel
                            ? `${cliDefaultModel.name} — whatever ${current?.name ?? fallbackName(effective)} picks`
                            : `Whatever ${current?.name ?? fallbackName(effective)} picks`
                        }
                        badge={
                          cliDefaultModel
                            ? formatContext(cliDefaultModel.maxContext || cliDefaultModel.context)
                            : undefined
                        }
                        onHover={() => setCursor(index)}
                        onClick={() => pickRow(row)}
                      />
                    ) : (
                      <ListRow
                        innerRef={(el) => (rowRefs.current[index] = el)}
                        index={index}
                        highlighted={cursor === index}
                        checked={effectiveModelId === row.model.id}
                        logo={<ProviderLogo provider={row.model.provider} size={24} />}
                        name={row.model.name}
                        description={row.model.description || row.model.providerName}
                        badge={formatContext(row.model.maxContext || row.model.context)}
                        isDefault={row.model.id === settingsModel}
                        bad={badModelIds.includes(row.model.id)}
                        starred={row.starred}
                        onToggleStar={() => toggleStarred(effective, row.model.id)}
                        onHover={() => setCursor(index)}
                        onClick={() => pickRow(row)}
                      />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* The way into the reasoning screen without re-picking the model
            first — the only reason it used to take two clicks to change one
            effort was that there was no door but the model row. */}
          {variants.length > 0 && isChat(effective) && (
            <button
              type="button"
              onClick={() => setView("effort")}
              className="mt-1 flex shrink-0 cursor-pointer items-center gap-2 rounded-lg border-t border-[var(--border)] px-2 pt-2 pb-1.5 text-left hover:bg-[var(--hover)]"
            >
              <span className="shrink-0 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)]">
                REASONING
              </span>
              <span className="min-w-0 flex-1 truncate text-right text-[12px] text-[var(--ink)]">
                {/* What the next turn runs at: the override, else the model's
                  own default where the CLI reports one, else just "Default". */}
                {variantLabel(
                  effectiveVariant || (selectedModel ?? cliDefaultModel)?.defaultVariant || "",
                ) || "Default"}
              </span>
              <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
            </button>
          )}

          {/* Keys, and the one housekeeping action that belongs here. */}
          <div className="mt-1.5 flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-1.5 pt-1.5 text-[10px] text-[var(--faint)]">
            <span className="truncate">
              {isChat(effective) ? "↑↓ browse · ⏎ select · ⇥ agent" : "⇥ agent"}
            </span>
            {effective !== defaultAgent && (
              <button
                type="button"
                onClick={() => void rememberDefault()}
                className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
              >
                Make default
              </button>
            )}
          </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One line of the catalog. `highlighted` is where the keys are; `checked` is
 * what the next session would actually run — they are drawn differently on
 * purpose, because they are usually not the same row. */
function ListRow({
  innerRef,
  index,
  name,
  description,
  logo,
  badge,
  highlighted,
  checked,
  starred,
  isDefault,
  bad,
  onToggleStar,
  onHover,
  onClick,
}: {
  innerRef: (el: HTMLDivElement | null) => void;
  index: number;
  name: string;
  description?: string;
  logo?: React.ReactNode;
  badge?: string;
  highlighted: boolean;
  checked: boolean;
  starred?: boolean;
  /** Settings > Agents pins this model for the agent — the same • the effort
   * row uses for the pinned effort. */
  isDefault?: boolean;
  /** Failed with a model/catalog-shaped error earlier this session — still
   * pickable (the failure could be transient, or fixed by then), just
   * flagged so the same wall isn't hit twice without warning. */
  bad?: boolean;
  onToggleStar?: () => void;
  onHover: () => void;
  onClick: () => void;
}) {
  return (
    <div
      ref={innerRef}
      role="option"
      aria-selected={checked}
      tabIndex={-1}
      onClick={onClick}
      onMouseMove={onHover}
      title={bad ? "Failed earlier this session — may still be worth retrying" : undefined}
      style={{ animationDelay: `${Math.min(index, 8) * 22}ms` }}
      className={`row-in group flex w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-2 py-[7px] text-left ${
        highlighted ? "bg-[var(--hover)]" : ""
      } ${bad ? "opacity-60" : ""}`}
    >
      <span className="flex w-6 shrink-0 items-center justify-center">{logo}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span
          className={`shrink-0 truncate text-[13px] ${
            checked ? "font-semibold text-[var(--ink)]" : "font-medium text-[var(--ink)]"
          }`}
        >
          {name}
        </span>
        {bad && <TriangleAlert size={11} strokeWidth={2} className="shrink-0 text-amber-400/90" />}
        {description && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--faint)]">
            {bad ? "Failed earlier this session" : description}
          </span>
        )}
      </span>
      {badge && (
        <span
          title={`Runs with its full ${badge} context`}
          className="shrink-0 text-[10px] text-[var(--faint)] tabular-nums"
        >
          {badge}
        </span>
      )}
      {isDefault && (
        <span
          title="Your default for this agent"
          className="shrink-0 text-[11px] leading-none text-[var(--faint)]"
        >
          •
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
            starred ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <Star
            size={13}
            strokeWidth={2}
            className={
              starred ? "fill-amber-300 text-amber-300" : "text-[var(--faint)] hover:text-amber-300"
            }
          />
        </button>
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
}
