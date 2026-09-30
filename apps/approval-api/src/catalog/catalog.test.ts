import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Result } from "@praha/byethrow";
import { assert, describe, expect, it } from "vite-plus/test";

import type { ActionType, JsonValue, OrganizationId } from "@app/approval-core";
import { D1McpActionRouteRepository, D1PublishedActionDefinitionResolver } from "@app/approval-d1";
import { migratedSqliteD1 } from "@app/approval-d1/testing";
import { CapabilityBroker, staticCapabilityPolicy } from "@app/workflow-application";
import { DEFAULT_SANDBOX_LIMITS, verifyWorkflowVersion } from "@app/workflow-core";
import {
  D1ProgramRepository,
  D1WorkflowActionBindingRepository,
  D1WorkflowVersionRepository,
} from "@app/workflow-d1";
import { QuickJsSandbox, validateProgramSource } from "@app/workflow-sandbox";
import { nodeQuickJsModule } from "@app/workflow-sandbox/node";

import { KNOWLEDGE_CATALOG } from "./knowledge.ts";
import {
  catalogActionRelation,
  catalogInputSchema,
  planCatalogMigration,
  renderCatalogEntries,
  reservedActionTypeOwner,
  resolvedWorkflow,
  validateCatalog,
  type ApplicationCatalog,
} from "./manifest.ts";
import {
  nextMigrationName,
  pendingCatalogMigration,
  registeredCatalogEntries,
} from "./migrations.ts";

const staging = "organization:staging" as OrganizationId;

