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
- `main` is the only branch.

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
- `lib/png.js` — host-side PNG reader for the mask assets: decodes one non-interlaced 8-bit
  file and returns the painted region's bbox, so `state` can describe the mask without the
  browser and without shipping an image library.
- `lib/model-catalog.js` — the workspace model snapshot: `/models` plus one
  `/models/<folder>` per folder, written to `<workspace>/.comfy-cowork/models.json`. Only files
  with a model extension are kept, and a folder that holds none is dropped. `custom_nodes`,
  `configs`, `datasets` and `vae_approx` are skipped by name: a node package can ship weights,
  and a preview folder can mirror every model. File strings stay exactly as ComfyUI reports
  them (folder-relative, no prefix), because that is what a loader widget takes. There is no
  TTL: a written snapshot is reused until it is missing, the ComfyUI address changed, or the
  `refresh` feature (or the canvas Refresh directories button) rebuilds it; a failed refresh
  keeps the last snapshot.
- `lib/node-catalog.js` — the node directory at `<workspace>/.comfy-cowork/nodes.json` (version
  2): ComfyUI's category tree, nested by the path it ships (`KJNodes/masking`,
  `🆎 AusBoss/Video`, …), each branch `{ count, nodes: [{ type, display, description }],
  children }`. It stores no input schemas: `node_info` reads one class live from
  `/object_info/<class>` (a 404 falls back to the full dump) and pages each dropdown at 100
  values (`option_offset`). No TTL — reused until missing, rebuilt by `refresh`, or after the
  address changes; a failed refresh keeps the previous tree.
- `lib/workflow-index.js` — one list over three sources: ComfyUI `userdata/workflows`
  (`comfyui:<userdata path>`), the comfy project convention (`fragments/*.json`,
  `blueprints/*.compiled.json`, absolute workspace paths), and this plugin's own saves
  (`<workspace>/.comfy-cowork/workflows/*.json`). Written to
  `<workspace>/.comfy-cowork/workflows/index.json` with explicit paths. Saving defaults to the
  workspace; `target: 'comfyui'` writes back to userdata.
- `lib/tools.js` — the one agent tool, `comfy_cowork`: `discover` (groups, or search names and
  aliases), `describe` (input schemas), `execute` (run one feature). Features are stored in a
  table filed under canvas, workflow, runs, catalog, and misc; `discover` lists their flat ids
  (`state`, `set_prompt`, `list_models`, `node_info`, `refresh`, `run`, `run_status`, …) and
  `describe` returns their schemas, so the request's tool list stays one fixed schema.
  Registered in-process through `scope.tools.register` — progressive disclosure, not an MCP
  server.
- `src/client/` — browser half, bundled into `client.js` by `node scripts/build-client.mjs`:
  - `CanvasTab.jsx` — app shell: tool rail, canvas, inspector (size, mask, prompt, layout…).
  - `CanvasStage.jsx` — the artboard: zoom/pan, brush + eraser, vector mask shapes,
    layout boxes, inline caption editor.
  - `WorkflowView.jsx` — graph view + node parameter editor + run panel.
  - `styles.css`, `locales.js` (en/zh/ja key-set parity), `api.js`, `ui.jsx`.

## Activation (per session, never global)

- The plugin mounts dormant: no tool and no prompt section exists until one chat opens
  the canvas. Enabling is strictly per session — the host attaches `comfy_cowork`
  through that agent's `ctx.inject(['tools','systemPrompt'])`, so other chats never see it.
- The only way in is the `/dsh-comfy-cowork` slash-menu row (label `DSH Comfy协同` /
  `DSH Comfy cowork`). It is a client command contribution (`ctx.commandUi.register`), not a
  host command — that is the only way a menu row gets a localized label and an icon, and its
  whole effect (enable the session + open the tab) is client-side. There is no composer button.
- The `open_canvas` feature (run through `comfy_cowork`) bumps `doc.ui.openSeq`; the plugin
  follows the on-screen session's SSE stream and opens the tab when the sequence moves.
- Ways out, and why there are two. Closing the canvas (appbar ✕ or any tab close) runs the
  tab type's close handler, which clears `doc.enabled` but leaves `doc.toolsPinned` set, so the
  tools stay with that chat. Removing tools rewrites the request's tool array, which sits in
  front of every message and invalidates the provider prefix cache for one full-context
  request. Only `PUT /api/comfy-cowork/doc/unload` clears the pin; the canvas asks for it from
  a warning dialog that recommends compacting the chat first. Never detach tools on a plain
  close, and never make unload the default.
- The canvas tab has its own title (`Comfy 画布`); the *command* carries the plugin's name.
  Never call the plugin "canvas" in UI copy, and never add a composer button for it.
- Enabling is guarded the same way. `PUT /doc/enabled` answers `needsConfirmation` (without
  changing anything) when the chat already has messages and the tools are not pinned yet; the
  canvas then shows the same warning modal and resends with `confirm: true`. Opening the canvas
  is what enables, so the slash command only opens the tab and the tab asks on mount.
