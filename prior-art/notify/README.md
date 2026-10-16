# Prior art: the send code

These files come from an earlier internal notifier. They are the send
code it uses today, copied here as the starting point for ned's own
code. Nothing builds or imports them yet: the work that brings them into
`src/` moves them and deletes this folder.

| File | What it does |
|---|---|
| `notify.ts` | Sends one message by level (1 to 5): Telegram for every level, ntfy from a configured level up. Refuses a half-set Telegram config and never puts a URL in an error, because the bot token and the ntfy topic both sit in URLs. |
| `telegram.ts` | The Telegram Bot API calls: `sendMessage` with a length clip, messages with inline buttons, closing the buttons after a tap, and reading updates (commands and taps) from the chat. |
| `output.ts` | The two error kinds the code above throws: `Refusal` (nothing was sent) and `Failure` (a send did not finish). |
| `*.test.ts` | Their tests, with fake ids, token and topic. |

Which ned specs start from them:

- #3, ned core: the levels here become an optional priority on `alert`
  and `notice`, and the level threshold becomes a route filter.
- #6, the Telegram provider: `telegram.ts`'s send and clip, and the rule
  that no error carries a URL.
- A new ntfy provider: `ringNtfy` and the ntfy half of `notify`, with
  the topic given as a secret name.
- #9, answering a waiting stop from a chat: the buttons, taps and
  closing calls in `telegram.ts` are a working round trip.

Known gaps, for the work that moves this code into `src/`:

- `telegram.ts` reads a response body outside a `try`, so a body that
  cannot be read throws the runtime's own error, which may carry the
  URL and with it the bot token. Wrap it and throw a `Failure` that
  names only the method.
- `notify.ts` joins the ntfy URL and topic as given: no `https` check
  and no encoding of the topic. Validate both before use.
