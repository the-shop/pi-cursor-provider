import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../index.ts";

const FAILURES: string[] = [];
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  if (!condition) {
    FAILURES.push(label);
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq<T>(label: string, actual: T, expected: T): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

interface ProviderConfig {
  api: string;
  baseUrl: string;
  refreshModels: (context: Record<string, unknown>) => Promise<Array<Record<string, any>>>;
  streamSimple: (model: Record<string, unknown>, context: Record<string, unknown>, options?: Record<string, unknown>) => AsyncIterable<Record<string, any>>;
}

const root = mkdtempSync(join(tmpdir(), "pi cursor provider e2e "));
const stubPath = join(root, "cursor agent stub.mjs");
const discoveryCapture = join(root, "discovery.json");
copyFileSync(new URL("./cursor-agent-stub.mjs", import.meta.url), stubPath);
chmodSync(stubPath, 0o755);

function context(): Record<string, unknown> {
  return {
    messages: [
      { role: "system", content: "You are the test agent.", timestamp: 1 },
      { role: "user", content: "first turn", timestamp: 2 },
      {
        role: "assistant",
        api: "other-api",
        provider: "other",
        model: "other-model",
        timestamp: 3,
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "previous-call", name: "read", arguments: { path: "notes.txt" } },
        ],
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "previous-call",
        toolName: "read",
        isError: false,
        timestamp: 4,
        content: [{ type: "text", text: "file body" }],
      },
      { role: "user", content: "ping 🌍", timestamp: 5 },
    ],
  };
}

