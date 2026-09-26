import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks GitHub's X-Hub-Signature-256 header against the raw request body.
 *
 * Must run on the exact bytes GitHub sent: re-serializing parsed JSON changes
 * whitespace/key order and the HMAC no longer matches.
 */
export function verifyGitHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const actual = Buffer.from(header);
  // timingSafeEqual throws on length mismatch, and a length mismatch leaks nothing.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
