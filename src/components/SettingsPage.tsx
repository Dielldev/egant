import {
  AlertTriangle,
  AppWindow,
  Archive,
  ArrowUpDown,
  Bell,
  BellRing,
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronLeft as BackChevron,
  CirclePlus,
  Eye,
  Folder,
  AlignLeft,
  KeyRound,
  Keyboard,
  LayoutGrid,
  MessageCircle,
  Monitor,
  Music,
  Pencil,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import {
  DEFAULT_SOUND_THEME,
  NOTIFY_KEYS,
  SOUND_THEMES,
  playCue,
  sendBanner,
} from "../lib/notify";
import type { NotifyKind } from "../lib/notify";
import { isMac, modShortcut, windowBarPadClass } from "../lib/platform";
import { shouldOpenUpward } from "../lib/popover";
import { ACCENTS, DARK_THEMES, LIGHT_THEMES } from "../lib/themes";
import { ageLabel } from "../lib/transcript";
import type { AgentStatus, ArchivedSession } from "../lib/types";
import type { ThemeName } from "cuelume";
import { useEgant } from "../store";
import type { BgEffect, GlassMode, SettingsSection } from "../store";
import { AgentsSection } from "./AgentsSettings";
import {
  Card,
  DevicePill,
  Dot,
  FILES_SETTINGS_EVENT,
  Pills,
  Row,
  SectionHead,
  Toggle,
  usePersistentState,
} from "./SettingsKit";
import { useNow } from "./useNow";
import {
  ConnectDeviceRow,
  PairedPhones,
  PhoneAccessSettings,
  PhoneConnectDialog,
  usePhoneAccess,
} from "./PhoneAccess";
import { AGENT_ACCENT, AGENT_PROVIDER } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";

/** Settings: the window behind the "Local only" profile. A left rail of
 * sections beside a scrolling pane, closed with the Back button (or `Esc`).
 * Appearance is fully wired to the window; the other sections are local
 * state until their backends land. */

const NAV: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: "devices", label: "Devices", icon: Monitor },
  { id: "agents", label: "Agents", icon: LayoutGrid },
  { id: "accounts", label: "Accounts", icon: KeyRound },
  { id: "appearance", label: "Appearance", icon: SlidersHorizontal },
  { id: "files", label: "Files", icon: Folder },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "appshots", label: "Appshots", icon: AppWindow },
  { id: "archived", label: "Archived sessions", icon: Archive },
];

