// PI/OpenAI: Pi UI and lifecycle for the extracted You should know observer.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, getAgentDir, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { backoff, defaultIntervalTurns, discussionDraft, explanationPrompt, lineKey, newState, observerContext, observerPrompt, promptSha256, readSettings, requestObservation, requestText, resolveObserverModel, type ObserverSettings, type ObserverState } from "./observer.ts";

interface Check {
  model: string;
  outcome: string;
  latencyMs: number;
  usage?: Usage;
  error?: string;
}
const command = "you-should-know";
const entryType = "pi-ysk";

export default function youShouldKnow(pi: ExtensionAPI) {
  const topicFile = join(getAgentDir(), "pi-ysk-topics.json");
  const configFile = join(getAgentDir(), "pi-ysk.json");
  let state = newState();
  let last: Check | undefined;
  let inspection: { context: Context; response?: string } | undefined;
  let active: AbortController | undefined;
  let generation = 0;
  let offeredThisRun = false;
  let inputOff: (() => void) | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let userSubmissions = 0;
  let dialogs = 0;

  function refreshSettings() { Object.assign(state, readSettings(configFile)); }
  function configuredModel(ctx: ExtensionContext) {
    refreshSettings();
    return resolveObserverModel(ctx, state.model);
  }
  function saveSettings(update: Partial<ObserverSettings>) {
    const settings = { ...readSettings(configFile), ...update };
    const temporary = `${configFile}.${process.pid}.tmp`;
    const json = { ...(settings.enabled ? {} : { enabled: false }), ...(settings.model === null ? {} : { model: settings.model }), ...(settings.intervalTurns === defaultIntervalTurns ? {} : { intervalTurns: settings.intervalTurns }) };
    writeFileSync(temporary, JSON.stringify(json, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, configFile);
    Object.assign(state, settings);
  }
  function topics() {
    let text: string;
    try { text = readFileSync(topicFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const memory = JSON.parse(text) as Pick<ObserverState, "seen" | "known" | "ignored" | "skip">;
    Object.assign(state, memory);
  }
  function saveTopics() {
    const temporary = `${topicFile}.${process.pid}.tmp`;
    const { seen, known, ignored, skip } = state;
    writeFileSync(temporary, JSON.stringify({ seen, known, ignored, skip }) + "\n", { mode: 0o600 });
    renameSync(temporary, topicFile);
  }
  function remember(kind: "seen" | "known", line: string) {
    topics();
    if (kind === "seen" || !state.known.some(item => item.toLowerCase() === line.toLowerCase())) state[kind] = [...state[kind], line].slice(-50);
    saveTopics();
  }
  function engaged() { topics(); state.ignored = 0; state.skip = 0; saveTopics(); }
  function cancel() {
    generation++; active?.abort(); active = undefined;
    if (state.note) state.note.explaining = false;
  }
  function save() { pi.appendEntry(entryType, { state: structuredClone(state), last }); }
  function render(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(entryType, state.enabled ? `YSK ${active ? "checking" : state.model ?? "session model"}` : undefined);
    const note = state.note;
    ctx.ui.setWidget(entryType, note ? (_tui, theme) => {
      const view = new Container();
      if (note.feedbackUntil !== undefined) {
        view.addChild(new Text("Dismissed.", 0, 0));
        view.addChild(new Text(note.expanded ? "1: That was helpful   2: Didn't understand   0: Dismiss" : "1: That was helpful   2: Not relevant   3: Couldn't understand   4: Turn off suggestions   0: Dismiss", 0, 0));
      } else {
        view.addChild(new Text(`${theme.fg("accent", `✦ ${note.tag} ·`)} ${note.line}`, 0, 0));
        if (note.explaining) view.addChild(new Text("Explaining…", 0, 0));
        else if (note.expanded) view.addChild(new Markdown(note.explanation, 0, 0, getMarkdownTheme()));
        view.addChild(new Text(note.expanded ? "1: Understood   2: Chat in main session   0: Dismiss" : "1: Learn more   2: Knew this already   0: Dismiss   3: What is this?", 0, 0));
      }
      return view;
    } : undefined);
  }
  function clearFeedbackTimer() { clearTimeout(feedbackTimer); feedbackTimer = undefined; }
  function expireFeedback(ctx: ExtensionContext) {
    clearFeedbackTimer();
    if (state.note?.feedbackUntil === undefined) return;
    feedbackTimer = setTimeout(() => { state.note = null; save(); render(ctx); }, Math.max(0, state.note.feedbackUntil - Date.now()));
    feedbackTimer.unref();
  }
  async function answer(ctx: ExtensionContext, action: "more" | "known" | "dismiss" | "discuss" | "clear") {
    const note = state.note;
    if (!note || note.explaining) return;
    if (action === "discuss" && ctx.ui.getEditorText().trim()) { ctx.ui.notify("Send or clear your draft first.", "warning"); return; }
    if (action !== "dismiss" || note.feedbackUntil === undefined) engaged();
    if (action === "more") {
      if (!note.explanation) {
        const epoch = generation;
        const controller = new AbortController();
        active = controller; note.explaining = true; render(ctx);
        const started = Date.now();
        try {
          const model = configuredModel(ctx);
          const context = observerContext(snapshot(ctx), explanationPrompt(note.line));
          inspection = { context };
          const result = await requestText(ctx, model, context, controller.signal, forkOptions(ctx, model));
          if (epoch !== generation || state.note !== note) return;
          note.explanation = result.text;
          inspection.response = result.text;
          last = { model: `${model.provider}/${model.id}`, outcome: "explained", usage: result.usage, latencyMs: Date.now() - started };
        } catch (error) {
          if (!controller.signal.aborted) ctx.ui.notify(`You should know: ${error instanceof Error ? error.message : error}`, "error");
        } finally {
          if (epoch === generation) { note.explaining = false; active = undefined; }
        }
        if (epoch !== generation) return;
      }
      if (state.note !== note || !note.explanation) { render(ctx); return; }
      note.expanded = true; userSubmissions = 0;
    } else if (action === "dismiss" && note.feedbackUntil === undefined) {
      note.feedbackUntil = Date.now() + 20_000; expireFeedback(ctx);
    } else {
      if (action === "discuss") ctx.ui.setEditorText(discussionDraft(note) + "\n\n");
      if (action === "known" || action === "discuss") remember("known", note.line);
      clearFeedbackTimer(); state.note = null;
    }
    save(); render(ctx);
  }
  function forkOptions(ctx: ExtensionContext, model: Model<any>) {
    const reasoning = pi.getThinkingLevel();
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      reasoning: reasoning !== "off" && model.provider === ctx.model?.provider && model.id === ctx.model.id ? reasoning : undefined,
    };
  }
  function snapshot(ctx: ExtensionContext): Message[] {
    return convertToLlm(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages);
  }
  async function check(ctx: ExtensionContext, messages: Message[], manual = false) {
    if (active) {
      if (manual) ctx.ui.notify("You should know is already checking.", "info");
      return;
    }
    if (state.note) {
      if (manual) ctx.ui.notify("A note is already displayed. Use /you-should-know more or dismiss.", "info");
      return;
    }
    try { refreshSettings(); }
    catch (error) { ctx.ui.notify(`You should know: ${String(error)}`, "error"); return; }
    if (!manual && (!state.enabled || offeredThisRun)) return;
    topics();
    if (!manual && state.skip > 0) { state.skip--; saveTopics(); save(); return; }
    const epoch = generation;
    const controller = new AbortController();
    active = controller;
    const started = Date.now();
    const record: Check = { model: state.model ?? "session", outcome: "error", latencyMs: 0 };
    try {
      const model = configuredModel(ctx);
      record.model = `${model.provider}/${model.id}`;
      if (manual) ctx.ui.notify(`Checking with ${record.model}…`, "info");
      topics();
      const context = observerContext(messages, observerPrompt(state.seen, state.known));
      inspection = { context };
      render(ctx);
      const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal]) : controller.signal;
      const result = await requestObservation(ctx, model, context, signal, forkOptions(ctx, model));
      if (epoch !== generation || signal.aborted) return;
      inspection.response = result.text;
      record.usage = result.usage;
      record.outcome = "none";
      if (result.note) {
        if ([...state.seen, ...state.known].some(line => lineKey(line) === lineKey(result.note!.line))) record.outcome = "duplicate";
        else {
          remember("seen", result.note.line);
          state.note = result.note; userSubmissions = 0;
          offeredThisRun = true;
          record.outcome = "shown";
        }
      }
      if (manual) ctx.ui.notify(record.outcome === "none"
        ? "Checked: nothing worth flagging."
        : record.outcome === "duplicate"
          ? "Checked: that topic was already shown or understood."
          : "Checked: a note is ready above the input.", "info");
    } catch (error) {
      if (epoch !== generation || controller.signal.aborted || ctx.signal?.aborted) return;
      record.error = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`You should know: ${record.error}`, "error");
    } finally {
      if (epoch === generation) {
        record.latencyMs = Date.now() - started;
        last = record;
        active = undefined;
        save(); render(ctx);
      }
    }
  }
  function restore(ctx: ExtensionContext) {
    cancel(); clearFeedbackTimer(); inputOff?.();
    state = newState(); last = undefined; inspection = undefined; offeredThisRun = false; userSubmissions = 0; dialogs = 0;
    const stored = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === entryType);
    if (stored?.type === "custom") {
      const data = stored.data as { state: ObserverState; last?: Check };
      state = structuredClone(data.state); last = data.last;
    }
    if (state.note) state.note.explaining = false;
    refreshSettings();
    topics(); expireFeedback(ctx); render(ctx);
    if (ctx.mode === "tui") inputOff = ctx.ui.onTerminalInput(data => {
      const note = state.note;
      if (!note || dialogs || ctx.ui.getEditorText() !== "" || !/^[0-4]$/.test(data)) return;
      if (note.feedbackUntil === undefined && data === "3" && !note.expanded) {
        ctx.ui.notify("A side agent watches this conversation for things you may have missed. It has no tools. Use /you-should-know off to disable it.", "info");
      } else if (note.feedbackUntil !== undefined && data === "4" && !note.expanded) {
        cancel(); clearFeedbackTimer(); saveSettings({ enabled: false }); state.note = null; save(); render(ctx);
      } else {
        const action = note.feedbackUntil !== undefined
          ? data === "1" ? "known" : data === "0" ? "dismiss" : data === "2" || data === "3" && !note.expanded ? "clear" : undefined
          : data === "0" ? "dismiss" : data === "1" ? note.expanded ? "known" : "more" : data === "2" ? note.expanded ? "discuss" : "known" : undefined;
        if (!action) return;
        void answer(ctx, action).catch(error => ctx.ui.notify(String(error), "error"));
      }
      return { consume: true };
    });
  }
  pi.on("session_start", async (_event, ctx) => {
    const { model } = readSettings(configFile);
    if (model) await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [model.slice(0, model.indexOf("/"))] });
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", (_event, ctx) => { cancel(); render(ctx); });
  pi.on("model_select", (_event, ctx) => { cancel(); render(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { cancel(); clearFeedbackTimer(); inputOff?.(); inputOff = undefined; ctx.ui.setWidget(entryType, undefined); ctx.ui.setStatus(entryType, undefined); });
  pi.on("ui_prompt_start", () => { dialogs++; });
  pi.on("ui_prompt_end", () => { dialogs = Math.max(0, dialogs - 1); });
  pi.on("input", event => { if (event.source !== "extension") userSubmissions++; });
  pi.on("before_agent_start", (_event, ctx) => {
    cancel(); offeredThisRun = false; refreshSettings(); topics();
    if (state.note?.feedbackUntil !== undefined) { clearFeedbackTimer(); state.note = null; }
    if (state.note && !state.note.expanded) {
      state.note.promptsSurvived += userSubmissions;
      if (state.note.promptsSurvived >= 2) { state.note = null; state.skip = backoff(++state.ignored); saveTopics(); }
    }
    userSubmissions = 0;
    save(); render(ctx);
  });
  pi.on("turn_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    refreshSettings();
    if (event.turnIndex > 0 && event.turnIndex % state.intervalTurns === 0) void check(ctx, snapshot(ctx));
  });
  pi.registerCommand(command, {
    description: "You should know: on, off, check, model [provider/id|session], more, knew, dismiss, discuss, status, inspect",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("You should know requires interactive Pi.", "error"); return; }
      const [action = "status", ...rest] = args.trim().split(/\s+/);
      switch (action || "status") {
        case "on":
          configuredModel(ctx); saveSettings({ enabled: true }); save(); render(ctx);
          ctx.ui.notify("You should know is on. Checks use your model allowance.", "info"); break;
        case "off":
          cancel(); clearFeedbackTimer(); saveSettings({ enabled: false }); state.note = null; save(); render(ctx); break;
        case "check":
          configuredModel(ctx); saveSettings({ enabled: true }); save(); render(ctx);
          void check(ctx, snapshot(ctx), true); break;
        case "model": {
          if (!rest.length) { refreshSettings(); ctx.ui.notify(state.model ?? "Same model as this session", "info"); break; }
          const value = rest.join(" ");
          const selected = value === "session" ? null : value;
          const model = resolveObserverModel(ctx, selected);
          cancel(); saveSettings({ model: selected }); save(); render(ctx);
          ctx.ui.notify(`You should know model: ${model.provider}/${model.id}`, "info"); break;
        }
        case "more": await answer(ctx, "more"); break;
        case "knew": await answer(ctx, "known"); break;
        case "dismiss": await answer(ctx, "dismiss"); break;
        case "discuss": await answer(ctx, "discuss"); break;
        case "inspect":
          await ctx.ui.editor("Last observer request and response (not sent to the main agent)", JSON.stringify({ promptSha256, ...inspection, last }, null, 2)); break;
        case "status":
          refreshSettings();
          ctx.ui.notify(JSON.stringify({ enabled: state.enabled, model: state.model ?? "session", intervalTurns: state.intervalTurns, checking: !!active, last }, null, 2), "info"); break;
        default: ctx.ui.notify(`Use /${command} on|off|check|model [provider/id|session]|more|knew|dismiss|discuss|status|inspect`, "info");
      }
    },
  });
}