- The ComfyUI address is per workspace: `lib/workspace-config.js` reads and writes
  `<workspace>/.comfy-cowork/config.json`, and `hooks.activate(sessionId)` copies it into the
  shared `config.baseUrl` before document requests, tool calls, and runs, so the client follows
  the workspace without a restart. `PUT /config` writes it and broadcasts to every open canvas;
  an invalid address is rejected. Never reintroduce a hard-coded port in UI copy.
- `doc.enabled` is the open-tab switch and `doc.toolsPinned` the attach switch; the host
  attaches when either is true. `GET /api/comfy-cowork/health` reports the live attach list as
  `scoped`.

## Commands

- `npm run build` — rebuild `client.js` (must run after every `src/client` change).
- `npm test` — node test runner (`tests/*.test.js`).
- `npm pack` — runs `prepack` (build + tests) and writes the tarball that users install; the
  tarball carries the prebuilt `client.js`, so installing needs no build. `npm publish` ships
  the same tarball and must only run with the user's approval.
- The npm tarball is the user-facing distribution: users enter the package name in the DSH
  plugin dialog and get the prebuilt bundle. `client.js` is gitignored; `prepare` builds it for
  local and git installs, and `prepack` builds it for the published tarball. A git install
  therefore needs pnpm's build approval.
- `npm run pack:dev` — build + test, then pack `dist/dsh-comfy-cowork-<version>-dev.<stamp>.tgz`.
  The author's machine runs this pre-release build so it can be tested before release; the
  published package is the only official version. The `-dev.` suffix keeps the release above
  every pre-release of it, and `GET /health` reports which one is running.
- Install a dev build into the author's live profile: `plugin_manager install_bundle` with the
  tarball's absolute path, then restart the DSH process (host modules are ESM-cached; an
  install without a restart leaves the old host half running). Confirm with
  `GET /api/comfy-cowork/health` that `version` is the dev build.

### Verification before a release

Nothing is published before it ran in a live host; one published version carries one verified
batch, so a fix is never split across two releases.

1. `npm run build`, then `npm test`.
2. `npm run pack:dev`, install the tarball, restart DSH, and check `/health` reports that
   version — a stale host is the failure that already cost a release.
3. Exercise the changed paths on the real page: the affected canvas controls, the API route
   with a signed cookie, and the agent-facing tool call.
4. Only then bump the version once and `npm publish` with the user's explicit approval.

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

- The only agent entry is `comfy_cowork`: `discover` walks groups → features, `describe`
  returns input schemas, `execute` runs one. Feature ids are flat; discover matches names,
  groups, descriptions, and English + Chinese aliases, so 「跑图」, 「刷新」, or 「批注」 finds the
  right feature without knowing its id.
- `state` is the whole canvas in one call: prompt and negative prompt, size and image,
  layout, workflow bindings, recent runs, every comment with its crop path, and the painted
  mask's bbox in canvas pixels plus its asset paths. Read it before editing. A painted mask
  means the next edit is a local repaint of that region; never regenerate the whole image
  while a mask is painted. An empty mask plus a full-image prompt is a new image.
- Mask plumbing. A workflow's `mask` input is followed through GrowMask/FeatherMask/ImageToMask
  back to a `LoadImageMask` or `LoadImage`, so a graph built from ComfyUI's mask nodes is fed
  `mask.png` (white = editable, carried in the alpha channel) directly. Only the legacy shape —
  `LoadImage`'s MASK output wired straight into the mask — makes the canvas hand over
  `canvas_rgba.png` with the mask cut out of the alpha; a run derives that from `mask.png`
  when it is missing.
- Model browsing is two levels on purpose: model folders first (with counts), then one folder's
  files, paged (default 200). The snapshot is rebuilt only by `refresh` (or the canvas Refresh
  directories button) or when the ComfyUI address changes — never on a timer. Never dump every
  model into a tool result, and never tell the agent to `ls` a ComfyUI directory outside the
  workspace — the catalog exists to avoid that.
- The model catalog and the node directory answer different questions. A model list is about
  models (folders of loadable files); the node directory is about node types (name and
  description). Never build one from the other: a widget's accepted values are read from
  ComfyUI on demand, not cached.
- The node directory mirrors the tree ComfyUI's own node palette shows: every node carries a
  category path (`KJNodes/masking`), so browse top-level counts → subcategories → the nodes
  filed there. `list_nodes` with no arguments opens the top level, `category` opens one level,
  and `query` searches type, display name, category, and description. `node_info` returns one
  node's inputs and outputs live from ComfyUI (defaults, ranges, tooltips, dropdown values paged
  at 100 with `option_offset`); input schemas are never cached. Never page the whole directory
  at an agent: an install has over a thousand types and a workflow uses a handful.
- Workflow ids are `<source>:<path>`; `find()` still accepts a bare ComfyUI file name.

- Layout boxes are **MOSS-Image only**; other models ignore them and use the prompt box.
- Comments are annotation bboxes the user (or the agent) draws on the image to explain what is
  wrong and how it should look; they are stored as JSON both in the document and embedded in
  the exported PNG, and every comment records its `source` (`user` / `agent`).
