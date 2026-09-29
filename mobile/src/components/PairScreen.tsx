import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import mark from "@egant/assets/logo.svg";
import { useMobile } from "../store";

/** No 0/O or 1/I — the same alphabet the Mac draws codes from. */
const CODE_CHARS = /[^23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/g;

function formatCode(input: string): string {
  const code = input.toUpperCase().replace(CODE_CHARS, "").slice(0, 10);
  return code.length > 5 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** Shown when this phone isn't paired (or no longer is). Scanning the QR code
 * the Mac shows is the usual way in and needs nothing here; typing the code
 * beside it is for a phone that opened the app some other way — a Home Screen
 * app that didn't keep its pairing, say. */
export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const pair = useMobile((s) => s.pair);
  const pairError = useMobile((s) => s.pairError);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.replace("-", "").length !== 10 || busy) return;
    setBusy(true);
    const ok = await pair(code);
    setBusy(false);
    if (ok) onPaired();
  };

  return (
    <div className="safe-top safe-bottom flex h-full flex-col items-center justify-center overflow-y-auto px-7 text-center">
      <img src={mark} alt="" className="mb-6 h-9 opacity-80" />
      <h1 className="text-[20px] font-semibold text-[var(--ink)]">Connect to your Mac</h1>
      <p className="mt-2 max-w-[320px] text-[14px] leading-relaxed text-[var(--muted)]">
        On your Mac, open egant → Settings → Devices → <em>Connect device</em>, and scan the QR code
        with your phone's camera.
      </p>

      <form onSubmit={(e) => void submit(e)} className="mt-8 flex w-full max-w-[300px] flex-col gap-3">
        <label className="text-[12px] text-[var(--faint)]" htmlFor="pair-code">
          Or type the code shown under it
        </label>
        <input
          id="pair-code"
          value={code}
          onChange={(e) => setCode(formatCode(e.target.value))}
          placeholder="ABCDE-FGHJK"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="one-time-code"
          spellCheck={false}
          className="h-12 rounded-xl border border-[var(--border)] bg-[var(--card)] text-center font-mono text-[18px] tracking-[0.18em] text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={code.replace("-", "").length !== 10 || busy}
          className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-full bg-[#f2f2f5] text-[14px] font-medium text-[#0c0c0e] disabled:opacity-40"
        >
          {busy && <Loader2 size={15} strokeWidth={2.5} className="animate-spin" />}
          Pair
        </button>
        {pairError && (
          <p className="text-[13px] leading-relaxed text-[var(--danger)]">{pairError}</p>
        )}
      </form>

      <p className="mt-10 max-w-[300px] text-[12px] leading-relaxed text-[var(--faint)]">
        Your phone reaches your Mac over Tailscale — both need it installed and signed in to the
        same tailnet. Nothing goes through anyone else's server.
      </p>
    </div>
  );
}
