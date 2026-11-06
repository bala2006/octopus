export function parseObject(
  value: unknown,
  error: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(error);
  }
  return Object.fromEntries(Object.entries(value));
}

export function parseText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
