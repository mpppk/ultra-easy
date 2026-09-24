import { Result } from "@praha/byethrow";

import {
  RelationshipGatewayError,
  type OrganizationId,
  type RelationshipTuple,
  type RelationshipTupleGateway,
} from "@app/approval-core";

import { openFgaFailureEffect, type OpenFgaClient, type OpenFgaRequestError } from "./openfga.ts";

function gatewayError(error: OpenFgaRequestError): RelationshipGatewayError {
  return new RelationshipGatewayError(
    error.code === "http_error" && error.status !== undefined
      ? `fga_http_${error.status}`
      : error.code,
    openFgaFailureEffect(error),
    error.retriable,
    error.message,
  );
}

/**
 * Tuple mutation capability for console-managed relationships. Only the
 * relationship executor / reconciler composition roots construct this; the
 * admin read API gets read-only ports.
 */
export class OpenFgaRelationshipTupleGateway implements RelationshipTupleGateway {
  readonly authorizationModelId: string;
  private readonly clientFor: (organizationId: OrganizationId) => OpenFgaClient;

  constructor(options: {
    authorizationModelId: string;
    clientFor: (organizationId: OrganizationId) => OpenFgaClient;
  }) {
    this.authorizationModelId = options.authorizationModelId;
    this.clientFor = options.clientFor;
  }

  async read(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
  }): Result.ResultAsync<boolean, RelationshipGatewayError> {
    const read = await this.clientFor(input.organizationId).readTuple({
      tuple: input.tuple,
      consistency: "higher_consistency",
    });
    return Result.isFailure(read) ? Result.fail(gatewayError(read.error)) : read;
  }

  async apply(input: {
    organizationId: OrganizationId;
    tuple: RelationshipTuple;
    present: boolean;
  }): Result.ResultAsync<void, RelationshipGatewayError> {
    const written = await this.clientFor(input.organizationId).writeTuples(
      input.present ? { writes: [input.tuple] } : { deletes: [input.tuple] },
    );
    return Result.isFailure(written) ? Result.fail(gatewayError(written.error)) : written;
  }
}
