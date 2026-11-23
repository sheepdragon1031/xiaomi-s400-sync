import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  decryptRc4,
  encryptRc4,
  generateEncParams,
  generateEncSignature,
  generateNonce,
  rc4Drop1024,
  signedNonce,
} from "../src/xiaomi_crypto.mjs";

test("rc4Drop1024 round-trips ASCII, UTF-8, and larger JSON payloads", () => {
  const key = crypto.randomBytes(32).toString("base64");
  const samples = [
    "",
    '{"did":"blt.3.12345","pdid":1}',
    '{"name":"米家體脂計 S400","weight":68.5}',
    "x".repeat(4096),
  ];

  for (const text of samples) {
    const encrypted = encryptRc4(key, text);
    const decrypted = decryptRc4(key, encrypted).toString("utf8");
    assert.equal(decrypted, text);
  }
});

test("rc4Drop1024 skips first 1024 keystream bytes (not raw RC4)", () => {
  // Known key "Key" (0x4b, 0x65, 0x79) with raw RC4 produces 0xeb9f7781... for "Plaintext".
  // With 1024-byte drop, the ciphertext must differ from raw RC4 and still self-invert.
  const keyBytes = Buffer.from("Key", "utf8");
  const plain = Buffer.from("Plaintext", "utf8");
  const ct = rc4Drop1024(keyBytes, plain);
  assert.notEqual(ct.toString("hex").slice(0, 8), "eb9f7781");
  assert.deepEqual(rc4Drop1024(keyBytes, ct), plain);
});

test("generateNonce packs 8 random bytes + 4-byte big-endian minute timestamp", () => {
  const rand = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const millis = 1700000000000; // floor(millis / 60000) = 28333333 = 0x01b05515
  const nonceB64 = generateNonce(millis, rand);
  const decoded = Buffer.from(nonceB64, "base64");

  assert.equal(decoded.length, 12);
  assert.deepEqual(decoded.subarray(0, 8), rand);
  assert.equal(decoded.readUInt32BE(8), Math.floor(millis / 60000));
});

test("signedNonce matches SHA256(decode(ssecurity) || decode(nonce))", () => {
  const ssecurity = Buffer.from("0123456789abcdef").toString("base64");
  const nonce = Buffer.from("fedcba987654").toString("base64");

  const expected = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from("0123456789abcdef"), Buffer.from("fedcba987654")]))
    .digest("base64");

  assert.equal(signedNonce(ssecurity, nonce), expected);
});

test("generateEncSignature normalizes /app/ path and hashes with SHA-1", () => {
  const url = "https://tw.api.io.mi.com/app/v2/device/blt_get_beaconkey";
  const sNonce = Buffer.from("signed-nonce-secret-key-32-bytes").toString("base64");
  const params = { data: '{"did":"blt.1","pdid":1}' };

  const expectedSigString = `POST&/v2/device/blt_get_beaconkey&data={"did":"blt.1","pdid":1}&${sNonce}`;
  const expectedSig = crypto.createHash("sha1").update(expectedSigString, "utf8").digest("base64");

  assert.equal(generateEncSignature(url, "POST", sNonce, params), expectedSig);
});

test("generateEncParams produces rc4_hash__, encrypted fields, signature, ssecurity, _nonce without mutating input", () => {
  const url = "https://tw.api.io.mi.com/app/user/get_user_device_data";
  const ssecurity = Buffer.from("ssecurity-16byte").toString("base64");
  const nonce = generateNonce(1700000000000, Buffer.alloc(8, 7));
  const sNonce = signedNonce(ssecurity, nonce);
  const originalParams = { data: '{"did":"blt.1","type":"event","key":"6"}' };

  const fields = generateEncParams(url, "POST", sNonce, nonce, originalParams, ssecurity);

  // Input object must remain unmutated.
  assert.deepEqual(Object.keys(originalParams), ["data"]);
  assert.equal(originalParams.data, '{"did":"blt.1","type":"event","key":"6"}');

  assert.equal(fields.ssecurity, ssecurity);
  assert.equal(fields._nonce, nonce);
  assert.ok(fields.rc4_hash__);
  assert.ok(fields.signature);

  // Decrypting data and rc4_hash__ must recover original data and plaintext rc4_hash__.
  assert.equal(decryptRc4(sNonce, fields.data).toString("utf8"), originalParams.data);
  const expectedPlainHash = generateEncSignature(url, "POST", sNonce, originalParams);
  assert.equal(decryptRc4(sNonce, fields.rc4_hash__).toString("utf8"), expectedPlainHash);

  // Outer signature must verify over encrypted { data, rc4_hash__ }.
  const expectedOuterSig = generateEncSignature(url, "POST", sNonce, {
    data: fields.data,
    rc4_hash__: fields.rc4_hash__,
  });
  assert.equal(fields.signature, expectedOuterSig);
});