describe("Knowledge Application Catalog", () => {
  it("is a valid catalog", () => {
    expect(validateCatalog(KNOWLEDGE_CATALOG)).toEqual([]);
  });

  it("is fully registered by the committed catalog migrations (run generate:catalog)", async () => {
    const pending = await pendingCatalogMigration(KNOWLEDGE_CATALOG);
    assert(Result.isSuccess(pending), Result.isFailure(pending) ? pending.error.message : "");
    expect(pending.value.entries.map((entry) => entry.id)).toEqual([]);
  });

  it("rejects changing an already registered version instead of overwriting it", async () => {
    const changed: ApplicationCatalog = {
      ...KNOWLEDGE_CATALOG,
      primitives: KNOWLEDGE_CATALOG.primitives.map((primitive) =>
        primitive.actionType === "knowledge.revision.publish"
          ? { ...primitive, tool: { ...primitive.tool, name: "knowledge.revision.force_publish" } }
          : primitive,
      ),
    };
    const pending = await pendingCatalogMigration(changed);
    assert(Result.isFailure(pending));
    expect(pending.error.code).toBe("catalog_entry_immutable");
    expect(pending.error.message).toContain("action:knowledge.revision.publish@1");
  });

  it("writes only new versions into the next migration", async () => {
    const entries = await renderCatalogEntries(KNOWLEDGE_CATALOG);
    assert(Result.isSuccess(entries));
    const existing = registeredCatalogEntries();
    existing.delete("action:knowledge.page.archive@1");
    const planned = planCatalogMigration({
      application: "knowledge",
      entries: entries.value,
      existing,
    });
    assert(Result.isSuccess(planned));
    expect(planned.value.entries.map((entry) => entry.id)).toEqual([
      "action:knowledge.page.archive@1",
    ]);
    expect(planned.value.sql).toContain(
      "-- catalog-entry: action:knowledge.page.archive@1 sha256:",
    );

    const directory = mkdtempSync(join(tmpdir(), "catalog-"));
    writeFileSync(join(directory, "0007_example.sql"), "");
    expect(nextMigrationName("knowledge", pathToFileURL(`${directory}/`))).toBe(
      "0008_knowledge_catalog.sql",
    );
  });

  it("keeps every action inside the application's namespace", () => {
    const outside: ApplicationCatalog = {
      ...KNOWLEDGE_CATALOG,
      primitives: [
        ...KNOWLEDGE_CATALOG.primitives,
        {
          ...(KNOWLEDGE_CATALOG.primitives[0] as ApplicationCatalog["primitives"][number]),
          actionType: "ticket.update",
        },
      ],
    };
    expect(validateCatalog(outside).map((issue) => issue.code)).toContain(
      "catalog_action_outside_namespace",
    );
    expect(reservedActionTypeOwner([KNOWLEDGE_CATALOG], "knowledge.anything")).toBe("knowledge");
    expect(reservedActionTypeOwner([KNOWLEDGE_CATALOG], "ticket.update")).toBeNull();
  });

  it("only lets approval rules reference required inputs of the scope's primitives (#199)", () => {
    const section = KNOWLEDGE_CATALOG.approvalPolicy;
    assert(section);
    const optionalField: ApplicationCatalog = {
      ...KNOWLEDGE_CATALOG,
      approvalPolicy: {
        ...section,
        scheme: {
          ...section.scheme,
          actions: [
            {
              actionType: "knowledge.page.archive",
              conditionFields: ["outcome"],
              principalFields: ["pageOwnerId"],
            },
          ],
        },
      },
    };
    expect(validateCatalog(optionalField).map((issue) => issue.code)).toContain(
      "catalog_policy_invalid",
    );
    expect(
      catalogActionRelation([KNOWLEDGE_CATALOG], {
        type: "application.approval_policy.update",
        resourceType: "knowledge_space",
      }),
    ).toBe("can_manage");
  });

  it("declares the authorization relation of every registered action", () => {
    expect(
      catalogActionRelation([KNOWLEDGE_CATALOG], {
        type: "knowledge.page.archive",
        resourceType: "knowledge_space",
      }),
    ).toBe("can_manage");
    expect(
      catalogActionRelation([KNOWLEDGE_CATALOG], {
        type: "knowledge.publish_document",
        resourceType: "knowledge_space",
      }),
    ).toBe("can_edit");
    // An action is authorized only on the resource type it was registered for.
    expect(
      catalogActionRelation([KNOWLEDGE_CATALOG], {
        type: "knowledge.page.archive",
        resourceType: "knowledge_page",
      }),
    ).toBeNull();
  });

  it("validates primitive input against the registered version only", async () => {
    const schema = catalogInputSchema([KNOWLEDGE_CATALOG], {
      key: "catalog:knowledge.revision.publish",
      version: 1,
    });
    const v2 = catalogInputSchema([KNOWLEDGE_CATALOG], {
      key: "catalog:knowledge.revision.publish",
      version: 2,
    });
    assert(v2);
    const withoutOwner = await v2["~standard"].validate({
      publicationSnapshotId: "snap-1",
      visibility: "space",
      sensitivity: "internal",
    });
    expect(withoutOwner.issues?.length).toBeGreaterThan(0);
    assert(schema);
    const ok = await schema["~standard"].validate({
      publicationSnapshotId: "snap-1",
      visibility: "space",
      sensitivity: "internal",
    });
    expect(ok.issues).toBeUndefined();
    const missing = await schema["~standard"].validate({ publicationSnapshotId: "snap-1" });
    expect(missing.issues?.length).toBeGreaterThan(0);
    const extra = await schema["~standard"].validate({
      publicationSnapshotId: "snap-1",
      visibility: "space",
      sensitivity: "internal",
      pageId: "other-page",
    });
    expect(extra.issues?.length).toBeGreaterThan(0);
    expect(
      catalogInputSchema([KNOWLEDGE_CATALOG], {
        key: "catalog:knowledge.revision.publish",
        version: 3,
      }),
    ).toBeNull();
  });

  it("passes the capability review of the organization policy that includes the catalog", async () => {
    const composite = KNOWLEDGE_CATALOG.composites.find(
      (candidate) => candidate.actionType === "knowledge.maintain_space",
    );
    assert(composite);
    const workflow = await resolvedWorkflow(KNOWLEDGE_CATALOG, composite);
    assert(Result.isSuccess(workflow));
    const db = migratedSqliteD1();
    const broker = new CapabilityBroker({
      policies: staticCapabilityPolicy({
        actions: KNOWLEDGE_CATALOG.programs.flatMap(
          (program) => program.requestedCapabilities.actions ?? [],
        ),
        maxEffects: 16,
      }),
      programs: new D1ProgramRepository(db),
    });
    const reviewed = await broker.review({ organizationId: staging, definition: workflow.value });
    assert(Result.isSuccess(reviewed));
    expect(reviewed.value.flatMap((review) => review.issues)).toEqual([]);

    const denied = await new CapabilityBroker({
      policies: staticCapabilityPolicy({ actions: [], maxEffects: 16 }),
      programs: new D1ProgramRepository(db),
    }).review({ organizationId: staging, definition: workflow.value });
    assert(Result.isSuccess(denied));
    expect(denied.value.flatMap((review) => review.issues).length).toBeGreaterThan(0);
  });

  it("installs catalog rows that the runtime repositories load and verify", async () => {
    const db = migratedSqliteD1();
    const resolved = await new D1PublishedActionDefinitionResolver(db, staging).resolve(
      "knowledge.revision.publish" as ActionType,
    );
    assert(Result.isSuccess(resolved) && resolved.value);
    expect(resolved.value.executorKey).toBe("mcp:knowledge");

    const route = await new D1McpActionRouteRepository(db).load({
      organizationId: staging,
      actionDefinitionKey: resolved.value.key,
      actionDefinitionVersion: resolved.value.version,
    });
    assert(Result.isSuccess(route) && route.value);
    expect(route.value.target).toEqual({
      mcpServerId: "knowledge",
      toolName: "knowledge.revision.publish",
    });

    const composite = await new D1PublishedActionDefinitionResolver(db, staging).resolve(
      "knowledge.maintain_space" as ActionType,
    );
    assert(Result.isSuccess(composite) && composite.value);
    const binding = await new D1WorkflowActionBindingRepository(db).load({
      organizationId: staging,
      actionDefinitionKey: composite.value.key,
      actionDefinitionVersion: composite.value.version,
    });
    assert(Result.isSuccess(binding) && binding.value);
    const version = await new D1WorkflowVersionRepository(db).load({
      organizationId: staging,
      definitionId: binding.value.workflowDefinitionId,
      version: binding.value.workflowVersion,
    });
    assert(Result.isSuccess(version) && version.value);
    const verified = await verifyWorkflowVersion(version.value);
    expect(Result.isSuccess(verified)).toBe(true);
    expect(String(version.value.checksum)).toBe(String(binding.value.workflowChecksum));

    const program = await new D1ProgramRepository(db).load({
      organizationId: staging,
      programId: "prog:knowledge-review-page",
      version: 1,
    });
    assert(Result.isSuccess(program) && program.value);
    const node = version.value.definition.graph.nodes
      .flatMap((candidate) => (candidate.type === "for_each" ? candidate.body.nodes : [candidate]))
      .find((candidate) => candidate.type === "program");
    assert(node?.type === "program");
    expect(String(node.program.sourceDigest)).toBe(program.value.sourceDigest);
  });
});

