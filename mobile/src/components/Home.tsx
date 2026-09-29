import { Monitor, Shield, ShieldOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { modeLabel } from "@egant/lib/transcript";
import { usePrefs } from "../prefs";
import { pickAgent, pickProject, useMobile } from "../store";
import { useBackgroundSrc } from "./Backdrop";
import { Composer, ToolbarChip } from "./Composer";
import type { ComposerHandle } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { IconButton, MenuIcon, ModelTitle, TopBar } from "./Header";
import { ModeSheet, ModelSheet, ProjectDot, ProjectSheet, modelName } from "./Pickers";

/** Ways into a first message, for a coding agent rather than a chatbot. */
const SUGGESTIONS = [
  {
    title: "Explain",
    detail: "how this project fits together",
    prompt:
      "Give me a tour of this project: how it's organized, what the main pieces are, and how they fit together.",
  },
  {
    title: "Find bugs",
    detail: "in what changed recently",
    prompt:
      "Look through the most recent changes in this project and point out anything that looks like a bug.",
  },
  {
    title: "Review",
    detail: "my uncommitted changes",
    prompt: "Review my uncommitted changes the way a careful senior engineer would.",
  },
  {
    title: "Write tests",
    detail: "for the riskiest code",
    prompt: "Find the part of this project that most needs tests, and write them.",
  },
  {
    title: "Plan",
    detail: "a new feature with me",
    prompt: "Help me plan a new feature. Ask me what I want to build before you start.",
  },
];

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return "Up late?";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A new chat: the greeting over the wallpaper, a few ways in, and the
 * composer — with the agent and model up top and where it runs riding along
 * under the text, the way ChatGPT lays out its own first screen. */
export function Home({ onMenu, needsYou }: { onMenu: () => void; needsYou: boolean }) {
  const machine = useMobile((s) => s.machineName);
  const connection = useMobile((s) => s.connection);
  const projects = useMobile((s) => s.projects);
  const sessions = useMobile((s) => s.sessions);
  const defaultAgent = useMobile((s) => s.defaultAgent);
  const catalogs = useMobile((s) => s.models);
  const loadModels = useMobile((s) => s.loadModels);
  const startChat = useMobile((s) => s.startChat);
  const homeDraft = useMobile((s) => s.homeDraft);
  const openSettings = useMobile((s) => s.openSettings);
  const prefAgent = usePrefs((s) => s.agent);
  const prefModels = usePrefs((s) => s.models);
  const prefVariants = usePrefs((s) => s.variants);
  const prefProject = usePrefs((s) => s.project);
  const mode = usePrefs((s) => s.mode);
  const setPrefs = usePrefs((s) => s.set);
  const onImage = useBackgroundSrc() != null;

  const [text, setText] = useState(homeDraft);
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<"model" | "mode" | "project" | null>(null);
  const composer = useRef<ComposerHandle>(null);

  // A chat that could not start hands its message back, once.
  useEffect(() => {
    if (!homeDraft) return;
    setText(homeDraft);
    useMobile.setState({ homeDraft: "" });
  }, [homeDraft]);

  const agent = pickAgent(prefAgent, defaultAgent);
  const project = pickProject(prefProject, projects, sessions);
  useEffect(() => {
    void loadModels(agent);
  }, [agent, loadModels]);
  const model = modelName(agent, catalogs[agent], prefModels[agent] || null);

  const send = () => {
    const message = text;
    setText("");
    void startChat(message);
  };

  return (
    <div className="relative flex h-full flex-col">
      <TopBar
        clear={onImage}
        left={
          <IconButton label="Chats" clear={onImage} onClick={onMenu} badge={needsYou}>
            <MenuIcon />
          </IconButton>
        }
        center={
          <ModelTitle
            agent={agent}
            model={model}
            variant={prefVariants[agent]}
            clear={onImage}
            onClick={() => setSheet("model")}
          />
        }
        right={
          <IconButton label="Settings" clear={onImage} onClick={openSettings}>
            <span className="relative">
              <Monitor size={20} strokeWidth={2} />
              <span
                className={`absolute -right-1 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-black/30 ${
                  connection === "live"
                    ? "bg-emerald-400"
                    : connection === "connecting"
                      ? "animate-pulse bg-amber-400"
                      : "bg-[var(--danger)]"
                }`}
              />
            </span>
          </IconButton>
        }
      />
      <ConnectionBanner />

      <div
        className="relative z-10 flex min-h-0 flex-1 flex-col"
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={() => setFocused(false)}
      >
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-[6vh] text-center">
          <div className={onImage ? "on-image" : "text-[var(--ink)]"}>
            <h1 className="fade-up text-[30px] leading-9 font-semibold tracking-[-0.025em]">
              {greeting(new Date())}
            </h1>
            <p
              className={`fade-up mt-2 text-[17px] leading-6 ${onImage ? "opacity-85" : "text-[var(--muted)]"}`}
              style={{ animationDelay: "80ms" }}
            >
              {project ? (
                <>
                  What should we build in <span className="font-semibold">{project.name}</span>?
                </>
              ) : (
                <>Open a project in egant on {machine || "your Mac"} to start a chat.</>
              )}
            </p>
          </div>
        </div>

        {!focused && text.trim() === "" && project && (
          <div
            className="no-scrollbar fade-up flex gap-2 overflow-x-auto px-3 pb-2.5"
            style={{ animationDelay: "160ms" }}
          >
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion.title}
                type="button"
                onClick={() => {
                  setText(suggestion.prompt);
                  composer.current?.focus();
                }}
                className={`press flex shrink-0 flex-col items-start rounded-[18px] px-4 py-2.5 text-left ${
                  onImage ? "chip-glass" : "border border-[var(--hairline)] bg-[var(--raised)]"
                }`}
              >
                <span
                  className={`text-[14.5px] leading-5 font-semibold ${onImage ? "text-white" : "text-[var(--ink)]"}`}
                >
                  {suggestion.title}
                </span>
                <span className={`text-[13.5px] leading-5 ${onImage ? "text-white/65" : "text-[var(--muted)]"}`}>
                  {suggestion.detail}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className="safe-bottom shrink-0 px-2.5">
          <Composer
            ref={composer}
            value={text}
            onChange={setText}
            onSubmit={send}
            placeholder="Ask anything"
            disabled={!project}
            toolbar={
              <>
                {project && (
                  <ToolbarChip
                    icon={<ProjectDot hue={project.hue} size={8} />}
                    label={project.name}
                    onClick={() => setSheet("project")}
                  />
                )}
                <ToolbarChip
                  icon={
                    mode === "bypassPermissions" ? (
                      <ShieldOff size={14} strokeWidth={2} />
                    ) : (
                      <Shield size={14} strokeWidth={2} />
                    )
                  }
                  label={modeLabel(mode)}
                  tone={mode === "bypassPermissions" ? "warn" : undefined}
                  onClick={() => setSheet("mode")}
                />
              </>
            }
          />
        </div>
      </div>

      <ModelSheet open={sheet === "model"} onClose={() => setSheet(null)} />
      <ModeSheet
        open={sheet === "mode"}
        onClose={() => setSheet(null)}
        agent={agent}
        mode={mode}
        onPick={(next) => setPrefs({ mode: next })}
      />
      <ProjectSheet open={sheet === "project"} onClose={() => setSheet(null)} />
    </div>
  );
}
