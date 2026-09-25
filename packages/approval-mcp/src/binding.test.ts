import { readFileSync } from "node:fs";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionDefinition, ActionType, ExecutorKey } from "@app/approval-core";

import {
  mapMcpToolArguments,
  mcpToolBindingFingerprint,
  StaticMcpToolBindingRegistry,
  validateMcpToolBindingsAgainstActionDefinitions,
} from "./binding.ts";
import {
  branded,
  closeBinding,
  MCP_EXECUTOR_KEY,
  org,
  otherOrg,
  priorityActionType,
  priorityBinding,
} from "./test-support.ts";

function issueCodes(result: ReturnType<typeof StaticMcpToolBindingRegistry.create>): string[] {
  return Result.isFailure(result) ? result.error.issues.map((issue) => issue.code) : [];
}

describe("MCP Gateway 1: ActionType ↔ MCP Tool Binding / Registry", () => {
  it("ActionType ↔ exposed tool ↔ downstream toolを解決できる", async () => {
    const registry = StaticMcpToolBindingRegistry.create([priorityBinding(), closeBinding()]);
    assert(Result.isSuccess(registry));

    const byTool = await registry.value.resolveByToolName({
      organizationId: org,
      toolName: "ticket_set_priority",
    });
    const byAction = await registry.value.resolveByActionType({
      organizationId: org,
      actionType: priorityActionType,
    });

    assert(Result.isSuccess(byTool) && Result.isSuccess(byAction));
    expect(byTool.value).toEqual(byAction.value);
    expect(byTool.value).toMatchObject({
      actionType: "ticket.priority.change",
      exposedTool: { name: "ticket_set_priority" },
      target: { mcpServerId: "ticket-server", toolName: "set_priority" },
    });
  });

  it("duplicate / ambiguous bindingをfail-fastで拒否する", () => {
    expect(
      issueCodes(
        StaticMcpToolBindingRegistry.create([
          priorityBinding(),
          closeBinding({
            exposedTool: { ...closeBinding().exposedTool, name: "ticket_set_priority" },
          }),
        ]),
      ),
    ).toContain("duplicate_tool_name");
    expect(
      issueCodes(
        StaticMcpToolBindingRegistry.create([
          priorityBinding(),
          closeBinding({ actionType: priorityActionType }),
        ]),
      ),
    ).toContain("duplicate_action_type");
    expect(
      issueCodes(StaticMcpToolBindingRegistry.create([priorityBinding(), priorityBinding()])),
    ).toEqual(expect.arrayContaining(["duplicate_binding_id", "duplicate_tool_name"]));
  });

  it("不正なtool名 / input schema / argument mappingを拒否する", () => {
    expect(
      issueCodes(
        StaticMcpToolBindingRegistry.create([
          priorityBinding({
            exposedTool: { ...priorityBinding().exposedTool, name: "has space" },
          }),
        ]),
      ),
    ).toContain("invalid_tool_name");
    expect(
      issueCodes(
        StaticMcpToolBindingRegistry.create([
          priorityBinding({
            exposedTool: {
              ...priorityBinding().exposedTool,
              inputSchema: { type: "object", properties: { ticketId: { type: "string" } } },
            },
          }),
        ]),
      ),
    ).toContain("invalid_input_schema");
    expect(
      issueCodes(
        StaticMcpToolBindingRegistry.create([
          priorityBinding({ exposedTool: { ...priorityBinding().exposedTool, inputSchema: {} } }),
        ]),
      ),
    ).toContain("invalid_input_schema");
  });

  it("inactive bindingは解決・公開されず、active bindingとの重複もfail-fast対象外", async () => {
    const registry = StaticMcpToolBindingRegistry.create([
      priorityBinding({ status: "inactive", version: 1 }),
      priorityBinding({ version: 2, target: { mcpServerId: "ticket-server-v2", toolName: "set" } }),
      closeBinding({ status: "inactive" }),
    ]);
    assert(Result.isSuccess(registry));

    const listed = await registry.value.listActive({ organizationId: org });
    const closed = await registry.value.resolveByToolName({
      organizationId: org,
      toolName: "ticket_close",
    });

    assert(Result.isSuccess(listed) && Result.isSuccess(closed));
    expect(listed.value.map((binding) => [binding.exposedTool.name, binding.version])).toEqual([
      ["ticket_set_priority", 2],
    ]);
    expect(closed.value).toBeNull();
  });

  it("別organizationのbindingは解決しない", async () => {
    const registry = StaticMcpToolBindingRegistry.create([
      priorityBinding({ organizationId: otherOrg }),
    ]);
    assert(Result.isSuccess(registry));

    const resolved = await registry.value.resolveByToolName({
      organizationId: org,
      toolName: "ticket_set_priority",
    });

    assert(Result.isSuccess(resolved));
    expect(resolved.value).toBeNull();
  });

  it("Action Definitionが存在しMCP executorで実行されるActionTypeだけをbindできる", async () => {
    const definitions = new Map<string, ActionDefinition>([
      [
        String(priorityActionType),
        {
          key: branded("definition:priority"),
          version: 1,
          actionType: priorityActionType,
          inputSchema: { key: branded("ticket-input"), version: 1 },
          executorKey: branded<ExecutorKey>("staging"),
        },
      ],
    ]);
    const resolver = {
      async resolve(actionType: ActionType) {
        return Result.succeed(definitions.get(String(actionType)) ?? null);
      },
    };

    const validated = await validateMcpToolBindingsAgainstActionDefinitions({
      bindings: [priorityBinding(), closeBinding()],
      resolver,
      mcpExecutorKey: MCP_EXECUTOR_KEY,
    });

    assert(Result.isFailure(validated));
    expect(validated.error.issues.map((issue) => issue.bindingId)).toEqual([
      "binding:ticket-priority",
      "binding:ticket-close",
    ]);
  });

  it("routing変更はbinding fingerprintを変え、承認時snapshotと区別できる", async () => {
    const v1 = await mcpToolBindingFingerprint(priorityBinding());
    const sameV1 = await mcpToolBindingFingerprint({ ...priorityBinding(), status: "inactive" });
    const rerouted = await mcpToolBindingFingerprint(
      priorityBinding({ version: 2, target: { mcpServerId: "other", toolName: "set_priority" } }),
    );

    assert(Result.isSuccess(v1) && Result.isSuccess(sameV1) && Result.isSuccess(rerouted));
    expect(sameV1.value).toBe(v1.value);
    expect(rerouted.value).not.toBe(v1.value);
  });

  it("argumentsはresource ID argumentだけをresourceへ、残りをinputへ写像する", () => {
    const mapped = mapMcpToolArguments(priorityBinding(), {
      ticketId: "T-9",
      priority: "low",
      actor: { type: "user", id: "user:mallory" },
    });

    assert(Result.isSuccess(mapped));
    expect(mapped.value).toEqual({
      type: priorityActionType,
      resource: { type: "ticket", id: "T-9" },
      input: { priority: "low", actor: { type: "user", id: "user:mallory" } },
    });
    expect(Result.isFailure(mapMcpToolArguments(priorityBinding(), { ticketId: 1 }))).toBe(true);
  });

  it("core packageはMCP protocol概念へ依存しない", () => {
    const core = JSON.parse(
      readFileSync(new URL("../../approval-core/package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const actionDefinition = readFileSync(
      new URL("../../approval-core/src/action-definition.ts", import.meta.url),
      "utf8",
    );

    expect(Object.keys(core.dependencies ?? {})).not.toContain("@app/approval-mcp");
    expect(actionDefinition).not.toMatch(/mcp/i);
  });
});
