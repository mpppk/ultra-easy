import { Result } from "@praha/byethrow";

import { parseBrand, sha256Text } from "@app/approval-core";
import type { OrganizationId } from "@app/approval-core";
import type { JsonValue } from "@app/expression-core";
import {
  DEFAULT_SANDBOX_LIMITS,
  MAX_SANDBOX_LIMITS,
  parseWorkflowId,
  validateJsonSchemaLite,
} from "@app/workflow-core";
import type {
  JsonSchemaLite,
  NodeRunId,
  ProgramCapabilityManifest,
  ProgramEffect,
  ProgramGeneratorMetadata,
  ProgramNodeReference,
  ProgramNodeVersion,
  ProgramResult,
  SandboxAdapter,
  SandboxLimits,
  WorkflowRunId,
} from "@app/workflow-core";

import { EffectHandlerError } from "./ports.ts";
import type {
  EffectContext,
  EffectHandler,
  EffectOutcomeReport,
  WorkflowRepositoryError,
} from "./ports.ts";

export interface ProgramRepository {
  /** insert-only。同じ(programId, version)に別sourceを保存しようとした場合はconflict error。 */
  save(input: {
    organizationId: OrganizationId;
    version: ProgramNodeVersion;
  }): Result.ResultAsync<{ type: "created" | "existing" }, WorkflowRepositoryError>;
  load(input: {
    organizationId: OrganizationId;
    programId: string;
    version: number;
  }): Result.ResultAsync<ProgramNodeVersion | null, WorkflowRepositoryError>;
  latest(input: {
    organizationId: OrganizationId;
    programId: string;
  }): Result.ResultAsync<ProgramNodeVersion | null, WorkflowRepositoryError>;
  list(input: {
    organizationId: OrganizationId;
  }): Result.ResultAsync<ProgramNodeVersion[], WorkflowRepositoryError>;
}

/** 自然言語からProgram sourceを生成するCoding LLM（LLM Gateway経由, #161）。 */
export interface ProgramCodeGenerator {
  generate(input: {
    organizationId: OrganizationId;
    instruction: string;
    inputSchema: JsonSchemaLite;
    outputSchema: JsonSchemaLite;
    requestedCapabilities: ProgramCapabilityManifest;
    model?: string;
  }): Result.ResultAsync<{ source: string; model: string }, EffectHandlerError>;
}

/** sandboxの同時実行数等のadmission（#161 Resource Governor）。 */
export interface SandboxAdmission {
  acquire(input: {
    organizationId: OrganizationId;
    runId?: WorkflowRunId;
    nodeRunId?: NodeRunId;
  }): Result.ResultAsync<
    | { type: "admitted"; release: () => Promise<void> }
    | { type: "denied"; code: string; message: string },
    EffectHandlerError
  >;
}

export type ProgramSourceValidator = (source: string) => { code: string; message: string }[];

export type ProgramTestCase = { input: JsonValue; expectedOutput?: JsonValue };

export type ProgramTestResult = {
  input: JsonValue;
  status: "passed" | "failed";
  output?: JsonValue;
  yielded?: ProgramEffect["type"];
  error?: { code: string; message: string };
  logs: string[];
};

export type ProgramDraft = {
  programId: string;
  source: string;
  sourceDigest: string;
  inputSchema: JsonSchemaLite;
  outputSchema: JsonSchemaLite;
  requestedCapabilities: ProgramCapabilityManifest;
  runtimeProfile: SandboxLimits;
  generator: ProgramGeneratorMetadata;
  description?: string;
  issues: { code: string; message: string }[];
  tests: ProgramTestResult[];
  /** 静的検証とtest sandboxがすべて通ったか（publishの前提）。 */
  ready: boolean;
};

function withinLimits(profile: SandboxLimits): boolean {
  return (Object.keys(MAX_SANDBOX_LIMITS) as (keyof SandboxLimits)[]).every(
    (key) =>
      Number.isInteger(profile[key]) && profile[key] > 0 && profile[key] <= MAX_SANDBOX_LIMITS[key],
  );
}

