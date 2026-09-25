import { readFileSync, readdirSync } from "node:fs";

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PageBadgePill, StepPill } from "#components/knowledge/badges";
import { MarkdownView } from "#components/knowledge/markdown-view";
import { EmptyState, ErrorState, NotFoundState } from "#components/layout/states";

const stylesPath = new URL("../styles.css", import.meta.url);

function tokenNames(block: string): string[] {
  return [...block.matchAll(/--([a-z-]+)\s*:/g)].map((match) => match[1] ?? "").sort();
}

function cssBlock(source: string, opener: string): string {
  const start = source.indexOf(opener);
  expect(start, `${opener} block`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

describe("Knowledge UI foundation", () => {
  it("light and dark themes define the same semantic tokens", () => {
    const source = readFileSync(stylesPath, "utf8");
    const light = tokenNames(cssBlock(source, ":root {"));
    const dark = tokenNames(cssBlock(source, "@media (prefers-color-scheme: dark) {"));
    const theme = cssBlock(source, "@theme inline");
    expect(dark).toEqual(light.filter((name) => name !== "radius"));
    for (const name of dark) {
      expect(theme, `--color-${name} mapping`).toContain(`--color-${name}: var(--${name});`);
    }
  });

  it("generated ui components never import feature code", () => {
    const directory = new URL("./ui/", import.meta.url);
    for (const file of readdirSync(directory)) {
      const source = readFileSync(new URL(file, directory), "utf8");
      for (const [, specifier = ""] of source.matchAll(/from "([^"]+)"/g)) {
        expect(
          specifier.startsWith("#") ? specifier.startsWith("#components/ui/") : true,
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("state and status primitives render with semantic tokens", () => {
    const html = renderToString(
      <>
        <EmptyState title="No results found" description="Try different keywords." />
        <ErrorState code="platform_unavailable" />
        <NotFoundState />
        <PageBadgePill badge="draft_changes" />
        <StepPill status="waiting" />
      </>,
    );
    for (const slot of ["empty-state", "error-state", "not-found-state", "pill"]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain("Page not found or forbidden");
    expect(html).toContain("text-warning");
    expect(html).not.toMatch(/(bg|text)-(red|green|blue|amber)-\d/);
  });

  it("renders Markdown without raw HTML", () => {
    const html = renderToString(
      <MarkdownView markdown={"# Title\n\n<script>alert(1)</script>\n\n| a |\n|---|\n| b |"} />,
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script>");
  });
});
