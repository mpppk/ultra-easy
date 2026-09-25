import { useState } from "react";

import type {
  ApprovalProjection,
  ApprovalProjectionItem,
  CapabilityReview,
  ProgramDraft,
} from "@app/workflow-application";

import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";
import { Textarea } from "#components/ui/textarea";
import { cn } from "#lib/utils";

import { studioApi } from "./studio-api.ts";

const CLASSIFICATION_LABEL: Record<ApprovalProjectionItem["classification"], string> = {
  statically_resolved: "確定",
  conditional: "条件付き",
  potential: "可能性あり",
  unresolved: "未確定",
};

export function projectionLabel(item: ApprovalProjectionItem): {
  label: string;
  tone: "required" | "none" | "unknown";
} {
  if (!item.approval || item.classification === "unresolved")
    return { label: "承認: 未確定（見込み）", tone: "unknown" };
  if (item.classification === "potential") {
    return {
      label: item.approval.required ? "承認の可能性（見込み）" : "承認不要の可能性（見込み）",
      tone: "unknown",
    };
  }
  const prefix = item.classification === "conditional" ? "条件付き: " : "";
  return item.approval.required
    ? { label: `${prefix}承認${item.approval.stepCount}段（見込み）`, tone: "required" }
    : { label: `${prefix}承認不要（見込み）`, tone: "none" };
}

