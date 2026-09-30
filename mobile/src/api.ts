// The phone's side of `src-tauri/src/mobile/server.rs`. Same origin as the
// page, so the device cookie rides along on its own; every request also names
// this page load, which is how the server tells a write from a cross-site
// forgery and how this page recognises its own changes coming back.

import type {
  AgentModel,
  DecisionResponse,
  PendingPermission,
  SessionUsage,
  TranscriptDto,
  TurnState,
} from "@egant/lib/types";

/** One page load. Its writes come back on the event stream tagged with it. */
export const CLIENT_ID = newClientId();
export const MY_ORIGIN = `client:${CLIENT_ID}`;

function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A session in the list — `SessionRowDto` in `mobile/dto.rs`. */
export interface MobileSession {
  id: number;
  title: string;
  projectId: number;
  projectName: string;
  projectHue: number;
  agent: string;
  kind: "chat" | "cli";
  branch: string | null;
  worktree: { branch: string; name: string } | null;
  /** The model the agent last reported, else the one it started on. */
  model: string | null;
  /** The catalog id it asked for; `null` is the CLI's default. */
  requestedModel: string | null;
  variant: string | null;
  permissionMode: string;
  state: TurnState;
  busy: boolean;
  pendingCount: number;
  ended: boolean;
  resumable: boolean;
  startedUnixMs: number;
  lastActivityMs: number;
}

/** What a chat's "Run website" pill offers — `GET /sessions/{id}/run`. Read
 * from the project's manifests and from what is listening on the Mac, never
 * from anything the phone said. */
export interface RunInfo {
  /** The command the project runs with; `null` when nothing on disk says. */
  run: { label: string; command: string; source: string } | null;
  /** This chat's site, answering on the Mac right now. */
  site: { port: number } | null;
}

/** What a tapped link asks the Mac to open: a port the chat's own reply named
 * (the Mac only agrees to ports it found for that chat) and where on the site
 * to land. Neither means the chat's site, at its front page. */
export interface PreviewTarget {
  port?: number;
  path?: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The link on the host this page was opened at, when both are this Mac's
 * own loopback name — trying the phone app in a desktop browser through a dev
 * server, say. The frame and the app must be one site for the frame's cookie
 * to be sent, and a cookie for `127.0.0.1` is not sent to `localhost`. Over
 * Tailscale both are the same name already, and nothing changes. */
export function onThisHost(link: string): string {
  try {
    const url = new URL(link);
    const here = window.location.hostname;
    if (LOOPBACK_HOSTS.includes(url.hostname) && LOOPBACK_HOSTS.includes(here) && url.hostname !== here) {
      url.hostname = here;
      return url.toString();
    }
  } catch {
    // Not a link this can read: the frame will say so.
  }
  return link;
}

/** A project a new chat can run in — `ProjectRowDto`. */
export interface MobileProject {
  id: number;
  name: string;
  hue: number;
}

/** A chat agent, and whether the Mac has it. */
export interface MobileAgent {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
}

export interface MobileState {
  epoch: string;
  seq: number;
  machineName: string;
  device: { id: string; name: string };
  sessions: MobileSession[];
  projects: MobileProject[];
  /** The agent the Mac starts new sessions with. */
  defaultAgent: string;
  /** Version of the Mac's wallpaper, or `null` when it has none. */
  wallpaper: string | null;
}

export interface NewChat {
  projectId: number;
  agent: string;
  model: string | null;
  variant: string | null;
  mode: string;
  text: string;
}

/** A window of one transcript (`TranscriptWindowDto`): the window's own
 * transcript shape, plus where it sits and the stream position it matches. */
export interface TranscriptWindow extends TranscriptDto {
  epoch: string;
  seq: number;
  start: number;
  total: number;
  pendingList: PendingPermission[];
  usage: SessionUsage;
  decisionResponses: Record<string, DecisionResponse>;
}

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the Mac could not be reached at all. */
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** Nothing answered, or the proxy in front of egant did because egant
   * itself didn't: the Mac is asleep or offline, egant is closed, or phone
   * access is off. */
  get unreachable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Egant-Client": CLIENT_ID,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach your Mac.");
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const failure = (await response.json()) as { error?: string };
      if (failure.error) message = failure.error;
    } catch {
      // Not JSON (a proxy's error page): the status line will do.
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as T;
}

export const api = {
  /** Whether egant answers, and whether it still knows this phone. */
  health: () => request<{ app: string; paired: boolean }>("GET", "/api/v1/health"),
  pair: (code: string) =>
    request<{ device: { id: string; name: string } }>("POST", "/api/v1/pair", { code }),
  unpair: () => request<{ ok: boolean }>("POST", "/api/v1/unpair"),
  state: () => request<MobileState>("GET", "/api/v1/state"),
  transcript: (id: number, before?: number, limit = 60) =>
    request<TranscriptWindow>(
      "GET",
      `/api/v1/sessions/${id}/transcript?limit=${limit}${before === undefined ? "" : `&before=${before}`}`,
    ),
  send: (id: number, text: string) =>
    request<{ title: string | null }>("POST", `/api/v1/sessions/${id}/messages`, { text }),
  interrupt: (id: number) => request<{ ok: boolean }>("POST", `/api/v1/sessions/${id}/interrupt`),
  runInfo: (id: number) => request<RunInfo>("GET", `/api/v1/sessions/${id}/run`),
  /** A link, good once and for a minute, that opens the chat's running site —
   * or the page a link in the chat named — on a port of its own, not this
   * page's origin. The app shows it in a frame; a browser tab can take it too. */
  openPreview: async (id: number, target: PreviewTarget = {}) => {
    const link = await request<{ url: string; port: number }>(
      "POST",
      `/api/v1/sessions/${id}/preview`,
      target,
    );
    return { ...link, url: onThisHost(link.url) };
  },
  agents: () => request<MobileAgent[]>("GET", "/api/v1/agents"),
  models: (agent: string) =>
    request<AgentModel[]>("GET", `/api/v1/agents/${encodeURIComponent(agent)}/models`),
  /** Starts a chat and sends its first message. `error` is set when the
   * session started but the message did not go out. */
  createSession: (chat: NewChat) =>
    request<{ id: number; title: string | null; error: string | null; session: MobileSession | null }>(
      "POST",
      "/api/v1/sessions",
      chat,
    ),
  setModel: (id: number, model: string | null, variant: string | null) =>
    request<{ session: MobileSession | null }>("POST", `/api/v1/sessions/${id}/model`, {
      model,
      variant,
    }),
  setMode: (id: number, mode: string) =>
    request<{ permissionMode: string }>("POST", `/api/v1/sessions/${id}/mode`, { mode }),
  answerPermission: (id: number, requestId: string, decision: "allow" | "allow-always" | "deny") =>
    request<{ permissionMode: string | null }>(
      "POST",
      `/api/v1/sessions/${id}/permissions/${encodeURIComponent(requestId)}`,
      { decision },
    ),
  answerDecision: (id: number, decisionId: string, response: DecisionResponse, text: string) =>
    request<{ title: string | null }>(
      "POST",
      `/api/v1/sessions/${id}/decisions/${encodeURIComponent(decisionId)}`,
      { response, text },
    ),
};

/** The Mac's wallpaper, addressed by version so the phone caches it. */
export function wallpaperUrl(version: string): string {
  return `/api/v1/wallpaper?v=${encodeURIComponent(version)}`;
}
