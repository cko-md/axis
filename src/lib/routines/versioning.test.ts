import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROUTINE_VERSIONS,
  cloneRoutineVersion,
  compareRoutineVersions,
  definitionFromJson,
  definitionToJson,
  nextRoutineVersion,
} from "./versioning";

describe("routine versioning", () => {
  it("compares routine definitions by steps, inputs, and safety contract", () => {
    const left = BUILTIN_ROUTINE_VERSIONS[0];
    const right = {
      ...left,
      id: "user-version",
      definition: {
        ...left.definition,
        inputs: { ...left.definition.inputs, minValue: { type: "number", default: 100 } },
        steps: [...left.definition.steps, "notify_user"],
        safety: [...left.definition.safety, "notifies_user"],
      },
    };

    const diff = compareRoutineVersions(left, right);

    expect(diff.sameRoutine).toBe(true);
    expect(diff.changed).toEqual(["steps", "inputs", "safety"]);
    expect(diff.stepChanges.added).toEqual(["notify_user"]);
    expect(diff.inputChanges.added).toEqual(["minValue"]);
    expect(diff.safetyChanges.added).toEqual(["notifies_user"]);
  });

  it("allocates the next version per routine key", () => {
    expect(nextRoutineVersion(BUILTIN_ROUTINE_VERSIONS, "concentration_review")).toBe(2);
    expect(nextRoutineVersion(BUILTIN_ROUTINE_VERSIONS, "new_routine")).toBe(1);
  });

  it("clones a version without changing the source definition in place", () => {
    const source = BUILTIN_ROUTINE_VERSIONS[0];
    const cloned = cloneRoutineVersion(source, 4, "draft");

    expect(cloned.routineKey).toBe(source.routineKey);
    expect(cloned.routineVersion).toBe(4);
    expect(cloned.definition.version).toBe(4);
    expect(source.definition.version).toBe(1);
    expect(cloned.sourceVersionId).toBe(source.id);
  });

  it("round-trips a definition through JSON with validation", () => {
    const definition = BUILTIN_ROUTINE_VERSIONS[1].definition;
    expect(definitionFromJson(definitionToJson(definition))).toEqual(definition);
    expect(definitionFromJson({ routineKey: "bad" })).toBeNull();
  });
});
