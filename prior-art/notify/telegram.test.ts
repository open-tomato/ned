import { describe, expect, it } from 'bun:test';

import { Failure } from './output.ts';
import { answerTap, clip, closeButtons, getMe, getUpdates, MAX_MESSAGE, parseTaps, parseUpdates, sendButtons, sendMessage } from './telegram.ts';

import type { JsonFetch } from './telegram.ts';

const TOKEN = '123:secret-token';

function answering(result: unknown, status = 200): { fetchFn: JsonFetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn: JsonFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => ({ ok: status < 400, result }) };
  };
  return { fetchFn, calls };
}

const TEXT_UPDATE = {
  update_id: 41,
  message: { message_id: 7, date: 1791800000, chat: { id: -100123, title: 'test' }, from: { id: 555, first_name: 'M' }, text: '/status' },
};
const JOIN_UPDATE = { update_id: 42, my_chat_member: { chat: { id: -100123 } } };
const PHOTO_UPDATE = { update_id: 43, message: { message_id: 8, date: 1791800001, chat: { id: -100123 }, from: { id: 555 } } };

describe('parseUpdates', () => {
  it('keeps messages that carry text, with ids as text and the time they were sent', () => {
    const incoming = parseUpdates([TEXT_UPDATE, JOIN_UPDATE, PHOTO_UPDATE]);

    expect(incoming).toEqual([{ updateId: 41, chatId: '-100123', userId: '555', text: '/status', sentAt: new Date(1791800000 * 1000) }]);
  });

  it("drops a forwarded message: it is somebody else's words, sent on", () => {
    const forwarded = { ...TEXT_UPDATE, message: { ...TEXT_UPDATE.message, forward_origin: { type: 'user' } } };
    const legacy = { ...TEXT_UPDATE, message: { ...TEXT_UPDATE.message, forward_date: 1791700000 } };

    expect(parseUpdates([forwarded, legacy])).toEqual([]);
  });

  it('reads anything that is no list of updates as no update', () => {
    expect(parseUpdates({ nope: true })).toEqual([]);
    expect(parseUpdates([null, 7, { update_id: 'x' }])).toEqual([]);
  });
});

describe('getUpdates', () => {
  it('asks from the offset and moves past every update it was given, text or not', async () => {
    const { fetchFn, calls } = answering([TEXT_UPDATE, JOIN_UPDATE, PHOTO_UPDATE]);

    const got = await getUpdates(fetchFn, TOKEN, 41, 30);

    expect(calls[0]!.body).toEqual({ offset: 41, timeout: 30, allowed_updates: ['message', 'callback_query'] });
    expect(got.incoming.map((one) => one.updateId)).toEqual([41]);
    expect(got.nextOffset).toBe(44);
  });

  it('keeps the offset when nothing came', async () => {
    const { fetchFn } = answering([]);

    expect((await getUpdates(fetchFn, TOKEN, 41, 0)).nextOffset).toBeNull();
  });

  it('fails without ever naming the token, on a refusal and on a network error', async () => {
    const refused = await getUpdates(answering([], 401).fetchFn, TOKEN, 1, 0).catch((caught: unknown) => caught);
    const throwing: JsonFetch = async (url) => {
      throw new Error(`connect failed for ${url}`);
    };
    const unreachable = await getUpdates(throwing, TOKEN, 1, 0).catch((caught: unknown) => caught);

    expect(refused).toBeInstanceOf(Failure);
    expect(String(refused)).toContain('401');
    expect(String(refused)).not.toContain(TOKEN);
    expect(String(unreachable)).not.toContain(TOKEN);
  });
});

describe('getMe', () => {
  it("reads the bot's own username", async () => {
    const { fetchFn } = answering({ id: 1, is_bot: true, username: 'example_bot' });

    expect(await getMe(fetchFn, TOKEN)).toBe('example_bot');
  });
});

describe('sendMessage', () => {
  it('sends the text to the chat', async () => {
    const { fetchFn, calls } = answering({ message_id: 9 });

    await sendMessage(fetchFn, TOKEN, '-100123', 'two jobs, both busy');

    expect(calls[0]!.url.endsWith('/sendMessage')).toBe(true);
    expect(calls[0]!.body).toEqual({ chat_id: '-100123', text: 'two jobs, both busy' });
  });

  it('cuts a text longer than one message holds, and says it was cut', () => {
    const cut = clip('x'.repeat(MAX_MESSAGE + 500));

    expect(cut.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(cut.endsWith('… (cut)')).toBe(true);
    expect(clip('short')).toBe('short');
  });
});

describe('buttons', () => {
  const TAP_UPDATE = {
    update_id: 50,
    callback_query: { id: 'cb-1', from: { id: 555, first_name: 'M' }, message: { message_id: 77, chat: { id: -100123 } }, data: 'ask:q1:1' },
  };

  it('reads a tap on a button: who tapped, where, on which message, and what the button carried', () => {
    expect(parseTaps([TEXT_UPDATE, TAP_UPDATE])).toEqual([{ updateId: 50, callbackId: 'cb-1', chatId: '-100123', userId: '555', messageId: 77, data: 'ask:q1:1' }]);
  });

  it('reads a tap with no message or no data as nothing', () => {
    expect(parseTaps([{ update_id: 51, callback_query: { id: 'cb-2', from: { id: 555 }, data: 'x' } }, { update_id: 52, callback_query: { id: 'cb-3', from: { id: 555 }, message: { message_id: 1, chat: { id: -1 } } } }])).toEqual([]);
  });

  it('hands back the taps of a poll beside its messages, and passes every update', async () => {
    const { fetchFn } = answering([TEXT_UPDATE, TAP_UPDATE]);

    const updates = await getUpdates(fetchFn, TOKEN, 41, 0);

    expect(updates.incoming.length).toBe(1);
    expect(updates.taps.length).toBe(1);
    expect(updates.nextOffset).toBe(51);
  });

  it('sends a message with one button per option and hands back its id', async () => {
    const { fetchFn, calls } = answering({ message_id: 77 });

    const id = await sendButtons(fetchFn, TOKEN, '-100123', 'Deploy now?', [{ text: 'yes', data: 'ask:q1:0' }, { text: 'no', data: 'ask:q1:1' }]);

    expect(id).toBe(77);
    expect(calls[0]!.url.endsWith('/sendMessage')).toBe(true);
    expect(calls[0]!.body).toEqual({
      chat_id: '-100123', text: 'Deploy now?',
      reply_markup: { inline_keyboard: [[{ text: 'yes', callback_data: 'ask:q1:0' }], [{ text: 'no', callback_data: 'ask:q1:1' }]] },
    });
  });

  it('answers a tap with a short notice, and rewrites a message without its buttons', async () => {
    const { fetchFn, calls } = answering(true);

    await answerTap(fetchFn, TOKEN, 'cb-1', 'answered: yes');
    await closeButtons(fetchFn, TOKEN, '-100123', 77, 'Deploy now?\n\n→ yes');

    expect(calls[0]!.url.endsWith('/answerCallbackQuery')).toBe(true);
    expect(calls[0]!.body).toEqual({ callback_query_id: 'cb-1', text: 'answered: yes' });
    expect(calls[1]!.url.endsWith('/editMessageText')).toBe(true);
    expect(calls[1]!.body).toEqual({ chat_id: '-100123', message_id: 77, text: 'Deploy now?\n\n→ yes' });
  });
});
