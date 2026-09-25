import { Result } from "@praha/byethrow";

import type { ActionDefinition, OrganizationId, PrincipalRef } from "@app/approval-core";
import { publishWorkflowVersion } from "@app/workflow-core";
import type {
  WorkflowDefinition,
  WorkflowValidationIssue,
  WorkflowVersion,
} from "@app/workflow-core";

import type { CompositeActionPublisher } from "./composite/lifecycle.ts";
import type { WorkflowActionBinding } from "./composite/ports.ts";
import type { WorkflowDraftRepository, WorkflowVersionRepository } from "./ports.ts";

export class WorkflowPublishingError extends Error {
  override readonly name = "WorkflowPublishingError";

  constructor(
    readonly code: string,
    readonly retriable: boolean,
    message: string,
    readonly issues?: WorkflowValidationIssue[],
  ) {
    super(message);
  }
}

export type WorkflowPublication = {
  version: WorkflowVersion;
  composite?: { definition: ActionDefinition; binding: WorkflowActionBinding };
};

/**
 * Workflow Definitionの保存（draft）とversion publish。publishは検証済みのimmutable snapshotを
 * 次のversionとしてinsert-onlyで保存し、指定があればComposite ActionとしてAction Catalogへ公開する。
 */
export class WorkflowPublishingService {
  constructor(
    private readonly deps: {
      versions: WorkflowVersionRepository;
      drafts: WorkflowDraftRepository;
      composites: CompositeActionPublisher;
    },
  ) {}

  async saveDraft(input: {
    organizationId: OrganizationId;
    definition: WorkflowDefinition;
    expectedRevision: number | null;
    now: string;
  }): Result.ResultAsync<{ revision: number }, WorkflowPublishingError> {
    const saved = await this.deps.drafts.save({
      organizationId: input.organizationId,
      definition: input.definition,
      expectedRevision: input.expectedRevision,
      updatedAt: input.now,
    });
    if (Result.isFailure(saved)) {
      return Result.fail(
        new WorkflowPublishingError(saved.error.code, saved.error.retriable, saved.error.message),
      );
    }
    if (saved.value.type === "conflict") {
      return Result.fail(
        new WorkflowPublishingError(
          "draft_revision_conflict",
          false,
          "draftが別の編集で更新されています",
        ),
      );
    }
    return Result.succeed({ revision: saved.value.revision });
  }

  async publish(input: {
    organizationId: OrganizationId;
    definition: WorkflowDefinition;
    publishedBy: PrincipalRef;
    now: string;
    /** Composite ActionとしてAction Catalogへ公開するaction type。 */
    actionType?: string;
  }): Result.ResultAsync<WorkflowPublication, WorkflowPublishingError> {
    const latest = await this.deps.versions.latest({
      organizationId: input.organizationId,
      definitionId: input.definition.id,
    });
    if (Result.isFailure(latest)) {
      return Result.fail(
        new WorkflowPublishingError(
          latest.error.code,
          latest.error.retriable,
          latest.error.message,
        ),
      );
    }
    const published = await publishWorkflowVersion({
      definition: input.definition,
      latestVersion: latest.value?.version ?? null,
      publishedAt: input.now,
      publishedBy: input.publishedBy,
    });
    if (Result.isFailure(published)) {
      return Result.fail(
        new WorkflowPublishingError(
          published.error.code,
          false,
          published.error.message,
          published.error.issues,
        ),
      );
    }
    const saved = await this.deps.versions.save({
      organizationId: input.organizationId,
      version: published.value,
    });
    if (Result.isFailure(saved)) {
      return Result.fail(
        new WorkflowPublishingError(saved.error.code, saved.error.retriable, saved.error.message),
      );
    }
    if (!input.actionType) return Result.succeed({ version: published.value });
    const composite = await this.deps.composites.publish({
      organizationId: input.organizationId,
      version: published.value,
      actionType: input.actionType,
      publishedBy: input.publishedBy,
      publishedAt: input.now,
    });
    if (Result.isFailure(composite)) {
      return Result.fail(
        new WorkflowPublishingError(
          composite.error.code,
          composite.error.retriable,
          composite.error.message,
        ),
      );
    }
    return Result.succeed({ version: published.value, composite: composite.value });
  }
}