export function SettingsPage() {
  const section = useEgant((s) => s.settingsSection);
  const setSection = useEgant((s) => s.setSettingsSection);
  const closeSettings = useEgant((s) => s.closeSettings);

  // Back/forward walk the visited sections. Fresh on every open, since the
  // page mounts anew when the overlay opens.
  const [hist, setHist] = useState<SettingsSection[]>([section]);
  const [index, setIndex] = useState(0);
  const go = (next: SettingsSection) => {
    if (next === hist[index]) return;
    const nextHist = [...hist.slice(0, index + 1), next];
    setHist(nextHist);
    setIndex(nextHist.length - 1);
    setSection(next);
  };
  const step = (delta: -1 | 1) => {
    const next = index + delta;
    if (next < 0 || next >= hist.length) return;
    setIndex(next);
    setSection(hist[next]);
  };

  return (
    <div className="stage-glass flex h-screen w-screen overflow-hidden text-[var(--ink)]">
      <aside className="sidebar-glass flex h-full w-[220px] shrink-0 flex-col border-r border-[var(--border)]">
        <div
          data-tauri-drag-region
          className={`flex h-[38px] w-full shrink-0 items-center gap-0.5 pr-2 ${windowBarPadClass()}`}
        >
          <NavArrow label="Back" disabled={index === 0} onClick={() => step(-1)}>
            <ChevronLeft size={15} strokeWidth={2} />
          </NavArrow>
          <NavArrow
            label="Forward"
            disabled={index >= hist.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight size={15} strokeWidth={2} />
          </NavArrow>
        </div>
        <div className="px-4 pt-1 pb-1.5 text-[11px] font-medium text-[var(--faint)]">
          Settings
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] ${
                item.id === hist[index]
                  ? "bg-[var(--selected)] font-semibold text-[var(--ink)]"
                  : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
              }`}
            >
              <item.icon size={15} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="shrink-0 px-1.5 py-3">
          <button
            type="button"
            onClick={() => closeSettings()}
            className="flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <BackChevron size={14} strokeWidth={2} />
            Back
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-10 pt-9 pb-16">
          {hist[index] === "devices" && <DevicesSection />}
          {hist[index] === "agents" && <AgentsSection />}
          {hist[index] === "accounts" && <AccountsSection />}
          {hist[index] === "appearance" && <AppearanceSection />}
          {hist[index] === "files" && <FilesSection />}
          {hist[index] === "notifications" && <NotificationsSection />}
          {hist[index] === "shortcuts" && <ShortcutsSection />}
          {hist[index] === "appshots" && <Placeholder text="App snapshots will live here." />}
          {hist[index] === "archived" && <ArchivedSection />}
        </div>
      </main>
    </div>
  );
}

function NavArrow({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)]"
    >
      {children}
    </button>
  );
}

function timeAgo(ts: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function osLabel(): string {
  const ua = navigator.userAgent || "";
  if (/mac/i.test(ua)) return "macOS";
  if (/win/i.test(ua)) return "Windows";
  return "Linux";
}

/** Stable per-machine fragment, e.g. `6886504b..393d`. */
function useDeviceId(): string {
  return useMemo(() => {
    try {
      let id = localStorage.getItem("egant.deviceId");
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(6)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        localStorage.setItem("egant.deviceId", id);
      }
      return `${id.slice(0, 8)}..${id.slice(8)}`;
    } catch {
      return "00000000..0000";
    }
  }, []);
}

function useAddedAt(): number {
  return useMemo(() => {
    try {
      const raw = localStorage.getItem("egant.deviceAddedAt");
      if (raw) return Number(raw);
      const now = Date.now();
      localStorage.setItem("egant.deviceAddedAt", String(now));
      return now;
    } catch {
      return Date.now();
    }
  }, []);
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function DevicesSection() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "");
  const [override, setOverride] = usePersistentState<string | null>(
    "egant.deviceName",
    null,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [version, setVersion] = useState("0.1.0");
  const deviceId = useDeviceId();
  const addedAt = useAddedAt();
  const now = useNow(30_000);
  const phone = usePhoneAccess();

  const name = override || machine || "Local device";

  useEffect(() => {
    let live = true;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then((v) => {
        if (live && v) setVersion(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return (
    <div>
      <SectionHead
        title="Devices"
        count={1 + (phone.status?.devices.length ?? 0)}
        sub="This Mac, and the phones you've connected to it."
      />
      <Card>
        <div className="flex items-center gap-3.5 px-4 py-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)]">
            <Monitor size={16} strokeWidth={2} />
          </span>
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setOverride(draft.trim() || null);
                    setEditing(false);
                  }
                  if (e.key === "Escape") {
                    // Cancel the rename without backing out of settings.
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                onBlur={() => {
                  setOverride(draft.trim() || null);
                  setEditing(false);
                }}
                className="w-full max-w-[280px] rounded-md border border-[var(--accent)] bg-transparent px-1.5 py-0.5 text-[13px] font-semibold text-[var(--ink)] outline-none"
              />
            ) : (
              <div className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</div>
            )}
            <div className="mt-0.5 truncate text-[12px] text-[var(--faint)]">
              {osLabel()}
              <Dot />v{version}
              <Dot />
              Last seen {timeAgo(now, now)}
              <Dot />
              Added {timeAgo(addedAt, now)}
              <Dot />
              {deviceId}
            </div>
          </div>
          <span className="shrink-0 text-[12px] text-[var(--muted)]">This Mac</span>
          <button
            type="button"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <Pencil size={13} strokeWidth={2} />
            Rename
          </button>
        </div>
        <PairedPhones phone={phone} />
        <ConnectDeviceRow phone={phone} />
      </Card>
      <PhoneAccessSettings phone={phone} />
      <PhoneConnectDialog phone={phone} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function AccountsSection() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "Local device");
  const agents = useEgant((s) => s.agents);
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const verifyAgents = useEgant((s) => s.verifyAgents);
  const refresh = useEgant((s) => s.refresh);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    void verifyAgents();
  }, [verifyAgents]);

  const statusOf = (id: string) => agents.find((a) => a.id === id);
  const known = agents.length > 0;
  const connectedCount = ["claude", "codex", "opencode", "cursor"].filter(
    (id) => statusOf(id)?.connected,
  ).length;

  const refreshAll = () => {
    setSpinning(true);
    const ids = ["claude", "codex", "opencode", "cursor"];
    void Promise.all([
      refresh(),
      fetchAgents(),
      ...ids.map((id) => api.checkAgentLogin(id).catch(() => null)),
    ]).finally(() => {
      void fetchAgents();
      setSpinning(false);
    });
  };

  return (
    <div>
      <SectionHead
        title="Accounts"
        count={connectedCount}
        sub="The Claude Code, Codex, OpenCode, and Cursor logins on this device. Refresh re-checks each login with the CLI itself, not just whether a credentials file exists."
        right={
          <>
            <button
              type="button"
              onClick={refreshAll}
              className="flex cursor-pointer items-center gap-1.5 text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
            >
              <RefreshCw size={13} strokeWidth={2} className={spinning ? "animate-spin" : ""} />
              Refresh
            </button>
            <DevicePill name={machine} />
          </>
        }
      />

      <AccountGroup
        id="claude"
        icon={<ProviderGlyph provider="claude" size={15} />}
        name="Claude Code"
        installed={!known || (statusOf("claude")?.installed ?? false)}
        body={
          <AccountBody
            status={statusOf("claude")}
            empty="Claude Code isn't connected on this device — Add account to sign in."
          />
        }
      />

      <AccountGroup
        id="codex"
        icon={<ProviderGlyph provider="codex" size={15} />}
        name="Codex"
        installed={!known || (statusOf("codex")?.installed ?? false)}
        body={
          <AccountBody
            status={statusOf("codex")}
            empty="Codex isn't connected on this device — Add account to sign in."
          />
        }
      />

      <AccountGroup
        id="opencode"
        icon={<ProviderGlyph provider="opencode" size={15} />}
        name="OpenCode"
        installed={!known || (statusOf("opencode")?.installed ?? false)}
        body={
          <AccountBody
            status={statusOf("opencode")}
            empty="OpenCode isn't installed on this device — install it to use its free models, or add a provider account."
            readySubtitle="Free models ready — Add account to sign in to a specific provider"
          />
        }
      />

      <AccountGroup
        id="cursor"
        // No real Cursor mark ships in assets/logos yet — the plain Lucide
        // glyph stays until one is added, rather than guessing at a brand
        // asset.
        icon={<Box size={15} strokeWidth={2} className="text-[var(--muted)]" />}
        name="Cursor"
        installed={!known || (statusOf("cursor")?.installed ?? false)}
        body={
          <AccountBody
            status={statusOf("cursor")}
            empty="Cursor isn't connected on this device — cursor-agent sign-in isn't wired up yet."
          />
        }
      />

      <p className="mt-4 max-w-[700px] text-[12px] leading-relaxed text-[var(--faint)]">
        Add account runs each CLI&apos;s own sign-in: Claude Code and Codex open a
        browser tab in the background, OpenCode opens a Terminal window for its
        provider picker. This device only ever holds one login per agent — Add
        account replaces whichever one is currently signed in.
      </p>
    </div>
  );
}

function AccountBody({
  status,
  empty,
  readySubtitle,
}: {
  status?: AgentStatus;
  empty: string;
  /** Overrides the "Logged in" line for an agent with no real login step —
   * OpenCode is ready off the CLI install alone (its free-tier models need
   * no provider auth), so "Logged in" would claim a step that never
   * happened. */
  readySubtitle?: string;
}) {
  if (!status?.connected) {
    return (
      <div className="px-4 py-6 text-center text-[13px] text-[var(--muted)]">{empty}</div>
    );
  }
  const letter = (status.email?.[0] ?? status.name[0]).toUpperCase();
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--selected)] text-[12px] font-medium text-[var(--ink)]">
        {letter}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
          {status.email ?? `${status.name} connected`}
        </div>
        <div className="mt-0.5 text-[12px] text-[var(--faint)]">
          {status.email ? "Usage unavailable" : (readySubtitle ?? "Logged in")}
        </div>
      </div>
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
        Active
      </span>
    </div>
  );
}

/** How long "Add account" keeps polling `checkAgentLogin` after a login was
 * started, before giving up and pointing the user at Refresh instead. Long
 * enough for a browser OAuth round trip or a terminal picker, not so long a
 * click-away-and-forget leaves it spinning forever. */
const CONNECT_POLL_MS = 2_500;
const CONNECT_TIMEOUT_MS = 120_000;

/** What to tell the user to go look at while a sign-in is under way — each
 * agent's "Add account" opens a different place, so "finish signing in"
 * alone leaves them checking the wrong window. */
const CONNECT_HINTS: Record<string, string> = {
  claude: "Check your browser — a Claude Code sign-in tab should have opened.",
  codex: "Check your browser — a Codex sign-in tab should have opened.",
  opencode: "Check the Terminal window that just opened and follow its provider picker.",
};

function AccountGroup({
  id,
  icon,
  name,
  installed,
  body,
}: {
  id: string;
  icon: ReactNode;
  name: string;
  installed: boolean;
  body: ReactNode;
}) {
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pollToken = useRef(0);

  useEffect(() => () => {
    // Invalidate any in-flight poll loop when this row unmounts (settings closed).
    pollToken.current += 1;
  }, []);

  const onAdd = async () => {
    const token = ++pollToken.current;
    setNote(null);
    try {
      await api.connectAgent(id);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      return;
    }
    setConnecting(true);
    setNote(CONNECT_HINTS[id] ?? "Finish signing in — this updates on its own once you do.");
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    const poll = async () => {
      if (pollToken.current !== token) return; // superseded or unmounted
      let status: AgentStatus | null = null;
      try {
        status = await api.checkAgentLogin(id);
      } catch {
        // A transient spawn failure shouldn't end the wait early.
      }
      if (pollToken.current !== token) return;
      if (status?.connected) {
        setConnecting(false);
        setNote(null);
        void fetchAgents();
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(() => void poll(), CONNECT_POLL_MS);
      } else {
        setConnecting(false);
        setNote("Still not connected — finish signing in, then hit Refresh.");
      }
    };
    setTimeout(() => void poll(), CONNECT_POLL_MS);
  };

  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ink)]">
          {icon}
          {name}
        </span>
        <button
          type="button"
          title={installed ? `Add ${name} account` : `Install ${name} to connect an account`}
          disabled={connecting || !installed}
          onClick={() => void onAdd()}
          className="flex cursor-pointer items-center gap-1.5 text-[13px] text-[var(--muted)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-50 disabled:hover:text-[var(--muted)]"
        >
          <CirclePlus size={14} strokeWidth={2} className={connecting ? "animate-pulse" : ""} />
          {connecting ? "Connecting…" : "Add account"}
        </button>
      </div>
      <Card>{body}</Card>
      {note && (
        <div
          className={`mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${
            connecting
              ? "border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--ink)]"
              : "border-amber-400/25 bg-amber-400/10 text-amber-200"
          }`}
        >
          {connecting ? (
            <RefreshCw size={13} strokeWidth={2} className="mt-0.5 shrink-0 animate-spin" />
          ) : (
            <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          )}
          <span>{note}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance (fully functional)
// ---------------------------------------------------------------------------

const GLASS_OPTIONS: { value: GlassMode; label: string }[] = [
  { value: "default", label: "Theme default" },
  { value: "frosted", label: "Frosted" },
  { value: "clear", label: "Clear" },
  { value: "opaque", label: "No Glass" },
];

const BG_EFFECTS: { value: BgEffect; label: string }[] = [
  { value: "none", label: "None" },
  { value: "dither", label: "Dither" },
  { value: "ascii", label: "ASCII" },
  { value: "halftone", label: "Halftone" },
  { value: "scanlines", label: "Scanlines" },
];

function AppearanceSection() {
  const appearance = useEgant((s) => s.appearance);
  const setAppearance = useEgant((s) => s.setAppearance);
  const wallpaperUrl = useEgant((s) => s.wallpaperUrl);
  const wallpaperName = useEgant((s) => s.snapshot?.settings.wallpaperName ?? null);
  const wallpaperDim = useEgant((s) => s.snapshot?.settings.wallpaperDim ?? 0.55);
  const chooseWallpaper = useEgant((s) => s.chooseWallpaper);
  const clearWallpaper = useEgant((s) => s.clearWallpaper);
  const cycleDim = useEgant((s) => s.cycleDim);

  return (
    <div>
      <SectionHead
        title="Appearance"
        sub="Choose how egant looks. These settings stay on this device."
      />

      <div className="mb-4 text-[13px] font-semibold text-[var(--ink)]">Appearance</div>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <ModeCard
          label="System"
          active={appearance.mode === "system"}
          onClick={() => setAppearance({ mode: "system" })}
        >
          <div className="flex h-full">
            <div className="flex w-1/2 gap-1 bg-[#f2f2f5] p-2">
              <div className="flex w-[26px] shrink-0 flex-col gap-1">
                <Bar dark={false} w="70%" />
                <Bar dark={false} w="90%" />
                <Bar dark={false} w="60%" />
                <Bar dark={false} w="80%" />
              </div>
              <div className="flex flex-1 flex-col gap-1 rounded border border-black/10 bg-white p-1">
                <Bar dark={false} w="55%" />
                <Bar dark={false} w="80%" />
                <Bar dark={false} w="65%" />
                <Bar dark={false} w="40%" />
              </div>
            </div>
            <div className="flex w-1/2 gap-1 bg-[#101014] p-2">
              <div className="flex w-[26px] shrink-0 flex-col gap-1">
                <Bar dark w="70%" />
                <Bar dark w="90%" />
                <Bar dark w="60%" />
              </div>
              <div className="flex flex-1 flex-col gap-1 rounded border border-white/10 bg-black/40 p-1">
                <Bar dark w="80%" />
                <Bar dark w="60%" />
                <Bar dark w="70%" />
              </div>
            </div>
          </div>
        </ModeCard>
        <ModeCard
          label="Light"
          active={appearance.mode === "light"}
          onClick={() => setAppearance({ mode: "light" })}
        >
          <div className="flex h-full gap-1.5 bg-[#f2f2f5] p-2">
            <div className="flex w-[52px] shrink-0 flex-col gap-1">
              <Bar dark={false} w="70%" />
              <Bar dark={false} w="90%" />
              <Bar dark={false} w="60%" />
            </div>
            <div className="flex flex-1 flex-col gap-1.5 rounded border border-black/10 bg-white p-1.5">
              <Bar dark={false} w="60%" />
              <Bar dark={false} w="90%" />
              <Bar dark={false} w="75%" />
              <Bar dark={false} w="50%" />
            </div>
          </div>
        </ModeCard>
        <ModeCard
          label="Dark"
          active={appearance.mode === "dark"}
          onClick={() => setAppearance({ mode: "dark" })}
        >
          <div className="flex h-full gap-1.5 bg-[#0b0b0e] p-2">
            <div className="flex w-[52px] shrink-0 flex-col gap-1">
              <Bar dark w="70%" />
              <Bar dark w="90%" />
              <Bar dark w="60%" />
            </div>
            <div className="flex flex-1 flex-col gap-1.5 rounded border border-white/10 bg-black/50 p-1.5">
              <Bar dark w="85%" />
              <Bar dark w="95%" />
              <Bar dark w="70%" />
              <Bar dark w="55%" />
            </div>
          </div>
        </ModeCard>
      </div>

      <Card>
        <Row
          icon={SlidersHorizontal}
          title="Light theme"
          sub="Used whenever this appearance is active."
          control={
            <ThemeSelect
              value={appearance.lightTheme}
              options={LIGHT_THEMES}
              onChange={(lightTheme) => setAppearance({ lightTheme })}
            />
          }
        />
        <Row
          icon={SlidersHorizontal}
          title="Dark theme"
          sub="Used whenever this appearance is active."
          control={
            <ThemeSelect
              value={appearance.darkTheme}
              options={DARK_THEMES}
              onChange={(darkTheme) => setAppearance({ darkTheme })}
            />
          }
        />
        <Row
          icon={SlidersHorizontal}
          title="Accent color"
          sub="Theme default - Uses the palette's intended color."
          control={
            <div className="flex max-w-[260px] flex-wrap items-start justify-end gap-2">
              {ACCENTS.map((a) =>
                a.value === "default" ? (
                  <button
                    key={a.value}
                    type="button"
                    title={a.label}
                    onClick={() => setAppearance({ accent: "default" })}
                    className="cursor-pointer"
                  >
                    <span
                      className={`flex h-6 w-6 items-end justify-center gap-[2.5px] rounded-md border pb-1 ${
                        appearance.accent === "default"
                          ? "border-[var(--accent)]"
                          : "border-[var(--border)] hover:bg-[var(--hover)]"
                      }`}
                    >
                      <span className="w-[3px] rounded-full bg-[var(--muted)]" style={{ height: 8 }} />
                      <span className="w-[3px] rounded-full bg-[var(--muted)]" style={{ height: 13 }} />
                      <span className="w-[3px] rounded-full bg-[var(--muted)]" style={{ height: 6 }} />
                      <span className="w-[3px] rounded-full bg-[var(--muted)]" style={{ height: 11 }} />
                    </span>
                    <span
                      className={`mt-1 block h-[2px] rounded-full ${
                        appearance.accent === "default" ? "bg-[var(--accent)]" : "bg-transparent"
                      }`}
                    />
                  </button>
                ) : (
                  <button
                    key={a.value}
                    type="button"
                    title={a.label}
                    onClick={() => setAppearance({ accent: a.value })}
                    className="cursor-pointer"
                  >
                    <span
                      className="block h-6 w-6 rounded-full border border-black/30"
                      style={{ background: a.value }}
                    />
                    <span
                      className="mt-1 block h-[2px] rounded-full"
                      style={{
                        background:
                          appearance.accent === a.value ? a.value : "transparent",
                      }}
                    />
                  </button>
                ),
              )}
            </div>
          }
        />
        <Row
          icon={LayoutGrid}
          title="Glass"
          sub="No Glass is a flat, solid IDE look — no blur or transparency."
          control={
            <Pills
              options={GLASS_OPTIONS}
              value={appearance.glass}
              onChange={(glass) => setAppearance({ glass })}
            />
          }
        />
        <div className="flex items-center gap-3.5 px-4 py-3.5">
          <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-[var(--border)]">
            {wallpaperUrl ? (
              <img src={wallpaperUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="block h-full w-full bg-gradient-to-br from-purple-900 via-indigo-950 to-black" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-[var(--ink)]">
              New thread composer background
            </div>
            <div className="mt-0.5 truncate text-[12px] text-[var(--muted)]">
              {wallpaperName ?? "No image chosen"}
              <Dot />
              Softened automatically on frosted themes.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {wallpaperUrl && (
              <button
                type="button"
                title="Cycle the wallpaper's dim level"
                onClick={() => void cycleDim()}
                className="cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
              >
                Dim {Math.round(wallpaperDim * 100)}%
              </button>
            )}
            <button
              type="button"
              onClick={() => void chooseWallpaper()}
              className="cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              Replace image
            </button>
            {wallpaperUrl && (
              <button
                type="button"
                onClick={() => void clearWallpaper()}
                className="cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--danger)] hover:bg-[var(--hover)]"
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <Row
          icon={SlidersHorizontal}
          title="Background effect"
          sub="Shows the original artwork."
          control={
            <Pills
              options={BG_EFFECTS}
              value={appearance.bgEffect}
              onChange={(bgEffect) => setAppearance({ bgEffect })}
            />
          }
        />
        <Row
          icon={Folder}
          title="Theme library"
          sub="Import or link custom themes."
          control={
            <button
              type="button"
              title="Custom themes aren't supported yet"
              className="shrink-0 cursor-pointer rounded-lg bg-white px-3.5 py-1.5 text-[13px] font-medium text-black hover:bg-white/85"
            >
              Add theme
            </button>
          }
        />
      </Card>
    </div>
  );
}

function ModeCard({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="cursor-pointer">
      <span
        className={`block h-[104px] overflow-hidden rounded-lg border transition-colors ${
          active ? "border-[var(--accent)]" : "border-[var(--border)]"
        }`}
      >
        {children}
      </span>
      <span
        className={`mt-2 block text-center text-[12px] ${
          active ? "font-medium text-[var(--accent)]" : "text-[var(--muted)]"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

function Bar({ dark, w }: { dark?: boolean; w: string }) {
  return (
    <span
      className={`h-1 rounded-full ${dark ? "bg-white/20" : "bg-black/15"}`}
      style={{ width: w }}
    />
  );
}

/** The theme picker seen in Appearance > Light/Dark theme: a swatch-and-label
 * button that opens a scrollable popover of every palette, checkmarking the
 * active one — same anchored-menu pattern as `ProjectMenu`. Picking a row
 * calls `onChange`, which flows into `setAppearance` and — via
 * `applyAppearance` — repaints `data-palette` on `<html>` immediately, so the
 * whole window re-skins on click rather than just recording a preference. */
function ThemeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; swatch: [string, string] }[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  const toggle = () => {
    if (!open) {
      setOpenUpward(shouldOpenUpward(rootRef, Math.min(360, window.innerHeight * 0.6)));
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-label={current?.label ?? "Theme"}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pr-2.5 pl-2.5 text-[13px] text-[var(--ink)] outline-none hover:bg-[var(--hover)]"
      >
        <ThemeSwatch colors={current.swatch} />
        <span className="max-w-[150px] truncate">{current?.label}</span>
        <ArrowUpDown size={12} className="shrink-0 text-[var(--faint)]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            style={{ transformOrigin: openUpward ? "bottom right" : "top right" }}
            className={`menu absolute right-0 z-50 flex max-h-[min(360px,60vh)] w-[248px] flex-col overflow-y-auto rounded-xl p-1.5 text-xs ${
              openUpward ? "menu-pop-up bottom-full mb-1.5" : "menu-pop top-full mt-1.5"
            }`}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                className={`flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
                  o.value === value ? "bg-[var(--selected)] text-[var(--ink)]" : "text-[var(--muted)]"
                }`}
              >
                <ThemeSwatch colors={o.swatch} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Check size={12} strokeWidth={2} className="shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ThemeSwatch({ colors }: { colors: [string, string] }) {
  return (
    <span className="block h-3.5 w-3.5 shrink-0 overflow-hidden rounded-[3px] border border-black/20">
      <span className="flex h-full">
        <span className="w-1/2" style={{ background: colors[0] }} />
        <span className="w-1/2" style={{ background: colors[1] }} />
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const FONT_SIZES = [
  { value: "10", label: "10 px" },
  { value: "11.5", label: "11.5 px" },
  { value: "13", label: "13 px" },
  { value: "15", label: "15 px" },
  { value: "17", label: "17 px" },
];

function FilesSection() {
  const [autosave, setAutosave] = usePersistentState("egant.files.autosave", true);
  const [fontSize, setFontSize] = usePersistentState("egant.files.fontSize", "13");
  const [wordWrap, setWordWrap] = usePersistentState("egant.files.wordWrap", true);
  const [showAll, setShowAll] = usePersistentState("egant.files.showAll", true);

  // The controls persist on their own; this tells already-open editors, diff
  // viewers and file trees to re-read them — same-window `storage` events
  // don't fire. Declared after the state above, so each hook's own
  // localStorage write has already run by the time this does.
  useEffect(() => {
    window.dispatchEvent(new Event(FILES_SETTINGS_EVENT));
  }, [autosave, fontSize, wordWrap, showAll]);

  return (
    <div>
      <SectionHead
        title="Files"
        sub="Control how workspace files are displayed and saved while you edit."
      />
      <Card>
        <Row
          icon={Folder}
          title="Autosave"
          sub="Save edited workspace files to disk automatically."
          control={<Toggle on={autosave} onChange={setAutosave} label="Autosave" />}
        />
        <div className="px-4 py-3.5">
          <div className="flex items-center gap-3.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)]">
              <SlidersHorizontal size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[var(--ink)]">
                Editor font size
              </div>
              <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                Set the text size in workspace file editors.
              </div>
            </div>
          </div>
          <div className="mt-3 ml-[50px]">
            <Pills options={FONT_SIZES} value={fontSize} onChange={setFontSize} />
          </div>
        </div>
        <Row
          icon={AlignLeft}
          title="Word wrap"
          sub="Wrap long lines in every workspace file."
          control={<Toggle on={wordWrap} onChange={setWordWrap} label="Word wrap" />}
        />
        <Row
          icon={Eye}
          title="Show all files"
          sub="Include hidden and ignored files in every file tree."
          control={<Toggle on={showAll} onChange={setShowAll} label="Show all files" />}
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Plays one event's cue so the user can hear what they are switching on. */
function PreviewButton({ kind, label }: { kind: NotifyKind; label: string }) {
  return (
    <button
      type="button"
      title={`Preview: ${label}`}
      aria-label={`Preview: ${label}`}
      onClick={() => playCue(kind)}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      <Play size={12} strokeWidth={2.25} />
    </button>
  );
}

const SOUND_THEME_LABELS: Record<ThemeName, string> = {
  default: "Default",
  mech: "Mech",
  bubble: "Bubble",
  press: "Press",
};

/** How long the test banner waits, so there is time to switch to another app:
 * egant stays quiet while it is the window in use, and macOS itself does not
 * present a banner for the app in front. */
const TEST_BANNER_DELAY_MS = 5000;

type BannerCheck = "waiting" | "sent" | "blocked";

function NotificationsSection() {
  const [sounds, setSounds] = usePersistentState(NOTIFY_KEYS.sounds, true);
  const [theme, setTheme] = usePersistentState<ThemeName>(NOTIFY_KEYS.theme, DEFAULT_SOUND_THEME);
  const [completed, setCompleted] = usePersistentState(NOTIFY_KEYS.completed, true);
  const [input, setInput] = usePersistentState(NOTIFY_KEYS.input, true);
  const [errors, setErrors] = usePersistentState(NOTIFY_KEYS.errors, true);
  const [desktop, setDesktop] = usePersistentState(NOTIFY_KEYS.desktop, true);
  const [check, setCheck] = useState<BannerCheck | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  const testBanner = () => {
    if (check === "waiting") return;
    setCheck("waiting");
    window.setTimeout(() => {
      sendBanner("egant", "Desktop notifications are working.")
        .then((sent) => setCheck(sent ? "sent" : "blocked"))
        .catch(() => setCheck("blocked"));
    }, TEST_BANNER_DELAY_MS);
  };

  const openSettings = () => {
    setSettingsError(null);
    api.openNotificationSettings().catch((error: unknown) => {
      setSettingsError(error instanceof Error ? error.message : String(error));
    });
  };

  const permissionSub =
    settingsError ??
    (check === "waiting"
      ? "egant stays quiet while it's your active window, so switch to another app. A test banner arrives in a few seconds."
      : check === "sent"
        ? `Test sent. If no banner appeared, open the settings, allow egant to send notifications, and turn off Focus or Do Not Disturb.${
            import.meta.env.DEV && isMac()
              ? " In a dev build macOS lists the banner under Terminal, not egant."
              : ""
          }`
        : check === "blocked"
          ? "The system refused the banner. Open the settings and allow notifications for egant."
          : "Banners only appear if your system allows egant to send them. Send a test, or open the settings to allow it.");

  return (
    <div>
      <SectionHead
        title="Notifications"
        sub="egant notifies you only while you're away from it, when it isn't the window you're using. Choose which events do, and whether by sound, banner, or both."
      />
      <Card>
        <Row
          icon={Volume2}
          title="Session sounds"
          sub="Play a sound for the events below while you're away. Sounds are synthesized live, so nothing is downloaded."
          control={<Toggle on={sounds} onChange={setSounds} label="Session sounds" />}
        />
        <Row
          icon={Music}
          title="Sound theme"
          sub="Default is warm and calm for all-day use. Mech is dry and precise, Bubble is playful, Press feels like a clicky switch."
          control={
            <Pills
              options={SOUND_THEMES.map((value) => ({ value, label: SOUND_THEME_LABELS[value] }))}
              value={theme}
              onChange={(next) => {
                setTheme(next);
                // Hear the choice on the spot; the saved theme catches up a
                // render later, so this one is told which material to use.
                playCue("completed", next);
              }}
            />
          }
        />
        <Row
          icon={Check}
          title="Task completed"
          sub="When an agent finishes a run."
          control={
            <div className="flex items-center gap-2">
              <PreviewButton kind="completed" label="Task completed" />
              <Toggle on={completed} onChange={setCompleted} label="Task completed" />
            </div>
          }
        />
        <Row
          icon={MessageCircle}
          title="Input required"
          sub="When an agent needs your approval or asks you a question."
          control={
            <div className="flex items-center gap-2">
              <PreviewButton kind="input" label="Input required" />
              <Toggle on={input} onChange={setInput} label="Input required" />
            </div>
          }
        />
        <Row
          icon={AlertTriangle}
          title="Errors and disconnections"
          sub="When a run fails or the agent exits unexpectedly. Stopping a run yourself stays quiet."
          control={
            <div className="flex items-center gap-2">
              <PreviewButton kind="errors" label="Errors and disconnections" />
              <Toggle on={errors} onChange={setErrors} label="Errors and disconnections" />
            </div>
          }
        />
        <Row
          icon={Bell}
          title="Desktop notifications"
          sub="Show a system banner on the same events while you're away from egant."
          control={
            <Toggle
              on={desktop}
              onChange={(next) => {
                setDesktop(next);
                // Turning banners on walks through allowing them, rather than
                // leaving the user to find out on the first missed ping.
                if (next) testBanner();
              }}
              label="Desktop notifications"
            />
          }
        />
        <Row
          icon={BellRing}
          title="System permission"
          sub={permissionSub}
          control={
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={check === "waiting"}
                onClick={testBanner}
                className="cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] whitespace-nowrap text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-50"
              >
                {check === "waiting" ? "Sending…" : "Send test"}
              </button>
              <button
                type="button"
                onClick={openSettings}
                className="cursor-pointer rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] whitespace-nowrap text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
              >
                Open settings
              </button>
            </div>
          }
        />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

function ShortcutsSection() {
  const shortcuts: [string, string][] = [
    ["New conversation", modShortcut("N")],
    ["Filter conversations", modShortcut("K")],
    ["Focus composer", modShortcut("L")],
    ["Toggle sidebar", modShortcut("B")],
    ["Open settings", modShortcut(",")],
    ["Close settings", "Esc"],
  ];
  return (
    <div>
      <SectionHead
        title="Shortcuts"
        sub="Keys that drive the window. They work wherever the window is focused."
      />
      <Card>
        {shortcuts.map(([label, keys]) => (
          <div key={label} className="flex items-center justify-between px-4 py-3">
            <span className="text-[13px] text-[var(--ink)]">{label}</span>
            <span className="rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-[12px] text-[var(--muted)]">
              {keys}
            </span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Archived sessions
// ---------------------------------------------------------------------------

/** Conversations archived from the sidebar's corner button: out of the
 * window, still on disk. Restore brings one back, selected and ready to
 * resume; Delete forgets it for good, asking first, and gives back the
 * worktree it ran in the way closing used to. */
function ArchivedSection() {
  const unarchiveSession = useEgant((s) => s.unarchiveSession);
  const deleteArchivedSession = useEgant((s) => s.deleteArchivedSession);
  const closeSettings = useEgant((s) => s.closeSettings);
  const storeError = useEgant((s) => s.error);
  const now = useNow(60_000);
  const [rows, setRows] = useState<ArchivedSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: number; message: string } | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [working, setWorking] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listArchivedSessions()
      .then((list) => {
        if (alive) setRows(list);
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(String(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  const restore = async (row: ArchivedSession) => {
    setWorking(row.id);
    setFailed(null);
    const ok = await unarchiveSession(row.id);
    setWorking(null);
    if (ok) closeSettings();
    else setFailed({ id: row.id, message: useEgant.getState().error ?? storeError ?? "Couldn't restore it." });
  };

  const remove = async (row: ArchivedSession) => {
    setWorking(row.id);
    setFailed(null);
    const ok = await deleteArchivedSession(row.id);
    setWorking(null);
    setConfirming(null);
    if (ok) setRows((prev) => (prev ?? []).filter((r) => r.id !== row.id));
    else setFailed({ id: row.id, message: useEgant.getState().error ?? "Couldn't delete it." });
  };

  return (
    <div>
      <SectionHead
        title="Archived sessions"
        count={rows && rows.length > 0 ? rows.length : undefined}
        sub="Conversations you archived from the sidebar. Restore one to carry on where it left off, or delete it for good. A worktree it ran in is kept until you do."
      />
      {rows == null ? (
        <Placeholder text={loadError ?? "Loading…"} />
      ) : rows.length === 0 ? (
        <Placeholder text="Nothing archived. Archive a conversation from its corner in the sidebar." />
      ) : (
        <Card>
          {rows.map((row) => (
            <div key={row.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-center gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)]">
                  <ProviderGlyph
                    provider={AGENT_PROVIDER[row.agent] ?? row.agent}
                    size={15}
                    color={AGENT_ACCENT[row.agent]}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-[var(--ink)]" title={row.title}>
                    {row.title}
                  </div>
                  <div className="truncate text-[12px] text-[var(--muted)]" title={row.projectPath}>
                    {row.projectName}
                    {row.branch ? ` · ${row.branch}` : ""}
                    {row.kind === "cli" ? " · CLI" : ""}
                    {` · archived ${archivedAgo(row.archivedAtMs, now)}`}
                  </div>
                </div>
                {confirming === row.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[12px] text-[var(--muted)]">Delete for good?</span>
                    <button
                      type="button"
                      disabled={working === row.id}
                      onClick={() => setConfirming(null)}
                      className="cursor-pointer rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={working === row.id}
                      onClick={() => void remove(row)}
                      className="cursor-pointer rounded-md px-2 py-1 text-[12px] font-medium text-[var(--danger)] hover:bg-[var(--hover)] disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={working === row.id}
                      onClick={() => void restore(row)}
                      className="cursor-pointer rounded-md bg-[var(--bubble)] px-2.5 py-1 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:opacity-50"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      disabled={working === row.id}
                      onClick={() => setConfirming(row.id)}
                      className="cursor-pointer rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--danger)]"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
              {failed?.id === row.id && (
                <div className="pl-[50px] text-[12px] text-[var(--danger)]">{failed.message}</div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/** `just now`, `5m ago`, `2d ago` — when a session went to the archive. */
function archivedAgo(atMs: number, nowMs: number): string {
  const age = ageLabel(atMs, nowMs);
  return age === "now" ? "just now" : `${age} ago`;
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-[40vh] items-center justify-center text-[13px] text-[var(--faint)]">
      {text}
    </div>
  );
}
