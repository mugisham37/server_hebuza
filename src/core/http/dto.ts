import { createZodDto } from "nestjs-zod";
import { z } from "zod";

// nestjs-zod pulls in @nest-zod/z, which installs a zod-3 global error map that throws on zod 4 (every 422 became a 500).
z.config({ customError: undefined });

/** `class XDto extends dto(X) {}` — nestjs-zod 4.3 is typed for zod 3; this keeps its runtime (ZodValidationPipe reads the static `schema`) and types the instance as `z.infer<S>`. */
/** Placeholder type for union/any props (swagger requires one); openapi.ts strips it. */
export const ANY = "x-any";

/** Shared component schemas (registered ids / recursive refs) collected while documenting; openapi.ts merges them. */
export const openapiDefs: Record<string, unknown> = {};
/** additionalProperties of record/loose DTOs (swagger's per-property metadata drops it); openapi.ts merges them. */
export const openapiExtra: Record<string, object> = {};
let calls = 0;
const names = new Map<string, z.ZodType>();
/** zod -> OpenAPI 3.0 schema with refs pointing at components.schemas (anonymous recursive defs made unique per call). */
export const toOpenApi = (schema: z.ZodType, io: "input" | "output") => {
  const n = ++calls;
  const raw = JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any", target: "openapi-3.0" }));
  const { definitions, ...js } = JSON.parse(raw.replace(/__schema(\d+)/g, `__s${n}_$1`).replaceAll("#/definitions/", "#/components/schemas/")) as Record<string, unknown> & { definitions?: Record<string, unknown> };
  Object.assign(openapiDefs, definitions);
  return js;
};

export const dto = <S extends z.ZodType>(schema: S) => {
  // cast: nestjs-zod's generic only accepts zod-3 schemas; the runtime class is identical.
  const C = createZodDto(schema as never) as unknown as { _OPENAPI_METADATA_FACTORY?: () => object };
  // @nestjs/swagger reads this per-property map to document @Body()/@Query() DTOs (nestjs-zod 4's own patch is zod-3 only).
  C._OPENAPI_METADATA_FACTORY = function (this: { name: string }) {
    // swagger keys components by class name; same-named DTOs in different modules (CreateDto…) get a numeric suffix.
    let name = this.name;
    for (let i = 2; names.has(name) && names.get(name) !== schema; i++) name = `${this.name}${i}`;
    names.set(name, schema);
    if (name !== this.name) Object.defineProperty(this, "name", { value: name });
    const js = toOpenApi(schema, "input") as { properties?: Record<string, object>; required?: string[]; additionalProperties?: unknown };
    if (js.additionalProperties && typeof js.additionalProperties === "object") openapiExtra[name] = { additionalProperties: js.additionalProperties };
    return Object.fromEntries(Object.entries(js.properties ?? {}).map(([k, v]) => [k, { type: ANY, ...v, required: !!js.required?.includes(k) }]));
  };
  return C as unknown as { new (): z.infer<S>; schema: S; isZodDto: true };
};
