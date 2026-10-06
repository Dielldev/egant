// Library > MCP: the servers every agent on this machine can call, written
// into each agent's own config file (`~/.claude.json`, `~/.codex/config.toml`,
// …) by `crates/harness/src/library/mcp.rs`. The agents' files are the only
// record — a server added by hand shows up here too.

import { ExternalLink, Eye, EyeOff, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { CatalogMcp, InstalledMcp, McpLibrary, McpServer, McpTransport } from "../lib/types";
import {
  AgentChecklist,
  AgentLogos,
  Field,
  GhostButton,
  GroupTitle,
  INPUT,
  LibraryCard,
  Monogram,
  Notice,
  PrimaryButton,
  SearchBox,
  Sheet,
  Tag,
  errorText,
} from "./LibraryKit";
import type { ChecklistAgent } from "./LibraryKit";
import { Pills, SectionHead } from "./SettingsKit";

type SheetState =
  | { kind: "add"; entry: CatalogMcp }
  | { kind: "custom" }
  | { kind: "edit"; server: InstalledMcp };

export function McpSection() {
  const [lib, setLib] = useState<McpLibrary | null>(null);
  const [catalog, setCatalog] = useState<CatalogMcp[]>([]);
  // null until the first answer: whether Recommended is emdash's live list.
  const [catalogLive, setCatalogLive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<SheetState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLib(await api.libraryMcp());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Separate from `load`: the catalog may wait on GitHub, and the servers
  // already added shouldn't wait with it.
  const loadCatalog = useCallback(async (refresh: boolean) => {
    try {
      const next = await api.libraryMcpCatalog(refresh);
      setCatalog(next.entries);
      setCatalogLive(next.live);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
    void loadCatalog(false);
  }, [load, loadCatalog]);

  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]) =>
    !needle || texts.some((t) => t.toLowerCase().includes(needle));
  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);

  const added = (lib?.servers ?? []).filter((s) => {
    const entry = s.catalogId ? catalogById.get(s.catalogId) : undefined;
    return matches(s.name, entry?.name ?? "", entry?.description ?? "", s.command, s.url);
  });
  const addedIds = new Set((lib?.servers ?? []).map((s) => s.catalogId ?? s.name.toLowerCase()));
  const recommended = catalog.filter(
    (c) => !addedIds.has(c.id) && matches(c.name, c.description, c.id),
  );

  return (
    <div>
      <SectionHead
        title="MCP"
        sub="Connect agents to tools and data. Each server is written into every selected agent's own config file, in that agent's format."
        right={
          <>
            <GhostButton onClick={() => setSheet({ kind: "custom" })}>
              <Plus size={14} strokeWidth={2} />
              Custom MCP
            </GhostButton>
          </>
        }
      />

      <div className="flex items-center gap-3">
        <SearchBox value={query} onChange={setQuery} placeholder="Search servers…" />
        <button
          type="button"
          title="Re-read every agent's config and recheck which agents are installed"
          onClick={() => {
            void load();
            void loadCatalog(true);
          }}
          className="ml-auto flex shrink-0 cursor-pointer items-center rounded-lg border border-[var(--border)] bg-[var(--card)] p-2 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCw size={14} strokeWidth={2} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <div className="mt-4">
          <Notice tone="warn">{error}</Notice>
        </div>
      )}

      <GroupTitle title="Added" count={lib ? added.length : undefined} />
      {added.length > 0 ? (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {added.map((server) => {
            const entry = server.catalogId ? catalogById.get(server.catalogId) : undefined;
            return (
              <LibraryCard
                key={server.name}
                icon={<Monogram text={entry?.name ?? server.name} />}
                title={entry?.name ?? server.name}
                tag={<Tag>{server.transport}</Tag>}
                description={entry?.description ?? describe(server)}
                footer={
                  <>
                    <AgentLogos ids={server.agents} />
                    {server.differs && (
                      <span className="text-amber-300" title="Not every agent has the same config for this server">
                        Differs between agents
                      </span>
                    )}
                  </>
                }
                onOpen={() => setSheet({ kind: "edit", server })}
              />
            );
          })}
        </div>
      ) : (
        <p className="px-0.5 text-[13px] text-[var(--faint)]">
          {loading && !lib
            ? "Reading agent configs…"
            : needle
              ? "No added server matches that search."
              : "No servers yet — add one from the list below, or a custom one."}
        </p>
      )}

      <GroupTitle title="Recommended" count={recommended.length} />
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
        {recommended.map((entry) => (
          <LibraryCard
            key={entry.id}
            icon={<Monogram text={entry.name} />}
            title={entry.name}
            tag={<Tag>{entry.transport}</Tag>}
            description={entry.description}
            action={
              <span className="flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-0.5 text-[11.5px] text-[var(--muted)]">
                <Plus size={11} strokeWidth={2.5} />
                Add
              </span>
            }
            onOpen={() => setSheet({ kind: "add", entry })}
          />
        ))}
      </div>
      {recommended.length === 0 && catalog.length > 0 && (
        <p className="px-0.5 text-[13px] text-[var(--faint)]">Nothing else matches that search.</p>
      )}
      {catalogLive === null ? (
        <p className="px-0.5 text-[13px] text-[var(--faint)]">Loading the catalog…</p>
      ) : (
        <p className="mt-4 px-0.5 text-[12px] text-[var(--faint)]">
          {catalogLive
            ? "Recommended servers come from emdash's catalog on GitHub, so new ones appear without an egant update."
            : "Couldn't reach GitHub, so this is the list built into egant — refresh to try again."}
        </p>
      )}

      {sheet && lib && (
        <McpSheet
          key={sheet.kind === "edit" ? `edit:${sheet.server.name}` : sheet.kind === "add" ? `add:${sheet.entry.id}` : "custom"}
          state={sheet}
          lib={lib}
          catalogById={catalogById}
          onClose={() => setSheet(null)}
          onChanged={(next) => {
            setLib(next);
            setSheet(null);
          }}
          onFailed={() => void load()}
        />
      )}
    </div>
  );
}

