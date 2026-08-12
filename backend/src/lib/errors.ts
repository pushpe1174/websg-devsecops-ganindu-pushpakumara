export class ValidationError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super('Invalid IP allowlist');
    this.name = 'ValidationError';
    this.reasons = reasons;
  }
}

export class VersionConflictError extends Error {
  constructor(message = 'Allowlist was modified by another request') {
    super(message);
    this.name = 'VersionConflictError';
  }
}

export class PreconditionRequiredError extends Error {
  constructor(message = 'If-Match header with the current version is required') {
    super(message);
    this.name = 'PreconditionRequiredError';
  }
}
