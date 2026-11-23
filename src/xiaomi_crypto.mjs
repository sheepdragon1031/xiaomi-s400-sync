import crypto from "node:crypto";

/**
 * Pure-JS RC4-Drop[1024] stream cipher.
 * Node.js v20+/v26 uses OpenSSL 3 where legacy RC4 is disabled by default,
 * so implementing KSA + PRGA in JS guarantees zero-dependency compatibility.
 *
 * @param {Buffer} keyBytes
 * @param {Buffer} dataBytes
 * @returns {Buffer}
 */
export function rc4Drop1024(keyBytes, dataBytes) {
  if (!keyBytes || keyBytes.length === 0) {
    throw new Error("RC4 key must not be empty");
  }

  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    s[i] = i;
  }

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + keyBytes[i % keyBytes.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  let i = 0;
  j = 0;

  // Drop the first 1024 keystream bytes (Xiaomi MiOT RC4-Drop1024 convention).
  for (let k = 0; k < 1024; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  const out = Buffer.allocUnsafe(dataBytes.length);
  for (let idx = 0; idx < dataBytes.length; idx++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
    const k = s[(s[i] + s[j]) & 0xff];
    out[idx] = dataBytes[idx] ^ k;
  }

  return out;
}

/**
 * Encrypts a UTF-8 string using RC4-Drop[1024] and returns Base64 ciphertext.
 * @param {string} passwordBase64
 * @param {string} plaintext
 * @returns {string}
 */
export function encryptRc4(passwordBase64, plaintext) {
  const key = Buffer.from(passwordBase64, "base64");
  const encrypted = rc4Drop1024(key, Buffer.from(plaintext, "utf8"));
  return encrypted.toString("base64");
}

/**
 * Decrypts Base64 RC4-Drop[1024] ciphertext into a raw Buffer.
 * @param {string} passwordBase64
 * @param {string} ciphertextBase64
 * @returns {Buffer}
 */
export function decryptRc4(passwordBase64, ciphertextBase64) {
  const key = Buffer.from(passwordBase64, "base64");
  const encrypted = Buffer.from(ciphertextBase64, "base64");
  return rc4Drop1024(key, encrypted);
}

/**
 * Generates Xiaomi MiOT 12-byte nonce (8 random bytes + 4-byte big-endian minute timestamp).
 * @param {number} [millis=Date.now()]
 * @param {Buffer} [randomBytes]
 * @returns {string} Base64 nonce
 */
export function generateNonce(millis = Date.now(), randomBytes = crypto.randomBytes(8)) {
  if (randomBytes.length !== 8) {
    throw new Error("randomBytes must be exactly 8 bytes");
  }
  const timeBuf = Buffer.allocUnsafe(4);
  timeBuf.writeUInt32BE(Math.floor(millis / 60000), 0);
  return Buffer.concat([randomBytes, timeBuf]).toString("base64");
}

/**
 * Derives Xiaomi signed_nonce = Base64(SHA256(decode(ssecurity) + decode(nonce))).
 * @param {string} ssecurityBase64
 * @param {string} nonceBase64
 * @returns {string}
 */
export function signedNonce(ssecurityBase64, nonceBase64) {
  const hash = crypto.createHash("sha256");
  hash.update(Buffer.from(ssecurityBase64, "base64"));
  hash.update(Buffer.from(nonceBase64, "base64"));
  return hash.digest("base64");
}

/**
 * Computes Xiaomi MiOT SHA-1 signature over method, normalized path, params, and signed_nonce.
 * Matches XiaomiCloudConnector.generate_enc_signature in token_extractor.py.
 *
 * @param {string} url
 * @param {string} method
 * @param {string} signedNonceVal
 * @param {Record<string, string>} params
 * @param {string | null} [signPathOverride=null]
 * @returns {string}
 */
export function generateEncSignature(url, method, signedNonceVal, params, signPathOverride = null) {
  let pathPart = signPathOverride;
  if (!pathPart) {
    const comIdx = url.indexOf("com");
    const rawPath = comIdx !== -1 ? url.slice(comIdx + 3) : url;
    pathPart = rawPath.replace("/app/", "/");
  }

  const signatureParams = [String(method).toUpperCase(), pathPart];
  for (const [k, v] of Object.entries(params)) {
    signatureParams.push(`${k}=${v}`);
  }
  signatureParams.push(signedNonceVal);

  const signatureString = signatureParams.join("&");
  return crypto.createHash("sha1").update(signatureString, "utf8").digest("base64");
}

/**
 * Builds the encrypted MiOT request parameter map (`data`, `rc4_hash__`, `signature`, `ssecurity`, `_nonce`).
 * Matches XiaomiCloudConnector.generate_enc_params in token_extractor.py.
 *
 * @param {string} url
 * @param {string} method
 * @param {string} signedNonceVal
 * @param {string} nonce
 * @param {Record<string, string>} params
 * @param {string} ssecurity
 * @param {string | null} [signPathOverride=null]
 * @returns {Record<string, string>}
 */
export function generateEncParams(
  url,
  method,
  signedNonceVal,
  nonce,
  params,
  ssecurity,
  signPathOverride = null
) {
  const workParams = { ...params };
  workParams.rc4_hash__ = generateEncSignature(
    url,
    method,
    signedNonceVal,
    workParams,
    signPathOverride
  );

  const encryptedParams = {};
  for (const [k, v] of Object.entries(workParams)) {
    encryptedParams[k] = encryptRc4(signedNonceVal, String(v));
  }

  encryptedParams.signature = generateEncSignature(
    url,
    method,
    signedNonceVal,
    encryptedParams,
    signPathOverride
  );
  encryptedParams.ssecurity = ssecurity;
  encryptedParams._nonce = nonce;
  return encryptedParams;
}
