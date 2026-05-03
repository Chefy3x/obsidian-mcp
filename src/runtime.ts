import { toolErrorResult } from "./errors.js";

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.OBSIDIAN_MCP_TIMEOUT_MS ?? "30000",
  10,
);

function isVerbose(): boolean {
  if (process.env.OBSIDIAN_MCP_DEBUG === "0") return false;
  if (process.env.DEBUG === "1" || process.env.DEBUG === "true") return true;
  return process.env.NODE_ENV !== "production";
}

class ToolTimeout extends Error {
  constructor(
    public toolName: string,
    public timeoutMs: number,
  ) {
    super(`${toolName} exceeded ${timeoutMs}ms timeout`);
    this.name = "ToolTimeout";
  }
}

function logEvent(fields: Record<string, unknown>): void {
  const parts = [`[${new Date().toISOString()}]`];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  process.stderr.write(parts.join(" ") + "\n");
}

function redactArgs(args: unknown): unknown {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    const out: Record<string, unknown> = { ...a };
    if (typeof a.content === "string") {
      out.content = `<${(a.content as string).length} chars>`;
    }
    if (typeof a.old_str === "string") {
      out.old_str = `<${(a.old_str as string).length} chars>`;
    }
    if (typeof a.new_str === "string") {
      out.new_str = `<${(a.new_str as string).length} chars>`;
    }
    return out;
  }
  return args;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withToolRuntime<F extends (...args: any[]) => Promise<any>>(
  name: string,
  fn: F,
): F {
  const wrapped = async (...args: Parameters<F>) => {
    const start = Date.now();
    const verbose = isVerbose();
    if (verbose) {
      logEvent({ tool: name, event: "start", args: redactArgs(args[0]) });
    }
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fn(...args),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new ToolTimeout(name, DEFAULT_TIMEOUT_MS)),
            DEFAULT_TIMEOUT_MS,
          );
        }),
      ]);
      const duration = Date.now() - start;
      if (verbose) {
        logEvent({ tool: name, event: "end", duration_ms: duration });
      }
      return result;
    } catch (err) {
      const duration = Date.now() - start;
      if (err instanceof ToolTimeout) {
        logEvent({
          tool: name,
          event: "timeout",
          timeout_ms: DEFAULT_TIMEOUT_MS,
          duration_ms: duration,
        });
        return toolErrorResult({
          tool: name,
          code: "TIMEOUT",
          message: `Operation exceeded ${DEFAULT_TIMEOUT_MS}ms timeout.`,
          attempted: { args: redactArgs(args[0]) },
          suggestions: [
            "Increase OBSIDIAN_MCP_TIMEOUT_MS if this was a legitimately long operation.",
            "Check the vault's filesystem for stuck I/O if this looks like a hang.",
          ],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      logEvent({
        tool: name,
        event: "error",
        duration_ms: duration,
        message,
      });
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };
  return wrapped as F;
}
