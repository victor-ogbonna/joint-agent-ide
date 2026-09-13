import React, { useEffect, useState } from "react";
import { useDocumentScroll } from "./useDocumentScroll";
import { Shield, Lock, LogOut, Eye, EyeOff, Check, AlertCircle, Loader2, CreditCard, Users, Copy, RefreshCw, UserPlus, Trash2 } from "lucide-react";

const TOKEN_KEY = "jointagent_admin_token";

export default function AdminPage() {
  useDocumentScroll();
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);



  const [paystackHasSecretKey, setPaystackHasSecretKey] = useState(false);
  const [paystackMaskedSecretKey, setPaystackMaskedSecretKey] = useState<string | null>(null);
  const [paystackPublicKey, setPaystackPublicKey] = useState<string | null>(null);
  const [paystackPlanCode, setPaystackPlanCode] = useState<string | null>(null);
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newPublicKey, setNewPublicKey] = useState("");
  const [newPlanCode, setNewPlanCode] = useState("");
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [savingPaystack, setSavingPaystack] = useState(false);
  const [paystackSaveMessage, setPaystackSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loadingPaystackConfig, setLoadingPaystackConfig] = useState(false);

  type WaitlistEntry = { email: string; joinedAt: string | null };
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [loadingWaitlist, setLoadingWaitlist] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [copiedEmails, setCopiedEmails] = useState(false);

  const [launchLocked, setLaunchLocked] = useState<boolean | null>(null);
  const [togglingLock, setTogglingLock] = useState(false);

  const [proEmails, setProEmails] = useState<string[]>([]);
  const [earlyEmails, setEarlyEmails] = useState<string[]>([]);
  const [ownerEmails, setOwnerEmails] = useState<string[]>([]);
  const [newGrantEmail, setNewGrantEmail] = useState("");
  const [newGrantTier, setNewGrantTier] = useState<"pro" | "early">("pro");
  const [savingGrants, setSavingGrants] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  const authHeaders = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  // Admin sessions live in a Map in the server process, so every restart —
  // including every deploy — forgets them while the browser still holds its
  // token. Without this the page stays in a half-logged-in state and every
  // card renders "Not authenticated" instead of asking for the password again.
  const handleSessionExpired = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setLoginError("Your admin session expired. Please sign in again.");
  };

  /** Returns null when the session is gone, having already reset to the login screen. */
  const adminFetch = async (t: string, path: string, init?: RequestInit): Promise<Response | null> => {
    const res = await fetch(path, { ...init, headers: authHeaders(t) });
    if (res.status === 401) {
      handleSessionExpired();
      return null;
    }
    return res;
  };


  const loadPaystackConfig = async (t: string) => {
    setLoadingPaystackConfig(true);
    try {
      const res = await adminFetch(t, "/api/admin/paystack-config");
      if (!res) return;
      const data = await res.json();
      setPaystackHasSecretKey(data.hasSecretKey);
      setPaystackMaskedSecretKey(data.maskedSecretKey);
      setPaystackPublicKey(data.publicKey);
      setPaystackPlanCode(data.planCode);
    } catch (e) {
      setPaystackSaveMessage({ type: "error", text: "Could not reach the server." });
    } finally {
      setLoadingPaystackConfig(false);
    }
  };

  const loadWaitlist = async (t: string) => {
    setLoadingWaitlist(true);
    setWaitlistError(null);
    try {
      const res = await adminFetch(t, "/api/waitlist/entries");
      if (!res) return;
      const data = await res.json();
      if (!res.ok) {
        setWaitlistError(data.error || "Could not load the waitlist.");
        return;
      }
      setWaitlist(data.entries || []);
    } catch {
      setWaitlistError("Could not reach the server.");
    } finally {
      setLoadingWaitlist(false);
    }
  };

  const loadLaunchStatus = async (t: string) => {
    try {
      const res = await adminFetch(t, "/api/admin/launch-status");
      if (!res || !res.ok) return;
      const data = await res.json();
      setLaunchLocked(data.launchLocked);
    } catch { /* leave as null; the toggle renders disabled */ }
  };

  const toggleLaunchLock = async (next: boolean) => {
    if (!token) return;
    setTogglingLock(true);
    try {
      const res = await adminFetch(token, "/api/admin/launch-status", {
        method: "POST",
        body: JSON.stringify({ launchLocked: next })
      });
      if (!res) return;
      const data = await res.json();
      if (res.ok) setLaunchLocked(data.launchLocked);
    } catch { /* keep the previous state on failure */ }
    finally { setTogglingLock(false); }
  };

  const loadAccessLists = async (t: string) => {
    try {
      const res = await adminFetch(t, "/api/admin/access-lists");
      if (!res || !res.ok) return;
      const d = await res.json();
      setProEmails(d.proAccessEmails || []);
      setEarlyEmails(d.earlyAccessEmails || []);
      setOwnerEmails(d.ownerEmails || []);
    } catch { /* lists stay empty; the form still works */ }
  };

  const saveGrants = async (pro: string[], early: string[]) => {
    if (!token) return;
    setSavingGrants(true);
    setGrantError(null);
    try {
      const res = await adminFetch(token, "/api/admin/access-lists", {
        method: "POST",
        body: JSON.stringify({ proAccessEmails: pro, earlyAccessEmails: early })
      });
      if (!res) return;
      const d = await res.json();
      if (!res.ok) {
        setGrantError(d.error || "Could not save.");
        return;
      }
      setProEmails(d.proAccessEmails || []);
      setEarlyEmails(d.earlyAccessEmails || []);
    } catch {
      setGrantError("Could not reach the server.");
    } finally {
      setSavingGrants(false);
    }
  };

  const addGrant = (e: React.FormEvent) => {
    e.preventDefault();
    const email = newGrantEmail.trim().toLowerCase();
    if (!email) return;
    // Adding to one tier removes from the other, so an address is never in both.
    const pro = newGrantTier === "pro"
      ? Array.from(new Set([...proEmails, email]))
      : proEmails.filter((x) => x !== email);
    const early = newGrantTier === "early"
      ? Array.from(new Set([...earlyEmails, email]))
      : earlyEmails.filter((x) => x !== email);
    setNewGrantEmail("");
    saveGrants(pro, early);
  };

  const removeGrant = (email: string) =>
    saveGrants(proEmails.filter((x) => x !== email), earlyEmails.filter((x) => x !== email));

  const handleCopyEmails = async () => {
    try {
      await navigator.clipboard.writeText(waitlist.map((w) => w.email).join(", "));
      setCopiedEmails(true);
      setTimeout(() => setCopiedEmails(false), 2000);
    } catch {
      setWaitlistError("Clipboard blocked by the browser — select the list manually.");
    }
  };

  useEffect(() => {
    if (token) {
      loadPaystackConfig(token);
      loadWaitlist(token);
      loadLaunchStatus(token);
      loadAccessLists(token);
    }
  }, [token]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || "Login failed.");
        return;
      }
      sessionStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPassword("");
    } catch (e) {
      setLoginError("Could not reach the server.");
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    if (token) {
      try {
        await fetch("/api/admin/logout", { method: "POST", headers: authHeaders(token) });
      } catch (e) {}
    }
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
  };


  const handleSavePaystackConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    const body: Record<string, string> = {};
    if (newSecretKey.trim()) body.secretKey = newSecretKey.trim();
    if (newPublicKey.trim()) body.publicKey = newPublicKey.trim();
    if (newPlanCode.trim()) body.planCode = newPlanCode.trim();
    if (Object.keys(body).length === 0) return;

    setSavingPaystack(true);
    setPaystackSaveMessage(null);
    try {
      const res = await adminFetch(token, "/api/admin/paystack-config", {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (!res) return;
      const data = await res.json();
      if (!res.ok) {
        setPaystackSaveMessage({ type: "error", text: data.error || "Failed to save Paystack config." });
        return;
      }
      setPaystackHasSecretKey(data.hasSecretKey);
      setPaystackMaskedSecretKey(data.maskedSecretKey);
      setPaystackPublicKey(data.publicKey);
      setPaystackPlanCode(data.planCode);
      setNewSecretKey("");
      setNewPublicKey("");
      setNewPlanCode("");
      setPaystackSaveMessage({
        type: "success",
        text: data.durable
          ? "Paystack config updated — takes effect immediately and will survive restarts."
          : "Paystack config updated and takes effect immediately, but will revert on the next restart (RENDER_API_KEY/RENDER_SERVICE_ID aren't set, so this save isn't durable)."
      });
    } catch (e) {
      setPaystackSaveMessage({ type: "error", text: "Could not reach the server." });
    } finally {
      setSavingPaystack(false);
    }
  };

  if (!token) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-root)] text-[var(--text-main)] p-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl shadow-2xl p-6 space-y-4"
        >
          <div className="flex flex-col items-center gap-2 text-center">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg"
              style={{ background: "var(--gradient-hero)" }}
            >
              <Shield size={22} />
            </div>
            <h1 className="font-display font-bold text-lg">Admin Access</h1>
            <p className="text-xs text-[var(--text-muted)]">Sign in to manage payments and the waitlist.</p>
          </div>

          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Admin password"
            className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
          />

          {loginError && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertCircle size={13} /> {loginError}
            </div>
          )}

          <button
            type="submit"
            disabled={loggingIn || !password}
            className="w-full flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-semibold py-2 rounded-lg transition"
          >
            {loggingIn ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
            Sign In
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-[var(--bg-root)] text-[var(--text-main)]">
      <header className="h-12 border-b border-[var(--border-main)] px-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white shadow-md" style={{ background: "var(--gradient-hero)" }}>
            <Shield size={14} />
          </div>
          <h1 className="font-display font-bold text-sm">Admin</h1>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] transition px-2 py-1 rounded-md hover:bg-[var(--bg-hover)]"
        >
          <LogOut size={13} /> Sign Out
        </button>
      </header>

      <main className="max-w-lg mx-auto p-6 pb-16">
        <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4 mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
              <Lock size={14} />
            </div>
            <h2 className="font-display font-bold text-sm">Pre-launch lock</h2>
            <button
              type="button"
              role="switch"
              aria-checked={launchLocked === true}
              aria-label="Pre-launch lock"
              disabled={launchLocked === null || togglingLock}
              onClick={() => toggleLaunchLock(!launchLocked)}
              className={`ml-auto relative w-11 h-6 rounded-full transition disabled:opacity-50 ${launchLocked ? "bg-orange-600" : "bg-[var(--bg-surface)] border border-[var(--border-main)]"}`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${launchLocked ? "left-6" : "left-1"}`} />
            </button>
          </div>

          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            {launchLocked === null
              ? "Loading…"
              : launchLocked
                ? "ON — the IDE is closed. Launch IDE is hidden, and anyone signed in who isn't allowlisted is signed out. The homepage and waitlist stay public."
                : "OFF — the IDE is open to everyone who signs in."}
          </p>

          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
            Allowlisted while locked: <span className="font-mono">victorogbonna313@gmail.com</span> (usage never counted)
            and <span className="font-mono">chineduogbonna313@gmail.com</span> (counted normally).
            Both must sign in with Google — the allowlist ignores unverified email addresses.
          </p>
        </div>

        <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4 mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
              <UserPlus size={14} />
            </div>
            <h2 className="font-display font-bold text-sm">Granted access</h2>
            <span className="ml-auto font-mono text-xs text-[var(--text-main)]">
              {proEmails.length + earlyEmails.length}
            </span>
          </div>

          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            These accounts can use the IDE even while the pre-launch lock is on.
            <span className="text-[var(--text-main)]"> Pro</span> also gets the paid
            token allowance without paying — for VCs and design partners.
            <span className="text-[var(--text-main)]"> Regular</span> gets the normal
            free allowance.
          </p>

          <form onSubmit={addGrant} className="space-y-2">
            <input
              type="email"
              value={newGrantEmail}
              onChange={(e) => setNewGrantEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-[var(--border-main)] overflow-hidden">
                {(["pro", "early"] as const).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => setNewGrantTier(tier)}
                    className={`px-3 py-2 text-xs font-semibold transition ${newGrantTier === tier ? "bg-orange-600 text-white" : "text-[var(--text-muted)] hover:text-[var(--text-main)]"}`}
                  >
                    {tier === "pro" ? "Pro" : "Regular"}
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={savingGrants || !newGrantEmail.trim()}
                className="flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition"
              >
                {savingGrants ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />}
                Grant access
              </button>
            </div>
          </form>

          {grantError && (
            <div className="flex items-start gap-1.5 text-xs text-red-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{grantError}</span>
            </div>
          )}

          {(proEmails.length > 0 || earlyEmails.length > 0) && (
            <div className="border border-[var(--border-main)] rounded-lg divide-y divide-[var(--border-main)] max-h-56 overflow-y-auto">
              {[...proEmails.map((e) => [e, "Pro"] as const), ...earlyEmails.map((e) => [e, "Regular"] as const)].map(([email, tier]) => (
                <div key={email} className="flex items-center gap-2 px-3 py-2 text-xs">
                  <span className="font-mono text-[var(--text-main)] truncate">{email}</span>
                  <span className={`shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded ${tier === "Pro" ? "bg-orange-500/15 text-orange-500" : "bg-[var(--bg-surface)] text-[var(--text-muted)]"}`}>
                    {tier}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeGrant(email)}
                    disabled={savingGrants}
                    aria-label={`Remove ${email}`}
                    className="ml-auto shrink-0 p-1 text-[var(--text-subtle)] hover:text-red-400 transition disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
            Owner, always unmetered and not editable here:{" "}
            <span className="font-mono">{ownerEmails.join(", ") || "—"}</span>.
            Granted accounts must sign in with Google — an unverified email address never matches a grant.
          </p>
        </div>

        <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
              <CreditCard size={14} />
            </div>
            <h2 className="font-display font-bold text-sm">Paystack subscription</h2>
          </div>

          <div className="text-xs text-[var(--text-muted)] space-y-1">
            <p>
              Secret key:{" "}
              {loadingPaystackConfig ? (
                <span className="italic">loading…</span>
              ) : paystackHasSecretKey ? (
                <span className="font-mono text-[var(--text-main)]">{paystackMaskedSecretKey}</span>
              ) : (
                <span className="text-red-400">not set — the Subscribe button shows a "not configured" state</span>
              )}
            </p>
            <p>
              Public key: <span className="font-mono text-[var(--text-main)]">{paystackPublicKey || "not set"}</span>
            </p>
            <p>
              Plan code: <span className="font-mono text-[var(--text-main)]">{paystackPlanCode || "not set"}</span>
            </p>
          </div>

          <form onSubmit={handleSavePaystackConfig} className="space-y-3">
            <div className="relative">
              <input
                type={showSecretKey ? "text" : "password"}
                value={newSecretKey}
                onChange={(e) => setNewSecretKey(e.target.value)}
                placeholder="Paystack secret key (sk_...)"
                className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-3 pr-9 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
              />
              <button
                type="button"
                onClick={() => setShowSecretKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
                title={showSecretKey ? "Hide" : "Show"}
              >
                {showSecretKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <input
              type="text"
              value={newPublicKey}
              onChange={(e) => setNewPublicKey(e.target.value)}
              placeholder="Paystack public key (pk_...)"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />
            <input
              type="text"
              value={newPlanCode}
              onChange={(e) => setNewPlanCode(e.target.value)}
              placeholder="Plan code (PLN_...) — Paystack owns the amount"
              className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg px-3 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
            />

            <button
              type="submit"
              disabled={savingPaystack || (!newSecretKey.trim() && !newPublicKey.trim() && !newPlanCode.trim())}
              className="flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition"
            >
              {savingPaystack ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save Paystack Config
            </button>
          </form>

          {paystackSaveMessage && (
            <div className={`flex items-start gap-1.5 text-xs ${paystackSaveMessage.type === "success" ? "text-green-400" : "text-red-400"}`}>
              {paystackSaveMessage.type === "success" ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
              <span>{paystackSaveMessage.text}</span>
            </div>
          )}

          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
            The plan code decides what customers are charged — the amount and currency live in Paystack, not in this app, so switching plans needs no redeploy. Fields are saved individually; leave any blank to keep its current value.
          </p>
        </div>

        <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4 mt-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
              <Users size={14} />
            </div>
            <h2 className="font-display font-bold text-sm">Waitlist</h2>
            <span className="ml-auto font-mono text-xs text-[var(--text-main)]">
              {loadingWaitlist ? "…" : waitlist.length}
            </span>
          </div>

          {waitlistError && (
            <div className="flex items-start gap-1.5 text-xs text-red-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              <span>{waitlistError}</span>
            </div>
          )}

          {!loadingWaitlist && !waitlistError && waitlist.length === 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              Nobody has signed up yet. Signups from <span className="font-mono">/waitlist</span> appear here.
            </p>
          )}

          {waitlist.length > 0 && (
            <div className="max-h-64 overflow-y-auto border border-[var(--border-main)] rounded-lg divide-y divide-[var(--border-main)]">
              {waitlist.map((entry) => (
                <div key={entry.email} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <span className="font-mono text-[var(--text-main)] truncate">{entry.email}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-[var(--text-subtle)]">
                    {entry.joinedAt ? new Date(entry.joinedAt).toLocaleDateString() : "—"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => token && loadWaitlist(token)}
              disabled={loadingWaitlist}
              className="flex items-center justify-center gap-1.5 border border-[var(--border-main)] hover:border-[var(--accent-primary)] disabled:opacity-50 text-[var(--text-main)] text-xs font-semibold px-3 py-2 rounded-lg transition"
            >
              {loadingWaitlist ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Refresh
            </button>
            {waitlist.length > 0 && (
              <button
                type="button"
                onClick={handleCopyEmails}
                className="flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition"
              >
                {copiedEmails ? <Check size={13} /> : <Copy size={13} />}
                {copiedEmails ? "Copied" : "Copy all emails"}
              </button>
            )}
          </div>

          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
            Newest first, up to 500. Paste the copied list into the BCC field when you email the waitlist — never the To field, or every subscriber sees the others' addresses.
          </p>
        </div>
      </main>
    </div>
  );
}
