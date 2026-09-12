from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 match, got {count}")
    path.write_text(text.replace(old, new))


materialization = Path("packages/approval-core/src/materialization.ts")
replace_once(
    materialization,
    '''  if (bindingResolution.type === "error") {
    return asMaterializationError(
      new MaterializationFailure(
        "binding_resolution_error",
        bindingResolution.error.message,
        bindingResolution.error.path,
      ),
    );
  }

  const policyBindingSnapshots: PolicyBindingSnapshot[] = [];
  const materializedFlows: MaterializedFlow[] = [];

  for (const binding of bindingResolution.bindings) {''',
    '''  if (Result.isFailure(bindingResolution)) {
    return asMaterializationError(
      new MaterializationFailure(
        "binding_resolution_error",
        bindingResolution.error.cause.message,
        bindingResolution.error.cause.path,
      ),
    );
  }

  const policyBindingSnapshots: PolicyBindingSnapshot[] = [];
  const materializedFlows: MaterializedFlow[] = [];

  for (const binding of bindingResolution.value) {''',
    "materialization binding resolution",
)
replace_once(
    materialization,
    '''    const evaluation = evaluatePolicy(source.policy, input.context);
    if (evaluation.type === "error") {
      return asMaterializationError(
        new MaterializationFailure(
          "policy_evaluation_error",
          evaluation.error.message,
          evaluation.error.path,
        ),
      );
    }
''',
    '''    const evaluation = evaluatePolicy(source.policy, input.context);
    if (Result.isFailure(evaluation)) {
      return asMaterializationError(
        new MaterializationFailure(
          "policy_evaluation_error",
          evaluation.error.cause.message,
          evaluation.error.cause.path,
        ),
      );
    }
''',
    "materialization policy evaluation",
)
replace_once(
    materialization,
    '''    const outcome: PolicyBindingSnapshotOutcome =
      evaluation.type === "matched"
        ? { type: "matched", ruleKey: evaluation.ruleKey, flowType: evaluation.flow.type }
        : { type: "not_matched" };''',
    '''    const outcome: PolicyBindingSnapshotOutcome =
      evaluation.value.type === "matched"
        ? {
            type: "matched",
            ruleKey: evaluation.value.ruleKey,
            flowType: evaluation.value.flow.type,
          }
        : { type: "not_matched" };''',
    "materialization snapshot outcome",
)
replace_once(
    materialization,
    '''    if (evaluation.type === "matched" && evaluation.flow.type !== "none") {
      const materialized = await materializeFlow(
        evaluation.flow,''',
    '''    if (evaluation.value.type === "matched" && evaluation.value.flow.type !== "none") {
      const materialized = await materializeFlow(
        evaluation.value.flow,''',
    "materialization flow",
)

acceptance = Path("tests/acceptance/m1-policy-core.test.ts")
text = acceptance.read_text()
if 'import { Result } from "@praha/byethrow";' not in text:
    text = text.replace(
        'import { describe, expect, it } from "vite-plus/test";\n',
        'import { Result } from "@praha/byethrow";\nimport { describe, expect, it } from "vite-plus/test";\n',
        1,
    )
acceptance.write_text(text)

