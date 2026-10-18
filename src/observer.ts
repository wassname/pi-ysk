// PI/OpenAI: observer mechanics; the prompt is the unmodified Anthropic extraction.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const document = readFileSync(new URL("../prompts/claude-code-2.1.292.md", import.meta.url), "utf8");
assert(document.startsWith("<!-- Anthropic Claude Code 2.1.292;") && document.endsWith("\n"));
export const originalPrompt = document.slice(document.indexOf("\n\n") + 2, -1);
export const promptSha256 = createHash("sha256").update(originalPrompt).digest("hex");
const explanationDocument = readFileSync(new URL("../prompts/claude-code-2.1.292-explain.md", import.meta.url), "utf8");
const explanationTemplate = explanationDocument.slice(explanationDocument.indexOf("\n\n") + 2, -1);
export const explanationPrompt = (line: string) => explanationTemplate.replace("__PI_YSK_TOPIC__", () => line);
const seenMarker = "These are the last suggestions offered to the user. You should skip them:\n(nothing yet)";
const knownMarker = "The person said they already understood these topics, so make sure to avoid offering them:\n(nothing yet)";
assert(originalPrompt.includes(seenMarker) && originalPrompt.includes(knownMarker));

export interface Note {
  line: string;
  tag: "Heads up" | "You should know";
  explanation: string;
  promptsSurvived: number;
  expanded: boolean;
  feedbackUntil?: number;
  explaining?: boolean;
}
export interface ObserverState {
  enabled: boolean;
  model: string | null;
  seen: string[];
  known: string[];
  note: Note | null;
  ignored: number;
  skip: number;
}
export const newState = (): ObserverState => ({
  enabled: false, model: null, seen: [], known: [], note: null, ignored: 0, skip: 0,
});
export const lineKey = (text: string) => text.toLowerCase().trim().replace(/\.$/, "");
export const backoff = (ignored: number) => ignored <= 2 ? 0 : Math.min(16, 2 ** (ignored - 3));
export function observerPrompt(seen: string[], known: string[]): string {
  const listed = (items: string[]) => items.length ? items.map(line => `- ${line}`).join("\n") : "(nothing yet)";
  return originalPrompt
    .replace(seenMarker, () => seenMarker.replace("(nothing yet)", () => listed(seen)))
    .replace(knownMarker, () => knownMarker.replace("(nothing yet)", () => listed(known)));
}

const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]|\p{Cf}/gu, "");
export function parseNote(text: string): Note | null {
  const lines = clean(text).split("\n");
  const start = lines.findIndex(line => /^\s*(?:[-*•]\s+)?learn\s*:/i.test(line));
  if (start === -1) throw new Error("Observer response has no learn: line");
  const explain = lines.findIndex((line, index) => index > start && /^\s*explain:/i.test(line));
  const fields = (explain < 0 ? lines : lines.slice(0, explain)).map(line => line.trim().replace(/^[-*•]\s+/, ""));
  let line = fields[start].replace(/^learn\s*:\s*/i, "").trim();
  for (const next of fields.slice(start + 1)) {
    if (!next || /^(learn|tag)\s*:/i.test(next) || /\?["'”’]?$/.test(line)) break;
    line += ` ${next}`;
  }
  line = line.replace(/\.+$/, "");
  for (const [left, right] of [["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["`", "`"]]) {
    if (line.startsWith(left) && line.endsWith(right)) line = line.slice(1, -1).replace(/\.+$/, "");
  }
  if (!line || /^none\s*(?:[.!?()[\]:;,-]|$)/i.test(line)) return null;
  const inline = /[.\s—–-]*\s\**tag\**\s*:\s*\**\s*(heads[\s-]*up|you should know)\W*$/i.exec(line);
  if (inline) line = line.slice(0, inline.index).trim();
  if (!/[.!?…]["'”’)\]]*$/.test(line)) line += ".";
  if (line.length > 240) throw new Error("Observer learn: line exceeds 240 characters");
  const tag = fields.find(field => /^tag\s*:/i.test(field))?.replace(/^tag\s*:\s*/i, "") ?? inline?.[1] ?? "";
  const explanation = explain < 0 ? "" : [lines[explain].replace(/^\s*explain:\s*/i, ""), ...lines.slice(explain + 1)].join("\n").trim();
  return { line, tag: /^\W*heads[\s-]*up\W*$/i.test(tag) ? "Heads up" : "You should know", explanation, promptsSurvived: 0, expanded: false };
}

export function discussionDraft(note: Note): string {
  const body = `${note.tag} · ${note.line}\n\n${note.explanation}`.split("\n").map(line => line ? `> ${line}` : ">").join("\n");
  return clean(`Here is a note offered by a side agent:\n\n${body}`)
    .replace(/(^|\s)@(?!\s)/g, "$1＠")
    .replace(/\[(Pasted text|Image|\.\.\.Truncated text|✦ Team setup guide) #(\d+)/g, "［$1 #$2")
    .replace(/(ultra)(code|plan|review|think)/gi, "$1-$2");
}

export function observerContext(messages: Message[], prompt: string): Context {
  const copied = structuredClone(messages);
  for (const message of copied) {
    if (message.role === "system") {
      message.toolsAdded = [];
      message.toolsRemoved = [];
    }
  }
  copied.push({ role: "user", content: prompt, timestamp: Date.now() });
  return { messages: copied, tools: [] };
}

export function resolveObserverModel(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, override: string | null): Model<any> {
  let model = ctx.model;
  if (override !== null) {
    const slash = override.indexOf("/");
    if (slash <= 0) throw new Error("Use provider/model-id, or session");
    model = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
  }
  if (!model) throw new Error("Observer model is not available");
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No configured credentials for ${model.provider}/${model.id}`);
  return model;
}

export async function requestText(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  model: Model<any>,
  context: Context,
  signal: AbortSignal,
): Promise<{ text: string; usage: Usage; response: AssistantMessage }> {
  const response = await ctx.modelRegistry.streamSimple(model, context, {
    signal, maxTokens: 4096, maxRetries: 0, toolChoice: "none",
  }).result();
  if (signal.aborted || response.stopReason === "aborted") throw new Error("Observer check cancelled");
  if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `Observer stopped: ${response.stopReason}`);
  if (response.content.some(block => block.type === "toolCall")) throw new Error("Observer attempted to call a tool");
  const text = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  if (!text.trim()) throw new Error("Observer returned no text");
  return { text, usage: response.usage, response };
}

export async function requestObservation(...args: Parameters<typeof requestText>) {
  const result = await requestText(...args);
  return { ...result, note: parseNote(result.text) };
}
