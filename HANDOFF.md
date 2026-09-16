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
| Last commit | `b80ceac Add the horizontal logo lockup` |
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

## Work to do

### 1. Plan mode is far too verbose — the main complaint

`server.ts:537` holds the plan-mode instruction. It currently commands
"**detailed**" steps, "**Ensure the user agrees**", "you **MUST** format
clarifying questions as a bulleted list", and "code blocks as appropriate".
The model obeys precisely, so "blink my LED for 5 seconds" produced a
7-section document with a full code dump and **7 clarifying questions**.

Victor wants plan mode **kept, including for small prompts** (he values the
clarification step) but made **concise**.

Required changes to that prompt:

- **Scale depth to complexity.** A one-line request gets a few lines, not seven
  sections. Nothing currently tells it to do this.
- **Never print `main.cpp` code in the chat response.** It duplicates the editor,
  doubles reading, and doubles the output tokens the user is billed for. Drop the
  "Software Architecture" section entirely.
- **Decide, don't interrogate.** Choose sensible defaults, state them in one
  line, ask at most one question and only where a wrong guess wastes real time.
- **Never ask about board specifics.** See §2 — it already has them.
- Keep clarifying questions as a bulleted list, but few and genuinely necessary.

### 2. The agent asks for board facts it already has

`server/boards.ts:138` `describeBoardForPrompt()` already injects
`ESP32 Dev Module (ESP32, 240MHz, 320KB RAM, 4096KB Flash). Pins include D2, D4, ...`
into every request — board, MCU, clock, RAM, flash **and the exposed pin list**.

Despite that, the agent asked the user *"Which GPIO is your board's onboard LED
actually on?"* and *"Are you using the Arduino IDE or PlatformIO?"* (the platform
**is** PlatformIO).

**Decision already made — do not revisit:** do NOT force a new project on login.
The data is already present. Fix the prompt to trust it and commit to a choice.
This matters because the product's whole promise is that hardware trivia is not
the user's problem.

### 3. Generated plans contradict their own code

Real example, verified by simulation: the plan's table claimed 500ms ON / 500ms
OFF and "5 full on/off cycles", while its own generated code
(`(millis()-start) % 500 < 250`) produces **250ms ON / 250ms OFF, 10 cycles** —
wrong by 2x. It compiles fine, so the compiler cannot catch it.

Less prose reduces this surface area, which is another argument for §1. Consider
also instructing it not to state timing numbers it has not derived from the code
it is writing.

### 4. Code comments are sometimes missing entirely

Victor reports generated code sometimes arrives with no comments. The prompt
spends its budget on chat formatting rather than code quality. Add an explicit
code-quality instruction covering comments.

### 5. It doesn't always follow the prompt exactly

Victor: *"sometimes when I say millis instead of delay, the agent should be
smart."* If the user names an approach (`millis()` not `delay()`), honour it
rather than substituting. Add an explicit instruction.

### 6. "Proceed to Implement" must actually gate implementation

Currently the flow can proceed before the user clicks it. Victor wants plan mode
to stay in plan until the user explicitly clicks through, because they may want
to ask follow-up questions first. Check `chatMode` handling in `src/App.tsx`
around the `streamChatEndpoint` call (~line 1177) and the plan/implement toggle.

### 7. Sidebar needs project / chat history

The left sidebar should list previously created projects and past chats so a
user can return to them. Nothing like this exists yet. Projects currently live
in-session; check how `currentProjectIdRef` and project state work in
`src/App.tsx` before designing storage (Firestore per-user is the natural home —
`users/{uid}/projects`).

### 8. Streaming feels jerky — measured, two causes

Measured against the real API (not theory):

| | |
|---|---|
| Time-to-first-token | **1.4s – 16.5s**, highly variable. 13.3s and 16.5s observed on ordinary prompts. |
| Plain chat | streams smoothly — 245 events, median gap 0ms, p90 21ms |
| **Code generation** | 3.5s of total silence, then 99 events in one burst, for 118 visible chars |

Code generation goes through a DeepSeek tool call. `server/deepseek.ts:161`
accumulates tool-call argument deltas silently until the stream ends, emitting
nothing. So the core feature never streams — the user sees a spinner then a dump,
and the only text is one canned line ("I've successfully generated the C++ code…").

Fix direction: emit progress events while tool arguments accumulate so the UI has
something honest to show. Do **not** fake token-by-token output.

### 9. The chat list re-renders on every token

`src/components/AgentChat.tsx:328` maps all messages, each rendering
`<ReactMarkdown>` with `rehypeKatex`. There is **no `React.memo` and no `useMemo`
anywhere in the file**. `src/App.tsx:1172` `updateAssistantMsg` does
`prev.map(...)` per token, so every message re-renders and re-parses its markdown
on every token — ~2,450 markdown parses for one 245-token reply with 10 messages
on screen. Memoise the message component.

### 10. Empty prompts are accepted and billed

`""` and `"   \n  "` both return 200 and generate a ~1,000-char greeting, billed
against the user's token cap. Add server-side validation rejecting empty/
whitespace-only prompts before calling DeepSeek.

### 11. Blank assistant bubbles are possible

`src/App.tsx:1190` does `assistantContent = event.text` on a `command` event.
A `command` event with no text produces an empty bubble. Observed once,
non-deterministically. Guard it.

### 12. Free tier burns faster than advertised

~22 test prompts consumed **13,435 tokens — 27% of the 50,000 lifetime free cap**.
The site claims "roughly 15 complete projects". Only true at ~5 exchanges per
project; beginners iterate far more. Not a bug, but expect complaints — worth
raising with Victor rather than silently changing.

### 13. It answers anything

"What is the capital of France? Also write me a poem about rain" produced Paris
plus a four-stanza poem, billed to the user. A VC will try this. Decide with
Victor whether to scope the agent to embedded topics.

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
