import { describe, expect, it } from "vite-plus/test";

import type { ActionType, ResourceId, ResourceType } from "@app/approval-core";

import { stagingActionRelation } from "./action-relations.ts";

const action = (type: string, resourceType: string, resourceId: string) => ({
  type: type as ActionType,
  resource: { type: resourceType as ResourceType, id: resourceId as ResourceId },
});

describe("stagingActionRelation", () => {
  it("maps ticket.update and relationship updates on authorization_admin:root", () => {
    expect(stagingActionRelation(action("ticket.update", "ticket", "T-1"))).toBe("can_execute");
    expect(
      stagingActionRelation(
        action("authorization.relationship.update", "authorization_admin", "root"),
      ),
    ).toBe("editor");
  });

  it("#195: application relationship update checks knowledge_space owner", () => {
    expect(
      stagingActionRelation(
        action("application.relationship.update", "knowledge_space", "spc-one"),
      ),
    ).toBe("can_manage");
    expect(
      stagingActionRelation(action("application.relationship.update", "ticket", "T-1")),
    ).toBeNull();
  });

  it("fails closed (null) for unknown actions and governed actions on other resources", () => {
    expect(stagingActionRelation(action("ticket.delete", "ticket", "T-1"))).toBeNull();
    expect(
      stagingActionRelation(action("authorization.relationship.update", "ticket", "T-1")),
    ).toBeNull();
    expect(
      stagingActionRelation(
        action("authorization.relationship.update", "authorization_admin", "other"),
      ),
    ).toBeNull();
  });
});
