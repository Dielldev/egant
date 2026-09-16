import { Monitor } from "lucide-react";
import { useEgant } from "../store";
import { Composer } from "./Composer";
import { ProjectMenu } from "./ProjectMenu";
import { SessionHeader } from "./SessionHeader";
import { Wallpaper } from "./Wallpaper";

/** The window before the first message lands: the same sidebar and the same
 * composer the conversation uses, over a wallpaper that still reads as a
 * photograph. Nothing here is a screen of its own — it is the conversation
 * with nothing in it yet. */
export function LaunchScreen() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "");

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <Wallpaper launch />
      <div className="relative z-10 flex h-full flex-col">
        <SessionHeader bare />
        <div className="flex flex-1 flex-col items-center px-6" style={{ paddingTop: "32vh" }}>
          <div className="rise w-full max-w-[735px]">
            {/* Where the next turn will run, right-aligned to the composer it
              belongs to. Deliberately unpositioned (no z-index of its own):
              the composer below establishes its own stacking context (its
              backdrop-filter triggers one even though it isn't `position`ed),
              so this row must stay out of one too, or it would get pinned
              behind the composer and its dropdowns (the project menu's own
              popover included) would render clipped underneath it. */}
            <div
              className="mb-2 flex items-center justify-end gap-4 text-xs text-white/85"
              style={{ textShadow: "0 1px 4px rgba(0,0,0,0.55)" }}
            >
              {/* A label, not a control: every session in this window is a
                local process, so there is no other machine to pick. */}
              <span className="flex min-w-0 items-center gap-1.5">
                <Monitor size={13} strokeWidth={2} className="shrink-0" />
                <span className="truncate">{machine}</span>
              </span>
              <ProjectMenu variant="chip" />
            </div>
            <Composer sessionId={null} hero autoFocus />
          </div>
        </div>
      </div>
    </div>
  );
}
