# pi-ysk

Claude Code's **You should know** observer for Pi, using the [original 2.1.292 prompt](prompts/claude-code-2.1.292.md).

It checks the conversation while the main agent works. If it finds something consequential you may have missed, it shows a short note above the editor. It has no tools and leaves the main conversation unchanged.

## Try it

```sh
pi install /workspace/pi-ysk
```

Reload Pi, then:

```text
/you-should-know on
/you-should-know check
```

Automatic checks start at main-loop step indices 6, 12, …, as in the dumped plugin. They use the current session model unless you set a model in `~/.pi/agent/pi-ysk.json`:

```json
{
  "model": "provider/model-id"
}
```

Use `{}` or omit the file to use the current session model. The setting applies across sessions and is reread before each request, so JSON edits need no reload. These commands write the same file:

```text
/you-should-know model provider/model-id
/you-should-know model session
```

The selected provider receives the conversation and full prompt. Requests consume model usage. The extension starts off in a new session.

When a note appears, with an empty input:

- `1`: learn more; then `1` marks it understood.
- `2`: already understood; in the explanation, `2` puts the note in your input for discussion.
- `0`: dismiss, then show Claude's 20-second feedback row.

`/you-should-know off` stops checks. `status` shows the selected model and last check's usage, separately from Pi's main-agent totals; `inspect` shows the last request and response. `/ysk` remains available for the separately installed briefing extension.

## Source and development

The prompt comes from the [Claude Code research dump](https://github.com/wassname/cc-plugin-you-should-know). Only the seen/understood topic lists are substituted. If a note omits its explanation, Learn more uses the [original explanation prompt](prompts/claude-code-2.1.292-explain.md). Topic memory is shared across sessions in `~/.pi/agent/pi-ysk-topics.json`; session controls and notes are stored outside model context. Pi cannot guarantee the same cache reuse as Claude Code.

```sh
npm test
npm run check
npm run smoke
```

There are two maintained functional regression tests. `smoke` makes a real provider request using synthetic evidence and your configured default model, or a `provider/model-id` argument. Temporary development checks are separate from the default suite.

Pi's SDK/UI packages are optional peers, supplied by the Pi host rather than bundled. Tested against Pi 1.1.0. This repository does not grant a new license to Anthropic's extracted prompt.

<!-- Implementation and README: PI/OpenAI, at wassname's request. -->
