# Assets

## Three assets, three different things

They get conflated, so to be explicit:

| Asset | What it is | Source |
|---|---|---|
| `assets/icon.svg` | The **app** icon | OnlyCat's brand mark |
| `assets/images/*.png` | The **app store** images (250×175, 500×350, 1000×700) | Lifestyle photograph |
| `drivers/cat_flap/assets/icon.svg` | The **device** icon, on the tile | Line drawing of the flap, three-quarter view, `dev/make-device-icon.py` |
| `drivers/cat_flap/assets/images/*.png` | The **driver** images (75×75, 500×500, 1000×1000) | Cut-out of the flap over white, `dev/make-driver-images.py` |

v0.1.0 used the brand mark for all four, which is wrong twice over: a logo on a device tile reads
as a sticker among Homey's outlined hardware icons, and a flat logo is not a driver image at all.
The device icon then went through a flat front elevation before landing on the three-quarter view
Homey's own device icons use — front face plus the top and one side, so the thing has volume.

Regenerate the device icon, with a PNG preview to actually look at:

```bash
python3 dev/make-device-icon.py /tmp/preview.png
```

The preview exists because there is no SVG renderer on this machine, and an icon nobody looks at
is how both earlier asset mistakes shipped.

### The app images

A 2501×1751 landscape crop of OnlyCat's own `hero-3000.webp`
(`https://www.onlycat.com/wp-content/themes/onlycat/assets/home/hero-3000.webp`, 3000×1751 — the
flap on a dark door at dusk, with a cat asleep in a bed beside it), keeping both the flap and the
cat in frame.

```bash
sips --cropToHeightWidth 1751 2501 --cropOffset 0 628 hero-3000.png --out app.png
```

Athom encourage exactly this: *"Use brand images if this is possible… Lifestyle images and brand
images are great examples and are strongly encouraged."*

### The driver images

**A driver image has a different job from an app image.** The app image sells the app; the driver
image identifies the hardware, on white, the way every other driver in the store does. This was a
1300×1300 square of the same hero photograph the app image is a crop of, and App Store review
rejected it: *"Your driver image is identical to your app image, and does not have a white
background. Please provide a distinct driver image with a white background, ideally showing a photo
of the actual cat flap device."* Two crops of one photograph are not byte-identical, and that is
beside the point — they look the same.

The source is now `dev/assets/onlycat-flap.png`, 904×1024 RGBA: the flap with a real alpha channel,
so `dev/make-driver-images.py` has nothing to key or trace. Composite over white, centre on a
square canvas with a 7% margin, box-downscale to the three sizes.

```bash
python3 dev/make-driver-images.py
```

It is vendored rather than fetched because, unlike OnlyCat's published photographs, it is not at a
URL the script could curl.

**Nothing OnlyCat publishes would have done.** Their site serves no PNGs at all — every image is
WebP, and every one is plain lossy `VP8` rather than the `VP8X`-with-alpha or `VP8L` that a cut-out
would need. The `/specs/` turntable is `turntable-1080.mp4`, and MP4 carries no alpha. The only
vectors are `Horizontal.svg`, which is the brand mark, and three 166×164 `manual/dimensions-*.svg`
slices, which are the little line drawings in the specs table. Their best studio asset is
`assets/specs/turntable-poster-1080.webp`, a clean 3D render — on a grey gradient.

**So do not reach for automatic keying if this ever needs redoing.** Both candidate sources defeat
it, for opposite reasons. In the product photograph the flap is white on a white table, which
leaves almost no gradient to find, while the one strong edge in the frame is a wooden window sill
crossing behind it — and showing again *through* the transparent door. In the render, the right-hand
face reads 207 against a 203 backdrop: a four-level step the eye sees and no threshold does. Both
were cut by tracing a silhouette polygon against a pixel grid, which worked, and which the alpha
channel makes unnecessary.

## Where the brand mark comes from

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

**`dev/assets/onlycat-flap.png` is a weaker position than the rest, and deliberately so.** It is
derived from the hero shot on `petflapsuk.com` — a retailer's product photograph, background
removed — and not from anything OnlyCat published. Homey's own reviewer linked that exact image as
an example of what they wanted, which says what Athom will accept and is still not a licence from
whoever owns the photograph. It is the one asset here not traceable to OnlyCat's own artwork. Ask
about it in the same message that asks about the mark, and if the answer is awkward, the fallback
is the turntable render cut out by hand, which at least comes from OnlyCat.
