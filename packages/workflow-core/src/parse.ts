import { Result } from "@praha/byethrow";

import { isPlainRecord } from "@app/expression-core";

import type { WorkflowDefinition } from "./definition.ts";
import type { WorkflowValidationIssue } from "./validation.ts";

const NODE_TYPES = new Set([
  "trigger",
  "action",
  "branch",
  "for_each",
  "while",
  "transform",
  "program",
  "llm",
  "join",
  "output",
]);

const MAX_DEPTH = 32;

function isValueExpression(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value["type"] === "literal") return "value" in value;
  if (value["type"] === "field") return typeof value["path"] === "string";
  return false;
}

function isTemplate(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || !isPlainRecord(value)) return false;
  if (value["type"] === "object") {
    const fields = value["fields"];
    return (
      isPlainRecord(fields) && Object.values(fields).every((child) => isTemplate(child, depth + 1))
    );
  }
  if (value["type"] === "array") {
    const items = value["items"];
    return Array.isArray(items) && items.every((child) => isTemplate(child, depth + 1));
  }
  return isValueExpression(value);
}

function isCondition(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || !isPlainRecord(value)) return false;
  switch (value["type"]) {
    case "comparison":
      return (
        isValueExpression(value["left"]) &&
        isValueExpression(value["right"]) &&
        ["eq", "ne", "gt", "gte", "lt", "lte"].includes(String(value["operator"]))
      );
    case "and":
    case "or": {
      const conditions = value["conditions"];
      return (
        Array.isArray(conditions) && conditions.every((child) => isCondition(child, depth + 1))
      );
    }
    case "not":
      return isCondition(value["condition"], depth + 1);
    case "in": {
      const candidates = value["candidates"];
      return (
        isValueExpression(value["value"]) &&
        Array.isArray(candidates) &&
        candidates.every(isValueExpression)
      );
    }
    case "contains":
      return isValueExpression(value["collection"]) && isValueExpression(value["value"]);
    default:
      return false;
  }
}

function checkNode(
  node: unknown,
  location: string,
  issues: WorkflowValidationIssue[],
  depth: number,
): void {
  const add = (message: string): void => {
    issues.push({ code: "invalid_shape", location, message });
  };
  if (!isPlainRecord(node)) return add("Nodeはobjectである必要があります");
  if (typeof node["id"] !== "string") return add("Node idが必要です");
  const type = node["type"];
  if (typeof type !== "string" || !NODE_TYPES.has(type))
    return add(`未対応のNode typeです: ${String(type)}`);
  switch (type) {
    case "action": {
      const resource = node["resource"];
      if (typeof node["actionType"] !== "string") add("actionTypeが必要です");
      if (
        !isPlainRecord(resource) ||
        typeof resource["type"] !== "string" ||
        !isValueExpression(resource["id"])
      ) {
        add("resource {type, id}が必要です");
      }
      if (!isTemplate(node["input"])) add("inputはValueTemplateである必要があります");
      if (node["restriction"] !== undefined && !isCondition(node["restriction"]))
        add("restrictionが不正です");
      return;
    }
    case "branch": {
      const cases = node["cases"];
      if (
        !Array.isArray(cases) ||
        !cases.every(
          (item) =>
            isPlainRecord(item) && typeof item["key"] === "string" && isCondition(item["when"]),
        )
      ) {
        add("casesは{key, when}の配列である必要があります");
      }
      return;
    }
    case "for_each":
    case "while": {
      if (type === "for_each" && !isValueExpression(node["collection"]))
        add("collectionが必要です");
      if (type === "while" && !isCondition(node["condition"])) add("conditionが必要です");
      checkGraph(node["body"], `${location}.body`, issues, depth + 1);
      return;
    }
    case "transform":
      if (!isTemplate(node["output"])) add("outputはValueTemplateである必要があります");
      if (
        node["assign"] !== undefined &&
        (!isPlainRecord(node["assign"]) ||
          !Object.values(node["assign"]).every((item) => isTemplate(item)))
      ) {
        add("assignが不正です");
      }
      return;
    case "program": {
      const program = node["program"];
      if (
        !isPlainRecord(program) ||
        typeof program["programId"] !== "string" ||
        typeof program["version"] !== "number" ||
        typeof program["sourceDigest"] !== "string"
      ) {
        add("program {programId, version, sourceDigest}が必要です");
      }
      if (!isTemplate(node["input"])) add("inputはValueTemplateである必要があります");
      return;
    }
    case "llm":
      if (
        typeof node["model"] !== "string" ||
        !isTemplate(node["prompt"]) ||
        typeof node["maxOutputTokens"] !== "number"
      ) {
        add("model / prompt / maxOutputTokensが必要です");
      }
      return;
    case "output":
      if (!isTemplate(node["value"])) add("valueはValueTemplateである必要があります");
      return;
    default:
      return;
  }
}

function checkGraph(
  graph: unknown,
  location: string,
  issues: WorkflowValidationIssue[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    issues.push({ code: "invalid_shape", location, message: "nestが深すぎます" });
    return;
  }
  if (!isPlainRecord(graph) || !Array.isArray(graph["nodes"]) || !Array.isArray(graph["edges"])) {
    issues.push({
      code: "invalid_shape",
      location,
      message: "graphは{nodes, edges}である必要があります",
    });
    return;
  }
  graph["nodes"].forEach((node, index) =>
    checkNode(node, `${location}.nodes[${index}]`, issues, depth),
  );
  graph["edges"].forEach((edge, index) => {
    if (
      !isPlainRecord(edge) ||
      typeof edge["id"] !== "string" ||
      typeof edge["source"] !== "string" ||
      typeof edge["target"] !== "string" ||
      (edge["branch"] !== undefined && typeof edge["branch"] !== "string")
    ) {
      issues.push({
        code: "invalid_shape",
        location: `${location}.edges[${index}]`,
        message: "edgeは{id, source, target, branch?}です",
      });
    }
  });
}

/**
 * 外部境界（HTTP / Studio）から受け取ったJSONをWorkflow Definitionとして構造検証する。
 * 意味的な検証（graph / 参照）は`validateWorkflowDefinition`が行う。
 */
export function parseWorkflowDefinition(
  value: unknown,
): Result.Result<WorkflowDefinition, WorkflowValidationIssue[]> {
  const issues: WorkflowValidationIssue[] = [];
  if (!isPlainRecord(value)) {
    return Result.fail([
      { code: "invalid_shape", location: "$", message: "Workflow Definitionはobjectです" },
    ]);
  }
  if (typeof value["id"] !== "string" || value["id"].length === 0) {
    issues.push({ code: "invalid_shape", location: "id", message: "idが必要です" });
  }
  if (typeof value["name"] !== "string")
    issues.push({ code: "invalid_shape", location: "name", message: "nameが必要です" });
  if (value["variables"] !== undefined && !isPlainRecord(value["variables"])) {
    issues.push({ code: "invalid_shape", location: "variables", message: "variablesはobjectです" });
  }
  if (value["inputFields"] !== undefined && !Array.isArray(value["inputFields"])) {
    issues.push({
      code: "invalid_shape",
      location: "inputFields",
      message: "inputFieldsは配列です",
    });
  }
  checkGraph(value["graph"], "graph", issues, 0);
  return issues.length > 0 ? Result.fail(issues) : Result.succeed(value as WorkflowDefinition);
}
