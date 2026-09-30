// Application Catalog（#198）のcatalog migrationを生成する。
// 既存migrationに記録済みのversionは変更しない（内容が変わっていればerror）。新しいversionだけを
// 次の番号のmigrationとして書き出す。出力はreviewしてcommitし、deploy時の
// `wrangler d1 migrations apply` で適用する（docs/application-catalog.md）。
// 実行: vp -C apps/approval-api run generate:catalog
import { writeFileSync } from "node:fs";

import { Result } from "@praha/byethrow";

import { APPLICATION_CATALOGS } from "../src/catalog/knowledge.ts";
import {
  MIGRATIONS_DIRECTORY,
  nextMigrationName,
  pendingCatalogMigration,
} from "../src/catalog/migrations.ts";

for (const catalog of APPLICATION_CATALOGS) {
  const pending = await pendingCatalogMigration(catalog);
  if (Result.isFailure(pending)) {
    console.error(`${catalog.application}: ${pending.error.code}\n${pending.error.message}`);
    process.exitCode = 1;
    continue;
  }
  if (!pending.value.sql) {
    console.log(`${catalog.application}: up to date`);
    continue;
  }
  const name = nextMigrationName(catalog.application);
  writeFileSync(new URL(name, MIGRATIONS_DIRECTORY), pending.value.sql);
  console.log(
    `${catalog.application}: wrote ${name} (${pending.value.entries.map((entry) => entry.id).join(", ")})`,
  );
}
