import { createHash } from "node:crypto";
import { PROFILE_SUBJECT_PREFIX } from "./profileSubject";

export function profileSubjectForUserId(userId: string) {
  return `${PROFILE_SUBJECT_PREFIX}${createHash("sha256").update(userId).digest("hex")}`;
}
