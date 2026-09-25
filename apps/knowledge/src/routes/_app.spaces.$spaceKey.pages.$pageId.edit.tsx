import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Sensitivity, Visibility } from "@app/knowledge-core";

import { Pill } from "#components/knowledge/badges";
import { MarkdownEditor } from "#components/knowledge/markdown-editor";
import { MarkdownView } from "#components/knowledge/markdown-view";
import { AppLink, useGo } from "#components/layout/app-link";
import { Breadcrumbs, PageContainer } from "#components/layout/page";
import { ErrorState, LoadingState, NotFoundState } from "#components/layout/states";
import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";
import { Label } from "#components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import { Switch } from "#components/ui/switch";
import { useApiQuery } from "#hooks/use-api-query";
import { ApiError, apiGet, apiSend, pagePath } from "#lib/api-client";
import { relativeTime, SENSITIVITY_LABEL, VISIBILITY_HELP, VISIBILITY_LABEL } from "#lib/format";

import { SENSITIVITIES, VISIBILITIES, wordCount } from "@app/knowledge-core";

import type { EditView } from "../shared/api.ts";

export const Route = createFileRoute("/_app/spaces/$spaceKey/pages/$pageId/edit")({
  component: PageEdit,
});

type Form = {
  title: string;
  body: string;
  tags: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
};

type SaveState =
  | { type: "clean" }
  | { type: "saving" }
  | { type: "saved" }
  | { type: "failed"; message: string };

const SAVE_MESSAGES: Record<string, string> = {
  draft_conflict: "Someone else changed this draft. Reload to get the latest version.",
  validation_error: "Check the title and tags before saving.",
  invalid_state: "This page can no longer be edited.",
};

function PageEdit() {
  const { spaceKey, pageId } = Route.useParams();
  const path = pagePath(spaceKey, pageId);
  const edit = useApiQuery(() => apiGet<EditView>(`${path}/edit`), [path]);
  if (edit.status === "error") {
    if (edit.error.status === 404) return <NotFoundState />;
    return (
      <PageContainer>
        <ErrorState
          title={
            edit.error.code === "invalid_state"
              ? "This page can't be edited"
              : "We couldn't load the editor"
          }
          description={
            edit.error.code === "invalid_state"
              ? "Archived pages are read-only. Restore the page to edit it."
              : edit.error.code === "forbidden"
                ? "You do not have permission to edit this page."
                : undefined
          }
          code={edit.error.code}
          onRetry={edit.refetch}
        />
      </PageContainer>
    );
  }
  if (!edit.data) {
    return (
      <PageContainer>
        <LoadingState rows={2} />
      </PageContainer>
    );
  }
  return <Editor key={edit.data.draft.version} initial={edit.data} path={path} />;
}

