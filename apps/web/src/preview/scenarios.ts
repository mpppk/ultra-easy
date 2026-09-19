export const previewScenarios = [
  "no-approval",
  "serial-two-users",
  "parallel-all",
  "parallel-quorum",
  "distinct-approvers",
] as const;

export type PreviewScenario = (typeof previewScenarios)[number];

export function isPreviewScenario(value: unknown): value is PreviewScenario {
  return typeof value === "string" && previewScenarios.includes(value as PreviewScenario);
}
