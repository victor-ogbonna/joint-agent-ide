import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Search, Loader2, Check, Plus, Trash2, Upload, Github, Library, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  fetchLibraries, searchCatalogue, fetchVersions, addFromCatalogue, importZip, importGithub, removeLibrary, formatBytes,
  type LibraryListing, type LibraryView, type CatalogueItem,
} from "../lib/libraries";

/**
 * Libraries, in both modes. Well-known ones are still added automatically
 * from the code's #includes; this is for everything else, or a set version.
 * Whatever is added here belongs to the account and works in every project,
 * used by a build whenever the code includes it.
 */
type Tab = "catalogue" | "yours" | "import";

const KIND_LABEL: Record<LibraryView["kind"], string> = {
  catalogue: "Catalogue",
  zip: "Imported .zip",
  github: "GitHub",
};

function Notice({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  const Icon = tone === "error" ? AlertCircle : CheckCircle2;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${tone === "error"
        ? "border-red-500/30 bg-red-500/10 text-red-300"
        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}`}
    >
      <Icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function includeLine(lib: { headerFiles: string[] }) {
  return lib.headerFiles.length ? `#include <${lib.headerFiles[0]}>` : "";
}

export default function LibrariesModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("catalogue");
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Catalogue
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [results, setResults] = useState<CatalogueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** "owner/name" being added, and what came of each attempt. */
  const [adding, setAdding] = useState<string | null>(null);
  const [addResult, setAddResult] = useState<Record<string, { ok: boolean; text: string }>>({});

  // Yours
  const [versions, setVersions] = useState<Record<string, string[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [yoursMessage, setYoursMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Import
  const fileRef = useRef<HTMLInputElement>(null);
  const [githubUrl, setGithubUrl] = useState("");
  const [importing, setImporting] = useState<"zip" | "github" | null>(null);
  const [importMessage, setImportMessage] = useState<{ ok: boolean; text: string; notes?: string[] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setListing(await fetchLibraries());
      setListError(null);
    } catch (err: any) {
      setListError(err?.message || "Your libraries couldn't be loaded.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mine = listing?.libraries ?? [];
  const catalogueKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();
  const addedFromCatalogue = (item: CatalogueItem) =>
    mine.find((l) => l.kind === "catalogue" && l.owner && catalogueKey(l.owner, l.name) === catalogueKey(item.owner, item.name));

  const runSearch = async (q: string, p: number) => {
    const text = q.trim();
    if (!text) return;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await searchCatalogue(text, p);
      setResults((prev) => (p === 1 ? data.items : [...prev, ...data.items]));
      setTotal(data.total);
      setPage(p);
      setSearched(text);
    } catch (err: any) {
      setSearchError(err?.message || "The catalogue couldn't be searched.");
    } finally {
      setSearching(false);
    }
  };

  const add = async (owner: string, name: string, version?: string) => {
    const key = catalogueKey(owner, name);
    setAdding(key);
    setAddResult((r) => { const next = { ...r }; delete next[key]; return next; });
    try {
      const res = await addFromCatalogue(owner, name, version);
      setListing(res);
      const line = includeLine(res.library);
      setAddResult((r) => ({ ...r, [key]: { ok: true, text: `Added ${res.library.name} ${res.library.version}.${line ? ` Use it with ${line}` : ""}` } }));
    } catch (err: any) {
      setAddResult((r) => ({ ...r, [key]: { ok: false, text: err?.message || "That library couldn't be added." } }));
    } finally {
      setAdding(null);
    }
  };

  const loadVersions = async (lib: LibraryView) => {
    if (!lib.owner || versions[lib.id]) return;
    try {
      const list = await fetchVersions(lib.owner, lib.name);
      setVersions((v) => ({ ...v, [lib.id]: list.map((x) => x.version) }));
    } catch {
      setVersions((v) => ({ ...v, [lib.id]: [lib.version] }));
    }
  };

  // Ready before the version list is opened: a phone's picker shows the
  // options it had at the tap, so loading them on the tap would be too late.
  useEffect(() => {
    if (tab !== "yours") return;
    for (const lib of mine) if (lib.kind === "catalogue") void loadVersions(lib);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, listing]);

  const changeVersion = async (lib: LibraryView, version: string) => {
    if (!lib.owner || version === lib.version) return;
    setBusyId(lib.id);
    setYoursMessage(null);
    try {
      const res = await addFromCatalogue(lib.owner, lib.name, version);
      setListing(res);
      setYoursMessage({ ok: true, text: `${res.library.name} is now version ${res.library.version}.` });
    } catch (err: any) {
      setYoursMessage({ ok: false, text: err?.message || "That version couldn't be used." });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (lib: LibraryView) => {
    if (confirmRemove !== lib.id) { setConfirmRemove(lib.id); return; }
    setBusyId(lib.id);
    setYoursMessage(null);
    try {
      setListing(await removeLibrary(lib.id));
      setYoursMessage({ ok: true, text: `${lib.name} was removed.` });
    } catch (err: any) {
      setYoursMessage({ ok: false, text: err?.message || "That library couldn't be removed." });
    } finally {
      setBusyId(null);
      setConfirmRemove(null);
    }
  };

  const afterImport = (res: LibraryListing & { library: LibraryView }) => {
    setListing(res);
    const line = includeLine(res.library);
    setImportMessage({
      ok: true,
      text: `Added ${res.library.name}${res.library.version ? ` ${res.library.version}` : ""}.${line ? ` Use it with ${line}` : ""}`,
      notes: res.library.notes,
    });
  };

  const onZipChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setImportMessage({ ok: false, text: "Choose a .zip file." });
      return;
    }
    setImporting("zip");
    setImportMessage(null);
    try {
      afterImport(await importZip(file));
    } catch (err: any) {
      setImportMessage({ ok: false, text: err?.message || "That zip couldn't be added." });
    } finally {
      setImporting(null);
    }
  };

  const onGithub = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubUrl.trim() || importing) return;
    setImporting("github");
    setImportMessage(null);
    try {
      afterImport(await importGithub(githubUrl.trim()));
      setGithubUrl("");
    } catch (err: any) {
      setImportMessage({ ok: false, text: err?.message || "That repository couldn't be added." });
    } finally {
      setImporting(null);
    }
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`flex-1 rounded-md px-2 py-2 text-[12px] font-semibold transition ${tab === id
        ? "bg-[var(--bg-panel)] text-[var(--text-main)] shadow-sm"
        : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="flex h-full items-end sm:items-center justify-center sm:p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="libraries-title"
          onClick={(e) => e.stopPropagation()}
          className="flex w-full sm:max-w-lg max-h-[88dvh] sm:max-h-[85vh] flex-col bg-[var(--bg-root)] border border-[var(--border-main)] sm:rounded-2xl rounded-t-2xl shadow-2xl animate-slide-up"
        >
          <div className="shrink-0 px-5 pt-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 id="libraries-title" className="flex items-center gap-2 font-display font-bold text-lg text-[var(--text-main)] leading-snug">
                  <Library size={18} className="text-[var(--accent-primary)]" /> Libraries
                </h2>
                <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                  Add a library once and use it in any project: it's used whenever your code includes it.
                </p>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="w-10 h-10 -mr-2 -mt-1 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] transition shrink-0"
              >
                <X size={18} />
              </button>
            </div>
            <div role="tablist" className="mt-4 flex gap-1 rounded-lg bg-[var(--bg-surface)] p-1">
              {tabButton("catalogue", "Catalogue")}
              {tabButton("yours", `Yours${listing ? ` (${mine.length})` : ""}`)}
              {tabButton("import", "Import")}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            {tab === "catalogue" && (
              <div className="space-y-3">
                <form
                  onSubmit={(e) => { e.preventDefault(); void runSearch(query, 1); }}
                  className="flex gap-2"
                >
                  <div className="relative min-w-0 flex-1">
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      type="search"
                      enterKeyHint="search"
                      placeholder="e.g. DHT, ArduinoJson, U8g2"
                      aria-label="Search the library catalogue"
                      className="w-full rounded-lg border border-[var(--border-main)] bg-[var(--bg-panel)] py-2.5 pl-9 pr-3 text-[16px] sm:text-[13px] text-[var(--text-main)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent-primary)]"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={searching || !query.trim()}
                    className="shrink-0 rounded-lg px-4 text-[13px] font-bold text-white disabled:opacity-50"
                    style={{ background: "var(--gradient-hero)" }}
                  >
                    {searching && page === 1 ? <Loader2 size={15} className="animate-spin" /> : "Search"}
                  </button>
                </form>

                {searchError && <Notice tone="error">{searchError}</Notice>}

                {!searched && !searchError && (
                  <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                    Well-known libraries are added for you when your code includes them. Search here for anything else, or to pick a particular version.
                  </p>
                )}
                {searched && !searching && !results.length && !searchError && (
                  <p className="text-[12px] text-[var(--text-muted)]">
                    Nothing found for “{searched}”. If the library is on GitHub or a maker's website, add it under Import.
                  </p>
                )}

                <ul className="space-y-2">
                  {results.map((item) => {
                    const key = catalogueKey(item.owner, item.name);
                    const added = addedFromCatalogue(item);
                    const result = addResult[key];
                    return (
                      <li key={key} className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-3">
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-bold text-[var(--text-main)]">{item.name}</p>
                            <p className="truncate text-[11px] text-[var(--text-subtle)]">
                              by {item.owner}{item.version ? ` · ${item.version}` : ""}
                            </p>
                            {item.description && (
                              <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-[var(--text-muted)]">{item.description}</p>
                            )}
                          </div>
                          {added ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border-main)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--text-muted)]">
                              <Check size={12} className="text-emerald-400" /> {added.version}
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void add(item.owner, item.name)}
                              disabled={adding !== null}
                              className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border-main)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                            >
                              {adding === key ? <><Loader2 size={12} className="animate-spin" /> Checking…</> : <><Plus size={12} /> Add</>}
                            </button>
                          )}
                        </div>
                        {result && (
                          <div className="mt-2">
                            <Notice tone={result.ok ? "success" : "error"}>{result.text}</Notice>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>

                {results.length > 0 && results.length < total && (
                  <button
                    type="button"
                    onClick={() => void runSearch(searched, page + 1)}
                    disabled={searching}
                    className="w-full rounded-lg border border-[var(--border-main)] py-2 text-[12px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  >
                    {searching ? <Loader2 size={14} className="mx-auto animate-spin" /> : "More results"}
                  </button>
                )}
              </div>
            )}

            {tab === "yours" && (
              <div className="space-y-3">
                {listError && <Notice tone="error">{listError}</Notice>}
                {yoursMessage && <Notice tone={yoursMessage.ok ? "success" : "error"}>{yoursMessage.text}</Notice>}
                {listing && (
                  <p className="text-[11px] text-[var(--text-subtle)]">
                    {mine.length} of {listing.maxLibraries} libraries · imported {formatBytes(listing.usedBytes)} of {formatBytes(listing.maxBytes)}
                  </p>
                )}
                {listing && !mine.length && (
                  <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                    No libraries yet. Search the catalogue, or import one from a .zip or a GitHub link.
                  </p>
                )}
                <ul className="space-y-2">
                  {mine.map((lib) => (
                    <li key={lib.id} className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-bold text-[var(--text-main)]">{lib.name}</p>
                          <p className="truncate text-[11px] text-[var(--text-subtle)]">
                            {KIND_LABEL[lib.kind]}{lib.owner ? ` · by ${lib.owner}` : ""}{lib.kind !== "catalogue" && lib.version ? ` · ${lib.version}` : ""}{lib.bytes ? ` · ${formatBytes(lib.bytes)}` : ""}
                          </p>
                          {includeLine(lib) && (
                            <p className="mt-1 truncate font-mono text-[11px] text-[var(--accent-primary)]">{includeLine(lib)}</p>
                          )}
                          {lib.notes.map((n) => (
                            <p key={n} className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">{n}</p>
                          ))}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {lib.kind === "catalogue" && (
                            <select
                              aria-label={`Version of ${lib.name}`}
                              value={lib.version}
                              disabled={busyId === lib.id}
                              onFocus={() => void loadVersions(lib)}
                              onPointerDown={() => void loadVersions(lib)}
                              onChange={(e) => void changeVersion(lib, e.target.value)}
                              className="max-w-[6.5rem] rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] px-2 py-1.5 text-[12px] text-[var(--text-main)]"
                            >
                              {(versions[lib.id] ?? [lib.version]).includes(lib.version) ? null : <option value={lib.version}>{lib.version}</option>}
                              {(versions[lib.id] ?? [lib.version]).map((v) => <option key={v} value={v}>{v}</option>)}
                            </select>
                          )}
                          <button
                            type="button"
                            onClick={() => void remove(lib)}
                            disabled={busyId === lib.id}
                            aria-label={confirmRemove === lib.id ? `Confirm removing ${lib.name}` : `Remove ${lib.name}`}
                            className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${confirmRemove === lib.id
                              ? "border-red-500/40 bg-red-500/10 text-red-300"
                              : "border-[var(--border-main)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)]"}`}
                          >
                            {busyId === lib.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                            {confirmRemove === lib.id && busyId !== lib.id ? "Remove?" : null}
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {tab === "import" && (
              <div className="space-y-4">
                {importMessage && (
                  <Notice tone={importMessage.ok ? "success" : "error"}>
                    {importMessage.text}
                    {importMessage.notes?.map((n) => <span key={n} className="mt-1 block opacity-80">{n}</span>)}
                  </Notice>
                )}

                <section className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
                  <h3 className="text-[13px] font-bold text-[var(--text-main)]">From a .zip file</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    A library .zip, such as one from a sensor maker's website. Up to 10 MB.
                  </p>
                  <input ref={fileRef} type="file" accept=".zip,application/zip" className="hidden" onChange={onZipChosen} />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={importing !== null}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--border-main)] py-2.5 text-[13px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  >
                    {importing === "zip" ? <><Loader2 size={14} className="animate-spin" /> Adding…</> : <><Upload size={14} /> Choose .zip</>}
                  </button>
                </section>

                <section className="rounded-xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-4">
                  <h3 className="text-[13px] font-bold text-[var(--text-main)]">From GitHub</h3>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
                    A link to a public repository, or to the folder a library is in.
                  </p>
                  <form onSubmit={onGithub} className="mt-3 flex gap-2">
                    <input
                      value={githubUrl}
                      onChange={(e) => setGithubUrl(e.target.value)}
                      type="url"
                      inputMode="url"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="https://github.com/owner/repository"
                      aria-label="GitHub link"
                      className="min-w-0 flex-1 rounded-lg border border-[var(--border-main)] bg-[var(--bg-root)] px-3 py-2.5 text-[16px] sm:text-[13px] text-[var(--text-main)] placeholder:text-[var(--text-subtle)] outline-none focus:border-[var(--accent-primary)]"
                    />
                    <button
                      type="submit"
                      disabled={importing !== null || !githubUrl.trim()}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg px-4 text-[13px] font-bold text-white disabled:opacity-50"
                      style={{ background: "var(--gradient-hero)" }}
                    >
                      {importing === "github" ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
                      Add
                    </button>
                  </form>
                </section>

                <p className="text-[11px] leading-relaxed text-[var(--text-subtle)]">
                  Only a library's code and headers are kept. Scripts and build steps inside it never run.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
