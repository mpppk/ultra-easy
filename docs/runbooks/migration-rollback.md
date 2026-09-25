# D1 migration, rollback, backup and restore

Issue: #58

Ultra Easy uses forward-only D1 migrations. Production rollback is a database restore to a verified pre-migration point; it is not a handwritten down migration.

## Before migration

1. Record the application revision and ordered migration files.
2. Create/record a D1 recovery point using the deployment environment's supported backup/Time Travel mechanism.
3. Verify that the recovery point belongs to the intended database/environment.
4. Run the repository migration-recovery test and the M6 critical-path suite on the release candidate.
5. Quiesce or otherwise account for writes if the migration cannot safely run concurrently.

## Deploy order and compatibility (#100)

Every deploy runs **migrate → deploy** (`deploy:staging`, `deploy:production`,
`deploy:preview`): the schema moves first, then the code. A failed migration stops the deploy
before any new code runs, and the new revision never runs against an older schema.

Because the currently running revision keeps serving traffic between the two steps, every
migration must be **backward compatible with the previous revision (expand / contract)**:

- **Expand** (safe in one release): add tables, add nullable columns or columns with defaults,
  add indexes, add triggers that do not reject writes the old revision performs.
- **Contract** (needs two releases): drop / rename columns or tables, add `NOT NULL` without a
  default, tighten constraints. First ship code that no longer depends on the old shape
  (release N), then ship the contracting migration (release N+1).
- Data backfills run as their own idempotent migration after the expanding one.
- Review checklist for a migration PR: "Would the revision currently in production still work
  after this migration runs?" If not, split it.

First deploy of a brand-new environment: D1 is auto-provisioned by `wrangler deploy`, so the
database does not exist before it. Use the one-time `bootstrap:<env>` script
(deploy → migrate) exactly once, then the regular migrate → deploy scripts.

## Forward migration

Apply `packages/approval-d1/migrations` in lexical order using the deployment pipeline. After application:

- verify expected schema objects exist;
- deploy the compatible application revision;
- run the critical-path acceptance suite;
- verify ActionRequest creation, approval, audit, outbox and force-cancel smoke paths.

Do not apply a later application revision against an unverified older schema.

## Rollback trigger

Rollback when a migration causes data corruption risk, prevents critical request processing, or cannot be made compatible by a safe forward fix within the incident window.

## Restore procedure

1. Stop or gate writes that would be lost by restoration.
2. Capture the current failed-state database for forensic analysis.
3. Restore the verified pre-migration recovery point into the target environment according to the D1 operational mechanism in use.
4. Deploy the application revision that matches the restored schema.
5. Verify organization-scoped reads, append-only audit continuity, and a representative ActionRequest.
6. Reconcile any external side effects that occurred after the recovery point before reopening traffic.

Never copy rows between tenants during recovery.

## Validation in CI

`packages/approval-d1/src/operational-recovery.integration.test.ts` proves two invariants locally:

- every checked-in forward migration applies to an empty SQLite/D1-compatible database;
- a pre-change database copy can restore append-only force-cancel audit data after a destructive schema change.

This does not replace a staging D1 restore drill. A staging drill should record the recovery-point identifier, release revision, operator, timestamps and verification results.