function describe(server: McpServer): string {
  return server.transport === "http"
    ? server.url
    : [server.command, ...server.args.map(quoteArg)].join(" ");
}

// ---------------------------------------------------------------------------
// The add/edit sheet
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  value: string;
}

const PLACEHOLDER = /YOUR_[A-Z0-9_]+/;
const SECRETISH = /key|token|secret|password|auth|pat\b|bearer|credential/i;

function rowsOf(map: Record<string, string>, skip: string[] = []): Row[] {
  return Object.entries(map)
    .filter(([key]) => !skip.includes(key))
    .map(([key, value]) => ({ key, value }));
}

function mapOf(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

function quoteArg(arg: string): string {
  return /[\s"']/.test(arg) || arg === "" ? `"${arg.replace(/(["\\])/g, "\\$1")}"` : arg;
}

/** Split an argument line the way a shell would for plain words and
 * quoted strings — no expansion, nothing is ever run through a shell. */
function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function McpSheet({
  state,
  lib,
  catalogById,
  onClose,
  onChanged,
  onFailed,
}: {
  state: SheetState;
  lib: McpLibrary;
  catalogById: Map<string, CatalogMcp>;
  onClose: () => void;
  onChanged: (next: McpLibrary) => void;
  onFailed: () => void;
}) {
  const editing = state.kind === "edit" ? state.server : null;
  const entry =
    state.kind === "add"
      ? state.entry
      : editing?.catalogId
        ? (catalogById.get(editing.catalogId) ?? null)
        : null;
  // Credentials get their own fields only when adding from the catalog; once
  // added they are ordinary env/header values.
  const credentialKeys = state.kind === "add" ? state.entry.credentialKeys : [];
  const credKeyNames = credentialKeys.map((c) => c.key);
  const source: McpServer =
    editing ??
    (state.kind === "add"
      ? {
          name: state.entry.id,
          transport: state.entry.transport,
          command: state.entry.command,
          args: state.entry.args,
          env: state.entry.env,
          url: state.entry.url,
          headers: state.entry.headers,
        }
      : { name: "", transport: "stdio", command: "", args: [], env: {}, url: "", headers: {} });

  const [name, setName] = useState(source.name);
  const [transport, setTransport] = useState<McpTransport>(source.transport);
  const [command, setCommand] = useState(source.command);
  const [argsText, setArgsText] = useState(source.args.map(quoteArg).join(" "));
  const [env, setEnv] = useState<Row[]>(rowsOf(source.env, credKeyNames));
  const [url, setUrl] = useState(source.url);
  const [headers, setHeaders] = useState<Row[]>(rowsOf(source.headers, credKeyNames));
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const [agents, setAgents] = useState<string[]>(
    editing ? editing.agents : lib.targets.filter((t) => t.available && !t.error).map((t) => t.id),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const checklist: ChecklistAgent[] = lib.targets.map((t) => ({
    id: t.id,
    name: t.name,
    detail: t.configPath,
    unavailable: !t.available && !agents.includes(t.id),
    lockedReason: t.error,
  }));

  const save = async () => {
    setError(null);
    const envMap = mapOf(env);
    const headerMap = mapOf(headers);
    for (const cred of credentialKeys) {
      const input = (creds[cred.key] ?? "").trim();
      if (!input) {
        if (cred.required) {
          setError(`${cred.key} is required.`);
          return;
        }
        continue;
      }
      const template = entry?.env[cred.key] ?? entry?.headers[cred.key];
      const value = template && PLACEHOLDER.test(template) ? template.replace(PLACEHOLDER, input) : input;
      const inHeaders = entry ? cred.key in entry.headers : transport === "http";
      if (inHeaders) headerMap[cred.key] = value;
      else envMap[cred.key] = value;
    }
    const leftover = [...Object.values(envMap), ...Object.values(headerMap)].find((v) =>
      PLACEHOLDER.test(v),
    );
    if (leftover) {
      setError(`Replace the placeholder in “${leftover}” with your own value.`);
      return;
    }
    const clash = lib.servers.find((s) => s.name === name.trim() && s.name !== editing?.name);
    if (clash) {
      setError(`A server named ${clash.name} is already added — edit that one instead.`);
      return;
    }
    if (agents.length === 0 && !editing) {
      setError("Pick at least one agent to add it to.");
      return;
    }
    const server: McpServer = {
      name: name.trim(),
      transport,
      command: command.trim(),
      args: transport === "stdio" ? splitArgs(argsText) : [],
      env: envMap,
      url: url.trim(),
      headers: transport === "http" ? headerMap : {},
    };
    setBusy(true);
    try {
      onChanged(await api.libraryMcpSave(server, agents, editing?.name ?? null));
    } catch (e) {
      setError(errorText(e));
      onFailed();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onChanged(await api.libraryMcpRemove(editing.name));
    } catch (e) {
      setError(errorText(e));
      onFailed();
    } finally {
      setBusy(false);
    }
  };

  const title = entry?.name ?? (editing ? editing.name : "Custom MCP server");

  return (
    <Sheet
      eyebrow={editing ? "Edit MCP server" : "Add MCP server"}
      onClose={onClose}
      footer={
        <>
          {editing && (
            <GhostButton danger disabled={busy} onClick={() => void remove()}>
              <Trash2 size={13} strokeWidth={2} />
              {confirmRemove ? "Remove from every agent?" : "Remove"}
            </GhostButton>
          )}
          <span className="flex-1" />
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton busy={busy} onClick={() => void save()}>
            {busy && <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" />}
            {editing ? "Save" : "Add"}
          </PrimaryButton>
        </>
      }
    >
      <header className="flex items-start gap-3.5">
        <Monogram text={title} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold text-[var(--ink)]">{title}</div>
          {entry && <div className="mt-0.5 text-[12.5px] text-[var(--muted)]">{entry.description}</div>}
        </div>
        {entry?.docsUrl && (
          <button
            type="button"
            onClick={() => void api.openUrl(entry.docsUrl)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            Docs
            <ExternalLink size={13} strokeWidth={2} />
          </button>
        )}
      </header>

      {editing?.differs && (
        <Notice tone="warn">
          Not every agent has the same config for this server. Saving writes this version to
          every selected agent.
        </Notice>
      )}

      <section className="flex flex-col gap-3.5">
        <Field label="Name" hint="How agents refer to the server. Letters, numbers, - and _.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            spellCheck={false}
            className={INPUT}
          />
        </Field>

        <Field label="Transport">
          <Pills
            value={transport}
            onChange={setTransport}
            options={[
              { value: "stdio", label: "stdio — run a local command" },
              { value: "http", label: "http — connect to a URL" },
            ]}
          />
        </Field>

        {transport === "stdio" ? (
          <>
            <Field label="Command" required>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
            </Field>
            <Field label="Arguments" hint="Separated by spaces; quote an argument that contains one.">
              <input
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="-y @modelcontextprotocol/server-everything"
                spellCheck={false}
                className={`${INPUT} font-mono`}
              />
            </Field>
          </>
        ) : (
          <Field label="URL" required>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
          </Field>
        )}
      </section>

      {credentialKeys.length > 0 && (
        <section className="flex flex-col gap-3">
          <SubHead title="Credentials" reveal={reveal} onReveal={() => setReveal((v) => !v)} />
          {credentialKeys.map((cred) => {
            const template = entry?.env[cred.key] ?? entry?.headers[cred.key] ?? "";
            return (
              <Field
                key={cred.key}
                label={cred.key}
                required={cred.required}
                hint={
                  template && template !== "YOUR_API_KEY" && PLACEHOLDER.test(template)
                    ? `Sent as “${template.replace(PLACEHOLDER, "…")}”.`
                    : cred.required
                      ? undefined
                      : "Optional."
                }
              >
                <input
                  type={reveal ? "text" : "password"}
                  value={creds[cred.key] ?? ""}
                  onChange={(e) => setCreds((prev) => ({ ...prev, [cred.key]: e.target.value }))}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT} font-mono`}
                />
              </Field>
            );
          })}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <SubHead
          title={transport === "stdio" ? "Environment variables" : "Headers"}
          reveal={credentialKeys.length > 0 ? undefined : reveal}
          onReveal={() => setReveal((v) => !v)}
        />
        <KeyValueRows
          rows={transport === "stdio" ? env : headers}
          onChange={transport === "stdio" ? setEnv : setHeaders}
          reveal={reveal}
          keyPlaceholder={transport === "stdio" ? "API_KEY" : "Authorization"}
        />
      </section>

      <AgentChecklist agents={checklist} selected={agents} onChange={setAgents} />

      {editing && agents.length === 0 && (
        <Notice tone="warn">No agent selected — saving takes this server out of every agent.</Notice>
      )}
      {error && <Notice tone="warn">{error}</Notice>}
    </Sheet>
  );
}

