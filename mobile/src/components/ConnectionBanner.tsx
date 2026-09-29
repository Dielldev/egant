import { RefreshCw } from "lucide-react";
import { reconnect } from "../stream";
import { useMobile } from "../store";

/** A thin line under the header while the Mac is out of reach. What is on
 * screen stays readable; it is simply not live until this goes away. */
export function ConnectionBanner() {
  const connection = useMobile((s) => s.connection);
  const machine = useMobile((s) => s.machineName);
  if (connection === "live") return null;
  const down = connection === "down";
  return (
    <button
      type="button"
      onClick={() => void reconnect()}
      className={`flex w-full shrink-0 cursor-pointer items-center gap-2 px-4 py-2 text-left text-[12px] ${
        down ? "bg-[rgba(224,112,112,0.12)] text-[var(--danger)]" : "bg-amber-400/10 text-amber-300"
      }`}
    >
      <RefreshCw size={12} strokeWidth={2} className={down ? "" : "animate-spin"} />
      <span className="min-w-0 flex-1 truncate">
        {down
          ? `Can't reach ${machine || "your Mac"} — is it awake, with egant open and Tailscale on?`
          : `Reconnecting to ${machine || "your Mac"}…`}
      </span>
      {down && <span className="shrink-0 underline underline-offset-2">Retry</span>}
    </button>
  );
}
