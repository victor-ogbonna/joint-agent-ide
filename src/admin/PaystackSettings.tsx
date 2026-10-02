import React, { useCallback, useEffect, useState } from "react";
import { CreditCard, Check, AlertCircle, Loader2, Eye, EyeOff, Pencil, Trash2, X, Copy } from "lucide-react";
import { formatMoney } from "../lib/plans";

/**
 * Paystack on the admin page (server/paystack.ts): the keys every payment
 * goes through (PRO monthly, PRO yearly, team licenses) and the two PRO
 * plans, each shown as it is and editable on its own. The secret key is
 * masked until Show; each plan is checked with Paystack, so the page says
 * what customers are really charged. Moving from test keys to live ones (or
 * back) changes both keys at once: the server refuses a test key beside a
 * live one, so a new key of the other kind asks for its partner too.
 */

type Get = (path: string) => Promise<Response | null>;
type Post = (path: string, body: unknown) => Promise<Response | null>;
type Field = "secretKey" | "publicKey" | "planCode" | "yearlyPlanCode";
type Source = "admin" | "server" | null;

interface Config {
  hasSecretKey: boolean;
  maskedSecretKey: string | null;
  publicKey: string | null;
  planCode: string | null;
  yearlyPlanCode: string | null;
  sources: Record<Field, Source>;
}
type PlanCheck = { ok: true; name: string; amount: number; currency: string; interval: string } | { ok: false; error: string };
interface Checked { mode: "test" | "live" | null; keysMatch: boolean | null; monthly: PlanCheck | null; yearly: PlanCheck | null }

const HINTS: Record<Field, { label: string; placeholder: string }> = {
  secretKey: { label: "Secret key", placeholder: "sk_live_..." },
  publicKey: { label: "Public key", placeholder: "pk_live_..." },
  planCode: { label: "Monthly plan (PRO)", placeholder: "PLN_..." },
  yearlyPlanCode: { label: "Yearly plan (PRO)", placeholder: "PLN_..." },
};

const EVERY: Record<string, string> = {
  hourly: "every hour", daily: "every day", weekly: "every week", monthly: "every month",
  quarterly: "every 3 months", biannually: "every 6 months", annually: "every year",
};

/** "test" or "live", from a key's prefix (sk_test_, pk_live_...), as the server reads it. */
const modeOf = (key: string | null | undefined): "test" | "live" | null =>
  (!key ? null : /^[sp]k_test_/.test(key) ? "test" : /^[sp]k_live_/.test(key) ? "live" : null);

const input = "w-full min-w-0 bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition";
const smallButton = "inline-flex items-center gap-1 rounded-md border border-[var(--border-main)] px-2 py-1 text-[11px] font-medium text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50";

function SourceNote({ source }: { source: Source }) {
  if (!source) return null;
  return <span className="text-[10px] text-[var(--text-subtle)]">{source === "admin" ? "saved here" : "from the server's .env file"}</span>;
}

function PlanLine({ check, kind, monthly }: { check: PlanCheck | null | undefined; kind: "monthly" | "yearly"; monthly: PlanCheck | null }) {
  if (check === undefined) return <p className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]"><Loader2 size={11} className="animate-spin" /> Checking with Paystack…</p>;
  if (check === null) return null;
  if ("error" in check) return <p className="text-[11px] text-red-400">{check.error}</p>;
  const expected = kind === "monthly" ? "monthly" : "annually";
  const saving = kind === "yearly" && monthly && "amount" in monthly && monthly.currency === check.currency && monthly.amount > 0
    ? Math.round(100 - (check.amount / (monthly.amount * 12)) * 100)
    : null;
  return (
    <div className="text-[11px]">
      <p className="text-green-400">
        Paystack charges {formatMoney(check.amount, check.currency)} {EVERY[check.interval] || check.interval}{check.name ? ` · “${check.name}”` : ""}
        {saving !== null ? ` · ${saving}% less than 12 months of the monthly plan` : ""}
      </p>
      {check.interval !== expected && (
        <p className="text-orange-400">This plan charges {EVERY[check.interval] || check.interval}, not {kind === "monthly" ? "every month" : "every year"}. Use a plan whose interval is {kind === "monthly" ? "Monthly" : "Annually"}.</p>
      )}
    </div>
  );
}

