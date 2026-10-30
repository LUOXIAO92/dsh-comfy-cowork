# dsh-comfy-coworking

A DSH (DeepSeek Harness) plugin that opens a right-sidebar image/layout canvas for ComfyUI:
mask painting, MOSS-Image layout boxes, workflow browsing/parameter editing, and a run/inject
pipeline that writes every prompt into the plugin prompt box.

## Ground rules

- **This project has effectively unlimited resources. Work boldly**: prefer the complete,
  correct implementation over the smallest possible diff. Refactor when the design wants it.
- **Subagents are welcome at any time.** Split independent work across subagents, and use a
  fork (`subagent_fork`) whenever the subagent needs this conversation's context.
- **Never add a git remote and never push.** Everything stays in local git until the user
  explicitly asks otherwise. Commit after each coherent batch.
- `main` is the only branch; commits use `-c user.name='dsh' -c user.email='dsh@local'`.

## Shape of the code

- `index.js` + `lib/plugin.js` — Host half. Injects `tools`, `webServer`, `sessions`,
  `workingDirectory`, `systemPrompt`, `connection`.
- `lib/routes.js` — `/api/comfy-coworking/*` HTTP routes (auth through `ctx.connection.admit`),
  the SSE stream, and the ComfyUI proxy.
- `lib/store.js` — per-session document store at `<workspace>/.comfy-coworking/<sessionId>/`
  (`document.json` + `assets/`). All mutations go through `store.mutate`.
- `lib/workflow.js` — infers canvas→workflow injection bindings from the ComfyUI JSON itself.
- `lib/moss.js` — MOSS-Image layout compilation (shared by host and browser).
- `lib/tools.js` — the agent-facing `comfy_coworking_*` tools.
- `src/client/` — browser half, bundled into `client.js` by `node scripts/build-client.mjs`:
  - `CanvasTab.jsx` — app shell: tool rail, canvas, inspector (size, mask, prompt, layout…).
  - `CanvasStage.jsx` — the artboard: zoom/pan, brush + eraser, vector mask shapes,
    layout boxes, inline caption editor.
  - `WorkflowView.jsx` — graph view + node parameter editor + run panel.
  - `styles.css`, `locales.js` (en/zh parity is enforced), `api.js`, `ui.jsx`.

## Commands

- `npm run build` — rebuild `client.js` (must run after every `src/client` change).
- `npm test` — node test runner (`tests/*.test.js`).
- Harness: serve the repo root (`python3 -m http.server 8766`) and open
  `http://127.0.0.1:8766/tests/harness/index.html`; rebuild the harness bundle with
  `npx esbuild tests/harness/entry.jsx --bundle --format=iife --outfile=tests/harness/harness.js --loader:.jsx=jsx`.
  Query flags: `?view=workflow`, `?noimage=1`, `?smoke=1`, `?sizetest=1`, …
- Real-page verification: mint a browser cookie from `~/.dsh/.credentials.yaml`, drive
  headless Chrome over CDP, evaluate JS and screenshot. Host changes need the plugin toggled
  off→on (`plugin_manager set_plugin`, entry `include:comfy-coworking`); client changes need
  `npm run build` + a page refresh.

## UI conventions

- Colours come from DSH alias tokens (`--dsw-alias-*`); the action accent is
  `--dsw-alias-state-business-primary`. Never hard-code chrome colours.
- The host theme rounds corners as squircles; force `corner-shape: round` for true circles.
- Text lives in `src/client/locales.js` — add both `en` and `zh` keys.
- The workflow JSON is the single source of truth; never add plugin-private fields to nodes.

## Feature map (agent-relevant)

- Layout boxes are **MOSS-Image only**; other models ignore them and use the prompt box.
- Comments are annotation bboxes the user (or the agent) draws on the image to explain what is
  wrong and how it should look; they are stored as JSON both in the document and embedded in
  the exported PNG, and every comment records its `source` (`user` / `agent`).
