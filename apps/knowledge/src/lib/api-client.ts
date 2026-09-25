/** Problem Details surfaced to the UI by stable code (never raw provider text). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
    this.name = "ApiError";
  }
}

const CLIENT_HEADERS = { "x-knowledge-client": "1" } as const;

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text().catch(() => "");
  const body = (text ? JSON.parse(text) : null) as
    | (T & { code?: string; title?: string; detail?: string })
    | null;
  if (!response.ok) {
    return Promise.reject(
      new ApiError(
        response.status,
        typeof body?.code === "string" ? body.code : `http_${response.status}`,
        typeof body?.title === "string" ? body.title : `HTTP ${response.status}`,
        typeof body?.detail === "string" ? body.detail : undefined,
      ),
    );
  }
  // Empty success bodies (204) resolve to `{}` so callers can tell success from failure.
  return (body ?? {}) as T;
}

export function apiGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const query = new URLSearchParams(
    Object.entries(params ?? {}).filter((entry): entry is [string, string] => !!entry[1]),
  ).toString();
  return fetch(`${path}${query ? `?${query}` : ""}`, { credentials: "same-origin" }).then(
    (response) => parse<T>(response),
  );
}

export function apiSend<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...CLIENT_HEADERS,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => parse<T>(response));
}

export const pagePath = (spaceKey: string, pageId: string) =>
  `/api/spaces/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(pageId)}`;
