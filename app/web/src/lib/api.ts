import type { ErrorBody } from '@outcome/shared';

/**
 * Typed fetch wrapper. Adds the CSRF header from the cookie the server set
 * (double-submit), and turns problem-details bodies into a typed error the
 * UI can render field-by-field.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.detail ?? body.title);
    this.name = 'ApiError';
  }

  get fields(): Record<string, string> {
    return this.body.fields ?? {};
  }
  get isAuth(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

function csrfToken(): string {
  const match = /(?:^|;\s*)outcome_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Network-level failure: give the UI something actionable.
    throw new ApiError(0, {
      type: 'network_error',
      title: 'Connection lost',
      status: 0,
      detail: "Couldn't reach the server. Check your connection and try again.",
    });
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  // A proxy or load balancer in front of the API can answer with an HTML
  // error page, and a cut-off response leaves truncated JSON. Neither should
  // surface as a raw SyntaxError the UI has no handler for.
  let payload: unknown = null;
  let parsed = true;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }

  if (!res.ok) {
    const errorBody =
      payload && typeof payload === 'object' && 'title' in payload
        ? (payload as ErrorBody)
        : { type: 'unknown', title: 'Request failed', status: res.status };
    throw new ApiError(res.status, errorBody);
  }
  if (!parsed) {
    throw new ApiError(res.status, {
      type: 'malformed_response',
      title: 'Unexpected response',
      status: res.status,
      detail: 'The server sent a response we could not read. Please try again.',
    });
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
