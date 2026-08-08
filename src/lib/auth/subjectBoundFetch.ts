import {
  EXPECTED_PROFILE_SUBJECT_HEADER,
  isProfileSubject,
} from "@/lib/auth/profileSubject";

function sameOriginUrl(input: string | URL) {
  const url = new URL(input.toString(), window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error("SUBJECT_BOUND_FETCH_REQUIRES_SAME_ORIGIN");
  }
  return url;
}

export function subjectBoundFetch(
  subject: string,
  input: string | URL,
  init: RequestInit = {},
) {
  if (!isProfileSubject(subject)) {
    throw new Error("SUBJECT_BOUND_FETCH_REQUIRES_AUTHORITY");
  }
  const url = sameOriginUrl(input);
  const headers = new Headers(init.headers);
  headers.set(EXPECTED_PROFILE_SUBJECT_HEADER, subject);
  return fetch(url, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
}
