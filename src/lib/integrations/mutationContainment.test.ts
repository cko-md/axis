import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { integrationCardView } from "./cardView";
import { getCapabilities, getProviderDescriptor } from "./registry";
import {
  GOVERNED_MAIL_MUTATION_ENTRYPOINTS,
  governedMailCapabilities,
  governedMailDescriptor,
} from "./mutationContainment";

describe("current mail mutation containment", () => {
  it("preserves technical adapter capability truth while disabling every mutation in the release policy", () => {
    const technical = getCapabilities("mail", "gmail", "direct");
    const effective = governedMailCapabilities(technical);

    expect(technical?.send).toBe(true);
    expect(technical?.delete).toBe(true);
    expect(effective).toMatchObject({
      list: true,
      read: true,
      attachmentDownload: true,
      send: false,
      reply: false,
      markRead: false,
      archive: false,
      delete: false,
    });
  });

  it("covers every runtime UI consumer and makes Control Room advertise the effective read-only surface", () => {
    expect(GOVERNED_MAIL_MUTATION_ENTRYPOINTS).toEqual([
      "MailModule/MessagePanel",
      "ComposeModal",
      "ControlRoomModule",
    ]);

    const descriptor = getProviderDescriptor("mail", "gmail");
    const view = integrationCardView(governedMailDescriptor(descriptor!), "direct");
    expect(view).toMatchObject({ riskLevel: "read_only", capabilityLabel: "3 caps" });
  });

  it("wires each actual UI entry point to governed capability derivation", () => {
    const source = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");
    const mailModule = source("src/components/mail/MailModule.tsx");
    const composeModal = source("src/components/mail/ComposeModal.tsx");
    const controlRoom = source("src/components/control-room/ControlRoomModule.tsx");

    expect(mailModule).toContain("return governedMailCapabilities(getCapabilities(\"mail\", msg.provider, transport));");
    expect(composeModal).toContain("governedMailCapabilities(getCapabilities(\"mail\", provider, via))?.send");
    expect(controlRoom).toContain("integrationCardView(governedMailDescriptor(descriptor), transport)");
  });
});
