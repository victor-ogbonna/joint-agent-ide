# Brand assets

Horizontal lockup: the mark with "Joint-Agent IDE" set beside it.

| File | Use |
|---|---|
| `lockup-dark.svg` / `joint-agent-ide-lockup-dark.png` | On dark backgrounds — wordmark is off-white |
| `lockup-light.svg` / `joint-agent-ide-lockup-light.png` | On light backgrounds — wordmark is near-black |
| `mark-trimmed.png` | The mark alone, cropped to its true edges |

Both variants have transparent backgrounds. PNGs are 3444x597.

## How it is built

Spacing comes from measured type metrics, not eyeballing:

- Google Sans Bold, 120pt, letter-spacing -1
- Cap height of "IDE" at that size: 86px
- Mark visible height: 128px (1.49x cap height)
- Gap between mark and wordmark: 56px (~0.44x mark width)
- Mark is centred on the **cap band**, not the full line box, so the descender
  of "g" does not drag it visually low
- Even 32px margin on all four sides

The source `public/logo.png` has ~16% transparent padding baked in — the mark
fills only 68% of its own canvas. `mark-trimmed.png` is that padding removed,
which is what makes the optical sizing correct. Rebuilding from the untrimmed
file will silently produce an undersized mark.

"IDE" is `#F97316`, identical to `--accent-primary` in the app.

## Regenerating

`build2.py` in the session scratchpad produced these. The measured constants
above are what matter — any tool can reproduce it from them.
