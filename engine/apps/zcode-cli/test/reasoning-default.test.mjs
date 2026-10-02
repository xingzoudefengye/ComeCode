import assert from "node:assert/strict";
import { test } from "node:test";
import { pickDefaultReasoningLevel } from "../../../packages/provider/dist/model-selection-config.js";

test("配置的默认档位合法时优先使用", () => {
  assert.equal(pickDefaultReasoningLevel(["low", "high", "max"], "low"), "low");
  assert.equal(pickDefaultReasoningLevel(["low", "high", "max"], "max"), "max");
});

test("配置的默认档位不被支持时按现有规则回退到 high", () => {
  assert.equal(pickDefaultReasoningLevel(["low", "max"], "medium"), "low");
  assert.equal(pickDefaultReasoningLevel(["low", "high", "max"], "medium"), "high");
});

test("未配置默认档位时沿用 high→balanced→medium 优先", () => {
  assert.equal(pickDefaultReasoningLevel(["low", "high", "max"]), "high");
  assert.equal(pickDefaultReasoningLevel(["low", "max"]), "low");
  assert.equal(pickDefaultReasoningLevel(["disabled", "none"]), "disabled");
  assert.equal(pickDefaultReasoningLevel([]), undefined);
});
