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
const timeout = setTimeout(() => controller.abort(), 60_000);
timeout.unref();

try {
  const definitions = await config.refreshModels({
    allowNetwork: true,
    signal: controller.signal,
    credential: undefined,
    publish: async () => true,
  });
  const definition = definitions.find((model: Record<string, unknown>) => model.id === "auto")
    ?? definitions.find((model: Record<string, unknown>) => model.id === "composer-2.5")
    ?? definitions[0];
  if (!definition) throw new Error("cursor-agent returned no selectable models");

  const model = { ...definition, api: config.api, provider: "cursor", baseUrl: config.baseUrl };
  const context = {
    messages: [
      { role: "system", content: "You are a test agent. Reply with a single word.", timestamp: 1 },
      { role: "user", content: "ping", timestamp: 2 },
    ],
  };
  const events: Array<Record<string, any>> = [];
  for await (const event of config.streamSimple(model, context, { signal: controller.signal })) {
    events.push(structuredClone(event));
  }

  const done = events.filter((event) => event.type === "done");
  const text = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.delta)
    .join("")
    .trim();
  if (text.length === 0) throw new Error("real Cursor smoke returned no text");
  if (done.length !== 1 || done[0].message?.stopReason !== "stop") {
    throw new Error(`real Cursor smoke did not stop successfully: ${JSON.stringify(events.at(-1))}`);
  }
  console.log(`e2e-real: passed (${definition.id}, ${text.length} text characters)`);
} catch (error) {
  console.error(`e2e-real: failed — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
