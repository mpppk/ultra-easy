import { describe, expect, it } from "vite-plus/test";

import {
  MemoryTelemetrySink,
  type MetricRecord,
  type OrganizationId,
  type SafeLogRecord,
} from "@app/approval-core";

import { matchHttpRoute, PUBLIC_HTTP_ROUTES, withHttpAccessLog } from "./http-access-log.ts";

const defaultOrganizationId = "organization:default" as OrganizationId;

function harness(handler: (request: Request) => Promise<Response>) {
  const telemetry = new MemoryTelemetrySink();
  let clock = 1_000;
  const fetch = withHttpAccessLog(
    async (request) => {
      clock += 25;
      return handler(request);
    },
    { telemetry, routes: PUBLIC_HTTP_ROUTES, defaultOrganizationId, now: () => clock },
  );
  const log = () => telemetry.records.find((record) => record.kind === "log") as SafeLogRecord;
  const metric = () => telemetry.records.find((record) => record.kind === "metric") as MetricRecord;
  return { fetch, telemetry, log, metric };
}

describe("#110 withHttpAccessLog", () => {
  it("成功応答のroute template / status / latency / request IDを出す（raw pathは出さない）", async () => {
    const { fetch, log, metric } = harness(async () => Response.json({ ok: true }));
    await fetch(
      new Request(
        "https://api.example/v1/organizations/organization%3Aacme/action-requests/action%3Asecret-42",
        { headers: { "cf-ray": "8f00-NRT" } },
      ),
    );
    expect(log()).toMatchObject({
      level: "info",
      event: "request.completed",
      correlation: {
        organizationId: "organization:acme",
        actionRequestId: "action:secret-42",
        correlationId: "action:secret-42",
        component: "http",
        operation: "/v1/organizations/{organizationId}/action-requests/{actionRequestId}",
      },
      attributes: {
        method: "GET",
        httpStatus: 200,
        durationMs: 25,
        requestId: "8f00-NRT",
      },
    });
    expect(JSON.stringify(log().attributes)).not.toContain("secret-42");
    expect(metric()).toMatchObject({ name: "http.request_duration_ms", value: 25 });
  });

  it("4xx / 5xxはerror codeを添えてwarn / errorで出し、ActionRequest前の失敗はrequest IDで相関する", async () => {
    const problem = (status: number, code: string) =>
      Response.json(
        {
          type: `urn:ultra-easy:problem:${code}`,
          title: "x",
          status,
          code,
          detail: "secret detail",
        },
        { status, headers: { "content-type": "application/problem+json" } },
      );
    const unauthorized = harness(async () => problem(401, "unauthenticated"));
    await unauthorized.fetch(
      new Request("https://api.example/v1/organizations/organization%3Aacme/action-requests", {
        method: "POST",
        headers: { "cf-ray": "ray-401" },
      }),
    );
    expect(unauthorized.log()).toMatchObject({
      level: "warn",
      correlation: { correlationId: "request:ray-401", organizationId: "organization:acme" },
      attributes: { httpStatus: 401, errorCode: "unauthenticated", method: "POST" },
    });
    expect(JSON.stringify(unauthorized.log())).not.toContain("secret detail");

    const failed = harness(async () => problem(503, "dependency_unavailable"));
    await failed.fetch(new Request("https://api.example/unknown/path/with-id-123"));
    expect(failed.log()).toMatchObject({
      level: "error",
      correlation: { organizationId: "organization:default", operation: "unmatched" },
      attributes: { route: "unmatched", httpStatus: 503, errorCode: "dependency_unavailable" },
    });
  });

  it("handlerの例外は500 / unhandled_errorとして記録し、例外はそのまま返す", async () => {
    const { fetch, log } = harness(async () => Promise.reject(new Error("boom")));
    await expect(
      fetch(
        new Request("https://api.example/v1/organizations/organization%3Aacme/me/approval-tasks"),
      ),
    ).rejects.toThrow("boom");
    expect(log()).toMatchObject({
      level: "error",
      attributes: { httpStatus: 500, errorCode: "unhandled_error" },
    });
  });

  it("route templateは完全一致だけを扱い、parameterをdecodeする", () => {
    expect(
      matchHttpRoute(PUBLIC_HTTP_ROUTES, "/v1/organizations/org%2Fa/approval-tasks/t1/decisions"),
    ).toEqual({
      route: "/v1/organizations/{organizationId}/approval-tasks/{taskId}/decisions",
      parameters: { organizationId: "org/a", taskId: "t1" },
    });
    expect(matchHttpRoute(PUBLIC_HTTP_ROUTES, "/v1/organizations/a/approval-tasks/t1/extra")).toBe(
      null,
    );
  });
});
