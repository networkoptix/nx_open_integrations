#!/usr/bin/env python3

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

"""Make the video frames file for run_plugin from test images of a dog and a person.

The images are OpenCV's own DNN test images, downloaded from the opencv_extra repository at a fixed
tag. Each image becomes FRAMES_PER_IMAGE identical frames. The file format is described in
run_plugin/run_plugin.cpp. Needs only Python 3: the PNG decoder is built in.
"""

import struct
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "provision_scripts"))
from download_sdk import fetch  # noqa: E402

IMAGES_URL = "https://raw.githubusercontent.com/opencv/opencv_extra/4.10.0/testdata/dnn/"
IMAGES = [
    "dog416.png",  #< A dog, a bicycle and a car.
    "grace_hopper_227.png",  #< A person.
]
FRAMES_PER_IMAGE = 20


def decode_png(data):
    """Return (width, height, BGR bytes) of an 8-bit non-interlaced RGB(A) or grayscale PNG."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos = 8
    compressed = b""
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"IDAT":
            compressed += chunk
        elif kind == b"IEND":
            break
    channels = {0: 1, 2: 3, 6: 4}.get(color)
    if depth != 8 or interlace or not channels:
        raise ValueError(f"unsupported PNG: depth {depth}, color type {color}")

    raw = zlib.decompress(compressed)
    stride = width * channels
    rows = []
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        row = bytearray(raw[start + 1:start + 1 + stride])
        # PNG filters (see the PNG specification, section 9).
        for i in range(stride):
            a = row[i - channels] if i >= channels else 0
            b = previous[i]
            if kind == 1:
                row[i] = (row[i] + a) & 0xFF
            elif kind == 2:
                row[i] = (row[i] + b) & 0xFF
            elif kind == 3:
                row[i] = (row[i] + ((a + b) >> 1)) & 0xFF
            elif kind == 4:
                c = previous[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                predictor = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                row[i] = (row[i] + predictor) & 0xFF
        rows.append(row)
        previous = row

    bgr = bytearray()
    for row in rows:
        for x in range(width):
            if channels == 1:
                bgr += bytes([row[x]] * 3)
            else:
                r, g, b = row[x * channels:x * channels + 3]
                bgr += bytes([b, g, r])
    return width, height, bytes(bgr)


def main():
    if len(sys.argv) != 2:
        sys.exit("Usage: make_frames.py <frames file>")
    with open(sys.argv[1], "wb") as output:
        for name in IMAGES:
            width, height, pixels = decode_png(fetch(IMAGES_URL + name))
            output.write(struct.pack("<iii", width, height, FRAMES_PER_IMAGE))
            output.write(pixels)
    print(f"{sys.argv[1]}: {len(IMAGES) * FRAMES_PER_IMAGE} frames")


if __name__ == "__main__":
    main()
