# Deck assets

Photos for the pitch deck — NOT used by the app.

Keep them out of `public/`: anything in `public/` is downloaded by every visitor
to the site, and these are only needed when building the deck.

Expected files:

| File                | Deck slide | What it is                              |
|---------------------|------------|-----------------------------------------|
| `board-off.jpg`     | 1          | LED circuit, unlit                      |
| `board-on.jpg`      | 12         | Same board, same framing, LED lit        |
| `founder.jpg`       | 11         | Victor — headshot or at the bench        |
| `ide-screenshot.png`| 5          | The live IDE mid-build                   |

Originals go here at full resolution. The build downscales and embeds them,
so don't pre-shrink them yourself.
