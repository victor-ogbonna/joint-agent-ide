import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import AdminPage from './AdminPage.tsx';
import HomePage from './HomePage.tsx';
import PrivacyPage from './PrivacyPage.tsx';
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
  const { user, loading } = useAuth();
  const [holding, setHolding] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setHolding(false), MIN_LAUNCH_MS);
    return () => clearTimeout(t);
  }, []);

  if (loading || holding) return <LaunchScreen />;

  return user ? <App /> : <HomePage />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute ? (
      <AdminPage />
    ) : isPrivacyRoute ? (
      <PrivacyPage />
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
