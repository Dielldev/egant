import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  QrCode,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import type { MobilePairing, MobileStatus } from "../lib/types";
import { Card, Dot, Row, Toggle } from "./SettingsKit";
import { useNow } from "./useNow";

/** Settings → Devices, below this Mac: using egant from a phone.
 *
 * The phone is a second window onto this Mac — the agents keep running here —
 * reached over Tailscale. This is the whole setup for it: one switch, the
 * Tailscale state with the one thing to fix next, the button that shows a
 * pairing QR code, and the phones already paired, each revocable. */
export function PhoneAccess() {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      setStatus(await api.mobileStatus(refresh));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // Fresh on open (Tailscale may have been set up since), then again whenever
  // a phone pairs, connects or goes away.
  useEffect(() => {
    void load(true);
    let unlisten: (() => void) | undefined;
    let live = true;
    void listen("mobile-changed", () => void load()).then((stop) => {
      if (live) unlisten = stop;
      else stop();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [load]);

  const run = async (action: () => Promise<MobileStatus>) => {
    setBusy(true);
    setProblem(null);
    try {
      setStatus(await action());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const ready = status.enabled && status.running;

  return (
    <div className="mt-8">
      <h2 className="text-[13px] font-semibold text-[var(--ink)]">Phone</h2>
      <p className="mt-1 mb-3 max-w-[660px] text-[13px] leading-relaxed text-[var(--muted)]">
        Use egant from your phone over Tailscale — see your sessions, send messages, stop agents
        and answer prompts. The agents keep running on this Mac.
      </p>
      <Card>
        <Row
          icon={Smartphone}
          title="Allow phone connections"
          sub={
            status.enabled
              ? status.running
                ? `egant is listening on this Mac only (port ${status.port}); Tailscale carries it to your phone.`
                : (status.error ?? "Starting…")
              : "Off — no phone can reach this Mac."
          }
          control={
            <Toggle
              label="Allow phone connections"
              on={status.enabled}
              disabled={busy}
              onChange={(on) => void run(() => api.mobileSetEnabled(on))}
            />
          }
        />
        {status.enabled && (
          <TailscaleRow
            status={status}
            busy={busy}
            onRecheck={() => void run(() => api.mobileSetupTailscale())}
          />
        )}
        {ready && (
          <Row
            icon={QrCode}
            title="Connect a device"
            sub="Scan a QR code with your phone's camera. It remembers this Mac after that."
            control={
              <button
                type="button"
                onClick={() => setConnecting(true)}
                className="shrink-0 cursor-pointer rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90"
              >
                Connect device
              </button>
            }
          />
        )}
      </Card>
      {problem && <div className="mt-2 text-[12px] text-[var(--danger)]">{problem}</div>}

      {status.devices.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-[12px] font-medium text-[var(--muted)]">
            Paired devices <span className="text-[var(--faint)]">{status.devices.length}</span>
          </h3>
          <Card>
            {status.devices.map((device) => (
              <DeviceRow
                key={device.id}
                name={device.name}
                connected={device.connected}
                lastSeenMs={device.lastSeenMs}
                createdMs={device.createdMs}
                onRevoke={() => void run(() => api.mobileRevokeDevice(device.id))}
              />
            ))}
          </Card>
        </>
      )}

      {connecting && (
        <ConnectDialog
          status={status}
          onClose={() => {
            setConnecting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Where Tailscale stands, and the one thing to do next if it isn't ready. */
function TailscaleRow({
  status,
  busy,
  onRecheck,
}: {
  status: MobileStatus;
  busy: boolean;
  onRecheck: () => void;
}) {
  const ts = status.tailscale;
  let sub: ReactNode;
  let action: ReactNode = null;
  if (!ts.installed) {
    sub = "Tailscale isn't installed on this Mac. Install it here and on your phone, and sign both in to the same account.";
    action = <LinkButton url="https://tailscale.com/download">Get Tailscale</LinkButton>;
  } else if (!ts.running) {
    sub =
      ts.backendState === "NeedsLogin"
        ? "Tailscale is installed but signed out. Open it and sign in."
        : `Tailscale isn't connected${ts.backendState ? ` (${ts.backendState})` : ""}. Open it and turn it on.`;
  } else if (!ts.httpsEnabled) {
    sub = `Connected as ${ts.dnsName ?? "this Mac"}. Turn on HTTPS certificates for your tailnet (DNS settings), then recheck.`;
    action = (
      <LinkButton url="https://login.tailscale.com/admin/dns">Open DNS settings</LinkButton>
    );
  } else if (status.url) {
    sub = (
      <>
        Reachable from your tailnet at{" "}
        <span className="font-mono text-[var(--ink)]">{status.url.replace("https://", "")}</span>
      </>
    );
  } else if (ts.portConflict) {
    sub = `Another tailscale serve entry already uses port ${status.port} on this Mac.`;
  } else {
    sub = (
      <>
        {status.error ?? "Tailscale is ready; egant still needs to publish itself with tailscale serve."}
        <CommandLine command={status.serveCommand} />
      </>
    );
  }
  return (
    <Row
      icon={Globe}
      title={
        <span className="flex items-center gap-1.5">
          Tailscale
          {ts.running && status.url && (
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Ready" />
          )}
        </span>
      }
      sub={sub}
      control={
        <div className="flex shrink-0 items-center gap-2">
          {action}
          <button
            type="button"
            title="Check Tailscale again and set up tailscale serve"
            disabled={busy}
            onClick={onRecheck}
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-50"
          >
            {busy ? (
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <RefreshCw size={13} strokeWidth={2} />
            )}
            Recheck
          </button>
        </div>
      }
    />
  );
}

function LinkButton({ url, children }: { url: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void api.openUrl(url)}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--hover)]"
    >
      {children}
      <ExternalLink size={11} strokeWidth={2} />
    </button>
  );
}

/** A command to run by hand, with a copy button. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="mt-1.5 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink)]">
        {command}
      </code>
      <button
        type="button"
        title="Copy command"
        onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true))}
        className="shrink-0 cursor-pointer text-[var(--faint)] hover:text-[var(--ink)]"
      >
        {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={2} />}
      </button>
    </span>
  );
}

function DeviceRow({
  name,
  connected,
  lastSeenMs,
  createdMs,
  onRevoke,
}: {
  name: string;
  connected: boolean;
  lastSeenMs: number;
  createdMs: number;
  onRevoke: () => void;
}) {
  const now = useNow(30_000);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center gap-3.5 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)]">
        <Smartphone size={16} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</div>
        <div className="mt-0.5 truncate text-[12px] text-[var(--faint)]">
          {connected ? (
            <span className="text-emerald-400">Connected</span>
          ) : (
            <>Last seen {ago(lastSeenMs, now)}</>
          )}
          <Dot />
          Paired {ago(createdMs, now)}
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[12px] text-[var(--muted)]">Revoke {name}?</span>
          <button
            type="button"
            onClick={onRevoke}
            className="cursor-pointer rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1 text-[12px] text-[var(--danger)] hover:opacity-85"
          >
            Revoke
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="cursor-pointer rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          Revoke
        </button>
      )}
    </div>
  );
}

function ago(ms: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** The pairing QR code: scan it and the phone is in. Closes itself once a
 * phone pairs with it. */
function ConnectDialog({ status, onClose }: { status: MobileStatus; onClose: () => void }) {
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const now = useNow(1000);
  const known = useRef(new Set(status.devices.map((device) => device.id)));

  const issue = useCallback(async () => {
    setError(null);
    try {
      setPairing(await api.mobileCreatePairing());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    void issue();
  }, [issue]);

  // A phone that pairs shows up as a device this dialog hadn't seen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    void listen("mobile-changed", async () => {
      const next = await api.mobileStatus().catch(() => null);
      const fresh = next?.devices.find((device) => !known.current.has(device.id));
      if (live && fresh) setPaired(fresh.name);
    }).then((stop) => {
      if (live) unlisten = stop;
      else stop();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!paired) return;
    const timer = setTimeout(onClose, 1600);
    return () => clearTimeout(timer);
  }, [paired, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const remaining = pairing ? Math.max(0, pairing.expiresAtMs - now) : 0;
  const expired = pairing != null && remaining === 0;
  const clock = `${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[380px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--stage)] shadow-2xl"
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-[var(--ink)]">Connect a device</div>
            <div className="mt-0.5 text-[12px] leading-[1.45] text-[var(--muted)]">
              Scan with your phone's camera. Your phone needs Tailscale, signed in to the same
              tailnet as this Mac.
            </div>
          </div>
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        <div className="flex flex-col items-center px-5 pt-4 pb-5">
          {paired ? (
            <div className="flex h-[232px] flex-col items-center justify-center gap-2 text-[13px] text-[var(--ink)]">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-400">
                <Check size={20} strokeWidth={2.5} />
              </span>
              {paired} is connected
            </div>
          ) : error ? (
            <div className="py-10 text-center text-[12px] text-[var(--danger)]">{error}</div>
          ) : !pairing ? (
            <div className="flex h-[232px] items-center justify-center">
              <Loader2 size={18} strokeWidth={2} className="animate-spin text-[var(--faint)]" />
            </div>
          ) : pairing.qrSvg && !expired ? (
            <img
              alt="Pairing QR code"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
              className="h-[232px] w-[232px] rounded-xl"
            />
          ) : (
            <div className="flex h-[232px] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-4 text-center text-[12px] text-[var(--muted)]">
              {expired
                ? "This code has expired."
                : "Your phone can't reach this Mac yet — finish the Tailscale step in Settings first."}
            </div>
          )}

          {pairing && !paired && (
            <>
              <div className="mt-4 text-[11px] text-[var(--faint)]">Or enter this code on your phone</div>
              <div className="mt-1 font-mono text-[18px] tracking-[0.12em] text-[var(--ink)]">
                {pairing.code}
              </div>
              <div className="mt-1 text-[11px] text-[var(--faint)]">
                {expired ? "Expired" : `Works once · expires in ${clock}`}
              </div>
              {pairing.url && !expired && (
                <div className="mt-3 max-w-full truncate font-mono text-[10.5px] text-[var(--faint)]" title={pairing.url}>
                  {pairing.url.split("#")[0]}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <button
            type="button"
            title="Open the phone app in this Mac's browser, paired with this code"
            disabled={!pairing || expired || paired != null}
            onClick={() => pairing && void api.openUrl(pairing.localUrl)}
            className="cursor-pointer rounded-lg px-2 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
          >
            Try it on this Mac
          </button>
          <button
            type="button"
            onClick={() => void issue()}
            disabled={paired != null}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-45"
          >
            <RefreshCw size={12} strokeWidth={2.5} />
            New code
          </button>
        </div>
      </div>
    </div>
  );
}
