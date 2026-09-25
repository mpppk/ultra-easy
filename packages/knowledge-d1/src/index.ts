export * from "./db.ts";
export * from "./page-repository.ts";
export * from "./publication-effect-repository.ts";
export * from "./publication-repository.ts";
export * from "./revision-repository.ts";
export * from "./search-repository.ts";
export * from "./space-repository.ts";

import type { D1DatabaseLike } from "./db.ts";
import { D1PageRepository } from "./page-repository.ts";
import { D1PublicationEffectRepository } from "./publication-effect-repository.ts";
import { D1PublicationRepository } from "./publication-repository.ts";
import { D1RevisionRepository } from "./revision-repository.ts";
import { D1SearchRepository } from "./search-repository.ts";
import { D1SpaceRepository } from "./space-repository.ts";

export type KnowledgeRepositories = {
  spaces: D1SpaceRepository;
  pages: D1PageRepository;
  revisions: D1RevisionRepository;
  publications: D1PublicationRepository;
  search: D1SearchRepository;
  effects: D1PublicationEffectRepository;
};

export function knowledgeRepositories(db: D1DatabaseLike): KnowledgeRepositories {
  return {
    spaces: new D1SpaceRepository(db),
    pages: new D1PageRepository(db),
    revisions: new D1RevisionRepository(db),
    publications: new D1PublicationRepository(db),
    search: new D1SearchRepository(db),
    effects: new D1PublicationEffectRepository(db),
  };
}
