// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for the vendored md5.mjs.
 *
 * Web Crypto has no MD5, so we ship our own. These prove it against the
 * canonical RFC 1321 test vectors (and a couple more), in hex AND base64, so
 * the digest the create-upload item carries is known-correct.
 *
 * Run from this folder:  node --test test_md5.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";

import { md5Bytes, md5Hex, md5Base64 } from "./md5.mjs";

// Known RFC 1321 vectors (hex).
const HEX_VECTORS = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ],
];

test("md5Hex matches the canonical RFC 1321 vectors", () => {
  for (const [input, expected] of HEX_VECTORS) {
    assert.equal(md5Hex(input), expected, `md5("${input}")`);
  }
});

test('md5("") and md5("abc") are exactly the well-known digests', () => {
  assert.equal(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
});

test("md5Base64 equals base64 of the raw digest", () => {
  // md5("") raw digest -> base64 is "1B2M2Y8AsgTpgAmY7PhCfg=="
  assert.equal(md5Base64(""), "1B2M2Y8AsgTpgAmY7PhCfg==");
});

test("md5Bytes returns 16 bytes", () => {
  const out = md5Bytes("abc");
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 16);
});

test("works on ArrayBuffer and Uint8Array inputs identically", () => {
  const u8 = new TextEncoder().encode("abc");
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  assert.equal(md5Hex(u8), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5Hex(ab), "900150983cd24fb0d6963f7d28e17f72");
});

test("agrees with Node's crypto MD5 on a multi-block buffer (padding boundaries)", () => {
  // Cover several lengths around the 56/64-byte padding boundary.
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 1000, 4096]) {
    const buf = crypto.randomBytes(len);
    const ours = md5Hex(new Uint8Array(buf));
    const ref = crypto.createHash("md5").update(buf).digest("hex");
    assert.equal(ours, ref, `length ${len}`);
  }
});
