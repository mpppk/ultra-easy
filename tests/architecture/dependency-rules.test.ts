import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";
import * as ts from "typescript";

const coreRoot = fileURLToPath(new URL("../../packages/approval-core/src/", import.meta.url));
const allowedExternalImports = new Set(["@standard-schema/spec"]);

function listProductionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return listProductionTypeScriptFiles(path);
    }

    if (
      extname(entry.name) !== ".ts" ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".type-test.ts")
    ) {
      return [];
    }

    return [path];
  });
}

function collectModuleSpecifiers(sourceText: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

describe("approval-coreの依存境界", () => {
  it("AC-M0-003: production coreはStandard Schema以外の外部packageへ依存しない", () => {
    const violations = listProductionTypeScriptFiles(coreRoot).flatMap((file) => {
      const source = readFileSync(file, "utf-8");
      const specifiers = collectModuleSpecifiers(source, file);

      return specifiers
        .filter((specifier) => !specifier.startsWith("."))
        .filter((specifier) => !allowedExternalImports.has(specifier))
        .map((specifier) => `${file}: ${specifier}`);
    });

    expect(violations).toEqual([]);
  });
});
