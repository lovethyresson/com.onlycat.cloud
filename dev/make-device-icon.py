"""
The device icon: the OnlyCat flap drawn as a product, with depth.

Three different assets get confused with each other, so to be explicit:

  assets/icon.svg                     the APP icon — OnlyCat's brand mark
  drivers/cat_flap/assets/icon.svg    the DEVICE icon — the product itself  <- this file
  drivers/cat_flap/assets/images/*    the DRIVER images — lifestyle photographs

v0.1.0 used the brand mark for all three. The second attempt drew the flap flat-on, which was
still wrong: Homey's device icons are small technical illustrations of the hardware, drawn at a
three-quarter angle so the thing has volume and reads as an object on a tile rather than a
pictogram. Compare the contact sensor, the air-quality puck and the speaker in any Homey room
view — all of them show a front face plus the top and one side.

So this is a cabinet projection: a front face carrying the aperture, sensor strip and catch, with
the top and right faces raked back along a single depth vector. Strokes, not fills — Homey's
guidance is explicit that "submitting a filled image or illustration as an icon will cause it to
appear as a solid shape, which is not recognisable at small sizes and will not be approved".

Proportions follow OnlyCat's product photography.

The PNG preview is deliberate. There is no SVG renderer on this machine, so without it the icon
ships unlooked-at — which is how both earlier asset mistakes happened. It is not part of the app.
"""

import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANVAS = 960
STROKE = 44

# How far back, and how far up, the rear of the housing sits. One vector for the whole drawing:
# using a single depth keeps the top and side faces consistent, which is what makes it read as
# one solid object rather than three shapes that happen to touch.
DEPTH = (-87, -61)

# Front face, as (x, y, w, h, radius). Placed so the WHOLE drawing — front face plus the depth
# the back is raked by — is centred on the canvas. Centring the front face alone leaves the icon
# sitting low and off to one side, because the volume only extends up and to the left.
FRONT = (139, 158, 770, 706, 78)
APERTURE = (264, 311, 519, 389, 68)
SENSOR = (418, 217, 212, 52, 26)
CATCH = (476, 729, 571, 729)


def shifted(point):
    return point[0] + DEPTH[0], point[1] + DEPTH[1]


def visible_depth_edges(rect):
    """
    The edges of the housing a viewer actually sees.

    The housing tilts RIGHT: its back rakes up and to the left, so the faces on show are the top
    and the LEFT side. Raking the other way puts the side face on the right and reads as tilting
    away from the viewer instead.

    Starting the depth lines at the front face's CORNERS looked wrong — the front is a rounded
    rectangle, so a line leaving the corner cuts across the curve. They start where the straight
    part of each edge begins, inset by the radius.
    """
    x, y, w, h, r = rect
    top_left = (x + r, y)
    top_right = (x + w - r, y)
    left_top = (x, y + r)
    left_bottom = (x, y + h - r)

    # Back outline: along the top from the near corner, around the far corner (chamfered — a
    # curve is invisible at tile size and costs an arc command), then down the far side and home.
    back = [
        top_right,
        shifted(top_right),
        shifted(top_left),
        shifted(left_top),
        shifted(left_bottom),
        left_bottom,
    ]
    # The one edge where the top face meets the side face.
    corner = [left_top, shifted(left_top)]
    return back, corner


BACK_OUTLINE, CORNER_EDGE = visible_depth_edges(FRONT)


def svg() -> str:
    def rect(r):
        x, y, w, h, rad = r
        return f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rad}" ry="{rad}"/>'

    def polyline(points):
        pts = ' '.join(f'{round(x)},{round(y)}' for x, y in points)
        return f'  <polyline points="{pts}"/>'

    def line(seg):
        x1, y1, x2, y2 = seg
        return f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>'

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!-- The OnlyCat flap as a device icon: front face with the aperture, sensor strip and\n'
        '     catch, plus the top and right faces raked back so the housing has volume. Strokes on\n'
        '     the 960x960 canvas Homey specifies. Regenerate with dev/make-device-icon.py. -->\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}" '
        f'width="{CANVAS}" height="{CANVAS}">\n'
        f'  <g fill="none" stroke="#000000" stroke-width="{STROKE}" '
        'stroke-linejoin="round" stroke-linecap="round">\n'
        + polyline(BACK_OUTLINE) + '\n'
        + polyline(CORNER_EDGE) + '\n'
        + rect(FRONT) + '\n'
        + rect(APERTURE) + '\n'
        + rect(SENSOR) + '\n'
        + line(CATCH)
        + '\n  </g>\n</svg>\n'
    )


# ---------------------------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------------------------

def rounded_rect_distance(px, py, rect):
    """Signed distance from (px, py) to a rounded rectangle's outline."""
    x, y, w, h, rad = rect
    cx, cy = x + w / 2, y + h / 2
    hx, hy = w / 2 - rad, h / 2 - rad
    dx = abs(px - cx) - hx
    dy = abs(py - cy) - hy
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    return outside + inside - rad


def segment_distance(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / length2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def polyline_distance(px, py, points):
    return min(
        segment_distance(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1])
        for i in range(len(points) - 1)
    )


def preview(path, size=320, ss=3):
    rects = (FRONT, APERTURE, SENSOR)
    polys = (BACK_OUTLINE, CORNER_EDGE)
    half = STROKE / 2.0
    scale = CANVAS / size
    step = 1.0 / ss
    weight = 1.0 / (ss * ss)

    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            ink = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) * step) * scale
                    py = (y + (sy + 0.5) * step) * scale
                    hit = (
                        any(abs(rounded_rect_distance(px, py, r)) <= half for r in rects)
                        or any(polyline_distance(px, py, p) <= half for p in polys)
                        or segment_distance(px, py, *CATCH) <= half
                    )
                    if hit:
                        ink += weight
            v = round(255 * (1 - ink))
            rows += bytes((v, v, v, 255))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(rows), 9))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)


target = f'{ROOT}/drivers/cat_flap/assets/icon.svg'
open(target, 'w').write(svg())
print(f'wrote {target}')

if len(sys.argv) > 1:
    preview(sys.argv[1])
    print(f'wrote preview {sys.argv[1]}')
