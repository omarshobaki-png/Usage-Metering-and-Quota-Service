export const ERROR_CODES = {
  badRequest: "BAD_REQUEST",
  bodyTooLarge: "BODY_TOO_LARGE",
  databaseUnavailable: "DATABASE_UNAVAILABLE",
  internalError: "INTERNAL_ERROR",
  invalidJson: "INVALID_JSON",
  invalidRequest: "INVALID_REQUEST",
  notFound: "NOT_FOUND",
  planNotFound: "PLAN_NOT_FOUND",
  planScopeMismatch: "PLAN_SCOPE_MISMATCH",
  predefinedPlanReadOnly: "PREDEFINED_PLAN_READ_ONLY",
  requestIdConflict: "REQUEST_ID_CONFLICT",
  unauthorized: "UNAUTHORIZED",
  userNotFound: "USER_NOT_FOUND"
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: ErrorCode
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class InvalidRequestError extends AppError {
  public constructor(message = "Request body is invalid.") {
    super(message, 400, ERROR_CODES.invalidRequest);
    this.name = "InvalidRequestError";
  }
}

export class PredefinedPlanReadOnlyError extends AppError {
  public constructor() {
    super(
      "Predefined plans cannot be modified.",
      403,
      ERROR_CODES.predefinedPlanReadOnly
    );
    this.name = "PredefinedPlanReadOnlyError";
  }
}

export class RequestIdConflictError extends AppError {
  public constructor() {
    super(
      "The requestId was already used with a different payload.",
      409,
      ERROR_CODES.requestIdConflict
    );
    this.name = "RequestIdConflictError";
  }
}
