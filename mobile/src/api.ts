// The phone's side of `src-tauri/src/mobile/server.rs`. Same origin as the
// page, so the device cookie rides along on its own; every request also names
// this page load, which is how the server tells a write from a cross-site
// forgery and how this page recognises its own changes coming back.

import type {
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
  model: string | null;
  permissionMode: string;
  state: TurnState;
  busy: boolean;
  pendingCount: number;
  ended: boolean;
  resumable: boolean;
  startedUnixMs: number;
  lastActivityMs: number;
}

export interface MobileState {
  epoch: string;
  seq: number;
  machineName: string;
  device: { id: string; name: string };
  sessions: MobileSession[];
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
