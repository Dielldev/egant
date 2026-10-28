import {
  AlertTriangle,
  Check,
  CirclePlus,
  Copy,
  Download,
  KeyRound,
  Laptop,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { roundPercent } from "../lib/usageLimits";
import type { AgentStatus } from "../lib/types";
import { useEgant } from "../store";
import { ProviderGlyph } from "./ProviderLogo";

/** Polling interval and timeout while waiting for an external CLI auth flow */
const CONNECT_POLL_MS = 2_500;
const CONNECT_TIMEOUT_MS = 120_000;

const CONNECT_HINTS: Record<string, string> = {
  claude: "Check your browser — a Claude Code sign-in tab has opened.",
  codex: "Check your browser — a Codex sign-in tab has opened.",
  opencode: "Check the Terminal window that opened and follow the provider picker.",
  antigravity: "Check the Terminal window that opened to sign in with Google.",
  cursor: "Run `cursor-agent login` in your terminal to authenticate Cursor.",
};

const PROVIDER_METADATA: Record<
  string,
  {
    description: string;
    defaultPlan: string;
  }
> = {
  claude: {
    description: "Anthropic Claude Code CLI with Opus & Sonnet reasoning.",
    defaultPlan: "Claude Pro",
  },
  codex: {
    description: "OpenAI Codex CLI connected via ChatGPT credentials.",
    defaultPlan: "ChatGPT Free",
  },
  opencode: {
    description: "Multi-provider open-source CLI with free community models.",
    defaultPlan: "Community Tier",
  },
  antigravity: {
    description: "Google Antigravity CLI engine with Gemini 2.5 / 3.0 models.",
    defaultPlan: "Google Account",
  },
  cursor: {
    description: "Cursor Agent CLI for local project edits and execution.",
    defaultPlan: "Cursor Account",
  },
};

export function AccountsSection() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "Local device");
  const agents = useEgant((s) => s.agents);
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const verifyAgents = useEgant((s) => s.verifyAgents);
  const refresh = useEgant((s) => s.refresh);
  const claudeUsage = useEgant((s) => s.claudeUsage);
  const fetchClaudeUsage = useEgant((s) => s.fetchClaudeUsage);
  const opencodeUsage = useEgant((s) => s.opencodeUsage);
  const fetchOpencodeUsage = useEgant((s) => s.fetchOpencodeUsage);

  const [spinning, setSpinning] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  useEffect(() => {
    void verifyAgents();
    void fetchClaudeUsage();
    void fetchOpencodeUsage();
  }, [verifyAgents, fetchClaudeUsage, fetchOpencodeUsage]);

  const statusOf = (id: string) => agents.find((a) => a.id === id);

  const refreshAll = async () => {
    setSpinning(true);
    const ids = ["claude", "codex", "opencode", "antigravity", "cursor"];
    try {
      await Promise.all([
        refresh(),
        fetchAgents(),
        fetchClaudeUsage(),
        fetchOpencodeUsage(),
        ...ids.map((id) => api.checkAgentLogin(id).catch(() => null)),
      ]);
      await fetchAgents();
      setLastRefreshed(new Date());
    } finally {
      setSpinning(false);
    }
  };

  const claudeStatus = statusOf("claude");
  const codexStatus = statusOf("codex");
  const antigravityStatus = statusOf("antigravity");
  const opencodeStatus = statusOf("opencode");
  const cursorStatus = statusOf("cursor");

  const connectedList = [claudeStatus, codexStatus, opencodeStatus, antigravityStatus, cursorStatus].filter(
    (a) => a?.connected,
  );
  const connectedCount = connectedList.length;

  const primaryName =
    claudeStatus?.accountName ??
    codexStatus?.accountName ??
    "Diell Govori";

  const primaryEmail =
    claudeStatus?.email ??
    codexStatus?.email ??
    antigravityStatus?.email ??
    "diellgovori9@gmail.com";

  return (
    <div className="space-y-6 pb-12">
      {/* Hero Developer Profile Banner (Monochrome Glass) */}
      <DeveloperHeroCard
        name={primaryName}
        email={primaryEmail}
        machine={machine}
        connectedCount={connectedCount}
        spinning={spinning}
        lastRefreshed={lastRefreshed}
        onRefresh={refreshAll}
      />

      {/* Main Section Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] pt-2 pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-[var(--ink)]">
            <KeyRound size={17} className="text-white" />
            AI Engine Logins
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
              {connectedCount} of 5 active
            </span>
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--muted)]">
            Active CLI sessions on this machine. Authentications are stored locally in your system Keychain and agent configs.
          </p>
        </div>

        <button
          type="button"
          onClick={refreshAll}
          disabled={spinning}
          className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--hover)] hover:text-white disabled:opacity-50"
        >
          <RefreshCw size={13} className={spinning ? "animate-spin text-white" : ""} />
          <span>{spinning ? "Verifying…" : "Re-check All"}</span>
        </button>
      </div>

      {/* Grid of Agent Account Cards */}
      <div className="grid grid-cols-1 gap-4">
        {/* Claude Code */}
        <AgentAccountCard
          id="claude"
          name="Claude Code"
          status={claudeStatus}
          meta={PROVIDER_METADATA.claude}
          usageMetric={
            claudeUsage?.fiveHour ? (
              <div className="mt-3 flex flex-col gap-1.5 rounded-lg border border-white/10 bg-black/30 p-2.5">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[var(--muted)]">5-hour usage limit</span>
                  <span className="font-semibold text-white">
                    {roundPercent(claudeUsage.fiveHour)}% used
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-white transition-all duration-300"
                    style={{
                      width: `${roundPercent(claudeUsage.fiveHour)}%`,
                    }}
                  />
                </div>
              </div>
            ) : null
          }
          subtitleOverride={
            claudeUsage?.fiveHour
              ? `${roundPercent(claudeUsage.fiveHour)}% used (5-hour limit)`
              : undefined
          }
          onSuccess={refreshAll}
        />

        {/* Codex */}
        <AgentAccountCard
          id="codex"
          name="Codex"
          status={codexStatus}
          meta={PROVIDER_METADATA.codex}
          detailsBadge="Google OAuth2 Session"
          onSuccess={refreshAll}
        />

        {/* Antigravity */}
        <AgentAccountCard
          id="antigravity"
          name="Antigravity"
          status={antigravityStatus}
          meta={PROVIDER_METADATA.antigravity}
          detailsBadge="Google Cloud Token Active"
          onSuccess={refreshAll}
        />

        {/* OpenCode */}
        <AgentAccountCard
          id="opencode"
          name="OpenCode"
          status={opencodeStatus}
          meta={PROVIDER_METADATA.opencode}
          usageMetric={
            opencodeUsage ? (
              <div className="mt-3 flex items-center gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-[var(--muted)]">
                <span className="flex items-center gap-1.5">
                  <Terminal size={12} className="text-white" />
                  <strong className="text-white">{opencodeUsage.totalSessions}</strong> sessions
                </span>
                <span>•</span>
                <span>
                  <strong className="text-white">
                    {opencodeUsage.totalMessages.toLocaleString()}
                  </strong>{" "}
                  messages
                </span>
                <span>•</span>
                <span className="text-white/80">Community Free Tier</span>
              </div>
            ) : null
          }
          onSuccess={refreshAll}
        />

        {/* Cursor */}
        <AgentAccountCard
          id="cursor"
          name="Cursor"
          status={cursorStatus}
          meta={PROVIDER_METADATA.cursor}
          emptyText="Cursor isn't connected on this device — cursor-agent sign-in isn't wired up yet."
          onSuccess={refreshAll}
        />
      </div>

      {/* Security and Credentials Note */}
      <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-[12px] leading-relaxed text-[var(--muted)]">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-white" />
        <div>
          <div className="font-semibold text-white">Secure Local Authentication</div>
          <p className="mt-1">
            All AI agent credentials reside solely on your local machine within system Keychain entries and CLI configuration files.
            Egant communicates directly with installed CLIs on this device and never transmits or stores authentication tokens externally.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Developer Hero Card (Top Profile Banner - Monochrome)
// ---------------------------------------------------------------------------

function DeveloperHeroCard({
  name,
  email,
  machine,
  connectedCount,
  spinning,
  lastRefreshed,
  onRefresh,
}: {
  name: string;
  email: string;
  machine: string;
  connectedCount: number;
  spinning: boolean;
  lastRefreshed: Date;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyEmail = () => {
    void navigator.clipboard.writeText(email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const initial = (name?.trim()?.[0] ?? email?.trim()?.[0] ?? "D").toUpperCase();

  return (
    <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] p-5 shadow-sm backdrop-blur-sm">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        {/* User Profile Info */}
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-[20px] font-semibold text-white shadow-inner">
            {initial}
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[17px] font-bold text-white tracking-tight">
                {name}
              </h1>
              <span className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-white/90">
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
                Active on device
              </span>
            </div>

            {/* Email with copy button */}
            <div className="mt-1 flex items-center gap-2 text-[13px] text-[var(--muted)]">
              <span className="truncate">{email}</span>
              <button
                type="button"
                onClick={copyEmail}
                title="Copy email"
                className="cursor-pointer text-[var(--faint)] transition-colors hover:text-white"
              >
                {copied ? <Check size={13} className="text-white" /> : <Copy size={13} />}
              </button>
            </div>

            {/* Machine & Hardware Info */}
            <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[12px] text-[var(--faint)]">
              <span className="flex items-center gap-1.5 text-white/80">
                <Laptop size={13} className="text-[var(--muted)]" />
                {machine}
              </span>
              <span>•</span>
              <span className="text-white/80">{connectedCount} Active AI Engines</span>
              <span>•</span>
              <span>
                Verified {lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
          <button
            type="button"
            onClick={onRefresh}
            disabled={spinning}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3.5 py-2 text-[12px] font-medium text-white transition-all hover:bg-white/10 hover:border-white/20 active:scale-[0.98] disabled:opacity-50"
          >
            <RefreshCw size={13} className={spinning ? "animate-spin text-white" : ""} />
            <span>{spinning ? "Verifying…" : "Sync Accounts"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account Card for Each AI Provider (Monochrome Studio)
// ---------------------------------------------------------------------------

function AgentAccountCard({
  id,
  name,
  status,
  meta,
  usageMetric,
  detailsBadge,
  subtitleOverride,
  emptyText,
  onSuccess,
}: {
  id: string;
  name: string;
  status?: AgentStatus;
  meta: { description: string; defaultPlan: string };
  usageMetric?: ReactNode;
  detailsBadge?: string;
  subtitleOverride?: string;
  emptyText?: string;
  onSuccess: () => void;
}) {
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const fetchCatalog = useEgant((s) => s.fetchCatalog);

  const [connecting, setConnecting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pollToken = useRef(0);

  useEffect(() => () => {
    pollToken.current += 1;
  }, []);

  const isInstalled = status?.installed ?? false;
  const isConnected = status?.connected ?? false;

  const onInstall = async () => {
    setInstalling(true);
    setNote(`Installing ${name} CLI…`);
    try {
      const outcome = await api.installAgent(id);
      if (!outcome.success) {
        setNote(`Installation failed: ${outcome.output || "Unknown error"}`);
        return;
      }
      setNote(`${name} installed successfully!`);
      await fetchCatalog();
      await fetchAgents();
      onSuccess();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(false);
    }
  };

  const onConnect = async () => {
    const token = ++pollToken.current;
    setNote(null);
    try {
      await api.connectAgent(id);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      return;
    }
    setConnecting(true);
    setNote(CONNECT_HINTS[id] ?? "Follow the prompts in the opened window to finish signing in.");

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    const poll = async () => {
      if (pollToken.current !== token) return;
      let fresh: AgentStatus | null = null;
      try {
        fresh = await api.checkAgentLogin(id);
      } catch {
        // Transient error
      }
      if (pollToken.current !== token) return;
      if (fresh?.connected) {
        setConnecting(false);
        setNote(null);
        await fetchAgents();
        onSuccess();
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(() => void poll(), CONNECT_POLL_MS);
      } else {
        setConnecting(false);
        setNote("Sign-in timed out. Try again or check the CLI terminal.");
      }
    };
    setTimeout(() => void poll(), CONNECT_POLL_MS);
  };

  const accountEmail = status?.email;
  const displayName = status?.accountName ?? (accountEmail ? accountEmail.split("@")[0] : `${name} User`);
  const planLabel = status?.plan ?? meta.defaultPlan;
  const letter = (displayName?.[0] ?? accountEmail?.[0] ?? name[0]).toUpperCase();

  return (
    <div className="group relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 transition-all duration-200 hover:border-white/20 hover:bg-white/[0.03]">
      <div className="flex flex-col gap-3.5">
        {/* Card Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white">
              <ProviderGlyph provider={id} size={18} />
            </div>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-semibold text-white">{name}</span>
                {isConnected ? (
                  <span className="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-white/90">
                    <span className="h-1.5 w-1.5 rounded-full bg-white" />
                    Active
                  </span>
                ) : isInstalled ? (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                    Not signed in
                  </span>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-[var(--faint)]">
                    Not installed
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--muted)]">{meta.description}</p>
            </div>
          </div>

          {/* Action button */}
          <div className="flex items-center gap-2">
            {!isInstalled ? (
              <button
                type="button"
                disabled={installing}
                onClick={() => void onInstall()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                <Download size={13} className={installing ? "animate-bounce text-white" : ""} />
                <span>{installing ? "Installing…" : `Install ${name}`}</span>
              </button>
            ) : isConnected ? (
              <button
                type="button"
                disabled={connecting}
                onClick={() => void onConnect()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[12px] text-[var(--muted)] transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                <CirclePlus size={13} className={connecting ? "animate-spin text-white" : ""} />
                <span>{connecting ? "Connecting…" : "Re-authenticate"}</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={connecting}
                onClick={() => void onConnect()}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/20 bg-white px-3 py-1.5 text-[12px] font-medium text-black shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <CirclePlus size={13} className={connecting ? "animate-spin" : ""} />
                <span>{connecting ? "Connecting…" : "Sign In"}</span>
              </button>
            )}
          </div>
        </div>

        {/* Connected Account Details View */}
        {isConnected ? (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-white/5 bg-black/20 p-3">
            <div className="flex items-center gap-3">
              {/* Clean letter monogram avatar tile */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-[13px] font-semibold text-white">
                {letter}
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold text-white">
                    {accountEmail ?? displayName}
                  </span>
                  <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/80">
                    {planLabel}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-[var(--muted)]">
                  {subtitleOverride ? (
                    <span>{subtitleOverride}</span>
                  ) : accountEmail ? (
                    <span>Logged in via official CLI credentials</span>
                  ) : (
                    <span>Ready for local turn execution</span>
                  )}
                  {detailsBadge && (
                    <>
                      <span>•</span>
                      <span className="text-white/80">{detailsBadge}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 self-start sm:self-center text-[11px] font-medium text-white/80">
              <Check size={12} strokeWidth={2.5} />
              <span>Verified</span>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-white/10 p-3 text-[12px] text-[var(--muted)]">
            {emptyText ?? `${name} isn't signed in on this device. Click Sign In to connect your account.`}
          </div>
        )}

        {/* Optional Usage Meter or Metric Details */}
        {usageMetric}

        {/* In-Flight Status Notification */}
        {note && (
          <div
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${
              connecting
                ? "border-white/20 bg-white/5 text-white"
                : "border-amber-400/30 bg-amber-400/10 text-amber-200"
            }`}
          >
            {connecting ? (
              <RefreshCw size={13} className="mt-0.5 shrink-0 animate-spin text-white" />
            ) : (
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-300" />
            )}
            <span>{note}</span>
          </div>
        )}
      </div>
    </div>
  );
}
