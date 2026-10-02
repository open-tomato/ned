# ned: the notification event dispatcher

**N**otification **E**vent **D**ispatcher. Decided 2026-10-02.

## What you get

ned is a small library with a thin CLI. A program hands it a message, ned
checks the message against its kind's schema, finds the routes for that
kind, and gives the message to each provider on those routes. A provider
delivers to one place: a Telegram chat, a file, a feed a Claude session
reads, a tray app. The sender gets a report back, one result per
provider, and never an exception.

ned carries messages to people and between programs. A `log` kind that
only appends a line, and an `alert` that reaches a phone, travel the
same path; the routes are what tell them apart.

It runs three ways, from one core:

- **Standalone:** `ned send` from a script, a hook or a cron job, or the
  library imported into any Bun program, with ned's own config file.
- **Inside a host:** `rafa-notifications`, a rafa module, wraps ned and
  passes it rafa's config, storage and secrets.
- **Through rafa-hub:** later, the hub runs ned with the hub's stack.

## Starting position

- **Prior art, the same code in two places.** The prior notification
  service lives in two private monorepos, and the copies differ only by
  the package scope. They hold an event log with a live SSE stream and an
  approval gate (create, wait, decide). Only the webhook delivers
  anything; mail, push, reminder and prompt are schemas with no delivery.
  Slack and Telegram exist only as design documents in the older
  monorepo: ADR 0007, the channel plugin architecture, and the OPT-206
  notes on chat channels.
- **The prior service carried module-to-module events too:** the executor's
  loop events reached the scheduler over SSE, and Claude Code hook events
  arrived as their own kind.
- **Claude's push cannot be called from outside a session.** Only a running
  Claude session has the `PushNotification` tool. It reaches the phone
  while Remote Control is connected, and Claude skips it when the person
  is active at that terminal.
- **Claude Code has an official Telegram channel** (`telegram@claude-plugins-official`,
  Apache-2.0, a Bun MCP server in one `server.ts`). It carries messages
  between a Telegram bot and a running session, both ways.
- **`@open-tomato/define-config`** is public on npmjs (0.5.x, Apache-2.0,
  no runtime dependencies): typed config entries, an id-keyed merge across
  layers, a loader with no file names of its own, and validation through
  Standard Schema V1, so Zod 4 and Valibot schemas both work. rafa's own
  move to it is rafa #118, not built yet.
- **rafa has no generic storage port.** Its `Store` is the effort-row
  store, and a module receives no store instance through its
  `AdapterContext`.
