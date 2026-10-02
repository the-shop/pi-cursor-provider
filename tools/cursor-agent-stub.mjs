#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";

function writeJson(path, value) {
  if (path) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function unicodeLine(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const marker = Buffer.from("🌍");
  const index = bytes.indexOf(marker);
  if (index < 0) {
    process.stdout.write(bytes);
    return;
  }
  process.stdout.write(bytes.subarray(0, index + 1));
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stdout.write(bytes.subarray(index + 1));
}

if (process.argv.includes("--list-models")) {
  writeJson(process.env.CURSOR_PI_STUB_DISCOVERY_CAPTURE, {
    argv: process.argv.slice(2),
    apiKey: process.env.CURSOR_API_KEY ?? null,
  });
  if (process.env.CURSOR_PI_STUB_DISCOVERY_SCENARIO === "hang") {
    process.on("SIGTERM", () => {
      if (process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE) {
        appendFileSync(process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE, "discovery:SIGTERM\n");
      }
      process.exit(143);
    });
    setInterval(() => {}, 1_000);
  } else if (process.env.CURSOR_PI_STUB_DISCOVERY_SCENARIO === "oversized") {
    process.stdout.write("x".repeat(1_100_000));
  } else if (process.env.CURSOR_PI_STUB_DISCOVERY_SCENARIO === "error") {
    process.stderr.write("stub discovery failed\n");
    process.exitCode = 9;
  } else {
    process.stdout.write("\u001b[32mAvailable models\u001b[0m\n\n");
    process.stdout.write("\u001b[36mauto\u001b[0m - Auto (default)\n");
    process.stdout.write("composer-2.5 - Composer 2.5 (current)\n");
    process.stdout.write("claude-sonnet-5-thinking-high - Claude Sonnet 5 1M Thinking\n");
    process.stdout.write("claude-sonnet-5-thinking-xhigh - Claude Sonnet 5 1M Extra High Thinking\n");
    process.stdout.write("gpt-5.3-codex - Codex 5.3\n");
    process.stdout.write("gpt-5.3-codex-low - Codex 5.3 Low\n");
    process.stdout.write("gpt-5.3-codex-high - Codex 5.3 High\n");
    process.stdout.write("gemini-3.7-flash-high - Gemini 3.7 Flash\n");
    process.stdout.write("Tip: pass --model\n");
  }
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;

  writeJson(process.env.CURSOR_PI_STUB_CAPTURE, {
    argv: process.argv.slice(2),
    prompt,
    env: {
      apiKey: process.env.CURSOR_API_KEY ?? null,
      probe: process.env.CURSOR_PI_ENV_PROBE ?? null,
    },
  });

  const scenario = process.env.CURSOR_PI_STUB_SCENARIO ?? "happy";
  if (scenario === "hang") {
    process.on("SIGTERM", () => {
      if (process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE) {
        appendFileSync(process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE, "stream:SIGTERM\n");
      }
      process.exit(143);
    });
    setInterval(() => {}, 1_000);
  } else if (scenario === "empty") {
    line({ type: "result", usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  } else if (scenario === "snake-usage") {
    line({ type: "assistant", message: { content: [{ type: "text", text: "snake" }] } });
    line({ type: "result", usage: { input_tokens: 5, output_tokens: 4, cache_read_tokens: 3, cache_write_tokens: 2 } });
  } else if (scenario === "partial-error") {
    line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
    line({
      type: "result",
      is_error: true,
      result: "provider rejected request",
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  } else if (scenario === "nonzero") {
    line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
    line({ type: "result", usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    process.exitCode = 7;
  } else if (scenario === "malformed") {
    line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
    process.stdout.write("{not json}\n");
  } else if (scenario === "truncated") {
    process.stdout.write('{"type":"assistant"');
  } else if (scenario === "oversized-line") {
    line({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(1_100_000) }] } });
    line({ type: "result", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  } else if (scenario === "abort") {
    line({ type: "assistant", message: { content: [{ type: "text", text: "before abort" }] } });
    process.on("SIGTERM", () => {
      if (process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE) {
        appendFileSync(process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE, "stream:SIGTERM\n");
      }
      process.exit(143);
    });
    setInterval(() => {}, 1_000);
  } else {
    line({ type: "thinking", subtype: "delta", text: "ponder" });
    line({ type: "thinking", subtype: "completed" });
    await unicodeLine({ type: "assistant", message: { content: [{ type: "text", text: "hello 🌍" }] } });
    line({
      type: "tool_call",
      subtype: "started",
      tool_call: { shellToolCall: { args: { command: "internal-only" } } },
    });
    line({
      type: "tool_call",
      subtype: "completed",
      tool_call: { shellToolCall: { args: { command: "internal-only" }, result: { exitCode: 0 } } },
    });
    line({ type: "telemetry", value: 1 });
    line({
      type: "result",
      usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 1 },
    });
  }
}
