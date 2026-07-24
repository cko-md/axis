import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposioError, getPrivateConnectedAccountExact } from "./composio";

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function privateAccount() {
  return {
    id: "remote-account-1",
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    user_id: "axis-user-1",
    auth_config: { id: "auth-config-1" },
    experimental: { account_type: "PRIVATE" },
    is_disabled: false,
  };
}

describe("Composio v3.1 private authority lookup", () => {
  it("requires one result after filtering by every authority dimension", async () => {
    process.env.COMPOSIO_API_KEY = "test-key";
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [privateAccount()] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPrivateConnectedAccountExact({
      toolkit: "gmail",
      userId: "axis-user-1",
      authConfigId: "auth-config-1",
      connectedAccountId: "remote-account-1",
    })).resolves.toEqual(privateAccount());

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      toolkit_slugs: "gmail",
      statuses: "ACTIVE",
      user_ids: "axis-user-1",
      auth_config_ids: "auth-config-1",
      connected_account_ids: "remote-account-1",
      account_type: "PRIVATE",
    });
  });

  it("fails closed when provider filtering returns zero or multiple accounts", async () => {
    process.env.COMPOSIO_API_KEY = "test-key";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [privateAccount(), privateAccount()] }), { status: 200 }));

    const input = { toolkit: "gmail" as const, userId: "axis-user-1", authConfigId: "auth-config-1", connectedAccountId: "remote-account-1" };
    await expect(getPrivateConnectedAccountExact(input)).rejects.toMatchObject({ status: 403 });
    await expect(getPrivateConnectedAccountExact(input)).rejects.toMatchObject({ status: 403 });
  });

  it("does not include a raw provider error body in the thrown error", async () => {
    process.env.COMPOSIO_API_KEY = "test-key";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(new Response("oauth token and mailbox details", { status: 502 }));

    await expect(getPrivateConnectedAccountExact({
      toolkit: "gmail",
      userId: "axis-user-1",
      authConfigId: "auth-config-1",
      connectedAccountId: "remote-account-1",
    })).rejects.toEqual(new ComposioError("Composio request failed (502)", 502));
  });
});
