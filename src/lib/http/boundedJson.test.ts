import { describe, expect, it, vi } from "vitest";
import { readBoundedJson } from "./boundedJson";

describe("readBoundedJson", () => {
  it("cancels without reading when declared length already exceeds the bound", async () => {
    const cancel = vi.fn(async () => undefined);
    const read = vi.fn();
    const request = {
      headers: new Headers({ "content-length": "11" }),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Request;

    await expect(readBoundedJson(request, 10)).resolves.toEqual({
      ok: false,
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels the stream and returns 413 at the first over-limit chunk", async () => {
    const cancel = vi.fn(async () => undefined);
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(5) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(6) });
    const request = {
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Request;

    await expect(readBoundedJson(request, 10)).resolves.toEqual({
      ok: false,
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("cancels the stream when a body read throws", async () => {
    const cancel = vi.fn(async () => undefined);
    const read = vi.fn().mockRejectedValue(new Error("stream failed"));
    const request = {
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Request;

    await expect(readBoundedJson(request, 10)).resolves.toEqual({
      ok: false,
      status: 400,
      code: "INVALID_JSON",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
