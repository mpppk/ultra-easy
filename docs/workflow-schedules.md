# Workflow schedules

The approval API Worker evaluates schedules from D1 on its existing every-minute Cron. A schedule
stores a five-field UTC cron expression, one published Composite Action, a fixed resource, the
registering user, and the registering client ID. The API never stores an Auth0 access token.

## Public API

All routes are under `/v1/organizations/{organizationId}` and use the same bearer token and
`write:action-requests` permission as ActionRequest submission. The caller must be a user; an M2M
agent cannot create standing user authority.

| Method | Path                             | Meaning                                                                                                      |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| POST   | `/schedules`                     | Register `{key, cron, action, correlation?}`. Repeating the same key and body returns the existing schedule. |
| GET    | `/schedules`                     | List the caller's schedules.                                                                                 |
| GET    | `/schedules/{scheduleId}`        | Read one owned schedule.                                                                                     |
| POST   | `/schedules/{scheduleId}/stop`   | Revoke future starts and skip pending slots.                                                                 |
| POST   | `/schedules/{scheduleId}/resume` | Start from the next UTC slot after resumption.                                                               |
| GET    | `/schedules/{scheduleId}/slots`  | Read slot status and ActionRequest IDs.                                                                      |

Keys are unique within an organization. Only the registering user can read, stop, or resume a
schedule. At registration, the API validates the published Composite Action, input schema, client
grant, and user's FGA authority. The schedule fixes the action and resource; there is no edit route.

## Dispatch and recovery

The scheduler service principal acts under a delegation from the registering user, restricted to
the action's resource type and ID. Child ActionRequests inherit that restriction. Each slot gets a
deterministic ActionRequest ID. D1 advances the schedule cursor and inserts its slot in one
transaction; a slot lease prevents two Cron invocations from committing at the same time. The
prepared ActionRequest is saved before commit, and recovery resumes it with the same plan and ID.
Authorization and the registering client's current grant are checked again for each slot, and
execution rechecks authorization before effects. Removing the user's FGA relationship denies future
slots. Stopping a schedule skips pending slots; a run
already accepted continues under normal cancellation rules. Resuming never replays skipped slots.
If a previous run for the same schedule is still running or waiting, the new slot is skipped.

`accepted`, `denied`, `failed`, and `skipped` are terminal slot states. Retriable preparation or
commit failures return to `pending`; the next Cron tick retries. The slot history records attempts
and error codes without exposing input or credentials in the history response.
