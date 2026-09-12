import { Result } from "@praha/byethrow";
import { ErrorFactory } from "@praha/error-factory";

import type {
  ApprovalTaskId,
  MaterializedStepId,
  OrganizationId,
  UserId,
} from "./domain/brand.ts";
import type {
  MaterializedApprovalStep,
  ResolvedApproverTarget,
} from "./materialization.ts";
import type { AuthorizationConsistency } from "./authorization.ts";

export type ApproverCandidateList = {
  userIds: UserId[];
  complete: boolean;
  sourceRevision?: string;
};

const ApproverResolverProviderErrorBase = ErrorFactory({
  name: "ApproverResolverProviderError",
  message: ({ provider, detail }) => `${provider}による承認者解決に失敗しました: ${detail}`,
  fields: ErrorFactory.fields<{
    provider: string;
    code: string;
    retriable: boolean;
    detail: string;
  }>(),
});

export class ApproverResolverProviderError extends ApproverResolverProviderErrorBase {
  constructor(options: {
    provider: string;
    code: string;
    retriable: boolean;
    detail: string;
    cause?: Error;
  }) {
    super({
      provider: options.provider,
      code: options.code,
      retriable: options.retriable,
      detail: options.detail,
      ...(options.cause ? { cause: options.cause } : {}),
    });
  }
}

