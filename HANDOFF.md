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
| Last commit | `bdce627` — plan-mode rewrite, tool streaming, empty-prompt validation |
| Pre-launch lock | **ON** — leave it on. Victor knows. Only granted accounts get in. |
| Waitlist | 9 real signups. **Never pollute this** — clean up any test data. |
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

## Still to do

### 1. Sidebar project / chat history — NOT STARTED, the big one

The left sidebar should list previously created projects and past chats so a
user can return to them. Nothing exists yet. Projects are currently in-session
only — read how `currentProjectIdRef` and project state work in `src/App.tsx`
before designing storage. `users/{uid}/projects` in Firestore is the natural
home; the admin-gated waitlist route in `server/waitlist.ts` is a good pattern
for a per-user collection endpoint.

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
