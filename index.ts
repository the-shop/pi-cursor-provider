/**
 * Pi provider `cursor`: live Cursor CLI model discovery and stateless
 * transcript-over-stdin streaming.
 *
 * The host supplies a normalized TranscriptContext. Its current prompt is read
 * with getCurrentSystemPrompt(context.messages).
 *
 * Derived from @netandreus/pi-cursor-provider 0.1.4 (MIT). See THIRD_PARTY.md.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildFamilies,
  familySupportsReasoning,
  levelsFor,
  parseModelsOutput,
  resolveVariant,
  serializeTranscript,
  type Family,
  type RawModel,
} from "./logic.ts";

const PROVIDER_ID = "cursor";
const API_ID = "cursor-cli" as Api;
const BASE_URL = "cli://cursor-agent";
const DEFAULT_AGENT_PATH = "cursor-agent";
const DISCOVERY_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 1_000;
const STDERR_LIMIT = 8_192;

// The legacy registration contract requires an API-key value even though the
// Cursor CLI owns ambient login. This non-secret sentinel is never sent to it.
const LEGACY_AUTH_SENTINEL = "cursor-agent-login";

interface CursorPayload {
  argv: string[];
  prompt: string;
}

interface CursorModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ReturnType<typeof levelsFor>;
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

type StringEnv = Record<string, string | undefined>;
type CursorEvent = Record<string, unknown> & { type: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= STDERR_LIMIT) return current;
  return (current + chunk).slice(0, STDERR_LIMIT);
}

function terminate(child: ReturnType<typeof spawn>): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref();
  return timer;
}

function discoverModels(agentPath: string, env: StringEnv, signal: AbortSignal): Promise<RawModel[]> {
  if (signal.aborted) return Promise.reject(abortError("Cursor model discovery aborted"));

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(agentPath, ["--list-models"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });

    const timeout = setTimeout(() => {
      killTimer = terminate(child);
      settle(reject, new Error(`cursor-agent --list-models timed out after ${DISCOVERY_TIMEOUT_MS}ms`));
    }, DISCOVERY_TIMEOUT_MS);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      killTimer = terminate(child);
      settle(reject, abortError("Cursor model discovery aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    child.on("error", (error) => settle(reject, error));
    child.on("close", (code, closeSignal) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      if (signal.aborted) {
        settle(reject, abortError("Cursor model discovery aborted"));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        settle(
          reject,
          new Error(`cursor-agent --list-models exited with code ${code}${detail ? `: ${detail}` : ""}`),
        );
        return;
      }
      if (closeSignal) {
        settle(reject, new Error(`cursor-agent --list-models terminated by ${closeSignal}`));
        return;
      }
      const models = parseModelsOutput(stdout);
      if (models.length === 0) {
        settle(reject, new Error("cursor-agent --list-models returned no usable models"));
        return;
      }
      settle(resolve, models);
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usablePayload(value: unknown): value is CursorPayload {
  return isRecord(value)
    && Array.isArray(value.argv)
    && value.argv.every((argument) => typeof argument === "string")
    && typeof value.prompt === "string";
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function childOutcome(child: ReturnType<typeof spawn>): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ChildOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

function writePrompt(child: ReturnType<typeof spawn>, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = child.stdin;
    if (!input) {
      reject(new Error("cursor-agent stdin is unavailable"));
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    input.once("error", onError);
    input.end(prompt, () => finish());
  });
}

function numberField(object: Record<string, unknown>, names: readonly string[], required: boolean): number {
  const value = names.map((name) => object[name]).find((candidate) => candidate !== undefined);
  if (value === undefined && !required) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Cursor result has invalid usage field ${names[0]}`);
  }
  return value;
}

function resultErrorMessage(event: CursorEvent): string {
  for (const key of ["result", "error", "message"] as const) {
    const value = event[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (isRecord(value) && typeof value.message === "string" && value.message.trim()) return value.message.trim();
  }
  return "Cursor CLI reported an error";
}

function modelsFor(families: readonly Family[]): CursorModelDefinition[] {
  return [...families]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((family) => {
      const reasoning = familySupportsReasoning(family);
      return {
        id: family.id,
        name: `${family.name} (Cursor)`,
        reasoning,
        ...(reasoning ? { thinkingLevelMap: levelsFor(family) } : {}),
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: family.contextWindow,
        maxTokens: family.maxTokens,
      };
    });
}

function streamCursorCli(
  families: ReadonlyMap<string, Family>,
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  let started = false;
  let finished = false;
  let textIndex = -1;
  let thinkingIndex = -1;

  const closeText = () => {
    if (textIndex < 0) return;
    const block = output.content[textIndex] as TextContent;
    stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
    textIndex = -1;
  };
  const closeThinking = () => {
    if (thinkingIndex < 0) return;
    const block = output.content[thinkingIndex] as ThinkingContent;
    stream.push({
      type: "thinking_end",
      contentIndex: thinkingIndex,
      content: block.thinking,
      partial: output,
    });
    thinkingIndex = -1;
  };
  const pushText = (delta: string) => {
    if (!delta) return;
    closeThinking();
    if (textIndex < 0) {
      output.content.push({ type: "text", text: "" });
      textIndex = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
    }
    const block = output.content[textIndex] as TextContent;
    block.text += delta;
    stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
  };
  const pushThinking = (delta: string) => {
    if (!delta) return;
    closeText();
    if (thinkingIndex < 0) {
      output.content.push({ type: "thinking", thinking: "" });
      thinkingIndex = output.content.length - 1;
      stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
    }
    const block = output.content[thinkingIndex] as ThinkingContent;
    block.thinking += delta;
    stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta, partial: output });
  };
  const finish = (reason: Extract<StopReason, "stop" | "error" | "aborted">, errorMessage?: string) => {
    if (finished) return;
    finished = true;
    if (started) {
      closeThinking();
      closeText();
    }
    output.stopReason = reason;
    if (reason !== "stop") output.errorMessage = errorMessage || (reason === "aborted" ? "Request aborted" : "Cursor CLI failed");
    if (reason === "stop") stream.push({ type: "done", reason, message: output });
    else stream.push({ type: "error", reason, error: output });
    stream.end();
  };

  void (async () => {
    let child: ReturnType<typeof spawn> | undefined;
    let completion: Promise<ChildOutcome> | undefined;
    let abortListener: (() => void) | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let stderr = "";
    let sawResult = false;
    let providerError: string | undefined;

    try {
      if (options?.signal?.aborted) throw abortError("Request aborted before cursor-agent started");

      const env: StringEnv = { ...process.env, ...(options?.env ?? {}) };
      if (options?.apiKey && options.apiKey !== LEGACY_AUTH_SENTINEL) env.CURSOR_API_KEY = options.apiKey;
      const agentPath = env.CURSOR_AGENT_PATH || DEFAULT_AGENT_PATH;
      const family = families.get(model.id);
      const level = options?.reasoning as ModelThinkingLevel | undefined;
      const cliModel = family ? resolveVariant(family, level) : model.id;
      const initialPayload: CursorPayload = {
        argv: [
          "--print",
          ...(env.CURSOR_PI_NO_FORCE === "1" ? [] : ["--force"]),
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--model",
          cliModel,
        ],
        prompt: serializeTranscript(context.messages, getCurrentSystemPrompt(context.messages)),
      };
      const replacement = await options?.onPayload?.(initialPayload, model);
      const payload = usablePayload(replacement) ? replacement : initialPayload;

      if (options?.signal?.aborted) throw abortError("Request aborted before cursor-agent started");
      child = spawn(agentPath, payload.argv, { stdio: ["pipe", "pipe", "pipe"], env });
      completion = childOutcome(child);
      completion.then(() => { if (killTimer) clearTimeout(killTimer); });

      abortListener = () => { if (child) killTimer ??= terminate(child); };
      options?.signal?.addEventListener("abort", abortListener, { once: true });
      if (options?.signal?.aborted) abortListener();

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });

      await waitForSpawn(child);
      await options?.onResponse?.({ status: 0, headers: { "x-pi-transport": "subprocess" } }, model);
      await writePrompt(child, payload.prompt);
      if (options?.signal?.aborted) throw abortError("Request aborted");

      started = true;
      stream.push({ type: "start", partial: output });

      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          throw new Error("cursor-agent emitted malformed stream-json");
        }
        if (!isRecord(parsed) || typeof parsed.type !== "string") {
          throw new Error("cursor-agent emitted an invalid stream-json event");
        }
        const event = parsed as CursorEvent;
        await options?.onProviderStreamEvent?.(event, model);
        if (options?.signal?.aborted) break;

        if (event.type === "thinking") {
          if (event.subtype === "delta") {
            if (typeof event.text !== "string") throw new Error("Cursor thinking delta is missing text");
            pushThinking(event.text);
          } else if (event.subtype === "completed") {
            closeThinking();
          }
          continue;
        }

        if (event.type === "assistant") {
          if (!isRecord(event.message) || !Array.isArray(event.message.content)) {
            throw new Error("Cursor assistant event has invalid content");
          }
          for (const block of event.message.content) {
            if (!isRecord(block) || block.type !== "text") continue;
            if (typeof block.text !== "string") throw new Error("Cursor assistant text block is invalid");
            pushText(block.text);
          }
          continue;
        }

        // Cursor tool events describe work managed by the child. They stay
        // observable through onProviderStreamEvent but are not Pi tool calls.
        if (event.type === "tool_call") continue;

        if (event.type === "result") {
          if (sawResult) throw new Error("cursor-agent emitted more than one result event");
          sawResult = true;
          if (isRecord(event.usage)) {
            const usage = event.usage;
            output.usage.input = numberField(usage, ["inputTokens", "input_tokens"], true);
            output.usage.output = numberField(usage, ["outputTokens", "output_tokens"], true);
            output.usage.cacheRead = numberField(
              usage,
              ["cacheReadTokens", "cachedInputTokens", "cache_read_tokens"],
              false,
            );
            output.usage.cacheWrite = numberField(usage, ["cacheWriteTokens", "cache_write_tokens"], false);
            const reasoningKeys = ["reasoningTokens", "reasoning_tokens"] as const;
            if (reasoningKeys.some((key) => usage[key] !== undefined)) {
              output.usage.reasoning = numberField(usage, reasoningKeys, true);
            }
            output.usage.totalTokens = output.usage.input
              + output.usage.output
              + output.usage.cacheRead
              + output.usage.cacheWrite;
          } else if (event.is_error !== true) {
            throw new Error("Cursor result is missing usage");
          }
          if (event.is_error === true) providerError = resultErrorMessage(event);
        }
      }

      const outcome = await completion;
      if (options?.signal?.aborted) {
        finish("aborted", "Request aborted");
      } else if (providerError) {
        finish("error", providerError);
      } else if (outcome.error) {
        finish("error", outcome.error.message);
      } else if (outcome.signal) {
        finish("error", `cursor-agent terminated by ${outcome.signal}`);
      } else if (outcome.code !== 0) {
        finish("error", stderr.trim() || `cursor-agent exited with code ${outcome.code}`);
      } else if (!sawResult) {
        finish("error", stderr.trim() || "cursor-agent exited without a result event");
      } else {
        finish("stop");
      }
    } catch (error) {
      if (child) killTimer ??= terminate(child);
      const aborted = options?.signal?.aborted || (error instanceof Error && error.name === "AbortError");
      finish(aborted ? "aborted" : "error", aborted ? "Request aborted" : messageOf(error));
    } finally {
      if (abortListener) options?.signal?.removeEventListener("abort", abortListener);
    }
  })();

  return stream;
}

export default function cursorProvider(pi: ExtensionAPI): void {
  let families = new Map<string, Family>();
  let models: CursorModelDefinition[] = [];

  pi.registerProvider(PROVIDER_ID, {
    name: "Cursor subscription via cursor-agent",
    baseUrl: BASE_URL,
    apiKey: LEGACY_AUTH_SENTINEL,
    api: API_ID,
    models,
    refreshModels: async (context) => {
      const env: StringEnv = { ...process.env };
      const credentialKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
      if (credentialKey && credentialKey !== LEGACY_AUTH_SENTINEL) env.CURSOR_API_KEY = credentialKey;
      const agentPath = env.CURSOR_AGENT_PATH || DEFAULT_AGENT_PATH;
      const raw = await discoverModels(agentPath, env, context.signal);
      if (context.signal.aborted) throw abortError("Cursor model discovery aborted");
      const discovered = buildFamilies(raw);
      const nextFamilies = new Map(discovered.map((family) => [family.id, family]));
      const nextModels = modelsFor(discovered);
      families = nextFamilies;
      models = nextModels;
      return nextModels;
    },
    streamSimple: (model, context, options) => streamCursorCli(families, model, context, options),
  });
}
