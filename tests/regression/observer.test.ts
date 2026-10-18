// PI/OpenAI: maintained functional regressions; development probes stay outside this suite.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import { buildSessionContext, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import youShouldKnow from "../../src/index.ts";
import { discussionDraft, observerContext, observerPrompt, originalPrompt, parseNote, promptSha256, type ObserverState } from "../../src/observer.ts";

const model = { provider: "test", id: "main" };
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "main", api: "test", usage, stopReason: "stop", timestamp: 1 });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const note = "learn: The benchmark includes training examples.\ntag: Heads up\nexplain:\n**The score includes training data**\nThis score does not measure held-out performance.";

test("the exact prompt and full transcript are copied without tool declarations or main-context edits", () => {
  assert.equal(promptSha256, "e94c68d688a9a4ca97b9de8e9bc0acfa7f6db2c00c719dd294a4aae11f9520ce");
  assert.equal(observerPrompt([], []), originalPrompt);
  const dynamic = observerPrompt(["Price is $&."], ["A known topic."]);
  assert(dynamic.includes("\n- Price is $&.\n"));
  assert(dynamic.includes("\n- A known topic.\n"));
  assert.equal(parseNote('- learn: "A decision was left unexplained."')?.tag, "You should know");
  assert.equal(parseNote("learn: none (nothing consequential)"), null);
  const draft = discussionDraft({ line: "Check @person", tag: "Heads up", explanation: "ultrathink [Image #1]", promptsSurvived: 0, expanded: true });
  assert(draft.includes("> Heads up · Check ＠person"));
  assert(draft.includes("> ultra-think ［Image #1]"));
  const messages: Message[] = [
    { role: "system", content: "Main instructions", toolsAdded: [{ name: "read", description: "Read files", parameters: {} }], timestamp: 1 },
    { role: "user", content: "Check this result.", timestamp: 2 },
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }], provider: "test", model: "main", api: "test", usage, stopReason: "toolUse", timestamp: 3 },
    { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "Training and evaluation rows overlap." }], isError: false, timestamp: 4 },
  ];
  const before = structuredClone(messages);
  const copy = observerContext(messages, originalPrompt);
  assert.deepEqual(messages, before);
  assert.deepEqual(copy.tools, []);
  assert.equal(copy.messages.length, messages.length + 1);
  assert(copy.messages.filter(message => message.role === "system").every(message => !message.toolsAdded?.length));
  assert.deepEqual(copy.messages.at(-2), messages.at(-1));
});

