import type { Sensitivity, SpaceRole, Visibility } from "@app/knowledge-core";

/**
 * JSON contract between the Knowledge worker (server-built, caller-specific
 * projections) and the browser. The browser never receives a full Page
 * aggregate to hide parts of: every field here is already authorized.
 */

export type PrincipalView = { id: string; displayName: string };

export type ApiProblem = { code: string; title: string; detail?: string };

export type MeView = {
  principal: PrincipalView;
  organizationId: string;
  demo: null | {
    principals: PrincipalView[];
    faults: { notifier: boolean; searchIndex: boolean };
  };
  notifications: NotificationView[];
};

export type NotificationView = {
  pageId: string;
  spaceKey: string;
  title: string;
  revisionNumber: number;
  deliveredAt: string;
};

/** Knowledge-domain badge for a page, derived from readable projections only. */
export type PageBadge =
  | "published"
  | "draft"
  | "draft_changes"
  | "needs_review"
  | "archived"
  | "pending_approval";

export type HomeView = {
  recentlyPublished: Array<{
    pageId: string;
    spaceKey: string;
    spaceName: string;
    title: string;
    publishedAt: string;
    owner: PrincipalView;
    visibility: Visibility;
    sensitivity: Sensitivity;
  }>;
  /** Only pages whose authoring content the caller may read. */
  recentlyEdited: Array<{
    pageId: string;
    spaceKey: string;
    spaceName: string;
    title: string;
    editedAt: string;
    state: "draft" | "unpublished_changes";
  }>;
  attention: AttentionItem[];
  canCreatePage: boolean;
  /** Sections that could not be loaded (the rest still renders). */
  failedSections: Array<"recentlyPublished" | "recentlyEdited" | "attention">;
};

export type AttentionItem =
  | {
      kind: "stale_review";
      runId: string;
      pageId: string;
      spaceKey: string;
      title: string;
      detail: string;
    }
  | { kind: "update_needed"; pageId: string; spaceKey: string; title: string; detail: string }
  | {
      kind: "publication_conflict";
      pageId: string;
      spaceKey: string;
      title: string;
      detail: string;
    }
  | {
      kind: "effect_failed";
      pageId: string;
      spaceKey: string;
      title: string;
      detail: string;
      snapshotId: string;
      effect: "search_reindex" | "watcher_notification";
    }
  | {
      kind: "approval_pending";
      pageId: string;
      spaceKey: string;
      title: string;
      detail: string;
      approvalUrl: string;
    };

export type SpaceSummary = {
  id: string;
  key: string;
  name: string;
  description: string;
  role: SpaceRole;
  publishedPageCount: number;
  lastActivityAt: string | null;
};

export type SpacesView = { spaces: SpaceSummary[]; canCreateSpace: boolean };

export type PageRowView = {
  pageId: string;
  title: string;
  tags: string[];
  owner: PrincipalView;
  updatedAt: string;
  badge: PageBadge;
};

export type SpaceDetailView = {
  space: SpaceSummary;
  canCreatePage: boolean;
  canAdminister: boolean;
  canRunMaintenance: boolean;
  pages: PageRowView[];
  tags: string[];
};

export type PageLinkView = { pageId: string; spaceKey: string; title: string };

export type StepStatus =
  | "done"
  | "running"
  | "waiting"
  | "pending"
  | "failed"
  | "conflict"
  | "skipped"
  | "cancelled";

export type PublicationState =
  | "analyzing"
  | "waiting_approval"
  | "publishing"
  | "published"
  | "published_effect_failed"
  | "conflict"
  | "rejected"
  | "cancelled"
  | "failed_before_publish";

export type EffectView = {
  effect: "search_reindex" | "watcher_notification";
  status: "pending" | "succeeded" | "failed" | "unknown";
  attempts: number;
  lastErrorCode: string | null;
};

/** Domain result (Knowledge) and automation result (ultra-easy) side by side. */
export type PublicationPanelView = {
  snapshotId: string;
  revisionNumber: number;
  visibility: Visibility;
  sensitivity: Sensitivity;
  createdAt: string;
  createdBy: PrincipalView;
  state: PublicationState;
  steps: Array<{ key: string; label: string; status: StepStatus; detail?: string }>;
  conflict: { reason: string; expected: number; actual: number } | null;
  failure: { code: string; message: string } | null;
  effects: EffectView[];
  runId: string | null;
  runStatus: string | null;
  approvalUrl: string | null;
  canCancel: boolean;
  retryableEffects: Array<"search_reindex" | "watcher_notification">;
};

