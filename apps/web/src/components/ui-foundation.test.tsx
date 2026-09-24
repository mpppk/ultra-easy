import { readFileSync, readdirSync } from "node:fs";

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PageContainer, PageHeader, PageSection, Toolbar } from "#components/layout/page";
import { EmptyState, ErrorState, LoadingState } from "#components/layout/states";
import { Badge } from "#components/ui/badge";
import { Button } from "#components/ui/button";
import { Dialog, DialogTrigger } from "#components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#components/ui/tabs";
import { TooltipProvider } from "#components/ui/tooltip";
import { cn } from "#lib/utils";

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

describe("M9-0 Web UI foundation", () => {
  it("AC-M9-UI-002: package imports (#components / #lib) resolve generated components", () => {
    expect(typeof Button).toBe("function");
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("AC-M9-UI-004: representative shadcn components render with semantic token classes", () => {
    const html = renderToString(
      <TooltipProvider>
        <PageContainer>
          <PageHeader title="Title" description="Description" actions={<Button>Act</Button>} />
          <PageSection title="Section">
            <Toolbar>
              <Badge variant="destructive">deny</Badge>
            </Toolbar>
            <Tabs defaultValue="one">
              <TabsList>
                <TabsTrigger value="one">One</TabsTrigger>
              </TabsList>
              <TabsContent value="one">content</TabsContent>
            </Tabs>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>user:alice</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open</Button>
              </DialogTrigger>
            </Dialog>
            <EmptyState title="Nothing here" />
            <ErrorState title="Failed" code="provider_unavailable" />
            <LoadingState />
          </PageSection>
        </PageContainer>
      </TooltipProvider>,
    );

    for (const slot of [
      "page-container",
      "page-header",
      "toolbar",
      "badge",
      "tabs",
      "table",
      "dialog-trigger",
      "empty-state",
      "error-state",
      "loading-state",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("code: <code");
  });

  it("AC-M9-UI-004: light and dark themes define the same semantic tokens", () => {
    const source = readFileSync(stylesPath, "utf8");
    const light = tokenNames(cssBlock(source, ":root {"));
    const dark = tokenNames(cssBlock(source, "@media (prefers-color-scheme: dark) {"));
    const theme = cssBlock(source, "@theme inline");

    expect(dark).toEqual(light.filter((name) => name !== "radius"));
    for (const name of dark) {
      expect(theme, `--color-${name} mapping`).toContain(`--color-${name}: var(--${name});`);
    }
  });

  it("AC-M9-UI-007: generated ui components never import feature code", () => {
    const directory = new URL("./ui/", import.meta.url);
    for (const file of readdirSync(directory)) {
      const source = readFileSync(new URL(file, directory), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const specifier of imports) {
        expect(
          specifier.startsWith("#") ? specifier.startsWith("#components/ui/") : true,
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
