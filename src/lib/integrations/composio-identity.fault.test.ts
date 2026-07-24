import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

import {
  assertRemoteBinding,
  ComposioIdentityError,
  projectComposioConnection,
} from "./composio-identity";
import type { ConnectedAccount } from "./composio";

const authority = {
  user_id: "axis-user-1",
  toolkit: "gmail",
  connected_account_id: "remote-account-1",
  auth_config_id: "auth-config-1",
};

function privateActiveRemote(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    id: "remote-account-1",
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    user_id: "axis-user-1",
    auth_config: { id: "auth-config-1" },
    experimental: { account_type: "PRIVATE" },
    is_disabled: false,
    ...overrides,
  };
}

function expectBindingRejected(remote: ConnectedAccount) {
  expect(() => assertRemoteBinding(authority, remote, { requireActive: true }))
    .toThrow(ComposioIdentityError);
}

describe("Composio identity fault boundaries", () => {
  it("requires the complete private remote binding before authorizing an action", () => {
    assertRemoteBinding(authority, privateActiveRemote(), { requireActive: true });

    expectBindingRejected(privateActiveRemote({ id: "forged-remote-account" }));
    expectBindingRejected(privateActiveRemote({ toolkit: { slug: "outlook" } }));
    expectBindingRejected(privateActiveRemote({ user_id: "other-axis-user" }));
    expectBindingRejected(privateActiveRemote({ auth_config: { id: "other-auth-config" } }));
    expectBindingRejected(privateActiveRemote({ experimental: { account_type: "PUBLIC" } }));
    expectBindingRejected(privateActiveRemote({ is_disabled: true }));
    expectBindingRejected(privateActiveRemote({ status: "EXPIRED" }));
  });

  it("fails closed when a provider response cannot prove its Axis owner", () => {
    expectBindingRejected(privateActiveRemote({ user_id: undefined, userId: undefined }));
  });

  it("projects only opaque Axis identity and safe lifecycle metadata to browsers", () => {
    const projected = projectComposioConnection({
      id: "axis-connection-uuid",
      user_id: "axis-user-1",
      toolkit: "gmail",
      connected_account_id: "remote-account-secret",
      status: "ACTIVE",
      account_label: "me@example.test",
      created_at: "2026-07-23T00:00:00.000Z",
      updated_at: "2026-07-23T00:01:00.000Z",
      remote_verified_at: "2026-07-23T00:01:00.000Z",
      lifecycle_version: 4,
      verification_error_code: null,
    });

    expect(projected).toEqual({
      id: "axis-connection-uuid",
      toolkit: "gmail",
      status: "ACTIVE",
      accountLabel: "me@example.test",
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:01:00.000Z",
      remoteVerifiedAt: "2026-07-23T00:01:00.000Z",
    });
    expect(JSON.stringify(projected)).not.toContain("remote-account-secret");
    expect(JSON.stringify(projected)).not.toContain("axis-user-1");
  });
});
