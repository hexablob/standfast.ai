/**
 * The response envelope every list-returning tool uses.
 *
 * `truncated` is mandatory and is never left for the caller to infer from
 * `returned < total`. docs/02-principles.md, anti-patterns: do not return a
 * truncated result set without telling the agent it was truncated. An agent
 * that believes it has seen everything reasons confidently and wrongly, which
 * is worse than one that knows it is missing something.
 */
export type Envelope<T> = {
  items: T[];
  total: number;
  returned: number;
  truncated: boolean;
};

/**
 * Caps a result set to what an agent should actually read.
 *
 * The cap lives here rather than in the API because the token budget is the
 * MCP server's problem: the same list is fine over HTTP and ruinous in a
 * session context window.
 */
export function envelope<T>(items: T[], limit: number): Envelope<T> {
  const kept = items.slice(0, limit);
  return {
    items: kept,
    total: items.length,
    returned: kept.length,
    truncated: kept.length < items.length,
  };
}

/** MCP content blocks are text; JSON keeps it parseable on the way back. */
export function asToolResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

export function asToolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
