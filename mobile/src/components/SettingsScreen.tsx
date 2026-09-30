import {
  ChevronRight,
  FolderOpen,
  Gauge,
  ImagePlus,
  LogOut,
  Monitor,
  Plus,
  Share,
  Shield,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fallbackName, variantLabel } from "@egant/lib/agents";
import { modeLabel } from "@egant/lib/transcript";
import { clearHero, setHero, useHero } from "../hero";
import { usePrefs } from "../prefs";
import type { Scheme } from "../prefs";
import { pickAgent, pickProject, useMobile } from "../store";
import { AgentGlyph } from "./bits";
import { isIos, isStandalone } from "./InstallHint";
import { ModeSheet, ModelSheet, ProjectSheet, modelName } from "./Pickers";
import { Group, Sheet } from "./Sheet";

type SheetName = "model" | "mode" | "project" | "forget" | "install" | null;

/** This phone's settings, as a page that rises over the app: the Mac it is
 * paired with, what a new chat starts with, light or dark, and how chats
 * read. Everything but forgetting the Mac stays on the phone. */
export function SettingsScreen() {
  const close = useMobile((s) => s.closeSettings);
  const machine = useMobile((s) => s.machineName);
  const connection = useMobile((s) => s.connection);
  const device = useMobile((s) => s.device);
  const defaultAgent = useMobile((s) => s.defaultAgent);
  const projects = useMobile((s) => s.projects);
  const sessions = useMobile((s) => s.sessions);
  const catalogs = useMobile((s) => s.models);
  const loadModels = useMobile((s) => s.loadModels);
  const forget = useMobile((s) => s.forget);
  const openUsage = useMobile((s) => s.openUsage);
  const prefs = usePrefs();
  const [sheet, setSheet] = useState<SheetName>(null);

  const agent = pickAgent(prefs.agent, defaultAgent);
  useEffect(() => {
    void loadModels(agent);
  }, [agent, loadModels]);
  const project = pickProject(prefs.project, projects, sessions);
  const model = modelName(agent, catalogs[agent], prefs.models[agent] || null);
  const variant = prefs.variants[agent];

  return (
    <div className="page-in fixed inset-0 z-50 flex flex-col bg-[var(--stage)]">
      <header className="safe-top shrink-0">
        <div className="grid h-[54px] grid-cols-[52px_1fr_52px] items-center px-1">
          <button
            type="button"
            aria-label="Close settings"
            onClick={close}
            className="press ml-1 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--raised)] text-[var(--ink)]"
          >
            <X size={19} strokeWidth={2.2} />
          </button>
          <div className="text-center text-[17px] font-semibold text-[var(--ink)]">Settings</div>
        </div>
      </header>

      <div className="safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2">
        <div className="mx-auto w-full max-w-[560px]">
          <div className="mb-6 flex flex-col items-center pt-2 text-center">
            <span className="relative mb-3 flex h-[72px] w-[72px] items-center justify-center rounded-full bg-[var(--raised)] text-[var(--ink)]">
              <Monitor size={30} strokeWidth={1.7} />
              <span
                className={`absolute right-0.5 bottom-0.5 h-4 w-4 rounded-full border-[3px] border-[var(--stage)] ${
                  connection === "live"
                    ? "bg-emerald-400"
                    : connection === "connecting"
                      ? "animate-pulse bg-amber-400"
                      : "bg-[var(--danger)]"
                }`}
              />
            </span>
            <div className="text-[21px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
              {machine || "Your Mac"}
            </div>
            <div className="mt-1 text-[14px] text-[var(--muted)]">
              {connection === "live" ? "Connected" : connection === "connecting" ? "Reconnecting…" : "Offline"}
              {device ? ` · paired as “${device.name}”` : ""}
            </div>
          </div>

          <Group label="New chats" note="What the next chat you start from this phone runs with.">
            <Row
              icon={<AgentGlyph agent={agent} size={17} />}
              label="Model"
              value={`${fallbackName(agent)} · ${model}${variant ? ` · ${variantLabel(variant)}` : ""}`}
              onClick={() => setSheet("model")}
            />
            <Row
              icon={<Shield size={18} strokeWidth={2} />}
              label="Permissions"
              value={modeLabel(prefs.mode)}
              onClick={() => setSheet("mode")}
            />
            <Row
              icon={<FolderOpen size={18} strokeWidth={2} />}
              label="Project"
              value={prefs.project == null ? `Most recent${project ? ` · ${project.name}` : ""}` : (project?.name ?? "—")}
              onClick={() => setSheet("project")}
            />
          </Group>

          <Group label="Usage">
            <Row
              icon={<Gauge size={18} strokeWidth={2} />}
              label="Limits and context"
              value="Claude 5-hour, weekly"
              onClick={openUsage}
            />
          </Group>

          <Group label="Appearance">
            <div className="px-3 py-3">
              <Segmented<Scheme>
                value={prefs.scheme}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
                onChange={(value) => prefs.set({ scheme: value })}
              />
            </div>
          </Group>

          <Group
            label="Home image"
            note="Fills the top of a new chat and fades into the page. It stays on this phone."
          >
            <HeroPicker />
            <Toggle
              label="Show on new chats"
              checked={prefs.heroEnabled}
              onChange={(heroEnabled) => prefs.set({ heroEnabled })}
            />
          </Group>

          <Group label="Chats">
            <Toggle
              label="Show thinking"
              detail="The agent's reasoning, folded above each reply."
              checked={prefs.showThinking}
              onChange={(showThinking) => prefs.set({ showThinking })}
            />
            <Toggle
              label="Return key sends"
              detail="Otherwise Return starts a new line."
              checked={prefs.enterSends}
              onChange={(enterSends) => prefs.set({ enterSends })}
            />
          </Group>

          <Group label="This phone">
            {!isStandalone() && (
              <Row
                icon={<Plus size={18} strokeWidth={2} />}
                label="Add to Home Screen"
                onClick={() => setSheet("install")}
              />
            )}
            <Row
              icon={<LogOut size={18} strokeWidth={2} className="text-[var(--danger)]" />}
              label={<span className="text-[var(--danger)]">Forget {machine || "this Mac"}</span>}
              onClick={() => setSheet("forget")}
              plain
            />
          </Group>

          <p className="px-6 pt-1 pb-8 text-center text-[12.5px] leading-relaxed text-[var(--faint)]">
            egant on your phone talks to your Mac directly. Chats, agents and files stay there — this
            phone only keeps how it looks.
          </p>
        </div>
      </div>

      <ModelSheet open={sheet === "model"} onClose={() => setSheet(null)} />
      <ModeSheet
        open={sheet === "mode"}
        onClose={() => setSheet(null)}
        agent={agent}
        mode={prefs.mode}
        onPick={(mode) => prefs.set({ mode })}
      />
      <ProjectSheet open={sheet === "project"} onClose={() => setSheet(null)} />
      <Sheet open={sheet === "install"} onClose={() => setSheet(null)} title="Add to Home Screen">
        <div className="px-3 pb-4 text-[15px] leading-relaxed text-[var(--muted)]">
          {isIos() ? (
            <>
              In Safari, tap <Share size={15} strokeWidth={2} className="inline align-[-2px]" /> Share,
              then <span className="text-[var(--ink)]">Add to Home Screen</span>. egant then opens
              full-screen like an app and stays paired with {machine || "your Mac"}.
            </>
          ) : (
            <>
              Open the browser menu and choose <span className="text-[var(--ink)]">Install app</span>{" "}
              (or Add to Home screen). egant then opens like an app and stays paired with{" "}
              {machine || "your Mac"}.
            </>
          )}
        </div>
      </Sheet>
      <Sheet open={sheet === "forget"} onClose={() => setSheet(null)} title={`Forget ${machine || "this Mac"}?`}>
        <div className="px-3 pb-4 text-[15px] leading-relaxed text-[var(--muted)]">
          This phone stops being able to reach it. To connect again you'll need a new code from the
          Mac: egant → Settings → Devices → Connect a device.
        </div>
        <div className="flex flex-col gap-2 px-1 pb-2">
          <button
            type="button"
            onClick={() => void forget()}
            className="press h-12 rounded-full bg-[var(--danger)] text-[16px] font-semibold text-white"
          >
            Forget this Mac
          </button>
          <button
            type="button"
            onClick={() => setSheet(null)}
            className="press h-12 rounded-full bg-[var(--raised-2)] text-[16px] font-medium text-[var(--ink)]"
          >
            Cancel
          </button>
        </div>
      </Sheet>
    </div>
  );
}

