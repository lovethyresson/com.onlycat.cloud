"""
Build Homey assets from OnlyCat's own artwork.

Source: https://www.onlycat.com/wp-content/uploads/2024/07/Horizontal.svg — the only vector brand
asset OnlyCat publishes. Its 15 <polygon> elements are the low-poly cat-head mark and occupy
exactly x 0..66.07, y 0..70.87; the 8 <path> elements after them are the "OnlyCat" wordmark and
the registered-trademark symbol, which we deliberately do NOT ship.

Brand blue is #008FD5, not the #0084FF the abandoned community app guessed. #008FD5 is what the
product actually is: it is `--ion-color-primary` in OnlyCat's own app stylesheet, `theme_color` in
their PWA manifest, and the exact value sampled out of all three icon masters.

No ImageMagick, no PIL on this machine, so the PNGs are rasterised here from the polygon
coordinates directly — which is better than resampling a bitmap anyway: every size is drawn from
the vector at its native resolution.
"""

import os
import re
import struct
import zlib

import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'Horizontal.svg')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BLUE = (0x00, 0x8F, 0xD5)
WHITE = (0xFF, 0xFF, 0xFF)

# --------------------------------------------------------------------------------------------
# Read the mark
# --------------------------------------------------------------------------------------------

svg = open(SRC).read()
polygons = []
for points in re.findall(r'<polygon[^>]*points="([^"]+)"', svg):
    nums = [float(n) for n in re.split(r'[\s,]+', points.strip()) if n]
    pts = list(zip(nums[0::2], nums[1::2]))
    if pts and max(x for x, _ in pts) <= 67.0:      # the mark, not the wordmark
        polygons.append(pts)

assert len(polygons) == 15, f'expected the 15 mark polygons, found {len(polygons)}'
MARK_W, MARK_H = 66.07, 70.87


# --------------------------------------------------------------------------------------------
# icon.svg — 960x960, transparent, single colour
# --------------------------------------------------------------------------------------------

def write_icon_svg(path):
    margin = 0.08
    scale = (960.0 * (1 - 2 * margin)) / MARK_H
    dx = (960.0 - MARK_W * scale) / 2
    dy = (960.0 - MARK_H * scale) / 2

    body = []
    for pts in polygons:
        coords = ' '.join(f'{x * scale + dx:.2f},{y * scale + dy:.2f}' for x, y in pts)
        body.append(f'  <polygon points="{coords}"/>')

    svg_out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!-- OnlyCat cat-head mark, from the official Horizontal.svg published at\n'
        '     https://www.onlycat.com/wp-content/uploads/2024/07/Horizontal.svg\n'
        '     The wordmark and registered-trademark symbol are deliberately omitted.\n'
        '     Canvas is 960x960 with a transparent background, per Homey\'s icon guidance. -->\n'
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960" width="960" height="960">\n'
        '  <g fill="#000000">\n'
        + '\n'.join(body)
        + '\n  </g>\n</svg>\n'
    )
    open(path, 'w').write(svg_out)
    print(f'wrote {path}')


# --------------------------------------------------------------------------------------------
# PNGs — rasterise the mark over the brand blue
# --------------------------------------------------------------------------------------------

def png(path, w, h, pixels):
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        for x in range(w):
            r, g, b = pixels[y * w + x]
            rows += bytes((r, g, b, 255))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(rows), 9))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)


def coverage(w, h, scale, dx, dy, ss=4):
    """
    Per-pixel ink coverage 0..1, supersampled ss x ss.

    Each polygon is scanline-filled INDEPENDENTLY and the results unioned. Pooling every edge
    into one crossing list and pairing them — which is what the first version did — treats the
    15 separate facets as one even-odd path, so adjacent triangles cancel each other out and the
    cat loses half its face.
    """
    cov = [0.0] * (w * h)
    step = 1.0 / ss
    weight = 1.0 / (ss * ss)

    for pts in polygons:
        edges = []
        for i in range(len(pts)):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % len(pts)]
            ax, ay = x0 * scale + dx, y0 * scale + dy
            bx, by = x1 * scale + dx, y1 * scale + dy
            if ay != by:
                edges.append((ax, ay, bx, by))
        if not edges:
            continue

        top = max(0, int(min(min(ay, by) for _, ay, _, by in edges) * ss))
        bottom = min(h * ss, int(max(max(ay, by) for _, ay, _, by in edges) * ss) + 1)

        for sy in range(top, bottom):
            py = (sy + 0.5) * step
            xs = []
            for ax, ay, bx, by in edges:
                if (ay <= py < by) or (by <= py < ay):
                    xs.append(ax + (py - ay) * (bx - ax) / (by - ay))
            if len(xs) < 2:
                continue
            xs.sort()
            row = (sy // ss) * w
            for i in range(0, len(xs) - 1, 2):
                left, right = xs[i], xs[i + 1]
                for sx in range(max(0, int(left * ss)), min(w * ss, int(right * ss) + 1)):
                    px = (sx + 0.5) * step
                    if left <= px < right:
                        cov[row + (sx // ss)] += weight

    return [min(1.0, c) for c in cov]


def render(path, w, h, fill=0.62):
    """Mark centred on the brand blue, occupying `fill` of the shorter side."""
    scale = (min(w, h) * fill) / MARK_H
    dx = (w - MARK_W * scale) / 2
    dy = (h - MARK_H * scale) / 2
    cov = coverage(w, h, scale, dx, dy)

    pixels = []
    for i in range(w * h):
        a = cov[i]
        pixels.append(tuple(round(BLUE[c] + (WHITE[c] - BLUE[c]) * a) for c in range(3)))
    png(path, w, h, pixels)
    print(f'wrote {path}  {w}x{h}')


write_icon_svg(f'{ROOT}/assets/icon.svg')
write_icon_svg(f'{ROOT}/drivers/cat_flap/assets/icon.svg')

for name, w, h in [('small', 250, 175), ('large', 500, 350), ('xlarge', 1000, 700)]:
    render(f'{ROOT}/assets/images/{name}.png', w, h, fill=0.60)

for name, size in [('small', 75), ('large', 500), ('xlarge', 1000)]:
    render(f'{ROOT}/drivers/cat_flap/assets/images/{name}.png', size, size, fill=0.66)
