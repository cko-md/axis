import { afterEach } from "vitest";

process.env.PASSKEY_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DIRECT_PROVIDER_COOKIE_SECRET = "axis-test-direct-provider-cookie-secret-v2";

afterEach(async () => {
  const { resetDirectProviderRefreshLeaseTestState } = await import(
    "@/lib/auth/directProviderRefresh.server"
  );
  resetDirectProviderRefreshLeaseTestState();
});