/** The picture across a new chat's top: a preview of it, and the two things
 * to do with it — choose one from the photos, or take it away. */
function HeroPicker() {
  const image = useHero((s) => s.image);
  const showToast = useMobile((s) => s.showToast);
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setWorking(true);
    try {
      await setHero(file);
      usePrefs.getState().set({ heroEnabled: true });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "That picture could not be used.");
    } finally {
      setWorking(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <div className="border-b border-[var(--hairline)] p-3">
      <div className="relative h-[120px] overflow-hidden rounded-[14px] bg-[var(--raised-2)]">
        {image ? (
          <img src={image} alt="" className="fade-up h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[14px] text-[var(--faint)]">
            No picture yet
          </div>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={working}
          onClick={() => input.current?.click()}
          className="press flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--ink)] text-[15px] font-semibold text-[var(--stage)] disabled:opacity-60"
        >
          <ImagePlus size={17} strokeWidth={2.2} />
          {working ? "Preparing…" : image ? "Change picture" : "Choose picture"}
        </button>
        {image && (
          <button
            type="button"
            onClick={clearHero}
            className="press h-10 rounded-full bg-[var(--raised-2)] px-5 text-[15px] font-medium text-[var(--ink)]"
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void choose(event.target.files?.[0])}
      />
    </div>
  );
}

function Row({
  icon,
  label,
  value,
  onClick,
  plain,
}: {
  icon: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  onClick: () => void;
  /** No chevron: the row does one thing, it doesn't open anything. */
  plain?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-3 border-b border-[var(--hairline)] px-4 py-2.5 text-left last:border-b-0 active:bg-[var(--hover)]"
    >
      <span className="flex w-5 shrink-0 items-center justify-center text-[var(--muted)]">{icon}</span>
      <span className="shrink-0 text-[16px] text-[var(--ink)]">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2 pl-3">
        {value != null && <span className="min-w-0 truncate text-[15px] text-[var(--muted)]">{value}</span>}
        {!plain && <ChevronRight size={17} strokeWidth={2.2} className="shrink-0 text-[var(--faint)]" />}
      </span>
    </button>
  );
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 border-b border-[var(--hairline)] px-4 py-3 text-left last:border-b-0"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] text-[var(--ink)]">{label}</span>
        {detail && <span className="mt-0.5 block text-[13px] leading-[18px] text-[var(--muted)]">{detail}</span>}
      </span>
      <span className="ios-switch" aria-checked={checked} />
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid rounded-[12px] bg-[var(--raised-2)]/70 p-[3px]" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`h-8 rounded-[9px] text-[14px] font-medium transition-colors ${
            option.value === value
              ? "bg-[var(--stage)] text-[var(--ink)] shadow-[0_1px_4px_rgba(0,0,0,0.18)]"
              : "text-[var(--muted)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
