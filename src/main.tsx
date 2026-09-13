import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import AdminPage from './AdminPage.tsx';
import HomePage from './HomePage.tsx';
import PrivacyPage from './PrivacyPage.tsx';
import ThanksPage from './ThanksPage.tsx';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import './index.css';

// No router library yet. Every extra route here bypasses Firebase auth on
// purpose: /admin has its own password gate, /privacy has to be publicly
// readable (Google's OAuth consent screen links to it), and /waitlist is a
// share link handed to people who don't have an account yet — sending them
// through a sign-in wall would defeat the point.
const currentPath = window.location.pathname.replace(/\/+$/, '');
const isAdminRoute = currentPath === '/admin';
const isPrivacyRoute = currentPath === '/privacy';
const isWaitlistRoute = currentPath === '/waitlist';
// Where a successful waitlist signup lands. Public and auth-free like
// /waitlist — the people seeing it do not have accounts yet.
const isThanksRoute = currentPath === '/thanks';

// Auth usually resolves in a few hundred ms — too fast for the power-on to
// register as intentional rather than as a flicker. Long enough to land, short
// enough that nobody waits on it.
const MIN_LAUNCH_MS = 1500;

function LaunchScreen() {
  return (
    <div className="launch-screen">
      <div className="launch-stage">
        <svg className="launch-reticle" viewBox="0 0 200 200" aria-hidden="true">
          <circle
            className="launch-ring-outer"
            cx="100" cy="100" r="92" fill="none"
            stroke="var(--accent-primary)" strokeOpacity="0.5"
            strokeWidth="1" strokeDasharray="10 14" strokeLinecap="round"
          />
          <circle
            className="launch-ring-mid"
            cx="100" cy="100" r="74" fill="none"
            stroke="var(--accent-secondary)" strokeOpacity="0.38"
            strokeWidth="1" strokeDasharray="3 9" strokeLinecap="round"
          />
        </svg>

        <span className="launch-pulse" />
        <span className="launch-pulse" />

        <span className="launch-bracket tl" />
        <span className="launch-bracket tr" />
        <span className="launch-bracket bl" />
        <span className="launch-bracket br" />

        <div className="launch-core">
          <img src="/logo.png" alt="Joint-Agent IDE" />
          <span className="launch-scan" />
        </div>
      </div>

      {/* Bar only, no wording — the sequence is short enough that a status
          line would be gone before it could be read. */}
      <div className="launch-readout">
        <span className="launch-track"><span className="launch-fill" /></span>
      </div>
    </div>
  );
}

function RootRoute() {
  const { user, loading, signOut } = useAuth();
  const [holding, setHolding] = useState(true);
  const [access, setAccess] = useState<'checking' | 'open' | 'locked'>('checking');
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setHolding(false), MIN_LAUNCH_MS);
    return () => clearTimeout(t);
  }, []);

  // The pre-launch lock (admin page -> Pre-launch lock). This is presentation
  // only: the server refuses locked-out accounts at the middleware regardless,
  // so the worst a bypass achieves is a UI that 403s on every action. That is
  // also why a failed check falls open rather than closed — a blip must not
  // lock out the whole product.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/launch-status');
        const { launchLocked } = await res.json();
        if (cancelled) return;
        if (!launchLocked) return setAccess('open');
        if (!user) return setAccess('locked');

        // Locked and signed in. Only the server knows who is allowlisted, so
        // ask it rather than shipping the list to the browser.
        const idToken = await user.getIdToken();
        const probe = await fetch('/api/quota/status', { headers: { Authorization: `Bearer ${idToken}` } });
        if (cancelled) return;
        if (probe.status === 403) {
          await signOut();
          setAccessDenied(true);
          setAccess('locked');
        } else {
          setAccess('open');
        }
      } catch {
        if (!cancelled) setAccess('open');
      }
    })();
    return () => { cancelled = true; };
  }, [user, signOut]);

  if (loading || holding || access === 'checking') return <LaunchScreen />;

  // Locked: everyone without a grant sees the waitlist page. inviteSignIn keeps
  // a sign-in door open for accounts that have been granted access — without it
  // a granted VC could never get in, which would make the grant meaningless.
  if (access === 'locked') return <HomePage waitlistMode inviteSignIn accessDenied={accessDenied} />;

  return user ? <App /> : <HomePage />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute ? (
      <AdminPage />
    ) : isPrivacyRoute ? (
      <PrivacyPage />
    ) : isThanksRoute ? (
      <ThanksPage />
    ) : isWaitlistRoute ? (
      // Same marketing page, product doors removed. Rendered outside
      // AuthProvider deliberately — nothing on it touches auth.
      <HomePage waitlistMode />
    ) : (
      <AuthProvider>
        <RootRoute />
      </AuthProvider>
    )}
  </StrictMode>,
);
