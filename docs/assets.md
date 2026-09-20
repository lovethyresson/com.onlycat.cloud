# Assets

## Where the artwork comes from

Everything visual in this app is derived from **OnlyCat's own published artwork**, not redrawn or
approximated.

| | |
|---|---|
| Source | `https://www.onlycat.com/wp-content/uploads/2024/07/Horizontal.svg` |
| What it is | The only vector brand asset OnlyCat publishes. 15 `<polygon>` elements forming the low-poly cat-head mark (x 0–66.07, y 0–70.87), followed by 8 `<path>` elements for the "OnlyCat" wordmark and a registered-trademark symbol. |
| What we use | **The 15 mark polygons only.** The wordmark and the ® are deliberately not shipped. |
| Generator | `dev/make-assets.py` — reads the SVG, writes `icon.svg` at Homey's 960×960 canvas and rasterises every PNG from the polygon coordinates at its native size. |

Rasterising from the vector rather than resampling a bitmap matters at 75×75, which is where a
downscaled 1024px master turns to mush.

## Brand colour: `#008FD5`

Not `#0084FF`. That value is real — it is `--e-global-color-primary` in the legacy Elementor kit
still driving OnlyCat's storefront pages, and it is what the abandoned community Homey app used —
but it is not what the product looks like.

`#008FD5` is corroborated three ways:

- `--ion-color-primary: #008FD5` in OnlyCat's own app stylesheet, overriding Ionic's default
- `"theme_color": "#008FD5"` in `https://onlycat.app/manifest.webmanifest`
- the exact value sampled from all three icon masters (site, `onlycat.app`, Play Store)

OnlyCat's current website palette (`tokens.css`, dated September 2026 and described in its own
comment as "the approved direction") is moving to `--oc-blue #0079c2`. If their site settles there,
that is the value to follow.

## Regenerating

```bash
curl -o /tmp/Horizontal.svg https://www.onlycat.com/wp-content/uploads/2024/07/Horizontal.svg
python3 dev/make-assets.py /tmp/Horizontal.svg
```

## Trademark position — read before publishing

**OnlyCat grants no brand-usage permission anywhere, and none should be assumed.**

- Their site footer reads "© 2026 VirtualV Trading Ltd t/a OnlyCat. All rights reserved." That is a
  blanket reservation; it grants nothing.
- Their Terms have one IP clause and it is about software, not marks: *"OnlyCat and its licensors
  retain their intellectual property rights."*
- The wordmark carries **®** — a claimed registration, not a bare mark.
- There is no press kit, brand page or trademark policy. `/press/`, `/brand/`, `/media-kit/` all 404.

What exists on the other side of the ledger: their developer hub explicitly invites third-party
work — *"We'll be sharing APIs, developer documentation, and featuring community-built projects"* —
and Athom's own App Store guidelines tell you to do this: *"If your app supports a specific brand,
use the company's brand icon."*

**Those are not the same thing.** Athom's guidance says what Athom will accept; it is not a licence
from the trademark owner. Before publishing, ask OnlyCat directly — a GitHub Discussion on
`OnlyCatAI/onlycat-developer`, or their Discord — and get a one-line yes. That converts "available"
into "sanctioned" for the cost of one message, and they are demonstrably approachable.

Using the head mark rather than the ®-bearing wordmark is the deliberately lower-risk choice in the
meantime.
