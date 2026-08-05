"use client";

import { usePathname } from "next/navigation";
import { classifyAccess } from "@/lib/auth/accessPolicy";

type RootProviderBoundaryProps = {
  children: React.ReactNode;
  staticPublic: React.ReactNode;
};

/**
 * Static public documents must remain renderable when authentication
 * infrastructure is unavailable. The authenticated provider tree stays strict
 * and is mounted for every other route, including login and OAuth callback
 * paths that need Supabase to complete their workflow.
 */
export function RootProviderBoundary({
  children,
  staticPublic,
}: RootProviderBoundaryProps) {
  const pathname = usePathname();
  return classifyAccess(pathname ?? "") === "static-public-page"
    ? staticPublic
    : children;
}