replace_once(
    acceptance,
    '''    expect(result.type).toBe("matched");
    if (result.type !== "matched") return;
    expect(String(result.ruleKey)).toBe("critical");
    expect(result.flow).toEqual(managerFlow);''',
    '''    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.value.type).toBe("matched");
    if (result.value.type !== "matched") return;
    expect(String(result.value.ruleKey)).toBe("critical");
    expect(result.value.flow).toEqual(managerFlow);''',
    "AC-M1-001",
)
replace_once(
    acceptance,
    '''    expect(first).toEqual(second);
    expect(first.type).toBe("compiled");
    if (first.type !== "compiled") return;
    expect(first.flow).toEqual({
      type: "serial",
      children: [managerFlow, securityFlow],
      constraints: { distinctApprovers: true },
    });''',
    '''    expect(first).toEqual(second);
    expect(Result.isSuccess(first)).toBe(true);
    if (Result.isFailure(first)) return;
    expect(first.value.flow).toEqual({
      type: "serial",
      children: [managerFlow, securityFlow],
      constraints: { distinctApprovers: true },
    });''',
    "AC-M1-002",
)
replace_once(
    acceptance,
    '''    expect(mixed.type === "compiled" ? mixed.flow : mixed).toEqual(managerFlow);

    const onlyNone = evaluateApprovalPlan({
      context: ticketContext(),
      bindings: [noApprovalBinding],
      policies: [noApprovalPolicy],
    });
    expect(onlyNone.type === "compiled" ? onlyNone.flow : onlyNone).toEqual({ type: "none" });''',
    '''    expect(mixed).toMatchObject({ type: "Success", value: { flow: managerFlow } });

    const onlyNone = evaluateApprovalPlan({
      context: ticketContext(),
      bindings: [noApprovalBinding],
      policies: [noApprovalPolicy],
    });
    expect(onlyNone).toMatchObject({
      type: "Success",
      value: { flow: { type: "none" } },
    });''',
    "AC-M1-003",
)
replace_once(
    acceptance,
    '''    expect(evaluateCondition(condition, purchaseContext({ currency: "JPY" }))).toMatchObject({
      type: "error",
      code: "field_missing",
    });
    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: "500000", currency: "JPY" })),
    ).toMatchObject({ type: "error", code: "type_mismatch" });
    expect(
      evaluateCondition(
        condition,
        purchaseContext({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "JPY" }),
      ),
    ).toMatchObject({ type: "error", code: "invalid_number" });''',
    '''    expect(evaluateCondition(condition, purchaseContext({ currency: "JPY" }))).toMatchObject({
      type: "Failure",
      error: { code: "field_missing" },
    });
    expect(
      evaluateCondition(condition, purchaseContext({ amountMinor: "500000", currency: "JPY" })),
    ).toMatchObject({ type: "Failure", error: { code: "type_mismatch" } });
    expect(
      evaluateCondition(
        condition,
        purchaseContext({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: "JPY" }),
      ),
    ).toMatchObject({ type: "Failure", error: { code: "invalid_number" } });''',
    "AC-M1-004",
)

text = acceptance.read_text()
for old, new in [
    (
        'evaluateCondition(condition, purchaseContext({ amountMinor: 499_999, currency: "JPY" })).type,\n    ).toBe("not_matched");',
        'evaluateCondition(condition, purchaseContext({ amountMinor: 499_999, currency: "JPY" })),\n    ).toMatchObject({ type: "Success", value: { type: "not_matched" } });',
    ),
    (
        'evaluateCondition(condition, purchaseContext({ amountMinor: 500_000, currency: "JPY" })).type,\n    ).toBe("matched");',
        'evaluateCondition(condition, purchaseContext({ amountMinor: 500_000, currency: "JPY" })),\n    ).toMatchObject({ type: "Success", value: { type: "matched" } });',
    ),
    (
        'evaluateCondition(condition, purchaseContext({ amountMinor: 500_001, currency: "JPY" })).type,\n    ).toBe("matched");',
        'evaluateCondition(condition, purchaseContext({ amountMinor: 500_001, currency: "JPY" })),\n    ).toMatchObject({ type: "Success", value: { type: "matched" } });',
    ),
    (
        'evaluateCondition(condition, purchaseContext({ amountMinor: 500_001, currency: "USD" })).type,\n    ).toBe("not_matched");',
        'evaluateCondition(condition, purchaseContext({ amountMinor: 500_001, currency: "USD" })),\n    ).toMatchObject({ type: "Success", value: { type: "not_matched" } });',
    ),
]:
    if text.count(old) != 1:
        raise RuntimeError(f"money condition pattern mismatch: {old}")
    text = text.replace(old, new)
acceptance.write_text(text)

replace_once(
    acceptance,
    '''    expect(result.type).toBe("resolved");
    if (result.type !== "resolved") return;
    expect(result.bindings.map((binding) => String(binding.id))).toEqual([
      "binding:exact",
      "binding:prefix",
    ]);''',
    '''    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) return;
    expect(result.value.map((binding) => String(binding.id))).toEqual([
      "binding:exact",
      "binding:prefix",
    ]);''',
    "AC-M1-006",
)
replace_once(
    acceptance,
    '''      ).type,
    ).toBe("matched");''',
    '''      ),
    ).toMatchObject({ type: "Success", value: { type: "matched" } });''',
    "field namespace",
)
replace_once(
    acceptance,
    '''    expect(critical.type === "compiled" ? critical.flow : critical).toEqual(managerFlow);
    expect(normal.type === "compiled" ? normal.flow : normal).toEqual({ type: "none" });''',
    '''    expect(critical).toMatchObject({ type: "Success", value: { flow: managerFlow } });
    expect(normal).toMatchObject({
      type: "Success",
      value: { flow: { type: "none" } },
    });''',
    "ticket demo",
)
