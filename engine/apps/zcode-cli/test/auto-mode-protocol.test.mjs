import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubmittedExecutionState } from "../packages/bootstrap/src/zcode-protocol-v4/commands/handlers/submitted-execution-state.ts";

const modelSelection = { providerId: "mock", modelId: "mock-model" };

function createRecord(mode = "auto") {
  return {
    app: {
      getMode: () => mode,
      runtime: {
        getPlanEnabled: () => false,
      },
    },
  };
}

test("protocol admission preserves explicitly submitted auto mode", () => {
  const state = resolveSubmittedExecutionState(createRecord(), {
    modelSelection,
    mode: "auto",
  });

  assert.deepEqual(state, {
    modelSelection,
    mode: "auto",
    planEnabled: false,
  });
});

test("protocol admission preserves the current auto mode for legacy payloads", () => {
  const state = resolveSubmittedExecutionState(createRecord(), { modelSelection });

  assert.equal(state.mode, "auto");
});
