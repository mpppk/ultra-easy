import type {
  ActionRequestView,
  AuthorizationExplainResult,
  AuthorizationModelView,
  RelationshipAuditView,
  RelationshipMutationView,
  RelationshipView,
} from "@app/approval-application";
import type { ManagedRelationshipCatalog, PrincipalRef } from "@app/approval-core";

export type {
  ActionRequestView,
  AuthorizationExplainResult,
  AuthorizationModelView,
  RelationshipAuditView,
  RelationshipMutationView,
  RelationshipView,
};

export type ConsoleSession = {
  organizationId: string;
  principal: PrincipalRef;
  permissions: { viewer: boolean; editor: boolean };
  provider: { apiHost: string; storeId: string; authorizationModelId: string } | null;
};

export type ConsoleCatalog = {
  managedRelationships: ManagedRelationshipCatalog;
  simulationOverrides: string[];
  actionTypes: Array<{ actionType: string; executorKey: string; schemaKey: string }>;
  syncStatuses: string[];
  auditEventTypes: string[];
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type RelationshipDetail = {
  relationship: RelationshipView;
  mutations: RelationshipMutationView[];
  provider: { observedState: "present" | "absent" | null; error: string | null } | null;
};

/** Problem Details surfaced to the UI by stable code (never raw provider text). */
export class ConsoleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const CONSOLE_HEADERS = { "x-ue-console": "1" } as const;

async function parse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | (T & { code?: string; title?: string })
    | null;
  if (!response.ok) {
    return Promise.reject(
      new ConsoleApiError(
        response.status,
        typeof body?.code === "string" ? body.code : `http_${response.status}`,
        typeof body?.title === "string" ? body.title : `HTTP ${response.status}`,
      ),
    );
  }
  return body as T;
}

export function consoleGet<T>(path: string, params?: Record<string, string | undefined>) {
  const query = new URLSearchParams(
    Object.entries(params ?? {}).filter((entry): entry is [string, string] => !!entry[1]),
  ).toString();
  return fetch(`${path}${query ? `?${query}` : ""}`, { credentials: "same-origin" }).then((r) =>
    parse<T>(r),
  );
}

export function consolePost<T>(path: string, body: unknown, headers?: Record<string, string>) {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...CONSOLE_HEADERS, ...headers },
    body: JSON.stringify(body),
  }).then((r) => parse<T>(r));
}

export const adminPath = (path: string) => `/api/admin/authorization${path}`;