/** Programがyieldした作用が、自身のrequested manifestの範囲か（宣言していない能力は使えない）。 */
export function effectWithinManifest(
  effect: ProgramEffect,
  manifest: ProgramCapabilityManifest,
): boolean {
  if (effect.type === "action") {
    return (manifest.actions ?? []).some(
      (action) =>
        action.actionType === effect.actionType &&
        (action.resourceType === undefined || action.resourceType === effect.resource.type),
    );
  }
  if (effect.type === "llm")
    return manifest.llm !== undefined && manifest.llm.models.includes(effect.model);
  return true;
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function digestOf(source: string): Result.ResultAsync<string, EffectHandlerError> {
  const digest = await sha256Text(source);
  if (Result.isFailure(digest))
    return Result.fail(
      new EffectHandlerError("program_digest_failed", false, digest.error.message),
    );
  return Result.succeed(String(digest.value));
}

/**
 * Program Nodeのauthoring（#160）:
 * `Natural language -> Coding LLM -> generated program -> static validation -> test sandbox -> immutable ProgramNodeVersion`
 *
 * runtimeでは毎回コード生成せず、publish済みversionのsourceだけを実行する。
 */
export class ProgramAuthoringService {
  constructor(
    private readonly deps: {
      programs: ProgramRepository;
      sandbox: SandboxAdapter;
      validateSource: ProgramSourceValidator;
      generator?: ProgramCodeGenerator;
      clock: { now(): string };
    },
  ) {}

  private async test(
    source: string,
    draft: Pick<
      ProgramDraft,
      "inputSchema" | "outputSchema" | "requestedCapabilities" | "runtimeProfile"
    >,
    samples: readonly ProgramTestCase[],
  ): Promise<ProgramTestResult[]> {
    const results: ProgramTestResult[] = [];
    for (const sample of samples) {
      const inputIssues = validateJsonSchemaLite(draft.inputSchema, sample.input);
      if (inputIssues.length > 0) {
        results.push({
          input: sample.input,
          status: "failed",
          error: {
            code: "sample_input_invalid",
            message: inputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
          },
          logs: [],
        });
        continue;
      }
      const ran = await this.deps.sandbox.run({
        source,
        input: sample.input,
        limits: draft.runtimeProfile,
      });
      if (Result.isFailure(ran)) {
        results.push({
          input: sample.input,
          status: "failed",
          error: { code: ran.error.code, message: ran.error.message },
          logs: [],
        });
        continue;
      }
      const result: ProgramResult = ran.value.result;
      if (result.type === "yield") {
        const allowed = effectWithinManifest(result.effect, draft.requestedCapabilities);
        results.push({
          input: sample.input,
          status: allowed ? "passed" : "failed",
          yielded: result.effect.type,
          ...(allowed
            ? {}
            : {
                error: {
                  code: "capability_not_requested",
                  message: `${result.effect.type}作用がmanifestに宣言されていません`,
                },
              }),
          logs: ran.value.logs,
        });
        continue;
      }
      const outputIssues = validateJsonSchemaLite(draft.outputSchema, result.output);
      const expectedMatches =
        sample.expectedOutput === undefined || sameJson(sample.expectedOutput, result.output);
      results.push({
        input: sample.input,
        status: outputIssues.length === 0 && expectedMatches ? "passed" : "failed",
        output: result.output,
        ...(outputIssues.length > 0
          ? {
              error: {
                code: "output_schema_mismatch",
                message: outputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
              },
            }
          : !expectedMatches
            ? {
                error: {
                  code: "expected_output_mismatch",
                  message: "期待したoutputと一致しません",
                },
              }
            : {}),
        logs: ran.value.logs,
      });
    }
    return results;
  }

  /**
   * 自然言語（またはsource直接指定）からdraftを作り、静的検証とtest sandboxで検証する。
   * 生成結果はreviewされるまでpublishされない。
   */
  async draft(input: {
    organizationId: OrganizationId;
    programId: string;
    instruction?: string;
    source?: string;
    description?: string;
    inputSchema: JsonSchemaLite;
    outputSchema: JsonSchemaLite;
    requestedCapabilities?: ProgramCapabilityManifest;
    runtimeProfile?: Partial<SandboxLimits>;
    samples: ProgramTestCase[];
    model?: string;
  }): Result.ResultAsync<ProgramDraft, EffectHandlerError> {
    const now = this.deps.clock.now();
    let source = input.source;
    let generator: ProgramGeneratorMetadata = { kind: "manual", generatedAt: now };
    if (source === undefined) {
      if (!input.instruction || !this.deps.generator) {
        return Result.fail(
          new EffectHandlerError(
            "program_generator_unavailable",
            false,
            "instructionとcode generatorが必要です",
          ),
        );
      }
      const generated = await this.deps.generator.generate({
        organizationId: input.organizationId,
        instruction: input.instruction,
        inputSchema: input.inputSchema,
        outputSchema: input.outputSchema,
        requestedCapabilities: input.requestedCapabilities ?? {},
        ...(input.model ? { model: input.model } : {}),
      });
      if (Result.isFailure(generated)) return generated;
      source = generated.value.source;
      const instructionDigest = await digestOf(input.instruction);
      if (Result.isFailure(instructionDigest)) return instructionDigest;
      generator = {
        kind: "llm",
        model: generated.value.model,
        instructionDigest: instructionDigest.value,
        generatedAt: now,
      };
    }
    const sourceDigest = await digestOf(source);
    if (Result.isFailure(sourceDigest)) return sourceDigest;
    const runtimeProfile: SandboxLimits = { ...DEFAULT_SANDBOX_LIMITS, ...input.runtimeProfile };
    const issues = [...this.deps.validateSource(source)];
    if (!withinLimits(runtimeProfile)) {
      issues.push({
        code: "runtime_profile_out_of_range",
        message: "runtime profileが上限を超えています",
      });
    }
    if (input.samples.length === 0) {
      issues.push({
        code: "test_samples_required",
        message: "test sandboxで検証するsampleが必要です",
      });
    }
    const base = {
      inputSchema: input.inputSchema,
      outputSchema: input.outputSchema,
      requestedCapabilities: input.requestedCapabilities ?? {},
      runtimeProfile,
    };
    const tests = issues.length > 0 ? [] : await this.test(source, base, input.samples);
    return Result.succeed({
      programId: input.programId,
      source,
      sourceDigest: sourceDigest.value,
      ...base,
      generator,
      ...(input.description !== undefined ? { description: input.description } : {}),
      issues,
      tests,
      ready:
        issues.length === 0 && tests.length > 0 && tests.every((test) => test.status === "passed"),
    });
  }

  /** draftを再検証・再testし、次のversionとしてimmutableに保存する。 */
  async publish(input: {
    organizationId: OrganizationId;
    draft: ProgramDraft;
    samples: ProgramTestCase[];
    publishedBy: string;
  }): Result.ResultAsync<
    { version: ProgramNodeVersion; reference: ProgramNodeReference },
    EffectHandlerError
  > {
    const { draft } = input;
    const digest = await digestOf(draft.source);
    if (Result.isFailure(digest)) return digest;
    if (digest.value !== draft.sourceDigest) {
      return Result.fail(
        new EffectHandlerError(
          "program_digest_mismatch",
          false,
          "draftのsource digestが一致しません",
        ),
      );
    }
    const issues = this.deps.validateSource(draft.source);
    const tests = issues.length > 0 ? [] : await this.test(draft.source, draft, input.samples);
    if (issues.length > 0 || tests.length === 0 || tests.some((test) => test.status !== "passed")) {
      return Result.fail(
        new EffectHandlerError(
          "program_not_ready",
          false,
          "静的検証またはtest sandboxが通っていません",
        ),
      );
    }
    const latest = await this.deps.programs.latest({
      organizationId: input.organizationId,
      programId: draft.programId,
    });
    if (Result.isFailure(latest)) {
      return Result.fail(
        new EffectHandlerError(latest.error.code, latest.error.retriable, latest.error.message),
      );
    }
    const version: ProgramNodeVersion = Object.freeze({
      programId: draft.programId,
      version: (latest.value?.version ?? 0) + 1,
      language: "javascript",
      source: draft.source,
      sourceDigest: draft.sourceDigest,
      inputSchema: draft.inputSchema,
      outputSchema: draft.outputSchema,
      requestedCapabilities: draft.requestedCapabilities,
      runtimeProfile: draft.runtimeProfile,
      generator: draft.generator,
      ...(draft.description !== undefined ? { description: draft.description } : {}),
      publishedAt: this.deps.clock.now(),
      publishedBy: input.publishedBy,
    });
    const saved = await this.deps.programs.save({ organizationId: input.organizationId, version });
    if (Result.isFailure(saved)) {
      return Result.fail(
        new EffectHandlerError(saved.error.code, saved.error.retriable, saved.error.message),
      );
    }
    const reference = programReference(version);
    if (Result.isFailure(reference)) return reference;
    return Result.succeed({ version, reference: reference.value });
  }
}

/** Program Nodeが参照する（programId, version, sourceDigest）。 */
export function programReference(
  version: ProgramNodeVersion,
): Result.Result<ProgramNodeReference, EffectHandlerError> {
  const programId = parseWorkflowId("ProgramId", version.programId);
  const sourceDigest = parseBrand("Sha256Digest", version.sourceDigest);
  if (Result.isFailure(programId) || Result.isFailure(sourceDigest)) {
    return Result.fail(
      new EffectHandlerError("program_reference_invalid", false, "Program referenceが不正です"),
    );
  }
  return Result.succeed({
    programId: programId.value,
    version: version.version,
    sourceDigest: sourceDigest.value,
  });
}

/**
 * Program作用のhandler（#160）。publish済みversionのsourceだけを、digestを照合してsandboxで実行する。
 * sandboxはinvocationごとに生成・破棄し、yieldした作用の待機中は何も保持しない
 * （再開はpersisted state + 作用の結果から新しいsandboxで行う）。
 */
export class ProgramEffectHandler implements EffectHandler {
  constructor(
    private readonly deps: {
      programs: ProgramRepository;
      sandbox: SandboxAdapter;
      admission?: SandboxAdmission;
      onRun?: (event: {
        programId: string;
        version: number;
        durationMs: number;
        logs: string[];
        logsTruncated: boolean;
      }) => void;
    },
  ) {}

  async dispatch(
    context: EffectContext,
  ): Result.ResultAsync<EffectOutcomeReport, EffectHandlerError> {
    const request = context.effect.request;
    if (request.kind !== "program") {
      return Result.succeed({
        type: "failed",
        code: "effect_kind_mismatch",
        message: "program作用ではありません",
      });
    }
    const organizationId = context.run.state.organizationId;
    const loaded = await this.deps.programs.load({
      organizationId,
      programId: String(request.program.programId),
      version: request.program.version,
    });
    if (Result.isFailure(loaded)) {
      return Result.fail(
        new EffectHandlerError(loaded.error.code, loaded.error.retriable, loaded.error.message),
      );
    }
    const version = loaded.value;
    if (!version)
      return Result.succeed({
        type: "failed",
        code: "program_not_found",
        message: "Program versionが見つかりません",
      });
    if (version.sourceDigest !== String(request.program.sourceDigest)) {
      return Result.succeed({
        type: "failed",
        code: "program_digest_mismatch",
        message: "Program Nodeが参照するdigestとpublish済みsourceが一致しません",
      });
    }
    if (!request.resume) {
      const inputIssues = validateJsonSchemaLite(version.inputSchema, request.input);
      if (inputIssues.length > 0) {
        return Result.succeed({
          type: "failed",
          code: "program_input_invalid",
          message: inputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
        });
      }
    }

    let release: (() => Promise<void>) | undefined;
    if (this.deps.admission) {
      const admitted = await this.deps.admission.acquire({
        organizationId,
        runId: context.run.state.runId,
        nodeRunId: context.effect.nodeRunId,
      });
      if (Result.isFailure(admitted)) return admitted;
      if (admitted.value.type === "denied") {
        // 他tenantを圧迫しないよう、枠が空くまで作用を未確定のまま待つ。
        return Result.fail(
          new EffectHandlerError(admitted.value.code, true, admitted.value.message),
        );
      }
      release = admitted.value.release;
    }
    const ran = await this.deps.sandbox.run({
      source: version.source,
      input: request.input,
      ...(request.resume
        ? {
            resume: {
              state: request.resume.state,
              effectResult: request.resume.effectResult as unknown as JsonValue,
            },
          }
        : {}),
      limits: version.runtimeProfile,
    });
    await release?.();
    if (Result.isFailure(ran)) {
      if (ran.error.retriable)
        return Result.fail(new EffectHandlerError(ran.error.code, true, ran.error.message));
      return Result.succeed({ type: "failed", code: ran.error.code, message: ran.error.message });
    }
    this.deps.onRun?.({
      programId: version.programId,
      version: version.version,
      durationMs: ran.value.durationMs,
      logs: ran.value.logs,
      logsTruncated: ran.value.logsTruncated,
    });
    const result = ran.value.result;
    if (result.type === "yield") {
      if (!effectWithinManifest(result.effect, version.requestedCapabilities)) {
        return Result.succeed({
          type: "failed",
          code: "capability_denied",
          message: `Programは宣言していない${result.effect.type}作用を要求できません`,
        });
      }
      return Result.succeed({ type: "yielded", state: result.state, effect: result.effect });
    }
    const outputIssues = validateJsonSchemaLite(version.outputSchema, result.output);
    if (outputIssues.length > 0) {
      return Result.succeed({
        type: "failed",
        code: "program_output_invalid",
        message: outputIssues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      });
    }
    return Result.succeed({ type: "completed", output: result.output });
  }
}
