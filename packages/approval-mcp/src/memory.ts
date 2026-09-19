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

  save(record: McpTaskProjectionRecord) {
    if (this.records.has(record.taskId)) {
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
    this.records.set(record.taskId, clone(record));
    return Promise.resolve(Result.succeed(undefined));
  }

  load(taskId: string) {
    const record = this.records.get(taskId);
    return Promise.resolve(Result.succeed(record ? clone(record) : null));
  }
}
