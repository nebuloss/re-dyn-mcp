/** util.ts — tiny shared helpers (no r2/SDK coupling). */

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Cap output to keep tool results token-disciplined (mirrors r2-re-mcp). */
export function capOutput(s: string, opts?: { maxLines?: number; maxChars?: number }): string {
  const maxLines = opts?.maxLines ?? 200;
  const maxChars = opts?.maxChars ?? 16_000;
  let out = s ?? "";
  let truncated = false;
  const lines = out.split("\n");
  if (lines.length > maxLines) {
    out = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? out + "\n… [output truncated]" : out;
}

const LEVELS = ["error", "warn", "info", "debug"];
const LVL = Math.max(0, LEVELS.indexOf(process.env.LOG_LEVEL ?? "info"));
function ts(): string {
  return "[re-dyn]";
}
export const log = {
  error: (...a: unknown[]) => console.error(ts(), ...a),
  warn: (...a: unknown[]) => LVL >= 1 && console.error(ts(), ...a),
  info: (...a: unknown[]) => LVL >= 2 && console.error(ts(), ...a),
  debug: (...a: unknown[]) => LVL >= 3 && console.error(ts(), ...a),
};
