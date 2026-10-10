import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fitMenu } from "../lib/popover";
import { modeLabel } from "../lib/transcript";
import { MODE_INFO, NUMBERED_MODES } from "../lib/modes";
import { useEgant } from "../store";

/** The composer's mode control: a plain "⌄ Auto" pill — same shape as Claude
 * Code Desktop's — that opens a "Mode" menu with a description and a
 * number-key shortcut per row, plus Bypass permissions as a separate toggle
 * beneath a divider rather than a fifth numbered row, so a stray click (or
 * keypress) can never step you into the mode that asks for nothing. Every
 * chat agent honors it — each backend maps it onto whatever "run unattended"
 * means for its own wire (Claude's `bypassPermissions` mode, Codex's
 * `--dangerously-bypass-approvals-and-sandbox`, opencode's persistent
 * `--auto`) — so it's shown regardless of whether the agent has an entry in
 * `MODE_INFO`. */
export function ModeInfo({
  sessionId,
  agent,
  mode,
}: {
  sessionId: number;
  agent: string;
  mode: string;
}) {
  const setMode = useEgant((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  // Room on the chosen side, so the menu scrolls rather than reaching the
  // window's edge (or, opening upward, the top of the stage).
  const [maxHeight, setMaxHeight] = useState(420);
  // How far above the chip an upward menu sits. The chip is on the footer row
  // *under* the composer box, so a menu hung straight off the chip lands on
  // the box (and the model picker in it); this lifts it clear of both.
  const [lift, setLift] = useState(8);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      const index = Number(e.key) - 1;
      if (index >= 0 && index < NUMBERED_MODES.length) {
        e.preventDefault();
        const picked = NUMBERED_MODES[index];
        setOpen(false);
        if (picked !== mode) void setMode(sessionId, picked);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, mode, sessionId, setMode]);

  const place = () => {
    // 12px margin on top of the menu's own 8px gap to the pill: the composer
    // row it hangs from should stay fully visible beside it.
    const fit = fitMenu(rootRef, 420, 12);
    setOpenUpward(fit.openUpward);
    const chip = rootRef.current?.getBoundingClientRect();
    const box = rootRef.current?.closest("[data-composer-footer]")?.previousElementSibling;
    const boxTop = box?.getBoundingClientRect().top;
    const clear = chip && boxTop != null ? chip.bottom - boxTop + 8 : 8;
    setLift(Math.max(8, clear));
    setMaxHeight(
      fit.openUpward && chip && boxTop != null
        ? Math.max(160, Math.min(fit.maxHeight, boxTop - 8 - 12))
        : fit.maxHeight,
    );
  };

  // `/mode` in the composer opens this menu as a click would.
  const pickerRequest = useEgant((s) => s.pickerRequest);
  useEffect(() => {
    if (pickerRequest?.kind === "mode" && pickerRequest.sessionId === sessionId) {
      place();
      setOpen(true);
    }
    // Only a new request opens it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerRequest?.token]);

  const info = MODE_INFO[agent];
  const bypassed = mode === "bypassPermissions";

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title="Permission mode"
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
        className="flex cursor-pointer items-center gap-1 rounded-full px-2 py-1 text-xs text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <ChevronDown size={12} strokeWidth={2} />
        <span className="font-medium whitespace-nowrap">{modeLabel(mode)}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            style={{
              transformOrigin: openUpward ? "bottom right" : "top right",
              maxHeight,
              ...(openUpward ? { bottom: lift } : {}),
            }}
            className={`menu absolute right-0 z-50 w-[280px] overflow-y-auto rounded-xl p-1.5 text-xs ${
              openUpward ? "menu-pop-up" : "menu-pop top-full mt-2"
            }`}
          >
            <div className="px-2 pt-1 pb-1.5 text-[11px] font-semibold text-[var(--faint)]">
              Mode
            </div>
            {bypassed && (
              // None of the four is current while Bypass is on, which reads
              // as a menu that forgot the answer; say what is true instead.
              <p className="px-2 pb-1.5 text-[11px] leading-relaxed text-[var(--attention)]">
                Bypass is on, so the agent asks about nothing. Picking a mode turns it off.
              </p>
            )}
            {info ? (
              NUMBERED_MODES.map((m, index) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (m !== mode) void setMode(sessionId, m);
                  }}
                  className={`flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--hover)] ${
                    m === mode ? "bg-[var(--selected)]" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium text-[var(--ink)]">
                      {modeLabel(m)}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--muted)]">
                      {info[m]}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
                    {m === mode && (
                      <Check size={13} strokeWidth={2} className="text-[var(--ink)]" />
                    )}
                    <span className="text-[11px] text-[var(--faint)]">{index + 1}</span>
                  </span>
                </button>
              ))
            ) : (
              <p className="px-2.5 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
                This agent runs under its own fixed tool policy for now — per-mode switching
                isn&apos;t wired up in egant yet. Bypass permissions below still works.
              </p>
            )}
            <div className="mx-1 my-1.5 border-t border-[var(--border)]" />
            <div className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2">
              <span className="min-w-0 flex-1 text-[12.5px] font-medium text-[var(--ink)]">
                Bypass permissions
              </span>
              {bypassed && <Check size={13} strokeWidth={2} className="shrink-0 text-[var(--ink)]" />}
              <button
                type="button"
                role="switch"
                aria-checked={bypassed}
                title={
                  bypassed
                    ? "Bypassing all permissions — click to go back to asking"
                    : "Bypass all permissions: the agent won't ask before acting"
                }
                onClick={() => void setMode(sessionId, bypassed ? "auto" : "bypassPermissions")}
                className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-0.5 ${
                  bypassed
                    ? "justify-end bg-[var(--toggle-on)]"
                    : "justify-start bg-[var(--bubble)]"
                }`}
              >
                <span
                  className={`h-4 w-4 rounded-full ${
                    bypassed ? "bg-[var(--toggle-knob)]" : "bg-[var(--faint)]"
                  }`}
                />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
