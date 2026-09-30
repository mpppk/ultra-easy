import { Result } from "@praha/byethrow";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ActionDefinition } from "./action-definition.ts";
import {
  ActionExecutorError,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionExecutor,
} from "./action-execution.ts";
import {
  always,
  and,
  approve,
  definePolicy,
  eq,
  field,
  literal,
  ne,
  none,
  object,
  parallelAny,
  relation,
  rule,
  user,
} from "./builder.ts";
import { brandLiteral } from "./domain/brand.ts";
import type { ActionRequestId, OrganizationId } from "./domain/brand.ts";
import type { AlwaysCondition, Condition } from "./domain/condition.ts";
import type { FlowDefinition } from "./domain/flow.ts";
import type { ApprovalPolicyDefinition } from "./domain/policy.ts";
import type { PrincipalRef } from "./domain/principal.ts";
import type { GovernancePersistenceError } from "./governance.ts";

/**
 * Application-scoped approval policy（#199）。
 *
 * 外部アプリが自分のresource（例: Knowledge space）ごとに、自分のAction（例: publish / archive）の
 * 承認ruleを変える経路。ruleはアプリが宣言した語彙（{@link ApplicationApprovalScheme}）の範囲だけで書け、
 * ultra-easyがApproval Policyへcompileする。変更自体は`application.approval_policy.update`という
 * ActionRequestで、meta-approval（申請者以外のscope owner、または組織管理者）を必ず通る。
 */
export const APPLICATION_APPROVAL_POLICY_ACTION_TYPE = brandLiteral(
  "ActionType",
  "application.approval_policy.update",
);

export const APPLICATION_APPROVAL_POLICY_EXECUTOR_KEY = brandLiteral(
  "ExecutorKey",
  "application-policy",
);

export const APPLICATION_APPROVAL_POLICY_UPDATE_DEFINITION: ActionDefinition = {
  key: brandLiteral("ActionDefinitionKey", "application:approval-policy-update"),
  version: 1,
  actionType: APPLICATION_APPROVAL_POLICY_ACTION_TYPE,
  inputSchema: {
    key: brandLiteral("SchemaKey", "application:approval-policy-update"),
    version: 1,
  },
  executorKey: APPLICATION_APPROVAL_POLICY_EXECUTOR_KEY,
};

/** アプリの語彙で書く1 rule（Knowledgeの`CompiledPolicyRule`と同じ形）。 */
export type ApplicationApprovalRule = {
  key: string;
  actionType: string;
  when: { field: string; equals: string } | { always: true } | { requesterIsNot: string };
  /** schemeの`approvers`のkey。 */
  approvers: string;
};

export type ApplicationApprovalPolicy = { rules: ApplicationApprovalRule[] };

export type ApplicationApprover =
  /** scope resourceへのrelationを持つuser（例: `knowledge_space#owner`）。 */
  | { relation: string }
  /** Action inputのuser ID field（例: `pageOwnerId`。値の正しさはdownstreamが照合する）。 */
  | { inputUser: string };

/** アプリが宣言する承認ruleの語彙（Application Catalogが持つ）。 */
export type ApplicationApprovalScheme = {
  application: string;
  /** ruleを持つresource type（例: `knowledge_space`）。 */
  scopeResourceType: string;
  /**
   * compile先のApproval Policy key / Binding IDのprefix。Actionごとに
   * `<policyKey>:<actionType>` / `<bindingId>:<actionType>` を持つ（条件は評価時に全ruleで
   * 評価されるため、別Actionのinput fieldを参照するruleを同じpolicyに置かない）。
   */
  policyKey: string;
  bindingId: string;
  /** `application.approval_policy.update`自身のmeta-approval policy key / Binding ID。 */
  metaPolicyKey: string;
  metaBindingId: string;
  /** ruleを書けるAction。`conditionFields`は`{field, equals}`に、`principalFields`は
   * `inputUser` approver / `requesterIsNot`に使えるAction inputのfield（どちらも必須input）。 */
  actions: readonly { actionType: string; conditionFields: string[]; principalFields: string[] }[];
  approvers: Readonly<Record<string, ApplicationApprover>>;
  /** `requesterIsNot`の名前 → 比較するAction inputのuser ID field。 */
  requesterIsNot: Readonly<Record<string, string>>;
  /** scopeに固有ruleが無い間に適用する既定rule。 */
  defaultPolicy: ApplicationApprovalPolicy;
  /** policy変更のmeta-approvalを行うscope上のrelation（申請者本人は除く）。 */
  metaApprovalRelation: string;
};

