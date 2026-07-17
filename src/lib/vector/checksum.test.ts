import { describe, expect, it } from "vitest";
import {
  canonicalVectorJson,
  checksumVectorState,
  vectorJsonBytes,
} from "@/lib/vector/checksum";

describe("VECTOR canonical JSON", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalVectorJson({
      z: 1,
      a: { y: true, x: [3, 2, 1] },
    })).toBe('{"a":{"x":[3,2,1],"y":true},"z":1}');
  });

  it("produces the same checksum for semantically identical objects", async () => {
    await expect(checksumVectorState({ b: 2, a: 1 })).resolves.toBe(
      await checksumVectorState({ a: 1, b: 2 }),
    );
  });

  it("canonicalizes adversarial Unicode keys independently of insertion order", async () => {
    const keys = ["Z", "a", "z", "ä", "e\u0301", "é", "😀", "\uE000"];
    const forward = Object.fromEntries(keys.map((key) => [key, key]));
    const reverse = Object.fromEntries([...keys].reverse().map((key) => [key, key]));

    const canonical = canonicalVectorJson(forward);
    expect(canonicalVectorJson(reverse)).toBe(canonical);
    expect(Object.keys(JSON.parse(canonical))).toEqual([
      "Z",
      "a",
      "e\u0301",
      "z",
      "ä",
      "é",
      "😀",
      "\uE000",
    ]);
    await expect(checksumVectorState(reverse)).resolves.toBe(
      await checksumVectorState(forward),
    );
  });

  it("measures the canonical UTF-8 representation", () => {
    expect(vectorJsonBytes({ symbol: "◇" })).toBe(
      new TextEncoder().encode('{"symbol":"◇"}').byteLength,
    );
  });
});