function Editor({ initial, path }: { initial: EditView; path: string }) {
  const go = useGo();
  const [form, setForm] = useState<Form>({
    title: initial.draft.title,
    body: initial.draft.body,
    tags: initial.draft.tags,
    visibility: initial.draft.visibility,
    sensitivity: initial.draft.sensitivity,
  });
  const [saved, setSaved] = useState({ ...initial.draft });
  const [saveState, setSaveState] = useState<SaveState>({ type: "clean" });
  const [preview, setPreview] = useState(true);
  const [tagInput, setTagInput] = useState("");
  const [publishing, setPublishing] = useState(false);
  const leaving = useRef(false);
  const viewHref = `/spaces/${initial.space.key}/pages/${initial.pageId}`;

  const dirty =
    form.title !== saved.title ||
    form.body !== saved.body ||
    form.visibility !== saved.visibility ||
    form.sensitivity !== saved.sensitivity ||
    form.tags.join("\u0000") !== saved.tags.join("\u0000");

  useBlocker({
    shouldBlockFn: () =>
      dirty && !leaving.current
        ? !window.confirm("You have unsaved changes. Leave without saving?")
        : false,
    enableBeforeUnload: () => dirty && !leaving.current,
  });

  useEffect(() => {
    if (dirty && saveState.type === "saved") setSaveState({ type: "clean" });
  }, [dirty, saveState.type]);

  async function save(): Promise<number | null> {
    setSaveState({ type: "saving" });
    return apiSend<EditView["draft"]>("PUT", `${path}/draft`, {
      ...form,
      expectedVersion: saved.version,
    })
      .then((draft) => {
        setSaved(draft);
        setSaveState({ type: "saved" });
        return draft.version;
      })
      .catch((error: unknown) => {
        setSaveState({
          type: "failed",
          message:
            error instanceof ApiError
              ? (SAVE_MESSAGES[error.code] ?? error.title)
              : "Save failed. Check your connection.",
        });
        return null;
      });
  }

  async function publish() {
    setPublishing(true);
    const version = dirty ? await save() : saved.version;
    if (version === null) {
      setPublishing(false);
      return;
    }
    await apiSend("POST", `${path}/publish`, { expectedDraftVersion: version })
      .then(() => {
        leaving.current = true;
        go(viewHref);
      })
      .catch((error: unknown) =>
        setSaveState({
          type: "failed",
          message: error instanceof ApiError ? error.title : "Publishing failed.",
        }),
      )
      .finally(() => setPublishing(false));
  }

  function addTag() {
    const tag = tagInput.trim();
    if (tag && !form.tags.includes(tag) && form.tags.length < 12)
      setForm({ ...form, tags: [...form.tags, tag] });
    setTagInput("");
  }

  return (
    <PageContainer className="max-w-7xl">
      <Breadcrumbs
        items={[
          { label: "Spaces", href: "/spaces" },
          { label: initial.space.name, href: `/spaces/${initial.space.key}` },
          { label: saved.title, href: viewHref },
          { label: "Edit" },
        ]}
      />
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Edit Page</h1>
          {dirty ? (
            <Pill tone="warning">● Unsaved changes</Pill>
          ) : saveState.type === "saved" ? (
            <Pill tone="success">Saved</Pill>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <AppLink href={viewHref}>Cancel</AppLink>
          </Button>
          <Button
            variant="outline"
            className="border-primary text-primary"
            disabled={!dirty || saveState.type === "saving"}
            onClick={() => void save()}
          >
            {saveState.type === "saving" ? "Saving…" : "Save draft"}
          </Button>
          {initial.canPublish ? (
            <Button
              disabled={publishing || saveState.type === "saving"}
              onClick={() => void publish()}
            >
              {initial.publishedRevisionNumber === null ? "Publish" : "Publish changes"}
            </Button>
          ) : null}
        </div>
      </header>
      {saveState.type === "failed" ? (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveState.message}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-4 rounded-xl border bg-card p-6">
          <div className="flex flex-col gap-2">
            <Label htmlFor="page-title" className="text-xs text-muted-foreground uppercase">
              Page title
            </Label>
            <Input
              id="page-title"
              value={form.title}
              maxLength={200}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              className="h-11 bg-muted text-lg font-semibold"
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase">Tags</span>
            <div className="flex flex-wrap items-center gap-2">
              {form.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() =>
                      setForm({ ...form, tags: form.tags.filter((entry) => entry !== tag) })
                    }
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
              <form
                className="flex items-center"
                onSubmit={(event) => {
                  event.preventDefault();
                  addTag();
                }}
              >
                <PlusIcon className="size-3 text-primary" />
                <input
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onBlur={addTag}
                  placeholder="Add tag"
                  aria-label="Add tag"
                  maxLength={32}
                  className="w-24 bg-transparent px-1 text-xs text-primary outline-none placeholder:text-primary"
                />
              </form>
            </div>
          </div>
          <div className="flex items-center justify-between border-b pb-1">
            <span className="text-xs font-medium text-muted-foreground uppercase">
              Markdown source
            </span>
            <a
              href="https://github.github.com/gfm/"
              target="_blank"
              rel="noreferrer noopener"
              className="text-xs text-primary hover:underline"
            >
              Syntax Help
            </a>
          </div>
          <div className={preview ? "grid gap-4 xl:grid-cols-2" : ""}>
            <MarkdownEditor
              value={form.body}
              onChange={(body) => setForm((current) => ({ ...current, body }))}
              onSave={() => void save()}
            />
            {preview ? (
              <div className="rounded-lg border bg-background p-4" aria-label="Preview">
                <MarkdownView markdown={form.body} />
              </div>
            ) : null}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Last saved {relativeTime(saved.updatedAt)}</span>
            <span>{wordCount(form.body)} words</span>
          </div>
        </div>
        <aside className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 rounded-xl border bg-card p-5">
            <h2 className="text-lg font-semibold">Publication settings</h2>
            <div className="flex flex-col gap-2">
              <Label>Visibility</Label>
              <Select
                value={form.visibility}
                onValueChange={(value) => setForm({ ...form, visibility: value as Visibility })}
              >
                <SelectTrigger className="w-full" aria-label="Visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISIBILITIES.map((visibility) => (
                    <SelectItem key={visibility} value={visibility}>
                      {VISIBILITY_LABEL[visibility]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{VISIBILITY_HELP[form.visibility]}</p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Sensitivity</Label>
              <Select
                value={form.sensitivity}
                onValueChange={(value) => setForm({ ...form, sensitivity: value as Sensitivity })}
              >
                <SelectTrigger className="w-full" aria-label="Sensitivity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SENSITIVITIES.map((sensitivity) => (
                    <SelectItem key={sensitivity} value={sensitivity}>
                      {SENSITIVITY_LABEL[sensitivity]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving a draft never requests approval. Settings are pinned only when you publish.
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border bg-card p-5">
            <div>
              <h2 className="text-lg font-semibold">Split Preview</h2>
              <p className="text-sm text-muted-foreground">Show live HTML preview</p>
            </div>
            <Switch
              checked={preview}
              onCheckedChange={setPreview}
              aria-label="Show live HTML preview"
            />
          </div>
          {initial.publishedRevisionNumber !== null ? (
            <p className="text-xs text-muted-foreground">
              Published revision: #{initial.publishedRevisionNumber}
              {initial.hasUnpublishedChanges || dirty
                ? " · this draft differs from it"
                : " · draft matches it"}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">This page has never been published.</p>
          )}
        </aside>
      </div>
    </PageContainer>
  );
}
