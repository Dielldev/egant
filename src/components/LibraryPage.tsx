// The Library: Skills and MCP servers, shared across every coding agent on
// this machine. Appears in the chat stage beside the sidebar sessions list.
// Closed with the Close button, the sidebar button, or `Esc`.

import { Blocks, Plug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useColumnLayout } from "../lib/layout";
import { useEgant } from "../store";
import { McpSection } from "./LibraryMcp";
import { SkillsSection } from "./LibrarySkills";
import { WindowBar } from "./WindowBar";

export function LibraryPage() {
  const section = useEgant((s) => s.librarySection);
  const tab = useEgant((s) => s.libraryTab);
  const setSection = useEgant((s) => s.setLibrarySection);
  const setTab = useEgant((s) => s.setLibraryTab);
  const closeLibrary = useEgant((s) => s.closeLibrary);
  const { sidebarShown } = useColumnLayout();

  const [skillsCount, setSkillsCount] = useState<number | null>(null);
  const [mcpCount, setMcpCount] = useState<number | null>(null);

  useEffect(() => {
    void api.librarySkills().then((lib) => setSkillsCount(lib.installed.length)).catch(() => {});
    void api.libraryMcp().then((lib) => setMcpCount(lib.servers.length)).catch(() => {});
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden text-[var(--ink)]">
      {!sidebarShown && <WindowBar />}

      {/* Top Header Bar */}
      <div
        data-tauri-drag-region
        className="flex h-[38px] w-full shrink-0 items-center justify-between border-b border-[var(--border)] px-4"
      >
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[var(--selected)] text-[var(--ink)]">
              <Blocks size={13} strokeWidth={2.2} />
            </span>
            <span className="text-[13px] font-semibold text-[var(--ink)]">Skills & MCP</span>
          </div>

          <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bubble)] p-0.5">
            <button
              type="button"
              onClick={() => setSection("skills")}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                section === "skills"
                  ? "bg-[var(--selected)] font-semibold text-[var(--ink)] shadow-xs"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <span>Skills</span>
              {skillsCount !== null && (
                <span className="rounded-full bg-[var(--badge)] px-1.5 py-0.2 text-[10px] font-medium text-[var(--faint)]">
                  {skillsCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setSection("mcp")}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-0.5 text-[12px] font-medium transition-colors ${
                section === "mcp"
                  ? "bg-[var(--selected)] font-semibold text-[var(--ink)] shadow-xs"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Plug
                size={12}
                strokeWidth={2.2}
                className={section === "mcp" ? "text-[var(--accent)]" : "text-[var(--muted)]"}
              />
              <span>MCP Servers</span>
              {mcpCount !== null && (
                <span className="rounded-full bg-[var(--badge)] px-1.5 py-0.2 text-[10px] font-medium text-[var(--faint)]">
                  {mcpCount}
                </span>
              )}
            </button>
          </div>
        </div>

        <button
          type="button"
          title="Close · Esc"
          onClick={() => closeLibrary()}
          className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[11.5px] font-medium text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] transition-colors"
        >
          <X size={13} strokeWidth={2} />
          <span>Close</span>
        </button>
      </div>

      {/* Main content pane */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-8 pt-6 pb-16">
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