export type ApplicationApprovalPolicyUpdateInput = {
  /** 提案の基になったscope version（0 = 既定rule）。適用時に一致しなければconflict。 */
  baseVersion: number;
  policy: ApplicationApprovalPolicy;
};

export type ApplicationApprovalPolicyIssue = { path: string; message: string };

const RULE_KEY = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_RULES = 20;
const MAX_VALUE_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** policyをschemeの語彙で検証する。未知のkey・Action・field・approverはすべて拒否する。 */
export function validateApplicationApprovalPolicy(
  scheme: ApplicationApprovalScheme,
  value: unknown,
):
  | { type: "valid"; policy: ApplicationApprovalPolicy }
  | { type: "invalid"; issues: ApplicationApprovalPolicyIssue[] } {
  const issues: ApplicationApprovalPolicyIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  if (!isRecord(value) || !Array.isArray(value["rules"]) || Object.keys(value).length !== 1) {
    return { type: "invalid", issues: [{ path: "policy", message: "{ rules: [...] }が必要です" }] };
  }
  const rules = value["rules"] as unknown[];
  if (rules.length > MAX_RULES) issue("policy.rules", `ruleは${MAX_RULES}件までです`);
  const keys = new Set<string>();
  const parsed: ApplicationApprovalRule[] = [];
  rules.forEach((candidate, index) => {
    const path = `policy.rules.${index}`;
    if (!isRecord(candidate)) return issue(path, "ruleはobjectです");
    const unknownKeys = Object.keys(candidate).filter(
      (key) => !["key", "actionType", "when", "approvers"].includes(key),
    );
    if (unknownKeys.length > 0) issue(path, `未知のfieldがあります: ${unknownKeys.join(", ")}`);
    const key = candidate["key"];
    if (typeof key !== "string" || !RULE_KEY.test(key))
      return issue(`${path}.key`, "keyが不正です");
    if (keys.has(key)) issue(`${path}.key`, `keyが重複しています: ${key}`);
    keys.add(key);
    const action = scheme.actions.find((entry) => entry.actionType === candidate["actionType"]);
    if (!action) return issue(`${path}.actionType`, "このAction typeにはruleを書けません");
    const approverName = candidate["approvers"];
    const approver =
      typeof approverName === "string" && Object.hasOwn(scheme.approvers, approverName)
        ? scheme.approvers[approverName]
        : undefined;
    if (!approver || typeof approverName !== "string") {
      return issue(`${path}.approvers`, "未知のapproverです");
    }
    if ("inputUser" in approver && !action.principalFields.includes(approver.inputUser)) {
      return issue(`${path}.approvers`, `${action.actionType}ではこのapproverを使えません`);
    }
    const when = candidate["when"];
    if (!isRecord(when)) return issue(`${path}.when`, "whenが不正です");
    let parsedWhen: ApplicationApprovalRule["when"];
    if (Object.keys(when).length === 1 && when["always"] === true) {
      parsedWhen = { always: true };
    } else if (Object.keys(when).length === 1 && typeof when["requesterIsNot"] === "string") {
      const name = when["requesterIsNot"];
      const inputField = Object.hasOwn(scheme.requesterIsNot, name)
        ? scheme.requesterIsNot[name]
        : undefined;
      if (!inputField || !action.principalFields.includes(inputField)) {
        return issue(`${path}.when`, "未知のrequesterIsNotです");
      }
      parsedWhen = { requesterIsNot: name };
    } else if (
      Object.keys(when).length === 2 &&
      typeof when["field"] === "string" &&
      typeof when["equals"] === "string"
    ) {
      if (!action.conditionFields.includes(when["field"])) {
        return issue(`${path}.when.field`, "このfieldは条件に使えません");
      }
      if (when["equals"].length === 0 || when["equals"].length > MAX_VALUE_LENGTH) {
        return issue(`${path}.when.equals`, "equalsが不正です");
      }
      parsedWhen = { field: when["field"], equals: when["equals"] };
    } else {
      return issue(`${path}.when`, "whenは{field, equals} / {always: true} / {requesterIsNot}です");
    }
    parsed.push({ key, actionType: action.actionType, when: parsedWhen, approvers: approverName });
  });
  return issues.length > 0
    ? { type: "invalid", issues }
    : { type: "valid", policy: { rules: parsed } };
}

