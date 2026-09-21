# Joint-Agent IDE — continuation brief

Paste this whole file as the first message in a new chat.

---

## Who and what

Victor Ogbonna, solo founder. **Joint-Agent IDE** — an AI agent that writes,
compiles and flashes embedded firmware from a browser tab, nothing installed.
React 19 + Vite frontend, Express/tsx backend, DeepSeek V4 Flash for the agent,
Gemini for voice transcription only, PlatformIO cloud compilation (espressif32 +
atmelavr, 466 boards), Web Serial flashing, Firebase auth + Firestore, Paystack
billing.

Project lives at `~/joint-agent-project` (NOT the primary working directory,
which is a different older project — always `cd ~/joint-agent-project` first).

## Live state

| | |
|---|---|
| Production | **https://jointagentide.com** (Hetzner `138.201.91.112`, Docker + Caddy, auto HTTPS) |
| Repo | `git@github.com:victor-ogbonna/joint-agent-ide.git`, branch `master` |
| Last commit | `198da88` — GitHub integration |
| Pre-launch lock | **ON** — leave it on. Victor knows. Only granted accounts get in. |
| Waitlist | 56 real signups. **Never pollute this** — clean up any test data. |
| Users | 7 real user docs in Firestore. Same rule. |
| Paystack | Live keys, plan `PLN_t62cgm1fovgz0he`, ₦9,300/mo. UI shows "$7" deliberately — reverting to a USD plan once his Zenith domiciliary account clears. |

**afrojoint.xyz is retired** — dropped from Caddy. DNS still points at the server;
Victor may or may not delete the Cloudflare records.

## How to deploy (this exact sequence — it has bitten twice)

```bash
cd ~/joint-agent-project
git add -A && git commit -m "..."
git archive --format=tar HEAD | ssh victor@138.201.91.112 "tar xf - -C ~/joint-agent"
ssh victor@138.201.91.112 'cd ~/joint-agent && docker compose up -d --force-recreate --build'
```

Three hard-won rules:

1. **`--force-recreate` is required.** Plain `up -d --build` rebuilds the image
   but can leave the old container running, reporting `Container Running` instead
   of `Recreated`. It silently ships nothing.
2. **`.env` is NOT in git** (correctly). Any `VITE_*` variable the client needs
   must be passed as a Docker **build arg** — Vite inlines them at build time and
   `.env` is dockerignored. See `VITE_SURVEY_URL` in `Dockerfile` /
   `docker-compose.yml` for the pattern. Getting this wrong makes a feature work
   in dev and silently do nothing in production.
3. **Verify against the deployed bundle, never the build output:**
   ```bash
   curl -s https://jointagentide.com/ -o /tmp/h.html
   js=$(grep -o '/assets/index-[^"]*\.js' /tmp/h.html | head -1)
   curl -s "https://jointagentide.com$js" -o /tmp/b.js
   grep -q "some new string" /tmp/b.js && echo present || echo MISSING
   ```
   **Never** write `grep -o X | head -1 && echo ok` — a pipeline returns the exit
   status of its LAST command and `head` always succeeds, so that test passes
   whether or not the string exists. This produced several false "verified"
   claims.

Server code changes need a restart; only `src/` hot-reloads.
Admin sessions are in-memory, so every deploy logs Victor out of `/admin`.

## Already fixed and deployed (do not redo)

Verified against the deployed bundle, not the build log:

- **Plan mode is now concise.** `server.ts` plan instruction rewritten to scale
  length to complexity, never print firmware in chat, and decide with stated
  defaults rather than interrogate. Measured on Victor's exact complaint prompt
  ("blink my esp32 inbuilt led for 5 seconds"): **1,200 words -> 103, seven
  clarifying questions -> zero, code block -> none**, and the timing it quotes is
  now internally consistent (500+500ms x 5 = 5s).
- **It no longer asks for board facts it already has.** It receives board, MCU,
  clock, RAM, flash and the exposed pin list from `describeBoardForPrompt`.
  Settled decision: do NOT force a new project on login — the data was never
  missing, the instruction to trust it was.
- **Code quality instruction** added to BOTH code-generating prompts: real
  comments explaining why, and honour a technique the user names (millis over
  delay) instead of substituting. Verified: 24 comment lines in 62, millis()
  used, no real delay() call.
- **Tool-call streaming.** `server/deepseek.ts` emits `onToolProgress` as tool
  arguments accumulate; `server.ts` forwards it as a `tool_progress` SSE event
  throttled to 1.2s; `src/App.tsx` renders it. Three progress events on a real
  generation, so code generation no longer shows a dead spinner.
- **Empty/whitespace prompts** return 400 `EMPTY_PROMPT` before reaching the
  model. They previously produced a ~1,000-character greeting billed to the user.
- **Blank assistant bubbles** guarded — a `command` event with no text now falls
  back to naming the command.
