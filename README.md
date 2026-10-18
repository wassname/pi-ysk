# pi-ysk

Claude Code's **You should know** observer for Pi, using the [original 2.1.292 prompt](prompts/claude-code-2.1.292.md).

It checks the conversation while the main agent works. If it finds something consequential you may have missed, it shows a short note above the editor. It has no tools and leaves the main conversation unchanged.


<img width="2195" height="96" alt="image" src="https://github.com/user-attachments/assets/cb5f35a8-d715-4e4c-98fd-154474f0c408" />

<img width="2189" height="335" alt="image" src="https://github.com/user-attachments/assets/3e01e0c5-ae2a-4d94-ab8c-efd3e6beaac1" />
<img width="2200" height="459" alt="image" src="https://github.com/user-attachments/assets/da3557a9-b4da-4b38-83d1-c71dc73bb82b" />

## Try it

```sh
pi install npm:pi-ysk
```

Reload Pi. Watching is on by default. To check immediately:

```text
/you-should-know check
```

Manual checks report progress and completion, including “nothing worth flagging.” Automatic checks stay quiet unless they have a note or an error.

Automatic checks start at main-loop step indices 6, 12, …, as in the dumped plugin. Settings are in `~/.pi/agent/pi-ysk.json`. Suggested low-cost model, if configured in Pi:

```json
{
  "enabled": true,
  "model": "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017"
}
```

This uses DeepInfra directly. The model and credentials must exist in Pi; see [compatible-endpoint configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#configure-a-compatible-endpoint).

Omit `model` to use the current session model. Omit `enabled` to default to on; set it to `false` to stop automatic checks. Settings apply across sessions and are reread before requests, so JSON edits need no reload. These commands write the same file:

```text
/you-should-know model provider/model-id
/you-should-know model session
```

The selected provider receives the conversation and full prompt. Requests consume model usage. `/you-should-know check` enables watching and checks immediately; `/you-should-know off` stops automatic checks.

Notes use the theme's accent colour for the star and label. With an empty input:

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

There are two maintained functional regression tests. `smoke` makes a real provider request using synthetic evidence and the configured observer model (or session default if unset), or a `provider/model-id` argument. Temporary development checks are separate from the default suite.

Pi's SDK/UI packages are optional peers, supplied by the Pi host rather than bundled. Tested against Pi 1.1.0. This repository does not grant a new license to Anthropic's extracted prompt.

<!-- Implementation and README: PI/OpenAI, at wassname's request. -->
