// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * A tiny, self-contained MD5 implementation (pure JS, zero dependencies).
 *
 * WHY THIS EXISTS
 * ---------------
 * The create-upload item for a virtual-camera upload REQUIRES an `md5` field
 * (base64 of the file's MD5 digest). The browser's Web Crypto API
 * (`crypto.subtle.digest`) supports SHA-1/256/384/512 but deliberately has NO
 * MD5. Rather than pull in an npm package (which would break this sample's
 * "no npm install" promise), we vendor a small, correct MD5 here.
 *
 * It works on an ArrayBuffer or a Uint8Array and returns the digest. Helpers
 * convert to hex or base64 (base64 is what the API wants).
 *
 * This is RFC 1321 MD5. It is proven against known vectors in test_md5.mjs
 * (md5("") and md5("abc")). MD5 is used here only as the content checksum the
 * Nx API expects — not for any security purpose.
 */

// --- core: operate on a Uint8Array, return 16 bytes (Uint8Array) -----------

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === "string") return new TextEncoder().encode(input);
  throw new TypeError("md5: expected ArrayBuffer, TypedArray, or string");
}

// 32-bit left rotate.
function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

// Per-round shift amounts and the precomputed sine-derived constants K[i].
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    // K[i] = floor(2^32 * abs(sin(i + 1)))
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return k;
})();

/**
 * Compute the raw 16-byte MD5 digest of the input.
 * @param {ArrayBuffer|Uint8Array|string} input
 * @returns {Uint8Array} 16 bytes.
 */
export function md5Bytes(input) {
  const msg = toBytes(input);
  const originalLenBits = msg.length * 8;

  // Padded length: append 0x80, then zeros, until length % 64 === 56, then an
  // 8-byte little-endian original-length-in-bits.
  let paddedLen = msg.length + 1;
  while (paddedLen % 64 !== 56) paddedLen++;
  paddedLen += 8;

  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[msg.length] = 0x80;

  // Little-endian length in bits (low 32 bits, then high 32 bits).
  const lenLo = originalLenBits >>> 0;
  const lenHi = Math.floor(originalLenBits / 4294967296) >>> 0;
  buf[paddedLen - 8] = lenLo & 0xff;
  buf[paddedLen - 7] = (lenLo >>> 8) & 0xff;
  buf[paddedLen - 6] = (lenLo >>> 16) & 0xff;
  buf[paddedLen - 5] = (lenLo >>> 24) & 0xff;
  buf[paddedLen - 4] = lenHi & 0xff;
  buf[paddedLen - 3] = (lenHi >>> 8) & 0xff;
  buf[paddedLen - 2] = (lenHi >>> 16) & 0xff;
  buf[paddedLen - 1] = (lenHi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Uint32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
    }

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let w = 0; w < 4; w++) {
    out[w * 4] = words[w] & 0xff;
    out[w * 4 + 1] = (words[w] >>> 8) & 0xff;
    out[w * 4 + 2] = (words[w] >>> 16) & 0xff;
    out[w * 4 + 3] = (words[w] >>> 24) & 0xff;
  }
  return out;
}

/** Lowercase hex of the digest (handy for debugging / test vectors). */
export function md5Hex(input) {
  const bytes = md5Bytes(input);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Base64 of the digest — the form the Nx create-upload item expects.
 * Uses btoa in the browser, Buffer in Node; both are always available.
 */
export function md5Base64(input) {
  const bytes = md5Bytes(input);
  if (typeof btoa === "function") {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }
  // Node fallback (used by the offline tests).
  return Buffer.from(bytes).toString("base64");
}
