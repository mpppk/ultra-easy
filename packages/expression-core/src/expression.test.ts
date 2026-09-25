import { Result } from "@praha/byethrow";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  APPROVAL_FIELD_NAMESPACES,
  DELEGATION_FIELD_NAMESPACES,
  WORKFLOW_FIELD_NAMESPACES,
  createFieldResolver,
  describeFieldCatalog,
  evaluateCondition,
  evaluateValueTemplate,
  isFieldPathAllowed,
  referencedFieldPaths,
  templateValueExpressions,
  validateCondition,
  validateValueTemplate,
} from "./index.ts";
import type { Condition, FieldResolver, JsonValue, ValueExpression } from "./index.ts";

const field = (path: string): ValueExpression => ({ type: "field", path });
const literal = (value: JsonValue): ValueExpression => ({ type: "literal", value });
const cmp = (
  left: ValueExpression,
  operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte",
  right: ValueExpression,
): Condition => ({ type: "comparison", left, operator, right });

function workflowResolver(root: unknown): FieldResolver {
  return createFieldResolver({
    policy: WORKFLOW_FIELD_NAMESPACES,
    root,
    dateTimeFields: ["now"],
  });
}

const workflowContext = {
  workflow: { input: { amount: 12_000, currency: "JPY", tags: ["urgent", "vip"] } },
  variables: { approvedBy: "user:alice" },
  nodes: { lookup: { output: { tier: "gold", score: 80 } } },
  loop: { item: { name: "bob" }, index: 2 },
  actor: { type: "user", id: "user:alice" },
  organization: { settings: { limit: 10_000 } },
  attributes: {},
  now: "2026-09-25T00:00:00.000Z",
};

function evaluated(condition: Condition, root: unknown = workflowContext) {
  const result = evaluateCondition(condition, workflowResolver(root));
  return Result.isSuccess(result) ? result.value.type : result.error.code;
}

