/** Typed application errors mapped to HTTP problem details by the error hook. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(detail ?? title);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(detail: string, fields?: Record<string, string>) {
    super(400, 'validation_error', 'Invalid request', detail, fields);
  }
}
export class AuthRequiredError extends AppError {
  constructor(detail = 'Sign in to continue') {
    super(401, 'auth_required', 'Not signed in', detail);
  }
}
export class ForbiddenError extends AppError {
  constructor(detail = "You don't have access to this") {
    super(403, 'forbidden', 'Access denied', detail);
  }
}
export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super(404, 'not_found', 'Not found', `${what} was not found, or has been deleted`);
  }
}
export class ConflictError extends AppError {
  constructor(detail: string, fields?: Record<string, string>) {
    super(409, 'conflict', 'Conflict', detail, fields);
  }
}
export class RateLimitedError extends AppError {
  constructor(detail = 'Too many requests — try again shortly') {
    super(429, 'rate_limited', 'Slow down', detail);
  }
}
export class AiUnavailableError extends AppError {
  constructor(detail = 'The AI service is unavailable right now') {
    super(503, 'ai_unavailable', 'AI unavailable', detail);
  }
}
