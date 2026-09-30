import { ChevronDown, Folder, FolderGit2, GitBranch, Monitor, Shield, ShieldOff } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { modeLabel } from "@egant/lib/transcript";
import { chosenCheckout, useCheckouts } from "../checkouts";
import { useHero } from "../hero";
import { usePrefs } from "../prefs";
import { pickAgent, pickProject, useMobile } from "../store";
import { Mark } from "./bits";
import { CheckoutSheet, checkoutName } from "./CheckoutSheet";
import { Composer } from "./Composer";
import { ConnectionBanner } from "./ConnectionBanner";
import { IconButton, MenuIcon, ModelTitle, TopBar } from "./Header";
import { ModeSheet, ModelSheet, ProjectIcon, ProjectSheet, modelName } from "./Pickers";

function greeting(now: Date): string {
  const hour = now.getHours();
  const part = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  return `How can I help you this ${part}?`;
}

/** The line, a word at a time: each rises out of a blur just after the one
 * before it. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(" ").map((word, index) => (
        <Fragment key={`${index}-${word}`}>
          {index > 0 && " "}
          <span className="word-in inline-block" style={{ animationDelay: `${180 + index * 70}ms` }}>
            {word}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** A new chat: the picture chosen in Settings across the top 40% of the
 * screen, dissolving into the page; the greeting where it ends; and a glass
 * composer at the bottom, with the agent and model up top and what rides
 * along tucked behind its +. */
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
  const heroEnabled = usePrefs((s) => s.heroEnabled);
  const image = useHero((s) => s.image);
  const hero = heroEnabled && image ? image : null;

  const [text, setText] = useState(homeDraft);
  const [sheet, setSheet] = useState<"model" | "mode" | "project" | "checkout" | null>(null);

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

  // Where the chat will run: read from git on the Mac now, and again with a
  // fetch behind it so "behind" is current.
  const projectId = project?.id ?? null;
  const loadCheckouts = useCheckouts((s) => s.load);
  const checkoutList = useCheckouts((s) => (projectId != null ? s.byProject[projectId] : undefined));
  usePrefs((s) => s.checkouts);
  useEffect(() => {
    if (projectId == null) return;
    void loadCheckouts(projectId).then(() => loadCheckouts(projectId, { fetch: true }));
  }, [projectId, loadCheckouts]);
  const checkout = projectId != null && checkoutList?.isRepo ? chosenCheckout(projectId, checkoutList) : null;

  const send = () => {
    const message = text;
    setText("");
    void startChat(message);
  };

  const title = project ? greeting(new Date()) : `Open a project in egant on ${machine || "your Mac"} to start.`;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Behind everything: the picture (or, without one, a soft glow), faded
          into the page from its lower half. */}
      <div className="hero pointer-events-none absolute inset-x-0 top-0 h-[40%]" aria-hidden>
        {hero ? (
          <>
            <img src={hero} alt="" className="hero-image h-full w-full object-cover" />
            <div className="absolute inset-x-0 top-0 h-[38%] bg-gradient-to-b from-black/45 to-transparent" />
          </>
        ) : (
          <div className="hero-glow h-full w-full" />
        )}
      </div>

      <div className={hero ? "on-hero" : ""}>
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
      </div>
      <ConnectionBanner />

      {/* The greeting sits where the picture ends. */}
      <div className="absolute inset-x-0 z-10 flex flex-col items-center px-6 text-center" style={{ top: "calc(40% - 18px)" }}>
        {!hero && <Mark height={30} className="fade-up mb-5 text-[var(--ink)]" />}
        <h1 className="greeting max-w-[340px] text-[34px] leading-[38px] font-semibold text-[var(--ink)]">
          <Words text={title} />
        </h1>
        {project && (
          <div className="fade-up mt-4 flex max-w-full flex-wrap justify-center gap-2" style={{ animationDelay: "520ms" }}>
            <button
              type="button"
              onClick={() => setSheet("project")}
              className="press flex h-8 items-center gap-2 rounded-full bg-[var(--bubble)] pr-2.5 pl-2.5 text-[14px] font-medium text-[var(--muted)]"
            >
              <ProjectIcon size={15} />
              <span className="max-w-[160px] truncate">{project.name}</span>
              <ChevronDown size={14} strokeWidth={2.4} className="text-[var(--faint)]" />
            </button>
            {checkout && (
              <button
                type="button"
                onClick={() => setSheet("checkout")}
                className="press flex h-8 items-center gap-2 rounded-full bg-[var(--bubble)] pr-2.5 pl-2.5 text-[14px] font-medium text-[var(--muted)]"
              >
                {checkout.kind === "project" ? (
                  <GitBranch size={15} strokeWidth={1.9} />
                ) : (
                  <FolderGit2 size={15} strokeWidth={1.9} />
                )}
                <span className="max-w-[140px] truncate">
                  {checkout.kind === "project" ? (checkout.branch ?? "detached") : checkoutName(checkout)}
                </span>
                {!!checkout.behind && (
                  <span className="text-amber-600 tabular-nums dark:text-amber-300">↓{checkout.behind}</span>
                )}
                <ChevronDown size={14} strokeWidth={2.4} className="text-[var(--faint)]" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="relative z-20 mt-auto flex min-h-0 flex-col">
        <div className="safe-bottom rise-in shrink-0 px-2.5" style={{ animationDelay: "240ms" }}>
          <Composer
            value={text}
            onChange={setText}
            onSubmit={send}
            placeholder="Ask anything"
            disabled={!project}
            menu={
              project
                ? [
                    {
                      key: "project",
                      icon: <ProjectIcon size={18} />,
                      label: "Project",
                      value: project.name,
                      onClick: () => setSheet("project"),
                    },
                    ...(checkout
                      ? [
                          {
                            key: "checkout",
                            icon:
                              checkout.kind === "project" ? (
                                <Folder size={18} strokeWidth={2} />
                              ) : (
                                <FolderGit2 size={18} strokeWidth={2} />
                              ),
                            label: "Work in",
                            value: `${checkoutName(checkout)}${checkout.behind ? ` ↓${checkout.behind}` : ""}`,
                            tone: checkout.behind ? ("warn" as const) : undefined,
                            onClick: () => setSheet("checkout"),
                          },
                        ]
                      : []),
                    {
                      key: "mode",
                      icon:
                        mode === "bypassPermissions" ? (
                          <ShieldOff size={18} strokeWidth={2} />
                        ) : (
                          <Shield size={18} strokeWidth={2} />
                        ),
                      label: "Permissions",
                      value: modeLabel(mode),
                      tone: mode === "bypassPermissions" ? "warn" : undefined,
                      onClick: () => setSheet("mode"),
                    },
                  ]
                : undefined
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
      {project && (
        <CheckoutSheet open={sheet === "checkout"} onClose={() => setSheet(null)} projectId={project.id} />
      )}
    </div>
  );
}
