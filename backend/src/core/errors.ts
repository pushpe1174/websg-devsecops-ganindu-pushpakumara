/**
 * The errors the API answers with deliberately. Anything else reaching the
 * handler is a bug and becomes a 500 with no detail.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly reasons?: string[];

  constructor(status: number, message: string, reasons?: string[]) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.reasons = reasons;
  }
}

export const validationError = (reasons: string[]) =>
  new HttpError(400, 'Invalid IP allowlist', reasons);

export const versionConflict = () =>
  new HttpError(409, 'Allowlist was modified by another request');

export const preconditionRequired = () =>
  new HttpError(428, 'If-Match header with the current version is required');
