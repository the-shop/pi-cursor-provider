import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../index.ts";

const FAILURES: string[] = [];
let checks = 0;
function check(label: string, condition: boolean, detail = ""): void {
  checks += 1;
  console.log(`  [${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) FAILURES.push(label);
}
function eq<T>(label: string, actual: T, expected: T): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  models: Array<Record<string, unknown>>;
  refreshModels: (context: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  streamSimple: (...args: unknown[]) => unknown;
}

const providers = new Map<string, ProviderConfig>();
const commands: string[] = [];
const mockApi = {
  registerProvider: (name: string, config: ProviderConfig) => {
    if (providers.has(name)) FAILURES.push(`duplicate provider ${name}`);
    providers.set(name, config);
  },
  registerCommand: (name: string) => commands.push(name),
};

const factoryResult = factory(mockApi as never);
const config = providers.get("cursor")!;

console.log("=== registration ===");
check("factory is synchronous", factoryResult === undefined);
check("provider cursor registered", Boolean(config));
eq("custom API id", config?.api, "cursor-cli");
eq("CLI base URL", config?.baseUrl, "cli://cursor-agent");
check("legacy auth sentinel is non-secret", config?.apiKey === "cursor-agent-login");
check("streamSimple registered", typeof config?.streamSimple === "function");
check("refreshModels registered", typeof config?.refreshModels === "function");
eq("initial catalog is live-only", config?.models, []);
eq("no slash commands registered", commands, []);

const root = mkdtempSync(join(tmpdir(), "pi cursor provider registration "));
try {
  const stubPath = join(root, "cursor agent stub.mjs");
  const discoveryCapture = join(root, "discovery.json");
  const signalCapture = join(root, "signal.txt");
  copyFileSync(new URL("./cursor-agent-stub.mjs", import.meta.url), stubPath);
  chmodSync(stubPath, 0o755);

  process.env.CURSOR_AGENT_PATH = stubPath;
  process.env.CURSOR_PI_STUB_DISCOVERY_CAPTURE = discoveryCapture;
  delete process.env.CURSOR_API_KEY;

  const controller = new AbortController();
  const refreshContext = {
    allowNetwork: false,
    signal: controller.signal,
    credential: undefined,
    publish: async () => true,
  };
  const models = await config.refreshModels(refreshContext as never);

  console.log("=== initial local catalog ===");
  check("cold refresh discovers models when network is disallowed", models.length >= 5, `${models.length}`);
  eq("family ids are unique", new Set(models.map((model) => model.id)).size, models.length);
  const claude = models.find((model) => model.id === "claude-sonnet-5-thinking")!;
  check("effort variants collapse into one family", Boolean(claude));
  eq("thinking family is marked as reasoning", claude.reasoning, true);
  eq("exact thinking map", claude.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "claude-sonnet-5-thinking-high",
    xhigh: "claude-sonnet-5-thinking-xhigh",
    max: null,
  });
  const auto = models.find((model) => model.id === "auto")!;
  eq("plain family is not marked as reasoning", auto.reasoning, false);
  check("plain family does not publish a thinking map", auto.thinkingLevelMap === undefined);
  check("all models are text-only", models.every((model) => JSON.stringify(model.input) === '["text"]'));
  check("all model names retain Cursor label", models.every((model) => String(model.name).endsWith(" (Cursor)")));
  check("all model costs are zero", models.every((model) => (model.cost as { input: number }).input === 0));
  eq("1M estimate survives registration", claude.contextWindow, 1_000_000);
  eq("single output estimate survives registration", claude.maxTokens, 16_384);
  const discovery = JSON.parse(readFileSync(discoveryCapture, "utf8")) as { argv: string[]; apiKey: string | null };
  eq("discovery argv is minimal", discovery.argv, ["--list-models"]);
  eq("ambient CLI login needs no key", discovery.apiKey, null);

  process.env.CURSOR_API_KEY = "test-key";
  await config.refreshModels(refreshContext as never);
  const keyedDiscovery = JSON.parse(readFileSync(discoveryCapture, "utf8")) as { argv: string[]; apiKey: string | null };
  eq("optional API key reaches discovery environment", keyedDiscovery.apiKey, "test-key");
  eq("optional API key stays out of discovery argv", keyedDiscovery.argv, ["--list-models"]);
  delete process.env.CURSOR_API_KEY;

  console.log("=== refresh failure and cancellation ===");
  process.env.CURSOR_AGENT_PATH = join(root, "missing cursor agent");
  let missingError = "";
  try {
    await config.refreshModels(refreshContext as never);
  } catch (error) {
    missingError = error instanceof Error ? error.message : String(error);
  }
  check("missing CLI is surfaced even when network is disallowed", /ENOENT|spawn/.test(missingError), missingError);

  process.env.CURSOR_AGENT_PATH = stubPath;
  process.env.CURSOR_PI_STUB_DISCOVERY_SCENARIO = "hang";
  process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE = signalCapture;
  const aborted = new AbortController();
  const pending = config.refreshModels({ ...refreshContext, signal: aborted.signal } as never);
  setTimeout(() => aborted.abort(), 30);
  let abortName = "";
  try {
    await pending;
  } catch (error) {
    abortName = error instanceof Error ? error.name : "";
  }
  eq("refresh cancellation is an AbortError", abortName, "AbortError");
} finally {
  delete process.env.CURSOR_AGENT_PATH;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_PI_STUB_DISCOVERY_CAPTURE;
  delete process.env.CURSOR_PI_STUB_DISCOVERY_SCENARIO;
  delete process.env.CURSOR_PI_STUB_SIGNAL_CAPTURE;
  rmSync(root, { recursive: true, force: true });
}

console.log("=== package surface ===");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, any>;
check("pi-package keyword", packageJson.keywords.includes("pi-package"));
eq("Pi manifest points to root extension", packageJson.pi, { extensions: ["./index.ts"] });
eq("Node strip-types minimum", packageJson.engines, { node: ">=22.6.0" });
check("no runtime dependencies", packageJson.dependencies === undefined);
eq("host peers only", Object.keys(packageJson.peerDependencies).sort(), [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]);
for (const script of ["test", "test:e2e", "test:e2e:real", "secret-scan"]) {
  check(`${script} script exists`, typeof packageJson.scripts[script] === "string");
}
check("no install step in tests", !JSON.stringify(packageJson.scripts).includes("npm install"));

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
check("default force flag is present", source.includes('"--force"'));
check("force opt-out is present", source.includes('env.CURSOR_PI_NO_FORCE === "1"'));
for (const removed of ["--yolo", "--trust", "--api-key", "CURSOR_PI_DEBUG", "STATIC_MODELS", "registerCommand("]) {
  check(`removed production surface: ${removed}`, !source.includes(removed));
}
check("source is strip-types compatible", !/constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/s.test(source));

console.log(`\n=== ${FAILURES.length === 0 ? `REGISTRATION PASSED (${checks} checks)` : `REGISTRATION FAILED (${FAILURES.length}/${checks})`} ===`);
for (const failure of FAILURES) console.log(`  - ${failure}`);
process.exit(FAILURES.length === 0 ? 0 : 1);
