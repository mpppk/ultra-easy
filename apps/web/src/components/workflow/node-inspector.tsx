import { PlusIcon, Trash2Icon } from "lucide-react";
import type * as React from "react";

import type { CapabilityGrant, ProgramNodeVersion, WorkflowNode } from "@app/workflow-core";

import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";

import { ConditionBuilder, TemplateEditor, ValueExpressionEditor } from "./condition-builder.tsx";
import { NODE_TYPE_LABELS, alwaysTrue } from "./graph-model.ts";
import type { CatalogAction } from "./studio-api.ts";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function GrantEditor({
  value,
  onChange,
  actions,
  llmModel,
  withLlm,
}: {
  value: CapabilityGrant | undefined;
  onChange: (value: CapabilityGrant) => void;
  actions: readonly CatalogAction[];
  llmModel: string;
  withLlm: boolean;
}) {
  const grant = value ?? {};
  const granted = new Set((grant.actions ?? []).map((action) => String(action.actionType)));
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2">
      <p className="text-xs font-medium">capability grant（実効 = 要求 ∩ grant ∩ 組織policy）</p>
      <div className="flex flex-wrap gap-2">
        {actions
          .filter((action) => action.kind === "primitive")
          .map((action) => (
            <label key={action.actionType} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={granted.has(action.actionType)}
                onChange={(event) =>
                  onChange({
                    ...grant,
                    actions: event.target.checked
                      ? [...(grant.actions ?? []), { actionType: action.actionType as never }]
                      : (grant.actions ?? []).filter(
                          (item) => String(item.actionType) !== action.actionType,
                        ),
                  })
                }
              />
              {action.actionType}
            </label>
          ))}
      </div>
      {withLlm ? (
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={grant.llm !== undefined}
            onChange={(event) => {
              const { llm: _removed, ...rest } = grant;
              onChange(
                event.target.checked
                  ? {
                      ...rest,
                      llm: {
                        models: [llmModel],
                        maxCalls: 2,
                        maxInputTokens: 4000,
                        maxOutputTokens: 512,
                        maxCostMicroUsd: 200_000,
                      },
                    }
                  : rest,
              );
            }}
          />
          LLM（{llmModel}）
        </label>
      ) : null}
    </div>
  );
}