export default function PaystackSettings({ get, post }: { get: Get; post: Post }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [checked, setChecked] = useState<Checked | null | undefined>(undefined);
  const [editing, setEditing] = useState<Field | null>(null);
  const [value, setValue] = useState("");
  /** The other key, when the one typed is of the other kind (test or live): both are saved together. */
  const [pair, setPair] = useState("");
  const [showTyped, setShowTyped] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const runCheck = useCallback(async () => {
    setChecked(undefined);
    try {
      const res = await get("/api/admin/paystack-check");
      if (!res) return;
      setChecked(res.ok ? await res.json() : null);
    } catch {
      setChecked(null);
    }
  }, [get]);

  const load = useCallback(async () => {
    try {
      const res = await get("/api/admin/paystack-config");
      if (!res) return;
      setConfig(await res.json());
    } catch {
      setMessage({ type: "error", text: "Could not reach the server." });
    }
  }, [get]);

  useEffect(() => { void load(); void runCheck(); }, [load, runCheck]);

  const startEdit = (field: Field) => {
    setEditing(field);
    setShowTyped(false);
    setMessage(null);
    setValue(field === "secretKey" ? "" : (config?.[field] ?? ""));
    setPair("");
  };

  // The secret key's kind, from its masked start ("sk_liv…", "sk_tes…").
  const secretMode = config?.maskedSecretKey?.startsWith("sk_tes") ? "test" : config?.maskedSecretKey?.startsWith("sk_liv") ? "live" : null;
  const partner: Field | null = editing === "secretKey" ? "publicKey" : editing === "publicKey" ? "secretKey" : null;
  const typedMode = modeOf(value.trim());
  const partnerMode = partner === "publicKey" ? modeOf(config?.publicKey) : partner === "secretKey" ? secretMode : null;
  const needsPartner = !!partner && !!typedMode && !!partnerMode && typedMode !== partnerMode;

  /** Saves, and says how it went; the saved settings, or null if it didn't save. */
  const send = async (body: Record<string, unknown>, done: string): Promise<Config | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await post("/api/admin/paystack-config", body);
      if (!res) return null;
      const data = await res.json();
      if (!res.ok) { setMessage({ type: "error", text: data.error || "That couldn't be saved." }); return null; }
      setConfig(data);
      setEditing(null);
      setValue("");
      setPair("");
      setSecret(null);
      setMessage({
        type: "success",
        text: data.durable
          ? `${done} It works straight away, and is kept after restarts and updates.`
          : `${done} It works straight away, but this server keeps it only until it restarts: add it to the server's .env file too.`,
      });
      void runCheck();
      return data;
    } catch {
      setMessage({ type: "error", text: "Could not reach the server." });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const v = value.trim();
    if (!v) { setMessage({ type: "error", text: `Paste the ${HINTS[editing].label.toLowerCase()} first.` }); return; }
    if (needsPartner && partner) {
      const p = pair.trim();
      const other = HINTS[partner].label.toLowerCase();
      if (!p) { setMessage({ type: "error", text: `Paste the ${typedMode} ${other} too: the two keys change together.` }); return; }
      if (modeOf(p) !== typedMode) { setMessage({ type: "error", text: `The ${other} has to be a ${typedMode} key too (it starts with ${partner === "secretKey" ? "sk" : "pk"}_${typedMode}_).` }); return; }
      void send({ [editing]: v, [partner]: p }, `Secret key and public key saved (${typedMode} keys).`);
      return;
    }
    if (editing !== "secretKey" && v === config?.[editing]) { setEditing(null); return; }
    void send({ [editing]: v }, `${HINTS[editing].label} saved.`);
  };

  const removeYearly = () => {
    if (!window.confirm("Remove the yearly plan? The Plans page then offers monthly only. People already paying yearly keep their plan.")) return;
    void send({ clearYearlyPlanCode: true }, "Yearly plan removed.").then((saved) => {
      // The server's .env file can set one too; that one is still used.
      if (saved?.yearlyPlanCode) {
        setMessage({ type: "error", text: `Removed from here, but the server's .env file sets a yearly plan too (PAYSTACK_YEARLY_PLAN_CODE=${saved.yearlyPlanCode}), so it's still offered. To stop offering yearly, delete that line from .env, then restart the server.` });
      }
    });
  };

  const toggleSecret = async () => {
    if (secret) { setSecret(null); return; }
    try {
      const res = await get("/api/admin/paystack-secret");
      if (!res) return;
      const data = await res.json();
      if (res.ok && data.secretKey) setSecret(data.secretKey);
    } catch {
      setMessage({ type: "error", text: "Could not reach the server." });
    }
  };
  const copySecret = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };

  const row = (field: Field, shown: React.ReactNode, extra?: React.ReactNode) => (
    <div className="border-t border-[var(--border-main)] pt-3" data-paystack-field={field}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{HINTS[field].label}</p>
          <div className="mt-0.5 break-all font-mono text-[12px] text-[var(--text-main)]">{shown}</div>
          <SourceNote source={config?.sources[field] ?? null} />
        </div>
        {editing !== field && (
          <div className="flex shrink-0 flex-wrap gap-1.5">
            {field === "secretKey" && config?.hasSecretKey && (
              <button type="button" className={smallButton} onClick={() => void toggleSecret()}>{secret ? <EyeOff size={11} /> : <Eye size={11} />} {secret ? "Hide" : "Show"}</button>
            )}
            {field === "secretKey" && secret && (
              <button type="button" className={smallButton} onClick={() => void copySecret()}>{copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}</button>
            )}
            <button type="button" className={smallButton} disabled={busy} onClick={() => startEdit(field)}>
              <Pencil size={11} /> {field === "secretKey" ? (config?.hasSecretKey ? "Replace" : "Add") : config?.[field] ? "Edit" : "Add"}
            </button>
            {field === "yearlyPlanCode" && config?.yearlyPlanCode && config.sources.yearlyPlanCode === "admin" && (
              <button type="button" className={`${smallButton} hover:text-red-400`} disabled={busy} onClick={removeYearly}><Trash2 size={11} /> Remove</button>
            )}
          </div>
        )}
      </div>
      {editing === field ? (
        <form onSubmit={save} className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor={`paystack-${field}`} className="sr-only">{HINTS[field].label}</label>
          <div className="relative min-w-0 flex-1 basis-56">
            <input
              id={`paystack-${field}`}
              autoFocus
              type={field === "secretKey" && !showTyped ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={HINTS[field].placeholder}
              autoComplete="off"
              spellCheck={false}
              className={`${input} ${field === "secretKey" ? "pr-9" : ""}`}
            />
            {field === "secretKey" && (
              <button type="button" onClick={() => setShowTyped((v) => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-main)]" title={showTyped ? "Hide" : "Show"}>
                {showTyped ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            )}
          </div>
          {needsPartner && partner && (
            <div className="basis-full" data-paystack-pair="">
              <p className="mb-1 text-[11px] text-orange-400">
                That's a {typedMode} key, and the {HINTS[partner].label.toLowerCase()} is a {partnerMode} key. Paste the {typedMode} {HINTS[partner].label.toLowerCase()} too: both are saved together.
              </p>
              <label htmlFor="paystack-pair" className="sr-only">{HINTS[partner].label}</label>
              <input
                id="paystack-pair"
                type={partner === "secretKey" && !showTyped ? "password" : "text"}
                value={pair}
                onChange={(e) => setPair(e.target.value)}
                placeholder={`${partner === "secretKey" ? "sk" : "pk"}_${typedMode}_...`}
                autoComplete="off"
                spellCheck={false}
                className={input}
              />
            </div>
          )}
          <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white hover:bg-orange-500 disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
          </button>
          <button type="button" onClick={() => { setEditing(null); setValue(""); setPair(""); }} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-main)] px-3 py-2 text-xs text-[var(--text-main)] hover:bg-[var(--bg-hover)]">
            <X size={13} /> Cancel
          </button>
        </form>
      ) : extra}
    </div>
  );

  const monthly = checked?.monthly ?? null;
  return (
    <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-3" data-paystack-settings="">
      <div className="flex flex-wrap items-center gap-2">
        <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600"><CreditCard size={14} /></div>
        <h2 className="font-display font-bold text-sm">Paystack</h2>
        {checked?.mode && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${checked.mode === "live" ? "bg-green-500/15 text-green-400" : "bg-orange-500/15 text-orange-400"}`}>
            {checked.mode === "live" ? "Live keys" : "Test keys"}
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        The keys are used for every payment: PRO monthly, PRO yearly and team licenses. The plans set what PRO costs and how often Paystack charges it; their prices live in Paystack.
      </p>
      {checked?.keysMatch === false && (
        <p className="flex items-start gap-1.5 text-xs text-red-400"><AlertCircle size={13} className="mt-0.5 shrink-0" /> The public key and the secret key are of different kinds (one test, one live). Use both test keys or both live keys.</p>
      )}

      {!config ? (
        <p className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]"><Loader2 size={13} className="animate-spin" /> Loading…</p>
      ) : (
        <>
          {row("secretKey", config.hasSecretKey ? (secret || config.maskedSecretKey) : <span className="font-sans text-red-400">Not set: payments can't be taken.</span>)}
          {row("publicKey", config.publicKey || <span className="font-sans text-red-400">Not set: the payment window can't open.</span>)}
          {row("planCode", config.planCode || <span className="font-sans text-red-400">Not set: PRO can't be bought.</span>,
            config.planCode ? <PlanLine check={checked === undefined ? undefined : monthly} kind="monthly" monthly={null} /> : null)}
          {row("yearlyPlanCode", config.yearlyPlanCode || <span className="font-sans text-[var(--text-muted)]">Not set: the Plans page offers monthly only.</span>,
            config.yearlyPlanCode ? <PlanLine check={checked === undefined ? undefined : checked?.yearly ?? null} kind="yearly" monthly={monthly} /> : null)}
        </>
      )}

      {message && (
        <div className={`flex items-start gap-1.5 text-xs ${message.type === "success" ? "text-green-400" : "text-red-400"}`}>
          {message.type === "success" ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
        Team licenses need no plan: the server prices each team payment (seats × price × months) and Paystack takes it once, through these same keys. Paystack's webhook (Settings → API Keys &amp; Webhooks) should point to https://jointagentide.com/api/paystack/webhook.
      </p>
    </div>
  );
}
