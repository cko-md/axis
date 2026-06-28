import crypto from "crypto";

const KEY_HEX = process.env.PASSKEY_ENCRYPTION_KEY ?? "";
const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer | null {
  if (!KEY_HEX || KEY_HEX.length !== 64) return null;
  return Buffer.from(KEY_HEX, "hex");
}

/** Encrypt plaintext with AES-256-GCM. Returns base64-encoded `iv:authTag:ciphertext`. */
export function encrypt(plaintext: string): string | null {
  const key = getKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** Decrypt a value produced by `encrypt()`. Returns null on failure. */
export function decrypt(encoded: string): string | null {
  const key = getKey();
  if (!key) return null;
  try {
    const [ivB64, tagB64, dataB64] = encoded.split(":");
    if (!ivB64 || !tagB64 || dataB64 === undefined || dataB64 === null) return null;
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data) + decipher.final("utf8");
  } catch {
    return null;
  }
}
