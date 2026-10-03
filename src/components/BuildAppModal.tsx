import React, { useEffect, useMemo, useRef, useState } from "react";
import { X, Smartphone, Loader2, Check, Download, Wifi, Bluetooth, Globe, Info, Undo2, Trash2 } from "lucide-react";
import {
  AppSettings, APP_NAME_MAX, APP_SHORT_NAME_MAX, applyApp, appliedSettings, cleanAppName, filterNameInput,
  inspectProject, isHexColor, removeApp, shortNameFrom,
} from "../lib/buildApp";
import { appPackageFiles, appSlug, fetchPng, PackageKind, prepareAppPage, zip } from "../lib/appPackage";
import { callAiEndpoint, QuotaBlockedInfo } from "../lib/aiClient";
import { formatWhen } from "../lib/plans";

interface BuildAppModalProps {
  onClose: () => void;
  code: string;
  /** Puts changed code in the editor (saved like any other edit). */
  onCodeChange: (code: string) => void;
  projectName: string;
  description: string;
  signedIn: boolean;
  /** The AI allowance is used up: the app shows its pause and plans. */
  onQuotaBlocked: (info: QuotaBlockedInfo) => void;
}

/** The board serves the app, or an app package reaches it another way. */
type Delivery = "board" | PackageKind;

const DELIVERY_LABELS: Record<Delivery, [string, typeof Wifi]> = {
  board: ["From the board", Wifi],
  bluetooth: ["Bluetooth LE app", Bluetooth],
  classic: ["Bluetooth app", Bluetooth],
  internet: ["Internet app", Globe],
};

const COLOURS = ["#0b0d12", "#f97316", "#2563eb", "#16a34a", "#7c3aed", "#dc2626"];

/**
 * "Build App (PWA)": makes a project a phone app with the Joint-Agent icon.
 * A board that serves its own page gets the app's name and icon added to
 * the sketch (src/lib/buildApp.ts); a Bluetooth (Low Energy or Classic) or
 * internet-connected one gets an app package to put on any https site
 * (src/lib/appPackage.ts).
 */
