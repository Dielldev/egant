import {
  AlertCircle,
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Loader2,
  Plug,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { AGENT_PROVIDER } from "../lib/agents";
import { ProviderGlyph } from "./ProviderLogo";
import { useEgant } from "../store";

interface AgentActionState {
  installing: boolean;
  connecting: boolean;
  note: string | null;
  error: string | null;
}

const CONNECT_HINTS: Record<string, string> = {
  claude: "Check your browser — a Claude Code sign-in tab should have opened.",
  codex: "Check your browser — a Codex sign-in tab should have opened.",
  opencode: "Terminal opened with the provider picker. Follow its prompt to select your provider or enter your API key.",
  antigravity: "Terminal opened — follow its prompts to sign in with your Google account.",
};

const AGENT_DEFS = [
  {
    id: "opencode",
    name: "OpenCode",
    provider: "opencode",
    recommended: true,
    badges: ["Recommended", "All Providers", "Free Tier"],
    headline: "Universal Multi-Provider & Free Models",
    description:
      "Run any model provider — OpenAI, Anthropic Claude, Google Gemini, Ollama (local), Groq, Mistral, DeepSeek, OpenRouter — or use OpenCode Zen free models with zero setup.",
  },
  {
    id: "claude",
    name: "Claude Code",
    provider: "claude",
    recommended: false,
    badges: ["Anthropic", "Claude 3.7 / 3.5 Sonnet"],
    headline: "Anthropic's Official Agent",
    description:
      "Direct Anthropic CLI for Claude 3.7 Sonnet, Claude 3.5 Sonnet, and Opus with tool execution.",
  },
  {
    id: "codex",
    name: "Codex",
    provider: "codex",
    recommended: false,
    badges: ["OpenAI", "GPT-4o & o1"],
    headline: "OpenAI's Agent",
    description:
      "OpenAI's official CLI supporting GPT-4o, o1, o3-mini, and full coding tools.",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    provider: "antigravity",
    recommended: false,
    badges: ["Google DeepMind", "Gemini 2.5"],
    headline: "Google DeepMind's Agent",
    description:
      "Google's CLI agent with advanced reasoning and large Gemini context windows.",
  },
] as const;

export function ConnectModelsDialog() {
  const open = useEgant((s) => s.connectModelsOpen);
  const target = useEgant((s) => s.connectModelsTarget);
  const close = useEgant((s) => s.closeConnectModels);
  const agents = useEgant((s) => s.agents);
  const composerAgent = useEgant((s) => s.composerAgent);
  const setComposerAgent = useEgant((s) => s.setComposerAgent);
  const setAgentEnabled = useEgant((s) => s.setAgentEnabled);
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const fetchCatalog = useEgant((s) => s.fetchCatalog);
  const refresh = useEgant((s) => s.refresh);
  const openSettings = useEgant((s) => s.openSettings);

  const [states, setStates] = useState<Record<string, AgentActionState>>({});
  const pollToken = useRef(0);

  // Keyboard navigation & escape listener
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Periodic poll of login state when modal is open and something is connecting
  useEffect(() => {
    if (!open) return;
    void fetchAgents();
    void fetchCatalog();
  }, [open, fetchAgents, fetchCatalog]);

  const updateState = (id: string, patch: Partial<AgentActionState>) => {
    setStates((prev) => {
      const current = prev[id] ?? {
        installing: false,
        connecting: false,
        note: null,
        error: null,
      };
      return {
        ...prev,
        [id]: {
          ...current,
          ...patch,
        },
      };
    });
  };

  const handleInstall = async (id: string, name: string) => {
    updateState(id, { installing: true, note: `Installing ${name}…`, error: null });
    try {
      const outcome = await api.installAgent(id);
      if (!outcome.success) {
        updateState(id, {
          installing: false,
          error: `Install failed: ${outcome.output || "Unknown error"}`,
          note: null,
        });
        return;
      }
      await fetchCatalog();
      await fetchAgents();
      // Auto-select the newly installed agent as active
      setAgentEnabled(id, true);
      setComposerAgent(id);
      void api.setDefaultAgent(id);
      await refresh();

      updateState(id, {
        installing: false,
        note: `${name} installed successfully!`,
        error: null,
      });
    } catch (e) {
      updateState(id, {
        installing: false,
        error: e instanceof Error ? e.message : String(e),
        note: null,
      });
    }
  };

  const handleConnect = async (id: string) => {
    const token = ++pollToken.current;
    updateState(id, { connecting: true, note: CONNECT_HINTS[id] ?? "Connecting…", error: null });

    try {
      await api.connectAgent(id);
    } catch (e) {
      updateState(id, {
        connecting: false,
        error: e instanceof Error ? e.message : String(e),
        note: null,
      });
      return;
    }

    const deadline = Date.now() + 180_000;
    const poll = async () => {
      if (pollToken.current !== token) return;
      let status = null;
      try {
        status = await api.checkAgentLogin(id);
      } catch {
        // ignore transient check failures
      }
      if (pollToken.current !== token) return;

      if (status?.connected) {
        await fetchAgents();
        setAgentEnabled(id, true);
        setComposerAgent(id);
        void api.setDefaultAgent(id);
        await refresh();
        updateState(id, {
          connecting: false,
          note: "Connected successfully! Ready to chat.",
          error: null,
        });
        return;
      }

      if (Date.now() < deadline) {
        setTimeout(() => void poll(), 2000);
      } else {
        updateState(id, {
          connecting: false,
          note: null,
          error: "Connection timed out. Complete sign-in, then hit Refresh in Settings.",
        });
      }
    };

    setTimeout(() => void poll(), 2000);
  };

  const handleSelectAgent = async (id: string) => {
    setAgentEnabled(id, true);
    setComposerAgent(id);
    try {
      await api.setDefaultAgent(id);
      await refresh();
    } catch {
      // keep composer choice in-memory
    }
    close();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/60 pt-[8vh] pb-12 backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="menu-pop relative w-full max-w-[680px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--stage)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--border)] px-6 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)]/15 text-[var(--accent)]">
              <Plug size={20} strokeWidth={2.2} />
            </span>
            <div>
              <h2 className="text-[17px] font-semibold text-[var(--ink)]">Connect Models</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted)]">
                Connect an AI agent to run in egant. OpenCode supports any provider (OpenAI,
                Anthropic, Gemini, Groq, Ollama, OpenRouter) or free models out of the box.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="cursor-pointer rounded-lg p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)] transition-colors"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Providers list */}
        <div className="flex flex-col gap-3.5 p-6">
          {AGENT_DEFS.map((agent) => {
            const status = agents.find((a) => a.id === agent.id);
            const isInstalled = status?.installed ?? false;
            const isConnected = status?.connected ?? false;
            const isCurrent = (composerAgent ?? "claude") === agent.id;
            const state = states[agent.id] ?? {
              installing: false,
              connecting: false,
              note: null,
              error: null,
            };

            const isHighlighted = target === agent.id;

            return (
              <div
                key={agent.id}
                className={`relative rounded-xl border p-4.5 transition-all ${
                  isHighlighted
                    ? "border-[var(--accent)] bg-[var(--accent)]/5 shadow-md"
                    : agent.recommended
                      ? "border-[var(--accent)]/30 bg-[var(--card)] hover:border-[var(--accent)]/50"
                      : "border-[var(--border)] bg-[var(--card)] hover:border-[var(--border)]/80"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--bubble)] p-2">
                      <ProviderGlyph
                        provider={AGENT_PROVIDER[agent.id] ?? agent.provider}
                        size={22}
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-semibold text-[var(--ink)]">
                          {agent.name}
                        </span>
                        {agent.badges.map((b) => (
                          <span
                            key={b}
                            className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ${
                              b === "Recommended"
                                ? "bg-[var(--accent)]/20 text-[var(--accent)]"
                                : "bg-[var(--bubble)] text-[var(--muted)]"
                            }`}
                          >
                            {b}
                          </span>
                        ))}
                      </div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted)]">
                        {agent.description}
                      </p>
                    </div>
                  </div>

                  {/* Status Indicator */}
                  <div className="shrink-0 text-right">
                    {isConnected ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-medium text-[var(--muted)]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--muted)]" />
                        {status?.email ?? (agent.id === "opencode" ? "Ready (Free & Auth)" : "Connected")}
                      </span>
                    ) : isInstalled ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[11px] font-medium text-[var(--faint)]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--faint)]" />
                        Installed · Not signed in
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bubble)] px-2.5 py-1 text-[11px] font-medium text-[var(--faint)]">
                        Not installed
                      </span>
                    )}
                  </div>
                </div>

                {/* Status or error message */}
                {state.note && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-3 py-2 text-[12px] text-[var(--ink)]">
                    <Sparkles size={14} className="shrink-0 text-[var(--accent)]" />
                    <span>{state.note}</span>
                  </div>
                )}
                {state.error && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--hover)] px-3 py-2 text-[12px] text-[var(--ink)]">
                    <AlertCircle size={14} className="shrink-0 text-[var(--muted)]" />
                    <span>{state.error}</span>
                  </div>
                )}

                {/* Actions */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-3.5">
                  <div className="text-[12px] text-[var(--faint)]">
                    {agent.id === "opencode" ? (
                      <span>Runs OpenCode Zen free models or connect any API key</span>
                    ) : (
                      <span>Requires {agent.name} CLI & account</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {!isInstalled ? (
                      <button
                        type="button"
                        disabled={state.installing}
                        onClick={() => void handleInstall(agent.id, agent.name)}
                        className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white shadow hover:opacity-90 disabled:opacity-50 transition-opacity"
                      >
                        {state.installing ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Download size={13} strokeWidth={2} />
                        )}
                        {state.installing ? "Installing…" : `Install ${agent.name}`}
                      </button>
                    ) : (
                      <>
                        {agent.id === "opencode" && (
                          <button
                            type="button"
                            disabled={state.connecting}
                            onClick={() => void handleConnect(agent.id)}
                            title="Opens a Terminal window to choose provider (Anthropic, OpenAI, Gemini, Ollama, Groq...)"
                            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bubble)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--hover)] transition-colors"
                          >
                            <Terminal size={13} strokeWidth={2} />
                            {state.connecting ? "Opening Terminal…" : "Connect Provider (Auth)"}
                          </button>
                        )}

                        {agent.id !== "opencode" && !isConnected && (
                          <button
                            type="button"
                            disabled={state.connecting}
                            onClick={() => void handleConnect(agent.id)}
                            className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--bubble)] px-3 py-1.5 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--hover)] transition-colors"
                          >
                            {state.connecting ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : (
                              <Plug size={13} strokeWidth={2} />
                            )}
                            {state.connecting ? "Connecting…" : "Sign In"}
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => void handleSelectAgent(agent.id)}
                          className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all ${
                            isCurrent
                              ? "border border-[var(--border)] bg-[var(--selected)] text-[var(--ink)]"
                              : "bg-[var(--selected)] text-[var(--ink)] hover:opacity-90"
                          }`}
                        >
                          {isCurrent ? (
                            <>
                              <Check size={13} strokeWidth={2.5} />
                              Active Agent
                            </>
                          ) : (
                            <>
                              Use {agent.name}
                              <ArrowRight size={13} strokeWidth={2} />
                            </>
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer info about custom providers & Ollama */}
        <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--card)] px-6 py-3.5 text-[12px] text-[var(--muted)]">
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--ink)]">Custom & Local Providers:</span>
            <span>Use Ollama, DeepSeek, Groq, Mistral, or OpenRouter via OpenCode.</span>
          </div>
          <button
            type="button"
            onClick={() => {
              close();
              openSettings("accounts");
            }}
            className="flex cursor-pointer items-center gap-1 text-[var(--faint)] hover:text-[var(--ink)] transition-colors"
          >
            All Accounts & Keys
            <ExternalLink size={12} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
