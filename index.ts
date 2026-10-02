/**
 * cursor-provider — Pi custom provider that routes turns through the Cursor
 * Agent CLI (`cursor-agent -p --output-format stream-json`), so every model in
 * the Cursor subscription is selectable via `/model cursor/<family>`.
 *
 * pi-ai 1.0 migration (2026-10-02): the stream receives a normalized transcript;
 * the prompt lives in `context.messages` system messages, so it is read with
 * `getCurrentSystemPrompt(context.messages)`. Never reintroduce `context.systemPrompt`
 * (it is `undefined` on TranscriptContext and silently drops the whole agent prompt).
 *
 * Vendored + reworked from @netandreus/pi-cursor-provider 0.1.4 (MIT):
 *   - binary defaults to `cursor-agent` (bare `agent` on this machine is Grok's CLI)
 *   - ANSI-safe `cursor-agent models` parsing
 *   - model catalogue is parsed into families; effort/thinking variants are
 *     picked from Pi's thinking level (`/thinking low|medium|high|xhigh|max`)
 *   - thinking deltas → Pi thinking blocks, result usage → Pi usage
 *   - `--force` by default so tool calls actually run (CURSOR_PI_NO_FORCE=1 to disable)
 *
 * Env: CURSOR_AGENT_PATH (binary), CURSOR_API_KEY (optional; login otherwise),
 *      CURSOR_PI_NO_FORCE=1 (respect Cursor allowlist instead of --force).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ImageContent,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Catalogue → families
// ---------------------------------------------------------------------------

interface RawModel { id: string; name: string }

type Effort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface Family {
  id: string;                 // pi model id, e.g. claude-opus-5-thinking-fast
  name: string;
  variants: Map<Effort, string>; // effort → cursor id
  variantNames: Map<string, string>;
  thinking: boolean;
  contextWindow: number;
  maxTokens: number;
}

function parseCursorId(id: string): { family: string; effort: Effort; thinking: boolean } {
  const parts = id.split("-");
  let fast = false;
  let thinking = false;
  let effort: Effort = "default";
  if (parts.at(-1) === "fast") { fast = true; parts.pop(); }
  if (parts.at(-1) === "thinking") { thinking = true; parts.pop(); }
  if (parts.length >= 3 && parts.at(-1) === "high" && parts.at(-2) === "extra") {
    effort = "xhigh"; parts.pop(); parts.pop();
  } else if (parts.length > 1 && EFFORTS.has(parts.at(-1)!)) {
    effort = parts.pop() as Effort;
  }
  if (parts.at(-1) === "thinking") { thinking = true; parts.pop(); }
  const family = parts.join("-") + (thinking ? "-thinking" : "") + (fast ? "-fast" : "");
  return { family, effort, thinking };
}

const NAME_PREF: Effort[] = ["default", "high", "medium", "low", "xhigh", "max", "minimal", "none"];

function cleanName(name: string): string {
  return name
    .replace(/\((?:current|default|current,\s*default)\)/g, "")
    .replace(/\b(Extra High|None|Minimal|Low|Medium|High|Max)\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildFamilies(raw: RawModel[]): Family[] {
  const byFamily = new Map<string, Family>();
  for (const m of raw) {
    const { family, effort, thinking } = parseCursorId(m.id);
    let f = byFamily.get(family);
    if (!f) {
      f = { id: family, name: "", variants: new Map(), variantNames: new Map(), thinking, contextWindow: 200_000, maxTokens: 32_768 };
      byFamily.set(family, f);
    }
    if (!f.variants.has(effort)) f.variants.set(effort, m.id);
    f.variantNames.set(m.id, m.name);
  }
  for (const f of byFamily.values()) {
    const nameSrc = NAME_PREF.map((e) => f.variants.get(e)).find(Boolean) ?? [...f.variants.values()][0]!;
    f.name = cleanName(f.variantNames.get(nameSrc) ?? nameSrc);
    const allNames = [...f.variantNames.values()].join(" ");
    if (/\b1M\b/.test(allNames) || /gemini/i.test(f.id)) f.contextWindow = 1_000_000;
    if (/gemini/i.test(f.id)) f.maxTokens = 65_536;
  }
  return [...byFamily.values()];
}

/** Which cursor variant to run for a Pi thinking level. */
const LEVEL_PREF: Record<string, Effort[]> = {
  off:     ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
  minimal: ["minimal", "none", "low", "default", "medium", "high", "xhigh", "max"],
  low:     ["low", "minimal", "default", "medium", "none", "high", "xhigh", "max"],
  medium:  ["medium", "default", "high", "low", "minimal", "xhigh", "max", "none"],
  high:    ["high", "default", "medium", "xhigh", "max", "low", "minimal", "none"],
  xhigh:   ["xhigh", "max", "high", "default", "medium", "low", "minimal", "none"],
  max:     ["max", "xhigh", "high", "default", "medium", "low", "minimal", "none"],
};

