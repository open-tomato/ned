/** Exit codes, the two error kinds a command ends on, and how a result is printed. */
export const EXIT_DONE = 0;
export const EXIT_REFUSED = 1;
export const EXIT_FAILED = 2;

/** A command that will not run as asked: exit code 1, nothing changed. */
export class Refusal extends Error {}

/** A step that could not finish: exit code 2. */
export class Failure extends Error {}

export type OutputMode = 'text' | 'json';

/** What a command hands back: lines for a person, data for a caller. */
export interface CommandResult {
  readonly lines: readonly string[];
  readonly data: unknown;
}

export function exitCodeOf(error: unknown): number {
  return error instanceof Refusal ? EXIT_REFUSED : EXIT_FAILED;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderResult(mode: OutputMode, command: string, result: CommandResult): string {
  if (mode === 'json') return `${JSON.stringify({ type: 'result', ok: true, command, data: result.data })}\n`;
  return result.lines.length === 0 ? '' : `${result.lines.join('\n')}\n`;
}

export function renderError(mode: OutputMode, command: string, error: unknown): string {
  if (mode === 'json') return `${JSON.stringify({ type: 'result', ok: false, command, error: messageOf(error) })}\n`;
  return `ned ${command}: ${messageOf(error)}\n`;
}
