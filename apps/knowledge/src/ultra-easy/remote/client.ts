import type { Result } from "@praha/byethrow";

import type { UltraEasyClient, UltraEasyError } from "../client.ts";
import { RemoteAuthorizationClient } from "./authorization.ts";
import { RemotePolicyClient } from "./policy.ts";
import { RemoteWorkflowClient } from "./workflow.ts";

export type RemoteUltraEasyOptions = {
  baseUrl: string;
  approvalUiBaseUrl: string;
  organizationId: string;
  /** Bound to the verified session or Auth0 M2M token by the caller. */
  principalId: string;
  accessToken: string;
  agentToken?: () => Result.ResultAsync<string, UltraEasyError>;
  send?: (request: Request) => Promise<Response>;
};

/** The only Knowledge-facing composition of public ultra-easy HTTP adapters. */
export function remoteUltraEasy(options: RemoteUltraEasyOptions): UltraEasyClient {
  const authorization = new RemoteAuthorizationClient(options);
  const workflow = new RemoteWorkflowClient(options);
  const policy = new RemotePolicyClient(options);
  return {
    listPrincipals: (organizationId) => authorization.listPrincipals(organizationId),
    ensurePrincipal: (input) => authorization.ensurePrincipal(input),
    spaceRoles: (input) => authorization.spaceRoles(input),
    spaceMembers: (input) => authorization.spaceMembers(input),
    grantSpaceRole: (input) => authorization.grantSpaceRole(input),
    startAction: (input) => workflow.startAction(input),
    registerMaintenanceSchedule: (input) => workflow.registerMaintenanceSchedule(input),
    cancelAction: (input) => workflow.cancelAction(input),
    getRun: (input) => workflow.getRun(input),
    findRunByActionRequest: (input) => workflow.findRunByActionRequest(input),
    listRuns: (input) => workflow.listRuns(input),
    submitHumanInput: (input) => workflow.submitHumanInput(input),
    getPolicyBinding: (input) => policy.getPolicyBinding(input),
    proposePolicyBinding: (input) => policy.proposePolicyBinding(input),
    approvalUrl: (taskId) => policy.approvalUrl(taskId),
    adminPolicyUrl: (spaceId) => policy.adminPolicyUrl(spaceId),
  };
}
