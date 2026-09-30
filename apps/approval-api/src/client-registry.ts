import type { PublicApiOperation } from "@app/approval-application";

/** Reviewed application grants. Client IDs are deployment settings, never supplied by callers. */
export type ClientGrant = {
  operations: "*" | readonly PublicApiOperation[];
  actionTypes: "*" | readonly string[];
  resourceTypes: "*" | readonly string[];
};

export type ClientRegistry = ReadonlyMap<string, ClientGrant>;

const FIRST_PARTY: ClientGrant = {
  operations: "*",
  actionTypes: "*",
  resourceTypes: "*",
};

const KNOWLEDGE_USER: ClientGrant = {
  operations: [
    "action_request.read",
    "action_request.submit",
    "approval_decision.submit",
    "principal_directory.read",
    "principal_directory.ensure",
    "application_relationship.read",
    "application_policy.read",
  ],
  actionTypes: [
    "knowledge.*",
    "application.relationship.update",
    "application.approval_policy.update",
  ],
  resourceTypes: ["knowledge_page", "knowledge_space"],
};

const KNOWLEDGE_AGENT: ClientGrant = {
  operations: [
    "action_request.read",
    "action_request.submit",
    "application_relationship.read",
    "application_policy.read",
  ],
  actionTypes: ["knowledge.maintain_space", "application.relationship.update"],
  resourceTypes: ["knowledge_space"],
};

export function readClientRegistry(env: {
  AUTH0_WEB_CLIENT_ID?: string;
  AUTH0_AGENT_CLIENT_ID?: string;
  AUTH0_KNOWLEDGE_CLIENT_ID?: string;
  AUTH0_KNOWLEDGE_AGENT_CLIENT_ID?: string;
}): ClientRegistry {
  const clients = new Map<string, ClientGrant>();
  const register = (id: string | undefined, grant: ClientGrant) => {
    if (id?.trim()) clients.set(id.trim(), grant);
  };
  register(env.AUTH0_WEB_CLIENT_ID, FIRST_PARTY);
  register(env.AUTH0_AGENT_CLIENT_ID, FIRST_PARTY);
  register(env.AUTH0_KNOWLEDGE_CLIENT_ID, KNOWLEDGE_USER);
  register(env.AUTH0_KNOWLEDGE_AGENT_CLIENT_ID, KNOWLEDGE_AGENT);
  return clients;
}

function matches(allowed: "*" | readonly string[], actual: string): boolean {
  return (
    allowed === "*" ||
    allowed.some((pattern) =>
      pattern.endsWith(".*") ? actual.startsWith(pattern.slice(0, -1)) : pattern === actual,
    )
  );
}

export function clientAllows(
  grant: ClientGrant,
  input: { operation: PublicApiOperation; actionType?: string; resourceType?: string },
): boolean {
  return (
    matches(grant.operations, input.operation) &&
    (input.actionType === undefined || matches(grant.actionTypes, input.actionType)) &&
    (input.resourceType === undefined || matches(grant.resourceTypes, input.resourceType))
  );
}
