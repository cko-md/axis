import crypto from "crypto";

export type HmacVerificationInput = {
  secret: string;
  rawBody: string;
  signature: string | null | undefined;
};

function paddedBuffer(value: string, length: number): Buffer {
  const source = Buffer.from(value, "utf8");
  const out = Buffer.alloc(length);
  source.copy(out, 0, 0, Math.min(source.length, length));
  return out;
}

/** Constant-time string equality that does not throw when lengths differ. */
export function timingSafeStringEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const length = Math.max(Buffer.byteLength(a), Buffer.byteLength(b), 1);
  const equal = crypto.timingSafeEqual(paddedBuffer(a, length), paddedBuffer(b, length));
  return equal && Buffer.byteLength(a) === Buffer.byteLength(b);
}

export function hmacSha256Hex(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyHmacSha256Hex(input: HmacVerificationInput): boolean {
  const signature = input.signature?.trim().toLowerCase();
  if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeStringEqual(signature, hmacSha256Hex(input.secret, input.rawBody));
}
