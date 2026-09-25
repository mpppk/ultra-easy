/**
 * Deterministic stand-in for the ultra-easy LLM Effect / LLM Gateway.
 *
 * Output is an *untrusted suggestion*: it never decides authorization, never
 * skips a mandatory approval and never archives on its own (archive always goes
 * through an ActionRequest with approval / human input).
 */

const STOP_WORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with you your use using should".split(
    " ",
  ),
);

export type MetadataAnalysis = {
  summary: string;
  suggestedTags: string[];
  riskSignals: string[];
};

export function analyzeMetadata(input: {
  title: string;
  body: string;
  tags: string[];
}): MetadataAnalysis {
  const text = input.body.replace(/```[\s\S]*?```/g, " ").replace(/[#>*_`[\]()!-]/g, " ");
  const sentence = text
    .split(/(?<=[.!?])\s+/u)
    .find((part) => part.trim().length > 20)
    ?.trim();
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}]{3,}/gu) ?? []) {
    if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const existing = new Set(input.tags.map((tag) => tag.toLowerCase()));
  const suggestedTags = [...counts.entries()]
    .filter(([word]) => !existing.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);
  const riskSignals = /password|secret|api[_ ]?key|token/i.test(input.body)
    ? ["mentions credentials"]
    : [];
  return { summary: sentence ?? input.title, suggestedTags, riskSignals };
}

export type FreshnessVerdict = "likely_current" | "needs_review" | "archive_candidate";

export function assessFreshness(input: {
  title: string;
  body: string;
  publishedAt: string | null;
  lastReviewedAt: string | null;
  now: string;
}): { verdict: FreshnessVerdict; analysis: string } {
  if (/\b(deprecated|obsolete|no longer (used|supported|maintained))\b/i.test(input.body)) {
    return {
      verdict: "archive_candidate",
      analysis: "The page describes itself as deprecated / no longer used.",
    };
  }
  const reference = Math.max(
    input.publishedAt ? Date.parse(input.publishedAt) : 0,
    input.lastReviewedAt ? Date.parse(input.lastReviewedAt) : 0,
  );
  const ageDays = Math.floor((Date.parse(input.now) - reference) / (24 * 60 * 60 * 1000));
  if (ageDays > 180 || /\b(todo|tbd|20(1\d|2[0-3]))\b/i.test(input.body)) {
    return {
      verdict: "needs_review",
      analysis: `Last confirmed ${ageDays} days ago and references possibly outdated details.`,
    };
  }
  return {
    verdict: "likely_current",
    analysis: `Last confirmed ${ageDays} days ago; no outdated signals found.`,
  };
}
