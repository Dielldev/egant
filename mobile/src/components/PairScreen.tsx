import { Loader2 } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";
import { useMobile } from "../store";
import { Mark } from "./bits";

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
    <div className="relative h-full">
      <div className="safe-top safe-bottom relative z-10 flex h-full flex-col items-center justify-center overflow-y-auto px-6 text-center">
        <div className="fade-up flex flex-col items-center text-[var(--ink)]">
          <Mark height={30} className="mb-6" />
          <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.02em]">Connect to your Mac</h1>
          <p className="mt-2.5 max-w-[320px] text-[15px] leading-relaxed text-[var(--muted)]">
            On your Mac, open egant → Settings → Devices → <em>Connect a device</em>, and scan the QR
            code with your phone's camera.
          </p>
        </div>

        <form
          onSubmit={(e) => void submit(e)}
          className="composer fade-up mt-9 flex w-full max-w-[340px] flex-col gap-3 rounded-[28px] p-4"
          style={{ animationDelay: "120ms" }}
        >
          <label className="text-[13px] text-[var(--muted)]" htmlFor="pair-code">
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
            className="h-13 rounded-[16px] border border-[var(--hairline)] bg-[var(--stage)]/60 text-center font-mono text-[19px] tracking-[0.18em] text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={code.replace("-", "").length !== 10 || busy}
            className="press flex h-12 items-center justify-center gap-2 rounded-full bg-[var(--ink)] text-[16px] font-semibold text-[var(--stage)] disabled:opacity-40"
          >
            {busy && <Loader2 size={16} strokeWidth={2.5} className="animate-spin" />}
            Pair
          </button>
          {pairError && (
            <p className="text-[13.5px] leading-relaxed text-[var(--danger)]">{pairError}</p>
          )}
        </form>

        <p className="mt-8 max-w-[300px] text-[12.5px] leading-relaxed text-[var(--faint)]">
          Your phone talks to your Mac directly, encrypted all the way to it. Only phones paired
          with a code from the Mac get in.
        </p>
      </div>
    </div>
  );
}