test("the extension checks asynchronously, remembers notes, supports model choice, and rejects stale results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ysk-regression-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const manager = SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "Check this benchmark.", timestamp: 1 });
    const mainBefore = buildSessionContext(manager.getEntries()).messages;
    const events = new Map<string, (event: any, ctx: any) => unknown>();
    let command!: (args: string, ctx: any) => Promise<void>;
    const requests: { model: any; context: Context; options: any; resolve: (value: AssistantMessage) => void }[] = [];
    let editor = "";
    const notifications: string[] = [];
    const api = {
      on(name: string, handler: any) { events.set(name, handler); },
      registerCommand(name: string, config: any) { assert.equal(name, "you-should-know"); command = config.handler; },
      appendEntry(kind: string, data: unknown) { manager.appendCustomEntry(kind, data); },
      sendMessage() { throw new Error("Observer must not inject messages"); },
      sendUserMessage() { throw new Error("Observer must not start the main agent"); },
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "tui", hasUI: true, sessionManager: manager, model,
      ui: {
        notify(text: string) { notifications.push(text); }, setStatus() {}, setWidget() {},
        onTerminalInput() { return () => {}; },
        getEditorText() { return editor; }, setEditorText(text: string) { editor = text; },
      },
      modelRegistry: {
        find(provider: string, id: string) { return { ...model, provider, id }; }, hasConfiguredAuth() { return true; },
        streamSimple(selected: unknown, context: Context, options: unknown) {
          const result = new Promise<AssistantMessage>(resolve => requests.push({ model: selected, context, options, resolve }));
          return { result: () => result };
        },
      },
    } as unknown as ExtensionContext;
    const emit = (name: string, event: any = {}) => events.get(name)!(event, ctx);
    const stored = () => (manager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "pi-ysk") as any).data as { state: ObserverState; last: { outcome: string } };
    youShouldKnow(api);
    emit("session_start");
    const step = (index: number) => emit("turn_start", { turnIndex: index });
    step(6); assert.equal(requests.length, 0);
    await command("on", ctx);
    step(5); assert.equal(requests.length, 0);
    assert.equal(step(6), undefined); assert.equal(requests.length, 1);
    step(12); assert.equal(requests.length, 1);
    assert.equal(requests[0].model, model);
    assert.equal(requests[0].options.toolChoice, "none");
    emit("input", { source: "interactive" });
    requests[0].resolve(response(note)); await flush();
    assert.equal(stored().last.outcome, "shown");
    emit("input", { source: "interactive" }); emit("before_agent_start");
    assert.equal(stored().state.note!.promptsSurvived, 1);
    await command("more", ctx); assert.equal(requests.length, 1);
    await command("knew", ctx); assert.equal(stored().state.known.length, 1);
    await command("check", ctx);
    assert(notifications.some(text => text.startsWith("Checking with test/main")));
    await command("check", ctx); assert.equal(requests.length, 2);
    assert(notifications.includes("You should know is already checking."));
    requests[1].resolve(response(note)); await flush();
    assert.equal(stored().last.outcome, "duplicate");
    assert(notifications.includes("Checked: that topic was already shown or understood."));
    await command("model other/cheap", ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "pi-ysk.json"), "utf8")), { model: "other/cheap" });
    await command("check", ctx); assert.equal(requests[2].model.provider, "other");
    emit("before_agent_start"); assert.equal(requests[2].options.signal.aborted, true);
    requests[2].resolve(response(note.replace("benchmark", "measurement"))); await flush();
    assert.equal(stored().state.note, null);
    await command("check", ctx); requests[3].resolve(response(note.replace("benchmark", "measurement"))); await flush();
    await command("dismiss", ctx);
    assert(stored().state.note!.feedbackUntil! > Date.now() + 19_000);
    assert.equal(stored().state.note!.expanded, false);
    await command("dismiss", ctx); assert.equal(stored().state.note, null);
    await command("check", ctx); requests[4].resolve(response("learn: The new score has no held-out split.")); await flush();
    const expanding = command("more", ctx);
    assert.equal(stored().state.note!.explanation, "");
    await command("model other/new", ctx); emit("session_tree");
    assert.equal(stored().state.note!.explaining, false);
    requests[5].resolve(response("**Old-model explanation**\nDo not adopt this stale result.")); await expanding;
    assert.equal(stored().state.note!.explanation, "");
    await command("knew", ctx); assert.equal(stored().state.note, null);
    writeFileSync(join(dir, "pi-ysk.json"), JSON.stringify({ model: "configured/family" }));
    await command("check", ctx); assert.equal(requests[6].model.provider, "configured");
    requests[6].resolve(response("learn: none")); await flush();
    assert(notifications.includes("Checked: nothing worth flagging."));
    writeFileSync(join(dir, "pi-ysk.json"), "{}"); emit("session_tree");
    await command("check", ctx); assert.equal(requests[7].model, model);
    requests[7].resolve(response("learn: none")); await flush();
    await command("model session", ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "pi-ysk.json"), "utf8")), {});
    writeFileSync(join(dir, "pi-ysk.json"), '{"model":42}');
    await command("check", ctx); assert.equal(requests.length, 8);
    assert(notifications.some(text => text.includes("pi-ysk.json model must be")));
    assert.deepEqual(buildSessionContext(manager.getEntries()).messages, mainBefore);
    assert(!notifications.some(text => text.includes("Observer response")));
    emit("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
