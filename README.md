# pi-cursor-provider

Cursor subscription models for the [pi](https://github.com/the-shop/pi-the-shop) coding agent. The package registers provider id `cursor`, discovers the account's live model catalog, and routes each turn through the `cursor-agent` CLI.

## Status: working

The provider supports live model refresh, exact effort variants through Pi thinking levels, stateless transcript replay over stdin, streamed text and thinking, usage reporting, cancellation, and request instrumentation.

## Install

```sh
pi install npm:pi-cursor-provider
```

The git package can also be installed directly:

```sh
pi install git:github.com/the-shop/pi-cursor-provider
```

## Requirements

- Node.js 22 or newer
- pi 1.0 or newer
- `cursor-agent` on `PATH`, or `CURSOR_AGENT_PATH` set to the executable
- An existing Cursor CLI login (`cursor-agent login`) or `CURSOR_API_KEY`

Authentication remains owned by the Cursor CLI. This package does not implement another login flow and does not put API keys in process arguments.

## Usage

Select a discovered family with Pi's model command:

```text
/model cursor/<family>
```

When a family has exact effort variants, `/thinking` offers only the matching levels. For example, a family discovered with `high` and `xhigh` variants exposes those levels; unsupported levels are not approximated.

The catalog comes from `cursor-agent --list-models`. Discovery failure is surfaced instead of being hidden behind a bundled model snapshot.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CURSOR_AGENT_PATH` | Cursor CLI executable. Defaults to `cursor-agent`. Paths containing spaces are supported. |
| `CURSOR_API_KEY` | Optional Cursor API key inherited by the child process. Omit it to use the CLI's existing login. |

Provider-scoped request environment values override the ambient process environment.

## Safety

The provider does **not** pass `--force`, `--yolo`, or `--trust`. Cursor can therefore request approval or workspace trust according to its own configuration. The package does not silently approve commands or trust a workspace.

Cursor executes its own internal tools. Their stream events are observable through Pi's provider-event hook, but they are not converted into Pi tool calls or persisted as assistant prose. Pi tool declarations are not bridged into Cursor.

## How it works

1. Pi refreshes the provider catalog through a cancellable `cursor-agent --list-models` subprocess.
2. Exact effort suffixes are grouped into one `/model cursor/<family>` entry. Fast variants remain separate families.
3. On every turn, the current system prompt and normalized transcript are serialized as text and written to stdin.
4. The CLI runs with `--print --output-format stream-json --stream-partial-output --model <exact-id>`.
5. Ordered stream-json events become balanced Pi text/thinking events. A Cursor `result` event supplies token usage.

The transcript serializer preserves user text, assistant text, prior Pi tool calls, tool results, errors, empty messages, and image metadata placeholders. Previous assistant thinking is not replayed. The provider declares text-only input and never sends image bytes to the CLI.

### Request instrumentation

Pi's HTTP-shaped hooks map to this subprocess transport as follows:

| Pi hook | Cursor CLI mapping |
| --- | --- |
| `onPayload` | Receives `{ argv, prompt }` before spawn. A replacement with a string-array `argv` and string `prompt` is used; an unusable replacement is ignored. Credentials are not included. |
| `onResponse` | Runs after the child emits `spawn` and before stdout is consumed, with `{ status: 0, headers: { "x-pi-transport": "subprocess" } }`. Status `0` deliberately denotes a non-HTTP subprocess, not an HTTP success code. |
| `onProviderStreamEvent` | Awaited once for every parsed stream-json event before that event is normalized. |

There is no HTTP status, response-header set, custom fetch implementation, or Pi structured-tool handoff at this transport boundary.

## Model metadata

`--list-models` reports ids and display names, but not context or output limits. The package therefore publishes adapter estimates, not vendor guarantees:

| Signal | Context estimate | Output estimate |
| --- | ---: | ---: |
| Display name contains `1M` | 1,000,000 | 16,384 |
| Family id contains `gemini` | 1,000,000 | 16,384 |
| Otherwise | 128,000 | 16,384 |

Input is text-only and subscription token costs are reported as zero. These values describe Pi catalog metadata; they are not Cursor billing data or service-level guarantees.

## Tests

No install, network access, Cursor login, or quota is needed for the default checks:

```sh
npm test                 # secret scan, pure unit checks, registration checks
npm run test:e2e         # deterministic cursor-agent stub
npm run secret-scan
```

A real CLI smoke test is explicitly opt-in and may consume quota:

```sh
CURSOR_PI_E2E_REAL=1 npm run test:e2e:real
```

## License

MIT. See `LICENSE`.

Portions are derived from `@netandreus/pi-cursor-provider` 0.1.4 (MIT). See `THIRD_PARTY.md`.
