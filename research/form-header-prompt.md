# Google Form header image — spec and prompt

## Size: 1600 × 400 px

Your 800 × 200 guess is the right **shape** — Google Forms crops headers to a
strict **4:1** ratio. But supply it at **1600 × 400**, double that, so it stays
sharp on high-DPI phones and laptops. Google downsamples; it will not upscale.

- Format: PNG or JPG, under 2 MB
- Google crops from the centre, so keep anything important away from the edges
- It renders small on a phone. One clear idea only — a banner is not a poster.

Upload: open the form → click the palette icon (top right) → **Header** →
**Upload** → choose your file.

---

## The prompt

Most image models take reference images. Attach **both**:

1. `public/logo.png` — the orange Y-junction mark
2. `deck-assets/board-on.jpg` — the Arduino with the lit LED

```
A wide 4:1 banner image, 1600x400 pixels, for the header of a customer research
survey by a developer-tools company called Joint-Agent IDE.

Layout, left to right:
- Left third: the attached orange logo mark, and to its right the words
  "Joint-Agent IDE" in a clean bold geometric sans-serif, warm off-white.
- Right two thirds: the attached photograph of an Arduino board wired to a
  breadboard with a glowing LED, dark and moody, shot shallow so the lit LED is
  the brightest point in the frame. It fades softly into the dark background
  toward the centre so the text never sits on busy detail.

The whole banner sits on a near-black #0B0D12 ground. The only saturated colour
is the warm orange #F97316 of the logo and the lit LED — everything else stays
dark and desaturated. Cinematic low-key lighting, crisp, modern, premium
developer-tool aesthetic.

Leave generous empty space around the wordmark. Composition must read clearly
when scaled down to 800x200.

--no clutter, busy background, extra text, taglines, stock-photo people, bright
white background, rainbow colours, gradients across the whole image, borders,
frames, watermarks, UI screenshots
```

---

## A simpler fallback

If the photo makes it messy at small size, this version almost always works:

```
A minimal wide banner, 1600x400 pixels, on a near-black #0B0D12 background.
Centred: the attached orange logo mark with the words "Joint-Agent IDE" beside
it in a bold geometric sans-serif, warm off-white. A very subtle warm orange
glow radiates behind the mark and falls off quickly into darkness. Nothing else
in the frame. Flat, clean, premium, high contrast, lots of negative space.

--no extra text, taglines, photographs, clutter, borders, watermarks, gradients
across the whole image, bright backgrounds
```

---

## Before you accept it

- **Shrink it to 800×200 and look.** If the wordmark is unreadable, regenerate
  with "larger wordmark, more negative space".
- **Check the orange** is `#F97316`, not red or yellow. Generators drift.
- **Check the spelling of "Joint-Agent IDE"** character by character. Image
  models garble text constantly, and a typo in your own product name on a
  research survey undermines the thing you are testing.
- **View it on a phone.** That is where most people will answer the form.
