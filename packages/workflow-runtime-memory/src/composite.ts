import { Result } from "@praha/byethrow";

import type {
  ActionDefinition,
  ActionDefinitionKey,
  ActionDefinitionResolver,
  ActionDefinitionResolverError,
  ActionRequestId,
  ActionType,
  OrganizationId,
  PrincipalRef,
} from "@app/approval-core";
import { WorkflowRepositoryError } from "@app/workflow-application";
import type {
  ActionCatalogPublisher,
  ChildActionCorrelation,
  ChildActionCorrelationRepository,
  EffectHandlerError,
  WorkflowActionBinding,
  WorkflowActionBindingRepository,
} from "@app/workflow-application";
import type { WorkflowDefinitionId, WorkflowRunId } from "@app/workflow-core";

function key(...parts: unknown[]): string {
  return JSON.stringify(parts.map(String));
}

/** insert-onlyのWorkflowActionBinding（同じkey / versionの差し替えを拒否）。 */
export class InMemoryWorkflowActionBindingRepository implements WorkflowActionBindingRepository {
  private readonly bindings = new Map<string, WorkflowActionBinding>();

  async save(binding: WorkflowActionBinding) {
    const id = key(
      binding.organizationId,
      binding.actionDefinitionKey,
      binding.actionDefinitionVersion,
    );
    const existing = this.bindings.get(id);
    if (existing) {
      const same =
        String(existing.workflowDefinitionId) === String(binding.workflowDefinitionId) &&
        existing.workflowVersion === binding.workflowVersion &&
        String(existing.workflowChecksum) === String(binding.workflowChecksum);
      if (!same) {
        return Result.fail(
          new WorkflowRepositoryError(
            "workflow_action_binding_conflict",
            false,
            "ActionDefinition versionのWorkflow bindingは差し替えられません（immutable）",
          ),
        );
      }
      return Result.succeed({ type: "existing" as const });
    }
    this.bindings.set(id, structuredClone(binding));
    return Result.succeed({ type: "created" as const });
  }

  async load(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
    actionDefinitionVersion: number;
  }) {
    const found = this.bindings.get(
      key(input.organizationId, input.actionDefinitionKey, input.actionDefinitionVersion),
    );
    return Result.succeed(found ? structuredClone(found) : null);
  }

  async listForWorkflow(input: {
    organizationId: OrganizationId;
    workflowDefinitionId: WorkflowDefinitionId;
  }) {
    return Result.succeed(
      [...this.bindings.values()]
        .filter(
          (binding) =>
            String(binding.organizationId) === String(input.organizationId) &&
            String(binding.workflowDefinitionId) === String(input.workflowDefinitionId),
        )
        .map((binding) => structuredClone(binding)),
    );
  }

  async list(input: { organizationId: OrganizationId }) {
    return Result.succeed(
      [...this.bindings.values()]
        .filter((binding) => String(binding.organizationId) === String(input.organizationId))
        .map((binding) => structuredClone(binding)),
    );
  }
}

export class InMemoryChildActionCorrelationRepository implements ChildActionCorrelationRepository {
  private readonly correlations = new Map<string, ChildActionCorrelation>();

  async record(correlation: ChildActionCorrelation) {
    const id = key(correlation.organizationId, correlation.childActionRequestId);
    if (!this.correlations.has(id)) this.correlations.set(id, structuredClone(correlation));
    return Result.succeed(undefined);
  }

  async findByChild(input: {
    organizationId: OrganizationId;
    childActionRequestId: ActionRequestId;
  }) {
    const found = this.correlations.get(key(input.organizationId, input.childActionRequestId));
    return Result.succeed(found ? structuredClone(found) : null);
  }

  async listForRun(input: { organizationId: OrganizationId; runId: WorkflowRunId }) {
    return Result.succeed(
      [...this.correlations.values()]
        .filter(
          (correlation) =>
            String(correlation.organizationId) === String(input.organizationId) &&
            String(correlation.runId) === String(input.runId),
        )
        .map((correlation) => structuredClone(correlation)),
    );
  }
}

/**
 * in-memory Action Catalog。primitive ActionとComposite Actionを同じcatalogから解決する
 * （ActionDefinitionResolverはaction typeのlatest versionを返す）。
 */
export class InMemoryActionCatalog implements ActionCatalogPublisher, ActionDefinitionResolver {
  readonly definitions: {
    organizationId: string;
    definition: ActionDefinition;
    publishedBy?: PrincipalRef;
  }[] = [];

  constructor(private readonly organizationId: OrganizationId) {}

  add(definition: ActionDefinition): this {
    this.definitions.push({ organizationId: String(this.organizationId), definition });
    return this;
  }

  async latestVersion(input: {
    organizationId: OrganizationId;
    actionDefinitionKey: ActionDefinitionKey;
  }) {
    const versions = this.definitions
      .filter(
        (entry) =>
          entry.organizationId === String(input.organizationId) &&
          String(entry.definition.key) === String(input.actionDefinitionKey),
      )
      .map((entry) => entry.definition.version);
    return Result.succeed<number | null>(versions.length > 0 ? Math.max(...versions) : null);
  }

  async publish(input: {
    organizationId: OrganizationId;
    definition: ActionDefinition;
    publishedBy: PrincipalRef;
    publishedAt: string;
  }): Result.ResultAsync<void, EffectHandlerError> {
    this.definitions.push({
      organizationId: String(input.organizationId),
      definition: structuredClone(input.definition),
      publishedBy: input.publishedBy,
    });
    return Result.succeed(undefined);
  }

  async resolve(
    actionType: ActionType,
  ): Result.ResultAsync<ActionDefinition | null, ActionDefinitionResolverError> {
    const matches = this.definitions
      .filter(
        (entry) =>
          entry.organizationId === String(this.organizationId) &&
          String(entry.definition.actionType) === String(actionType),
      )
      .map((entry) => entry.definition)
      .sort((left, right) => right.version - left.version);
    return Result.succeed(matches[0] ? structuredClone(matches[0]) : null);
  }
}