- **Chat re-render storm fixed.** The markdown body is extracted into a memoised
  `MessageMarkdown` in `src/components/AgentChat.tsx`, so a streaming reply no
  longer re-parses every other message's markdown and KaTeX on every token.
- **Proceed to Implement is now a one-shot.** It no longer calls
  `setChatMode("implement")`, so the session stays in plan mode and a follow-up
  question still gets a plan. Nothing implements until the button is pressed.

## Added since (all deployed and verified against the live bundle)

- **Board search is ranked, not filtered.** It was a substring match over
  name/mcu/vendor, so "mega" matched ATmega328P and returned 189 of 224 AVR
  boards with Arduino Uno first. `scoreBoard` in `NewProjectModal.tsx` now
  scores by where the match lands; first-party vendor breaks ties. Searching on
  the wrong family tab auto-switches on zero matches and otherwise offers a
  "switch tab" line.
- **Board selection is derived, not stored.** The old fallback was
  `familyBoards[0]` (Arduino Uno), so after a search nothing was highlighted
  while Create quietly said "Create on Arduino Uno". A click is now remembered
  with the query it was made under.
- **USB detection reports a catalogue board id.** Arduino's own VID (0x2341)
  distinguishes Uno from Mega 2560; New Project preselects it. Generic bridges
  (CH340/CP2102/FTDI) still identify nothing.
- **Welcome dialog on sign-in** — new project vs a recent one. Fires once per
  uid per page load.
- **Terminal clears on project create.**
- **Chat markdown rhythm tightened** via `.chat-prose` in `index.css`.
- **In-app feedback.** `server/feedback.ts` + `FeedbackWidget.tsx`. Feedback row
  at the bottom of the left rail (floating button on narrow layouts only — a
  floating button on wide layouts landed on top of Serial Plotter). Writes to
  Firestore FIRST, then tries to email, so nothing is ever lost. Listed in
  `/admin`. **To turn on email delivery**, add to `.env` ON THE SERVER:
  `RESEND_API_KEY=...` and `FEEDBACK_TO_EMAIL=...` (optionally
  `FEEDBACK_FROM_EMAIL=...`), then restart. No code change needed; `/admin`
  shows whether it is on.
- **"autonomously"** added to the meta description, og:description,
  twitter:description and JSON-LD.

## AVR flashing — fixed, but UNTESTED ON REAL SILICON

Mega 2560 failed at sync every time; the Uno path was broken the same way and
only appeared to work when the USB bridge happened to deliver one byte at a
time. Three defects, all in `src/lib/avrFlash.ts`:

1. `readExactly()` returned `out.slice(0, count)` with **no carry-over buffer**,
   so every byte of a chunk past `count` was discarded. A bridge delivers a
   whole frame in one chunk, so reading the 1-byte frame marker binned the rest
   of the 17-byte sign-on reply.
2. It raced `reader.read()` against a timeout. A real
   `ReadableStreamDefaultReader` **queues** read requests and serves them in
   order, so the orphaned request ate the next chunk and gave it to nobody —
   one timeout poisoned every retry.
   Both replaced by `SerialBuffer`: one pump loop owns `read()`.
3. `CMD_PROGRAM_FLASH_ISP` sent a **13-byte header**; `stk500boot.c` reads page
   data from a fixed `msgBuffer+10`, so every page landed 3 bytes late. Now 10.
   That loop is `do { ... size -= 2 } while (size)`, which underflows on an odd
   length, so short final pages are padded to even.

**Ground truth lives on disk** — the real Mega bootloader source is at
`~/.platformio/packages/framework-arduino-avr/bootloaders/stk500v2/stk500boot.c`.
Read it before changing protocol code; it beats recalling avrdude. It also
confirms `boot_timeout` is ~7 seconds, so sync failures are never a timing
problem, and `_FIX_ISSUE_505_` is defined, so incrementing sequence numbers is
fine.

