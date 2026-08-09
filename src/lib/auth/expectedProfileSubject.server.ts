import { timingSafeEqual } from "node:crypto";
import {
  EXPECTED_PROFILE_SUBJECT_HEADER,
  isProfileSubject,
} from "@/lib/auth/profileSubject";
import { profileSubjectForUserId } from "@/lib/auth/profileSubject.server";
import { privateJson } from "@/lib/auth/privateNoStore";

type ExpectedProfileSubjectResult =
  | { ok: true; subject: string }
  | { ok: false; response: Response };

function equalFixedLength(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Binds a browser request to the same authenticated Axis subject that issued
 * it. Missing, malformed, and stale-account headers intentionally collapse to
 * the same private response; no subject value is returned or logged.
 */
export function validateExpectedProfileSubject(
  request: Request,
  userId: string,
): ExpectedProfileSubjectResult {
  const supplied = request.headers.get(EXPECTED_PROFILE_SUBJECT_HEADER);
  const subject = profileSubjectForUserId(userId);
  if (!isProfileSubject(supplied) || !equalFixedLength(supplied, subject)) {
    return {
      ok: false,
      response: privateJson({ error: "SUBJECT_CHANGED" }, { status: 409 }),
    };
  }
  return { ok: true, subject };
}
