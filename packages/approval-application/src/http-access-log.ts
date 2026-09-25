import { Result } from "@praha/byethrow";
import {
  actionCorrelation,
  decodeUriComponent,
  metricRecord,
  parseBrand,
  safeLogRecord,
  SYSTEM_ORGANIZATION_ID,
  type CorrelationContext,
  type OrganizationId,
  type SafeLogAttributes,
  type TelemetryComponent,
  type TelemetrySink,
} from "@app/approval-core";

/**
 * route template（例: `/v1/organizations/{organizationId}/action-requests/{actionRequestId}`）。
 * `{organizationId}` / `{actionRequestId}`はcorrelationに使い、それ以外の`{...}`は照合だけに使う。
 */
export type HttpRouteTemplate = string;

/** Public API（public-http.ts / http.ts）のroute template。 */
export const PUBLIC_HTTP_ROUTES: readonly HttpRouteTemplate[] = [
  "/v1/organizations/{organizationId}/action-requests",
  "/v1/organizations/{organizationId}/action-requests/{actionRequestId}",
  "/v1/organizations/{organizationId}/action-requests/{actionRequestId}/tasks",
  "/v1/organizations/{organizationId}/me/approval-tasks",
  "/v1/organizations/{organizationId}/approval-tasks/{taskId}",
  "/v1/organizations/{organizationId}/approval-tasks/{taskId}/decisions",
  "/v1/organizations/{organizationId}/approval-commands/{commandId}",
];

/** Authorization admin API（authorization-admin.ts）のroute template。 */
export const AUTHORIZATION_ADMIN_HTTP_ROUTES: readonly HttpRouteTemplate[] = [
  "/v1/admin/authorization/session",
  "/v1/admin/authorization/explain",
  "/v1/admin/authorization/catalog",
  "/v1/admin/authorization/relationships",
  "/v1/admin/authorization/relationships/{relationshipId}",
  "/v1/admin/authorization/model",
  "/v1/admin/authorization/audit",
];

type CompiledRoute = { template: HttpRouteTemplate; pattern: RegExp; parameters: string[] };

function compileRoute(template: HttpRouteTemplate): CompiledRoute {
  const parameters: string[] = [];
  const source = template
    .split("/")
    .map((segment) => {
      const parameter = /^\{(\w+)\}$/.exec(segment);
      if (parameter?.[1]) {
        parameters.push(parameter[1]);
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { template, pattern: new RegExp(`^${source}$`), parameters };
}

/** pathnameに一致するroute templateと、そのpath parameter（decode済み）を返す。 */
export function matchHttpRoute(
  routes: readonly HttpRouteTemplate[],
  pathname: string,
): { route: HttpRouteTemplate; parameters: Record<string, string> } | null {
  for (const compiled of routes.map(compileRoute)) {
    const match = compiled.pattern.exec(pathname);
    if (!match) continue;
    const parameters: Record<string, string> = {};
    compiled.parameters.forEach((name, index) => {
      const decoded = decodeUriComponent(match[index + 1] ?? "");
      if (Result.isSuccess(decoded)) parameters[name] = decoded.value;
    });
    return { route: compiled.template, parameters };
  }
  return null;
}

const readJson = Result.fn({
  try: (response: Response) => response.clone().json() as Promise<unknown>,
  catch: (error): Error => (error instanceof Error ? error : new Error(String(error))),
});

const invoke = Result.fn({
  try: (handler: (request: Request) => Promise<Response>, request: Request) => handler(request),
  catch: (error): unknown => error,
});

/** problem+json / JSON error bodyの`code`だけを読む（bodyの他の値はlogへ出さない）。 */
async function responseErrorCode(response: Response): Promise<string | undefined> {
  if (response.status < 400) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;
  const parsed = await readJson(response);
  if (Result.isFailure(parsed)) return undefined;
  const code = (parsed.value as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(code) ? code : undefined;
}

function correlationFor(input: {
  component: TelemetryComponent;
  route: string;
  parameters: Record<string, string>;
  defaultOrganizationId: OrganizationId | null;
  requestId: string;
}): CorrelationContext {
  const pathOrganization = input.parameters.organizationId
    ? parseBrand("OrganizationId", input.parameters.organizationId)
    : null;
  const organizationId =
    pathOrganization && Result.isSuccess(pathOrganization)
      ? pathOrganization.value
      : (input.defaultOrganizationId ?? SYSTEM_ORGANIZATION_ID);
  const actionRequestId = input.parameters.actionRequestId
    ? parseBrand("ActionRequestId", input.parameters.actionRequestId)
    : null;
  if (actionRequestId && Result.isSuccess(actionRequestId)) {
    return actionCorrelation({
      organizationId,
      actionRequestId: actionRequestId.value,
      component: input.component,
      operation: input.route,
    });
  }
  return {
    organizationId,
    correlationId: `request:${input.requestId}`,
    component: input.component,
    operation: input.route,
  };
}

export type HttpAccessLogOptions = {
  telemetry: TelemetrySink;
  /** 既知のroute template。一致しないpathは`unmatched`として記録する（raw pathは出さない）。 */
  routes: readonly HttpRouteTemplate[];
  component?: TelemetryComponent;
  /** pathにorganizationIdが無いroute（admin API等）のcorrelationに使う。 */
  defaultOrganizationId?: OrganizationId | null;
  now?: () => number;
};

/**
 * すべてのHTTP応答についてroute / status / latency / error code / request IDを出すmiddleware
 * （#110）。handlerの例外は500として記録してから呼び出し元へ返す（応答は変えない）。
 */
export function withHttpAccessLog(
  handler: (request: Request) => Promise<Response>,
  options: HttpAccessLogOptions,
): (request: Request) => Promise<Response> {
  const now = options.now ?? (() => Date.now());
  return async (request) => {
    const startedAt = now();
    const url = new URL(request.url);
    const matched = matchHttpRoute(options.routes, url.pathname);
    const route = matched?.route ?? "unmatched";
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const correlation = correlationFor({
      component: options.component ?? "http",
      route,
      parameters: matched?.parameters ?? {},
      defaultOrganizationId: options.defaultOrganizationId ?? null,
      requestId,
    });

    const handled = await invoke(handler, request);
    const response = Result.isSuccess(handled) ? handled.value : null;
    const httpStatus = response?.status ?? 500;
    const errorCode = response ? await responseErrorCode(response) : "unhandled_error";
    const durationMs = Math.max(0, now() - startedAt);
    const attributes: SafeLogAttributes = {
      method: request.method,
      route,
      httpStatus,
      status: String(httpStatus),
      durationMs,
      requestId,
      ...(errorCode ? { errorCode } : {}),
    };
    options.telemetry.emit(
      safeLogRecord({
        level: httpStatus >= 500 ? "error" : httpStatus >= 400 ? "warn" : "info",
        event: "request.completed",
        correlation,
        attributes,
      }),
    );
    options.telemetry.emit(
      metricRecord({
        name: "http.request_duration_ms",
        value: durationMs,
        unit: "milliseconds",
        correlation,
        attributes,
      }),
    );
    if (Result.isFailure(handled)) return Promise.reject(handled.error);
    return response!;
  };
}
