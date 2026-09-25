import { useState } from "react";
import type * as React from "react";

import { useGo } from "#components/layout/app-link";
import { Button } from "#components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#components/ui/dialog";
import { Input } from "#components/ui/input";
import { Label } from "#components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select";
import { Textarea } from "#components/ui/textarea";
import { useMutation } from "#hooks/use-api-query";
import { apiSend } from "#lib/api-client";

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32);
}

const MESSAGES: Record<string, string> = {
  duplicate_key: "That key is already used by another space.",
  validation_error: "Check the name and key (2-32 lowercase letters, digits or hyphens).",
  forbidden: "You do not have permission to do this.",
};

export function CreateSpaceDialog({ trigger }: { trigger: React.ReactNode }) {
  const go = useGo();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState("");
  const mutation = useMutation();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation
              .run(() =>
                apiSend<{ key: string }>("POST", "/api/spaces", { name, key, description }),
              )
              .then((created) => created && go(`/spaces/${created.key}`));
          }}
        >
          <DialogHeader>
            <DialogTitle>Create space</DialogTitle>
            <DialogDescription>You become the owner of the new space.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="space-name">Name</Label>
            <Input
              id="space-name"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!keyTouched) setKey(slug(event.target.value));
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="space-key">Key</Label>
            <Input
              id="space-key"
              required
              pattern="[a-z][a-z0-9-]{1,31}"
              value={key}
              onChange={(event) => {
                setKeyTouched(true);
                setKey(event.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">Used in URLs: /spaces/{key || "key"}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="space-description">Description (optional)</Label>
            <Textarea
              id="space-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          {mutation.error ? (
            <p className="text-sm text-destructive" role="alert">
              {MESSAGES[mutation.error.code] ?? mutation.error.title}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.busy}>
              Create space
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Minimal "new page" dialog: creates the page shell + draft, then opens the editor.
 * With `spaces`, the caller picks the space (Home); otherwise `spaceKey` is fixed.
 */
export function CreatePageDialog({
  trigger,
  spaceKey,
  spaces,
}: {
  trigger: React.ReactNode;
  spaceKey?: string;
  spaces?: Array<{ key: string; name: string }>;
}) {
  const go = useGo();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState(spaceKey ?? spaces?.[0]?.key ?? "");
  const mutation = useMutation();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation
              .run(() =>
                apiSend<{ pageId: string; spaceKey: string }>(
                  "POST",
                  `/api/spaces/${target}/pages`,
                  { title },
                ),
              )
              .then(
                (created) =>
                  created && go(`/spaces/${created.spaceKey}/pages/${created.pageId}/edit`),
              );
          }}
        >
          <DialogHeader>
            <DialogTitle>New page</DialogTitle>
            <DialogDescription>
              Start a draft. Nothing is published until you publish it.
            </DialogDescription>
          </DialogHeader>
          {spaces ? (
            <div className="flex flex-col gap-2">
              <Label>Space</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a space" />
                </SelectTrigger>
                <SelectContent>
                  {spaces.map((space) => (
                    <SelectItem key={space.key} value={space.key}>
                      {space.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor="page-title">Title</Label>
            <Input
              id="page-title"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          {mutation.error ? (
            <p className="text-sm text-destructive" role="alert">
              {MESSAGES[mutation.error.code] ?? mutation.error.title}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.busy || !target}>
              Create page
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
