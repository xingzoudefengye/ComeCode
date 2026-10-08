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

test("auto mode still asks for tools marked alwaysAsk", () => {
  const decision = service.checkPermission(
    {
      input: { command: "git push" },
      mode: "auto",
      riskLevel: "high",
      toolName: "Bash",
    },
    { alwaysAsk: true },
  );

  assert.equal(decision.decision, "ask");
  assert.equal(decision.ruleId, "tool.alwaysAsk");
});

test("auto mode still denies explicitly disallowed tools", () => {
  const autoService = new PermissionService({
    allowedTools: new Set(),
    disallowedTools: new Set(["Bash"]),
    autoApproveHighRisk: false,
    allowMediumRiskInAutoMode: false,
  });
  const decision = autoService.checkPermission({
    input: { command: "rm -rf ./dist" },
    mode: "auto",
    riskLevel: "high",
    toolName: "Bash",
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.disallowedTools");
});

test("auto mode still denies project deny rules", () => {
  const decision = service.checkPermission(
    {
      input: { command: "rm -rf ./dist" },
      mode: "auto",
      riskLevel: "high",
      toolName: "Bash",
    },
    undefined,
    { version: 1, deny: [{ toolName: "Bash" }] },
  );

  assert.equal(decision.decision, "deny");
  assert.equal(decision.ruleId, "rule.project.deny");
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
