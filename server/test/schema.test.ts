/** Strict tool schemas: the shape the provider's strict mode requires, and the tools that opt into it. */
import { z } from "zod";
import { defineTool, strictParameters, toFunction } from "../src/tools/types";

const tool = (args: z.ZodType) => defineTool({ name: "t", description: "d", args, run: async () => ({ text: "ok" }) });

describe("strictParameters", () => {
  test("marks every property required, forbids extras, and makes optional properties nullable", () => {
    const schema = strictParameters({
      type: "object",
      properties: { path: { type: "string" }, offset: { type: "integer" } },
      required: ["path"],
      additionalProperties: false,
    }) as Record<string, unknown>;
    expect(schema.required).toEqual(["path", "offset"]);
    expect((schema.properties as Record<string, unknown>).path).toEqual({ type: "string" });
    expect((schema.properties as Record<string, unknown>).offset).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
  });

  test("normalises nested objects and arrays of objects", () => {
    const schema = strictParameters({
      type: "object",
      required: ["edits"],
      properties: {
        edits: { type: "array", items: { type: "object", properties: { n: { type: "number" } } } },
      },
    }) as { properties: { edits: { items: Record<string, unknown> } } };
    const items = schema.properties.edits.items;
    expect(items.required).toEqual(["n"]);
    expect(items.additionalProperties).toBe(false);
  });

  test("leaves scalars and empty schemas alone", () => {
    expect(strictParameters({ type: "string" })).toEqual({ type: "string" });
    expect(strictParameters({})).toEqual({});
    expect(strictParameters(null)).toBe(null);
  });
});

describe("toFunction", () => {
  test("is not strict unless asked, so a deployment that rejects strict keeps working", () => {
    const f = toFunction(tool(z.object({ path: z.string(), limit: z.number().optional() })));
    expect(f.strict).toBe(false);
    expect((f.parameters as { required: string[] }).required).toEqual(["path"]);
    expect(f.description).toBe("d");
  });

  test("with strict, advertises the normalised schema and says so", () => {
    const f = toFunction(tool(z.object({ path: z.string(), limit: z.number().optional() })), true);
    expect(f.strict).toBe(true);
    const p = f.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    expect(p.required).toEqual(["path", "limit"]);
    expect(p.additionalProperties).toBe(false);
    expect(p.properties.limit).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
  });
});
