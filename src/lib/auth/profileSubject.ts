export const PROFILE_SUBJECT_PREFIX = "ps1_";
export const PROFILE_SUBJECT_LENGTH = PROFILE_SUBJECT_PREFIX.length + 64;

const PROFILE_SUBJECT_PATTERN = /^ps1_[a-f0-9]{64}$/;

export function isProfileSubject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === PROFILE_SUBJECT_LENGTH &&
    PROFILE_SUBJECT_PATTERN.test(value)
  );
}