- **rafa is public on npmjs, and every runtime dependency of a public rafa
  package must be public** (rafa #503). `rafa-notifications` depends on
  ned, so ned publishes to npmjs.

## Phases

| Phase | Holds |
|---|---|
| **PoC** | send only: the core, the `alert` and `notice` kinds, routes, the `claude-feed`, `telegram`, `file` and `tray` providers, in that order |
| **Later** | the contract grows from the PoC: the `question` kind with its reply half, receiving providers, then the rafa-hub add-on with a tested contract and interaction mechanics |
| **MVP** | ned's own mobile push through APNs and FCM (Apple's and Google's push services) |

Work imported complete from the prior art may land before its phase; it
is marked *imported, beyond the PoC* and kept, never cut back.

## Design

### Three parts

```
message in (library, or `ned send`)
→ kind: check the core envelope + the kind's own schema
→ route: which providers this kind goes to (config)
→ provider: delivers to one place
→ report: one result per provider, back to the sender
```

Each part changes without touching the others: a new kind needs no
provider change, and a new provider needs no kind change.

### The core envelope and kinds

Every message carries the core envelope. `kind` selects the kind's
schema, which extends the envelope with its own fields.

```ts
interface CoreMessage {
  id: string            // uuid; ned sets it when missing
  kind: string          // selects the kind's schema
  source: string        // who sent it: 'rafa', 'watchtower', 'cron'
  ts: string            // ISO time; ned sets it when missing
  dedupeKey?: string    // the same key within the window is sent once
}

interface KindDefinition<T extends CoreMessage> {
  kind: string
  schema: StandardSchemaV1<T>      // the envelope + this kind's fields
  render?(msg: T): { title: string; text: string }
}
```

Kinds are an open registry. ned ships two; a host or a program registers
more, such as `log`.

| Kind | Required | Optional | Meaning |
|---|---|---|---|
| `alert` | `title` | `severity` (`warn` default, `error`), `body`, `link` | something needs a person |
| `notice` | `title` | `body`, `link` | something finished, for information |

`question` is reserved and not built: the first interactive kind, with
both halves of the contract, what it sends (`prompt`, `options`) and what
comes back (`answer`, `answeredBy`).

`render` lets a human-facing provider show any kind without knowing it.
A machine-facing provider (a file, a webhook) takes the message as JSON
and never calls it. A kind without `render` shows its `kind` and `id`.

The schemas are typed as Standard Schema V1, so a host may write its
kinds in any compliant library; ned's own are Zod 4.

### Providers

```ts
interface Provider<Config> {
  id: string                          // 'telegram', 'file', 'claude-feed', 'tray'
  configSchema: StandardSchemaV1<Config>
  send(msg: CoreMessage, ctx: SendContext): Promise<SendResult>
}

type SendResult =
  | { status: 'delivered'; ref?: string }        // the provider's own id
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean }

interface SendContext {
  kind: KindDefinition<CoreMessage>   // for render
  secrets(name: string): Promise<string | undefined>
  signal: AbortSignal                 // fires at the provider's timeout
  log: Logger
}
```

- **ned never throws at the sender.** A provider's exception becomes a
  `failed` result.
- **No retries in the PoC.** `retryable` is recorded so retries come
  later without a contract change.
- **Receiving is out of the PoC contract.** A provider that also receives
  arrives with the `question` kind.

The PoC providers:

| Provider | Delivers by | Skips when | Notes |
|---|---|---|---|
| `claude-feed` | appending one `ned· <title>` line to a file | never | ned ships an agent file, `ned-relay`, whose session tails the feed with Monitor and calls `PushNotification` per line. Phone delivery needs that session running with Remote Control connected. |
| `telegram` | Telegram's `sendMessage`, plain text | never | `tokenSecret` and `chatId` in config. Sending never polls for updates, so a bot can be shared with the Claude Telegram channel. Telegram's 429 answer is `failed`, `retryable: true`. |
| `file` | appending the message as one JSON line | never | the journal; the `log` kind's usual target |
| `tray` | one message over the tray app's local socket | the tray app is not running (`skipped: tray not running`) | the tray app is the long-running process, so ned keeps none |

### Routes and config

Config follows define-config. ned's `config` subpath exports
`defineConfig` (define-config's, typed with ned's `Config`), `defaults`
and the `Config` type. A config file is code:

```ts
// ned.config.ts
import { defineConfig, defaults } from '@open-tomato/ned/config'

export default defineConfig([
  defaults,
  {
    providers: {
      phone: { use: 'telegram', tokenSecret: 'ned.telegram.token', chatId: '123456789' },
      feed: { use: 'claude-feed', path: '~/.local/state/ned/feed.ndjson' },
      journal: { use: 'file', path: '~/.local/state/ned/journal.ndjson' },
    },
    routes: {
      everything: { kind: '*', to: ['journal'] },
      alerts: { kind: 'alert', to: ['feed', 'phone'] },
      notices: { kind: 'notice', to: ['phone'] },
    },
    dedupe: { window: '10m' },
  },
])
```

- **Layers:** `defaults`, then the user layer in `~/.config/ned/`, then the
  project layer. The lookup names are `ned.config.ts`, `ned.config.mjs`
  and `.ned/config.yaml`; YAML is read through `Bun.YAML.parse` as a
  loader. `ned send --config <path>` and `NED_CONFIG` name the project
  layer's file instead of the lookup.
- **Keys are shaped for the merge.** `providers` and `routes` are maps
  keyed by id, so a later layer adds an entry, changes it, or removes it
  with `false` (`routes: { notices: false }`). A route's `to` list
  replaces whole.
- **Providers are named instances.** A route points at `phone`, never at
  `telegram`, so two bots coexist and a bot changes without a route
  change.
- **Every matching route applies.** A message goes to the union of the
  targets of every route that matches its kind, each target once. That is
  why `everything` and `alerts` both fire for an alert.
- **No route, no delivery, said aloud.** The report says `routed: false`.
- **Secrets by name only.** Config holds the secret's name, never its
  value, as rafa's `hub.tokenSecret` does.
- **Each provider has a `timeout`**, 5 seconds by default.
- **Diagnostics** come from define-config: an error refuses before any
  delivery; a warning prints once. `ned check` prints them, then each
  kind's targets.

A host does not use the files at all: it passes its own entries, or a
resolved object, to `createNed`.

### Storage and secrets come from the host

ned opens no storage of its own unless the config asks for it.

```ts
interface NedStore {
  // true when the key was not claimed within the window; claims it
  claimDedupe(key: string, windowMs: number, now: number): Promise<boolean>
}

createNed({
  config,          // define-config entries, or a resolved Config
  store?,          // a NedStore; the host's
  secrets?,        // (name) => Promise<string | undefined>; the host's
  log?,
  kinds?,          // extra KindDefinitions
  providers?,      // extra Providers
})
```

- **The store port holds only what the PoC needs:** dedupe claims. It
  grows when a feature needs it (delivery history, `question` state), with
  a contract suite every adapter passes, the pattern rafa #325 set for the
  hub.
- **With no host store and no `store:` in config**, ned uses an in-memory
  store: dedupe then holds within one process only, and `ned check` warns
  about it, since each `ned send` is a new process.
- **`store: { use: 'sqlite', path }`** turns on the bundled `bun:sqlite`
  adapter, for running ned as its own service.
- **Secrets:** with no host resolver, ned reads the OS secret store through
  `Bun.secrets` (service `ned`), then the environment variable
  `NED_SECRET_<NAME>` (the name upper-cased, dots as underscores). A
  headless Linux host often has no unlocked keyring, so the variable is
  the working path there.

### The CLI

```bash
ned send alert --title "loop halted: checkout moved" --source rafa --severity error
ned send notice --title "PR #612 opened" --source rafa --link <url>
ned send --json '{"kind":"alert","source":"cron","title":"backup failed"}'
ned check
```

`ned send` also reads NDJSON from stdin, one message per line. Exit codes:
`0` when every target delivered or skipped, `1` for an invalid message or
config, `2` when any target failed. `--output=json` prints the report.

### The package

One package, `@open-tomato/ned`, public on npmjs, Bun first:

- `.` the library (`createNed`, the built-in kinds and providers);
- `./contract` the types alone (`CoreMessage`, `KindDefinition`,
  `Provider`, `SendResult`, `NedStore`), for hosts and provider authors;
- `./config` `defineConfig`, `defaults`, `Config`;
- `bin: ned`;
- `agents/ned-relay.md`, the Claude relay agent: tools `Read`, `Bash`,
  `Monitor`, `ScheduleWakeup`, `PushNotification`.

The tray app lives in this repository under `apps/tray`, outside the
published package.

### rafa-notifications

A rafa module, a workspace package in the rafa repository, that wraps
ned. It is not built in this spec; this spec only keeps ned shaped for
it.

- It maps rafa's loop events to ned kinds: `halt`, `task-blocked` and
  `error` to `alert`; `pr`, `no-pr` and the run's end to `notice`;
  `task-start` and `task-done` to a `rafa-log` kind it registers.
- It passes rafa's config section, rafa's secret store, and a `NedStore`
  over rafa's storage.
- rafa needs three things it lacks, filed on rafa's board when this module
  is planned: a way for a host to compose a module's config (#118 and #29
  cover neither), a storage field in `AdapterContext`, and a second output
  beside the single active one, so events reach ned and the terminal.

