// ---------------------------------------------------------------------------
// Error handlers (#240).
//
// The global error handler and the not-found handler are registered here.
// Both attach the request id to the response body so a client-reported error
// can be matched to its log lines. Error messages are redacted before they
// leave the server (#74).
//
// Database connection failures produce a 503 Service Unavailable with a
// Retry-After header, distinguishing temporary infrastructure issues from
// application bugs in monitoring and allowing load balancers to route around
// unhealthy instances.
// ---------------------------------------------------------------------------

import type { FastifyError, FastifyInstance } from "fastify";

import { errorCodeForStatus, redactErrorMessage } from "./error-redaction.js";
import { QueryTimeoutError } from "./db.js";
import { REQUEST_ID_HEADER } from "./request-id.js";

// Prisma connection errors indicate database unavailability rather than an
// application bug. Common error codes include P1000-P1017 (connection issues),
// P1001 (cannot reach database), P1002 (database timeout).
function isDatabaseConnectionError(err: Error): boolean {
  const message = err.message;
  // Prisma client errors have codes like P1001, P1002, etc.
  if (/P10\d{2}/.test(message)) return true;
  // Connection-related error messages
  if (message.includes("connect ECONNREFUSED")) return true;
  if (message.includes("Connection terminated unexpectedly")) return true;
  if (message.includes("database") && message.includes("unavailable")) return true;
  // Our own timeout errors from withQueryTimeout
  if (err instanceof QueryTimeoutError) return true;
  return false;
}

/**
 * Registers the global error handler and the not-found handler on `app`.
 * Both handlers attach `requestId`, a stable `code`, and a redacted `error`
 * message to every failure response.
 */
export function registerErrorHandlers(app: FastifyInstance): void {
  // Attach the request id to error bodies so an error a client saw can be
  // traced to its log lines. Status codes are preserved and each failure
  // carries a stable machine-readable code (#73). Outgoing messages are
  // redacted so connection strings, SQL fragments, or stack traces never
  // reach the client (#74); the original error is logged server-side with
  // the request id for diagnosis.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    let statusCode =
      typeof err.statusCode === "number" && err.statusCode >= 400
        ? err.statusCode
        : 500;
    
    // Database connection failures become 503 Service Unavailable
    if (statusCode >= 500 && isDatabaseConnectionError(err)) {
      statusCode = 503;
      reply.header("Retry-After", "30");
    }
    
    if (statusCode >= 500) {
      request.log.error({ err }, "request failed");
    }
    const message =
      statusCode >= 500
        ? "internal server error"
        : redactErrorMessage(err.message);
    void reply.status(statusCode).send({
      code: errorCodeForStatus(statusCode),
      error: message,
      requestId: request.id,
    });
  });

  // Unmatched routes bypass the error handler, so they get their own handler �
  // with the request id attached like every other error response.
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      code: errorCodeForStatus(404),
      error: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });
}