function resolveVariant(f: Family, level: string | undefined): string {
  if (level && f.variantNames.has(level)) return level; // already a cursor id
  const prefs = LEVEL_PREF[level ?? "off"] ?? LEVEL_PREF.off;
  for (const e of prefs) {
    const v = f.variants.get(e);
    if (v) return v;
  }
  return [...f.variants.values()][0] ?? f.id;
}

const FAMILIES = new Map<string, Family>();

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const DISCOVERY_TIMEOUT_MS = 20_000;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function parseModelsOutput(output: string): RawModel[] {
  const out: RawModel[] = [];
  const lineRe = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+?)\s*$/;
  for (const line of output.replace(ANSI_RE, "").split("\n")) {
    const t = line.trim();
    if (!t || /^(Available|Tip:)/.test(t)) continue;
    const m = lineRe.exec(t);
    if (!m) continue;
    out.push({ id: m[1], name: m[2].replace(/\s*\((?:current|default|current,\s*default)\)\s*$/, "").trim() });
  }
  return out;
}

function runModels(agentPath: string): Promise<RawModel[]> {
  return new Promise((resolve, reject) => {
    const args = ["--list-models"];
    if (process.env["CURSOR_API_KEY"]) args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
    let stdout = "";
    let stderr = "";
    const child = spawn(agentPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("cursor-agent --list-models timed out")); }, DISCOVERY_TIMEOUT_MS);
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`cursor-agent --list-models exit ${code}: ${stderr.trim()}`));
      const models = parseModelsOutput(stdout);
      if (!models.length) return reject(new Error("cursor-agent --list-models returned no models"));
      resolve(models);
    });
  });
}

