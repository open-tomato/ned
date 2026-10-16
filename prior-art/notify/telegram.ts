/**
 * The two Telegram Bot API calls the bot needs: read new messages, send
 * one. The bot's token sits in the address of every call, so no error
 * from here ever carries an address.
 */
import { Failure } from './output.ts';

const API = 'https://api.telegram.org';
const CUT_MARK = '… (cut)';
const MS_PER_SECOND = 1000;
const FORWARD_FIELDS = ['forward_origin', 'forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date'] as const;

/** The most text one message is sent with; Telegram's own limit is 4096. */
export const MAX_MESSAGE = 4000;

export interface JsonResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export type JsonFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string },
) => Promise<JsonResponse>;

/** One text message someone sent where the bot can read it. */
export interface Incoming {
  readonly updateId: number;
  readonly chatId: string;
  readonly userId: string;
  readonly text: string;
  readonly sentAt: Date;
}

/** One tap on a button under a message of the bot. */
export interface Tap {
  readonly updateId: number;
  /** What Telegram wants named when the tap is answered. */
  readonly callbackId: string;
  readonly chatId: string;
  readonly userId: string;
  /** The message the button sits under. */
  readonly messageId: number;
  /** What the button carried. */
  readonly data: string;
}

/** One button: what it shows and what a tap on it carries back, at most 64 bytes. */
export interface Button {
  readonly text: string;
  readonly data: string;
}

export interface Updates {
  readonly incoming: readonly Incoming[];
  readonly taps: readonly Tap[];
  /** The offset that passes every update just read, text or not; null when none came. */
  readonly nextOffset: number | null;
}

async function call(fetchFn: JsonFetch, token: string, method: string, payload: unknown): Promise<unknown> {
  let response: JsonResponse;
  try {
    response = await fetchFn(`${API}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch {
    throw new Failure(`Telegram ${method} could not be reached`);
  }
  if (!response.ok) throw new Failure(`Telegram ${method} answered ${String(response.status)}`);
  const body = await response.json() as { ok?: unknown; result?: unknown } | null;
  if (body?.ok !== true) throw new Failure(`Telegram ${method} answered without a result`);
  return body.result;
}

function updateIds(result: unknown): readonly number[] {
  if (!Array.isArray(result)) return [];
  return result
    .map((update) => (update as { update_id?: unknown } | null)?.update_id)
    .filter((id): id is number => typeof id === 'number');
}

function asIncoming(update: unknown): Incoming | null {
  const record = update as { update_id?: unknown; message?: Record<string, unknown> & { text?: unknown; date?: unknown; chat?: { id?: unknown }; from?: { id?: unknown } } } | null;
  const message = record?.message;
  if (typeof record?.update_id !== 'number' || typeof message?.text !== 'string') return null;
  // A forwarded message is somebody else's words sent on; it is never the sender's own command.
  if (FORWARD_FIELDS.some((field) => message[field] !== undefined)) return null;
  if (typeof message.chat?.id !== 'number' || typeof message.from?.id !== 'number' || typeof message.date !== 'number') return null;
  return {
    updateId: record.update_id,
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    text: message.text,
    sentAt: new Date(message.date * MS_PER_SECOND),
  };
}

export function parseUpdates(result: unknown): readonly Incoming[] {
  if (!Array.isArray(result)) return [];
  return result.map(asIncoming).filter((incoming): incoming is Incoming => incoming !== null);
}

function asTap(update: unknown): Tap | null {
  const record = update as { update_id?: unknown; callback_query?: { id?: unknown; data?: unknown; from?: { id?: unknown }; message?: { message_id?: unknown; chat?: { id?: unknown } } } } | null;
  const query = record?.callback_query;
  if (typeof record?.update_id !== 'number' || typeof query?.id !== 'string' || typeof query.data !== 'string') return null;
  if (typeof query.from?.id !== 'number' || typeof query.message?.message_id !== 'number' || typeof query.message.chat?.id !== 'number') return null;
  return {
    updateId: record.update_id,
    callbackId: query.id,
    chatId: String(query.message.chat.id),
    userId: String(query.from.id),
    messageId: query.message.message_id,
    data: query.data,
  };
}

export function parseTaps(result: unknown): readonly Tap[] {
  if (!Array.isArray(result)) return [];
  return result.map(asTap).filter((tap): tap is Tap => tap !== null);
}

/** New updates from `offset` on, messages and taps; waits up to `timeoutSeconds` for one when none is there. */
export async function getUpdates(fetchFn: JsonFetch, token: string, offset: number, timeoutSeconds: number): Promise<Updates> {
  const result = await call(fetchFn, token, 'getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] });
  const ids = updateIds(result);
  return { incoming: parseUpdates(result), taps: parseTaps(result), nextOffset: ids.length === 0 ? null : Math.max(...ids) + 1 };
}

/** The bot's own username, without the `@`. */
export async function getMe(fetchFn: JsonFetch, token: string): Promise<string | null> {
  const username = (await call(fetchFn, token, 'getMe', {}) as { username?: unknown } | null)?.username;
  return typeof username === 'string' ? username : null;
}

export function clip(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - CUT_MARK.length)}${CUT_MARK}`;
}

export async function sendMessage(fetchFn: JsonFetch, token: string, chatId: string, text: string): Promise<void> {
  await call(fetchFn, token, 'sendMessage', { chat_id: chatId, text: clip(text) });
}

/** Sends a message with one button per row under it, and hands back the message's id. */
export async function sendButtons(fetchFn: JsonFetch, token: string, chatId: string, text: string, buttons: readonly Button[]): Promise<number> {
  const sent = await call(fetchFn, token, 'sendMessage', {
    chat_id: chatId, text: clip(text),
    reply_markup: { inline_keyboard: buttons.map((button) => [{ text: button.text, callback_data: button.data }]) },
  }) as { message_id?: unknown } | null;
  if (typeof sent?.message_id !== 'number') throw new Failure('Telegram sendMessage answered without a message id');
  return sent.message_id;
}

/** Ends the wait a tap shows on the person's screen, with a short notice. */
export async function answerTap(fetchFn: JsonFetch, token: string, callbackId: string, text: string): Promise<void> {
  await call(fetchFn, token, 'answerCallbackQuery', { callback_query_id: callbackId, text });
}

/** Rewrites a message of the bot; sent with no buttons, so the ones it had are gone. */
export async function closeButtons(fetchFn: JsonFetch, token: string, chatId: string, messageId: number, text: string): Promise<void> {
  await call(fetchFn, token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: clip(text) });
}
