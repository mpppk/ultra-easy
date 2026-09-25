import { Result } from "@praha/byethrow";

import type { Sensitivity, SpaceRole, Visibility } from "@app/knowledge-core";

import type { KnowledgeRuntime } from "./runtime.ts";

/**
 * Local / demo fixture: principals, spaces, relationships and pages with
 * published history. Runs once when the Knowledge DB has no spaces yet.
 */

export const DEMO_PRINCIPALS = [
  { id: "user:yuki", displayName: "Yuki M." },
  { id: "user:morgan", displayName: "Morgan T." },
  { id: "user:alex", displayName: "Alex K." },
  { id: "user:sam", displayName: "Sam L." },
  { id: "user:hana", displayName: "Hana S." },
  { id: "user:riley", displayName: "Riley P." },
] as const;

type SeedSpace = {
  id: string;
  key: string;
  name: string;
  description: string;
  roles: Record<string, SpaceRole>;
};

const SPACES: SeedSpace[] = [
  {
    id: "spc_engineering",
    key: "engineering",
    name: "Engineering",
    description: "Build systems, infrastructure, architecture, and operational knowledge.",
    roles: {
      "user:yuki": "owner",
      "user:morgan": "owner",
      "user:alex": "editor",
      "user:sam": "viewer",
    },
  },
  {
    id: "spc_product",
    key: "product",
    name: "Product",
    description: "Product strategy, launches, and research.",
    roles: { "user:hana": "owner", "user:yuki": "editor", "user:alex": "viewer" },
  },
  {
    id: "spc_hr",
    key: "hr",
    name: "HR",
    description: "People policies, benefits, and onboarding.",
    roles: { "user:hana": "owner", "user:yuki": "viewer", "user:sam": "viewer" },
  },
  {
    id: "spc_handbook",
    key: "handbook",
    name: "Company Handbook",
    description: "Company-wide guidance and operating norms.",
    roles: { "user:morgan": "owner", "user:yuki": "viewer", "user:hana": "viewer" },
  },
];

type SeedPage = {
  id: string;
  spaceId: string;
  ownerId: string;
  title: string;
  body: string;
  tags: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
  /** null: draft only. */
  publishedDaysAgo: number | null;
  revisions?: number;
  /** Draft edited after publication (unpublished changes). */
  draftBody?: string;
  watchers?: string[];
};

const link = (key: string, id: string, text: string) => `[${text}](/spaces/${key}/pages/${id})`;

