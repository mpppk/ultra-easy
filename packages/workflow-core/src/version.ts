import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import { sha256CanonicalJson } from "@app/approval-core";
import type { JsonValue, PrincipalRef, Sha256Digest } from "@app/approval-core";

import type { WorkflowDefinition, WorkflowVersion } from "./definition.ts";
import { validateWorkflowDefinition } from "./validation.ts";
import type { WorkflowValidationIssue } from "./validation.ts";

export class WorkflowPublishError extends ErrorFactory({
  name: "WorkflowPublishError",
  message: ({ detail }) => detail,
  fields: ErrorFactory.fields<{
    code: "workflow_invalid" | "workflow_checksum_failed" | "workflow_version_conflict";
    detail: string;
    issues?: WorkflowValidationIssue[];
  }>(),
}) {}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Workflow Definitionのcanonical JSON checksum（publish済みversionの同一性）。 */
export async function workflowDefinitionChecksum(
  definition: WorkflowDefinition,
): Result.ResultAsync<Sha256Digest, WorkflowPublishError> {
  const digest = await sha256CanonicalJson(definition as unknown as JsonValue);
  if (Result.isFailure(digest)) {
    return Result.fail(
      new WorkflowPublishError({
        code: "workflow_checksum_failed",
        detail: digest.error.message,
      }),
    );
  }
  return Result.succeed(digest.value);
}

/**
 * Definitionを検証し、次のversion番号でimmutableなWorkflow Versionを作る。
 * 既存versionは書き換えない（新しいversionだけを返す）。保存時の一意性・不変性は
 * repositoryがinsert-onlyで保証する。
 */
export async function publishWorkflowVersion(input: {
  definition: WorkflowDefinition;
  latestVersion: number | null;
  publishedAt: string;
  publishedBy: PrincipalRef;
}): Result.ResultAsync<WorkflowVersion, WorkflowPublishError> {
  const validation = validateWorkflowDefinition(input.definition);
  if (!validation.valid) {
    return Result.fail(
      new WorkflowPublishError({
        code: "workflow_invalid",
        detail: `Workflow Definitionが不正です（${validation.issues.length}件）`,
        issues: validation.issues,
      }),
    );
  }
  const snapshot = structuredClone(input.definition);
  const checksum = await workflowDefinitionChecksum(snapshot);
  if (Result.isFailure(checksum)) return checksum;
  return Result.succeed(
    deepFreeze({
      definitionId: snapshot.id,
      version: (input.latestVersion ?? 0) + 1,
      checksum: checksum.value,
      definition: snapshot,
      publishedAt: input.publishedAt,
      publishedBy: structuredClone(input.publishedBy),
    }),
  );
}

/** 保存・転送されたversionが改変されていないことをchecksumで検証する。 */
export async function verifyWorkflowVersion(
  version: WorkflowVersion,
): Result.ResultAsync<WorkflowVersion, WorkflowPublishError> {
  const checksum = await workflowDefinitionChecksum(version.definition);
  if (Result.isFailure(checksum)) return checksum;
  if (String(checksum.value) !== String(version.checksum)) {
    return Result.fail(
      new WorkflowPublishError({
        code: "workflow_version_conflict",
        detail: "Workflow Versionのchecksumがdefinitionと一致しません",
      }),
    );
  }
  return Result.succeed(version);
}
