import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ZodValidationException } from "nestjs-zod";

export class AppError extends Error {
  constructor(readonly status: number, readonly errorType: string, message: string, readonly fields?: Record<string, string>, readonly data?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const forbidden = () => new AppError(403, "forbidden", "Forbidden");
export const conflict = (msg: string) => new AppError(409, "conflict", msg);
export const invalid = (fields: Record<string, string>) => new AppError(422, "validation", "Validation failed", fields);

type Detail = { loc: (string | number)[]; msg: string }[];

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger("Exception");

  catch(err: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500, errorType = "internal", message = "Internal server error", detail: Detail | undefined, data: Record<string, unknown> | null = null;

    if (err instanceof AppError) {
      ({ status, errorType, message } = err);
      data = err.data ?? null;
      if (err.fields) detail = Object.entries(err.fields).map(([f, msg]) => ({ loc: ["body", f], msg }));
    } else if (err instanceof ZodValidationException) {
      status = 422; errorType = "validation"; message = "Validation failed";
      detail = err.getZodError().issues.map((i) => ({ loc: ["body", ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))], msg: i.message }));
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      errorType = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : status >= 500 ? "internal" : "bad_request";
      if (status < 500) message = err.message;
    }
    if (status >= 500) this.log.error(err);

    void reply.status(status).send({ success: false, message, errorType, data, ...(detail && { detail }) });
  }
}
