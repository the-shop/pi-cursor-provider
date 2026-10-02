import * as module from "node:module";
import { isMainThread } from "node:worker_threads";

const SHIM_URL = "pi-ai-test:shim";

export function resolve(specifier, context, nextResolve) {
  if (specifier === "@earendil-works/pi-ai") {
    return { url: SHIM_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url !== SHIM_URL) return nextLoad(url, context);
  return {
    format: "module",
    shortCircuit: true,
    source: String.raw`
class Queue {
  values = [];
  waiters = [];
  done = false;

  push(value) {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end() {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.values.length > 0) yield this.values.shift();
      else if (this.done) return;
      else {
        const result = await new Promise((resolve) => this.waiters.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }
}

class AssistantMessageEventStream extends Queue {
  push(event) {
    super.push(event);
    if (event?.type === "done" || event?.type === "error") this.done = true;
  }
}

export function createAssistantMessageEventStream() {
  return new AssistantMessageEventStream();
}

function textOf(content) {
  return typeof content === "string"
    ? content
    : content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
}

export function getCurrentSystemPrompt(messages) {
  let base = "";
  const sections = new Map();
  for (const message of messages) {
    if (message?.role !== "system") continue;
    const text = textOf(message.content);
    if (text) base = base ? base + "\n\n" + text : text;
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [base, ...sections.values()].filter(Boolean).join("\n\n");
}
`,
  };
}

if (isMainThread) {
  if (typeof module.registerHooks === "function") module.registerHooks({ resolve, load });
  else module.register(import.meta.url);
}