export type PageView = {
  space: { id: string; key: string; name: string };
  page: {
    id: string;
    status: "active" | "archived";
    owner: PrincipalView;
    reviewState: "current" | "update_needed";
  };
  /** Current published revision (null when never published or not readable). */
  published: null | {
    revisionNumber: number;
    title: string;
    body: string;
    tags: string[];
    visibility: Visibility;
    sensitivity: Sensitivity;
    publishedAt: string;
    publishedBy: PrincipalView;
  };
  /** Authoring summary: only for callers with read_draft. */
  draft: null | {
    title: string;
    body: string;
    tags: string[];
    visibility: Visibility;
    sensitivity: Sensitivity;
    version: number;
    updatedAt: string;
    updatedBy: PrincipalView;
    hasUnpublishedChanges: boolean;
  };
  access: {
    edit: boolean;
    publish: boolean;
    archive: boolean;
    restore: boolean;
    readHistory: boolean;
    watch: boolean;
  };
  watching: boolean;
  /** What a Publish click would pin (server-computed; shown in the confirmation dialog). */
  nextPublication: null | {
    revisionNumber: number;
    reusesRevision: boolean;
    visibility: Visibility;
    sensitivity: Sensitivity;
    draftVersion: number;
  };
  publication: PublicationPanelView | null;
  /** An archive request of this page waiting for approval in ultra-easy. */
  pendingArchive: null | { approvalUrl: string };
  historyCount: number | null;
  related: PageLinkView[];
  backlinks: PageLinkView[];
};

export type RevisionSummaryView = {
  number: number;
  title: string;
  createdAt: string;
  createdBy: PrincipalView;
  publications: Array<{
    snapshotId: string;
    visibility: Visibility;
    sensitivity: Sensitivity;
    outcome: "published" | "conflict" | "pending";
  }>;
  current: boolean;
};

export type RevisionDetailView = {
  number: number;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  createdBy: PrincipalView;
};

export type EditView = {
  space: { id: string; key: string; name: string };
  pageId: string;
  status: "active" | "archived";
  draft: {
    title: string;
    body: string;
    tags: string[];
    visibility: Visibility;
    sensitivity: Sensitivity;
    version: number;
    updatedAt: string;
  };
  publishedRevisionNumber: number | null;
  hasUnpublishedChanges: boolean;
  canPublish: boolean;
};

export type SearchResultView = {
  pageId: string;
  spaceKey: string;
  spaceName: string;
  title: string;
  /** Plain text with \u0002 / \u0003 around matches. */
  snippet: string;
  tags: string[];
  badge: PageBadge;
  timestamp: string;
};

export type SearchView = {
  query: string;
  results: SearchResultView[];
  spaces: Array<{ key: string; name: string }>;
  tags: string[];
};

export type AutomationCategory = "running" | "waiting" | "needs_attention" | "completed";

export type AutomationItemView = {
  runId: string;
  actionRequestId: string;
  kind: "publish_document" | "maintain_space" | "recovery" | "archive";
  label: string;
  space: { key: string; name: string };
  page: { id: string; title: string } | null;
  startedAt: string;
  updatedAt: string;
  status: string;
  statusLabel: string;
  category: AutomationCategory;
  nextAction: string | null;
};

export type AutomationDetailView = AutomationItemView & {
  steps: Array<{ key: string; label: string; status: StepStatus; detail?: string }>;
  approvals: Array<{ taskId: string; actionType: string; status: string; url: string }>;
  humanInputs: Array<{
    key: string;
    pageId: string;
    spaceKey: string;
    title: string;
    prompt: string;
    analysis: string;
    status: "waiting" | "answered";
    answer: string | null;
    canRespond: boolean;
    assignee: PrincipalView;
  }>;
  childActions: Array<{
    actionRequestId: string;
    actionType: string;
    status: string;
    errorCode: string | null;
  }>;
  failure: { code: string; message: string } | null;
  publication: null | {
    snapshotId: string;
    revisionNumber: number;
    visibility: Visibility;
    sensitivity: Sensitivity;
    createdBy: PrincipalView;
    createdAt: string;
  };
  retryableEffects: Array<"search_reindex" | "watcher_notification">;
  audit: Array<{ at: string; type: string; actionRequestId: string; detail: string }>;
};

export type AutomationView = {
  items: AutomationItemView[];
  spaces: Array<{ key: string; name: string }>;
};

export type ApprovalRuleView = {
  key: "publish_confidential" | "publish_organization" | "archive";
  title: string;
  description: string;
  requireApproval: boolean;
  approver: "space_owners" | "page_owner";
};

export type SpaceSettingsView = {
  space: SpaceSummary;
  rules: ApprovalRuleView[];
  policyVersion: number;
  pendingChange: null | { approvalUrl: string; rules: ApprovalRuleView[] };
  members: Array<{ principal: PrincipalView; role: SpaceRole }>;
  adminUrl: string;
};

export type ApprovalTaskPageView = {
  taskId: string;
  actionType: string;
  status: string;
  requestedBy: PrincipalView;
  candidates: PrincipalView[];
  decidedBy: PrincipalView | null;
  decidedAt: string | null;
  createdAt: string;
  canDecide: boolean;
  viewer: PrincipalView;
  context: Array<{ label: string; value: string }>;
  subjectLink: string | null;
  returnLink: string | null;
};
