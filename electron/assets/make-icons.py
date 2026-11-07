"""Generates the app and tray icons (plain PNGs, no third-party libraries). Run: python3 make-icons.py"""
import math
import struct
import zlib
from pathlib import Path


def png(path, size, pixel):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            row += bytes(pixel(x + .5, y + .5, size))
        rows.append(bytes(row))
    raw = b"".join(rows)
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def coverage(d, edge, aa=1.0):
    """Anti-aliased 0..1 coverage for a signed distance d (negative = inside)."""
    return max(0.0, min(1.0, (edge - d) / aa + .5))


def ring(x, y, size, outer, inner):
    r = math.hypot(x - size / 2, y - size / 2)
    return coverage(r, outer, size / 256) * (1 - coverage(r, inner, size / 256))


def app_icon(x, y, size):
    # rounded square, neutral dark, with a light ring and a blue dot
    c, half, rad = size / 2, size * .46, size * .22
    dx, dy = max(abs(x - c) - (half - rad), 0), max(abs(y - c) - (half - rad), 0)
    box = coverage(math.hypot(dx, dy), rad, size / 256)
    r_ = ring(x, y, size, size * .27, size * .19)
    dot = coverage(math.hypot(x - c, y - c), size * .07, size / 256)
    base = (28, 28, 28)
    col = [base[i] * (1 - r_) + 238 * r_ for i in range(3)]
    col = [col[0] * (1 - dot) + 107 * dot, col[1] * (1 - dot) + 155 * dot, col[2] * (1 - dot) + 255 * dot]
    return (*[int(v) for v in col], int(255 * box))


def tray_template(x, y, size):   # macOS template image: black + alpha only
    return (0, 0, 0, int(255 * (ring(x, y, size, size * .42, size * .27) + coverage(math.hypot(x - size / 2, y - size / 2), size * .11, size / 128))) if True else 0)


def tray_color(x, y, size):      # Windows / Linux
    a = min(255, int(255 * (ring(x, y, size, size * .42, size * .27) + coverage(math.hypot(x - size / 2, y - size / 2), size * .11, size / 128))))
    return (37, 99, 235, a)


here = Path(__file__).parent
png(here / "icon.png", 512, app_icon)
png(here / "trayTemplate.png", 22, tray_template)
png(here / "trayTemplate@2x.png", 44, tray_template)
png(here / "tray.png", 32, tray_color)
print("icons written")
