import React, { useEffect, useState } from "react";
import { Shield, Key, LogOut, Eye, EyeOff, Check, AlertCircle, Loader2, CreditCard } from "lucide-react";

const TOKEN_KEY = "jointagent_admin_token";

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(false);

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

  const authHeaders = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  const loadConfig = async (t: string) => {
    setLoadingConfig(true);
    try {
      const res = await fetch("/api/admin/config", { headers: authHeaders(t) });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        return;
      }
      const data = await res.json();
      setMaskedKey(data.maskedApiKey);
      setHasKey(data.hasKey);
    } catch (e) {
      setSaveMessage({ type: "error", text: "Could not reach the server." });
    } finally {
      setLoadingConfig(false);
    }
  };

  const loadPaystackConfig = async (t: string) => {
    setLoadingPaystackConfig(true);
    try {
      const res = await fetch("/api/admin/paystack-config", { headers: authHeaders(t) });
      if (res.status === 401) return;
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

  useEffect(() => {
    if (token) {
      loadConfig(token);
      loadPaystackConfig(token);
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

  const handleSaveKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !newKey.trim()) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ apiKey: newKey.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMessage({ type: "error", text: data.error || "Failed to save the key." });
        return;
      }
      setMaskedKey(data.maskedApiKey);
      setHasKey(true);
      setNewKey("");
      setSaveMessage({
        type: "success",
        text: data.durable
          ? "Gemini API key updated — takes effect immediately and will survive restarts."
          : "Gemini API key updated and takes effect immediately, but will revert on the next restart (RENDER_API_KEY/RENDER_SERVICE_ID aren't set, so this save isn't durable)."
      });
    } catch (e) {
      setSaveMessage({ type: "error", text: "Could not reach the server." });
    } finally {
      setSaving(false);
    }
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
      const res = await fetch("/api/admin/paystack-config", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify(body)
      });
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
            <p className="text-xs text-[var(--text-muted)]">Sign in to manage the Gemini API key.</p>
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

      <main className="max-w-lg mx-auto p-6">
        <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
              <Key size={14} />
            </div>
            <h2 className="font-display font-bold text-sm">Gemini API Key</h2>
          </div>

          <div className="text-xs text-[var(--text-muted)] space-y-1">
            <p>
              Current key:{" "}
              {loadingConfig ? (
                <span className="italic">loading…</span>
              ) : hasKey ? (
                <span className="font-mono text-[var(--text-main)]">{maskedKey}</span>
              ) : (
                <span className="text-red-400">not set — AI features are using the offline mock generator</span>
              )}
            </p>
          </div>

          <form onSubmit={handleSaveKey} className="space-y-3">
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="Paste a new Gemini API key"
                className="w-full bg-[var(--bg-surface)] border border-[var(--border-main)] rounded-lg pl-3 pr-9 py-2 text-sm font-mono text-[var(--text-main)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent-primary)] transition"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
                title={showKey ? "Hide" : "Show"}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>

            <button
              type="submit"
              disabled={saving || !newKey.trim()}
              className="flex items-center justify-center gap-1.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded-lg transition"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save Key
            </button>
          </form>

          {saveMessage && (
            <div className={`flex items-start gap-1.5 text-xs ${saveMessage.type === "success" ? "text-green-400" : "text-red-400"}`}>
              {saveMessage.type === "success" ? <Check size={13} className="mt-0.5 shrink-0" /> : <AlertCircle size={13} className="mt-0.5 shrink-0" />}
              <span>{saveMessage.text}</span>
            </div>
          )}

          <p className="text-[10px] text-[var(--text-subtle)] leading-relaxed border-t border-[var(--border-main)] pt-3">
            Changing the key takes effect immediately for new AI requests — no redeploy needed. It's stored on the server only (never shown here in full again).
          </p>
        </div>

        <div className="bg-[var(--bg-panel)] border border-[var(--border-main)] rounded-xl p-5 space-y-4 mt-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-orange-500/10 rounded-md text-orange-600">
              <CreditCard size={14} />
            </div>
            <h2 className="font-display font-bold text-sm">Paystack ($7/mo Paywall)</h2>
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
              placeholder="Plan code (PLN_...) for the $7/month plan"
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
            Test-mode keys/plan work fine before your Paystack account finishes live activation. Fields are saved individually — leave any blank to keep its current value.
          </p>
        </div>
      </main>
    </div>
  );
}
