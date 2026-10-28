// The Library: Skills and MCP servers, shared across every coding agent on
// this machine. Modeled on native desktop suites with a dedicated left rail
// sidebar and prominent, high-craft Browse and Installed views.
// Closed with the Back button, X, or `Esc`.

import {
  ChevronLeft as BackChevron,
  Compass,
  Download,
  Library as LibraryIcon,
  Plug,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";
import { windowBarPadClass } from "../lib/platform";
import { useEgant } from "../store";
import { McpSection } from "./LibraryMcp";
import { SkillsSection } from "./LibrarySkills";

export function LibraryPage() {
  const section = useEgant((s) => s.librarySection);
  const tab = useEgant((s) => s.libraryTab);
  const setSection = useEgant((s) => s.setLibrarySection);
  const setTab = useEgant((s) => s.setLibraryTab);
  const closeLibrary = useEgant((s) => s.closeLibrary);

  const [skillsCount, setSkillsCount] = useState<number | null>(null);
  const [mcpCount, setMcpCount] = useState<number | null>(null);

  return (
    <div className="stage-glass flex h-full w-full overflow-hidden text-[var(--ink)]">
      {/* Dedicated Library Sidebar Rail on the left */}
      <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)] pt-3 text-[var(--ink)]">
        {/* Window controls / Drag region */}
        <div
          data-tauri-drag-region
          className={`flex h-9 shrink-0 items-center justify-between border-b border-[var(--border)] px-3 pb-3 ${windowBarPadClass()}`}
        >
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--selected)] text-[var(--ink)]">
              <LibraryIcon size={13} strokeWidth={2.2} />
            </span>
            <span className="text-[13px] font-semibold text-[var(--ink)]">Library</span>
          </div>
          <button
            type="button"
            title="Close Library · Esc"
            onClick={() => closeLibrary()}
            className="cursor-pointer rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Navigation list */}
        <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3.5">
          {/* SKILLS SECTION */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--faint)]">
              <Sparkles size={11} strokeWidth={2.5} className="text-[var(--accent)]" />
              <span>Skills</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setSection("skills");
                  setTab("installed");
                }}
                className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors ${
                  section === "skills" && tab === "installed"
                    ? "bg-[var(--selected)] font-semibold text-[var(--ink)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Download size={14} strokeWidth={2} className="shrink-0" />
                  <span>Installed</span>
                </div>
                {skillsCount !== null && (
                  <span className="rounded-full bg-[var(--badge)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--faint)]">
                    {skillsCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setSection("skills");
                  setTab("browse");
                }}
                className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors ${
                  section === "skills" && tab === "browse"
                    ? "bg-[var(--selected)] font-semibold text-[var(--ink)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Compass size={14} strokeWidth={2} className="shrink-0" />
                  <span>Browse</span>
                </div>
                <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                  skills.sh
                </span>
              </button>
            </div>
          </div>

          {/* MCP SERVERS SECTION */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--faint)]">
              <Plug size={11} strokeWidth={2.5} className="text-[var(--accent)]" />
              <span>MCP Servers</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setSection("mcp");
                  setTab("installed");
                }}
                className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors ${
                  section === "mcp" && tab === "installed"
                    ? "bg-[var(--selected)] font-semibold text-[var(--ink)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Server size={14} strokeWidth={2} className="shrink-0" />
                  <span>Installed</span>
                </div>
                {mcpCount !== null && (
                  <span className="rounded-full bg-[var(--badge)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--faint)]">
                    {mcpCount}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setSection("mcp");
                  setTab("browse");
                }}
                className={`flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors ${
                  section === "mcp" && tab === "browse"
                    ? "bg-[var(--selected)] font-semibold text-[var(--ink)]"
                    : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Compass size={14} strokeWidth={2} className="shrink-0" />
                  <span>Browse Catalog</span>
                </div>
                <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                  Catalog
                </span>
              </button>
            </div>
          </div>
        </nav>

        {/* Footer: Back to chat */}
        <div className="shrink-0 border-t border-[var(--border)] px-1.5 py-3">
          <button
            type="button"
            title="Back to conversation · Esc"
            onClick={() => closeLibrary()}
            className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] transition-colors"
          >
            <BackChevron size={14} strokeWidth={2} />
            <span>Back to chat</span>
          </button>
        </div>
      </aside>

      {/* Main content pane */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-8 pt-7 pb-16">
          {section === "mcp" ? (
            <McpSection
              tab={tab}
              onTabChange={setTab}
              onCountChange={setMcpCount}
            />
          ) : (
            <SkillsSection
              tab={tab}
              onTabChange={setTab}
              onCountChange={setSkillsCount}
            />
          )}
        </div>
      </main>
    </div>
  );
}
