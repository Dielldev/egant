// How the "Run" pill knows what to run.
//
// Reads the project's own manifests out of the session's working directory
// (which is the worktree's path when the session has one) and picks the
// command a person would type to see their work: `npm run dev`, `cargo run,
// `go run .`, and so on. Frontend-only — it reuses the panel's `list_dir` /
// `read_file`, so no new Tauri command is needed.

import { api } from "./api";

export interface RunCommand {
  /** What the pill says: "Run website", "Run project". */
  label: string;
  /** The exact shell line the terminal gets, without the trailing newline. */
  command: string;
  /** Which manifest it came from (`package.json`, `Cargo.toml`, …). */
  source: string;
}

function join(cwd: string, name: string): string {
  return `${cwd.replace(/\/+$/, "")}/${name}`;
}

async function tryRead(path: string): Promise<string | null> {
  try {
    const file = await api.readFile(path);
    if (file.binary) return null;
    return file.text;
  } catch {
    return null;
  }
}

/** Package manager from the lockfiles on disk — the command differs per tool. */
function packageManager(names: Set<string>): "bun" | "pnpm" | "yarn" | "npm" {
  if (names.has("bun.lockb") || names.has("bun.lock")) return "bun";
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  return "npm";
}

function nodeCommand(pm: string, script: string): string {
  switch (pm) {
    case "bun":
      return `bun run ${script}`;
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    default:
      return `npm run ${script}`;
  }
}

const WEBSITE_DEPS = new Set([
  "next",
  "vite",
  "@vitejs/plugin-react",
  "astro",
  "@remix-run/react",
  "@remix-run/node",
  "nuxt",
  "gatsby",
  "@sveltejs/kit",
  "webpack-dev-server",
  "parcel",
  "expo",
  "@angular/cli",
  "vue-cli-service",
  "solid-start",
]);

function isWebsite(pkg: Record<string, unknown>): boolean {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (deps != null && typeof deps === "object") {
      for (const name of Object.keys(deps as Record<string, unknown>)) {
        if (WEBSITE_DEPS.has(name)) return true;
      }
    }
  }
  return false;
}

async function fromPackageJson(cwd: string, names: Set<string>): Promise<RunCommand | null> {
  const text = await tryRead(join(cwd, "package.json"));
  if (!text) return null;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scripts = pkg["scripts"];
  if (scripts == null || typeof scripts !== "object") return null;
  const available = scripts as Record<string, unknown>;
  // The script a person reaches for first: `dev` for a website in progress,
  // `start` for something already runnable, then the rest.
  const pick = ["dev", "start", "serve", "preview"].find(
    (name) => typeof available[name] === "string",
  );
  if (!pick) return null;
  const command = nodeCommand(packageManager(names), pick);
  return {
    label: isWebsite(pkg) ? "Run website" : "Run project",
    command,
    source: "package.json",
  };
}

async function fromCargo(cwd: string): Promise<RunCommand | null> {
  const text = await tryRead(join(cwd, "Cargo.toml"));
  if (!text) return null;
  if (!text.includes("[package]")) return null;
  return { label: "Run project", command: "cargo run", source: "Cargo.toml" };
}

function fromGo(names: Set<string>): RunCommand | null {
  if (!names.has("go.mod")) return null;
  return { label: "Run project", command: "go run .", source: "go.mod" };
}

async function fromPython(cwd: string, names: Set<string>): Promise<RunCommand | null> {
  // Django first: `manage.py runserver` is the website answer, and a Django
  // tree also tends to carry an `app.py`-looking file that would misfire.
  if (names.has("manage.py")) {
    return { label: "Run website", command: "python3 manage.py runserver", source: "manage.py" };
  }
  if (names.has("main.py")) {
    return { label: "Run project", command: "python3 main.py", source: "main.py" };
  }
  if (names.has("app.py")) {
    const text = await tryRead(join(cwd, "app.py"));
    const website =
      text != null && /flask|fastapi|django|streamlit/i.test(text);
    return {
      label: website ? "Run website" : "Run project",
      command: "python3 app.py",
      source: "app.py",
    };
  }
  return null;
}

async function fromMakefile(cwd: string): Promise<RunCommand | null> {
  const text = await tryRead(join(cwd, "Makefile"));
  if (!text) return null;
  if (/^run[\s:]/m.test(text)) {
    return { label: "Run project", command: "make run", source: "Makefile" };
  }
  return null;
}

function fromStaticSite(names: Set<string>): RunCommand | null {
  if (!names.has("index.html")) return null;
  return { label: "Run website", command: "npx serve .", source: "index.html" };
}

/** The command the Run pill should offer for `cwd`, or `null` when nothing
 * on disk says how this project runs. Cheap: one directory listing and at
 * most two small file reads. */
export async function detectRunCommand(cwd: string): Promise<RunCommand | null> {
  if (!cwd) return null;
  let names: Set<string>;
  try {
    const entries = await api.listDir(cwd);
    names = new Set(entries.map((e) => e.name));
  } catch {
    return null;
  }

  if (names.has("package.json")) {
    const found = await fromPackageJson(cwd, names);
    if (found) return found;
  }
  const cargo = await fromCargo(cwd);
  if (cargo) return cargo;
  const go = fromGo(names);
  if (go) return go;
  const python = await fromPython(cwd, names);
  if (python) return python;
  const make = await fromMakefile(cwd);
  if (make) return make;
  return fromStaticSite(names);
}