async function collect(
  config: ProviderConfig,
  model: Record<string, unknown>,
  options: Record<string, unknown>,
  timeoutMs = 4_000,
): Promise<Array<Record<string, any>>> {
  const events: Array<Record<string, any>> = [];
  let timedOut = false;
  const timeoutController = new AbortController();
  const suppliedSignal = options.signal as AbortSignal | undefined;
  const streamOptions = {
    ...options,
    signal: suppliedSignal ? AbortSignal.any([suppliedSignal, timeoutController.signal]) : timeoutController.signal,
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  timeout.unref();
  try {
    for await (const event of config.streamSimple(model, context(), streamOptions)) {
      events.push(structuredClone(event));
    }
  } finally {
    clearTimeout(timeout);
  }
  check("stream completed before hard timeout", !timedOut);
  return events;
}

function terminalEvents(events: Array<Record<string, any>>): Array<Record<string, any>> {
  return events.filter((event) => event.type === "done" || event.type === "error");
}

function assertSingleTerminal(label: string, events: Array<Record<string, any>>, type: "done" | "error"): void {
  const terminals = terminalEvents(events);
  eq(`${label}: one terminal event`, terminals.length, 1);
  eq(`${label}: terminal type`, terminals[0]?.type, type);
  eq(`${label}: terminal is last`, events.at(-1)?.type, type);
}

try {
  process.env.CURSOR_AGENT_PATH = stubPath;
  process.env.CURSOR_PI_STUB_DISCOVERY_CAPTURE = discoveryCapture;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_PI_NO_FORCE;

  const providers = new Map<string, ProviderConfig>();
  factory({ registerProvider: (name: string, config: ProviderConfig) => providers.set(name, config) } as never);
  const config = providers.get("cursor")!;
  const models = await config.refreshModels({
    allowNetwork: true,
    signal: new AbortController().signal,
    credential: undefined,
    publish: async () => true,
  });
  const definition = models.find((entry) => entry.id === "claude-sonnet-5-thinking") ?? models[0];
  const model = {
    ...definition,
    api: config.api,
    provider: "cursor",
    baseUrl: config.baseUrl,
  };

  console.log("=== happy path and instrumentation ===");
  const happyCapture = join(root, "happy.json");
  const hookOrder: string[] = [];
  const rawTypes: string[] = [];
  let payloadSeen: { argv: string[]; prompt: string } | undefined;
  let responseSeen: unknown;
  process.env.CURSOR_AGENT_PATH = join(root, "ambient path must lose");
  process.env.CURSOR_PI_ENV_PROBE = "ambient";
  const happy = await collect(config, model, {
    env: {
      CURSOR_AGENT_PATH: stubPath,
      CURSOR_PI_STUB_CAPTURE: happyCapture,
      CURSOR_PI_STUB_SCENARIO: "happy",
      CURSOR_PI_ENV_PROBE: "scoped",
    },
    reasoning: "xhigh",
    onPayload: async (payload: unknown) => {
      hookOrder.push("payload");
      payloadSeen = payload as { argv: string[]; prompt: string };
      const replacement = structuredClone(payloadSeen);
      const modelIndex = replacement.argv.indexOf("--model");
      replacement.argv[modelIndex + 1] = "claude-sonnet-5-thinking-xhigh";
      replacement.prompt += "\n\n[Hook]\nreplacement";
      return replacement;
    },
    onResponse: async (response: unknown) => {
      hookOrder.push("response");
      responseSeen = response;
    },
    onProviderStreamEvent: async (event: unknown) => {
      const type = (event as { type: string }).type;
      hookOrder.push(`event:${type}`);
      rawTypes.push(type);
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
  });
  assertSingleTerminal("happy", happy, "done");
  eq("start is first", happy[0]?.type, "start");
  eq("start snapshot has pending stop reason", happy[0]?.partial?.stopReason, "pending");
  eq("done reason", happy.at(-1)?.reason, "stop");
  eq("final message reason", happy.at(-1)?.message?.stopReason, "stop");
  check("no error event on success", !happy.some((event) => event.type === "error"));
  check("thinking precedes text", happy.findIndex((event) => event.type === "thinking_delta") < happy.findIndex((event) => event.type === "text_delta"));
  eq("thinking delta preserved", happy.find((event) => event.type === "thinking_delta")?.delta, "ponder");
  eq("split UTF-8 text preserved", happy.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""), "hello 🌍");
  check("Cursor-internal tool args are not transcript text", !JSON.stringify(happy).includes("internal-only"));
  check("Cursor tools do not become Pi tool calls", !happy.some((event) => String(event.type).startsWith("toolcall")));
  eq("raw event hook sees every parsed event", rawTypes, ["thinking", "thinking", "assistant", "tool_call", "telemetry", "result"]);
  eq("hook order starts payload then response", hookOrder.slice(0, 2), ["payload", "response"]);
  check("provider events follow response hook", hookOrder.slice(2).every((entry) => entry.startsWith("event:")));
  eq("synthetic subprocess response", responseSeen, { status: 0, headers: { "x-pi-transport": "subprocess" } });
  check("payload hook receives argv", Array.isArray(payloadSeen?.argv));
  check("payload hook receives complete prompt", payloadSeen?.prompt.includes("[System]\nYou are the test agent.") === true);
  const happyResult = happy.at(-1)?.message;
  eq("camel-case usage", {
    input: happyResult?.usage.input,
    output: happyResult?.usage.output,
    cacheRead: happyResult?.usage.cacheRead,
    cacheWrite: happyResult?.usage.cacheWrite,
    reasoning: happyResult?.usage.reasoning,
    totalTokens: happyResult?.usage.totalTokens,
  }, { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, reasoning: 1, totalTokens: 23 });

  const captured = JSON.parse(readFileSync(happyCapture, "utf8")) as {
    argv: string[];
    prompt: string;
    env: { apiKey: string | null; probe: string | null };
  };
  eq("default argv enables non-interactive tool execution", captured.argv, [
    "--print",
    "--force",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    "claude-sonnet-5-thinking-xhigh",
  ]);
  for (const removed of ["--yolo", "--trust", "--workspace", "--api-key"]) {
    check(`argv omits ${removed}`, !captured.argv.includes(removed));
  }
  eq("payload replacement controls exact model", captured.argv[captured.argv.indexOf("--model") + 1], "claude-sonnet-5-thinking-xhigh");
  check("payload replacement controls stdin", captured.prompt.endsWith("[Hook]\nreplacement"));
  check("stdin has current system prompt", captured.prompt.includes("[System]\nYou are the test agent."));
  check("stdin has user history", captured.prompt.includes("[User]\nfirst turn"));
  check("stdin has assistant tool-call history", captured.prompt.includes('[Tool call: read, id: previous-call]\n{"path":"notes.txt"}'));
  check("stdin has tool result history", captured.prompt.includes("[Tool result: read, id: previous-call, status: ok]\nfile body"));
  eq("ambient CLI login leaves key unset", captured.env.apiKey, null);
  eq("provider-scoped env wins", captured.env.probe, "scoped");

  const starts = happy.filter((event) => event.type.endsWith("_start"));
  const ends = happy.filter((event) => event.type.endsWith("_end"));
  eq("happy content blocks balanced", starts.map((event) => [event.type.replace("_start", ""), event.contentIndex]), ends.map((event) => [event.type.replace("_end", ""), event.contentIndex]));

  console.log("=== empty, usage, and payload fallback ===");
  const emptyCapture = join(root, "empty.json");
  const empty = await collect(config, model, {
    env: {
      CURSOR_AGENT_PATH: stubPath,
      CURSOR_PI_NO_FORCE: "1",
      CURSOR_PI_STUB_CAPTURE: emptyCapture,
      CURSOR_PI_STUB_SCENARIO: "empty",
    },
    apiKey: "test-key",
    onPayload: () => ({ argv: "invalid", prompt: 42 }),
  });
  assertSingleTerminal("empty", empty, "done");
  eq("empty success has no content blocks", empty.at(-1)?.message?.content, []);
  const emptyCaptured = JSON.parse(readFileSync(emptyCapture, "utf8")) as { argv: string[]; env: { apiKey: string | null } };
  eq("CURSOR_PI_NO_FORCE=1 omits the default force flag", emptyCaptured.argv, [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    "claude-sonnet-5-thinking-high",
  ]);
  check("invalid payload replacement is ignored", emptyCaptured.argv.includes("--stream-partial-output"));
  eq("request API key uses environment only", emptyCaptured.env.apiKey, "test-key");
  check("request API key never enters argv", !emptyCaptured.argv.includes("test-key"));

  const snake = await collect(config, model, {
    env: { CURSOR_AGENT_PATH: stubPath, CURSOR_PI_STUB_CAPTURE: join(root, "snake.json"), CURSOR_PI_STUB_SCENARIO: "snake-usage" },
  });
  assertSingleTerminal("snake usage", snake, "done");
  eq("snake-case usage", snake.at(-1)?.message?.usage.totalTokens, 14);

  console.log("=== provider and process failures ===");
  for (const [scenario, expectedMessage] of [
    ["partial-error", "provider rejected request"],
    ["nonzero", "cursor-agent exited with code 7"],
    ["malformed", "malformed stream-json"],
    ["truncated", "malformed stream-json"],
    ["oversized-line", "stream-json event exceeded the 1048576-byte limit"],
  ] as const) {
    const events = await collect(config, model, {
      env: {
        CURSOR_AGENT_PATH: stubPath,
        CURSOR_PI_STUB_CAPTURE: join(root, `${scenario}.json`),
        CURSOR_PI_STUB_SCENARIO: scenario,
      },
    });
    assertSingleTerminal(scenario, events, "error");
    eq(`${scenario}: stop reason`, events.at(-1)?.error?.stopReason, "error");
    check(`${scenario}: concrete error`, String(events.at(-1)?.error?.errorMessage).includes(expectedMessage), events.at(-1)?.error?.errorMessage);
    if (scenario === "partial-error" || scenario === "nonzero" || scenario === "malformed") {
      check(`${scenario}: partial text retained`, events.some((event) => event.type === "text_delta"));
      eq(`${scenario}: text block balanced`, events.filter((event) => event.type === "text_start").length, events.filter((event) => event.type === "text_end").length);
    }
    if (scenario === "oversized-line") {
      check("oversized-line: event is rejected before normalization", !events.some((event) => event.type === "text_delta"));
    }
  }

  const spawnFailure = await collect(config, model, {
    env: { CURSOR_AGENT_PATH: join(root, "does not exist"), CURSOR_PI_STUB_SCENARIO: "happy" },
  });
  assertSingleTerminal("spawn failure", spawnFailure, "error");
  check("spawn failure emits no start", !spawnFailure.some((event) => event.type === "start"));
  check("spawn failure is concrete", /ENOENT|spawn/.test(spawnFailure.at(-1)?.error?.errorMessage ?? ""));

  console.log("=== callback failures ===");
  const payloadFailure = await collect(config, model, {
    env: { CURSOR_AGENT_PATH: stubPath, CURSOR_PI_STUB_CAPTURE: join(root, "payload-failure.json") },
    onPayload: () => { throw new Error("payload observer failed"); },
  });
  assertSingleTerminal("payload callback", payloadFailure, "error");
  check("payload callback failure is pre-start", !payloadFailure.some((event) => event.type === "start"));
  check("payload callback error preserved", payloadFailure.at(-1)?.error?.errorMessage === "payload observer failed");

  const responseFailure = await collect(config, model, {
    env: { CURSOR_AGENT_PATH: stubPath, CURSOR_PI_STUB_CAPTURE: join(root, "response-failure.json") },
    onResponse: () => { throw new Error("response observer failed"); },
  });
  assertSingleTerminal("response callback", responseFailure, "error");
  check("response callback failure is pre-start", !responseFailure.some((event) => event.type === "start"));
  check("response callback error preserved", responseFailure.at(-1)?.error?.errorMessage === "response observer failed");

  const providerHookFailure = await collect(config, model, {
    env: { CURSOR_AGENT_PATH: stubPath, CURSOR_PI_STUB_CAPTURE: join(root, "provider-hook-failure.json") },
    onProviderStreamEvent: () => { throw new Error("provider observer failed"); },
  });
  assertSingleTerminal("provider callback", providerHookFailure, "error");
  check("provider callback failure follows start", providerHookFailure.some((event) => event.type === "start"));
  check("provider callback error preserved", providerHookFailure.at(-1)?.error?.errorMessage === "provider observer failed");

  console.log("=== abort ===");
  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortCapture = join(root, "pre-abort.json");
  const beforeAbort = await collect(config, model, {
    signal: preAborted.signal,
    env: { CURSOR_AGENT_PATH: stubPath, CURSOR_PI_STUB_CAPTURE: preAbortCapture },
  });
  assertSingleTerminal("pre-abort", beforeAbort, "error");
  eq("pre-abort reason", beforeAbort.at(-1)?.reason, "aborted");
  eq("pre-abort message", beforeAbort.at(-1)?.error?.errorMessage, "Request aborted");
  check("pre-abort does not spawn", !existsSync(preAbortCapture));

  const midAbort = new AbortController();
  const signalCapture = join(root, "stream-signal.txt");
  const abortPromise = collect(config, model, {
    signal: midAbort.signal,
    env: {
      CURSOR_AGENT_PATH: stubPath,
      CURSOR_PI_STUB_CAPTURE: join(root, "abort.json"),
      CURSOR_PI_STUB_SCENARIO: "abort",
      CURSOR_PI_STUB_SIGNAL_CAPTURE: signalCapture,
    },
  });
  setTimeout(() => midAbort.abort(), 60);
  const aborted = await abortPromise;
  assertSingleTerminal("mid-abort", aborted, "error");
  eq("mid-abort reason", aborted.at(-1)?.reason, "aborted");
  eq("mid-abort stop reason", aborted.at(-1)?.error?.stopReason, "aborted");
  eq("mid-abort message", aborted.at(-1)?.error?.errorMessage, "Request aborted");
  check("mid-abort closes partial block", aborted.filter((event) => event.type === "text_start").length === aborted.filter((event) => event.type === "text_end").length);
  check("abort reaches child", existsSync(signalCapture) && readFileSync(signalCapture, "utf8").includes("stream:SIGTERM"));
} finally {
  delete process.env.CURSOR_AGENT_PATH;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_PI_NO_FORCE;
  delete process.env.CURSOR_PI_ENV_PROBE;
  delete process.env.CURSOR_PI_STUB_DISCOVERY_CAPTURE;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n=== ${FAILURES.length === 0 ? `E2E PASSED (${checks} checks)` : `E2E FAILED (${FAILURES.length}/${checks})`} ===`);
for (const failure of FAILURES) console.log(`  - ${failure}`);
process.exit(FAILURES.length === 0 ? 0 : 1);
