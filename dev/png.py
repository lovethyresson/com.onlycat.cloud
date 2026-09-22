"""
Read, write and box-downscale PNGs, in the standard library alone.

There is no PIL and no ImageMagick on this machine, and `sips` cannot composite or resample
into a new canvas, so `make-driver-images.py` needs this. It handles what that script meets:
8-bit non-interlaced RGB or RGBA.
"""

import struct
import zlib


def read(path):
    """-> (width, height, channels, pixels). Channels is 3 or 4; pixels is row-major."""
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', f'{path} is not a PNG'

    pos, idat = 8, bytearray()
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b'IHDR':
            w, h, depth, colour, _, _, interlace = struct.unpack('>IIBBBBB', body)
            assert depth == 8 and interlace == 0 and colour in (2, 6), \
                f'{path}: only 8-bit non-interlaced RGB/RGBA, got depth {depth} colour {colour}'
            ch = 3 if colour == 2 else 4
        elif tag == b'IDAT':
            idat += body
        pos += 12 + length

    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    out = bytearray(w * h * ch)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        filter_type = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if filter_type == 1:                                        # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif filter_type == 2:                                      # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif filter_type == 3:                                      # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif filter_type == 4:                                      # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out


def write(path, w, h, px):
    """px is RGB, row-major."""
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        rows += px[y * w * 3:(y + 1) * w * 3]

    def chunk(tag, body):
        return (struct.pack('>I', len(body)) + tag + body
                + struct.pack('>I', zlib.crc32(tag + body) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(rows), 9))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)


def resize(w, h, px, nw, nh):
    """Box filter — an exact area average, which is what a downscale wants. RGB in, RGB out."""
    out = bytearray(nw * nh * 3)
    for ny in range(nh):
        y0, y1 = ny * h // nh, max(ny * h // nh + 1, (ny + 1) * h // nh)
        for nx in range(nw):
            x0, x1 = nx * w // nw, max(nx * w // nw + 1, (nx + 1) * w // nw)
            r = g = b = n = 0
            for y in range(y0, y1):
                base = y * w * 3
                for x in range(x0, x1):
                    i = base + x * 3
                    r += px[i]
                    g += px[i + 1]
                    b += px[i + 2]
                    n += 1
            i = (ny * nw + nx) * 3
            out[i], out[i + 1], out[i + 2] = r // n, g // n, b // n
    return out