export default function BuildAppModal({ onClose, code, onCodeChange, projectName, description, signedIn, onQuotaBlocked }: BuildAppModalProps) {
  const project = useMemo(() => inspectProject(code), [code]);
  // What the sketch was last made an app with, read once when the window opens.
  const [previous] = useState(() => appliedSettings(code));
  const canBoard = project.board !== null;
  // Every way phones can get this project's app, the board's own first.
  const deliveries: Delivery[] = [
    ...(canBoard ? ["board" as const] : []),
    ...(project.ble ? ["bluetooth" as const] : []),
    ...(project.classicBluetooth ? ["classic" as const] : []),
    ...(project.cloud || project.cellular ? ["internet" as const] : []),
  ];
  const [delivery, setDelivery] = useState<Delivery>(deliveries[0] ?? "board");
  const packageKind: PackageKind | null = delivery !== "board" && deliveries.includes(delivery) ? delivery : null;

  const startName = previous?.name || cleanAppName(projectName) || "My App";
  const [name, setName] = useState(startName);
  const [shortName, setShortName] = useState(previous?.shortName || shortNameFrom(startName));
  const [shortEdited, setShortEdited] = useState(!!previous?.shortName);
  const [themeColor, setThemeColor] = useState(previous?.themeColor && isHexColor(previous.themeColor) ? previous.themeColor : COLOURS[0]);
  const [display, setDisplay] = useState<AppSettings["display"]>(previous?.display || "standalone");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [boardDone, setBoardDone] = useState<{ before: string; removed: boolean } | null>(null);
  const [pkg, setPkg] = useState<{ zip: Uint8Array; fileName: string; page: string; notes: string; kind: PackageKind } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const settings = (): AppSettings => {
    const n = cleanAppName(name);
    return { name: n, shortName: cleanAppName(shortName, APP_SHORT_NAME_MAX) || shortNameFrom(n), themeColor, display };
  };

  const close = () => { abort.current?.abort(); onClose(); };

  const addToSketch = () => {
    setError("");
    const result = applyApp(code, settings());
    if (!result.ok) { setError(result.reason); return; }
    setBoardDone({ before: code, removed: false });
    onCodeChange(result.code);
  };

  const removeFromSketch = () => {
    setError("");
    setBoardDone({ before: code, removed: true });
    onCodeChange(removeApp(code));
  };

  const download = (bytes: Uint8Array, fileName: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const buildPackage = async () => {
    if (!packageKind || busy) return;
    const s = settings();
    if (!s.name) { setError("Give the app a name."); return; }
    setBusy(true);
    setError("");
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const [icon192, icon512] = await Promise.all([fetchPng("/icons/icon-192.png"), fetchPng("/icons/icon-512.png")]);
      const result = await callAiEndpoint<{ html: string; notes: string }>("/api/ai/app-page", {
        code, description, name: s.name, themeColor: s.themeColor, kind: packageKind,
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.blocked && result.info) {
        onQuotaBlocked(result.info);
        const when = result.info.resetAt ? ` It refills ${formatWhen(result.info.resetAt)}.` : "";
        setError(`Your AI allowance is used up for now, and the agent writes the app's page with it.${when}`);
        return;
      }
      if (!result.ok || !result.data?.html) { setError(result.error || "The app page couldn't be written. Try again."); return; }
      const files = appPackageFiles({
        html: result.data.html, notes: result.data.notes || "", settings: s, kind: packageKind,
        icon192, icon512, version: Date.now().toString(36),
      });
      const bytes = zip(files);
      const fileName = `${appSlug(s.name)}.zip`;
      setPkg({ zip: bytes, fileName, page: prepareAppPage(result.data.html, s), notes: result.data.notes || "", kind: packageKind });
      download(bytes, fileName);
    } catch (err: any) {
      if (err?.name === "AbortError" || controller.signal.aborted) return;
      setError(err?.message || "The app couldn't be built. Try again.");
    } finally {
      if (abort.current === controller) { abort.current = null; setBusy(false); }
    }
  };

  // What the project can become, said plainly when it's nothing yet.
  const nothing = deliveries.length === 0;
  const why = project.boardProblem
    ?? (project.wifi
      ? "This project joins Wi-Fi but doesn't serve a web page or use an internet service yet. Ask the agent to add a web page to control it, then build the app."
      : "Apps are for projects a phone can talk to: a web page on Wi-Fi, Bluetooth (the ESP32's own, or a module like the HC-05 or HM-10), or an internet service (also over a SIM card). Ask the agent to add one, then build the app.");

  const field = "w-full bg-[var(--bg-root)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)]";
  const label = "block text-[11px] font-semibold text-[var(--text-muted)] mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="build-app-title">
      <div data-build-app={nothing ? "none" : delivery === "board" ? "board" : "package"} data-build-app-kind={packageKind ?? undefined} className="w-full max-w-lg bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-main)] shrink-0 gap-2">
          <h2 id="build-app-title" className="font-display font-bold text-sm flex items-center gap-2 text-[var(--text-main)] min-w-0">
            <Smartphone size={15} className="text-[var(--accent-secondary)] shrink-0" />
            <span className="truncate">Build App (PWA)</span>
          </h2>
          <button type="button" onClick={close} title="Close" className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto terminal-scrollbar p-5 space-y-4 min-h-0 text-[var(--text-main)]">
          {boardDone ? (
            <BoardDone removed={boardDone.removed} onUndo={() => { onCodeChange(boardDone.before); setBoardDone(null); }} onClose={close} />
          ) : pkg ? (
            <PackageDone pkg={pkg} kind={pkg.kind} onDownload={() => download(pkg.zip, pkg.fileName)} onClose={close} />
          ) : nothing ? (
            <div data-build-app-why className="text-xs text-[var(--text-muted)] leading-relaxed border border-dashed border-[var(--border-main)] rounded-lg px-4 py-5">
              <p className="text-[var(--text-main)] font-medium mb-1">This project can't be an app yet.</p>
              <p>{why}</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <img src="/icons/icon-192.png" alt="" width={48} height={48} className="rounded-xl shrink-0" />
                <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                  Your app gets the Joint-Agent icon on the home screen, and the name you give it here.
                </p>
              </div>

              <div>
                <label className={label} htmlFor="build-app-name">App name</label>
                <input id="build-app-name" className={field} value={name} maxLength={APP_NAME_MAX}
                  onChange={(e) => {
                    const v = filterNameInput(e.target.value);
                    setName(v);
                    if (!shortEdited) setShortName(shortNameFrom(v));
                  }} placeholder="Plant Monitor" />
              </div>
              <div>
                <label className={label} htmlFor="build-app-short">Name under the icon <span className="font-normal text-[var(--text-subtle)]">(up to {APP_SHORT_NAME_MAX} letters)</span></label>
                <input id="build-app-short" className={field} value={shortName} maxLength={APP_SHORT_NAME_MAX}
                  onChange={(e) => { setShortName(filterNameInput(e.target.value, APP_SHORT_NAME_MAX)); setShortEdited(true); }} placeholder="Plant" />
              </div>

              <div>
                <span className={label}>Colour</span>
                <div className="flex items-center gap-2 flex-wrap">
                  {COLOURS.map((c) => (
                    <button key={c} type="button" onClick={() => setThemeColor(c)} title={c} aria-label={`Colour ${c}`} aria-pressed={themeColor === c}
                      className={`w-7 h-7 rounded-full border-2 transition ${themeColor === c ? "border-[var(--accent-primary)] scale-110" : "border-[var(--border-main)]"}`}
                      style={{ background: c }} />
                  ))}
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] cursor-pointer">
                    <input type="color" value={themeColor} onChange={(e) => isHexColor(e.target.value) && setThemeColor(e.target.value.toLowerCase())}
                      className="w-7 h-7 rounded border border-[var(--border-main)] bg-transparent cursor-pointer" aria-label="Any colour" />
                    Any colour
                  </label>
                </div>
              </div>

              <div>
                <span className={label}>Opens as</span>
                <div className="grid grid-cols-2 gap-2">
                  {([["standalone", "App window", "Keeps the phone's status bar"], ["fullscreen", "Full screen", "Hides the status bar"]] as const).map(([id, title, sub]) => (
                    <button key={id} type="button" onClick={() => setDisplay(id)} aria-pressed={display === id}
                      className={`text-left px-3 py-2 rounded-lg border transition ${display === id ? "border-[var(--accent-primary)] bg-[var(--accent-primary-soft)]" : "border-[var(--border-main)] hover:bg-[var(--bg-hover)]"}`}>
                      <span className="block text-xs font-semibold">{title}</span>
                      <span className="block text-[10px] text-[var(--text-muted)]">{sub}</span>
                    </button>
                  ))}
                </div>
              </div>

              {deliveries.length > 1 && (
                <div>
                  <span className={label}>How phones get it</span>
                  <div className="grid grid-cols-2 gap-2">
                    {deliveries.map((id) => [id, ...DELIVERY_LABELS[id]] as const).map(([id, title, Icon]) => (
                      <button key={id} type="button" onClick={() => setDelivery(id)} aria-pressed={delivery === id}
                        className={`text-left px-3 py-2 rounded-lg border transition flex items-center gap-2 ${delivery === id ? "border-[var(--accent-primary)] bg-[var(--accent-primary-soft)]" : "border-[var(--border-main)] hover:bg-[var(--bg-hover)]"}`}>
                        <Icon size={13} className="shrink-0 text-[var(--accent-secondary)]" />
                        <span className="text-xs font-semibold">{title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <DeliveryNote delivery={delivery} />
              {!canBoard && project.boardProblem && (
                <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">The board&rsquo;s own page can&rsquo;t be made an app: {project.boardProblem}</p>
              )}

              {error && <p role="alert" className="text-xs text-red-400 leading-relaxed">{error}</p>}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                {delivery === "board" ? (
                  <>
                    <button type="button" onClick={addToSketch} disabled={!cleanAppName(name)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-50" style={{ background: "var(--gradient-hero)" }}>
                      {project.applied ? "Update the app in my sketch" : "Add the app to my sketch"}
                    </button>
                    {project.applied && (
                      <button type="button" onClick={removeFromSketch}
                        className="px-3 py-2 rounded-lg text-xs border border-[var(--border-main)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] flex items-center gap-1.5">
                        <Trash2 size={12} /> Remove it
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" onClick={buildPackage} disabled={busy || !cleanAppName(name) || !signedIn}
                    className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-50 flex items-center gap-2" style={{ background: "var(--gradient-hero)" }}>
                    {busy ? <><Loader2 size={13} className="animate-spin" /> The agent is writing your app…</> : <><Download size={13} /> Build and download the app</>}
                  </button>
                )}
              </div>
              {packageKind && !signedIn && <p className="text-[11px] text-[var(--text-muted)]">Sign in to build the app package.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeliveryNote({ delivery }: { delivery: Delivery }) {
  const text = delivery === "board"
    ? <>Adds the app&rsquo;s name and icon to your sketch: one <code>#include</code>, one line in <code>setup()</code> and a few tags in the page. After you flash it, open the board&rsquo;s page on the phone and add it to the home screen. On iPhone it opens full screen like an app; on Android and computers it&rsquo;s a home-screen icon that opens in the browser, because a board&rsquo;s address can&rsquo;t be secure (https).</>
    : delivery === "bluetooth"
      ? <>The agent writes the app&rsquo;s page for this project, using your AI allowance, and you download it as a .zip to put on any free https site. It talks to the board over Bluetooth Low Energy in Chrome on Android, and in Chrome or Edge on Windows, Mac and Chromebooks. iPhone and iPad browsers can&rsquo;t use Bluetooth.</>
      : delivery === "classic"
        ? <>The agent writes the app&rsquo;s page for this project, using your AI allowance, and you download it as a .zip to put on any free https site. It talks to the board over Classic Bluetooth in Chrome on Android, and in Chrome or Edge on computers, once the board is paired in the Bluetooth settings. iPhone and iPad can&rsquo;t connect to Classic Bluetooth.</>
        : <>The agent writes the app&rsquo;s page for this project, using your AI allowance, and you download it as a .zip to put on any free https site. It installs on Android, iPhone and computers, and talks to the same internet service as your board. No password or key from your sketch is put in it.</>;
  return (
    <p data-build-app-note className="text-[11px] text-[var(--text-muted)] leading-relaxed flex items-start gap-1.5">
      <Info size={12} className="mt-0.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

function BoardDone({ removed, onUndo, onClose }: { removed: boolean; onUndo: () => void; onClose: () => void }) {
  return (
    <div data-build-app-done="board" className="space-y-3">
      <p className="text-sm font-semibold flex items-center gap-2"><Check size={15} className="text-green-400" /> {removed ? "The app was removed from your sketch." : "Your sketch now makes the board's page an app."}</p>
      {!removed && (
        <ol className="text-xs text-[var(--text-muted)] leading-relaxed list-decimal pl-5 space-y-1.5">
          <li>Compile and flash the board.</li>
          <li>Connect the phone to the board&rsquo;s Wi-Fi (or the same Wi-Fi as the board) and open the board&rsquo;s page in Safari or Chrome. If a sign-in window pops up when the phone joins, close it and choose to stay connected (on iPhone, &ldquo;Use without internet&rdquo;): the home-screen option is only in the browser.</li>
          <li>
            Add it to the home screen:
            <ul className="list-disc pl-4 mt-1 space-y-0.5">
              <li>iPhone and iPad (Safari): Share, then Add to Home Screen.</li>
              <li>Android (Chrome): the ⋮ menu, then Add to Home screen.</li>
              <li>Computer (Chrome): the ⋮ menu, Cast, save and share, then Create shortcut, ticking Open as window.</li>
            </ul>
          </li>
        </ol>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onUndo} className="px-3 py-2 rounded-lg text-xs border border-[var(--border-main)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] flex items-center gap-1.5">
          <Undo2 size={12} /> Undo
        </button>
        <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-semibold text-white" style={{ background: "var(--gradient-hero)" }}>Done</button>
      </div>
    </div>
  );
}

function PackageDone({ pkg, kind, onDownload, onClose }: { pkg: { fileName: string; page: string; notes: string }; kind: PackageKind; onDownload: () => void; onClose: () => void }) {
  return (
    <div data-build-app-done="package" className="space-y-3">
      <p className="text-sm font-semibold flex items-center gap-2"><Check size={15} className="text-green-400" /> Your app is ready: {pkg.fileName}</p>
      {pkg.notes && (
        <p data-build-app-notes className="text-xs leading-relaxed border border-[var(--border-main)] rounded-lg px-3 py-2 bg-[var(--bg-root)]">
          <span className="font-semibold">From the agent: </span>{pkg.notes}
        </p>
      )}
      <div className="flex justify-center">
        {/* No allow-same-origin: the page's scripts run, but can't reach this app. */}
        <iframe title="App preview" srcDoc={pkg.page} sandbox="allow-scripts allow-forms"
          className="bg-white rounded-lg border border-[var(--border-main)] w-full" style={{ maxWidth: 360, height: 360 }} />
      </div>
      <ol className="text-xs text-[var(--text-muted)] leading-relaxed list-decimal pl-5 space-y-1.5">
        <li>Unzip it. Put the folder online for free: drag it onto <span className="font-mono">app.netlify.com/drop</span>, or upload its files to a GitHub repository with Pages turned on.</li>
        <li>Open the https link on the phone or computer, then install it: Android (Chrome) menu, Install app; iPhone (Safari) Share, Add to Home Screen; computer, the install icon in the address bar.</li>
        {kind === "bluetooth" && <li>Bluetooth works in Chrome on Android, and in Chrome or Edge on Windows, Mac and Chromebooks, not in iPhone or iPad browsers.</li>}
        {kind === "classic" && <li>Pair the board in the phone&rsquo;s or computer&rsquo;s Bluetooth settings first (a PIN, if asked, is usually 1234 or 0000), then tap Connect in the app. It works in Chrome on Android, and in Chrome or Edge on computers, not on iPhone or iPad.</li>}
      </ol>
      <p className="text-[11px] text-[var(--text-subtle)]">The same steps are in README.txt inside the .zip.</p>
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={onDownload} className="px-3 py-2 rounded-lg text-xs border border-[var(--border-main)] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-hover)] flex items-center gap-1.5">
          <Download size={12} /> Download again
        </button>
        <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-xs font-semibold text-white" style={{ background: "var(--gradient-hero)" }}>Done</button>
      </div>
    </div>
  );
}
