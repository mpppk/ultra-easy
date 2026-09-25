import type { CompiledPolicy, CompiledPolicyRule } from "../client.ts";

/**
 * Seeded (version-controlled) publication / archive policy used until a space
 * owner changes it through the governed `approval_policy_binding.update` path.
 */
export const DEFAULT_KNOWLEDGE_POLICY: CompiledPolicy = {
  rules: [
    {
      key: "publish_confidential",
      actionType: "knowledge.revision.publish",
      when: { field: "sensitivity", equals: "confidential" },
      approvers: "space_owners",
    },
    {
      key: "publish_organization",
      actionType: "knowledge.revision.publish",
      when: { field: "visibility", equals: "organization" },
      approvers: "space_owners",
    },
    {
      key: "archive",
      actionType: "knowledge.page.archive",
      when: { requesterIsNot: "page_owner" },
      approvers: "page_owner",
    },
  ],
};

/**
 * First matching rule wins (same composition semantics as ultra-easy Policy
 * evaluation). Conditions only read trusted ActionRequest input — never LLM
 * output — so an LLM "looks safe" signal can't skip a mandatory approval.
 */
export function matchRule(input: {
  policy: CompiledPolicy;
  actionType: string;
  actionInput: Record<string, unknown>;
  /** Principal that directly initiated the request (a user, or an agent). */
  actorId: string;
  pageOwnerId: string | null;
}): CompiledPolicyRule | null {
  for (const rule of input.policy.rules) {
    if (rule.actionType !== input.actionType) continue;
    const when = rule.when;
    if ("always" in when) return rule;
    if ("requesterIsNot" in when) {
      if (input.actorId !== input.pageOwnerId) return rule;
      continue;
    }
    if (input.actionInput[when.field] === when.equals) return rule;
  }
  return null;
}
