import {
  describeMcpInvocationRepositoryContract,
  describeMcpRouteSnapshotRepositoryContract,
} from "./repository-contract.ts";
import { InMemoryMcpInvocationRepository, InMemoryMcpRouteSnapshotRepository } from "./memory.ts";

describeMcpInvocationRepositoryContract(
  "InMemoryMcpInvocationRepository",
  () => new InMemoryMcpInvocationRepository(),
);
describeMcpRouteSnapshotRepositoryContract(
  "InMemoryMcpRouteSnapshotRepository",
  () => new InMemoryMcpRouteSnapshotRepository(),
);
