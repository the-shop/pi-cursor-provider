import type {
  ImageContent,
  Message,
  ModelThinkingLevel,
  TextContent,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";

export type Effort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RawModel {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface Family {
  id: string;
  name: string;
  variants: Map<Effort, string>;
  defaultVariant: string;
  thinking: boolean;
  contextWindow: number;
  maxTokens: number;
}

const EFFORTS = new Set<Effort>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SELECTION_MARKER_RE = /\s*\((current|default|current,\s*default)\)\s*$/i;

/** Parse a Cursor model id into the family exposed by Pi and its exact effort variant. */
export function parseCursorId(id: string): { family: string; effort: Effort; thinking: boolean } {
  const parts = id.split("-");
  let fast = false;
  let thinking = false;
  let effort: Effort = "default";

  if (parts.at(-1) === "fast") {
    fast = true;
    parts.pop();
  }
  if (parts.at(-1) === "thinking") {
    thinking = true;
    parts.pop();
  }
  if (parts.length >= 3 && parts.at(-2) === "extra" && parts.at(-1) === "high") {
    effort = "xhigh";
    parts.splice(-2);
  } else {
    const candidate = parts.at(-1) as Effort | undefined;
    if (parts.length > 1 && candidate && EFFORTS.has(candidate)) {
      effort = candidate;
      parts.pop();
    }
  }
  if (parts.at(-1) === "thinking") {
    thinking = true;
    parts.pop();
  }

  const base = parts.join("-") || id;
  return {
    family: `${base}${thinking ? "-thinking" : ""}${fast ? "-fast" : ""}`,
    effort,
    thinking,
  };
}

/** Parse the ANSI-decorated output of `cursor-agent --list-models`. */
export function parseModelsOutput(output: string): RawModel[] {
  const models: RawModel[] = [];
  const seen = new Set<string>();
  const linePattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+?)\s*$/;

  for (const line of output.replace(ANSI_RE, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(Available models|Tip:)/i.test(trimmed)) continue;
    const match = linePattern.exec(trimmed);
    if (!match || seen.has(match[1])) continue;

    const marker = SELECTION_MARKER_RE.exec(match[2]);
    const name = match[2].replace(SELECTION_MARKER_RE, "").trim();
    if (!name) continue;

    seen.add(match[1]);
    models.push({
      id: match[1],
      name,
      isDefault: marker?.[1].toLowerCase().includes("default") === true,
    });
  }

  return models;
}

/** Group exact Cursor ids into the smaller family catalog shown by Pi. */
export function buildFamilies(raw: readonly RawModel[]): Family[] {
  interface PendingFamily extends Family {
    names: Map<string, string>;
    explicitDefault?: string;
    plainDefault?: string;
  }

  const byFamily = new Map<string, PendingFamily>();
  for (const model of raw) {
    const parsed = parseCursorId(model.id);
    let family = byFamily.get(parsed.family);
    if (!family) {
      family = {
        id: parsed.family,
        name: model.name,
        variants: new Map(),
        defaultVariant: model.id,
        thinking: parsed.thinking,
        contextWindow: 128_000,
        maxTokens: 16_384,
        names: new Map(),
      };
      byFamily.set(parsed.family, family);
    }

    family.thinking ||= parsed.thinking;
    family.names.set(model.id, model.name);
    if (!family.variants.has(parsed.effort)) family.variants.set(parsed.effort, model.id);
    if (family.variants.get(parsed.effort) === model.id) {
      if (parsed.effort === "default") family.plainDefault ??= model.id;
      if (model.isDefault) family.explicitDefault = model.id;
    }
  }

  return [...byFamily.values()].map((family) => {
    const defaultVariant = family.explicitDefault ?? family.plainDefault ?? family.defaultVariant;
    const name = family.names.get(defaultVariant) ?? family.name;
    const names = [...family.names.values()].join(" ");
    const contextWindow = /\b1M\b/i.test(names) || /gemini/i.test(family.id) ? 1_000_000 : 128_000;
    return {
      id: family.id,
      name,
      variants: family.variants,
      defaultVariant,
      thinking: family.thinking,
      contextWindow,
      maxTokens: 16_384,
    };
  });
}

/** Map only exact variants advertised for a family; unsupported Pi levels are null. */
export function levelsFor(family: Family): ThinkingLevelMap {
  return {
    off: family.variants.get("none") ?? family.variants.get("default") ?? null,
    minimal: family.variants.get("minimal") ?? null,
    low: family.variants.get("low") ?? null,
    medium: family.variants.get("medium") ?? null,
    high: family.variants.get("high") ?? null,
    xhigh: family.variants.get("xhigh") ?? null,
    max: family.variants.get("max") ?? null,
  };
}

/** Select an exact requested variant, falling back only to the family's discovered default. */
export function resolveVariant(family: Family, level: ModelThinkingLevel | undefined): string {
  if (level === undefined) return family.defaultVariant;
  if (level === "off") {
    return family.variants.get("none") ?? family.variants.get("default") ?? family.defaultVariant;
  }
  return family.variants.get(level) ?? family.defaultVariant;
}

export function familySupportsReasoning(family: Family): boolean {
  return family.thinking || [...family.variants.keys()].some((effort) => !["default", "none"].includes(effort));
}

function blockToText(block: TextContent | ImageContent): string {
  if (block.type === "text") return block.text;
  const bytes = Math.round((block.data.length * 3) / 4);
  return `[Image: ${block.mimeType}, ~${bytes} bytes — omitted by the text-only Cursor provider]`;
}

function assistantContent(message: Extract<Message, { role: "assistant" }>): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      parts.push(`[Tool call: ${block.name}, id: ${block.id}]\n${JSON.stringify(block.arguments)}`);
    }
  }
  return parts.join("\n");
}

/** Serialize a normalized Pi transcript after the host resolves its current system prompt. */
export function serializeTranscript(messages: readonly Message[], systemPrompt: string): string {
  const blocks: string[] = [];
  if (systemPrompt) blocks.push(`[System]\n${systemPrompt}\n[/System]`);

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.map(blockToText).join("\n");
      blocks.push(`[User]\n${content}\n[/User]`);
    } else if (message.role === "assistant") {
      blocks.push(`[Assistant]\n${assistantContent(message)}\n[/Assistant]`);
    } else {
      const status = message.isError ? "error" : "ok";
      const content = message.content.map(blockToText).join("\n");
      blocks.push(
        `[Tool result: ${message.toolName}, id: ${message.toolCallId}, status: ${status}]\n${content}\n[/Tool result]`,
      );
    }
  }

  return blocks.join("\n\n");
}