Two things deliberately NOT changed, both proposed and then refuted: leaving
DTR/RTS asserted after reset (avrdude's `wiring.c` does the same), and the
0x80 extended-address bit in `CMD_LOAD_ADDRESS` (the bootloader's `<<1`
discards it, which is why avrdude sends it too).

**`npm run test:flash`** drives the real flasher against transcriptions of both
bootloaders at four USB chunk sizes and diffs the flash image against the input
hex. It fails 7 of 8 cases on the pre-fix code, reproducing the exact reported
error. Run it after ANY change to the flasher.

**Still unverified on hardware.** Victor has a Mega 2560 and an Uno; both need a
live test. Ask for the terminal log either way.

## GitHub — built, needs ONE thing from Victor

The whole flow is implemented (`server/github.ts`, `src/components/GithubPanel.tsx`)
and degrades gracefully until it is configured. To switch it on:

1. Create an OAuth App at https://github.com/settings/developers
   - Homepage URL: `https://jointagentide.com`
   - Authorization callback URL: `https://jointagentide.com/api/github/callback`
2. Add to `.env` **on the server**: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
   (optionally `GITHUB_TOKEN_SECRET`; it falls back to the client secret).
3. `docker compose up -d --force-recreate` — it is server-side, so a restart is
   required.

Until then `/api/github/status` returns `configured:false` and the panel shows
the setup instructions instead of a dead button. Tokens are AES-256-GCM
encrypted at rest; the OAuth state is HMAC-signed with a 10-minute TTL.

## Flashing transports

- **Web Serial** (Chrome/Edge desktop, incl. macOS) — the original path.
- **WebUSB** (`src/lib/webusbSerial.ts`) — for Chrome on Android, which has no
  Web Serial. Drivers for CDC-ACM, CH340, CP210x, FTDI behind the same port
  surface, so `flashAvr` and esptool-js are unchanged. Register details come
  from the Linux drivers; the widely-copied CH341_BAUDBASE_FACTOR formula is
  WRONG for current silicon.
- **iPhone/iPad: impossible.** Every iOS browser is WebKit, which has neither
  API. Not a bug to fix.

`npm test` runs both simulators (`test:flash`, `test:webusb`). Run it after any
change to a flasher.

## DeepSeek

The model is `deepseek-flash`, which IS DeepSeek-V4.1-Flash (released
2026-09-10). It is a ROLLING name — a newer flash release is picked up with no
code change. `deepseek-v4-flash` was an alias that temporarily routes to the
same model. There is no `deepseek-v4.1-flash` model id; the API rejects it.
From 2026-09-14 `deepseek-v4-pro` also routes to V4.1-Flash.

## Still to do

### 1. Chat history per project — partially done

**Done and live:** the sidebar now lists recent projects under a "Recent"
heading below the three action buttons, marks the open one, caps at 12 with a
"View all" link into the Browse modal, and refetches whenever the current
project changes. It reuses `handleOpenProject` and the existing
`listProjects()` — projects were already persisted to Firestore, so this was a
listing change, not new storage.

**Not done:** *chat* history. Conversations are still per-session and are lost
on reload. `chatMessages` in `src/App.tsx` is local state and is never written
to Firestore. If Victor wants past conversations back, persist them under the
project (`users/{uid}/projects/{projectId}/messages` or a `messages` array on
the project doc) and load them in `handleOpenProject`. Note the free-tier token
cost of replaying long histories — `CHAT_HISTORY_WINDOW` is 16 in `server.ts`.

### 2. Time-to-first-token is still 7-16 seconds

Measured after the fixes: 7.4s (plan) and 10.4s (implement) before the first
token. That is DeepSeek's own latency, not a bug in this code, and the
`tool_progress` events only start once the tool call begins — so the opening
silence remains. Consider an immediate client-side "thinking" indicator the
moment the request is sent, rather than waiting for the first server event.

### 3. Free tier burns faster than advertised

~22 exploratory prompts consumed **13,435 of the 50,000 lifetime token cap (27%)**.
The site claims "roughly 15 complete projects". Raise with Victor rather than
silently changing.

### 4. It answers anything

"Capital of France + a poem about rain" produced both, billed to the user. Decide
with Victor whether to scope the agent to embedded topics.

## Verified working — don't break these

- Prompt injection refused cleanly
- 240V-to-GPIO request refused with a genuinely good safety explanation
- Multi-turn memory works (recalled "pin 34" two turns later)
- Nigerian Pidgin prompts work and generate correct code
- Invalid pins rejected against the real exposed-pin list

## How to test the agent as a real user

Auth is required. Mint a throwaway token with the Admin SDK, exchange it via
`identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken`, call
`/api/ai/chat`, then **delete the test user doc and auth user afterwards**.
Test against `http://localhost:3000` (local `.admin-config.json` has the lock
off) so production state is never touched. Each prompt costs real DeepSeek
credits — be deliberate about volume.

## Working style Victor expects

- He says "make no mistakes" often and means it. Verify claims against the
  deployed artifact, not the build log.
- State plainly when something was your own error — several bugs in this project
  were mine and naming them directly built trust.
- Never paste secrets into chat. Never sign in on his behalf or enter payment
  details. Direct him to do those himself.
- He is a beginner at hosting and deployment but an experienced embedded
  engineer. Explain infrastructure carefully; do not over-explain hardware.
- Tell him which terminal a command belongs in — local (`penguin`) vs server
  (`ubuntu-4gb-fsn1-1`). Confusing the two has cost real time.

## Still outstanding, non-code

- Admin password still the original, and `/admin` is on a public domain
- Google Form intro may still say "Around 5 minutes" — he wanted that removed
- Deck at https://claude.ai/code/artifact/8824cb00-e549-4856-9a80-4533d22fedac
  (private; must be shared from the artifact's own menu before sending to a VC)
- Brand lockup in `brand/` — use `brand/mark-trimmed.png`, never
  `public/logo.png`, which has ~16% transparent padding baked in
