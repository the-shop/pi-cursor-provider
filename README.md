# pi-cursor-provider

Cursor subscription models for the [pi](https://github.com/the-shop/pi-the-shop) coding agent. The package registers provider id `cursor`, discovers the account's live model catalog, and routes each turn through the `cursor-agent` CLI.

## Status: working

The provider supports live model refresh, exact effort variants through Pi thinking levels, stateless transcript replay over stdin, streamed text and thinking, usage reporting, cancellation, and request instrumentation.

## Install

This package is not published to npm. Install it directly from GitHub:

```sh
pi install git:github.com/the-shop/pi-cursor-provider
```

Or, from a local checkout:

```sh
pi install .
```

No `npm install` step is required.

## Requirements

- Node.js 22.6 or newer
- pi 1.0 or newer
- A `cursor-agent` build supporting `--list-models`, `--print`, `--output-format stream-json`, `--stream-partial-output`, `--model`, and `--force`, available on `PATH` or selected with `CURSOR_AGENT_PATH`
- An existing Cursor CLI login (`cursor-agent login`) or `CURSOR_API_KEY`

Authentication remains owned by the Cursor CLI. This package does not implement another login flow and does not put API keys in process arguments.

## Usage

Verify model discovery with `pi --list-models`, then start Pi and select one of the listed `cursor/<family>` entries.

```text
/model cursor/<family>
```

When a family has exact effort variants, `/thinking` offers only the matching levels. For example, a family discovered with `high` and `xhigh` variants exposes those levels; unsupported levels are not approximated.

The catalog is discovered by launching the local `cursor-agent --list-models` subprocess, including during Pi's initial refresh when `allowNetwork` is `false`; the adapter itself makes no provider HTTP request. If that subprocess cannot start, exits unsuccessfully, times out, is aborted, or returns no usable models, refresh rejects. There is no bundled fallback, so on first load no `cursor` models are available until discovery succeeds.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CURSOR_AGENT_PATH` | Cursor CLI executable. Defaults to `cursor-agent`. Paths containing spaces are supported. |
| `CURSOR_API_KEY` | Optional Cursor API key inherited by the child process. Omit it to use the CLI's existing login. |
| `CURSOR_PI_STREAM_TIMEOUT_MS` | Maximum duration of a streaming turn in milliseconds. Positive integers are accepted; the default is 600000 (10 minutes). |
| `CURSOR_PI_NO_FORCE` | Set to `1` to omit the default `--force`. In non-interactive `--print` mode, approval-gated shell calls are then rejected rather than prompting. |

Provider-scoped request environment values override the ambient process environment.

## Safety

By default, the provider passes `--force`. Cursor runs in non-interactive `--print` mode, where approval prompts cannot be answered; without `--force`, shell tool calls that require approval are rejected. `--force` allows those calls without interactive confirmation, so Cursor may execute commands and modify files. It does not override Cursor's own configured deny rules. The child inherits Pi's working directory and environment, so use an appropriate workspace or sandbox.

Set `CURSOR_PI_NO_FORCE=1` to omit `--force`. The provider-generated argv does not add `--yolo` or `--trust`. An `onPayload` hook can replace `argv` and therefore can change these flags.

Cursor executes its own internal tools. Their stream events are observable through Pi's provider-event hook, but they are not converted into Pi tool calls or persisted as assistant prose. Pi tool declarations are not bridged into Cursor.

## How it works

1. Pi refreshes the provider catalog through a cancellable local `cursor-agent --list-models` subprocess.
2. Exact effort suffixes are grouped into one `/model cursor/<family>` entry. Fast variants remain separate families.
3. On every turn, the current system prompt and normalized transcript are serialized as text and written to stdin.
4. The CLI runs with `--print --force --output-format stream-json --stream-partial-output --model <exact-id>` by default. `CURSOR_PI_NO_FORCE=1` omits `--force`.
5. Ordered stream-json events become balanced Pi text/thinking events. A Cursor `result` event supplies token usage.

The transcript serializer preserves user text, assistant text, prior Pi tool calls, tool results, errors, empty messages, and image metadata placeholders. To keep its readable boundaries unambiguous, marker-like lines in message bodies (such as `[System]` or `[/User]`) are prefixed with a backslash. Previous assistant thinking is not replayed. The provider declares text-only input and never sends image bytes to the CLI.

### Request instrumentation

Pi's HTTP-shaped hooks map to this subprocess transport as follows:

| Pi hook | Cursor CLI mapping |
| --- | --- |
| `onPayload` | Receives `{ argv, prompt }` before spawn. A replacement with a string-array `argv` and string `prompt` is used; an unusable replacement is ignored. The provider does not add configured API credentials to generated argv; authentication is passed through the child environment. |
| `onResponse` | Runs after the child emits `spawn` and before stdout is consumed, with `{ status: 0, headers: { "x-pi-transport": "subprocess" } }`. Status `0` deliberately denotes a non-HTTP subprocess, not an HTTP success code. |
| `onProviderStreamEvent` | Awaited once for every parsed stream-json event before that event is normalized. |

The status and header above are synthetic subprocess metadata; there is no HTTP request or response, custom fetch implementation, or Pi structured-tool handoff at this boundary.

## Model metadata

`--list-models` reports ids and display names, but not context or output limits. The package therefore publishes adapter estimates, not vendor guarantees:

| Signal | Context estimate | Output estimate |
| --- | ---: | ---: |
| Any discovered display name in the family contains `1M` | 1,000,000 | 16,384 |
| Family id contains `gemini` | 1,000,000 | 16,384 |
| Otherwise | 128,000 | 16,384 |

Input is text-only and subscription token costs are reported as zero. These values describe Pi catalog metadata; they are not Cursor billing data or service-level guarantees.

## How this compares

Two ways to reach Cursor from pi exist, and they trade different risks.

| | This package (`cursor-agent` transport) | OAuth/proxy extensions |
| --- | --- | --- |
| Transport | official `cursor-agent` CLI, `stream-json` events | reverse-engineered Cursor gRPC behind a local OpenAI-compatible proxy |
| Runtime dependencies | none | protobuf runtime plus a local HTTP/2 bridge process |
| Setup | install the CLI once, then `cursor-agent login` | sign in from inside pi |
| Tool execution | Cursor runs its own tools; Pi observes the events | Pi's tools are bridged into Cursor, so Pi owns the tool calls |
| Breakage surface | the CLI's event schema | Cursor's private API and auth flow |

Where this package's value is:

- It rides the public CLI surface, so it does not depend on reverse-engineered
  API shapes or an undocumented auth flow.
- No runtime dependencies, no local server, and no sidecar processes: one
  extension entry plus its logic module.
- Stream handling is regression-covered without quota: unit, registration, and
  deterministic stub checks, plus an opt-in real smoke test.
- Contract hygiene: a streaming deadline, bounded CLI output, cancellation
  mapped to `aborted`, request instrumentation hooks, and documented metadata
  estimates instead of invented precision.
- Honest defaults: `--force` is on by default so tools actually run in print
  mode, with `CURSOR_PI_NO_FORCE=1` as the documented opt-out.

When this is not the right choice: if you need Pi to own and approve tool calls
(MCP bridging), or you cannot install `cursor-agent`, use an OAuth/proxy
extension instead. Input here is text-only, and a failed discovery leaves the
model list empty rather than falling back to a stale catalog.

## Tests

No dependency installation, network access, Cursor login, or quota is needed for the default checks:

```sh
npm test                 # secret scan, pure unit checks, registration checks
npm run test:e2e         # deterministic cursor-agent stub
npm run secret-scan
```

A real CLI smoke test is explicitly opt-in and consumes quota for two model turns. Its second turn uses the default `--force` to perform one approval-gated shell write in a temporary directory and verifies the completed tool lifecycle:

```sh
CURSOR_PI_E2E_REAL=1 npm run test:e2e:real
```

Run it only when intentionally exercising the release-default safety behavior. Do not set `CURSOR_PI_NO_FORCE=1` for this check.

## License

MIT. See `LICENSE`.

Portions are derived from `@netandreus/pi-cursor-provider` 0.1.4 (MIT). See `THIRD_PARTY.md`.
