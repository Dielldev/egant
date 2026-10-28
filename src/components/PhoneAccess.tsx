import { listen } from "@tauri-apps/api/event";
import {
  Check,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  Monitor,
  Network,
  Pencil,
  QrCode,
  Radio,
  RefreshCw,
  Smartphone,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import { hostDeviceCapitalized, hostDeviceLabel } from "../lib/platform";
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

// ---------------------------------------------------------------------------
// 1. Phone Companion Spotlight Card
// ---------------------------------------------------------------------------

/** Clean, high-craft spotlight introducing the phone companion feature
 * without gaudy mockups or marketing clutter. */
export function PhoneCompanionCard({ phone }: { phone: PhoneAccess }) {
  const pairedCount = phone.status?.devices.length ?? 0;

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-start gap-4 min-w-0 flex-1">
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--stage)] text-[var(--ink)]">
            <Smartphone size={20} strokeWidth={1.8} />
            {pairedCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold text-[var(--ink)]">Phone Companion</span>
              {pairedCount > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  {pairedCount} {pairedCount === 1 ? "device" : "devices"} paired
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--stage)] px-2 py-0.5 text-[11px] text-[var(--muted)]">
                  Zero install · Browser based
                </span>
              )}
            </div>

            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted)] max-w-[580px]">
              Control egant from any smartphone browser. Follow active agent sessions, approve tool
              executions, answer prompts, and preview your localhost web servers away from your desk.
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-[var(--faint)]">
              <span className="flex items-center gap-1.5">
                <Radio size={12} className="text-[var(--accent)]" />
                <span>Live agent stream</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Check size={12} className="text-emerald-400" />
                <span>One-tap tool approvals</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Globe size={12} className="text-blue-400" />
                <span>Localhost web preview</span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex sm:flex-col items-center sm:items-end gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void phone.connect()}
            disabled={phone.busy}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-2 text-[12px] font-semibold text-[var(--stage)] hover:opacity-90 active:scale-[0.98] transition disabled:opacity-50 shadow-sm"
          >
            {phone.busy ? (
              <Loader2 size={13} strokeWidth={2.5} className="animate-spin" />
            ) : (
              <QrCode size={13} strokeWidth={2.5} />
            )}
            <span>{pairedCount > 0 ? "Pair another phone" : "Pair your phone"}</span>
          </button>

          {phone.status?.localUrl && (
            <button
              type="button"
              onClick={() => void api.openUrl(phone.status!.localUrl)}
              className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--hover)] transition"
            >
              <ExternalLink size={11} strokeWidth={2} />
              <span>Try in desktop browser</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Hardware Fleet / Connected Nodes
// ---------------------------------------------------------------------------

