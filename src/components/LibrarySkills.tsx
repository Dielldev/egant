// Library > Skills: folders holding a SKILL.md that agents load on demand.
// Installed and removed through the open `skills` CLI from skills.sh, which
// keeps one copy under `~/.agents/skills` and links it into each agent's
// skills folder; browsed from skills.sh's search and the official Anthropic
// and OpenAI skill repos. See `crates/harness/src/library/skills.rs`.

import { ArrowLeft, Download, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type {
  CatalogSkill,
  FeaturedSkillSource,
  InstalledSkill,
  SkillCommandOutcome,
  SkillsLibrary,
} from "../lib/types";
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
import { Markdown } from "./Markdown";
import { SectionHead } from "./SettingsKit";

type Tab = "installed" | "browse";

type SheetState =
  | { kind: "installed"; id: string }
  | { kind: "catalog"; skill: CatalogSkill }
  | { kind: "new" };

const TABS: { id: Tab; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "browse", label: "Browse" },
];

export function SkillsSection() {
  const [lib, setLib] = useState<SkillsLibrary | null>(null);
  const [tab, setTab] = useState<Tab>("installed");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [featured, setFeatured] = useState<FeaturedSkillSource[] | null>(null);
  const [featuredError, setFeaturedError] = useState<string | null>(null);
  const [results, setResults] = useState<CatalogSkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [popular, setPopular] = useState<CatalogSkill[] | null>(null);
  // Installed skills with a newer version upstream, by folder name.
  const [outdated, setOutdated] = useState<string[]>([]);
  const [updating, setUpdating] = useState(false);
  const [updateFailure, setUpdateFailure] = useState<SkillCommandOutcome | null>(null);

  const load = useCallback(async (first = false) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.librarySkills();
      setLib(next);
      // Nothing installed yet: the catalog is the useful first view.
      if (first && next.installed.length === 0) setTab("browse");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFeatured = useCallback(async (refresh: boolean) => {
    setFeaturedError(null);
    try {
      setFeatured(await api.librarySkillsFeatured(refresh));
    } catch (e) {
      setFeaturedError(errorText(e));
      setFeatured((prev) => prev ?? []);
    }
  }, []);

  // Quiet on failure: GitHub's anonymous rate limit is the usual cause,
  // and a missing "update" badge is the right degradation.
  const loadUpdates = useCallback(async (refresh: boolean) => {
    try {
      setOutdated(await api.librarySkillsCheckUpdates(refresh));
    } catch {
      // keep whatever the last check said
    }
  }, []);

  const loadPopular = useCallback(async (refresh: boolean) => {
    try {
      setPopular(await api.librarySkillsPopular(refresh));
    } catch {
      setPopular((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load(true);
    void loadUpdates(false);
  }, [load, loadUpdates]);

  useEffect(() => {
    if (tab === "browse" && featured === null) void loadFeatured(false);
    if (tab === "browse" && popular === null) void loadPopular(false);
  }, [tab, featured, loadFeatured, popular, loadPopular]);

  /** `skills update` for `names` (every CLI-installed skill when empty). */
  const runUpdate = async (names: string[]) => {
    setUpdating(true);
    setUpdateFailure(null);
    setError(null);
    try {
      const outcome = await api.librarySkillsUpdate(names);
      setLib(outcome.library);
      if (!outcome.success) setUpdateFailure(outcome);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUpdating(false);
      void loadUpdates(true);
    }
  };

  // skills.sh search, debounced; a stale answer never replaces a newer one.
  const needle = query.trim();
  useEffect(() => {
    if (tab !== "browse" || needle.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .librarySkillsSearch(needle)
        .then((hits) => {
          if (!cancelled) {
            setResults(hits);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(errorText(e));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tab, needle]);

  const installedById = useMemo(
    () => new Map((lib?.installed ?? []).map((s) => [s.id, s])),
    [lib],
  );
  const installedFor = (skill: CatalogSkill) =>
    installedById.get(skill.skillId) ?? installedById.get(skill.name) ?? null;
  const openCatalog = (skill: CatalogSkill) => {
    const installed = installedFor(skill);
    setSheet(installed ? { kind: "installed", id: installed.id } : { kind: "catalog", skill });
  };

  const lower = needle.toLowerCase();
  const installed = (lib?.installed ?? []).filter(
    (s) =>
      !lower ||
      s.name.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower) ||
      (s.source ?? "").toLowerCase().includes(lower),
  );
  const openInstalled = sheet?.kind === "installed" ? (installedById.get(sheet.id) ?? null) : null;

  const refresh = () => {
    void load();
    void loadUpdates(true);
    if (tab === "browse") {
      void loadFeatured(true);
      void loadPopular(true);
    }
  };

  const catalogCard = (skill: CatalogSkill) => (
    <LibraryCard
      key={skill.id}
      icon={<Monogram text={skill.name} />}
      title={skill.name}
      tag={installedFor(skill) ? <Tag>installed</Tag> : undefined}
      description={skill.description ?? skill.source}
      footer={
        <>
          <span className="truncate">{skill.source}</span>
          {skill.installs != null && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <Download size={11} strokeWidth={2} />
              {formatCount(skill.installs)}
            </span>
          )}
        </>
      }
      onOpen={() => openCatalog(skill)}
    />
  );

  return (
    <div>
      <SectionHead
        title="Skills"
        sub="Reusable instructions agents load when a task calls for them. Installed with the skills CLI from skills.sh into each agent's skills folder."
        right={
          <>
            {outdated.length > 0 && (
              <GhostButton
                disabled={updating}
                title={`Newer versions upstream: ${outdated.join(", ")}`}
                onClick={() => void runUpdate(outdated)}
              >
                <RefreshCw size={14} strokeWidth={2} className={updating ? "animate-spin" : ""} />
                {updating ? "Updating…" : `Update ${outdated.length}`}
              </GhostButton>
            )}
            <GhostButton onClick={() => setSheet({ kind: "new" })}>
              <Plus size={14} strokeWidth={2} />
              New skill
            </GhostButton>
          </>
        }
      />

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`cursor-pointer rounded-md px-3 py-1 text-[12px] whitespace-nowrap ${
                t.id === tab
                  ? "bg-[var(--selected)] font-medium text-[var(--ink)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              {t.label}
              {t.id === "installed" && lib ? ` (${lib.installed.length})` : ""}
            </button>
          ))}
        </div>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder={tab === "browse" ? "Search skills.sh…" : "Search installed skills…"}
        />
        <button
          type="button"
          title="Re-read skills folders and the catalog"
          onClick={refresh}
          className="ml-auto flex shrink-0 cursor-pointer items-center rounded-lg border border-[var(--border)] bg-[var(--card)] p-2 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCw
            size={14}
            strokeWidth={2}
            className={loading || searching ? "animate-spin" : ""}
          />
        </button>
      </div>

      {error && (
        <div className="mt-4">
          <Notice tone="warn">{error}</Notice>
        </div>
      )}
      {updateFailure && (
        <div className="mt-4 flex flex-col gap-2">
          <Notice tone="warn">The skills CLI didn't finish updating.</Notice>
          <CommandLog outcome={updateFailure} />
        </div>
      )}

      {tab === "installed" ? (
        <>
          <GroupTitle title="Installed" count={lib ? installed.length : undefined} />
          {installed.length > 0 ? (
            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {installed.map((skill) => (
                <LibraryCard
                  key={skill.id}
                  icon={<Monogram text={skill.name} />}
                  title={skill.name}
                  tag={
                    outdated.includes(skill.id) ? (
                      <UpdateTag />
                    ) : skill.source ? undefined : (
                      <Tag>local</Tag>
                    )
                  }
                  description={skill.description || "No description."}
                  footer={
                    <>
                      <AgentLogos ids={skill.agents} />
                      {skill.source && <span className="ml-auto truncate">{skill.source}</span>}
                    </>
                  }
                  onOpen={() => setSheet({ kind: "installed", id: skill.id })}
                />
              ))}
            </div>
          ) : (
            <p className="px-0.5 text-[13px] text-[var(--faint)]">
              {loading && !lib
                ? "Reading skills folders…"
                : lower
                  ? "No installed skill matches that search."
                  : "No skills installed yet — browse the catalog, or write one with New skill."}
            </p>
          )}
        </>
      ) : results !== null ? (
        <>
          <GroupTitle title={`skills.sh results for “${needle}”`} count={results.length} />
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {results.map(catalogCard)}
          </div>
          {results.length === 0 && !searching && (
            <p className="px-0.5 text-[13px] text-[var(--faint)]">Nothing on skills.sh matches that.</p>
          )}
        </>
      ) : (
        <>
          {featuredError && (
            <div className="mt-4">
              <Notice tone="warn">{featuredError}</Notice>
            </div>
          )}
          <GroupTitle title="Popular on skills.sh" count={popular?.length || undefined} />
          {popular === null ? (
            <p className="px-0.5 text-[13px] text-[var(--faint)]">Loading popular skills…</p>
          ) : popular.length > 0 ? (
            <>
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                {popular.map(catalogCard)}
              </div>
              <p className="mt-2 px-0.5 text-[11.5px] text-[var(--faint)]">
                The most-installed skills across a spread of searches, at most three per source —
                close to skills.sh's leaderboard, which egant can't read directly.
              </p>
            </>
          ) : (
            <p className="px-0.5 text-[13px] text-[var(--faint)]">Couldn't reach skills.sh.</p>
          )}
          {featured === null && (
            <p className="mt-6 px-0.5 text-[13px] text-[var(--faint)]">Loading official skills…</p>
          )}
          {featured?.map((group) => (
            <div key={group.source}>
              <GroupTitle title={`${group.label} · ${group.source}`} count={group.skills.length} />
              <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
                {group.skills.map(catalogCard)}
              </div>
            </div>
          ))}
          <p className="mt-6 px-0.5 text-[12px] text-[var(--faint)]">
            Search to find any of the skills published on skills.sh.
          </p>
        </>
      )}

      {lib && sheet?.kind === "catalog" && (
        <CatalogSkillSheet
          key={sheet.skill.id}
          skill={sheet.skill}
          lib={lib}
          onClose={() => setSheet(null)}
          onInstalled={(next, id) => {
            setLib(next);
            if (next.installed.some((s) => s.id === id)) setSheet({ kind: "installed", id });
          }}
        />
      )}
      {lib && openInstalled && (
        <InstalledSkillSheet
          key={openInstalled.id}
          skill={openInstalled}
          lib={lib}
          outdated={outdated.includes(openInstalled.id)}
          updating={updating}
          onUpdate={() => void runUpdate([openInstalled.id])}
          onClose={() => setSheet(null)}
          onChanged={setLib}
          onRemoved={(next) => {
            setLib(next);
            setSheet(null);
          }}
        />
      )}
      {lib && sheet?.kind === "new" && (
        <NewSkillSheet
          lib={lib}
          onClose={() => setSheet(null)}
          onCreated={(next, id) => {
            setLib(next);
            setTab("installed");
            setSheet({ kind: "installed", id });
          }}
        />
      )}
    </div>
  );
}

function UpdateTag() {
  return (
    <span className="shrink-0 rounded-md border border-amber-400/25 bg-amber-500/15 px-1.5 py-px text-[10.5px] text-amber-300">
      update
    </span>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/** The body of a SKILL.md, without its YAML frontmatter. */
function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function checklistOf(lib: SkillsLibrary, selected: string[], lockShared: boolean): ChecklistAgent[] {
  return lib.agents.map((a) => ({
    id: a.id,
    name: a.name,
    detail: a.dir,
    unavailable: !a.available && !selected.includes(a.id),
    lockedReason:
      lockShared && a.shared
        ? "Reads ~/.agents/skills, the shared copy — follows install and uninstall"
        : null,
  }));
}

function defaultAgents(lib: SkillsLibrary): string[] {
  return lib.agents.filter((a) => a.available).map((a) => a.id);
}

function SkillPreview({ load }: { load: () => Promise<string> }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((t) => !cancelled && setText(stripFrontmatter(t)))
      .catch((e) => !cancelled && setError(errorText(e)));
    return () => {
      cancelled = true;
    };
    // `load` is rebuilt every render; the sheet is keyed per skill instead.
  }, []);
  return (
    <section>
      <h3 className="mb-2 text-[13px] text-[var(--muted)]">SKILL.md</h3>
      <div className="max-h-[420px] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
        {text !== null ? (
          <Markdown text={text} />
        ) : (
          <span className="text-[12.5px] text-[var(--faint)]">{error ?? "Loading…"}</span>
        )}
      </div>
    </section>
  );
}

function CommandLog({ outcome }: { outcome: SkillCommandOutcome }) {
  return (
    <details open={!outcome.success}>
      <summary className="cursor-pointer text-[12px] text-[var(--faint)] hover:text-[var(--ink)]">
        Command output
      </summary>
      <pre className="mt-1.5 max-h-[200px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--muted)]">
        {outcome.output}
      </pre>
    </details>
  );
}

function SkillHeader({
  name,
  sub,
  link,
}: {
  name: string;
  sub: string;
  link?: { label: string; url: string };
}) {
  return (
    <header className="flex items-start gap-3.5">
      <Monogram text={name} />
      <div className="min-w-0 flex-1">
        <div className="text-[17px] font-semibold text-[var(--ink)]">{name}</div>
        <div className="mt-0.5 text-[12.5px] leading-relaxed text-[var(--muted)]">{sub}</div>
      </div>
      {link && (
        <button
          type="button"
          onClick={() => void api.openUrl(link.url)}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          {link.label}
          <ExternalLink size={13} strokeWidth={2} />
        </button>
      )}
    </header>
  );
}

function CatalogSkillSheet({
  skill,
  lib,
  onClose,
  onInstalled,
}: {
  skill: CatalogSkill;
  lib: SkillsLibrary;
  onClose: () => void;
  onInstalled: (next: SkillsLibrary, id: string) => void;
}) {
  const [agents, setAgents] = useState<string[]>(defaultAgents(lib));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SkillCommandOutcome | null>(null);

  const install = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const result = await api.librarySkillInstall(skill.source, skill.skillId, agents);
      setOutcome(result);
      if (result.success) onInstalled(result.library, skill.skillId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // A source without a slash is a site publishing under /.well-known/.
  const sourceArg = skill.source.includes("/") ? skill.source : `https://${skill.source}`;
  const command = `npx skills add ${sourceArg} --skill ${skill.skillId} -g`;

  return (
    <Sheet
      eyebrow="Install skill"
      onClose={onClose}
      footer={
        <>
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--faint)]" title={command}>
            {command}
          </code>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton busy={busy} disabled={agents.length === 0} onClick={() => void install()}>
            {busy ? (
              <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" />
            ) : (
              <Download size={13} strokeWidth={2.5} />
            )}
            {busy ? "Installing…" : "Install"}
          </PrimaryButton>
        </>
      }
    >
      <SkillHeader
        name={skill.name}
        sub={[
          skill.source,
          skill.installs != null ? `${formatCount(skill.installs)} installs` : null,
          skill.description,
        ]
          .filter(Boolean)
          .join(" · ")}
        link={{ label: "skills.sh", url: `https://skills.sh/${skill.source}/${skill.skillId}` }}
      />
      <AgentChecklist agents={checklistOf(lib, agents, false)} selected={agents} onChange={setAgents} />
      {busy && (
        <Notice tone="good">
          Fetching {skill.source} with the skills CLI — the first run downloads the CLI itself, so
          this can take a minute.
        </Notice>
      )}
      {error && <Notice tone="warn">{error}</Notice>}
      {outcome && !outcome.success && (
        <>
          <Notice tone="warn">The skills CLI didn't finish the install.</Notice>
          <CommandLog outcome={outcome} />
        </>
      )}
      <SkillPreview
        load={() => api.librarySkillReadRemote(skill.source, skill.skillId, skill.path)}
      />
    </Sheet>
  );
}

function InstalledSkillSheet({
  skill,
  lib,
  outdated,
  updating,
  onUpdate,
  onClose,
  onChanged,
  onRemoved,
}: {
  skill: InstalledSkill;
  lib: SkillsLibrary;
  outdated: boolean;
  updating: boolean;
  onUpdate: () => void;
  onClose: () => void;
  onChanged: (next: SkillsLibrary) => void;
  onRemoved: (next: SkillsLibrary) => void;
}) {
  const [agents, setAgents] = useState<string[]>(skill.agents);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SkillCommandOutcome | null>(null);
  const [saved, setSaved] = useState(false);

  // Shared agents follow the canonical copy; only the others are editable.
  const editable = (ids: string[]) =>
    ids.filter((id) => !lib.agents.find((a) => a.id === id)?.shared).sort();
  const dirty = editable(agents).join() !== editable(skill.agents).join();

  const save = async () => {
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const next = await api.librarySkillSetAgents(skill.id, agents);
      onChanged(next);
      const updated = next.installed.find((s) => s.id === skill.id);
      if (updated) setAgents(updated.agents);
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
      void api.librarySkills().then(onChanged).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy("remove");
    setError(null);
    setOutcome(null);
    try {
      const result = await api.librarySkillUninstall(skill.id);
      if (!result.library.installed.some((s) => s.id === skill.id)) {
        onRemoved(result.library);
        return;
      }
      setOutcome(result);
      onChanged(result.library);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  };

  return (
    <Sheet
      eyebrow="Skill"
      onClose={onClose}
      footer={
        <>
          <GhostButton danger disabled={busy !== null} onClick={() => void remove()}>
            {busy === "remove" ? (
              <RefreshCw size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <Trash2 size={13} strokeWidth={2} />
            )}
            {confirmRemove ? "Uninstall from every agent?" : "Uninstall"}
          </GhostButton>
          <span className="flex-1" />
          {outdated && (
            <GhostButton disabled={updating || busy !== null} onClick={onUpdate}>
              <RefreshCw size={13} strokeWidth={2} className={updating ? "animate-spin" : ""} />
              {updating ? "Updating…" : "Update"}
            </GhostButton>
          )}
          <PrimaryButton busy={busy === "save"} disabled={!dirty || busy !== null} onClick={() => void save()}>
            {busy === "save" && <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" />}
            Save agents
          </PrimaryButton>
        </>
      }
    >
      <SkillHeader
        name={skill.name}
        sub={skill.description || "No description."}
        link={
          skill.source
            ? { label: "skills.sh", url: `https://skills.sh/${skill.source}/${skill.id}` }
            : undefined
        }
      />
      <div className="-mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--faint)]">
        <span>{skill.source ? `From ${skill.source}` : "Local skill"}</span>
        <span className="truncate font-mono" title={skill.path}>
          {skill.path}
        </span>
      </div>
      {outdated && (
        <Notice tone="warn">
          A newer version is published in {skill.source}. Updating replaces the installed copy
          for every agent.
        </Notice>
      )}
      <AgentChecklist agents={checklistOf(lib, agents, true)} selected={agents} onChange={setAgents} />
      {saved && !dirty && <Notice tone="good">Agents updated.</Notice>}
      {error && <Notice tone="warn">{error}</Notice>}
      {outcome && (
        <>
          <Notice tone="warn">Some copies of this skill are still installed.</Notice>
          <CommandLog outcome={outcome} />
        </>
      )}
      <SkillPreview load={() => api.librarySkillReadInstalled(skill.id)} />
    </Sheet>
  );
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function NewSkillSheet({
  lib,
  onClose,
  onCreated,
}: {
  lib: SkillsLibrary;
  onClose: () => void;
  onCreated: (next: SkillsLibrary, id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [agents, setAgents] = useState<string[]>(defaultAgents(lib));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = SKILL_NAME.test(name) && name.length <= 64;
  const taken = lib.installed.some((s) => s.id === name);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.librarySkillCreate(name, description, body, agents), name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      eyebrow="New skill"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>
            <ArrowLeft size={13} strokeWidth={2} />
            Cancel
          </GhostButton>
          <span className="flex-1" />
          <PrimaryButton
            busy={busy}
            disabled={!nameOk || taken || !description.trim() || agents.length === 0}
            onClick={() => void create()}
          >
            Create
          </PrimaryButton>
        </>
      }
    >
      <section className="flex flex-col gap-3.5">
        <Field
          label="Name"
          required
          hint={
            taken
              ? "A skill with this name is already installed."
              : name && !nameOk
                ? "Lowercase letters, numbers and single hyphens."
                : `Written to ~/.agents/skills/${name || "<name>"}/SKILL.md and linked into each agent.`
          }
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            placeholder="release-notes"
            spellCheck={false}
            autoFocus
            className={`${INPUT} font-mono`}
          />
        </Field>
        <Field
          label="Description"
          required
          hint="What the skill does and when to use it — agents read this to decide whether to load it."
        >
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Drafts release notes from merged PRs. Use when asked to write a changelog or release notes."
            className={`${INPUT} resize-none leading-relaxed`}
          />
        </Field>
        <Field label="Instructions" hint="Markdown. Leave empty for a starter outline you can fill in later.">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder={"# Release notes\n\n1. List PRs merged since the last tag.\n2. Group them by area.\n3. …"}
            spellCheck={false}
            className={`${INPUT} resize-y font-mono text-[12.5px] leading-relaxed`}
          />
        </Field>
      </section>
      <AgentChecklist agents={checklistOf(lib, agents, false)} selected={agents} onChange={setAgents} />
      {error && <Notice tone="warn">{error}</Notice>}
    </Sheet>
  );
}
