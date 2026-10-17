import Fastify, { type FastifyInstance } from "fastify";

import {
  createAuthenticateApiKeyHook,
  type AuthenticateAccount
} from "./middleware/authenticate-api-key.js";
import {
  registerUserRoutes,
  type UserRouteOperations
} from "./modules/users/routes.js";
import {
  registerPlanRoutes,
  type PlanRouteOperations
} from "./modules/plans/routes.js";
import {
  registerAssignmentRoutes,
  type AssignmentRouteOperations
} from "./modules/plans/assignment-routes.js";
import {
  registerConsumptionRoutes,
  type ConsumptionRouteOperations
} from "./modules/usage/routes.js";
import { AppError } from "./shared/errors.js";

export const JSON_BODY_LIMIT_BYTES = 1_048_576;

interface LoggerOptions {
  level?: string;
  stream?: {
    write(message: string): void;
  };
}

export interface BuildAppOptions {
  checkDatabase: () => Promise<void>;
  authenticateAccount: AuthenticateAccount;
  userOperations: UserRouteOperations;
  planOperations?: PlanRouteOperations;
  assignmentOperations?: AssignmentRouteOperations;
  consumptionOperations?: ConsumptionRouteOperations;
  logger?: false | LoggerOptions;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
  correlationId: string;
}

function errorResponse(
  correlationId: string,
  code: string,
  message: string
): ErrorResponse {
  return {
    error: { code, message },
    correlationId
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const logger =
    options.logger === false
      ? false
      : {
          level: options.logger?.level ?? "info",
          redact: {
            paths: [
              'req.headers["x-api-key"]',
              "req.headers.authorization",
              'request.headers["x-api-key"]',
              "request.headers.authorization",
              'headers["x-api-key"]',
              "headers.authorization"
            ],
            censor: "[REDACTED]"
          },
          ...(options.logger?.stream === undefined
            ? {}
            : { stream: options.logger.stream })
        };

  const app = Fastify({
    logger,
    bodyLimit: JSON_BODY_LIMIT_BYTES
  });

  app.decorateRequest("authenticatedAccount", null);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.get("/health", async (request, reply) => {
    try {
      await options.checkDatabase();
      return { status: "ok", database: "reachable" };
    } catch {
      return reply.status(503).send({
        status: "unhealthy",
        database: "unreachable",
        ...errorResponse(
          request.id,
          "DATABASE_UNAVAILABLE",
          "The database is currently unavailable."
        )
      });
    }
  });

  app.register(async (tenantRoutes) => {
    tenantRoutes.addHook(
      "preHandler",
      createAuthenticateApiKeyHook(options.authenticateAccount)
    );

    tenantRoutes.get("/account", async (request) => {
      const account = request.authenticatedAccount;

      if (account === null) {
        throw new Error("Authenticated account context is missing.");
      }

      return { account };
    });

    registerUserRoutes(tenantRoutes, options.userOperations);

    if (options.planOperations !== undefined) {
      registerPlanRoutes(tenantRoutes, options.planOperations);
    }

    if (options.assignmentOperations !== undefined) {
      registerAssignmentRoutes(tenantRoutes, options.assignmentOperations);
    }

    if (options.consumptionOperations !== undefined) {
      registerConsumptionRoutes(tenantRoutes, options.consumptionOperations);
    }
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send(errorResponse(request.id, "NOT_FOUND", "Route not found."));
  });

  app.setErrorHandler((error, request, reply) => {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;

    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send(errorResponse(request.id, error.code, error.message));
    }

    if (errorCode === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply
        .status(400)
        .send(
          errorResponse(
            request.id,
            "INVALID_JSON",
            "Request body must be valid JSON."
          )
        );
    }

    if (errorCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply
        .status(413)
        .send(
          errorResponse(
            request.id,
            "BODY_TOO_LARGE",
            `Request body must not exceed ${JSON_BODY_LIMIT_BYTES} bytes.`
          )
        );
    }

    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send(
          errorResponse(
            request.id,
            "BAD_REQUEST",
            "The request could not be processed."
          )
        );
    }

    request.log.error({ err: error }, "Unexpected request failure");
    return reply
      .status(500)
      .send(
        errorResponse(request.id, "INTERNAL_ERROR", "Internal server error.")
      );
  });

  return app;
}