/** Host Mac/PC row within the Linked Devices card. */
export function HostDeviceRow({
  name,
  editing,
  draft,
  onStartEdit,
  onChangeDraft,
  onSaveEdit,
  onCancelEdit,
  os,
  version,
  deviceId,
  addedAt,
  now,
  enginePort,
  engineRunning,
}: {
  name: string;
  editing: boolean;
  draft: string;
  onStartEdit: () => void;
  onChangeDraft: (val: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  os: string;
  version: string;
  deviceId: string;
  addedAt: number;
  now: number;
  enginePort?: number;
  engineRunning: boolean;
}) {
  const [copiedId, setCopiedId] = useState(false);

  const copyId = () => {
    void navigator.clipboard.writeText(deviceId).then(() => {
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    });
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 px-4 py-3.5">
      <div className="flex items-center gap-3.5 min-w-0 flex-1">
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)]">
          <Monitor size={16} strokeWidth={2} />
          <span className="absolute -top-1 -right-1 flex h-2 w-2">
            <span
              className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"
              title="Active host"
            />
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => onChangeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSaveEdit();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      onCancelEdit();
                    }
                  }}
                  onBlur={onSaveEdit}
                  className="w-full max-w-[220px] rounded border border-[var(--accent)] bg-[var(--stage)] px-2 py-0.5 text-[13px] font-semibold text-[var(--ink)] outline-none"
                />
                <button
                  type="button"
                  onClick={onSaveEdit}
                  className="cursor-pointer rounded bg-[var(--ink)] px-2 py-0.5 text-[11px] font-medium text-[var(--stage)]"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  className="cursor-pointer rounded px-2 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</span>
                <button
                  type="button"
                  onClick={onStartEdit}
                  title="Rename this device"
                  className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] transition-colors"
                >
                  <Pencil size={11} strokeWidth={2} />
                  Rename
                </button>
              </>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center text-[12px] text-[var(--faint)]">
            <span>{os}</span>
            <Dot />
            <span>v{version}</span>
            <Dot />
            <button
              type="button"
              onClick={copyId}
              title="Copy device ID"
              className="inline-flex cursor-pointer items-center gap-1 hover:text-[var(--ink)] transition-colors"
            >
              <span className="font-mono">{deviceId}</span>
              {copiedId ? <Check size={10} className="text-emerald-400" /> : <Copy size={10} />}
            </button>
            <Dot />
            <span>Added {ago(addedAt, now)}</span>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 text-[12px]">
        {engineRunning ? (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Port {enginePort ?? 1421}
          </span>
        ) : (
          <span className="text-[var(--faint)]">Engine inactive</span>
        )}
        <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
          {hostDeviceCapitalized()}
        </span>
      </div>
    </div>
  );
}

