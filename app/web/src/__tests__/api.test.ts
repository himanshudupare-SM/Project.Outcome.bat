import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, request } from '../lib/api.js';

/**
 * The fetch wrapper is the single door every screen goes through, so its
 * error translation and CSRF handling are worth pinning down directly.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  document.cookie = 'outcome_csrf=csrf-value-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'outcome_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('request', () => {
  it('sends GETs without a CSRF header or body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const result = await api.get<{ ok: boolean }>('/projects');

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/projects');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
  });

  it('attaches the CSRF cookie value to every mutating request', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.post('/tasks', { title: 'Ship it' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('csrf-value-123');
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ title: 'Ship it' }));
  });

  it('sends an empty CSRF header rather than crashing when the cookie is missing', async () => {
    document.cookie = 'outcome_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.del('/tasks/1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('');
  });

  it('returns undefined for 204 responses without parsing a body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.del('/watchers/me')).resolves.toBeUndefined();
  });

  it('turns a problem-details body into a field-aware ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        type: 'validation_error',
        title: 'Invalid request',
        status: 400,
        detail: 'Check the highlighted fields.',
        fields: { email: 'Enter a valid email address.' },
      }),
    );

    const error = await api.post('/auth/signup', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.message).toBe('Check the highlighted fields.');
    expect(apiError.fields).toEqual({ email: 'Enter a valid email address.' });
    expect(apiError.isAuth).toBe(false);
  });

  it('classifies auth, permission and missing-resource failures', async () => {
    const cases: Array<[number, keyof Pick<ApiError, 'isAuth' | 'isForbidden' | 'isNotFound'>]> = [
      [401, 'isAuth'],
      [403, 'isForbidden'],
      [404, 'isNotFound'],
    ];
    for (const [status, flag] of cases) {
      fetchMock.mockResolvedValue(jsonResponse(status, { type: 't', title: 'nope', status }));
      const error = (await api.get('/me').catch((e: unknown) => e)) as ApiError;
      expect(error[flag], `status ${status} should set ${flag}`).toBe(true);
    }
  });

  it('survives an error response that is not problem-details', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const error = (await api.get('/projects').catch((e: unknown) => e)) as ApiError;
    // No JSON body to trust, so fall back to a generic — never leak raw HTML.
    expect(error.status).toBe(502);
    expect(error.body.title).toBe('Request failed');
    expect(error.fields).toEqual({});
  });

  it('reports a transport failure as an actionable network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await request('GET', '/projects').catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(0);
    expect(error.body.type).toBe('network_error');
    expect(error.message).toMatch(/check your connection/i);
  });
});

describe('malformed success responses', () => {
  it('rejects with an ApiError rather than a raw SyntaxError', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"projects": [', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const error = (await api.get('/projects').catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.body.type).toBe('malformed_response');
  });
});
