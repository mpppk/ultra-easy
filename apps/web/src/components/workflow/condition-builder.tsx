import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import type {
  ComparisonOperator,
  Condition,
  ValueExpression,
  ValueTemplate,
} from "@app/expression-core";

import { Button } from "#components/ui/button";
import { Input } from "#components/ui/input";
import { Textarea } from "#components/ui/textarea";
import { cn } from "#lib/utils";

import { alwaysTrue, field, literal } from "./graph-model.ts";

const OPERATORS: ComparisonOperator[] = ["eq", "ne", "gt", "gte", "lt", "lte"];
const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function parseLiteral(text: string): unknown {
  if (text.trim() === "") return "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function literalText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** field（namespace付きpath）かliteralを選ぶValueExpression editor。 */
export function ValueExpressionEditor({
  value,
  onChange,
  fields,
}: {
  value: ValueExpression;
  onChange: (value: ValueExpression) => void;
  fields: readonly string[];
}) {
  const listId = useId();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <select
        aria-label="値の種類"
        className={cn(selectClass, "w-[84px]")}
        value={value.type}
        onChange={(event) =>
          onChange(
            event.target.value === "field" ? field(fields[0] ?? "workflow.input") : literal(""),
          )
        }
      >
        <option value="field">field</option>
        <option value="literal">literal</option>
      </select>
      {value.type === "field" ? (
        <>
          <Input
            aria-label="field path"
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            list={listId}
            value={value.path}
            onChange={(event) => onChange(field(event.target.value))}
          />
          <datalist id={listId}>
            {fields.map((path) => (
              <option key={path} value={path} />
            ))}
          </datalist>
        </>
      ) : (
        <Input
          aria-label="literal"
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          value={literalText(value.value)}
          onChange={(event) => onChange(literal(parseLiteral(event.target.value)))}
        />
      )}
    </div>
  );
}

function defaultFor(type: Condition["type"], fields: readonly string[]): Condition {
  const left = field(fields[0] ?? "workflow.input");
  switch (type) {
    case "comparison":
      return { type, left, operator: "eq", right: literal("") };
    case "and":
    case "or":
      return { type, conditions: [alwaysTrue] };
    case "not":
      return { type, condition: alwaysTrue };
    case "in":
      return { type, value: left, candidates: [literal("")] };
    case "contains":
      return { type, collection: left, value: literal("") };
  }
}

/**
 * Approval Policy / Workflow Branch・Loop / Delegation restrictionで共有するCondition Builder。
 * 参照できるfieldはcontextのnamespace（field catalog）から候補表示する。
 */
