import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Network,
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

/** How long a newly opened public link may still be reaching the public
 * DNS: Tailscale quotes up to ten minutes. */
const FRESH_LINK_MS = 10 * 60_000;

/** Phones in Settings → Devices: using egant from a phone.
 *
 * A phone is a second window onto this Mac — the agents keep running here —
 * so it's listed as a device beside it, with "Connect a device" (the pairing
 * QR code) right under them. It arrives through Tailscale on this Mac: over
 * the tailnet, or through the public link from any network, with nothing
 * installed on the phone. The settings for that sit below the list: one
 * switch, the Tailscale state with the one thing to fix next, and the public
 * link. This hook is the state they all share. */
export function usePhoneAccess() {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      setStatus(await api.mobileStatus(refresh));
    } catch (error) {
      setProblem(messageOf(error));
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

  const run = async (action: () => Promise<MobileStatus>): Promise<MobileStatus | null> => {
    setBusy(true);
    setProblem(null);
    try {
      const next = await action();
      setStatus(next);
      return next;
    } catch (error) {
      setProblem(messageOf(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Stable, so the dialog's close-after-pairing timer isn't restarted by
  // every status refresh.
  const closeConnect = useCallback(() => {
    setConnecting(false);
    void load();
  }, [load]);

  return {
    status,
    setStatus,
    busy,
    problem,
    run,
    connecting,
    /** Opens the pairing QR code — from any state: phone access comes on
     * first when it's off. */
    connect: async () => {
      const next =
        status?.enabled && status.running ? status : await run(() => api.mobileSetEnabled(true));
      if (next?.running) setConnecting(true);
    },
    closeConnect,
  };
}

export type PhoneAccess = ReturnType<typeof usePhoneAccess>;

/** The phones paired with this Mac, as rows of the device list. */
export function PairedPhones({ phone }: { phone: PhoneAccess }) {
  return (
    <>
      {phone.status?.devices.map((device) => (
        <DeviceRow
          key={device.id}
          name={device.name}
          connected={device.connected}
          lastSeenMs={device.lastSeenMs}
          createdMs={device.createdMs}
          onRevoke={() => void phone.run(() => api.mobileRevokeDevice(device.id))}
        />
      ))}
    </>
  );
}

/** The last row of the device list: connect another one — a phone — by
 * scanning a QR code this shows. */
export function ConnectDeviceRow({ phone }: { phone: PhoneAccess }) {
  return (
    <Row
      icon={QrCode}
      title="Connect a device"
      sub={
        phone.status?.enabled
          ? "Scan a QR code with your phone's camera. It remembers this Mac after that."
          : "Shows a QR code to scan with your phone's camera, and turns phone access on."
      }
      control={
        <button
          type="button"
          disabled={phone.busy}
          onClick={() => void phone.connect()}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          {phone.busy && <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />}
          Connect device
        </button>
      }
    />
  );
}

/** How phones reach this Mac, under the device list. */
export function PhoneAccessSettings({ phone }: { phone: PhoneAccess }) {
  const { status, busy, run } = phone;
  return (
    <div className="mt-8">
      <h2 className="text-[13px] font-semibold text-[var(--ink)]">Phone access</h2>
      <p className="mt-1 mb-3 max-w-[660px] text-[13px] leading-relaxed text-[var(--muted)]">
        From a connected phone you can see your sessions, send messages, stop agents and answer
        prompts. The agents keep running on this Mac.
      </p>
      {status && (
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
          {status.enabled && (
            <PublicLinkRow
              status={status}
              busy={busy}
              onSet={(on) => void run(() => api.mobileSetPublic(on))}
            />
          )}
        </Card>
      )}
      {phone.problem && (
        <div className="mt-2 text-[12px] text-[var(--danger)]">{phone.problem}</div>
      )}
    </div>
  );
}

/** The pairing QR code, while "Connect a device" has it open. */
export function PhoneConnectDialog({ phone }: { phone: PhoneAccess }) {
  if (!phone.connecting || !phone.status) return null;
  return (
    <ConnectDialog status={phone.status} onStatus={phone.setStatus} onClose={phone.closeConnect} />
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
    sub =
      "Tailscale isn't installed on this Mac. Install it and sign in — with the public link, your phone doesn't need it.";
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
  } else if (status.tailnetUrl) {
    sub = (
      <>
        Reachable from your tailnet at{" "}
        <span className="font-mono text-[var(--ink)]">
          {status.tailnetUrl.replace("https://", "")}
        </span>
        <PreviewNote status={status} />
      </>
    );
  } else if (ts.portConflict) {
    sub = `Another tailscale serve entry already uses port ${status.port} on this Mac.`;
  } else {
    const fix = status.error ? adminFix(status.error) : null;
    sub = (
      <>
        {fix?.text ??
          "Tailscale is ready; egant still needs to publish itself with tailscale serve."}
        {!fix?.url && <CopyLine text={status.serveCommand} title="Copy command" />}
      </>
    );
    if (fix?.url) action = <LinkButton url={fix.url}>{fix.label}</LinkButton>;
  }
  return (
    <Row
      icon={Network}
      title={
        <span className="flex items-center gap-1.5">
          Tailscale
          {ts.running && status.tailnetUrl && (
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

/** The public link: Tailscale Funnel puts this Mac's Tailscale name on the
 * internet, so a phone opens egant from any network with nothing installed.
 * Pairing still decides who gets in. */
function PublicLinkRow({
  status,
  busy,
  onSet,
}: {
  status: MobileStatus;
  busy: boolean;
  onSet: (on: boolean) => void;
}) {
  const now = useNow(30_000);
  const link = status.public;
  const ts = status.tailscale;
  const tailscaleReady = ts.installed && ts.running && ts.httpsEnabled;
  const fix = link.error ? adminFix(link.error) : null;
  let sub: ReactNode;
  if (link.live && link.url) {
    const fresh = link.openedMs != null && now - link.openedMs < FRESH_LINK_MS;
    sub = (
      <>
        <CopyLine text={link.url} title="Copy link" />
        <span className="mt-1 block">
          Anyone can open it; only phones you pair get in.
          {fresh && " A new address can take a few minutes to reach phones."}
        </span>
        <PreviewNote status={status} />
      </>
    );
  } else if (fix) {
    sub = (
      <>
        {fix.text}
        {!fix.url && <CopyLine text={link.command} title="Copy command" />}
      </>
    );
  } else if (!tailscaleReady) {
    sub = "Needs Tailscale ready on this Mac (above). Your phone doesn't need it.";
  } else if (ts.funnelBlocked) {
    sub = "Funnel's ports (443, 8443 and 10000) are all used by other tailscale serve entries on this Mac.";
  } else if (link.on) {
    sub = "Closed outside egant. Start opens it again.";
  } else {
    sub =
      "Off. Reach this Mac from any network with nothing to install on your phone, through Tailscale Funnel.";
  }
  return (
    <Row
      icon={Globe}
      title={
        <span className="flex items-center gap-1.5">
          Public link
          {link.live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Live" />}
        </span>
      }
      sub={sub}
      control={
        <div className="flex shrink-0 items-center gap-2">
          {fix?.url && !link.live && <LinkButton url={fix.url}>{fix.label}</LinkButton>}
          <button
            type="button"
            disabled={busy || (!link.live && !tailscaleReady)}
            onClick={() => onSet(!link.live)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-45"
          >
            {busy && <Loader2 size={12} strokeWidth={2} className="animate-spin" />}
            {link.live ? "Stop" : "Start"}
          </button>
        </div>
      }
    />
  );
}

/** What stops the phone opening a website your agent runs on this Mac (the
 * preview, on a port beside the link). It has a line only when something is
 * wrong: working, it has nothing to say. */
function PreviewNote({ status }: { status: MobileStatus }) {
  const error = status.preview.error;
  if (!error) return null;
  return <span className="mt-1 block text-[var(--danger)]">{error}</span>;
}

/** A Tailscale refusal ends with the admin page that turns on what's
 * missing. That link is the useful part: a button, not a URL mid-sentence. */
function adminFix(message: string): { text: string; url: string | null; label: string } {
  const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(message)?.[0] ?? null;
  if (!url) return { text: message, url: null, label: "" };
  return {
    text: `${message.replace(url, "").replace(/[\s:]+$/, "")}.`,
    url,
    label: url.includes("/f/funnel") ? "Turn on Funnel" : "Open Tailscale",
  };
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

/** A command to run by hand, or a link to pass on, with a copy button. */
function CopyLine({ text, title }: { text: string; title: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <span className="mt-1.5 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink)]">
        {text}
      </code>
      <button
        type="button"
        title={title}
        onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
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
    <div className="flex items-center gap-3.5 px-4 py-3.5">
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

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/** The pairing QR code: scan it and the phone is in. Carries the public link
 * when it's open; offers to open it when the phone would otherwise need
 * Tailscale, or couldn't reach this Mac at all. Closes itself once a phone
 * pairs with it. */
function ConnectDialog({
  status,
  onStatus,
  onClose,
}: {
  status: MobileStatus;
  onStatus: (status: MobileStatus) => void;
  onClose: () => void;
}) {
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const now = useNow(1000);
  const known = useRef(new Set(status.devices.map((device) => device.id)));

  const issue = useCallback(async () => {
    setError(null);
    try {
      setPairing(await api.mobileCreatePairing());
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);

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

  // The code only ever travels with the public link: it's the one address a
  // phone reaches with nothing installed. So connecting a phone opens it,
  // and a refusal (Funnel not turned on yet, say) shows here with its fix.
  const openPublic = async () => {
    setOpening(true);
    setOpenError(null);
    try {
      const next = await api.mobileSetPublic(true);
      onStatus(next);
      if (next.public.live) await issue();
      else setOpenError(next.public.error ?? "The public link didn't open.");
    } catch (failure) {
      setOpenError(messageOf(failure));
    } finally {
      setOpening(false);
    }
  };

  const ts = status.tailscale;
  const tailscaleReady = ts.installed && ts.running && ts.httpsEnabled;

  // On open: a code at once when the public link is up, else open it first.
  // Without Tailscale ready on this Mac there's nothing to open yet — the
  // dialog names that step instead.
  useEffect(() => {
    if (status.public.live) void issue();
    else if (tailscaleReady && !ts.funnelBlocked) void openPublic();
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const remaining = pairing ? Math.max(0, pairing.expiresAtMs - now) : 0;
  const expired = pairing != null && remaining === 0;
  const clock = `${Math.floor(remaining / 60_000)}:${String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")}`;
  const fresh =
    pairing?.public === true &&
    status.public.openedMs != null &&
    now - status.public.openedMs < FRESH_LINK_MS;
  const fix = openError ? adminFix(openError) : null;

  const openButton = (label: string) => (
    <button
      type="button"
      onClick={() => void openPublic()}
      className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90"
    >
      <Globe size={12} strokeWidth={2.5} />
      {label}
    </button>
  );

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
              Scan with your phone's camera. Nothing to install on the phone — it opens egant
              over this Mac's public link.
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
          ) : opening || (status.public.live && !pairing) ? (
            <div className="flex h-[232px] flex-col items-center justify-center gap-2 text-[12px] text-[var(--muted)]">
              <Loader2 size={18} strokeWidth={2} className="animate-spin text-[var(--faint)]" />
              {opening && "Opening the public link…"}
            </div>
          ) : pairing?.qrSvg && !expired ? (
            <img
              alt="Pairing QR code"
              src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
              className="h-[232px] w-[232px] rounded-xl"
            />
          ) : (
            <div className="flex h-[232px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--border)] px-5 text-center text-[12px] leading-[1.5] text-[var(--muted)]">
              {expired ? (
                "This code has expired."
              ) : !ts.installed ? (
                <>
                  Install Tailscale on this Mac and sign in. Your phone doesn't need it.
                  <LinkButton url="https://tailscale.com/download">Get Tailscale</LinkButton>
                </>
              ) : !ts.running ? (
                "Tailscale isn't connected on this Mac. Open it and sign in, then try again."
              ) : !ts.httpsEnabled ? (
                <>
                  Turn on HTTPS certificates for your tailnet, then try again.
                  <LinkButton url="https://login.tailscale.com/admin/dns">
                    Open DNS settings
                  </LinkButton>
                </>
              ) : ts.funnelBlocked ? (
                "Funnel's ports (443, 8443 and 10000) are all used by other tailscale serve entries on this Mac."
              ) : (
                <>
                  Open the public link so your phone can reach this Mac from any network. Anyone
                  can open the address; only phones you pair get in.
                  {!openError && openButton("Open public link")}
                </>
              )}
            </div>
          )}

          {openError && !opening && (
            <div className="mt-3 flex flex-col items-center gap-2 text-center text-[12px] text-[var(--danger)]">
              {fix?.text}
              <div className="flex items-center gap-2">
                {fix?.url && <LinkButton url={fix.url}>{fix.label}</LinkButton>}
                {openButton("Try again")}
              </div>
            </div>
          )}

          {pairing && !paired && !opening && (
            <>
              <div className="mt-4 text-[11px] text-[var(--faint)]">Or enter this code on your phone</div>
              <div className="mt-1 font-mono text-[18px] tracking-[0.12em] text-[var(--ink)]">
                {pairing.code}
              </div>
              <div className="mt-1 text-[11px] text-[var(--faint)]">
                {expired ? "Expired" : `Works once · expires in ${clock}`}
              </div>
              {pairing.url && !expired && (
                <div
                  className="mt-3 max-w-full truncate font-mono text-[10.5px] text-[var(--faint)]"
                  title={pairing.url}
                >
                  {pairing.url.split("#")[0]}
                </div>
              )}
              {fresh && !expired && (
                <div className="mt-1 text-center text-[11px] text-[var(--faint)]">
                  Just opened — the address can take a few minutes to reach phones.
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
            onClick={() => void (status.public.live ? issue() : openPublic())}
            disabled={paired != null || opening || !tailscaleReady}
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