### Importing the existing work

Bootstrap starts by cloning the prior art into `.reference/`, a gitignored
folder in this repository, so its context stays close and reading it
needs no permission outside the project:

| Source | What ned takes |
|---|---|
| the prior service: `services/notifications`, `packages/notifications/*` | `EntityTypeDefinition` → `KindDefinition`; the webhook delivery; the executor event schemas as candidate kinds; the approval loop for `question` |
| the older monorepo's ADR 0007 and OPT-206 notes | the retryable and permanent error split; the Telegram and Slack chat designs |
| the Claude Telegram channel plugin | the Telegram provider's calls (Apache-2.0: keep its notice on copied code) |
| rafa's `src/adapters/output/events.ts`, `src/config-schema-hub.ts` | the one-line prefix format; the secret-by-name pattern |
| `@open-tomato/define-config` | the loader, merge and validation, as a dependency |

As much as works is imported rather than rewritten. These prior defects
are not carried:

- `anthropic` is in the schema's enum but in no migration;
- a client reads an SSE stream with `res.json()`;
- the approvals list ignores its `pending` filter;
- a webhook URL is fetched with no allowlist, a server-side request
  forgery risk; ned's webhook provider takes its URLs from config only.

## The spike: answering a stop from a chat

Filed in ned's backlog as a spike, outside the PoC. A rafa stop that needs
an answer is faked as interactive by resuming the waiting Claude session
with the answer. Two routes to measure:

1. `claude -p --resume <session-id> "<answer>"`. Reported to send a
   follow-up turn to a session still running from Claude Code 2.1.285;
   unmeasured on 2.1.283.
2. The Claude Telegram channel: the session runs with
   `--channels plugin:telegram@claude-plugins-official`, asks in Telegram,
   and the answer arrives as a channel message. `--remote-control` covers
   the same from the Claude app.

The spike reports which route works, from which version, and what two
writers on one session do. Its answer shapes the `question` kind.

## What can go wrong

