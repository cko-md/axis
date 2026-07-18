import { describe, expect, it } from "vitest";
import {
  INITIAL_SECOND_SENSE_INPUT_STATE,
  isSecondSenseHolding,
  reduceSecondSenseInput,
  type SecondSenseInputState,
} from "@/lib/vector/games/second-sense/inputState";

function run(events: Parameters<typeof reduceSecondSenseInput>[1][]): SecondSenseInputState {
  return events.reduce(reduceSecondSenseInput, INITIAL_SECOND_SENSE_INPUT_STATE);
}

describe("second sense input state machine", () => {
  it("advances through a full valid trial cycle", () => {
    const afterStart = run([{ type: "trialStart" }]);
    expect(afterStart.phase).toBe("demonstrating");

    const afterDemo = run([{ type: "trialStart" }, { type: "demoComplete" }]);
    expect(afterDemo.phase).toBe("armed");

    const afterHoldStart = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 1000 },
    ]);
    expect(afterHoldStart.phase).toBe("holding");
    expect(afterHoldStart.holdStartedAtMs).toBe(1000);
    expect(isSecondSenseHolding(afterHoldStart)).toBe(true);

    const afterHoldEnd = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 1000 },
      { type: "holdEnd", atMs: 1750 },
    ]);
    expect(afterHoldEnd.phase).toBe("released");
    expect(afterHoldEnd.heldForMs).toBe(750);
    expect(isSecondSenseHolding(afterHoldEnd)).toBe(false);
  });

  it("allows a new trial to start after the previous one is released", () => {
    const released = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 0 },
      { type: "holdEnd", atMs: 500 },
    ]);
    const next = reduceSecondSenseInput(released, { type: "trialStart" });
    expect(next.phase).toBe("demonstrating");
    expect(next.heldForMs).toBeNull();
  });

  it("ignores a duplicate holdStart while already holding (e.g. keyboard auto-repeat)", () => {
    const holding = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 1000 },
    ]);
    const repeated = reduceSecondSenseInput(holding, { type: "holdStart", atMs: 1050 });
    expect(repeated).toEqual(holding);
    expect(repeated.holdStartedAtMs).toBe(1000);
  });

  it("ignores holdEnd with no matching holdStart", () => {
    const armed = run([{ type: "trialStart" }, { type: "demoComplete" }]);
    const spuriousEnd = reduceSecondSenseInput(armed, { type: "holdEnd", atMs: 500 });
    expect(spuriousEnd).toEqual(armed);
  });

  it("ignores holdStart before the demonstration completes", () => {
    const demonstrating = run([{ type: "trialStart" }]);
    const spuriousStart = reduceSecondSenseInput(demonstrating, { type: "holdStart", atMs: 10 });
    expect(spuriousStart).toEqual(demonstrating);
  });

  it("ignores events once a trial is already released, until the next trialStart", () => {
    const released = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 0 },
      { type: "holdEnd", atMs: 400 },
    ]);
    const spuriousHoldStart = reduceSecondSenseInput(released, { type: "holdStart", atMs: 900 });
    expect(spuriousHoldStart).toEqual(released);
  });

  it("clamps a negative held duration to zero for a clock that moves backwards", () => {
    const holding = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 1000 },
    ]);
    const released = reduceSecondSenseInput(holding, { type: "holdEnd", atMs: 900 });
    expect(released.heldForMs).toBe(0);
  });

  it("resets unconditionally from any phase", () => {
    const holding = run([
      { type: "trialStart" },
      { type: "demoComplete" },
      { type: "holdStart", atMs: 1000 },
    ]);
    expect(reduceSecondSenseInput(holding, { type: "reset" })).toEqual(
      INITIAL_SECOND_SENSE_INPUT_STATE,
    );
  });
});
