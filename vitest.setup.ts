import { afterEach } from "vitest";

process.env.PASSKEY_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DIRECT_PROVIDER_COOKIE_SECRET = "axis-test-direct-provider-cookie-secret-v2";
process.env.DIRECT_PROVIDER_COOKIE_V1_ACCEPT_UNTIL = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
  const { resetDirectProviderRefreshLeaseTestState } = await import(
    "@/lib/auth/directProviderRefresh.server"
  );
  resetDirectProviderRefreshLeaseTestState();
});