export function validateApplicationApprovalPolicyUpdateInput(
  scheme: ApplicationApprovalScheme,
  value: unknown,
):
  | { type: "valid"; input: ApplicationApprovalPolicyUpdateInput }
  | { type: "invalid"; issues: ApplicationApprovalPolicyIssue[] } {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "baseVersion" && key !== "policy")
  ) {
    return {
      type: "invalid",
      issues: [{ path: "", message: "{ baseVersion, policy }が必要です" }],
    };
  }
  const baseVersion = value["baseVersion"];
  if (typeof baseVersion !== "number" || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    return { type: "invalid", issues: [{ path: "baseVersion", message: "0以上の整数です" }] };
  }
  const policy = validateApplicationApprovalPolicy(scheme, value["policy"]);
  return policy.type === "invalid"
    ? policy
    : { type: "valid", input: { baseVersion, policy: policy.policy } };
}

/** policyのruleが属するscheme（ruleが無ければ全schemeに適合するので先頭）。 */
function schemeForInput(
  schemes: readonly ApplicationApprovalScheme[],
  value: unknown,
): ApplicationApprovalScheme | undefined {
  const policy = isRecord(value) ? value["policy"] : undefined;
  const rules = isRecord(policy) && Array.isArray(policy["rules"]) ? policy["rules"] : [];
  const actionType = rules.map((entry) => (isRecord(entry) ? entry["actionType"] : undefined))[0];
  return actionType === undefined
    ? schemes[0]
    : schemes.find((scheme) => scheme.actions.some((action) => action.actionType === actionType));
}

/**
 * `application.approval_policy.update`のinput schema。submit時（meta-approvalの前）に語彙を検証し、
 * 実行時はexecutorがscope resource typeのschemeで再検証する。
 */
export function applicationApprovalPolicyUpdateInputSchema(
  schemes: readonly ApplicationApprovalScheme[],
): StandardSchemaV1<unknown, ApplicationApprovalPolicyUpdateInput> {
  return {
    "~standard": {
      version: 1,
      vendor: "ultra-easy",
      validate(value: unknown) {
        const scheme = schemeForInput(schemes, value);
        if (!scheme) return { issues: [{ message: "このAction typeにはruleを書けません" }] };
        const validated = validateApplicationApprovalPolicyUpdateInput(scheme, value);
        return validated.type === "valid"
          ? { value: validated.input }
          : {
              issues: validated.issues.map((entry) => ({
                message: `${entry.path}: ${entry.message}`,
                ...(entry.path ? { path: entry.path.split(".") } : {}),
              })),
            };
      },
    },
  };
}