/** Fallback when discovery fails (not logged in, binary missing). Snapshot 2026-09-04. */
const STATIC_MODELS: RawModel[] = [
  { id: "auto", name: "Auto" },
  { id: "composer-2.5", name: "Composer 2.5" },
  { id: "claude-sonnet-5-thinking-high", name: "Claude Sonnet 5 1M Thinking" },
  { id: "claude-sonnet-5-thinking-xhigh", name: "Claude Sonnet 5 1M Extra High Thinking" },
  { id: "claude-opus-5-thinking-high", name: "Claude Opus 5 1M Thinking" },
  { id: "claude-opus-5-thinking-xhigh", name: "Claude Opus 5 1M Extra High Thinking" },
  { id: "claude-fable-5-1-thinking-high", name: "Claude Fable 5.1 1M Thinking (NO ZDR)" },
  { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol 1M High" },
  { id: "gpt-5.6-sol-xhigh", name: "GPT-5.6 Sol 1M Extra High" },
  { id: "gpt-5.3-codex-high", name: "Codex 5.3 High" },
  { id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash" },
];

// ---------------------------------------------------------------------------
// Prompt serialisation (stateless: whole Pi transcript each turn)
// ---------------------------------------------------------------------------

function blockToText(block: TextContent | ImageContent): string {
  if (block.type === "text") return block.text;
  const bytes = Math.round((block.data.length * 3) / 4);
  return `[Image: ${block.mimeType}, ~${bytes} bytes — image input is not supported by the Cursor Agent CLI]`;
}

function serializeContext(context: TranscriptContext): string {
  const lines: string[] = [];
  // Providers now receive a normalized transcript: the system prompt (and tool
  // declarations) live in the leading transcript system messages, not on the
  // context object. Replay every system message into the one prompt block.
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  if (systemPrompt) lines.push(`[System]\n${systemPrompt}\n`);
  for (const msg of context.messages) {
    if (msg.role === "system") continue; // already replayed above
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : msg.content.map(blockToText).join("\n");
      lines.push(`[User]\n${text}`);
    } else if (msg.role === "assistant") {
      const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
      if (text.trim()) lines.push(`[Assistant]\n${text}`);
    } else if (msg.role === "toolResult") {
      const text = msg.content.map(blockToText).join("\n");
      if (text.trim()) lines.push(`[Tool result: ${msg.toolName}]\n${text}`);
    }
  }
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// stream-json events
// ---------------------------------------------------------------------------

interface ToolPayload {
  args?: Record<string, unknown>;
  result?: { success?: unknown; rejected?: { reason?: string }; error?: { message?: string } };
}

const TOOL_NAMES: Record<string, string> = {
  shellToolCall: "shell", readToolCall: "read", editToolCall: "edit", writeToolCall: "write",
  deleteToolCall: "delete", grepToolCall: "grep", globToolCall: "glob", lsToolCall: "ls",
  todoToolCall: "todo", updateTodosToolCall: "todos", findToolCall: "find",
  webFetchToolCall: "web_fetch", webSearchToolCall: "web_search", getMcpToolsToolCall: "mcp_tools",
};
const toolName = (k: string) => TOOL_NAMES[k] ?? k.replace(/ToolCall$/, "");

function toolBrief(payload: ToolPayload): string {
  const a = { ...(payload.args ?? {}) } as Record<string, unknown>;
  delete a["toolCallId"]; delete a["simpleCommands"]; delete a["hasInputRedirect"]; delete a["hasOutputRedirect"];
  const s = JSON.stringify(a);
  return s.length > 140 ? s.slice(0, 140) + "…" : s;
}

function streamCursorCli(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const startTime = Date.now();
    let firstTokenTime: number | undefined;
    const output: AssistantMessage & { duration?: number; ttft?: number } = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    };
    const setTiming = () => {
      output.duration = Date.now() - startTime;
      output.ttft = firstTokenTime != null ? firstTokenTime - startTime : undefined;
    };

    try {
      const agentPath = process.env["CURSOR_AGENT_PATH"] ?? "cursor-agent";
      const family = FAMILIES.get(model.id);
      const level = (options as { reasoning?: string } | undefined)?.reasoning;
      const cliModel = family ? resolveVariant(family, level) : model.id;

      const args = ["--print", "--output-format", "stream-json", "--model", cliModel, "--trust", "--workspace", process.cwd()];
      if (!process.env["CURSOR_PI_NO_FORCE"]) args.push("--force");
      if (process.env["CURSOR_API_KEY"]) args.unshift("--api-key", process.env["CURSOR_API_KEY"]);
      // Prompt goes over stdin: argv would hit ARG_MAX (1 MiB on macOS) on long sessions.
      const prompt = serializeContext(context);

      stream.push({ type: "start", partial: output });

      const dbg = process.env["CURSOR_PI_DEBUG"];
      const log = (s: string) => { if (dbg) { try { appendFileSync(dbg, `${new Date().toISOString()} ${s}\n`); } catch {} } };
      log(`spawn ${agentPath} ${JSON.stringify(args)} promptChars=${prompt.length}`);

      const child = spawn(agentPath, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      child.stdin?.on("error", (e) => log(`stdin error ${e.message}`));
      child.stdin?.end(prompt);
      const onAbort = () => child.kill("SIGTERM");
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const stderrChunks: string[] = [];
      child.stderr?.on("data", (c: Buffer) => { stderrChunks.push(c.toString()); log(`stderr ${c.toString().slice(0, 500)}`); });

      let textIdx = -1;      // open text block index or -1
      let thinkIdx = -1;     // open thinking block index or -1
      let sawText = false;
      let sawEvent = false;

      const closeText = () => {
        if (textIdx < 0) return;
        const b = output.content[textIdx] as TextContent;
        stream.push({ type: "text_end", contentIndex: textIdx, content: b.text, partial: output });
        textIdx = -1;
      };
      const closeThinking = () => {
        if (thinkIdx < 0) return;
        const b = output.content[thinkIdx] as ThinkingContent;
        stream.push({ type: "thinking_end", contentIndex: thinkIdx, content: b.thinking, partial: output });
        thinkIdx = -1;
      };
      const pushText = (delta: string) => {
        if (!delta) return;
        closeThinking();
        if (textIdx < 0) {
          output.content.push({ type: "text", text: "" });
          textIdx = output.content.length - 1;
          stream.push({ type: "text_start", contentIndex: textIdx, partial: output });
        }
        const b = output.content[textIdx] as TextContent;
        b.text += delta;
        stream.push({ type: "text_delta", contentIndex: textIdx, delta, partial: output });
      };
      const pushThinking = (delta: string) => {
        if (!delta) return;
        closeText();
        if (thinkIdx < 0) {
          output.content.push({ type: "thinking", thinking: "" });
          thinkIdx = output.content.length - 1;
          stream.push({ type: "thinking_start", contentIndex: thinkIdx, partial: output });
        }
        const b = output.content[thinkIdx] as ThinkingContent;
        b.thinking += delta;
        stream.push({ type: "thinking_delta", contentIndex: thinkIdx, delta, partial: output });
      };

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on("line", (line: string) => {
        log(`line ${line.slice(0, 300)}`);
        let ev: any;
        try { ev = JSON.parse(line.trim()); } catch { return; }
        if (!ev || typeof ev !== "object") return;
        sawEvent = true;

        if (ev.type === "thinking") {
          if (firstTokenTime === undefined) firstTokenTime = Date.now();
          if (ev.subtype === "delta" && typeof ev.text === "string") pushThinking(ev.text);
          else if (ev.subtype === "completed") closeThinking();
          return;
        }
        if (ev.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block?.type !== "text" || !block.text) continue;
            if (firstTokenTime === undefined) firstTokenTime = Date.now();
            if (sawText && textIdx < 0) pushText("\n");
            pushText(block.text);
            sawText = true;
          }
          return;
        }
        // Tool calls run inside Cursor; render as inline markers only, never as
        // Pi toolcall events (Pi would try to execute them itself).
        if (ev.type === "tool_call") {
          const key = Object.keys(ev.tool_call ?? {})[0];
          if (!key) return;
          const payload = (ev.tool_call[key] ?? {}) as ToolPayload;
          const name = toolName(key);
          if (ev.subtype === "started") {
            pushText(`\n⏳ ${name} ${toolBrief(payload)}\n`);
          } else if (ev.subtype === "completed") {
            const r = payload.result ?? {};
            const status = r.rejected ? `✗ ${name} rejected${r.rejected.reason ? `: ${r.rejected.reason}` : ""}`
              : r.error ? `✗ ${name} error: ${r.error.message ?? ""}` : `✓ ${name}`;
            pushText(`${status}\n`);
          }
          return;
        }
        if (ev.type === "result") {
          const u = ev.usage ?? {};
          output.usage.input = Number(u.inputTokens ?? u.input_tokens ?? 0);
          output.usage.output = Number(u.outputTokens ?? u.output_tokens ?? 0);
          output.usage.cacheRead = Number(u.cacheReadTokens ?? u.cachedInputTokens ?? u.cache_read_tokens ?? 0);
          output.usage.cacheWrite = Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? 0);
          output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          if (ev.is_error && !sawText) {
            output.stopReason = "error";
            output.errorMessage = typeof ev.result === "string" ? ev.result : "Cursor CLI reported an error";
          }
        }
      });

      await new Promise<void>((resolve) => {
        child.on("close", (code, signal) => {
          log(`close code=${code} signal=${signal} sawText=${sawText}`);
          options?.signal?.removeEventListener("abort", onAbort);
          closeThinking();
          closeText();
          setTiming();
          if (options?.signal?.aborted) {
            output.stopReason = "aborted";
            stream.push({ type: "error", reason: "aborted", error: output });
          } else if (output.stopReason === "error" || (code !== 0 && !sawText) || !sawEvent) {
            output.stopReason = "error";
            output.errorMessage ??= stderrChunks.join("").trim() || (sawEvent ? `Cursor CLI exited with code ${code}` : `Cursor CLI exited ${code} without emitting any stream-json events (self-update in progress? run \`cursor-agent status\`)`);
            stream.push({ type: "error", reason: "error", error: output });
          } else {
            stream.push({ type: "done", reason: "stop", message: output });
          }
          stream.end();
          resolve();
        });
        child.on("error", (err) => {
          options?.signal?.removeEventListener("abort", onAbort);
          output.stopReason = "error";
          output.errorMessage = err.message;
          setTiming();
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          resolve();
        });
      });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      setTiming();
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// ---------------------------------------------------------------------------
// Helpers for slash commands
// ---------------------------------------------------------------------------

function runCapture(agentPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(agentPath, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr?.on("data", (c: Buffer) => { out += c.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(out.replace(ANSI_RE, "").trim()));
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const agentPath = process.env["CURSOR_AGENT_PATH"] ?? "cursor-agent";

  let raw: RawModel[];
  let discovered = true;
  try { raw = await runModels(agentPath); } catch { raw = STATIC_MODELS; discovered = false; }

  FAMILIES.clear();
  for (const f of buildFamilies(raw)) FAMILIES.set(f.id, f);

  const levelsFor = (f: Family) => {
    const has = (e: Effort) => f.variants.has(e);
    const multi = f.variants.size > 1;
    return {
      off: null as string | null,
      minimal: multi && (has("minimal") || has("none")) ? resolveVariant(f, "minimal") : null,
      low: multi ? resolveVariant(f, "low") : null,
      medium: multi ? resolveVariant(f, "medium") : null,
      high: multi ? resolveVariant(f, "high") : null,
      xhigh: multi && (has("xhigh") || has("max")) ? resolveVariant(f, "xhigh") : null,
      max: multi && has("max") ? resolveVariant(f, "max") : null,
    };
  };

  pi.registerProvider("cursor", {
    name: `Cursor subscription via cursor-agent${discovered ? "" : " (static fallback list)"}`,
    baseUrl: "cli://cursor-agent",
    apiKey: "CURSOR_API_KEY",
    api: "cursor-cli" as Api,
    models: [...FAMILIES.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => {
        const reasoning = f.thinking || f.variants.size > 1;
        return {
          id: f.id,
          name: `${f.name} (Cursor)`,
          reasoning,
          input: ["text"] as ("text" | "image")[],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: f.contextWindow,
          maxTokens: f.maxTokens,
          ...(reasoning && f.variants.size > 1 ? { thinkingLevelMap: levelsFor(f) } : {}),
        };
      }),
    streamSimple: streamCursorCli,
  });

  pi.registerCommand("cursor-status", {
    description: "Cursor auth status + discovered model families",
    handler: async (_args, ctx) => {
      const status = await runCapture(agentPath, ["status"]).catch((e) => `error: ${e.message}`);
      ctx.ui.notify(`${status}\n${FAMILIES.size} families (${discovered ? "live" : "static"}) via ${agentPath}`, "info");
    },
  });

  pi.registerCommand("cursor-variants", {
    description: "Show effort variants for a cursor model family: /cursor-variants <family>",
    handler: async (args, ctx) => {
      const f = FAMILIES.get((args ?? "").trim());
      if (!f) { ctx.ui.notify(`Unknown family. Known: ${[...FAMILIES.keys()].join(", ")}`, "error"); return; }
      const lines = [...f.variants.entries()].map(([e, id]) => `${e.padEnd(8)} → ${id}`);
      ctx.ui.notify(`${f.id}: ${f.name}\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("cursor-login", {
    description: "Log in to Cursor (runs `cursor-agent login`)",
    handler: async (_args, ctx) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(agentPath, ["login"], { stdio: "inherit", env: process.env });
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`login exited ${code}`))));
        });
        ctx.ui.notify("Cursor login successful. Restart pi to refresh the model list.", "info");
      } catch (err) {
        ctx.ui.notify(`Cursor login failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