const PAGES: SeedPage[] = [
  {
    id: "pg_cf_workers_deploy",
    spaceId: "spc_engineering",
    ownerId: "user:yuki",
    title: "Cloudflare Workers deployment",
    tags: ["Infrastructure", "Deployment"],
    visibility: "organization",
    sensitivity: "internal",
    publishedDaysAgo: 2,
    revisions: 3,
    watchers: ["user:sam", "user:alex"],
    body: `# Deploying to Cloudflare Workers

This guide describes the standard deployment path for production Workers services.

## 1. Prepare the project

Ensure \`Wrangler\` is configured with the correct compatibility date and environment bindings.
Run the test suite before creating a release:

\`\`\`bash
bun run test
\`\`\`

## 2. Deploy to staging

Use the staging environment first. Verify D1 migrations, service bindings, and observability signals before production.

## 3. Promote to production

Production deployment should use the same immutable build artifact and approved configuration.
See ${link("engineering", "pg_workers_architecture", "Workers architecture")} and ${link("engineering", "pg_cicd_standards", "CI/CD standards")}.
`,
  },
  {
    id: "pg_workers_architecture",
    spaceId: "spc_engineering",
    ownerId: "user:morgan",
    title: "Workers architecture",
    tags: ["Infrastructure", "Architecture"],
    visibility: "organization",
    sensitivity: "internal",
    publishedDaysAgo: 12,
    body: `# Workers architecture

Our edge services run on Cloudflare Workers with D1 for relational data and service bindings between workers.
Deployments follow ${link("engineering", "pg_cf_workers_deploy", "Cloudflare Workers deployment")}.
`,
  },
  {
    id: "pg_cicd_standards",
    spaceId: "spc_engineering",
    ownerId: "user:alex",
    title: "CI/CD standards",
    tags: ["Deployment"],
    visibility: "space",
    sensitivity: "internal",
    publishedDaysAgo: 20,
    body: `# CI/CD standards

Every change runs lint, type check and tests in CI. Deploys happen from main only, after checks pass.
`,
  },
  {
    id: "pg_secrets_management",
    spaceId: "spc_engineering",
    ownerId: "user:morgan",
    title: "Secrets management",
    tags: ["Security", "Infrastructure"],
    visibility: "space",
    sensitivity: "confidential",
    publishedDaysAgo: 30,
    body: `# Secrets management

Secrets live in the team vault and are injected with \`wrangler secret put\`. Never commit plaintext secrets.
`,
  },
  {
    id: "pg_api_auth_guide",
    spaceId: "spc_engineering",
    ownerId: "user:yuki",
    title: "API authentication guide",
    tags: ["Security"],
    visibility: "space",
    sensitivity: "internal",
    publishedDaysAgo: 200,
    body: `# API authentication guide

Guidelines and requirements for securely authenticating internal services and provisioning staging keys.
TODO: document the 2023 key rotation flow.
`,
  },
  {
    id: "pg_service_ownership",
    spaceId: "spc_engineering",
    ownerId: "user:yuki",
    title: "Service ownership model",
    tags: ["Operations"],
    visibility: "space",
    sensitivity: "internal",
    publishedDaysAgo: 5,
    body: `# Service ownership model

Core runbook detailing operational responsibilities and deployment targets.
`,
    draftBody: `# Service ownership model

Core runbook detailing operational responsibilities, deployment targets, and emergency pager duty rosters.
`,
  },
  {
    id: "pg_incident_runbook",
    spaceId: "spc_engineering",
    ownerId: "user:morgan",
    title: "Incident response runbook",
    tags: ["Reliability", "Operations"],
    visibility: "space",
    sensitivity: "normal",
    publishedDaysAgo: 100,
    body: `# Incident response runbook

Declare an incident, page the on-call engineer, and keep a timeline in the incident channel.
`,
  },
  {
    id: "pg_legacy_deploy_scripts",
    spaceId: "spc_engineering",
    ownerId: "user:yuki",
    title: "Legacy deploy scripts",
    tags: ["Deployment"],
    visibility: "space",
    sensitivity: "internal",
    publishedDaysAgo: 120,
    body: `# Legacy deploy scripts

These shell scripts are deprecated and no longer used since the move to Workers.
`,
  },
  {
    id: "pg_onboarding_checklist",
    spaceId: "spc_engineering",
    ownerId: "user:alex",
    title: "Onboarding checklist",
    tags: ["Onboarding"],
    visibility: "organization",
    sensitivity: "normal",
    publishedDaysAgo: 8,
    body: `# Onboarding checklist

1. Get repository access.
2. Read ${link("engineering", "pg_cf_workers_deploy", "Cloudflare Workers deployment")}.
`,
  },
  {
    id: "pg_edge_caching",
    spaceId: "spc_engineering",
    ownerId: "user:alex",
    title: "Edge caching strategy",
    tags: ["Infrastructure"],
    visibility: "space",
    sensitivity: "internal",
    publishedDaysAgo: null,
    body: `# Edge caching strategy

Draft: cache deploy artifacts at the edge with a stale-while-revalidate policy.
`,
  },
  {
    id: "pg_launch_checklist",
    spaceId: "spc_product",
    ownerId: "user:hana",
    title: "Product launch checklist",
    tags: ["Launch"],
    visibility: "organization",
    sensitivity: "normal",
    publishedDaysAgo: 1,
    body: `# Product launch checklist

Confirm pricing, docs, support readiness and the rollout plan before launch day.
`,
  },
  {
    id: "pg_benefits_2027",
    spaceId: "spc_hr",
    ownerId: "user:hana",
    title: "2027 Benefits guide",
    tags: ["Benefits"],
    visibility: "organization",
    sensitivity: "normal",
    publishedDaysAgo: 0,
    body: `# 2027 Benefits guide

Everything about health plans, dental, vision, and wellness programs for 2027.
`,
  },
  {
    id: "pg_benefits_enrollment",
    spaceId: "spc_hr",
    ownerId: "user:hana",
    title: "Benefits enrollment checklist",
    tags: ["Benefits"],
    visibility: "organization",
    sensitivity: "normal",
    publishedDaysAgo: 3,
    body: `# Benefits enrollment checklist

Comprehensive guide for 2027 health plans, including dental, vision, and wellness program deployment timelines.
`,
  },
  {
    id: "pg_compensation_bands",
    spaceId: "spc_hr",
    ownerId: "user:hana",
    title: "Compensation bands",
    tags: ["Compensation"],
    visibility: "private",
    sensitivity: "confidential",
    publishedDaysAgo: 10,
    body: `# Compensation bands

Confidential salary bands per level.
`,
  },
  {
    id: "pg_code_of_conduct",
    spaceId: "spc_handbook",
    ownerId: "user:morgan",
    title: "Code of conduct",
    tags: ["Policy"],
    visibility: "organization",
    sensitivity: "normal",
    publishedDaysAgo: 40,
    body: `# Code of conduct

Be respectful, assume good intent, and escalate concerns to People Operations.
`,
  },
];

function daysAgo(now: string, days: number, offsetMinutes = 0): string {
  return new Date(
    Date.parse(now) - days * 24 * 60 * 60 * 1000 - offsetMinutes * 60 * 1000,
  ).toISOString();
}

type SeedError = { message: string };

async function step<T, E extends SeedError>(
  result: Result.ResultAsync<T, E>,
): Result.ResultAsync<T, SeedError> {
  const resolved = await result;
  return Result.isFailure(resolved) ? Result.fail({ message: resolved.error.message }) : resolved;
}

