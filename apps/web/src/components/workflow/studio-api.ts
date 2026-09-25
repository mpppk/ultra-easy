import type {
  ActionTrace,
  ApprovalProjection,
  CapabilityPolicy,
  CapabilityReview,
  ProgramDraft,
  WorkflowAdvanceResult,
} from "@app/workflow-application";
import type {
  ProgramNodeVersion,
  WorkflowAuditEvent,
  WorkflowDefinition,
  WorkflowRunState,
  WorkflowValidationIssue,
  WorkflowVersion,
} from "@app/workflow-core";
import type { FieldCatalogView } from "@app/expression-core";

import { previewFetch } from "#/preview/client.ts";

export type CatalogAction = {
  actionType: string;
  kind: "primitive" | "composite";
  definitionKey: string;
  version: number;
  workflow?: { definitionId: string | null; version?: number };
};

export type StudioCatalog = {
  actions: CatalogAction[];
  fields: { workflow: FieldCatalogView | null; delegation: FieldCatalogView | null };
  capabilityPolicy: CapabilityPolicy;
  llmModel: string;
  llmAvailable: boolean;
};

export type DefinitionSummary = {
  id: string;
  name: string;
  draftRevision: number | null;
  updatedAt: string | null;
  versions: { version: number; checksum: string; publishedAt: string }[];
};

export type DefinitionDetail = {
  draft: { definition: WorkflowDefinition; revision: number; updatedAt: string } | null;
  versions: WorkflowVersion[];
  bindings: { actionType: string; actionDefinitionVersion: number; workflowVersion: number }[];
};

export type ValidationResponse = {
  definition: WorkflowDefinition | null;
  issues: WorkflowValidationIssue[];
  capabilities: CapabilityReview[];
};

export type RunSummary = {
  runId: string;
  definitionId: string;
  version: number;
  status: string;
  depth: number;
  parentActionRequestId: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ChildActionView = {
  actionRequestId: string;
  actionType: string;
  nodeRunId: string;
  effectId: string;
  status: string | null;
  approvalRequired: boolean | null;
  output: unknown;
  code: string | null;
  childRunId: string | null;
};

export type RunView = {
  run: {
    state: WorkflowRunState;
    depth: number;
    invocation: {
      parentAction?: { actionRequestId: string };
      parentRunId?: string;
      actor: { type: string; id: string };
    };
    completionDelivered: boolean;
    wakeAt: string | null;
  };
  definition: WorkflowDefinition | null;
  events: WorkflowAuditEvent[];
  children: ChildActionView[];
};

export type ActionView = {
  actionRequestId: string;
  status: { status: string; approvalRequired?: boolean; output?: unknown; code?: string } | null;
  result: { status: string; code?: string; message?: string; result?: { output?: unknown } } | null;
  approval: {
    status: string;
    tasks: { id: string; status: string; candidateUserIds: string[] }[];
  } | null;
  actor: { type: string; id: string } | null;
  authority: { principal: { type: string; id: string }; delegation?: { chain: unknown[] } } | null;
  action: { type: string; input: unknown } | null;
  runId: string | null;
  trace: ActionTrace | null;
};

export class StudioApiError extends Error {
  override readonly name = "StudioApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await previewFetch(`/api/preview/workflow/${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const record = (parsed ?? {}) as { error?: string; message?: string };
    return Promise.reject(
      new StudioApiError(
        response.status,
        record.error ?? `http_${response.status}`,
        record.message ?? text,
        parsed,
      ),
    );
  }
  return parsed as T;
}

const enc = encodeURIComponent;

export const studioApi = {
  bootstrap: () => call<{ actions: number }>("bootstrap", { method: "POST" }),
  catalog: () => call<StudioCatalog>("catalog"),
  definitions: () => call<{ definitions: DefinitionSummary[] }>("definitions"),
  definition: (id: string) => call<DefinitionDetail>(`definitions/${enc(id)}`),
  validate: (id: string, definition: WorkflowDefinition) =>
    call<ValidationResponse>(`definitions/${enc(id)}/validate`, {
      method: "POST",
      body: { definition },
    }),
  saveDraft: (id: string, definition: WorkflowDefinition, expectedRevision: number | null) =>
    call<{ revision: number; issues: WorkflowValidationIssue[]; capabilities: CapabilityReview[] }>(
      `definitions/${enc(id)}`,
      { method: "PUT", body: { definition, expectedRevision } },
    ),
  publish: (id: string, definition: WorkflowDefinition, actionType?: string) =>
    call<{
      version: WorkflowVersion;
      composite?: { definition: { actionType: string; version: number } };
    }>(`definitions/${enc(id)}/publish`, {
      method: "POST",
      body: { definition, ...(actionType ? { actionType } : {}) },
    }),
  projection: (id: string, input: unknown, version?: number) =>
    call<ApprovalProjection>(`definitions/${enc(id)}/projection`, {
      method: "POST",
      body: { input, ...(version ? { version } : {}) },
    }),
  programs: () => call<{ programs: ProgramNodeVersion[] }>("programs"),
  draftProgram: (input: Record<string, unknown>) =>
    call<ProgramDraft>("programs/draft", { method: "POST", body: input }),
  publishProgram: (draft: ProgramDraft, samples: unknown[]) =>
    call<{
      version: ProgramNodeVersion;
      reference: { programId: string; version: number; sourceDigest: string };
    }>("programs/publish", { method: "POST", body: { draft, samples } }),
  startRun: (actionType: string, input: unknown, resourceId?: string) =>
    call<{ actionRequestId: string; status: string }>("runs", {
      method: "POST",
      body: { actionType, input, ...(resourceId ? { resourceId } : {}) },
    }),
  runs: () => call<{ runs: RunSummary[] }>("runs"),
  run: (runId: string) => call<RunView>(`runs/${enc(runId)}`),
  advance: (runId: string) =>
    call<WorkflowAdvanceResult>(`runs/${enc(runId)}/advance`, { method: "POST" }),
  cancel: (runId: string) =>
    call<WorkflowAdvanceResult>(`runs/${enc(runId)}/cancel`, { method: "POST" }),
  provideInput: (runId: string, effectId: string, value: unknown) =>
    call<WorkflowAdvanceResult>(`runs/${enc(runId)}/effects/${enc(effectId)}/input`, {
      method: "POST",
      body: { value },
    }),
  action: (actionRequestId: string) => call<ActionView>(`actions/${enc(actionRequestId)}`),
  decide: (actionRequestId: string, decision: "approve" | "reject") =>
    call<{ accepted: boolean; userId: string }>(`actions/${enc(actionRequestId)}/decision`, {
      method: "POST",
      body: { decision },
    }),
};