/** The phones paired with this Mac, rendered as rows in the device list. */
export function PairedPhones({ phone }: { phone: PhoneAccess }) {
  const devices = phone.status?.devices ?? [];
  if (devices.length === 0) return null;

  return (
    <>
      {devices.map((device) => (
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

/** Individual paired device row. */
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
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)]">
        <Smartphone size={16} strokeWidth={2} />
        {connected && (
          <span className="absolute -top-1 -right-1 flex h-2 w-2">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" title="Connected" />
          </span>
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</span>
          {connected && (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-400">
              Active
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-[var(--faint)]">
          {connected ? (
            <span className="text-emerald-400">Connected now</span>
          ) : (
            <span>Last seen {ago(lastSeenMs, now)}</span>
          )}
          <Dot />
          <span>Paired {ago(createdMs, now)}</span>
        </div>
      </div>

      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-[12px] text-[var(--muted)]">Disconnect {name}?</span>
          <button
            type="button"
            onClick={onRevoke}
            className="cursor-pointer rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1 text-[12px] text-[var(--danger)] hover:opacity-85 transition"
          >
            Disconnect
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="cursor-pointer rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] transition"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[rgba(224,112,112,0.1)] hover:text-[var(--danger)] transition"
        >
          Disconnect
        </button>
      )}
    </div>
  );
}

/** The last row of the device list: connect another phone by scanning a QR code. */
export function ConnectDeviceRow({ phone }: { phone: PhoneAccess }) {
  return (
    <Row
      icon={QrCode}
      title="Link a companion phone"
      sub={
        phone.status?.enabled
          ? `Scan a pairing QR code with your phone camera. It remembers ${hostDeviceLabel()} after pairing.`
          : `Shows a pairing QR code to scan with your phone camera, and turns phone access on.`
      }
      control={
        <button
          type="button"
          disabled={phone.busy}
          onClick={() => void phone.connect()}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-50 transition"
        >
          {phone.busy && <Loader2 size={12} strokeWidth={2.5} className="animate-spin" />}
          Pair via QR
        </button>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// 3. Remote Access & Networking Hub
// ---------------------------------------------------------------------------

/** Remote Access & Networking settings under the device list. */
export function PhoneAccessSettings({ phone }: { phone: PhoneAccess }) {
  const { status, busy, run } = phone;

  return (
    <div className="mt-8">
      <h2 className="text-[13px] font-semibold text-[var(--ink)]">Remote Access &amp; Networking</h2>
      <p className="mt-1 mb-3 max-w-[660px] text-[13px] leading-relaxed text-[var(--muted)]">
        How companion devices reach {hostDeviceLabel()}. Tailscale carries the encrypted session stream;
        the public link allows access from any cellular or Wi-Fi network with zero phone configuration.
      </p>

      {status && (
        <Card>
          <Row
            icon={Radio}
            title="Allow phone connections"
            sub={
              status.enabled
                ? status.running
                  ? `Listening locally on port ${status.port}. Tailscale carries the encrypted stream to your phone.`
                  : (status.error ?? "Starting listener…")
                : `Off — remote phone connections to ${hostDeviceLabel()} are blocked.`
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
    sub = `Tailscale isn't installed on ${hostDeviceLabel()}. Install it and sign in — with the public link, your phone doesn't need it.`;
    action = <LinkButton url="https://tailscale.com/download">Get Tailscale</LinkButton>;
  } else if (!ts.running) {
    sub =
      ts.backendState === "NeedsLogin"
        ? `Tailscale is installed on ${hostDeviceLabel()} but signed out. Open it and sign in.`
        : `Tailscale isn't connected${ts.backendState ? ` (${ts.backendState})` : ""}. Open it and turn it on.`;
  } else if (!ts.httpsEnabled) {
    sub = `Connected as ${ts.dnsName ?? hostDeviceLabel()}. Turn on HTTPS certificates for your tailnet (in DNS settings), then recheck.`;
    action = (
      <LinkButton url="https://login.tailscale.com/admin/dns">Open DNS settings</LinkButton>
    );
  } else if (status.tailnetUrl) {
    sub = (
      <>
        Reachable on your tailnet at{" "}
        <span className="font-mono text-[var(--ink)]">
          {status.tailnetUrl.replace("https://", "")}
        </span>
        <PreviewNote status={status} />
      </>
    );
  } else if (ts.portConflict) {
    sub = `Another tailscale serve entry already uses port ${status.port} on ${hostDeviceLabel()}.`;
  } else {
    const fix = status.error ? adminFix(status.error) : null;
    sub = (
      <>
        {fix?.text ?? "Tailscale is ready; egant still needs to publish itself with tailscale serve."}
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
          Tailscale Mesh
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
            title="Check Tailscale status and configure serve"
            disabled={busy}
            onClick={onRecheck}
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-50 transition"
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

/** The public link: Tailscale Funnel in front of phone access. */
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
        <CopyLine text={link.url} title="Copy link" onOpen={() => void api.openUrl(link.url!)} />
        <span className="mt-1 block">
          Reachable from any cellular or Wi-Fi network. Only phones you pair with a QR code can enter.
          {fresh && " (A newly opened address can take a few minutes to reach phones via DNS.)"}
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
    sub = `Needs Tailscale connected on ${hostDeviceLabel()} (above). Your phone doesn't need Tailscale installed.`;
  } else if (ts.funnelBlocked) {
    sub = `Funnel's ports (443, 8443 and 10000) are all used by other tailscale serve entries on ${hostDeviceLabel()}.`;
  } else if (link.on) {
    sub = "Closed outside egant. Start opens it again.";
  } else {
    sub = `Off. Reach ${hostDeviceLabel()} from any network with nothing to install on your phone, through Tailscale Funnel.`;
  }

  return (
    <Row
      icon={Globe}
      title={
        <span className="flex items-center gap-1.5">
          Public internet link
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
            className="flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-45 transition"
          >
            {busy && <Loader2 size={12} strokeWidth={2} className="animate-spin" />}
            {link.live ? "Stop" : "Start"}
          </button>
        </div>
      }
    />
  );
}

/** What stops the phone opening a website your agent runs on this Mac. */
function PreviewNote({ status }: { status: MobileStatus }) {
  const error = status.preview.error;
  if (!error) return null;
  return <span className="mt-1 block text-[11.5px] text-[var(--danger)]">{error}</span>;
}

/** A Tailscale refusal ends with the admin page that turns on what's missing. */
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
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--hover)] transition"
    >
      {children}
      <ExternalLink size={11} strokeWidth={2} />
    </button>
  );
}

/** A command to run by hand, or a link to pass on, with a copy button. */
function CopyLine({
  text,
  title,
  onOpen,
}: {
  text: string;
  title: string;
  onOpen?: () => void;
}) {
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
        className="shrink-0 cursor-pointer text-[var(--faint)] hover:text-[var(--ink)] transition"
      >
        {copied ? <Check size={12} strokeWidth={2} className="text-emerald-400" /> : <Copy size={12} strokeWidth={2} />}
      </button>
      {onOpen && (
        <button
          type="button"
          title="Open in browser"
          onClick={onOpen}
          className="shrink-0 cursor-pointer text-[var(--faint)] hover:text-[var(--ink)] transition"
        >
          <ExternalLink size={12} strokeWidth={2} />
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 4. Pairing Modal Dialog
// ---------------------------------------------------------------------------

/** The pairing QR code, while "Connect a device" has it open. */
export function PhoneConnectDialog({ phone }: { phone: PhoneAccess }) {
  if (!phone.connecting || !phone.status) return null;
  return (
    <ConnectDialog status={phone.status} onStatus={phone.setStatus} onClose={phone.closeConnect} />
  );
}

/** The pairing QR code modal: scan it and the phone is in. */
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
  const [copiedCode, setCopiedCode] = useState(false);
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

  useEffect(() => {
    if (status.public.live) void issue();
    else if (tailscaleReady && !ts.funnelBlocked) void openPublic();
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

  const copyCode = () => {
    if (!pairing?.code) return;
    void navigator.clipboard.writeText(pairing.code).then(() => {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1400);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[390px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--stage)] shadow-2xl transition-all"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--card)] text-[var(--ink)]">
              <Smartphone size={17} strokeWidth={2} />
            </span>
            <div>
              <div className="text-[14px] font-semibold text-[var(--ink)]">Pair Mobile Companion</div>
              <div className="text-[11.5px] text-[var(--muted)]">Opens directly in Safari or Chrome</div>
            </div>
          </div>
          <button
            type="button"
            title="Close"
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)] transition"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex flex-col items-center px-6 py-5">
          {paired ? (
            <div className="flex h-[230px] flex-col items-center justify-center gap-2.5 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
                <Check size={24} strokeWidth={2.5} />
              </span>
              <div>
                <div className="text-[14px] font-semibold text-[var(--ink)]">{paired} is paired!</div>
                <div className="mt-0.5 text-[12px] text-[var(--muted)]">Connecting live agent stream…</div>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-[230px] flex-col items-center justify-center gap-2.5 text-center">
              <div className="text-[12px] text-[var(--danger)]">{error}</div>
              <button
                type="button"
                onClick={() => void issue()}
                className="cursor-pointer rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)]"
              >
                Try again
              </button>
            </div>
          ) : opening || (status.public.live && !pairing) ? (
            <div className="flex h-[230px] flex-col items-center justify-center gap-2 text-[12px] text-[var(--muted)]">
              <Loader2 size={20} strokeWidth={2} className="animate-spin text-[var(--muted)]" />
              <div>{opening ? "Opening public link…" : "Generating code…"}</div>
            </div>
          ) : pairing?.qrSvg && !expired ? (
            <div className="flex flex-col items-center">
              {/* High contrast QR box */}
              <div className="rounded-xl bg-white p-3 shadow-md border border-white/20">
                <img
                  alt="Pairing QR code"
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(pairing.qrSvg)}`}
                  className="h-[190px] w-[190px] rounded-lg"
                />
              </div>

              {/* Countdown badge */}
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--muted)]">
                <Clock size={11} strokeWidth={2} />
                <span>Expires in {clock} · One-time code</span>
              </div>

              {/* Fallback pairing code */}
              <div className="mt-2.5 flex flex-col items-center">
                <span className="text-[11px] text-[var(--faint)]">Or enter code manually:</span>
                <button
                  type="button"
                  onClick={copyCode}
                  title="Click to copy pairing code"
                  className="mt-0.5 flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1 text-[14px] font-mono font-semibold tracking-wider text-[var(--ink)] hover:border-[var(--accent)] transition"
                >
                  <span>{pairing.code}</span>
                  {copiedCode ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                </button>
              </div>

              {fresh && (
                <div className="mt-2 text-center text-[10.5px] text-[var(--faint)] max-w-[280px]">
                  Public link just opened — DNS propagation can take a minute on mobile networks.
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-[230px] w-full flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed border-[var(--border)] p-5 text-center text-[12px] leading-relaxed text-[var(--muted)]">
              {expired ? (
                <>
                  <div className="font-semibold text-[var(--ink)]">Pairing code expired</div>
                  <button
                    type="button"
                    onClick={() => void (status.public.live ? issue() : openPublic())}
                    className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)]"
                  >
                    <RefreshCw size={12} strokeWidth={2.5} />
                    Generate new code
                  </button>
                </>
              ) : !ts.installed ? (
                <>
                  <div>Tailscale isn&apos;t installed on {hostDeviceLabel()}. Install it and sign in — with the public link, your phone doesn&apos;t need it.</div>
                  <LinkButton url="https://tailscale.com/download">Get Tailscale</LinkButton>
                </>
              ) : !ts.running ? (
                `Tailscale isn't connected on ${hostDeviceLabel()}. Open it and sign in, then try again.`
              ) : !ts.httpsEnabled ? (
                <>
                  <div>Turn on HTTPS certificates for your tailnet, then try again.</div>
                  <LinkButton url="https://login.tailscale.com/admin/dns">Open DNS settings</LinkButton>
                </>
              ) : ts.funnelBlocked ? (
                `Funnel ports (443, 8443, 10000) are all used by other entries on ${hostDeviceLabel()}.`
              ) : (
                <>
                  <div>Open the public link so your phone can reach {hostDeviceLabel()} from any network.</div>
                  {!openError && (
                    <button
                      type="button"
                      onClick={() => void openPublic()}
                      className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12px] font-medium text-[var(--stage)]"
                    >
                      <Globe size={12} strokeWidth={2} />
                      Open public link
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          {openError && !opening && (
            <div className="mt-3 flex flex-col items-center gap-2 text-center text-[12px] text-[var(--danger)]">
              <div>{fix?.text}</div>
              <div className="flex items-center gap-2">
                {fix?.url && <LinkButton url={fix.url}>{fix.label}</LinkButton>}
                <button
                  type="button"
                  onClick={() => void openPublic()}
                  className="cursor-pointer rounded-lg bg-[var(--ink)] px-3 py-1 text-[12px] font-medium text-[var(--stage)]"
                >
                  Try again
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Dialog Footer */}
        <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--card)] px-4 py-3">
          <button
            type="button"
            title={`Open companion web app in a browser on ${hostDeviceLabel()}`}
            disabled={!pairing || expired || paired != null}
            onClick={() => pairing && void api.openUrl(pairing.localUrl)}
            className="cursor-pointer rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] transition disabled:opacity-40"
          >
            Try on {hostDeviceLabel()}
          </button>
          <button
            type="button"
            onClick={() => void (status.public.live ? issue() : openPublic())}
            disabled={paired != null || opening || !tailscaleReady}
            className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[12px] font-medium text-[var(--stage)] hover:opacity-90 active:scale-[0.98] transition disabled:opacity-45"
          >
            <RefreshCw size={12} strokeWidth={2.5} />
            New code
          </button>
        </div>
      </div>
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
