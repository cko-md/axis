import { describe, expect, it } from "vitest";
import {
  shouldCaptureWidgetEndpointStatus,
  widgetEndpointErrorCode,
  widgetProviderFailureTags,
} from "@/lib/widgets/observability";

describe("widget provider observability", () => {
  it("maps endpoint statuses into normalized batch error codes", () => {
    expect(widgetEndpointErrorCode(401)).toEqual("UNAUTHORIZED");
    expect(widgetEndpointErrorCode(403)).toEqual("WIDGET_ENDPOINT_FAILED");
    expect(widgetEndpointErrorCode(503)).toEqual("WIDGET_ENDPOINT_FAILED");
  });

  it("captures unexpected provider/server failures but not expected client/auth statuses", () => {
    expect(shouldCaptureWidgetEndpointStatus(500)).toBe(true);
    expect(shouldCaptureWidgetEndpointStatus(503)).toBe(true);
    expect(shouldCaptureWidgetEndpointStatus(429)).toBe(false);
    expect(shouldCaptureWidgetEndpointStatus(401)).toBe(false);
  });

  it("builds safe provider failure tags without payload content", () => {
    expect(widgetProviderFailureTags({
      widget: "weather",
      provider: "open-meteo",
      status: 503,
      code: "WIDGET_ENDPOINT_FAILED",
    })).toEqual({
      widget: "weather",
      provider: "open-meteo",
      status: "503",
      code: "WIDGET_ENDPOINT_FAILED",
    });
  });
});
