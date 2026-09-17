import { Monitor } from "lucide-react";
import { useEgant } from "../store";
import { Composer } from "./Composer";
import { ProjectMenu } from "./ProjectMenu";

/** The stage before the first message lands: the same composer the
 * conversation uses, centred, over the launch wallpaper. Nothing here is a
 * screen of its own — it is the conversation with nothing in it yet, which is
 * why the header, the tab strip and the wallpaper around it belong to the
 * stage in `App` rather than to this. */
export function LaunchScreen({ exiting }: { exiting?: boolean }) {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "");

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center px-6"
      style={{ paddingTop: "32vh" }}
    >
      <div className={`w-full max-w-[735px] ${exiting ? "dock-exit" : "rise"}`}>
        {/* Where the next turn will run, right-aligned to the composer it
          belongs to. Deliberately unpositioned (no z-index of its own):
          the composer below establishes its own stacking context (its
          backdrop-filter triggers one even though it isn't `position`ed),
          so this row must stay out of one too, or it would get pinned
          behind the composer and its dropdowns (the project menu's own
          popover included) would render clipped underneath it. */}
        <div
          className="mb-2 flex items-center justify-end gap-4 text-xs font-semibold text-white"
          style={{ textShadow: "0 1px 6px rgba(0,0,0,0.75), 0 1px 2px rgba(0,0,0,0.9)" }}
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
  );
}
