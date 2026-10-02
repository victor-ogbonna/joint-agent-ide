// First, before anything else runs: stand-ins for newer browser functions
// that older browsers (old laptops' Chrome) lack.
import './lib/polyfills.ts';
import {StrictMode, Suspense, lazy, useEffect, useState, type ComponentType} from 'react';
import {createRoot} from 'react-dom/client';
import { AuthProvider, useAuth } from './contexts/AuthContext.tsx';
import type { User } from 'firebase/auth';
import VerifyEmailScreen from './components/VerifyEmailScreen.tsx';
import './index.css';
import { startInstallSupport } from './lib/installApp.ts';
import { captureRefFromUrl } from './lib/referral.ts';
import { warmPaystack } from './lib/paystackScript.ts';

// Caught before anything renders: Chrome's install offer can arrive while the
// launch screen is still up.
startInstallSupport();
// A creator's link: its code waits here until the visitor has signed in.
captureRefFromUrl();

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
// A creator's own page (server/creators.ts): signs in on its own, and is
// never held behind the pre-launch lock, since creators promote before launch.
const isCreatorRoute = currentPath === '/creator';
// Team and school licenses (server/teams.ts): signs in on its own; joining by
// a team's link (/team?join=CODE) lands here.
const isTeamRoute = currentPath === '/team';
// A shared project's read-only page (server/share.ts). Public like /privacy:
// people opening a link someone sent them mostly have no account.
const shareId = /^\/share\/([A-Za-z0-9_-]{22})$/.exec(currentPath)?.[1] ?? null;

// Paystack's checkout script, fetched once the page is up, where a payment
// can start (the app's Plans page, /team).
if (!isAdminRoute && !shareId && !isPrivacyRoute && !isThanksRoute && !isWaitlistRoute && !isCreatorRoute) warmPaystack();

// Each page is its own download, so a visit fetches only the page it shows:
// the home page no longer carries the whole app, and the app downloads while
// the launch screen runs instead of before it. A download that fails is tried
// once more after a moment; after that the page asks for a reload.
type Page = ComponentType<any>;
function pageLoader(load: () => Promise<{ default: Page }>): () => Promise<Page | null> {
  let page: Promise<Page | null> | null = null;
  return () => {
    if (!page) {
      page = load()
        .catch(() => new Promise((resolve) => setTimeout(resolve, 1500)).then(load))
        .then((m) => m.default)
        .catch(() => null);
    }
    return page;
  };
}
const loadApp = pageLoader(() => import('./App.tsx'));
const loadHome = pageLoader(() => import('./HomePage.tsx'));
function lazyPage(load: () => Promise<Page | null>) {
  return lazy(async () => ({ default: (await load()) ?? LoadFailed }));
}
const HomePageForWaitlist = lazyPage(loadHome);
const AdminPage = lazyPage(pageLoader(() => import('./AdminPage.tsx')));
const PrivacyPage = lazyPage(pageLoader(() => import('./PrivacyPage.tsx')));
const ThanksPage = lazyPage(pageLoader(() => import('./ThanksPage.tsx')));
const SharePage = lazyPage(pageLoader(() => import('./SharePage.tsx')));
const CreatorPage = lazyPage(pageLoader(() => import('./CreatorPage.tsx')));
const TeamPage = lazyPage(pageLoader(() => import('./TeamPage.tsx')));

/** The page once downloaded; null while it downloads (or isn't wanted yet); "failed" if it couldn't download. */
function usePage(load: () => Promise<Page | null>, wanted: boolean): Page | null | 'failed' {
  const [state, setState] = useState<{ page: Page | null | 'failed' }>({ page: null });
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void load().then((page) => { if (live) setState({ page: page ?? 'failed' }); });
    return () => { live = false; };
  }, [load, wanted]);
  return state.page;
}

/** A page that couldn't download: the connection dropped, or a new version of the site replaced it. */
function LoadFailed() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-root)] text-[var(--text-main)] p-6">
      <div className="max-w-sm rounded-2xl border border-[var(--border-main)] bg-[var(--bg-panel)] p-6 text-center">
        <img src="/logo.png" alt="" className="mx-auto h-10 w-10 rounded-lg" />
        <h1 className="mt-3 text-[17px] font-bold">Joint-Agent IDE couldn't finish loading</h1>
        <p className="mt-2 text-[14px] text-[var(--text-muted)]">Check your internet connection, then reload the page.</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-full px-5 text-[14px] font-bold text-white" style={{ background: 'var(--gradient-hero)' }}>
          Reload
        </button>
      </div>
    </div>
  );
}

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

/** An email-and-password account whose address isn't verified yet, as this browser last heard. */
function maybeUnverified(user: User | null): boolean {
  return !!user && !user.emailVerified && user.providerData.some((p) => p.providerId === 'password');
}

