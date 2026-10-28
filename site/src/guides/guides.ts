/** Each guide is one section on the page, written as a short, concrete
 * walkthrough. Content mirrors the README and what the app itself tells you. */
export type GuideStep = { strong: string; rest: string };

export type Guide = {
  id: string;
  nav: string;
  tag: string;
  title: string;
  summary: string;
  intro: string;
  steps: GuideStep[];
  note?: string;
};

export const GUIDES: Guide[] = [
  {
    id: "windows-smartscreen",
    nav: "Windows SmartScreen",
    tag: "Windows",
    title: "“egant-setup-x64.exe is a virus” — it isn't. Here's the trick.",
    summary: "What to click when Windows blocks the installer",
    intro:
      "egant isn't notarized with Microsoft yet, so Windows Defender SmartScreen warns about the installer's reputation, not about anything inside it. Same installer, one-time click:",
    steps: [
      {
        strong: "Run the installer anyway.",
        rest: "When the blue “Windows protected your PC” screen appears, don't accept the default button — click More info instead. Clicking OK there just aborts.",
      },
      {
        strong: "Click Run anyway.",
        rest: "The More info link reveals the Run anyway button. The installer then runs like any other; it installs for your user, no admin rights needed.",
      },
      {
        strong: "That's it.",
        rest: "Windows remembers the choice — you won't see SmartScreen again for the next update. egant keeps itself up to date after that.",
      },
    ],
    note:
      "If antivirus software makes a genuine claim about a file you downloaded from this site, compare it against anything on the GitHub releases page and open an issue — but a SmartScreen warning on first run is expected until a release builds up reputation.",
  },
  {
    id: "macos-gatekeeper",
    nav: "macOS “can't verify”",
    tag: "macOS",
    title: "“egant can't be verified” — unblock it once, never again.",
    summary: "Getting past Gatekeeper on Apple Silicon Macs",
    intro:
      "Apple checks every app against a notarization ticket. egant isn't on Apple's books yet, so macOS blocks the first launch even though you intentionally downloaded it:",
    steps: [
      {
        strong: "Open the DMG and drag egant to Applications.",
        rest: "Like any Mac app. Then open it once — you'll get “egant can't verify the developer” and the dialog will only offer Move to Trash. Cancel that.",
      },
      {
        strong: "Open System Settings → Privacy & Security.",
        rest: "Scroll to the Security section. Because you just tried to open egant, there's a notice saying it was blocked — click Open Anyway. Authenticate with Touch ID or your password.",
      },
      {
        strong: "Click Open in the follow-up dialog.",
        rest: "egant launches. macOS remembers this: every future launch (and every auto-update) opens normally.",
      },
    ],
    note:
      "Terminal alternative, if you prefer: `xattr -dr com.apple.quarantine /Applications/egant.app` removes the quarantine flag directly. On Intel Macs or Linux, build from source.",
  },
  {
    id: "connect-agent-cli",
    nav: "Install an agent CLI",
    tag: "Setup",
    title: "egant drives the agents you already have — here's how to get one.",
    summary: "Install and log in to Claude Code, Codex or opencode",
    intro:
      "egant doesn't ship its own AI or its own accounts. It finds the agent CLIs on your machine and gives them a home. Install at least one before first launch — egant shows what it found and which are logged in:",
    steps: [
      {
        strong: "Install a CLI.",
        rest: "For Claude Code: `npm install -g @anthropic-ai/claude-code`. For opencode: `npm install -g opencode-ai`. Each agent's own README has the exact command; egant just needs the binary on your PATH.",
      },
      {
        strong: "Log in.",
        rest: "Run `claude login` (or the equivalent) once in a terminal. egant reuses that login, your own git and your own gh — it never asks for API keys.",
      },
      {
        strong: "Pick a project on egant's launch screen.",
        rest: "egant lists the agents it detected per project, choosing a model is one dropdown, and you're in a session.",
      },
    ],
  },
  {
    id: "phone-tailscale",
    nav: "Tailscale & phone",
    tag: "Remote access",
    title: "Follow a session from your phone, over your own tailnet.",
    summary: "Pair the phone client with the desktop app",
    intro:
      "The desktop serves a small phone client, and Tailscale is what carries the connection from anywhere. egant itself only ever listens on 127.0.0.1 — nothing is exposed to the network directly:",
    steps: [
      {
        strong: "Install Tailscale and sign in.",
        rest: "On your computer (tailscale.com/download) and on your phone, sign in with the same account. Everything stays inside your tailnet.",
      },
      {
        strong: "Turn on HTTPS certificates.",
        rest: "In Tailscale's DNS settings (login.tailscale.com/admin/dns), enable HTTPS certificates for your tailnet if it isn't already. egant links you there from the pairing dialog when it's needed.",
      },
      {
        strong: "Open Settings → Devices and click Connect device.",
        rest: "This turns phone access on and sets up tailscale serve. If the public link (Tailscale Funnel) isn't open yet, the dialog offers Open public link — that's what lets the phone reach you from any network.",
      },
      {
        strong: "Scan the QR code with your phone's camera.",
        rest: "If you can't scan, type the code shown underneath instead. A code works once and expires after five minutes — hit New code for another.",
      },
    ],
    note:
      "The phone appears under Settings → Devices and remembers your computer; Allow phone connections in the same panel turns access off, and revoking a device disconnects it. The phone is read-mostly: chats, switching models and answering prompts — it can't browse files, open a terminal or run git.",
  },
  {
    id: "updates",
    nav: "Updates",
    tag: "Staying current",
    title: "egant updates itself — what that actually means.",
    summary: "Auto-updates and what to do if one is offered mid-session",
    intro:
      "You don't re-download anything. The app ships an updater and checks for new releases on its own schedule:",
    steps: [
      {
        strong: "Updates arrive in the app.",
        rest: "egant downloads the new version in the background and applies it the next time the app starts. No emails, no site visits, no manual installers.",
      },
      {
        strong: "Unblock only once.",
        rest: "That's why the SmartScreen and Gatekeeper steps above are one-time: updates reuse the trust macOS and Windows already gave the app, on both sides of the process.",
      },
      {
        strong: "Everything else follows along.",
        rest: "Themes, MCP library and per-agent configs are versioned alongside, so an update doesn't disturb what you set up.",
      },
    ],
    note:
      "On Windows the same updater writes into your user folder, so no admin prompt appears. A release mid-session never interrupts the running agent — the update is applied at the next full restart.",
  },
];