function ruleCondition(
  scheme: ApplicationApprovalScheme,
  entry: ApplicationApprovalRule,
): Condition[] {
  const conditions: Condition[] = [];
  if ("field" in entry.when) {
    conditions.push(eq(field(`action.input.${entry.when.field}`), literal(entry.when.equals)));
  } else if ("requesterIsNot" in entry.when) {
    const inputField = scheme.requesterIsNot[entry.when.requesterIsNot] as string;
    conditions.push(ne(field(`action.input.${inputField}`), field("authority.principal.id")));
  }
  return conditions;
}

function ruleFlow(
  scheme: ApplicationApprovalScheme,
  entry: ApplicationApprovalRule,
): FlowDefinition {
  const approver = scheme.approvers[entry.approvers] as ApplicationApprover;
  return approve({
    key: entry.key,
    purpose: "business_approval",
    approver:
      "relation" in approver
        ? relation({
            object: object(scheme.scopeResourceType, field("action.resource.id")),
            relation: approver.relation,
          })
        : user(field(`action.input.${approver.inputUser}`)),
  });
}

function conjunction(conditions: Condition[]): Condition | AlwaysCondition {
  const [first, ...rest] = conditions;
  if (first === undefined) return always();
  return rest.length === 0 ? first : and(first, ...rest);
}

export function applicationApprovalPolicyKey(
  scheme: ApplicationApprovalScheme,
  actionType: string,
): string {
  return `${scheme.policyKey}:${actionType}`;
}

export function applicationApprovalBindingId(
  scheme: ApplicationApprovalScheme,
  actionType: string,
): string {
  return `${scheme.bindingId}:${actionType}`;
}

/**
 * scopeごとのruleと既定ruleを、Actionごとの Approval Policy へcompileする（最初に一致したruleが勝つ）。
 *
 * 固有ruleを持つscopeは、そのruleの後に「このscopeでは承認不要」のruleを置き、既定ruleへ
 * fall throughしないようにする。scopeの判定は`action.resource.id`（認可されたresource）だけで行う。
 * policyはActionごとに分け、各ruleはそのActionの必須inputだけを参照する（Conditionは
 * fail-closedで、存在しないfieldはerrorになる）。
 */
export function compileApplicationApprovalPolicies(
  scheme: ApplicationApprovalScheme,
  scopes: readonly { scopeId: string; policy: ApplicationApprovalPolicy }[],
): { actionType: string; policy: ApprovalPolicyDefinition }[] {
  const sorted = [...scopes].sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  return scheme.actions.map(({ actionType }) => {
    const rules = [];
    for (const scope of sorted) {
      const inScope = eq(field("action.resource.id"), literal(scope.scopeId));
      for (const entry of scope.policy.rules.filter((item) => item.actionType === actionType)) {
        rules.push(
          rule(`scope:${scope.scopeId}:${entry.key}`, {
            when: conjunction([inScope, ...ruleCondition(scheme, entry)]),
            flow: ruleFlow(scheme, entry),
          }),
        );
      }
      rules.push(rule(`scope:${scope.scopeId}:none`, { when: inScope, flow: none() }));
    }
    for (const entry of scheme.defaultPolicy.rules.filter(
      (item) => item.actionType === actionType,
    )) {
      rules.push(
        rule(`default:${entry.key}`, {
          when: conjunction(ruleCondition(scheme, entry)),
          flow: ruleFlow(scheme, entry),
        }),
      );
    }
    rules.push(rule("default:none", { when: always(), flow: none() }));
    return {
      actionType,
      policy: definePolicy({
        key: applicationApprovalPolicyKey(scheme, actionType),
        name: `${scheme.application} approval rules: ${actionType}`,
        description: `Compiled from ${scheme.application} ${scheme.scopeResourceType} approval rules (#199).`,
        rules,
      }),
    };
  });
}

/**
 * policy変更のmeta-approval。申請者以外のscope owner、または組織管理者（console editor）の
 * いずれかが承認する。owner 1人のscopeでも管理者が承認できるので、承認なしには変わらない。
 */
