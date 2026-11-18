import { ConfigModule as NestConfig } from "@nestjs/config";
import { envSchema } from "./env";

export const ConfigModule = NestConfig.forRoot({ isGlobal: true, cache: true, validate: (raw) => envSchema.parse(raw) });