function RootRoute() {
  const { user, loading, signOut, sendVerificationEmail, refreshVerification } = useAuth();
  const [holding, setHolding] = useState(true);
  const [access, setAccess] = useState<'checking' | 'open' | 'locked'>('checking');
  const [accessDenied, setAccessDenied] = useState(false);
  // Signed in with an email and password not yet verified (VerifyEmailScreen),
  // launch lock or not. recheck looks again once it is.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [recheck, setRecheck] = useState(0);
  // The signed-in account the decision below was made for. Until it's made,
  // a possibly unverified one waits on the launch screen rather than opening
  // the app for a moment (whose first requests the server would refuse).
  const [decidedFor, setDecidedFor] = useState<User | null>(null);

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
    // The verify screen and the access decision change together, so nothing
    // shows in between (the app, for an account the lock then turns away).
    const decide = (next: 'open' | 'locked', verify = false) => {
      setNeedsVerify(verify);
      setAccess(next);
      setDecidedFor(user);
    };
    (async () => {
      // Asked straight away, alongside the sign-in check below rather than
      // after it.
      const status: Promise<{ launchLocked?: boolean }> = fetch('/api/launch-status').then((r) => r.json());
      status.catch(() => { /* handled where it's awaited */ });
      try {
        // An email-and-password account is used once its address is
        // verified; the server refuses it until then (server/quota.ts).
        // Google accounts come verified. Decided by how this session signed
        // in, as the server decides it; an account with no password can't
        // have signed in with one, so it skips the token (which, an hour
        // after the last, Google has to renew first).
        if (user && user.providerData.some((p) => p.providerId === 'password')) {
          const token = await user.getIdTokenResult();
          if (cancelled) return;
          if (token.signInProvider === 'password') {
            if (!user.emailVerified) return decide('open', true);
            // Verified since this sign-in's token was made (the link opened
            // in another tab, say): a new one carries it to the server.
            if (token.claims.email_verified !== true) await user.getIdToken(true);
            if (cancelled) return;
          }
        }

        const { launchLocked } = await status;
        if (cancelled) return;
        if (!launchLocked) return decide('open');
        if (!user) return decide('locked');

        // Locked and signed in. Only the server knows who is allowlisted, so
        // ask it rather than shipping the list to the browser.
        const idToken = await user.getIdToken();
        const probe = await fetch('/api/quota/status', { headers: { Authorization: `Bearer ${idToken}` } });
        if (cancelled) return;
        if (probe.status === 403) {
          // Not verified after all, as far as the server can tell: ask for
          // it rather than turning the account away.
          const { code } = await probe.json().catch(() => ({ code: null }));
          if (cancelled) return;
          if (code === 'EMAIL_NOT_VERIFIED') return decide('open', true);
          await signOut();
          setAccessDenied(true);
          decide('locked');
        } else {
          decide('open');
        }
      } catch {
        // Falls open (see above), except that an account this browser knows
        // is unverified still gets the verify screen.
        if (!cancelled) decide('open', maybeUnverified(user));
      }
    })();
    return () => { cancelled = true; };
  }, [user, signOut, recheck]);

  // The app as soon as an account is known, the home page otherwise:
  // downloading while the launch screen runs.
  const app = usePage(loadApp, !loading && !!user);
  const home = usePage(loadHome, !loading && (!user || access === 'locked'));

  if (loading || holding || access === 'checking') return <LaunchScreen />;
  if (maybeUnverified(user) && decidedFor !== user) return <LaunchScreen />;

  if (needsVerify && user) {
    return (
      <VerifyEmailScreen
        email={user.email}
        onResend={sendVerificationEmail}
        onCheck={async () => {
          const verified = await refreshVerification();
          if (verified) setRecheck((n) => n + 1);
          return verified;
        }}
        // Stays up until the sign-out is done, so the app never shows in
        // between; the decision above then runs again for nobody signed in.
        onSignOut={signOut}
      />
    );
  }

  // Locked: everyone without a grant sees the waitlist page. inviteSignIn keeps
  // a sign-in door open for accounts that have been granted access — without it
  // a granted VC could never get in, which would make the grant meaningless.
  const page = access === 'locked' || !user ? home : app;
  if (page === 'failed') return <LoadFailed />;
  // Still downloading: the launch screen stays (the same one, still running).
  if (!page) return <LaunchScreen />;
  const Page = page;
  if (access === 'locked') return <Page waitlistMode inviteSignIn accessDenied={accessDenied} />;

  return <Page />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<LaunchScreen />}>
    {isAdminRoute ? (
      <AdminPage />
    ) : shareId ? (
      <SharePage shareId={shareId} />
    ) : isPrivacyRoute ? (
      <PrivacyPage />
    ) : isThanksRoute ? (
      <ThanksPage />
    ) : isCreatorRoute ? (
      <AuthProvider>
        <CreatorPage />
      </AuthProvider>
    ) : isTeamRoute ? (
      <AuthProvider>
        <TeamPage />
      </AuthProvider>
    ) : isWaitlistRoute ? (
      // Same marketing page, product doors removed. Rendered outside
      // AuthProvider deliberately — nothing on it touches auth.
      <HomePageForWaitlist waitlistMode />
    ) : (
      <AuthProvider>
        <RootRoute />
      </AuthProvider>
    )}
    </Suspense>
  </StrictMode>,
);
