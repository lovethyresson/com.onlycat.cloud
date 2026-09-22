"""
Build the driver images: the OnlyCat flap itself, on white.

Homey wants the device on a white background here — the app image is the lifestyle shot, the
driver image is the product. The source is `dev/assets/onlycat-flap.png`, a cut-out of the flap
with a real alpha channel, so there is nothing to key or trace: composite it over white, centre
it on a square canvas with a margin, and downscale.

    python3 dev/make-driver-images.py

The source is vendored rather than fetched, because unlike OnlyCat's published photographs it is
not at a URL this script could curl. Everything else about the pipeline is deliberately dull —
the interesting version of this script traced a silhouette by hand to cut the flap out of a
photograph, and none of that is needed once the alpha channel is there.

No PIL and no ImageMagick on this machine, so `dev/png.py` does the decoding, the box-filter
downscale and the encoding.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import png                                                          # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else f'{ROOT}/dev/assets/onlycat-flap.png'
OUT = f'{ROOT}/drivers/cat_flap/assets/images'

MARGIN = 0.07           # of the canvas, on the tighter axis
SIZES = [('xlarge', 1000), ('large', 500), ('small', 75)]

w, h, ch, src = png.read(SRC)
assert ch == 4, f'{SRC} has no alpha channel — the cut-out is what makes this simple'

# What the alpha channel says the product occupies.
left, top, right, bottom = w, h, -1, -1
for y in range(h):
    row = y * w
    for x in range(w):
        if src[(row + x) * 4 + 3] > 8:
            left, right = min(left, x), max(right, x)
            top, bottom = min(top, y), max(bottom, y)
assert right >= left and bottom >= top, f'{SRC} is entirely transparent'
pw, ph = right - left + 1, bottom - top + 1

side = round(max(pw, ph) / (1 - 2 * MARGIN))
ox, oy = (side - pw) // 2 - left, (side - ph) // 2 - top

canvas = bytearray(b'\xff' * (side * side * 3))
for y in range(h):
    cy = y + oy
    if not 0 <= cy < side:
        continue
    for x in range(w):
        cx = x + ox
        if not 0 <= cx < side:
            continue
        s = (y * w + x) * 4
        a = src[s + 3]
        if a == 0:
            continue
        d = (cy * side + cx) * 3
        if a == 255:
            canvas[d:d + 3] = src[s:s + 3]
        else:
            for k in range(3):
                canvas[d + k] = (src[s + k] * a + 255 * (255 - a) + 127) // 255

print(f'{SRC}: product {pw}x{ph} at ({left},{top}) -> {side}x{side} canvas')
for name, size in SIZES:
    png.write(f'{OUT}/{name}.png', size, size, png.resize(side, side, canvas, size, size))
    print(f'wrote {OUT}/{name}.png  {size}x{size}')
