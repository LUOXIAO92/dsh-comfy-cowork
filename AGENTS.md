# dsh-comfy-cowork

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
- **Never publish to npm without the user's explicit approval.** `npm publish` is public and
  irreversible; the package name is `dsh-comfy-cowork`, and end users install it by name from
  the DSH plugin dialog.
- `main` is the only branch; commits use `-c user.name='dsh' -c user.email='dsh@local'`.

## Shape of the code

- `index.js` + `lib/plugin.js` — Host half. Injects `tools`, `webServer`, `sessions`,
  `workingDirectory`, `systemPrompt`, `connection`, `agents`.
- `lib/routes.js` — `/api/comfy-cowork/*` HTTP routes (auth through `ctx.connection.admit`),
  the SSE stream, and the ComfyUI proxy.
- `lib/store.js` — per-session document store at `<workspace>/.comfy-cowork/<sessionId>/`
  (`document.json` + `assets/`). All mutations go through `store.mutate`. On first use it
  renames a pre-rename `.comfy-coworking/` directory in that workspace, so old canvases keep
  working; that legacy name is the only place the old spelling belongs.
- `lib/workflow.js` — infers canvas→workflow injection bindings from the ComfyUI JSON itself.
- `lib/moss.js` — MOSS-Image layout compilation (shared by host and browser).
- `lib/tools.js` — the agent-facing `comfy_coworking_*` tools.
- `src/client/` — browser half, bundled into `client.js` by `node scripts/build-client.mjs`:
  - `CanvasTab.jsx` — app shell: tool rail, canvas, inspector (size, mask, prompt, layout…).
  - `CanvasStage.jsx` — the artboard: zoom/pan, brush + eraser, vector mask shapes,
    layout boxes, inline caption editor.
  - `WorkflowView.jsx` — graph view + node parameter editor + run panel.
  - `styles.css`, `locales.js` (en/zh parity is enforced), `api.js`, `ui.jsx`.

## Activation (per session, never global)

- The plugin mounts dormant: no tool and no prompt section exists until one chat opens
  the canvas. Enabling is strictly per session — the host attaches `comfy_coworking_*`
  through that agent's `ctx.inject(['tools','systemPrompt'])`, so other chats never see them.
- The only way in is the `/dsh-comfy-cowork` slash-menu row (label `DSH Comfy协同` /
  `DSH Comfy cowork`). It is a client command contribution (`ctx.commandUi.register`), not a
  host command — that is the only way a menu row gets a localized label and an icon, and its
  whole effect (enable the session + open the tab) is client-side. There is no composer button.
- The agent's `comfy_coworking_open_canvas` tool bumps `doc.ui.openSeq`; the plugin follows the
  on-screen session's SSE stream and opens the tab when the sequence moves.
- Ways out: the appbar ✕ (and any tab close) run the tab type's close handler, which
  disables the session again; the tools leave that agent.
- The canvas tab has its own title (`Comfy 画布`); the *command* carries the plugin's name.
  Never call the plugin "canvas" in UI copy, and never add a composer button for it.
- `doc.enabled` is the durable switch; `GET /api/comfy-cowork/health` reports the live
  attach list as `scoped`.

## Commands

- `npm run build` — rebuild `client.js` (must run after every `src/client` change).
- `npm test` — node test runner (`tests/*.test.js`).
- `npm pack` — runs `prepack` (build + tests) and writes the tarball that users install; the
  tarball carries the prebuilt `client.js`, so installing needs no build. `npm publish` ships
  the same tarball and must only run with the user's approval.
- The npm tarball is the user-facing distribution: users enter the package name in the DSH
  plugin dialog and get the prebuilt bundle. `client.js` stays committed so `link:` and
  GitHub installs also work without a build.
- Verify the tarball install in a scratch profile:
  `DSH_HOME=/tmp/dsh-test <dsh> plugin --profile test add <tarball>` followed by
  `DSH_HOME=/tmp/dsh-test <dsh> --profile test --dump-config` (the bundle layer must appear).
- Harness: serve the repo root (`python3 -m http.server 8766`) and open
  `http://127.0.0.1:8766/tests/harness/index.html`; rebuild the harness bundle with
  `npx esbuild tests/harness/entry.jsx --bundle --format=iife --outfile=tests/harness/harness.js --loader:.jsx=jsx`.
  Query flags: `?view=workflow`, `?noimage=1`, `?smoke=1`, `?sizetest=1`, `?lang=en`, `?demo=mask|layout|comment|agent`, …
- README demos (`docs/media/*.gif`) are recorded from the harness with a CDP driver at a
  fixed 10 fps, then encoded with an ffmpeg palette. `?demo=` starts a clean enabled canvas
  per flow, so no session or workspace data can leak into a recording. Regenerate the GIFs
  whenever the canvas UI changes enough to make them misleading.
- Real-page verification: mint a browser cookie from `~/.dsh/.credentials.yaml`, drive
  headless Chrome over CDP, evaluate JS and screenshot. Host changes need the plugin toggled
  off→on (`plugin_manager set_plugin`, entry `include:comfy-cowork`); client changes need
  `npm run build` + a page refresh.
- **Never type into the composer of a live session as a test.** A stray Enter submits a real
  user message and starts a model turn. Prefer clicking the plugin's own controls, or assert on
  `doc.enabled` / `doc.ui.openSeq`; if a command must be exercised through the menu, use a
  throwaway session and confirm its draft is empty first.

## UI conventions

- Colours come from DSH alias tokens (`--dsw-alias-*`); the action accent is
  `--dsw-alias-state-business-primary`. Never hard-code chrome colours.
- The host theme rounds corners as squircles; force `corner-shape: round` for true circles.
- Text lives in `src/client/locales.js` — keep `en`, `zh`, and `ja` at identical key sets. The
  plugin registers Japanese with DSH's language catalog; any language it does not translate
  falls back to English.
- The workflow JSON is the single source of truth; never add plugin-private fields to nodes.

## Feature map (agent-relevant)

- Layout boxes are **MOSS-Image only**; other models ignore them and use the prompt box.
- Comments are annotation bboxes the user (or the agent) draws on the image to explain what is
  wrong and how it should look; they are stored as JSON both in the document and embedded in
  the exported PNG, and every comment records its `source` (`user` / `agent`).