function SubHead({
  title,
  reveal,
  onReveal,
}: {
  title: string;
  reveal?: boolean;
  onReveal: () => void;
}) {
  return (
    <div className="flex items-center">
      <h3 className="text-[13px] text-[var(--muted)]">{title}</h3>
      {reveal != null && (
        <button
          type="button"
          onClick={onReveal}
          className="ml-auto flex cursor-pointer items-center gap-1 text-[12px] text-[var(--faint)] hover:text-[var(--ink)]"
        >
          {reveal ? <EyeOff size={12} strokeWidth={2} /> : <Eye size={12} strokeWidth={2} />}
          {reveal ? "Hide values" : "Show values"}
        </button>
      )}
    </div>
  );
}

function KeyValueRows({
  rows,
  onChange,
  reveal,
  keyPlaceholder,
}: {
  rows: Row[];
  onChange: (rows: Row[]) => void;
  reveal: boolean;
  keyPlaceholder: string;
}) {
  const set = (index: number, patch: Partial<Row>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={row.key}
            onChange={(e) => set(index, { key: e.target.value })}
            placeholder={keyPlaceholder}
            spellCheck={false}
            className={`${INPUT} w-[40%] shrink-0 font-mono`}
          />
          <input
            type={reveal || !SECRETISH.test(row.key) ? "text" : "password"}
            value={row.value}
            onChange={(e) => set(index, { value: e.target.value })}
            placeholder="value"
            autoComplete="off"
            spellCheck={false}
            className={`${INPUT} font-mono`}
          />
          <button
            type="button"
            title="Remove"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="shrink-0 cursor-pointer rounded-md p-1.5 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
        className="flex w-fit cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
      >
        <Plus size={12} strokeWidth={2} />
        Add
      </button>
    </div>
  );
}