export interface ApproverResolver {
  check(input: {
    target: ResolvedApproverTarget;
    userId: UserId;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<boolean, ApproverResolverProviderError>;

  list(input: {
    target: ResolvedApproverTarget;
    context?: Record<string, unknown>;
    consistency: AuthorizationConsistency;
  }): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError>;
}

export class NoApproverCandidatesError extends ErrorFactory({
  name: "NoApproverCandidatesError",
  message: "Approval Stepの承認候補者を1人も解決できませんでした。",
  fields: ErrorFactory.fields<{
    code: "no_approver_candidates";
    materializedStepId: MaterializedStepId;
  }>(),
}) {}

export class IncompleteApproverCandidatesError extends ErrorFactory({
  name: "IncompleteApproverCandidatesError",
  message: "Approval Stepに必要な完全な承認候補集合を解決できませんでした。",
  fields: ErrorFactory.fields<{
    code: "incomplete_approver_candidates";
    materializedStepId: MaterializedStepId;
  }>(),
}) {}

export class ApproverQuorumUnreachableError extends ErrorFactory({
  name: "ApproverQuorumUnreachableError",
  message: "Approval Stepのquorumを満たす候補者数がありません。",
  fields: ErrorFactory.fields<{
    code: "approver_quorum_unreachable";
    materializedStepId: MaterializedStepId;
    quorum: number;
    candidateCount: number;
  }>(),
}) {}

export type ApproverResolutionError =
  | ApproverResolverProviderError
  | NoApproverCandidatesError
  | IncompleteApproverCandidatesError
  | ApproverQuorumUnreachableError;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCandidateList(list: ApproverCandidateList): ApproverCandidateList {
  const userIds = [...new Map(list.userIds.map((userId) => [String(userId), userId])).values()].sort(
    (left, right) => compareStrings(String(left), String(right)),
  );
  return { ...list, userIds };
}

export async function checkApproverTarget(input: {
  resolver: ApproverResolver;
  target: ResolvedApproverTarget;
  userId: UserId;
  context?: Record<string, unknown>;
  consistency: AuthorizationConsistency;
}): Result.ResultAsync<boolean, ApproverResolverProviderError> {
  if (input.target.type === "user") {
    return Result.succeed(String(input.target.userId) === String(input.userId));
  }
  return input.resolver.check(input);
}

export async function listApproverTarget(input: {
  resolver: ApproverResolver;
  target: ResolvedApproverTarget;
  context?: Record<string, unknown>;
  consistency: AuthorizationConsistency;
}): Result.ResultAsync<ApproverCandidateList, ApproverResolverProviderError> {
  if (input.target.type === "user") {
    return Result.succeed({ userIds: [input.target.userId], complete: true });
  }
  const listed = await input.resolver.list(input);
  return Result.isFailure(listed) ? listed : Result.succeed(normalizeCandidateList(listed.value));
}

export type ResolvedApproverCandidates = ApproverCandidateList & {
  target: ResolvedApproverTarget;
  usedFallback: boolean;
};

function requiresCompleteCandidateSet(step: MaterializedApprovalStep): boolean {
  if (step.resolution === "snapshot") return true;
  return step.candidateCompletion === "all" || typeof step.candidateCompletion === "object";
}

async function listPrimaryOrFallback(input: {
  resolver: ApproverResolver;
  step: MaterializedApprovalStep;
  context?: Record<string, unknown>;
  consistency: AuthorizationConsistency;
}): Result.ResultAsync<ResolvedApproverCandidates, ApproverResolverProviderError> {
  const primary = await listApproverTarget({
    resolver: input.resolver,
    target: input.step.target,
    context: input.context,
    consistency: input.consistency,
  });
  if (Result.isFailure(primary)) return primary;
  if (primary.value.userIds.length > 0 || input.step.onUnresolved?.type !== "fallback") {
    return Result.succeed({ ...primary.value, target: input.step.target, usedFallback: false });
  }

  const fallback = await listApproverTarget({
    resolver: input.resolver,
    target: input.step.onUnresolved.target,
    context: input.context,
    consistency: input.consistency,
  });
  return Result.isFailure(fallback)
    ? fallback
    : Result.succeed({
        ...fallback.value,
        target: input.step.onUnresolved.target,
        usedFallback: true,
      });
}

/**
 * Step activation時のcandidate集合を解決する。0候補・必要な完全性不足はfail closed。
 */
export async function resolveApproverCandidates(input: {
  resolver: ApproverResolver;
  step: MaterializedApprovalStep;
  context?: Record<string, unknown>;
  consistency?: AuthorizationConsistency;
}): Result.ResultAsync<ResolvedApproverCandidates, ApproverResolutionError> {
  const listed = await listPrimaryOrFallback({
    resolver: input.resolver,
    step: input.step,
    context: input.context,
    consistency: input.consistency ?? "minimize_latency",
  });
  if (Result.isFailure(listed)) return listed;

  if (listed.value.userIds.length === 0) {
    return Result.fail(
      new NoApproverCandidatesError({
        code: "no_approver_candidates",
        materializedStepId: input.step.materializedStepId,
      }),
    );
  }

  if (requiresCompleteCandidateSet(input.step) && !listed.value.complete) {
    return Result.fail(
      new IncompleteApproverCandidatesError({
        code: "incomplete_approver_candidates",
        materializedStepId: input.step.materializedStepId,
      }),
    );
  }

  if (
    typeof input.step.candidateCompletion === "object" &&
    listed.value.complete &&
    listed.value.userIds.length < input.step.candidateCompletion.count
  ) {
    return Result.fail(
      new ApproverQuorumUnreachableError({
        code: "approver_quorum_unreachable",
        materializedStepId: input.step.materializedStepId,
        quorum: input.step.candidateCompletion.count,
        candidateCount: listed.value.userIds.length,
      }),
    );
  }

  return Result.succeed(listed.value);
}

/** Decision受理直前のcandidate判定は常にhigher consistencyで再Checkする。 */
export function checkApprovalDecisionCandidate(input: {
  resolver: ApproverResolver;
  target: ResolvedApproverTarget;
  userId: UserId;
  context?: Record<string, unknown>;
}): Result.ResultAsync<boolean, ApproverResolverProviderError> {
  return checkApproverTarget({ ...input, consistency: "higher_consistency" });
}

export type ApprovalTaskCandidateProjection = {
  organizationId: OrganizationId;
  approvalTaskId: ApprovalTaskId;
  materializedStepId: MaterializedStepId;
  candidateUserIds: UserId[];
  complete: boolean;
  resolvedAt: string;
  sourceRevision?: string;
};

export class ApproverCandidateProjectionRepositoryError extends ErrorFactory({
  name: "ApproverCandidateProjectionRepositoryError",
  message: ({ detail }) => `承認候補projectionの永続化に失敗しました: ${detail}`,
  fields: ErrorFactory.fields<{
    code: "candidate_projection_repository_error";
    detail: string;
  }>(),
}) {}

export interface ApproverCandidateProjectionRepository {
  replace(
    projection: ApprovalTaskCandidateProjection,
  ): Result.ResultAsync<void, ApproverCandidateProjectionRepositoryError>;
  load(input: {
    organizationId: OrganizationId;
    approvalTaskId: ApprovalTaskId;
  }): Result.ResultAsync<ApprovalTaskCandidateProjection | null, ApproverCandidateProjectionRepositoryError>;
}

/**
 * Inbox検索用projection。正本ではないためincompleteでも保存し、Decision時には必ず再Checkする。
 */
export async function refreshApproverCandidateProjection(input: {
  resolver: ApproverResolver;
  repository: ApproverCandidateProjectionRepository;
  organizationId: OrganizationId;
  approvalTaskId: ApprovalTaskId;
  step: MaterializedApprovalStep;
  resolvedAt: string;
  context?: Record<string, unknown>;
}): Result.ResultAsync<ApprovalTaskCandidateProjection, ApproverResolverProviderError | ApproverCandidateProjectionRepositoryError> {
  const listed = await listApproverTarget({
    resolver: input.resolver,
    target: input.step.target,
    context: input.context,
    consistency: "minimize_latency",
  });
  if (Result.isFailure(listed)) return listed;

  const projection: ApprovalTaskCandidateProjection = {
    organizationId: input.organizationId,
    approvalTaskId: input.approvalTaskId,
    materializedStepId: input.step.materializedStepId,
    candidateUserIds: listed.value.userIds,
    complete: listed.value.complete,
    resolvedAt: input.resolvedAt,
    ...(listed.value.sourceRevision ? { sourceRevision: listed.value.sourceRevision } : {}),
  };
  const saved = await input.repository.replace(projection);
  return Result.isFailure(saved) ? saved : Result.succeed(projection);
}
