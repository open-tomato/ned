import { describe, expect, it } from 'bun:test';

import { notify, notifyEnv, ntfyMissingAt, parseEnvFile } from './notify.ts';
import { Refusal } from './output.ts';

import type { Fetch } from './notify.ts';

const TOKEN = '123:secret-token';
const TOPIC = 'secret-topic';
const FULL = notifyEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100', NTFY_TOPIC: TOPIC });

interface Call { readonly url: string; readonly headers: Record<string, string>; readonly body: string }

function recorder(status = 200): { fetchFn: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: status < 400, status };
  };
  return { fetchFn, calls };
}

describe('the env file', () => {
  it('reads KEY=value lines, skipping comments, blanks and quotes', () => {
    const vars = parseEnvFile('# bots\nTELEGRAM_BOT_TOKEN="1:a"\n\nNTFY_TOPIC=t\nbroken line\n');

    expect(vars).toEqual({ TELEGRAM_BOT_TOKEN: '1:a', NTFY_TOPIC: 't' });
  });

  it('defaults the ntfy address', () => {
    expect(notifyEnv({}).ntfyUrl).toBe('https://ntfy.sh');
  });
});

describe('notify', () => {
  it('sends a level 3 message to Telegram only', async () => {
    const { fetchFn, calls } = recorder();

    const deliveries = await notify(fetchFn, FULL, 3, 'build finished', 4);

    expect(deliveries.map((delivery) => delivery.via)).toEqual(['telegram']);
    expect(JSON.parse(calls[0]!.body)).toEqual({ chat_id: '-100', text: 'build finished' });
  });

  it('sends a level 5 message to both, with the ntfy priority set', async () => {
    const { fetchFn, calls } = recorder();

    const deliveries = await notify(fetchFn, FULL, 5, 'job failed', 4);

    expect(deliveries.map((delivery) => delivery.via)).toEqual(['telegram', 'ntfy']);
    expect(calls[1]!.url).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(calls[1]!.headers.Priority).toBe('5');
    expect(calls[1]!.body).toBe('job failed');
  });

  it('refuses when neither Telegram nor ntfy is set up, naming the keys', async () => {
    const { fetchFn } = recorder();

    await expect(notify(fetchFn, notifyEnv({}), 5, 'x', 4)).rejects.toThrow(Refusal);
    await expect(notify(fetchFn, notifyEnv({}), 5, 'x', 4)).rejects.toThrow('TELEGRAM_BOT_TOKEN');
  });

  it('refuses a Telegram set up by half, naming the missing key and sending nothing', async () => {
    const { fetchFn, calls } = recorder();
    const half = notifyEnv({ TELEGRAM_BOT_TOKEN: TOKEN, NTFY_TOPIC: TOPIC });

    const error = await notify(fetchFn, half, 5, 'x', 4).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Refusal);
    expect(String(error)).toContain('TELEGRAM_CHAT_ID');
    expect(String(error)).not.toContain(TOKEN);
    expect(calls).toEqual([]);
  });

  it('refuses when nothing that is set up carries this level, and sends nothing', async () => {
    const { fetchFn, calls } = recorder();
    const ntfyOnly = notifyEnv({ NTFY_TOPIC: TOPIC });

    await expect(notify(fetchFn, ntfyOnly, 3, 'x', 4)).rejects.toThrow(Refusal);
    await expect(notify(fetchFn, ntfyOnly, 3, 'x', 4)).rejects.toThrow('TELEGRAM_BOT_TOKEN');
    expect(calls).toEqual([]);
  });

  it('says ntfy is missing only at a level it would have carried', () => {
    const telegramOnly = notifyEnv({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-100' });

    expect(ntfyMissingAt(telegramOnly, 5, 4)).toBe(true);
    expect(ntfyMissingAt(telegramOnly, 3, 4)).toBe(false);
    expect(ntfyMissingAt(FULL, 5, 4)).toBe(false);
  });

  it('refuses a level outside 1 to 5', async () => {
    const { fetchFn } = recorder();

    await expect(notify(fetchFn, FULL, 6, 'x', 4)).rejects.toThrow('1 to 5');
  });

  it('fails on a refused send without ever naming the token or the topic', async () => {
    const { fetchFn } = recorder(401);

    const error = await notify(fetchFn, FULL, 5, 'x', 4).catch((caught: unknown) => caught);

    expect(String(error)).toContain('401');
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain(TOPIC);
  });

  it('fails without naming the token when the network throws', async () => {
    const throwing: Fetch = async (url) => {
      throw new Error(`connect failed for ${url}`);
    };

    const error = await notify(throwing, FULL, 3, 'x', 4).catch((caught: unknown) => caught);

    expect(String(error)).not.toContain(TOKEN);
  });
});