/** 選択したNodeの編集パネル。 */
export function NodeInspector({
  node,
  onChange,
  onDelete,
  onOpenBody,
  fields,
  delegationFields,
  actions,
  programs,
  llmModel,
}: {
  node: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
  onOpenBody: () => void;
  fields: readonly string[];
  delegationFields: readonly string[];
  actions: readonly CatalogAction[];
  programs: readonly ProgramNodeVersion[];
  llmModel: string;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="node-inspector">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">
          {NODE_TYPE_LABELS[node.type]} · <span className="font-mono">{String(node.id)}</span>
        </p>
        {node.type !== "trigger" ? (
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <Trash2Icon /> 削除
          </Button>
        ) : null}
      </div>
      <Field label="label">
        <Input
          className="h-8"
          value={node.label ?? ""}
          onChange={(event) => onChange({ ...node, label: event.target.value })}
        />
      </Field>

      {node.type === "action" ? (
        <>
          <Field label="Action（primitive / composite）">
            <select
              className={selectClass}
              value={String(node.actionType)}
              onChange={(event) => onChange({ ...node, actionType: event.target.value as never })}
            >
              {!actions.some((action) => action.actionType === String(node.actionType)) ? (
                <option value={String(node.actionType)}>{String(node.actionType)}</option>
              ) : null}
              {actions.map((action) => (
                <option key={action.actionType} value={action.actionType}>
                  {action.actionType} {action.kind === "composite" ? "（composite）" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="resource type">
            <Input
              className="h-8"
              value={node.resource.type}
              onChange={(event) =>
                onChange({ ...node, resource: { ...node.resource, type: event.target.value } })
              }
            />
          </Field>
          <Field label="resource id">
            <ValueExpressionEditor
              value={node.resource.id}
              fields={fields}
              onChange={(id) => onChange({ ...node, resource: { ...node.resource, id } })}
            />
          </Field>
          <Field label="input">
            <TemplateEditor
              value={node.input}
              fields={fields}
              onChange={(input) => onChange({ ...node, input })}
            />
          </Field>
          <Field label="attribute restriction（Node Agentへの委任条件）">
            {node.restriction ? (
              <div className="flex flex-col gap-1">
                <ConditionBuilder
                  value={node.restriction}
                  fields={delegationFields}
                  onChange={(restriction) => onChange({ ...node, restriction })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-fit"
                  onClick={() => {
                    const { restriction: _removed, ...rest } = node;
                    onChange(rest);
                  }}
                >
                  制限を外す
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() =>
                  onChange({
                    ...node,
                    restriction: {
                      type: "comparison",
                      left: { type: "field", path: "action.input.amount" },
                      operator: "lte",
                      right: { type: "literal", value: 10_000 },
                    },
                  })
                }
              >
                <PlusIcon /> 制限を追加
              </Button>
            )}
          </Field>
        </>
      ) : null}

      {node.type === "branch" ? (
        <>
          {node.cases.map((branchCase, index) => (
            <div key={index} className="flex flex-col gap-1 rounded-md border p-2">
              <div className="flex items-center gap-1">
                <Input
                  aria-label="case key"
                  className="h-8 w-32 font-mono text-xs"
                  value={branchCase.key}
                  onChange={(event) =>
                    onChange({
                      ...node,
                      cases: node.cases.map((item, position) =>
                        position === index ? { ...item, key: event.target.value } : item,
                      ),
                    })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="case削除"
                  onClick={() =>
                    onChange({
                      ...node,
                      cases: node.cases.filter((_, position) => position !== index),
                    })
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
              <ConditionBuilder
                value={branchCase.when}
                fields={fields}
                onChange={(when) =>
                  onChange({
                    ...node,
                    cases: node.cases.map((item, position) =>
                      position === index ? { ...item, when } : item,
                    ),
                  })
                }
              />
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              onChange({
                ...node,
                cases: [...node.cases, { key: `case${node.cases.length + 1}`, when: alwaysTrue }],
              })
            }
          >
            <PlusIcon /> case
          </Button>
          <Field label="default key（空欄 = 一致しなければ失敗）">
            <Input
              className="h-8 font-mono text-xs"
              value={node.defaultKey ?? ""}
              onChange={(event) => {
                const { defaultKey: _removed, ...rest } = node;
                onChange(event.target.value ? { ...rest, defaultKey: event.target.value } : rest);
              }}
            />
          </Field>
        </>
      ) : null}

      {node.type === "for_each" ? (
        <>
          <Field label="collection">
            <ValueExpressionEditor
              value={node.collection}
              fields={fields}
              onChange={(collection) => onChange({ ...node, collection })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="concurrency">
              <Input
                type="number"
                className="h-8"
                value={node.concurrency}
                onChange={(event) => onChange({ ...node, concurrency: Number(event.target.value) })}
              />
            </Field>
            <Field label="maxItems">
              <Input
                type="number"
                className="h-8"
                value={node.maxItems}
                onChange={(event) => onChange({ ...node, maxItems: Number(event.target.value) })}
              />
            </Field>
          </div>
          <Button variant="outline" size="sm" onClick={onOpenBody}>
            loop bodyを編集（{node.body.nodes.length} nodes）
          </Button>
        </>
      ) : null}

      {node.type === "while" ? (
        <>
          <Field label="condition（iteration前に評価）">
            <ConditionBuilder
              value={node.condition}
              fields={fields}
              onChange={(condition) => onChange({ ...node, condition })}
            />
          </Field>
          <Field label="maxIterations（必須）">
            <Input
              type="number"
              className="h-8"
              value={node.maxIterations}
              onChange={(event) => onChange({ ...node, maxIterations: Number(event.target.value) })}
            />
          </Field>
          <Button variant="outline" size="sm" onClick={onOpenBody}>
            loop bodyを編集（{node.body.nodes.length} nodes）
          </Button>
        </>
      ) : null}

      {node.type === "transform" ? (
        <Field label="output">
          <TemplateEditor
            value={node.output}
            fields={fields}
            onChange={(output) => onChange({ ...node, output })}
          />
        </Field>
      ) : null}

      {node.type === "output" ? (
        <Field label="value（Workflow / Composite Actionのoutput）">
          <TemplateEditor
            value={node.value}
            fields={fields}
            onChange={(value) => onChange({ ...node, value })}
          />
        </Field>
      ) : null}

      {node.type === "program" ? (
        <>
          <Field label="Program version（publish済み・immutable）">
            <select
              className={selectClass}
              value={`${String(node.program.programId)}@${node.program.version}`}
              onChange={(event) => {
                const selected = programs.find(
                  (program) => `${program.programId}@${program.version}` === event.target.value,
                );
                if (selected) {
                  onChange({
                    ...node,
                    program: {
                      programId: selected.programId as never,
                      version: selected.version,
                      sourceDigest: selected.sourceDigest as never,
                    },
                  });
                }
              }}
            >
              <option value={`${String(node.program.programId)}@${node.program.version}`}>
                {String(node.program.programId)}@{node.program.version}
              </option>
              {programs.map((program) => (
                <option
                  key={`${program.programId}@${program.version}`}
                  value={`${program.programId}@${program.version}`}
                >
                  {program.programId}@{program.version}
                </option>
              ))}
            </select>
          </Field>
          <Field label="input">
            <TemplateEditor
              value={node.input}
              fields={fields}
              onChange={(input) => onChange({ ...node, input })}
            />
          </Field>
          <GrantEditor
            value={node.capabilities}
            actions={actions}
            llmModel={llmModel}
            withLlm
            onChange={(capabilities) => onChange({ ...node, capabilities })}
          />
        </>
      ) : null}

      {node.type === "llm" ? (
        <>
          <Field label="model">
            <Input
              className="h-8"
              value={node.model}
              onChange={(event) => onChange({ ...node, model: event.target.value })}
            />
          </Field>
          <Field label="prompt">
            <TemplateEditor
              value={node.prompt}
              fields={fields}
              onChange={(prompt) => onChange({ ...node, prompt })}
            />
          </Field>
          <Field label="maxOutputTokens">
            <Input
              type="number"
              className="h-8"
              value={node.maxOutputTokens}
              onChange={(event) =>
                onChange({ ...node, maxOutputTokens: Number(event.target.value) })
              }
            />
          </Field>
          <GrantEditor
            value={node.capabilities}
            actions={actions}
            llmModel={llmModel}
            withLlm
            onChange={(capabilities) => onChange({ ...node, capabilities })}
          />
        </>
      ) : null}
    </div>
  );
}
