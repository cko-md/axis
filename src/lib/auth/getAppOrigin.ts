import { type NextRequest } from "next/server";

export function getAppOrigin(req: NextRequest): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") ?? req.nextUrl.origin
  );
}
