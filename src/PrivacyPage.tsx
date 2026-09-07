import React from "react";
import { ArrowLeft } from "lucide-react";

// Required by Google's OAuth consent screen, and genuinely needed since the
// app handles accounts, payments, and prompt content. Written to describe what
// the code actually does — if data handling changes, this needs updating too.
const LAST_UPDATED = "4 September 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-display font-semibold text-base text-[var(--text-main)] mb-2">{title}</h2>
      <div className="text-sm text-[var(--text-muted)] leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    // h-full for the same reason as HomePage — #root is height:100% with
    // overflow:hidden, so a min-height here is clipped instead of scrolled.
    <div className="h-full w-full bg-[var(--bg-root)] text-[var(--text-main)] overflow-y-auto">
      <header className="border-b border-[var(--border-main)] px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <a
            href="/"
            className="flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-main)] transition"
          >
            <ArrowLeft size={14} /> Back to Joint-Agent
          </a>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-12">
        <h1 className="font-display font-bold text-3xl mb-2">Privacy Policy</h1>
        <p className="text-xs text-[var(--text-subtle)] font-mono mb-10">Last updated: {LAST_UPDATED}</p>

        <Section title="Who we are">
          <p>
            Joint-Agent is an AI-assisted development environment for microcontrollers, operated by
            Ogbontor Engineering Enterprise. This policy explains what data the service collects, why,
            and who it is shared with. Questions can be sent to{" "}
            <a href="mailto:victorogbonna313@gmail.com" className="text-[var(--accent-secondary)] hover:underline">
              victorogbonna313@gmail.com
            </a>.
          </p>
        </Section>

        <Section title="What we collect">
          <p>
            <strong className="text-[var(--text-main)]">Account details.</strong> When you create an account we
            store your email address, and your name if you provide one. If you sign in with Google, we receive
            your email address, name, and profile picture from Google — we never see or store your Google
            password.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Your projects.</strong> Code, project names, and
            hardware settings you create are stored so you can return to them later.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Usage counts.</strong> We record how much AI usage your
            account has consumed, in order to enforce free and paid limits.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Subscription status.</strong> If you subscribe, we store
            whether your subscription is active and when the current period ends.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Waitlist email.</strong> If you join the waitlist, we
            store only the email address you submit.
          </p>
        </Section>

        <Section title="What we do not collect">
          <p>
            We never receive or store your card details. Payments are handled entirely by Paystack on their own
            systems.
          </p>
          <p>
            When you connect a microcontroller over USB, that connection is made directly by your browser to
            your device. We do not receive the contents of that serial connection, and connecting a board does
            not transmit anything about your hardware to us.
          </p>
        </Section>

        <Section title="Who your data is shared with">
          <p>
            <strong className="text-[var(--text-main)]">Google (Firebase).</strong> Accounts, projects, and
            usage records are stored using Firebase Authentication and Firestore.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Google (Gemini API).</strong> When you use the AI agent,
            the message you send and the relevant project code are transmitted to Google's Gemini API to
            generate a response. Do not paste passwords, API keys, or other secrets into the agent.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Paystack.</strong> If you subscribe, your email address
            and payment details go to Paystack to process the transaction.
          </p>
          <p>
            <strong className="text-[var(--text-main)]">Render.</strong> Our application runs on Render's
            infrastructure, which processes requests on our behalf.
          </p>
          <p>
            We do not sell your data, and we do not share it with advertisers.
          </p>
        </Section>

        <Section title="Why we process it">
          <p>
            To provide the service (running your account, saving your work, generating code), to enforce usage
            limits fairly, to process payments you have chosen to make, and to keep the service secure.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Account details, projects, and usage records are kept while your account exists. Waitlist emails are
            kept until launch or until you ask us to remove them. If you ask us to delete your account, we
            remove your account record and stored projects.
          </p>
        </Section>

        <Section title="Your choices">
          <p>
            You can ask us to access, correct, or delete the personal data we hold about you by emailing{" "}
            <a href="mailto:victorogbonna313@gmail.com" className="text-[var(--accent-secondary)] hover:underline">
              victorogbonna313@gmail.com
            </a>
            . You can ask to be removed from the waitlist at any time using the same address.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Connections to the service use HTTPS. Access to your projects and account record requires you to be
            signed in. No service can promise perfect security, but we aim to limit what is collected in the
            first place.
          </p>
        </Section>

        <Section title="Children">
          <p>
            The service is not directed at children under 13, and we do not knowingly collect their personal
            data.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If this policy changes, we will update the date at the top of this page.
          </p>
        </Section>

        <p className="text-[11px] text-[var(--text-subtle)] border-t border-[var(--border-main)] pt-6 mt-10">
          Joint-Agent · Powered by Ogbontor Engineering Enterprise
        </p>
      </main>
    </div>
  );
}
