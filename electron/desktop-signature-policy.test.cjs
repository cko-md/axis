/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");

async function policy() {
  return import("../scripts/desktop-signature-policy.mjs");
}

test("preview signature policy accepts only ad-hoc, teamless metadata", async () => {
  const { parseCodesignMetadata, validateSignatureMetadata } = await policy();
  const valid = parseCodesignMetadata("Signature=adhoc\nTeamIdentifier=not set\n");
  assert.deepEqual(validateSignatureMetadata(valid, "preview"), []);

  const developerId = parseCodesignMetadata(
    "Signature size=9041\nAuthority=Developer ID Application: Example (TEAM123)\nTeamIdentifier=TEAM123\n",
  );
  assert.match(
    validateSignatureMetadata(developerId, "preview").join("\n"),
    /ad-hoc.*signing team.*certificate authorities/s,
  );
});

test("release signature policy requires Developer ID and a signing team", async () => {
  const { parseCodesignMetadata, validateSignatureMetadata } = await policy();
  const valid = parseCodesignMetadata(
    "Signature size=9041\nAuthority=Developer ID Application: Example (TEAM123)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=TEAM123\n",
  );
  assert.deepEqual(validateSignatureMetadata(valid, "release"), []);

  const adHoc = parseCodesignMetadata("Signature=adhoc\nTeamIdentifier=not set\n");
  assert.match(
    validateSignatureMetadata(adHoc, "release").join("\n"),
    /Developer ID.*team identifier.*ad-hoc/s,
  );
});

test("preview stapler validation accepts only the documented no-ticket response", async () => {
  const { validateStaplerResult } = await policy();
  assert.deepEqual(
    validateStaplerResult({
      status: 65,
      stdout: "AXIS.app does not have a ticket stapled to it.\n",
      stderr: "",
    }, "preview"),
    [],
  );
  assert.match(
    validateStaplerResult({ status: 1, stdout: "something else", stderr: "" }, "preview").join("\n"),
    /expected no-ticket result/,
  );
  assert.match(
    validateStaplerResult({ status: 0, stdout: "The validate action worked!", stderr: "" }, "preview").join("\n"),
    /expected no-ticket result/,
  );
});