function ProjectionItems({
  items,
  depth = 0,
}: {
  items: ApprovalProjectionItem[];
  depth?: number;
}) {
  return (
    <ul className={cn("flex flex-col gap-1", depth > 0 && "ml-4 border-l pl-3")}>
      {items.map((item) => {
        const label = projectionLabel(item);
        return (
          <li
            key={`${item.path.join("/")}:${item.actionType}`}
            className="flex flex-col gap-1 text-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{item.path.join(" › ")}</span>
              <span>{item.actionType}</span>
              <Badge
                variant="outline"
                className={cn(
                  item.classification === "unresolved" || item.classification === "potential"
                    ? "border-dashed"
                    : undefined,
                )}
              >
                {CLASSIFICATION_LABEL[item.classification]}
              </Badge>
              <Badge
                variant={label.tone === "required" ? "default" : "outline"}
                className={cn(label.tone === "unknown" && "border-dashed")}
              >
                {label.label}
              </Badge>
              {item.source !== "action_node" ? (
                <Badge variant="secondary">{item.source}</Badge>
              ) : null}
            </div>
            {item.unresolvedReason ? (
              <p className="text-xs text-muted-foreground">
                runtime値に依存: {item.runtimeInputFields.join(", ") || "-"}（
                {item.unresolvedReason}）
              </p>
            ) : null}
            {item.nested ? (
              <div className="ml-2">
                <p className="text-xs text-muted-foreground">
                  nested Composite Action: {item.nested.workflow.definitionId}@
                  {item.nested.workflow.version}
                  {item.nested.workflowLevel?.approval?.required ? " · workflow-level承認あり" : ""}
                </p>
                <ProjectionItems items={item.nested.items} depth={depth + 1} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Approval Projection（説明用。実際の承認はchild ActionRequestのMaterialized Planが決める）。 */
export function ProjectionPanel({ projection }: { projection: ApprovalProjection | null }) {
  if (!projection)
    return <p className="text-sm text-muted-foreground">publish後に見込みを計算できます。</p>;
  return (
    <div className="flex flex-col gap-3" data-testid="approval-projection">
      <p className="text-xs text-muted-foreground">
        これは静的解析による <strong>見込み（projection）</strong> です。実行時の承認は各child
        ActionRequestの Materialized Approval
        Planが決め、親Workflowの承認でchildの承認が省略されることはありません。
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">workflow-level approval:</span>
        {projection.workflowLevel ? (
          projection.workflowLevel.approval ? (
            <Badge variant={projection.workflowLevel.approval.required ? "default" : "outline"}>
              {projection.workflowLevel.actionType}:{" "}
              {projection.workflowLevel.approval.required
                ? `承認${projection.workflowLevel.approval.stepCount}段`
                : "承認不要"}
            </Badge>
          ) : (
            <Badge variant="outline" className="border-dashed">
              未確定
            </Badge>
          )
        ) : (
          <span className="text-muted-foreground">Composite Action未公開</span>
        )}
      </div>
      {projection.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Actionはありません。</p>
      ) : (
        <ProjectionItems items={projection.items} />
      )}
    </div>
  );
}

/** Program / LLM Nodeのrequested capability review（生成結果を自動承認しない）。 */
export function CapabilityReviewPanel({ reviews }: { reviews: CapabilityReview[] }) {
  if (reviews.length === 0)
    return <p className="text-sm text-muted-foreground">Program / LLM Nodeはありません。</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="capability-review">
      {reviews.map((review) => (
        <div key={review.nodeId} className="rounded-md border p-2 text-sm">
          <p className="font-medium">
            {review.nodeId} <Badge variant="outline">{review.nodeType}</Badge>
          </p>
          <p className="text-xs text-muted-foreground">
            要求: actions [
            {(review.requested.actions ?? []).map((action) => action.actionType).join(", ")}]
            {review.requested.llm ? ` / llm ${review.requested.llm.models.join(", ")}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            grant: actions [
            {(review.granted.actions ?? []).map((action) => String(action.actionType)).join(", ")}]
            {review.granted.llm
              ? ` / llm ${review.granted.llm.models.join(", ")} (calls ≤ ${review.granted.llm.maxCalls})`
              : ""}
          </p>
          {review.issues.length > 0 ? (
            <ul className="mt-1 text-xs text-destructive">
              {review.issues.map((issue, index) => (
                <li key={index}>
                  {issue.code}: {issue.message}
                </li>
              ))}
            </ul>
          ) : (
            <Badge variant="secondary" className="mt-1">
              review OK
            </Badge>
          )}
        </div>
      ))}
    </div>
  );
}

const DEFAULT_SAMPLE = `[{ "input": { "lines": [{ "price": 3000, "qty": 2 }, { "price": 5000, "qty": 1 }] } }]`;

/** 自然言語からProgramを生成し、コード / manifest / test結果を確認してpublishする。 */
export function ProgramAuthoringPanel({ onPublished }: { onPublished: () => void }) {
  const [programId, setProgramId] = useState("program:invoice-total");
  const [instruction, setInstruction] = useState(
    "明細(lines: price, qty)の合計を計算し、1万円以上なら10%割引した total を返す",
  );
  const [source, setSource] = useState("");
  const [samples, setSamples] = useState(DEFAULT_SAMPLE);
  const [actions, setActions] = useState("");
  const [draft, setDraft] = useState<ProgramDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const parsedSamples = () => JSON.parse(samples) as unknown[];
  const requested = () => ({
    actions: actions
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((actionType) => ({ actionType })),
  });

  return (
    <div className="flex flex-col gap-2" data-testid="program-authoring">
      <Input
        aria-label="program id"
        className="h-8 font-mono text-xs"
        value={programId}
        onChange={(event) => setProgramId(event.target.value)}
      />
      <Textarea
        aria-label="自然言語の指示"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <Textarea
        aria-label="source（空欄ならLLMで生成）"
        placeholder="空欄ならCoding LLMで生成。直接書く場合: function main(input, context) { return ue.complete(...) }"
        className="min-h-24 font-mono text-xs"
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      <Input
        aria-label="要求するAction（カンマ区切り）"
        placeholder="要求するAction（例: notify.send）"
        className="h-8 text-xs"
        value={actions}
        onChange={(event) => setActions(event.target.value)}
      />
      <Textarea
        aria-label="test samples"
        className="min-h-16 font-mono text-xs"
        value={samples}
        onChange={(event) => setSamples(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setDraft(
                await studioApi.draftProgram({
                  programId,
                  ...(source.trim() ? { source } : { instruction }),
                  inputSchema: { type: "any" },
                  outputSchema: { type: "any" },
                  requestedCapabilities: requested(),
                  samples: parsedSamples(),
                }),
              );
            })
          }
        >
          生成・検証・test
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !draft?.ready}
          onClick={() =>
            run(async () => {
              if (!draft) return;
              await studioApi.publishProgram(draft, parsedSamples());
              setDraft(null);
              onPublished();
            })
          }
        >
          review済みとしてpublish
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {draft ? (
        <div className="flex flex-col gap-1 rounded-md border p-2 text-xs">
          <p>
            generator: {draft.generator.kind}
            {draft.generator.model ? ` (${draft.generator.model})` : ""} · digest{" "}
            <span className="font-mono">{draft.sourceDigest.slice(0, 20)}…</span>
          </p>
          <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono">
            {draft.source}
          </pre>
          <p>requested: {JSON.stringify(draft.requestedCapabilities)}</p>
          {draft.issues.map((issue, index) => (
            <p key={index} className="text-destructive">
              {issue.code}: {issue.message}
            </p>
          ))}
          {draft.tests.map((test, index) => (
            <p
              key={index}
              className={test.status === "passed" ? "text-success" : "text-destructive"}
            >
              test {index + 1}: {test.status}{" "}
              {test.output !== undefined ? JSON.stringify(test.output) : ""}{" "}
              {test.error ? `${test.error.code}: ${test.error.message}` : ""}
            </p>
          ))}
          <Badge variant={draft.ready ? "secondary" : "destructive"} className="w-fit">
            {draft.ready ? "ready" : "not ready"}
          </Badge>
        </div>
      ) : null}
    </div>
  );
}
