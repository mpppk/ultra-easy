export type ProgramSourceIssue = { code: string; message: string };

export const MAX_PROGRAM_SOURCE_BYTES = 64 * 1024;

/**
 * sandboxの外側で行う静的検証（defense in depth）。sandbox自体がnetwork / module / processを
 * 持たないが、生成コードがそれらへ依存しようとしていること自体を早期に拒否し、
 * 外部能力はEffect（ue.action / ue.llm / ue.sleep / ue.askHuman）でだけ要求させる。
 */
const FORBIDDEN: { pattern: RegExp; code: string; message: string }[] = [
  {
    pattern: /\bimport\s*[({"'`\w*]/,
    code: "module_import",
    message: "import（module読み込み）は使えません",
  },
  { pattern: /\brequire\s*\(/, code: "module_require", message: "requireは使えません" },
  {
    pattern: /\bfetch\s*\(/,
    code: "network_access",
    message: "fetch（network）は使えません。ue.actionを使ってください",
  },
  {
    pattern: /\b(XMLHttpRequest|WebSocket|EventSource)\b/,
    code: "network_access",
    message: "networkは使えません",
  },
  {
    pattern: /\b(process|Deno|Bun)\s*\./,
    code: "host_access",
    message: "host runtimeへのアクセスは使えません",
  },
  {
    pattern: /__ue_/,
    code: "reserved_identifier",
    message: "__ue_で始まる識別子は予約されています",
  },
];

export function validateProgramSource(source: string): ProgramSourceIssue[] {
  const issues: ProgramSourceIssue[] = [];
  if (new TextEncoder().encode(source).byteLength > MAX_PROGRAM_SOURCE_BYTES) {
    issues.push({
      code: "source_too_large",
      message: `sourceは${MAX_PROGRAM_SOURCE_BYTES} bytes以下である必要があります`,
    });
  }
  if (!/\bfunction\s+main\s*\(/.test(source)) {
    issues.push({
      code: "main_missing",
      message: "function main(input, context) を定義してください",
    });
  }
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(source)) issues.push({ code: rule.code, message: rule.message });
  }
  return issues;
}