describe("shared Expression Engine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("comparison / and / or / not / in / contains are evaluated deterministically", () => {
    expect(
      evaluated(cmp(field("workflow.input.amount"), "gt", field("organization.settings.limit"))),
    ).toBe("matched");
    expect(
      evaluated({
        type: "and",
        conditions: [
          cmp(field("workflow.input.currency"), "eq", literal("JPY")),
          { type: "not", condition: cmp(field("nodes.lookup.output.tier"), "eq", literal("x")) },
        ],
      }),
    ).toBe("matched");
    expect(
      evaluated({
        type: "or",
        conditions: [
          cmp(field("loop.index"), "lt", literal(1)),
          cmp(field("loop.item.name"), "eq", literal("carol")),
        ],
      }),
    ).toBe("not_matched");
    expect(
      evaluated({
        type: "in",
        value: field("variables.approvedBy"),
        candidates: [literal("user:bob"), literal("user:alice")],
      }),
    ).toBe("matched");
    expect(
      evaluated({
        type: "contains",
        collection: field("workflow.input.tags"),
        value: literal("vip"),
      }),
    ).toBe("matched");
    expect(evaluated(cmp(field("now"), "gte", literal("2026-01-01T00:00:00.000Z")))).toBe(
      "matched",
    );
  });

  it("unsafe path / missing field / type mismatch / namespace外はfail-closedになる", () => {
    expect(evaluated(cmp(field("workflow.input.__proto__"), "eq", literal(1)))).toBe(
      "field_not_allowed",
    );
    expect(evaluated(cmp(field("workflow.input.missing"), "eq", literal(1)))).toBe("field_missing");
    expect(evaluated(cmp(field("workflow.input.currency"), "gt", literal(1)))).toBe(
      "type_mismatch",
    );
    // Approval専用namespace（action.input）はWorkflow resolverからは参照できない。
    expect(evaluated(cmp(field("action.input.amount"), "eq", literal(1)))).toBe(
      "field_not_allowed",
    );
    expect(
      evaluated(cmp(field("now"), "eq", literal("x")), { ...workflowContext, now: "not-a-date" }),
    ).toBe("invalid_date");
    expect(
      evaluated(cmp(field("workflow.input.amount"), "eq", literal(Number.POSITIVE_INFINITY))),
    ).toBe("invalid_number");
    expect(
      evaluated(cmp(field("workflow.input.date"), "eq", literal(1)), {
        ...workflowContext,
        workflow: { input: { date: new Date() } },
      }),
    ).toBe("invalid_value");
    expect(
      evaluated({ type: "contains", collection: field("loop.index"), value: literal(1) }),
    ).toBe("type_mismatch");
  });

  it("Approval / Workflow / Delegationでnamespaceが分離されている", () => {
    expect(isFieldPathAllowed(APPROVAL_FIELD_NAMESPACES, "action.input.amount")).toBe(true);
    expect(isFieldPathAllowed(APPROVAL_FIELD_NAMESPACES, "action.inputs")).toBe(false);
    expect(isFieldPathAllowed(APPROVAL_FIELD_NAMESPACES, "workflow.input.amount")).toBe(false);
    expect(isFieldPathAllowed(APPROVAL_FIELD_NAMESPACES, "now.x")).toBe(false);

    expect(isFieldPathAllowed(WORKFLOW_FIELD_NAMESPACES, "nodes.lookup.output.tier")).toBe(true);
    expect(isFieldPathAllowed(WORKFLOW_FIELD_NAMESPACES, "nodes.lookup.input")).toBe(false);
    expect(isFieldPathAllowed(WORKFLOW_FIELD_NAMESPACES, "nodes.__proto__.output")).toBe(false);
    expect(isFieldPathAllowed(WORKFLOW_FIELD_NAMESPACES, "loop.index")).toBe(true);
    expect(isFieldPathAllowed(WORKFLOW_FIELD_NAMESPACES, "loop.index.x")).toBe(false);
    expect(isFieldPathAllowed(WORKFLOW_FIELD_NAMESPACES, "authority.principal")).toBe(false);

    expect(isFieldPathAllowed(DELEGATION_FIELD_NAMESPACES, "action.input.amount")).toBe(true);
    expect(isFieldPathAllowed(DELEGATION_FIELD_NAMESPACES, "organization.settings.x")).toBe(false);
    expect(isFieldPathAllowed(DELEGATION_FIELD_NAMESPACES, "attributes.x")).toBe(false);
  });

  it("evaluator does not perform external I/O", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const resolverCalls: string[] = [];
    const resolver: FieldResolver = {
      resolve(path) {
        resolverCalls.push(path);
        return workflowResolver(workflowContext).resolve(path);
      },
    };
    const result = evaluateCondition(
      cmp(field("workflow.input.amount"), "gt", literal(1)),
      resolver,
    );
    expect(Result.isSuccess(result)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolverCalls).toEqual(["workflow.input.amount"]);
  });

  it("ValueTemplate builds JSON from the fixed context", () => {
    const result = evaluateValueTemplate(
      {
        type: "object",
        fields: {
          name: field("loop.item.name"),
          index: field("loop.index"),
          tags: { type: "array", items: [literal("a"), field("nodes.lookup.output.tier")] },
        },
      },
      workflowResolver(workflowContext),
    );
    expect(result).toEqual(Result.succeed({ name: "bob", index: 2, tags: ["a", "gold"] }));
    const missing = evaluateValueTemplate(
      { type: "object", fields: { x: field("variables.nope") } },
      workflowResolver(workflowContext),
    );
    expect(Result.isFailure(missing) && missing.error.code).toBe("field_missing");
  });

  it("static validation reports namespace / unsafe / literal issues before execution", () => {
    expect(
      validateCondition(
        {
          type: "and",
          conditions: [
            cmp(field("action.input.amount"), "gt", literal(1)),
            cmp(field("workflow.input.__proto__"), "eq", literal(Number.NaN)),
          ],
        },
        WORKFLOW_FIELD_NAMESPACES,
      ).map((issue) => [issue.code, issue.location]),
    ).toEqual([
      ["field_not_allowed", "$.conditions[0].left"],
      ["unsafe_field_path", "$.conditions[1].left"],
      ["invalid_literal", "$.conditions[1].right"],
    ]);
    const template = {
      type: "object" as const,
      fields: { a: field("nodes.x.output.y"), b: field("variables.z") },
    };
    expect(validateValueTemplate(template, WORKFLOW_FIELD_NAMESPACES)).toEqual([]);
    expect(referencedFieldPaths(templateValueExpressions(template))).toEqual([
      "nodes.x.output.y",
      "variables.z",
    ]);
  });

  it("workflow field catalog can be enumerated for the UI", () => {
    const catalog = describeFieldCatalog(WORKFLOW_FIELD_NAMESPACES, [
      { path: "workflow.input.amount", type: "number", label: "金額" },
      { path: "nodes.lookup.output.tier", type: "string" },
    ]);
    expect(Result.isSuccess(catalog)).toBe(true);
    if (Result.isFailure(catalog)) return;
    expect(catalog.value.context).toBe("workflow");
    expect(catalog.value.namespaces.map((namespace) => namespace.pattern)).toContain(
      "nodes.*.output",
    );
    expect(catalog.value.fields).toHaveLength(2);

    const invalid = describeFieldCatalog(WORKFLOW_FIELD_NAMESPACES, [
      { path: "action.input.amount", type: "number" },
      { path: "variables.__proto__", type: "string" },
      { path: "variables.a", type: "string" },
      { path: "variables.a", type: "string" },
    ]);
    expect(Result.isFailure(invalid) && invalid.error.map((issue) => issue.code)).toEqual([
      "field_not_allowed",
      "unsafe_field_path",
      "duplicate_field",
    ]);
  });
});
