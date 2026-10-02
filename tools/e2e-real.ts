/**
 * Opt-in real Cursor test. It makes two model turns and consumes Cursor quota;
 * the second turn also authorizes one harmless approval-gated shell file write.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../index.ts";

if (process.env.CURSOR_PI_E2E_REAL !== "1") {
  console.log("e2e-real: skipped (set CURSOR_PI_E2E_REAL=1)");
  process.exit(0);
}

const providers = new Map<string, Record<string, any>>();
factory({ registerProvider: (name: string, config: Record<string, any>) => providers.set(name, config) } as never);
const config = providers.get("cursor");
if (!config) {
  console.error("e2e-real: cursor provider was not registered");
  process.exit(1);
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);
timeout.unref();
let probeRoot: string | undefined;

function successfulText(label: string, events: Array<Record<string, any>>): string {
  const terminals = events.filter((event) => event.type === "done" || event.type === "error");
  if (terminals.length !== 1 || terminals[0].type !== "done" || terminals[0].message?.stopReason !== "stop") {
    throw new Error(`${label} did not stop successfully: ${JSON.stringify(events.at(-1))}`);
  }
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("")
    .trim();
}

try {
  const definitions = await config.refreshModels({
    allowNetwork: true,
    signal: controller.signal,
    credential: undefined,
    publish: async () => true,
  });
  const definition = definitions.find((entry: Record<string, unknown>) => entry.id === "auto")
    ?? definitions.find((entry: Record<string, unknown>) => entry.id === "composer-2.5")
    ?? definitions[0];
  if (!definition) throw new Error("cursor-agent returned no selectable models");

  const model = { ...definition, api: config.api, provider: "cursor", baseUrl: config.baseUrl };
  const pingEvents: Array<Record<string, any>> = [];
  for await (const event of config.streamSimple(model, {
    messages: [
      { role: "system", content: "You are a test agent. Reply with a single word.", timestamp: 1 },
      { role: "user", content: "ping", timestamp: 2 },
    ],
  }, { signal: controller.signal })) {
    pingEvents.push(structuredClone(event));
  }
  const pingText = successfulText("real Cursor text smoke", pingEvents);
  if (pingText.length === 0) throw new Error("real Cursor text smoke returned no text");

  probeRoot = mkdtempSync(join(tmpdir(), "pi-cursor-provider-real-"));
  const probePath = join(probeRoot, "force-probe.txt");
  const command = `printf 'CURSOR_PI_FORCE_OK\\n' > '${probePath.replaceAll("'", "'\\''")}'`;
  const rawToolEvents: Array<Record<string, any>> = [];
  let generatedArgv: string[] = [];
  const toolEvents: Array<Record<string, any>> = [];
  for await (const event of config.streamSimple(model, {
    messages: [
      {
        role: "system",
        content: "You are a test agent. Follow the requested shell-tool steps exactly and report only after completion.",
        timestamp: 3,
      },
      {
        role: "user",
        content: `Use the shell tool exactly once to run this exact approval-gated command:\n${command}\nAfter it completes, reply with CURSOR_PI_FORCE_OK.`,
        timestamp: 4,
      },
    ],
  }, {
    signal: controller.signal,
    env: { CURSOR_PI_NO_FORCE: "0" },
    onPayload: (payload: { argv?: unknown }) => {
      if (Array.isArray(payload.argv)) generatedArgv = [...payload.argv] as string[];
    },
    onProviderStreamEvent: (event: Record<string, any>) => {
      if (event.type === "tool_call") rawToolEvents.push(structuredClone(event));
    },
  })) {
    toolEvents.push(structuredClone(event));
  }

  const toolText = successfulText("real Cursor force smoke", toolEvents);
  if (!generatedArgv.includes("--force")) throw new Error("real Cursor force smoke did not generate --force");
  const shellEvents = rawToolEvents.filter((event) => event.tool_call?.shellToolCall);
  const started = shellEvents.filter((event) => event.subtype === "started");
  const completed = shellEvents.filter((event) => event.subtype === "completed");
  if (started.length !== 1 || completed.length !== 1) {
    throw new Error(`real Cursor force smoke did not complete one shell action: ${JSON.stringify(rawToolEvents)}`);
  }
  if (!existsSync(probePath) || readFileSync(probePath, "utf8") !== "CURSOR_PI_FORCE_OK\n") {
    throw new Error("real Cursor force smoke shell action did not write the expected probe");
  }
  if (!toolText.includes("CURSOR_PI_FORCE_OK")) {
    throw new Error(`real Cursor force smoke returned unexpected text: ${JSON.stringify(toolText)}`);
  }

  console.log(`e2e-real: passed (${definition.id}, text + completed approval-gated shell action)`);
} catch (error) {
  console.error(`e2e-real: failed — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (probeRoot) rmSync(probeRoot, { recursive: true, force: true });
}
