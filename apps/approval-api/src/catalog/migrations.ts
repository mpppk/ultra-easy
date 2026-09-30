import { readdirSync, readFileSync } from "node:fs";

import { Result } from "@praha/byethrow";

import {
  parseCatalogMarkers,
  planCatalogMigration,
  renderCatalogEntries,
  type ApplicationCatalog,
  type CatalogEntry,
  type CatalogManifestError,
} from "./manifest.ts";

export const MIGRATIONS_DIRECTORY = new URL(
  "../../../../packages/approval-d1/migrations/",
  import.meta.url,
);

/** 既存migration（全file）に記録済みのcatalog entry（id → digest）。 */
export function registeredCatalogEntries(
  directory: URL = MIGRATIONS_DIRECTORY,
): Map<string, string> {
  const markers = new Map<string, string>();
  for (const name of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    for (const [id, digest] of parseCatalogMarkers(
      readFileSync(new URL(name, directory), "utf8"),
    )) {
      markers.set(id, digest);
    }
  }
  return markers;
}

export function nextMigrationName(
  application: string,
  directory: URL = MIGRATIONS_DIRECTORY,
): string {
  const numbers = readdirSync(directory)
    .map((name) => /^(\d{4})_/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const next = String(Math.max(0, ...numbers) + 1).padStart(4, "0");
  return `${next}_${application}_catalog.sql`;
}

/** catalogのうち、まだmigrationに無いentryと、そのmigration SQL（無ければnull）。 */
export async function pendingCatalogMigration(
  catalog: ApplicationCatalog,
  directory: URL = MIGRATIONS_DIRECTORY,
): Result.ResultAsync<{ entries: CatalogEntry[]; sql: string | null }, CatalogManifestError> {
  const entries = await renderCatalogEntries(catalog);
  if (Result.isFailure(entries)) return entries;
  return planCatalogMigration({
    application: catalog.application,
    entries: entries.value,
    existing: registeredCatalogEntries(directory),
  });
}
