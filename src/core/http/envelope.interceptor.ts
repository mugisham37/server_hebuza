import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { map } from "rxjs";

const RAW = "hebuza:raw";
export const RawResponse = () => SetMetadata(RAW, true);

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}
  intercept(ctx: ExecutionContext, next: CallHandler) {
    if (this.reflector.getAllAndOverride<boolean>(RAW, [ctx.getHandler(), ctx.getClass()])) return next.handle();
    return next.handle().pipe(map((data: unknown) => ({ success: true, message: "OK", errorType: null, data: data ?? null })));
  }
}
