import { type NextRequest } from "next/server";
import { optionalEnv } from "@/lib/env";

export function getAppOrigin(req: NextRequest): string {
  return optionalEnv("NEXT_PUBLIC_APP_URL")?.replace(/\/$/, "") ?? req.nextUrl.origin;
}