export function applicationApprovalPolicyMetaPolicy(
  scheme: ApplicationApprovalScheme,
): ApprovalPolicyDefinition {
  return definePolicy({
    key: scheme.metaPolicyKey,
    name: `${scheme.application} approval rule changes`,
    description: `Meta-approval of ${scheme.application} approval rule changes (#199).`,
    rules: [
      rule("meta-approval", {
        when: always(),
        flow: parallelAny(
          approve({
            key: "scope_owner",
            purpose: "security_approval",
            approver: relation({
              object: object(scheme.scopeResourceType, field("action.resource.id")),
              relation: scheme.metaApprovalRelation,
            }),
          }),
          approve({
            key: "organization_admin",
            purpose: "security_approval",
            approver: relation({
              object: object("authorization_admin", literal("root")),
              relation: "editor",
            }),
          }),
        ),
      }),
    ],
  });
}

/** 適用済みのscope rule（insert-onlyの履歴。最新versionが現在のrule）。 */
export type ApplicationApprovalPolicyRecord = {
  scopeId: string;
  version: number;
  policy: ApplicationApprovalPolicy;
  approvalPolicyVersion: number;
  sourceActionRequestId: string;
  createdAt: string;
};

export type ApplicationApprovalPolicyScope = {
  organizationId: OrganizationId;
  application: string;
  scopeType: string;
  scopeId: string;
};

export interface ApplicationApprovalPolicyRepository {
  current(
    scope: ApplicationApprovalPolicyScope,
  ): Result.ResultAsync<ApplicationApprovalPolicyRecord | null, GovernancePersistenceError>;
  /** applicationの全scopeの現在のrule。 */
  listCurrent(input: {
    organizationId: OrganizationId;
    application: string;
    scopeType: string;
  }): Result.ResultAsync<ApplicationApprovalPolicyRecord[], GovernancePersistenceError>;
  /** 全keyの最新versionの最大値。1つでも未publishならnull（bootstrap未適用）。 */
  latestApprovalPolicyVersion(input: {
    organizationId: OrganizationId;
    policyKeys: readonly string[];
  }): Result.ResultAsync<number | null, GovernancePersistenceError>;
  /**
   * scope ruleの新しいversionと、compile済みApproval Policy（Actionごと）の新しいversion
   * （`record.approvalPolicyVersion`）を1 transactionで保存する。いずれかのversionが既にあれば
   * 何も保存せず`conflict`を返す。
   */
  apply(input: {
    scope: ApplicationApprovalPolicyScope;
    record: ApplicationApprovalPolicyRecord;
    approvalPolicies: readonly ApprovalPolicyDefinition[];
    actor: PrincipalRef;
  }): Result.ResultAsync<{ type: "applied" } | { type: "conflict" }, GovernancePersistenceError>;
}

const MAX_APPLY_ATTEMPTS = 4;

function fail(code: string, detail: string, retriable = false) {
  return Result.fail(new ActionExecutorError({ code, retriable, detail }));
}

function persistenceFailure(error: GovernancePersistenceError) {
  return Result.fail(
    new ActionExecutorError({
      code: error.code,
      retriable: error.retriable,
      detail: error.message,
      cause: error,
    }),
  );
}

/**
 * meta-approvalとRe-Authorizationの後に、承認されたruleを適用する。
 *
 * - 提案の`baseVersion`が現在のscope versionと一致しなければ`application_policy_conflict`
 *   （後から承認された古い提案で新しいruleを上書きしない）
 * - 同じActionRequestの再実行は、適用済みなら同じ結果を返す（idempotent）
 * - Approval Policyのversionは他scopeの同時更新と競合しうるので、再読込して再compileする
 * - 承認待ちの既存ActionRequestはMaterialized Planに固定されたPolicy versionのまま変わらない
 */
export class ApplicationApprovalPolicyExecutor implements ActionExecutor {
  readonly guaranteeLevel = "idempotent" as const;