- **No relay session runs.** `claude-feed` delivers to the file and
  nothing reaches the phone. The `ned-relay` agent's description says so,
  and `ned check` names the feed's path so its tail can be checked.
- **Claude skips a push** when the person is active at the relay's
  terminal. That is Claude's rule; Telegram is the route that always
  delivers.
- **A dedupe that does not hold** across `ned send` calls, with the
  in-memory store. `ned check` warns; the fix is a host store or
  `store: sqlite`.
- **A Telegram token in a config file.** Config takes a secret's name
  only; a value shaped like a bot token in config is a diagnostic error.
- **A slow provider** delays the sender up to its timeout, never more.

## Tasks the plan must carry

- Bootstrap: the `.reference/` clones; the package with its subpaths; the
  define-config dependency; lint and test gates.
- The contract: `CoreMessage`, `KindDefinition`, `Provider`, `SendResult`,
  `NedStore`, as `./contract`.
- The core: `createNed`, validation, route resolution with the union
  rule, dedupe, the report.
- The config: `defineConfig`, `defaults`, the schema, the loader with its
  layers and lookup names, diagnostics.
- Storage and secrets: the in-memory store, the `bun:sqlite` adapter, the
  store contract suite, the default secret resolver.
- Providers in order: `claude-feed` with `ned-relay`, `telegram`, `file`,
  `tray` with the tray app.
- The CLI: `ned send`, `ned check`, exit codes, `--output=json`.
- Tests: each provider against a contract suite; kinds; routes; config
  layers; the CLI spawned.
- README and a `docs/` page per part.

## Definition of done (PoC)

- `ned send alert --title t --source s` with a route to `phone` puts a
  message in the Telegram chat, and the report says `delivered` with the
  message id.
- The same alert with a route to `feed` and `ned-relay` running with
  Remote Control connected reaches the phone, while the person is away
  from that terminal.
- A `log` kind registered by a program, routed to `journal` only, appends
  one JSON line and pushes nothing.
- Two `ned send` calls with one `dedupeKey` inside the window, with
  `store: sqlite`: the second reports `skipped`.
- A project layer with `routes: { notices: false }` over a user layer
  that routes notices: a notice reports `routed: false`.
- With the tray app closed, a tray target reports `skipped: tray not
  running` and the command exits 0.
- `createNed` given a host store and secret resolver opens no file under
  `~/.config/ned/` or `~/.local/state/ned/`.

## Open questions

- The tray app's stack and socket (a menu-bar app per OS, or one
  cross-platform shell), decided when the tray provider is planned.
- The repository's visibility on GitHub; the npm package is public either
  way.

## For the documentation writer

**Use cases, lightest first**

- *One person, one machine.* A cron job or a Claude hook runs
  `ned send alert ...`; a user-layer `ned.config.ts` routes alerts to
  Telegram.
- *A rafa stretch on a loop host.* `rafa-notifications` sends halts and
  blocks as alerts; the person gets them on the phone through Telegram,
  or through `ned-relay` and Claude's push.
- *Module to module.* A program registers a `log` kind and routes it to a
  file; another reads the file. Nothing reaches a person.
- *ned as its own service.* `store: sqlite`, secrets from the environment,
  inside another stack.

**Edge cases worth an example**

- An alert that reaches the journal and the phone at once, through two
  routes.
- A project turning off a user's route with `false`.
- A push Claude skips because the person is at the terminal.
- A headless Linux host with no keyring, reading `NED_SECRET_*`.

**Config, from empty up**

```ts
// empty: no routes; every message reports routed: false
export default defineConfig([defaults])
```

```ts
// one Telegram chat for alerts
export default defineConfig([defaults, {
  providers: { phone: { use: 'telegram', tokenSecret: 'ned.telegram.token', chatId: '123' } },
  routes: { alerts: { kind: 'alert', to: ['phone'] } },
}])
```

```ts
// a project layer turning the user's notices off
export default defineConfig([{ routes: { notices: false } }])
```

**Analogies used**

- Log shippers such as Vector: sources, routes, sinks. ned's kinds,
  routes and providers are the same three parts.
- Kent Brockman's Channel 6 was a naming candidate; the reader picked Ned
  Flanders, the neighbour shouting over the fence.

**Rejected alternatives**

- A local daemon as the way in: a background process must run before
  anything sends. The tray app is the only long-running part.
- A closed list of kinds: ned also carries module-to-module events, whose
  kinds ned cannot know.
- Routes as a list: a later config layer would replace every route.
- First matching route only: rules out a journal of everything beside
  specific routes.
- YAML as the format: define-config is the shared strategy; YAML stays
  readable as one layer.
- ned's own storage by default: inside a host it reuses the host's.
