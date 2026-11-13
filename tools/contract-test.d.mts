export const ROOT: string;
export const OPENAPI_FILE: string;

export function loadContract(file?: string): Promise<Record<string, unknown>>;

export function runContractTests(
  baseUrl: string,
  options?: { contract?: Record<string, unknown> },
): Promise<{
  ok: boolean;
  tested: Array<{ name: string; status?: number; skipped?: boolean }>;
  failures: string[];
}>;
