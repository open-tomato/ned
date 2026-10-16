/**
 * Reaching the person: Telegram for every level, ntfy from the configured
 * level up. The bot token sits in Telegram's URL and the topic in ntfy's,
 * so no error here ever carries a URL.
 */
import { Failure, Refusal } from './output.ts';

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 5;
const DEFAULT_NTFY_URL = 'https://ntfy.sh';
const TELEGRAM_API = 'https://api.telegram.org';
const TITLE = 'ned';

export interface NotifyEnv {
  readonly telegramToken: string | null;
  readonly telegramChat: string | null;
  readonly ntfyTopic: string | null;
  readonly ntfyUrl: string;
  /** The Telegram user ids the bot obeys; none means it obeys nobody. */
  readonly allowedUsers: readonly string[];
}

export type Fetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string },
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export interface Delivery {
  readonly via: 'telegram' | 'ntfy';
  readonly ok: boolean;
  readonly status: number;
}

const ENV_LINE = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

export function parseEnvFile(text: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    text.split('\n')
      .map((line) => ENV_LINE.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, '$2')]),
  );
}

function orNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

export function notifyEnv(vars: Readonly<Record<string, string | undefined>>): NotifyEnv {
  return {
    telegramToken: orNull(vars.TELEGRAM_BOT_TOKEN),
    telegramChat: orNull(vars.TELEGRAM_CHAT_ID),
    ntfyTopic: orNull(vars.NTFY_TOPIC),
    ntfyUrl: orNull(vars.NTFY_URL) ?? DEFAULT_NTFY_URL,
    allowedUsers: (vars.TELEGRAM_ALLOWED_USERS ?? '').split(/[\s,]+/).filter((id) => id !== ''),
  };
}

/** Whether a message of this level would have gone to ntfy too, had ntfy been set up. */
export function ntfyMissingAt(env: NotifyEnv, level: number, ntfyFromLevel: number): boolean {
  return env.ntfyTopic === null && level >= ntfyFromLevel;
}

async function send(fetchFn: Fetch, via: Delivery['via'], url: string, headers: Record<string, string>, body: string): Promise<Delivery> {
  try {
    const response = await fetchFn(url, { method: 'POST', headers, body });
    return { via, ok: response.ok, status: response.status };
  } catch {
    return { via, ok: false, status: 0 };
  }
}

/**
 * Rings ntfy alone, for a message that reaches Telegram another way, as
 * a question the bot sends with its buttons does. Null when ntfy is not
 * set up or the level is below where it starts.
 */
export async function ringNtfy(fetchFn: Fetch, env: NotifyEnv, level: number, text: string, ntfyFromLevel: number): Promise<Delivery | null> {
  if (env.ntfyTopic === null || level < ntfyFromLevel) return null;
  return send(fetchFn, 'ntfy', `${env.ntfyUrl}/${env.ntfyTopic}`, { Priority: String(level), Title: TITLE }, text);
}

export async function notify(
  fetchFn: Fetch,
  env: NotifyEnv,
  level: number,
  text: string,
  ntfyFromLevel: number,
): Promise<readonly Delivery[]> {
  if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL) {
    throw new Refusal(`--level is ${String(level)}, expected a whole number from ${String(MIN_LEVEL)} to ${String(MAX_LEVEL)}`);
  }
  const hasToken = env.telegramToken !== null;
  const hasChat = env.telegramChat !== null;
  if (hasToken !== hasChat) {
    throw new Refusal(`Telegram is set up by half: the env file lacks ${hasToken ? 'TELEGRAM_CHAT_ID' : 'TELEGRAM_BOT_TOKEN'}; nothing was sent`);
  }
  const telegram = hasToken && hasChat;
  const ntfy = env.ntfyTopic !== null && level >= ntfyFromLevel;
  if (!telegram && !ntfy) {
    throw new Refusal(env.ntfyTopic === null
      ? 'nothing to send through: the env file sets neither TELEGRAM_BOT_TOKEN with TELEGRAM_CHAT_ID nor NTFY_TOPIC'
      : `nothing carries level ${String(level)}: ntfy starts at level ${String(ntfyFromLevel)}, and Telegram is not set up (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)`);
  }
  const deliveries: Delivery[] = [];
  if (telegram) {
    deliveries.push(await send(
      fetchFn, 'telegram', `${TELEGRAM_API}/bot${env.telegramToken!}/sendMessage`,
      { 'Content-Type': 'application/json' }, JSON.stringify({ chat_id: env.telegramChat, text }),
    ));
  }
  if (ntfy) {
    deliveries.push(await send(
      fetchFn, 'ntfy', `${env.ntfyUrl}/${env.ntfyTopic!}`, { Priority: String(level), Title: TITLE }, text,
    ));
  }
  const failed = deliveries.filter((delivery) => !delivery.ok);
  if (failed.length > 0) {
    throw new Failure(`not delivered: ${failed.map((delivery) => `${delivery.via} answered ${String(delivery.status)}`).join(', ')}`);
  }
  return deliveries;
}
