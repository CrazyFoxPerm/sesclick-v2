# <img src="./icon.svg" width="60" align="center" /> sesclick-v2

> Fork of [JodusNodus/opencode-chrome-annotation](https://github.com/JodusNodus/opencode-chrome-annotation), GPL-3.0-only, with credit to JodusNodus for the original. The side-panel UI, annotation queue, and chat-locking ideas were carried over from the `eagleeyejack` fork. Not built by the OpenCode team and not affiliated with them.

> **v2-only: Requires OpenCode >= 2.0.27 (V2 plugin API). For OpenCode v1 use the upstream repo: [JodusNodus/opencode-chrome-annotation](https://github.com/JodusNodus/opencode-chrome-annotation).**

Point at what's broken in your live app. Your agent fixes it.

This is the **sesclick-v2 plugin** half of the tool. Pair it with the Chrome extension: a side panel connects any tab to your OpenCode session, you click the broken element on the live page, write what should change, and the agent receives the cropped screenshot, the element's exact selector, and your instruction.

## Install

Add the plugin to your OpenCode config (V2 object form):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "sesclick-v2", "options": {} }]
}
```

For local development, place the plugin directory under `.opencode/plugins/` instead — it is auto-discovered.

Restart OpenCode. It runs a local server on `127.0.0.1` (ports `39240-39260`).

Then load the unpacked Chrome extension: build it with `bun run build:extension`, then open `chrome://extensions`, enable developer mode, and load the `extension/` directory. Chrome Web Store: not published yet.

## How It Works

1. Start OpenCode in your project.
2. Click the extension icon: the side panel opens and lists your OpenCode sessions, grouped by project.
3. Pick a session to link the current tab.
4. Click **Select element**, click anything on the page, write your instruction, and add it to the queue.
5. Queue as many annotations as you need, then hit **Send all to OpenCode**.
6. Your agent receives each annotation's cropped screenshot, exact selector, tag/role/ARIA metadata, and your instruction.

Sessions can be closed (deleted) straight from the panel, with a two-click confirm.

### What Gets Sent

- Your written instruction.
- The current page URL and title.
- The selected element's metadata: selector, tag, role, ARIA label, visible text, bounds.
- A cropped screenshot of the selected element.

Everything travels over `127.0.0.1` (ports `39240-39260`) to your own OpenCode instance. Nothing leaves your machine. OpenCode and your browser must be on the same localhost (not in separate containers).

## Troubleshooting

- Ask the agent to run the `sesclick_status` tool for diagnostics (`chrome_status` is a kept alias returning the same JSON).
- `GET /status` on the local server reports the same payload, including `api: "v2"`.
- Placeholder-session error ("linked to a placeholder session, not a real chat"): reconnect and pick a specific chat — annotations cannot go to a placeholder.
- Subagent-target rejection: annotations always go to the chat you picked; sub-agent sessions cannot hijack routing and are rejected.

## License

GPL-3.0-only - inherited from upstream, with credit to [JodusNodus](https://github.com/JodusNodus/opencode-chrome-annotation) for the original.
