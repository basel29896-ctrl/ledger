import type { ProblemDto } from '@acct/shared';

/**
 * The API client.
 *
 * Two rules the rest of the app depends on:
 *  - credentials are always included, because the session lives in httpOnly
 *    cookies that JavaScript cannot read;
 *  - the CSRF token is echoed from its readable cookie on every mutation.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    readonly problem: ProblemDto,
    readonly status: number,
  ) {
    super(problem.title);
    this.name = 'ApiError';
  }

  /** Field-level messages, when the failure was validation. */
  get fieldErrors(): { path: string; message: string }[] {
    return this.problem.errors ?? [];
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return match?.[1] ?? '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && method !== 'HEAD') headers.set('X-CSRF-Token', csrfToken());

  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    method,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const problem = (body ?? {
      type: 'about:blank',
      title: res.statusText,
      status: res.status,
      code: 'UNKNOWN',
    }) as ProblemDto;
    throw new ApiError(problem, res.status);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> => {
    const init: RequestInit = { method: 'POST' };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (headers) init.headers = headers;
    return request<T>(path, init);
  },
};

/**
 * Priming request. The CSRF guard hands out its cookie on a safe method, so
 * one GET must happen before the first mutation of a session.
 */
export async function primeCsrf(): Promise<void> {
  try {
    await api.get('/auth/me');
  } catch {
    // Not signed in yet; the login response primes it instead.
  }
}
