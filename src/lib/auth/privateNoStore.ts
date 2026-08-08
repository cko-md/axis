import { NextResponse } from "next/server";

export const PRIVATE_NO_STORE = "private, no-store, max-age=0";

export function privateNoStoreHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  next.set("Cache-Control", PRIVATE_NO_STORE);
  next.set("Pragma", "no-cache");
  return next;
}

export function privateJson<T>(body: T, init: ResponseInit = {}): NextResponse<T> {
  return NextResponse.json(body, {
    ...init,
    headers: privateNoStoreHeaders(init.headers),
  });
}

export function privateRedirect(
  destination: string | URL,
  status: 301 | 302 | 303 | 307 | 308 = 307,
): NextResponse {
  const response = NextResponse.redirect(destination, status);
  response.headers.set("Cache-Control", PRIVATE_NO_STORE);
  response.headers.set("Pragma", "no-cache");
  return response;
}