describe("Knowledge review-page Program", () => {
  const program = KNOWLEDGE_CATALOG.programs[0];
  assert(program);
  const sandbox = new QuickJsSandbox(nodeQuickJsModule);
  const input = {
    spaceId: "space-1",
    pageId: "page-1",
    ownerId: "user:owner",
    now: "2026-09-30T00:00:00.000Z",
  };
  const run = async (resume?: { state: JsonValue; effectResult: JsonValue }) => {
    const ran = await sandbox.run({
      source: program.source,
      input,
      ...(resume ? { resume } : {}),
      limits: { ...DEFAULT_SANDBOX_LIMITS, ...program.runtimeProfile },
    });
    assert(Result.isSuccess(ran), Result.isFailure(ran) ? ran.error.message : "");
    return ran.value.result;
  };
  const published = (body: string, lastReviewedAt: string | null = "2026-09-01T00:00:00.000Z") => ({
    type: "completed",
    output: {
      pageId: "page-1",
      ownerId: "user:owner",
      title: "Runbook",
      body,
      publishedAt: "2026-01-01T00:00:00.000Z",
      lastReviewedAt,
    },
  });

  it("passes static validation", () => {
    expect(validateProgramSource(program.source)).toEqual([]);
  });

  it("reads the published revision first", async () => {
    expect(await run()).toEqual({
      type: "yield",
      state: { step: "read" },
      effect: {
        type: "action",
        actionType: "knowledge.page.get_published",
        resource: { type: "knowledge_space", id: "space-1" },
        input: { pageId: "page-1" },
      },
    });
  });

  it("asks the page owner when the page may be stale, then applies the answer", async () => {
    const asked = await run({ state: { step: "read" }, effectResult: published("See TODO", null) });
    assert(asked.type === "yield");
    expect(asked.effect).toMatchObject({
      type: "human_input",
      assignee: { type: "user", id: "user:owner" },
      options: ["still_valid", "update_needed", "archive_candidate"],
      subject: { type: "knowledge_page", id: "page-1", title: "Runbook" },
    });

    const archive = await run({
      state: asked.state,
      effectResult: { type: "completed", output: "archive_candidate" },
    });
    assert(archive.type === "yield");
    expect(archive.effect).toEqual({
      type: "action",
      actionType: "knowledge.page.archive",
      resource: { type: "knowledge_space", id: "space-1" },
      input: { pageId: "page-1", pageOwnerId: "user:owner" },
    });

    const rejected = await run({
      state: archive.state,
      effectResult: { type: "failed", code: "rejected", message: "rejected" },
    });
    expect(rejected).toMatchObject({
      type: "complete",
      output: { pageId: "page-1", decision: "archive_candidate", resolution: "archive_rejected" },
    });
  });

  it("marks a current page reviewed without asking anyone", async () => {
    const applied = await run({ state: { step: "read" }, effectResult: published("All good.") });
    assert(applied.type === "yield");
    expect(applied.effect).toMatchObject({
      actionType: "knowledge.page.mark_reviewed",
      input: { pageId: "page-1", outcome: "reviewed" },
    });
    const done = await run({
      state: applied.state,
      effectResult: { type: "completed", output: { pageId: "page-1" } },
    });
    expect(done).toMatchObject({ type: "complete", output: { resolution: "reviewed" } });
  });

  it("records a failed read instead of guessing", async () => {
    const failed = await run({
      state: { step: "read" },
      effectResult: { type: "failed", code: "authorization_denied", message: "denied" },
    });
    expect(failed).toMatchObject({
      type: "complete",
      output: { pageId: "page-1", resolution: "failed", errorCode: "authorization_denied" },
    });
  });
});
