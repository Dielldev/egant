// What each permission mode means to each chat agent. Kept apart from the
// desktop's mode picker so the phone app can say the same thing.

/** The four modes the picker cycles through with number-key shortcuts.
 * `bypassPermissions` is deliberately not one of them — see `ModeInfo`. */
export const NUMBERED_MODES = ["auto", "manual", "acceptEdits", "plan"] as const;
export type NumberedMode = (typeof NUMBERED_MODES)[number];

/// Codex has no live approval channel — there's nobody to ask mid-turn — so
/// its "modes" pick a sandbox level up front instead. Auto and Accept edits
/// currently land on the same sandbox, and Manual can't literally "ask" so it
/// falls back to the same read-only sandbox as Plan; both are spelled out
/// rather than left implied.
const CLAUDE_MODE_INFO: Record<NumberedMode, string> = {
  auto: "Claude handles permission decisions.",
  manual: "Always ask before making changes.",
  acceptEdits: "Automatically accept all file edits.",
  plan: "Create a plan before making changes.",
};

const CODEX_MODE_INFO: Record<NumberedMode, string> = {
  auto: "Workspace-write sandbox — can edit files in this project, nothing outside it.",
  manual: "No live approval channel here, so this reads the project without changing it.",
  acceptEdits: "Same sandbox as Auto for Codex — there's no separate ask-first step.",
  plan: "Read-only sandbox — can look around, can't write files or run mutating commands.",
};

const OPENCODE_MODE_INFO: Record<NumberedMode, string> = {
  auto: "opencode decides per its own permission config; asks only what that config says to ask.",
  manual: "No live approval channel here, so this reads the same as Auto — nothing to switch to.",
  acceptEdits: "Same as Auto for opencode — there's no separate ask-first step.",
  plan: "Same as Auto for opencode — there's no read-only sandbox to switch into.",
};

// Antigravity is turn-based like Codex and opencode: print mode soft-denies any
// tool confirmation instead of asking, so each mode picks the CLI's own
// `--mode` up front. Manual maps to the default mode, which is the one that
// denies whatever would have needed a confirmation.
const ANTIGRAVITY_MODE_INFO: Record<NumberedMode, string> = {
  auto: "Edits go through; anything that needs a confirmation is declined, because there's nobody to ask mid-turn.",
  manual: "No live approval channel here, so anything that needs a confirmation is declined.",
  acceptEdits: "Same as Auto for Antigravity — file edits are accepted, nothing riskier is.",
  plan: "Plan mode — Antigravity looks around and plans before it changes anything.",
};

/** Agents whose numbered modes (Auto/Manual/Accept edits/Plan) each mean
 * something different to the backend. Anything else falls back to a plain
 * note in the menu — but Bypass permissions (below) always works and is
 * never gated on this map. */
export const MODE_INFO: Partial<Record<string, Record<NumberedMode, string>>> = {
  claude: CLAUDE_MODE_INFO,
  codex: CODEX_MODE_INFO,
  opencode: OPENCODE_MODE_INFO,
  antigravity: ANTIGRAVITY_MODE_INFO,
};
