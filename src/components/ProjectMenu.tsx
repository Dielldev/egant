import { Check, ChevronDown, Folder, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { projectColor } from "../lib/transcript";
import { shouldOpenUpward } from "../lib/popover";
import { useEgant } from "../store";

/** Which project the next turn acts on.
 *
 * `header` is the sidebar's: full width, the machine name trailing the
 * project. `chip` is the one riding above the launch composer, which is
 * narrow and sits beside a machine label of its own. Both share the same
 * dropdown: a search field, "All projects", every project with its machine,
 * and — below a divider — where a new one comes from. Wallpaper lives in
 * Settings > Appearance now, not here. */
export function ProjectMenu({
  variant,
  machine,
}: {
  variant: "header" | "chip";
  machine?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openUpward, setOpenUpward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const snapshot = useEgant((s) => s.snapshot);
  const selectProject = useEgant((s) => s.selectProject);
  const selectAllProjects = useEgant((s) => s.selectAllProjects);
  const openFolderDialog = useEgant((s) => s.openFolderDialog);

  const projects = snapshot?.projects ?? [];
  const activeProject = snapshot?.activeProject ?? null;
  const current = projects.find((p) => p.id === activeProject);
  const header = variant === "header";
  const machineLabel = machine ?? snapshot?.machineName ?? "";

  const needle = query.trim().toLowerCase();
  const visibleProjects = useMemo(
    () => projects.filter((p) => needle === "" || p.name.toLowerCase().includes(needle)),
    [projects, needle],
  );

  const toggle = () => {
    if (!open) {
      setQuery("");
      setOpenUpward(shouldOpenUpward(rootRef, Math.min(420, window.innerHeight * 0.65)));
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
    <div ref={rootRef} className={`relative ${header ? "min-w-0 flex-1" : ""}`}>
      <button
        type="button"
        title={current?.path}
        onClick={toggle}
        className={`flex cursor-pointer items-center gap-1.5 rounded-md text-xs hover:text-[var(--ink)] ${
          header ? "w-full min-w-0 py-0.5" : "max-w-[220px]"
        }`}
      >
        <Folder
          size={13}
          strokeWidth={2}
          className={`shrink-0 ${header ? "text-[var(--muted)]" : "text-white/85"}`}
        />
        {/* In the header the machine name is the part that must stay whole —
          it is the same on every row, so a truncated project reads as "one of
          these" while a truncated machine reads as an unfinished word. The
          chip variant sits directly on the launch screen's wallpaper rather
          than a themed panel, so it reads in near-white rather than the
          panel-tuned muted tones, which get lost against a busy photo. */}
        <span
          className={`min-w-0 truncate ${
            header ? "flex-1 text-left font-semibold text-[var(--ink)]" : "text-white/85"
          }`}
        >
          {current?.name ?? "All projects"}
        </span>
        {header && machineLabel && (
          <span className="max-w-[62%] shrink-0 truncate text-[var(--faint)]">
            @ {machineLabel}
          </span>
        )}
        <ChevronDown
          size={13}
          strokeWidth={2}
          className={`shrink-0 ${header ? "text-[var(--faint)]" : "text-white/70"}`}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            style={{ transformOrigin: openUpward ? "bottom left" : "top left" }}
            className={`menu absolute z-50 flex max-h-[min(420px,65vh)] w-[264px] flex-col overflow-hidden rounded-xl text-xs ${
              openUpward ? "menu-pop-up bottom-full mb-1.5" : "menu-pop top-full mt-1.5"
            } ${header ? "left-0" : "right-0"}`}
          >
            <div className="shrink-0 px-2 pt-2 pb-1.5">
              <div className="flex items-center gap-2 rounded-lg bg-[rgba(255,255,255,0.05)] px-2.5 py-1.5">
                <Search size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects…"
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
                />
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
              <Row
                active={activeProject == null}
                onClick={() => {
                  setOpen(false);
                  void selectAllProjects();
                }}
              >
                <Folder size={13} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
                <span className="min-w-0 flex-1 truncate">All projects</span>
                {activeProject == null && <Check size={12} strokeWidth={2} className="shrink-0" />}
              </Row>
              {visibleProjects.map((project) => (
                <Row
                  key={project.id}
                  title={project.path}
                  active={project.id === activeProject}
                  onClick={() => {
                    setOpen(false);
                    void selectProject(project.id);
                  }}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: projectColor(project.hue) }}
                  />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {machineLabel && (
                    <span className="max-w-[40%] shrink-0 truncate text-[var(--faint)]">
                      @ {machineLabel}
                    </span>
                  )}
                  {project.id === activeProject && (
                    <Check size={12} strokeWidth={2} className="shrink-0" />
                  )}
                </Row>
              ))}
              {visibleProjects.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-[var(--faint)]">
                  {projects.length === 0 ? "No projects yet" : "No projects match"}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-[var(--border)] px-1 py-1">
              <Row
                onClick={() => {
                  setOpen(false);
                  void openFolderDialog();
                }}
              >
                <Plus size={12} strokeWidth={2} className="shrink-0" />
                <span className="flex-1 truncate">New project…</span>
              </Row>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  title,
  active,
  onClick,
  children,
}: {
  title?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
        active ? "bg-[var(--selected)] text-[var(--ink)]" : ""
      }`}
    >
      {children}
    </button>
  );
}