export function ConditionBuilder({
  value,
  onChange,
  fields,
  depth = 0,
}: {
  value: Condition;
  onChange: (value: Condition) => void;
  fields: readonly string[];
  depth?: number;
}) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-md border p-2", depth > 0 && "bg-muted/40")}>
      <select
        aria-label="条件の種類"
        className={cn(selectClass, "w-fit")}
        value={value.type}
        onChange={(event) => onChange(defaultFor(event.target.value as Condition["type"], fields))}
      >
        <option value="comparison">比較</option>
        <option value="and">すべて（and）</option>
        <option value="or">いずれか（or）</option>
        <option value="not">否定（not）</option>
        <option value="in">候補に含まれる（in）</option>
        <option value="contains">含む（contains）</option>
      </select>
      {value.type === "comparison" ? (
        <div className="flex flex-wrap items-center gap-1">
          <ValueExpressionEditor
            value={value.left}
            fields={fields}
            onChange={(left) => onChange({ ...value, left })}
          />
          <select
            aria-label="演算子"
            className={cn(selectClass, "w-[72px]")}
            value={value.operator}
            onChange={(event) =>
              onChange({ ...value, operator: event.target.value as ComparisonOperator })
            }
          >
            {OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
          <ValueExpressionEditor
            value={value.right}
            fields={fields}
            onChange={(right) => onChange({ ...value, right })}
          />
        </div>
      ) : null}
      {value.type === "and" || value.type === "or" ? (
        <div className="flex flex-col gap-2">
          {value.conditions.map((child, index) => (
            <div key={index} className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <ConditionBuilder
                  value={child}
                  fields={fields}
                  depth={depth + 1}
                  onChange={(next) =>
                    onChange({
                      ...value,
                      conditions: value.conditions.map((item, position) =>
                        position === index ? next : item,
                      ),
                    })
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="条件を削除"
                onClick={() =>
                  onChange({
                    ...value,
                    conditions: value.conditions.filter((_, position) => position !== index),
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={() =>
              onChange({
                ...value,
                conditions: [...value.conditions, defaultFor("comparison", fields)],
              })
            }
          >
            <PlusIcon /> 条件を追加
          </Button>
        </div>
      ) : null}
      {value.type === "not" ? (
        <ConditionBuilder
          value={value.condition}
          fields={fields}
          depth={depth + 1}
          onChange={(condition) => onChange({ ...value, condition })}
        />
      ) : null}
      {value.type === "in" ? (
        <div className="flex flex-col gap-1">
          <ValueExpressionEditor
            value={value.value}
            fields={fields}
            onChange={(next) => onChange({ ...value, value: next })}
          />
          <Input
            aria-label="候補（カンマ区切り）"
            className="h-8 font-mono text-xs"
            value={value.candidates
              .map((candidate) =>
                candidate.type === "literal" ? literalText(candidate.value) : candidate.path,
              )
              .join(", ")}
            onChange={(event) =>
              onChange({
                ...value,
                candidates: event.target.value
                  .split(",")
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0)
                  .map((item) => literal(parseLiteral(item))),
              })
            }
          />
        </div>
      ) : null}
      {value.type === "contains" ? (
        <div className="flex flex-wrap items-center gap-1">
          <ValueExpressionEditor
            value={value.collection}
            fields={fields}
            onChange={(collection) => onChange({ ...value, collection })}
          />
          <span className="text-xs text-muted-foreground">contains</span>
          <ValueExpressionEditor
            value={value.value}
            fields={fields}
            onChange={(next) => onChange({ ...value, value: next })}
          />
        </div>
      ) : null}
    </div>
  );
}

/** ValueTemplate editor（objectはkeyごとのfield / literal、それ以外はJSON）。 */
export function TemplateEditor({
  value,
  onChange,
  fields,
}: {
  value: ValueTemplate;
  onChange: (value: ValueTemplate) => void;
  fields: readonly string[];
}) {
  const [json, setJson] = useState<string | null>(null);
  const simpleObject =
    value.type === "object" &&
    Object.values(value.fields).every(
      (child) => child.type === "field" || child.type === "literal",
    );

  if (json !== null || !(simpleObject || value.type === "field" || value.type === "literal")) {
    const text = json ?? JSON.stringify(value, null, 2);
    return (
      <div className="flex flex-col gap-1">
        <Textarea
          aria-label="template JSON"
          className="min-h-32 font-mono text-xs"
          value={text}
          onChange={(event) => {
            setJson(event.target.value);
            try {
              onChange(JSON.parse(event.target.value) as ValueTemplate);
            } catch {
              // 入力途中のJSONは反映しない。
            }
          }}
        />
        <Button variant="ghost" size="sm" className="w-fit" onClick={() => setJson(null)}>
          フォーム表示に戻す
        </Button>
      </div>
    );
  }
  if (value.type === "field" || value.type === "literal") {
    return (
      <div className="flex items-center gap-1">
        <ValueExpressionEditor value={value} fields={fields} onChange={onChange} />
        <Button variant="ghost" size="sm" onClick={() => onChange({ type: "object", fields: {} })}>
          object
        </Button>
      </div>
    );
  }
  const entries = value.type === "object" ? Object.entries(value.fields) : [];
  const setEntries = (next: [string, ValueTemplate][]) =>
    onChange({ type: "object", fields: Object.fromEntries(next) });
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([key, child], index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            aria-label="key"
            className="h-8 w-28 font-mono text-xs"
            value={key}
            onChange={(event) =>
              setEntries(
                entries.map((entry, position) =>
                  position === index ? [event.target.value, entry[1]] : entry,
                ),
              )
            }
          />
          <ValueExpressionEditor
            value={child as ValueExpression}
            fields={fields}
            onChange={(next) =>
              setEntries(
                entries.map((entry, position) => (position === index ? [entry[0], next] : entry)),
              )
            }
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="削除"
            onClick={() => setEntries(entries.filter((_, position) => position !== index))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEntries([...entries, [`key${entries.length + 1}`, literal("")]])}
        >
          <PlusIcon /> field
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(field(fields[0] ?? "workflow.input"))}
        >
          式にする
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setJson(JSON.stringify(value, null, 2))}>
          JSON
        </Button>
      </div>
    </div>
  );
}