export async function ensureDemoSeed(
  runtime: KnowledgeRuntime,
): Result.ResultAsync<boolean, SeedError> {
  const count = await step(runtime.repos.spaces.count(runtime.organizationId));
  if (Result.isFailure(count)) return count;
  if (count.value > 0) return Result.succeed(false);

  const now = runtime.now();
  const org = runtime.organizationId;
  const platform = await Result.try({
    try: async () => {
      for (const principal of DEMO_PRINCIPALS)
        await runtime.ultraEasy.upsertPrincipal(org, principal);
    },
    catch: (error): SeedError => ({
      message: error instanceof Error ? error.message : "seed failed",
    }),
  });
  if (Result.isFailure(platform)) return platform;

  for (const space of SPACES) {
    const created = await step(
      runtime.repos.spaces.create({
        id: space.id,
        organizationId: org,
        key: space.key,
        name: space.name,
        description: space.description,
        createdBy: "user:yuki",
        createdAt: daysAgo(now, 400),
      }),
    );
    // A concurrent first request may have seeded already.
    if (Result.isFailure(created)) return Result.succeed(false);
    for (const [principalId, role] of Object.entries(space.roles)) {
      const granted = await step(
        runtime.ultraEasy.grantSpaceRole({
          organizationId: org,
          principalId,
          spaceId: space.id,
          role,
        }),
      );
      if (Result.isFailure(granted)) return granted;
    }
  }

  for (const page of PAGES) {
    const seeded = await seedPage(runtime, page, now);
    if (Result.isFailure(seeded)) return seeded;
  }
  return Result.succeed(true);
}

async function seedPage(
  runtime: KnowledgeRuntime,
  page: SeedPage,
  now: string,
): Result.ResultAsync<void, SeedError> {
  const { repos } = runtime;
  const created = daysAgo(now, (page.publishedDaysAgo ?? 1) + 30);
  const createdPage = await step(
    repos.pages.create(
      {
        id: page.id,
        spaceId: page.spaceId,
        ownerId: page.ownerId,
        status: "active",
        lifecycleVersion: 0,
        publishedRevisionId: null,
        publishedSnapshotId: null,
        publishedVisibility: null,
        publishedSensitivity: null,
        publishedAt: null,
        publishedBy: null,
        reviewState: "current",
        lastReviewedAt: null,
        createdAt: created,
        updatedAt: created,
      },
      {
        pageId: page.id,
        title: page.title,
        body: page.body,
        tags: page.tags,
        visibility: page.visibility,
        sensitivity: page.sensitivity,
        version: 0,
        updatedBy: page.ownerId,
        updatedAt:
          page.publishedDaysAgo === null
            ? daysAgo(now, 0, 30)
            : daysAgo(now, page.publishedDaysAgo),
      },
    ),
  );
  if (Result.isFailure(createdPage)) return createdPage;
  if (page.publishedDaysAgo === null) return Result.succeed(undefined);

  const total = page.revisions ?? 1;
  for (let number = 1; number <= total; number += 1) {
    const at = daysAgo(now, page.publishedDaysAgo + (total - number) * 7);
    const current = await step(repos.pages.find(page.id));
    if (Result.isFailure(current)) return current;
    const body =
      number === total ? page.body : `${page.body}\n\n_Revision ${number} draft notes._\n`;
    const revisionId = `rev_${page.id.slice(3)}_${number}`;
    const snapshotId = `pub_${page.id.slice(3)}_${number}`;
    const written = await step(
      repos.revisions.insertPublication({
        revision: {
          id: revisionId,
          pageId: page.id,
          number,
          title: page.title,
          body,
          tags: page.tags,
          createdBy: page.ownerId,
          createdAt: at,
        },
        snapshot: {
          id: snapshotId,
          pageId: page.id,
          revisionId,
          revisionNumber: number,
          spaceId: page.spaceId,
          visibility: page.visibility,
          sensitivity: page.sensitivity,
          expectedLifecycleVersion: current.value?.lifecycleVersion ?? 0,
          createdBy: page.ownerId,
          createdAt: at,
        },
      }),
    );
    if (Result.isFailure(written)) return written;
    const committed = await step(repos.publications.commitPublish({ snapshotId, now: at }));
    if (Result.isFailure(committed)) return committed;
    for (const effect of ["search_reindex", "watcher_notification"] as const) {
      const recorded = await step(
        repos.effects.record({ snapshotId, effect, status: "succeeded", errorCode: null, now: at }),
      );
      if (Result.isFailure(recorded)) return recorded;
    }
  }
  const indexed = await step(repos.search.reindexPublished(page.id));
  if (Result.isFailure(indexed)) return indexed;

  for (const watcher of page.watchers ?? []) {
    const watched = await step(
      repos.pages.setWatching({ pageId: page.id, principalId: watcher, watching: true, now }),
    );
    if (Result.isFailure(watched)) return watched;
  }
  if (page.draftBody) {
    const saved = await step(
      repos.pages.saveDraft({
        pageId: page.id,
        principalId: page.ownerId,
        now: daysAgo(now, 0, 60),
        draft: {
          title: page.title,
          body: page.draftBody,
          tags: page.tags,
          visibility: page.visibility,
          sensitivity: page.sensitivity,
          expectedVersion: 0,
        },
      }),
    );
    if (Result.isFailure(saved)) return saved;
  }
  return Result.succeed(undefined);
}
