export interface ToolErrorPayload {
  tool: string;
  code: string;
  message: string;
  attempted: Record<string, unknown>;
  suggestions: string[];
}

export function toolErrorResult(payload: ToolErrorPayload) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function toolSuccessResult<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}
