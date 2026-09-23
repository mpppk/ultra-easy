import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "#components/ui/button";
import { Dialog, DialogTrigger } from "#components/ui/dialog";
import { Table, TableBody, TableCell, TableRow } from "#components/ui/table";

describe("setup", () => {
  it("resolves package imports and renders shared primitives on the server", () => {
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(Button, null, "Continue"),
        createElement(Dialog, null, createElement(DialogTrigger, null, "Open details")),
        createElement(
          Table,
          { "aria-label": "Approval requests" },
          createElement(
            TableBody,
            null,
            createElement(TableRow, null, createElement(TableCell, null, "Request 123")),
          ),
        ),
      ),
    );

    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain("Continue");
    expect(markup).toContain('data-slot="dialog-trigger"');
    expect(markup).toContain('aria-label="Approval requests"');
    expect(markup).toContain("Request 123");
  });

  it("defines semantic tokens for light and dark themes", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

    for (const selector of [":root", ".dark"]) {
      const declarations = styles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1];

      expect(declarations).toContain("--background:");
      expect(declarations).toContain("--foreground:");
      expect(declarations).toContain("--primary:");
      expect(declarations).toContain("--destructive:");
    }
  });
});
