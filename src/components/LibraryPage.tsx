// The Library: MCP servers and skills, shared across every coding agent on
// this machine. Modeled on emdash's Library (emdash.com/docs/library). It
// takes the stage beside the sidebar rather than the whole window, so a
// conversation is always one click away; MCP and Skills are tabs along the
// top. Closed with the X (or `Esc`), or by picking a conversation.

import { Plug, Sparkles, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { windowBarPadClass } from "../lib/platform";
import { useEgant } from "../store";
import type { LibrarySection } from "../store";
import { McpSection } from "./LibraryMcp";
import { SkillsSection } from "./LibrarySkills";

const TABS: { id: LibrarySection; label: string; icon: LucideIcon }[] = [
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "skills", label: "Skills", icon: Sparkles },
];

export function LibraryPage() {
  const section = useEgant((s) => s.librarySection);
  const openLibrary = useEgant((s) => s.openLibrary);
  const closeLibrary = useEgant((s) => s.closeLibrary);
  const sidebarVisible = useEgant((s) => s.snapshot?.sidebarVisible ?? true);

  return (
    <div className="stage-glass flex h-full min-w-0 flex-1 flex-col overflow-hidden text-[var(--ink)]">
      {/* With the sidebar hidden this row sits under the traffic lights. */}
      <div
        data-tauri-drag-region
        className={`flex h-[44px] w-full shrink-0 items-center gap-3 border-b border-[var(--border)] pr-3 ${
          sidebarVisible ? "pl-5" : windowBarPadClass()
        }`}
      >
        <span className="text-[13px] font-semibold text-[var(--ink)]">Library</span>
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => openLibrary(tab.id)}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] whitespace-nowrap ${
                tab.id === section
                  ? "bg-[var(--selected)] font-medium text-[var(--ink)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <tab.icon size={13} strokeWidth={2} />
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          title="Close the Library · Esc"
          onClick={() => closeLibrary()}
          className="ml-auto cursor-pointer rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-8 pt-7 pb-16">
          {section === "mcp" ? <McpSection /> : <SkillsSection />}
        </div>
      </main>
    </div>
  );
}
