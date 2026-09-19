import { Result } from "@praha/byethrow";

import {
  McpAdapterError,
  type McpTaskProjectionRecord,
  type McpTaskProjectionRepository,
} from "./adapter.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryMcpTaskProjectionRepository implements McpTaskProjectionRepository {
  private readonly records = new Map<string, McpTaskProjectionRecord>();

  private key(organizationId: string, taskId: string): string {
    return JSON.stringify([organizationId, taskId]);
  }

  save(record: McpTaskProjectionRecord) {
    const key = this.key(String(record.organizationId), record.taskId);
    if (this.records.has(key)) {
      return Promise.resolve(
        Result.fail(
          new McpAdapterError(
            "mcp_task_already_exists",
            false,
            `MCP Task already exists: ${record.taskId}`,
          ),
        ),
      );
    }
    this.records.set(key, clone(record));
    return Promise.resolve(Result.succeed(undefined));
  }

  load(input: { organizationId: McpTaskProjectionRecord["organizationId"]; taskId: string }) {
    const record = this.records.get(this.key(String(input.organizationId), input.taskId));
    return Promise.resolve(Result.succeed(record ? clone(record) : null));
  }
}
