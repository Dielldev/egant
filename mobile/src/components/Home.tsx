import { Monitor, Shield, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import { modeLabel } from "@egant/lib/transcript";
import { usePrefs } from "../prefs";
import { pickAgent, pickProject, useMobile } from "../store";
import { Mark } from "./bits";
import { Composer, ToolbarChip } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { IconButton, MenuIcon, ModelTitle, TopBar } from "./Header";
import { ModeSheet, ModelSheet, ProjectDot, ProjectSheet, modelName } from "./Pickers";

function greeting(now: Date): string {
  const hour = now.getHours();
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  return `How can I help you this ${part}?`;
}

/** A new chat, the way Claude's app opens one: the mark and a line in the
 * middle of an empty screen, the composer at the bottom — with the agent and
 * model up top and where it runs riding along under the text. */
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

  const [text, setText] = useState(homeDraft);
  const [sheet, setSheet] = useState<"model" | "mode" | "project" | null>(null);

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
        clear
        left={
          <IconButton label="Chats" onClick={onMenu} badge={needsYou}>
            <MenuIcon />
          </IconButton>
        }
        center={
          <ModelTitle
            agent={agent}
            model={model}
            variant={prefVariants[agent]}
            onClick={() => setSheet("model")}
          />
        }
        right={
          <IconButton label="Settings" onClick={openSettings}>
            <span className="relative">
              <Monitor size={20} strokeWidth={2} />
              <span
                className={`absolute -right-1 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-[var(--stage)] ${
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

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-[8vh] text-center">
          <Mark height={34} className="fade-up text-[var(--ink)]" />
          <h1
            className="fade-up mt-6 max-w-[320px] text-[27px] leading-[34px] text-[var(--ink)]"
            style={{ fontFamily: 'ui-serif, "New York", Georgia, serif', animationDelay: "80ms" }}
          >
            {project ? greeting(new Date()) : `Open a project in egant on ${machine || "your Mac"} to start.`}
          </h1>
        </div>

        <div className="safe-bottom shrink-0 px-2.5">
          <Composer
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
