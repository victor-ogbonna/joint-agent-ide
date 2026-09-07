# Joint-Agent

An autonomous AI agent for embedded systems development that runs entirely in a browser tab.

Describe hardware behaviour in plain English. The agent writes the C++ firmware, compiles it
on a real PlatformIO toolchain, reads and fixes its own compiler errors, and flashes the
microcontroller over Web Serial. Nothing to install locally.

- 466 supported boards (ESP32 and Arduino/AVR families)
- Real cloud compilation — firmware either compiles or it doesn't
- Browser-to-hardware flashing with a live serial monitor
- Circuit schematic generation
- Free tier, and a $7/month Pro tier

## Running locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

Routes: `/` the app, `/waitlist` the public pre-launch page, `/privacy`, `/admin`.

## Environment

Copy `.env.example` to `.env` and fill it in. `DEEPSEEK_API_KEY` powers the agent;
`GEMINI_API_KEY` is used only for voice transcription.

## Notes on the rebrand from Afro-Joint

Two things deliberately still reference the original project, because they are
infrastructure rather than branding:

- **`src/lib/firebase.ts`** — the Firebase project ID, storage bucket and app ID name the
  live Firebase project. Renaming those strings would point at a project that doesn't
  exist and break sign-in. See the comment in that file for how to migrate properly.
- **Paystack** — the subscription amount comes from the plan referenced by
  `PAYSTACK_PLAN_CODE`, not from the code. The UI now says $7/month, so create a matching
  $7 plan in Paystack and set that plan code, or the displayed price and the charged
  price will disagree.