  constructor(
    private readonly deps: {
      schemes: readonly ApplicationApprovalScheme[];
      repository: ApplicationApprovalPolicyRepository;
    },
  ) {}

  async execute(
    request: ActionExecutionRequest,
  ): Result.ResultAsync<ActionExecutionResult, ActionExecutorError> {
    if (String(request.action.type) !== String(APPLICATION_APPROVAL_POLICY_ACTION_TYPE)) {
      return fail("unsupported_application_policy_action", "未対応のaction typeです");
    }
    const actor = request.actor;
    if (!actor) return fail("application_policy_actor_missing", "trusted actorが必要です");
    const scheme = this.deps.schemes.find(
      (candidate) => candidate.scopeResourceType === String(request.action.resource.type),
    );
    if (!scheme) return fail("application_policy_scope_unknown", "未登録のscopeです");
    const validated = validateApplicationApprovalPolicyUpdateInput(scheme, request.action.input);
    if (validated.type === "invalid") {
      return fail(
        "invalid_application_policy",
        validated.issues.map((entry) => `${entry.path}: ${entry.message}`).join("; "),
      );
    }
    const scope: ApplicationApprovalPolicyScope = {
      organizationId: request.organizationId,
      application: scheme.application,
      scopeType: scheme.scopeResourceType,
      scopeId: String(request.action.resource.id),
    };
    const actionRequestId: ActionRequestId = request.actionRequestId;

    for (let attempt = 0; attempt < MAX_APPLY_ATTEMPTS; attempt += 1) {
      const current = await this.deps.repository.current(scope);
      if (Result.isFailure(current)) return persistenceFailure(current.error);
      if (current.value?.sourceActionRequestId === String(actionRequestId)) {
        return Result.succeed({
          status: "succeeded",
          output: {
            scopeId: scope.scopeId,
            version: current.value.version,
            approvalPolicyVersion: current.value.approvalPolicyVersion,
          },
        });
      }
      const currentVersion = current.value?.version ?? 0;
      if (currentVersion !== validated.input.baseVersion) {
        return fail(
          "application_policy_conflict",
          `ruleは提案後に変更されています（base ${validated.input.baseVersion}, current ${currentVersion}）`,
        );
      }
      const [others, latest] = await Promise.all([
        this.deps.repository.listCurrent(scope),
        this.deps.repository.latestApprovalPolicyVersion({
          organizationId: scope.organizationId,
          policyKeys: scheme.actions.map((action) =>
            applicationApprovalPolicyKey(scheme, action.actionType),
          ),
        }),
      ]);
      if (Result.isFailure(others)) return persistenceFailure(others.error);
      if (Result.isFailure(latest)) return persistenceFailure(latest.error);
      if (latest.value === null) {
        return fail(
          "application_policy_not_bootstrapped",
          `${scheme.policyKey}がbootstrapされていません`,
        );
      }
      const approvalPolicies = compileApplicationApprovalPolicies(scheme, [
        ...others.value.filter((record) => record.scopeId !== scope.scopeId),
        { scopeId: scope.scopeId, policy: validated.input.policy },
      ]).map((compiled) => compiled.policy);
      const record: ApplicationApprovalPolicyRecord = {
        scopeId: scope.scopeId,
        version: currentVersion + 1,
        policy: validated.input.policy,
        approvalPolicyVersion: latest.value + 1,
        sourceActionRequestId: String(actionRequestId),
        createdAt: request.authorizationEvidence.evaluatedAt,
      };
      const applied = await this.deps.repository.apply({ scope, record, approvalPolicies, actor });
      if (Result.isFailure(applied)) return persistenceFailure(applied.error);
      if (applied.value.type === "applied") {
        return Result.succeed({
          status: "succeeded",
          output: {
            scopeId: scope.scopeId,
            version: record.version,
            approvalPolicyVersion: record.approvalPolicyVersion,
          },
        });
      }
    }
    return fail("application_policy_contention", "他のrule変更と競合しました", true);
  }
}
