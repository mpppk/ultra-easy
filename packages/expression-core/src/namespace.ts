import type { FieldType } from "./catalog.ts";

/**
 * 1つのbounded contextが式から参照できるfield namespace。
 *
 * - pattern: "."区切りのsegment列。`*`は任意の1 segment（安全な識別子）にmatchする。
 * - match: `prefix`はpattern自身とその配下、`exact`はpattern自身だけを参照できる。
 */
export type FieldNamespace = {
  pattern: string;
  match: "prefix" | "exact";
  label: string;
  description?: string;
  /** 値の型が固定されている場合（例: now = date_time, loop.index = number）。 */
  type?: FieldType;
};

/**
 * 評価器自体はnamespaceを知らず、contextごとのpolicyを注入する。
 * 同じCondition言語でも、Approval / Workflow / Delegationで参照可能な範囲は異なる。
 */
export type FieldNamespacePolicy = {
  context: string;
  namespaces: readonly FieldNamespace[];
};

const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const WILDCARD_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** prototype汚染につながるsegmentか。 */
export function isUnsafeFieldSegment(segment: string): boolean {
  return UNSAFE_SEGMENTS.has(segment);
}

export function hasUnsafeFieldSegment(path: string): boolean {
  return path.split(".").some(isUnsafeFieldSegment);
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === "*") return WILDCARD_SEGMENT.test(segment) && !isUnsafeFieldSegment(segment);
  return pattern === segment;
}

function namespaceMatches(namespace: FieldNamespace, path: string): boolean {
  const patternSegments = namespace.pattern.split(".");
  const pathSegments = path.split(".");
  if (pathSegments.length < patternSegments.length) return false;
  if (namespace.match === "exact" && pathSegments.length !== patternSegments.length) return false;
  return patternSegments.every((pattern, index) =>
    segmentMatches(pattern, pathSegments[index] ?? ""),
  );
}

/** pathを許可するnamespace。許可されなければundefined。 */
export function matchFieldNamespace(
  policy: FieldNamespacePolicy,
  path: string,
): FieldNamespace | undefined {
  return policy.namespaces.find((namespace) => namespaceMatches(namespace, path));
}

export function isFieldPathAllowed(policy: FieldNamespacePolicy, path: string): boolean {
  return matchFieldNamespace(policy, path) !== undefined;
}

/** Approval Policy（Policy Binding selector / Rule condition）の参照範囲。 */
export const APPROVAL_FIELD_NAMESPACES: FieldNamespacePolicy = {
  context: "approval",
  namespaces: [
    { pattern: "action.input", match: "prefix", label: "Action input" },
    { pattern: "actor", match: "prefix", label: "Actor" },
    { pattern: "authority", match: "prefix", label: "Authority" },
    { pattern: "origin", match: "prefix", label: "Origin" },
    { pattern: "organization.settings", match: "prefix", label: "Organization settings" },
    { pattern: "attributes", match: "prefix", label: "Derived attributes" },
    { pattern: "now", match: "exact", label: "評価時刻", type: "date_time" },
  ],
};

/**
 * Workflow Control Flow（Branch / ForEach / While / Transform / Action input）の参照範囲。
 * 外部I/Oの結果は`nodes.<nodeId>.output`として永続化済みの値だけを参照する。
 */
export const WORKFLOW_FIELD_NAMESPACES: FieldNamespacePolicy = {
  context: "workflow",
  namespaces: [
    { pattern: "workflow.input", match: "prefix", label: "Workflow input" },
    { pattern: "variables", match: "prefix", label: "Workflow variables" },
    {
      pattern: "nodes.*.output",
      match: "prefix",
      label: "Node output",
      description: "実行済みNodeの永続化済みoutput",
    },
    { pattern: "loop.item", match: "prefix", label: "Loop item" },
    { pattern: "loop.index", match: "exact", label: "Loop index", type: "number" },
    { pattern: "actor", match: "prefix", label: "Actor" },
    { pattern: "organization.settings", match: "prefix", label: "Organization settings" },
    { pattern: "attributes", match: "prefix", label: "Derived attributes" },
    { pattern: "now", match: "exact", label: "評価時刻", type: "date_time" },
  ],
};

/**
 * Delegation scopeのattribute restrictionの参照範囲。委任が許可するActionそのものと、
 * 要求の出所だけを参照する（Organization設定等で委任範囲を広げられないようにする）。
 */
export const DELEGATION_FIELD_NAMESPACES: FieldNamespacePolicy = {
  context: "delegation",
  namespaces: [
    { pattern: "action.type", match: "exact", label: "Action type", type: "string" },
    { pattern: "action.resource.type", match: "exact", label: "Resource type", type: "string" },
    { pattern: "action.resource.id", match: "exact", label: "Resource ID", type: "string" },
    { pattern: "action.input", match: "prefix", label: "Action input" },
    { pattern: "actor", match: "prefix", label: "Actor" },
    { pattern: "origin", match: "prefix", label: "Origin" },
    { pattern: "now", match: "exact", label: "評価時刻", type: "date_time" },
  ],
};
