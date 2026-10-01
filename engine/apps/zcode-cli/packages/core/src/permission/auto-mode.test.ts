import assert from "node:assert/strict";
import test from "node:test";
import { EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { PermissionService } from "./service.js";

const service = new PermissionService();

test("auto mode bypasses ordinary tool prompts", () => {
  const decision = service.checkPermission({
    input: {},
    mode: "auto",
    riskLevel: "medium",
    toolName: "Bash",
  });

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.auto");
});

test("auto mode approves ExitPlanMode without asking", () => {
  const decision = service.checkPermission(
    {
      input: { plan: "Ship the change." },
      mode: "auto",
      planEnabled: true,
      prePlanMode: "auto",
      riskLevel: "low",
      toolName: EXIT_PLAN_MODE_TOOL_NAME,
    },
    { requiresUserInteraction: true },
  );

  assert.equal(decision.decision, "allow");
  assert.equal(decision.ruleId, "mode.auto.plan");
});

test("yolo still asks before exiting plan mode", () => {
  const decision = service.checkPermission(
    {
      input: { plan: "Ship the change." },
      mode: "yolo",
      planEnabled: true,
      prePlanMode: "yolo",
      riskLevel: "low",
      toolName: EXIT_PLAN_MODE_TOOL_NAME,
    },
    { requiresUserInteraction: true },
  );

  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "tool.userInteraction");
});
