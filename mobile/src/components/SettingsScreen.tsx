import {
  Ban,
  ChevronRight,
  FolderOpen,
  ImagePlus,
  LogOut,
  Monitor,
  Palette,
  Plus,
  Share,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fallbackName, variantLabel } from "@egant/lib/agents";
import { ACCENTS, DARK_THEMES, LIGHT_THEMES } from "@egant/lib/themes";
import type { ThemeOption } from "@egant/lib/themes";
import { modeLabel } from "@egant/lib/transcript";
import { wallpaperUrl } from "../api";
import { BUILT_IN_BACKGROUNDS, accentOf, resolvedScheme, usePrefs } from "../prefs";
import type { Background, Scheme } from "../prefs";
import { pickAgent, pickProject, useMobile } from "../store";
import { AgentGlyph } from "./bits";
import { isIos, isStandalone } from "./InstallHint";
import { ModeSheet, ModelSheet, ProjectSheet, modelName } from "./Pickers";
import { Choice, Group, Sheet } from "./Sheet";

type SheetName = "model" | "mode" | "project" | "theme" | "forget" | "install" | null;

/** This phone's settings, as a page that rises over the app: the Mac it is
 * paired with, what a new chat starts with, how the app looks, and how chats
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
  const prefs = usePrefs();
  const [sheet, setSheet] = useState<SheetName>(null);

  const agent = pickAgent(prefs.agent, defaultAgent);
  useEffect(() => {
    void loadModels(agent);
  }, [agent, loadModels]);
  const project = pickProject(prefs.project, projects, sessions);
  const model = modelName(agent, catalogs[agent], prefs.models[agent] || null);
  const variant = prefs.variants[agent];
  const scheme = resolvedScheme(prefs.scheme);
  const theme = [...DARK_THEMES, ...LIGHT_THEMES].find(
    (t) => t.value === (scheme === "light" ? prefs.lightTheme : prefs.darkTheme),
  );

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
            <Row
              icon={<Palette size={18} strokeWidth={2} />}
              label="Theme"
              value={theme?.label ?? "Default"}
              trailingSwatch={theme}
              onClick={() => setSheet("theme")}
            />
            <div className="border-t border-[var(--hairline)] px-4 pt-3 pb-3.5">
              <div className="mb-3 flex items-center gap-3">
                <Sparkles size={18} strokeWidth={2} className="text-[var(--muted)]" />
                <span className="flex-1 text-[16px] text-[var(--ink)]">Accent color</span>
                <span className="text-[15px] text-[var(--muted)]">
                  {ACCENTS.find((a) => a.value === prefs.accent)?.label ?? "Custom"}
                </span>
              </div>
              <div className="no-scrollbar -mx-1 flex gap-2.5 overflow-x-auto px-1 py-1">
                {ACCENTS.map((accent) => {
                  const color = accent.value === "default" ? accentOf({ ...prefs, accent: "default" }) : accent.value;
                  const active = prefs.accent === accent.value;
                  return (
                    <button
                      key={accent.value}
                      type="button"
                      aria-label={accent.label}
                      onClick={() => prefs.set({ accent: accent.value })}
                      className="press relative h-8 w-8 shrink-0 rounded-full"
                      style={{
                        background: color,
                        boxShadow: active ? `0 0 0 2px var(--raised), 0 0 0 4px ${color}` : undefined,
                      }}
                    >
                      {accent.value === "default" && (
                        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-black/60">
                          A
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </Group>

          <BackgroundGroup />

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
      <ThemeSheet open={sheet === "theme"} onClose={() => setSheet(null)} />
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

function Row({
  icon,
  label,
  value,
  onClick,
  trailingSwatch,
  plain,
}: {
  icon: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  onClick: () => void;
  trailingSwatch?: ThemeOption;
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
        {trailingSwatch && <Swatch theme={trailingSwatch} />}
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

function Swatch({ theme }: { theme: ThemeOption }) {
  return (
    <span
      className="inline-flex h-5 w-5 shrink-0 overflow-hidden rounded-full border border-[var(--hairline)]"
      style={{ background: `linear-gradient(135deg, ${theme.swatch[0]} 50%, ${theme.swatch[1]} 50%)` }}
    />
  );
}

/** The desktop's palettes: the dark set and the light set, each used when
 * the phone is in that scheme. */
function ThemeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const darkTheme = usePrefs((s) => s.darkTheme);
  const lightTheme = usePrefs((s) => s.lightTheme);
  const scheme = usePrefs((s) => resolvedScheme(s.scheme));
  const set = usePrefs((s) => s.set);
  const dark = (
    <Group label="Dark" key="dark">
      {DARK_THEMES.map((theme) => (
        <Choice
          key={theme.value}
          leading={<Swatch theme={theme} />}
          label={theme.label}
          selected={theme.value === darkTheme}
          onClick={() => set({ darkTheme: theme.value })}
        />
      ))}
    </Group>
  );
  const light = (
    <Group label="Light" key="light">
      {LIGHT_THEMES.map((theme) => (
        <Choice
          key={theme.value}
          leading={<Swatch theme={theme} />}
          label={theme.label}
          selected={theme.value === lightTheme}
          onClick={() => set({ lightTheme: theme.value })}
        />
      ))}
    </Group>
  );
  return (
    <Sheet open={open} onClose={onClose} title="Theme" tall>
      {scheme === "light" ? [light, dark] : [dark, light]}
    </Sheet>
  );
}

/** The new-chat screen's picture: the Mac's wallpaper, one of the built-in
 * ones, a photo from this phone, or none — and how far it is darkened. */
function BackgroundGroup() {
  const background = usePrefs((s) => s.background);
  const photo = usePrefs((s) => s.photo);
  const dim = usePrefs((s) => s.dim);
  const set = usePrefs((s) => s.set);
  const setPhoto = usePrefs((s) => s.setPhoto);
  const showToast = useMobile((s) => s.showToast);
  const wallpaper = useMobile((s) => s.wallpaper);
  const machine = useMobile((s) => s.machineName);
  const file = useRef<HTMLInputElement>(null);

  const options: { id: Background; label: string; src: string | null; disabled?: boolean }[] = [
    { id: "mac", label: "Mac", src: wallpaper ? wallpaperUrl(wallpaper) : null, disabled: !wallpaper },
    ...BUILT_IN_BACKGROUNDS.map((b) => ({ id: b.id as Background, label: b.label, src: b.src as string })),
    { id: "photo", label: "Photo", src: photo },
    { id: "none", label: "None", src: null },
  ];
  // "Mac" with no wallpaper there shows the first built-in instead.
  const effective = background === "mac" && !wallpaper ? "dusk" : background;

  return (
    <Group
      label="Background"
      note={
        wallpaper
          ? `“Mac” is the wallpaper egant shows on ${machine || "your Mac"}.`
          : `${machine || "Your Mac"} has no wallpaper set in egant, so the phone uses Dusk until it does.`
      }
    >
      <div className="no-scrollbar flex gap-2.5 overflow-x-auto px-3 pt-3.5 pb-3">
        {options.map((option) => {
          const active = option.id === effective;
          return (
            <button
              key={option.id}
              type="button"
              disabled={option.disabled}
              onClick={() => {
                if (option.id === "photo" && (!photo || background === "photo")) {
                  file.current?.click();
                  return;
                }
                set({ background: option.id });
              }}
              className="press flex shrink-0 flex-col items-center gap-1.5 disabled:opacity-40"
            >
              <span
                className={`relative flex h-[118px] w-[66px] items-center justify-center overflow-hidden rounded-[14px] bg-[var(--raised-2)] ${
                  active ? "ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--raised)]" : ""
                }`}
              >
                {option.src ? (
                  <img src={option.src} alt="" className="h-full w-full object-cover" />
                ) : option.id === "photo" ? (
                  <ImagePlus size={20} strokeWidth={1.8} className="text-[var(--muted)]" />
                ) : option.id === "none" ? (
                  <Ban size={20} strokeWidth={1.8} className="text-[var(--muted)]" />
                ) : (
                  <Monitor size={20} strokeWidth={1.8} className="text-[var(--muted)]" />
                )}
                {option.id === "photo" && photo && background === "photo" && (
                  <span className="absolute inset-x-1 bottom-1 rounded-md bg-black/55 py-0.5 text-center text-[10px] font-medium text-white">
                    Change
                  </span>
                )}
              </span>
              <span className={`text-[12px] ${active ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)]"}`}>
                {option.label}
              </span>
            </button>
          );
        })}
      </div>
      {background !== "none" && (
        <div className="flex items-center gap-3 border-t border-[var(--hairline)] px-4 py-3.5">
          <span className="shrink-0 text-[16px] text-[var(--ink)]">Darken</span>
          <input
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={dim}
            onChange={(e) => set({ dim: Number(e.target.value) })}
            className="range"
            aria-label="Darken the background"
          />
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (!picked) return;
          void setPhoto(picked).catch(() => showToast("That photo couldn't be read."));
        }}
      />
    </Group>
  );
}
