// Shared tool plumbing. Magpie passes the `args` object through as native JSON
// Schema (internal/plugin/host.js `argsSchema`), so there is no zod here and the
// tool itself validates its input.

export interface ToolDef {
  description: string;
  args: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

export function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

export function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export function requiredString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key,
): string {
  const value = args[key];
  if (typeof value !== "string") fail("E_INPUT", `${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) fail("E_INPUT", `${label} must not be empty`);
  if (trimmed.length > maxLength) fail("E_INPUT", `${label} is longer than ${maxLength} characters`);
  return trimmed;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A wallet address argument, lowercased; the one identity this product has. */
export function requiredAddress(args: Record<string, unknown>, key: string, label = key): string {
  const value = requiredString(args, key, 64, label);
  if (!ADDRESS_RE.test(value)) fail("E_INPUT", `${label} must be a 0x… wallet address`);
  return value.toLowerCase();
}

export function optionalString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
  label = key,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail("E_INPUT", `${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) fail("E_INPUT", `${label} is longer than ${maxLength} characters`);
  return trimmed;
}

export function optionalBoolean(
  args: Record<string, unknown>,
  key: string,
  label = key,
): boolean {
  const value = args[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") fail("E_INPUT", `${label} must be a boolean`);
  return value;
}

export const NO_ARGS: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
