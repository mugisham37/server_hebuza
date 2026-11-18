import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Controller, Get, NotFoundException } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Public } from "../auth/decorators";
import { RawResponse } from "./envelope.interceptor";

let cached: unknown;

/** The HTTP contract the web generates its typed client from (`pnpm build` writes openapi.json next to dist/). */
@Controller("openapi.json")
@Public()
@RawResponse()
@ApiExcludeController()
export class OpenApiController {
  @Get()
  get() {
    try {
      return (cached ??= JSON.parse(readFileSync(resolve(__dirname, "../openapi.json"), "utf8")));
    } catch {
      throw new NotFoundException("openapi.json not built");
    }
  }
}
