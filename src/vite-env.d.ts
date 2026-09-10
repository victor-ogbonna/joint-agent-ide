/// <reference types="vite/client" />

// Build-time config read by the client bundle. Vite only exposes variables
// prefixed with VITE_, and inlines them at build time — so these are public,
// and no secret belongs here.
interface ImportMetaEnv {
  /** Discovery survey offered after a waitlist signup. Empty hides the offer. */
  readonly VITE_SURVEY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
