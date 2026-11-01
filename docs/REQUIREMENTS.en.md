[中文](REQUIREMENTS.md) · English · [日本語](REQUIREMENTS.ja.md)

# DSH Comfy Cowork product requirements

- Version: v1.0 (confirmed); this document describes v1.0 behavior.

## 1. Product positioning

DSH Comfy Cowork is a plugin installed into DSH that puts an image-editing canvas, a ComfyUI workflow browser, and agent collaboration into one interface. Chat on the left, canvas on the right; the human and the agent work on the same canvas state.

1. **The canvas is shared state**, not a chat attachment. The agent can read the masks the user paints, the boxes the user draws, and the prompt the user writes; the user can see prompts the agent writes in the text box and keep editing them.
2. **Outputs go straight into ComfyUI.** Masks are PNGs ComfyUI can read; prompts are strings MOSS-Image can use directly; workflows are the JSON ComfyUI saved itself.
3. **Local first.** Images move only between the local machine, DSH, and the ComfyUI the user configured.

The plugin works per session. Once installed it is dormant; running `/dsh-comfy-cowork` in a chat (the menu row shows `DSH Comfy cowork`) opens the canvas and attaches the `comfy_coworking_*` tools to that chat's agent. Closing the canvas tab removes them again; the on/off state is stored in the document and survives a refresh or restart. Other chats never see these tools.

## 2. Scope

Image mode: import an image, zoom/pan/fit, brush/eraser/rectangle/ellipse masks, undo/redo, mask operations, export.

Layout mode (MOSS-Image only): set the canvas size, draw boxes and drag to resize them, edit `label`/`caption`/`text`/`palette`/`tags` per box, compile the layout prompt live, validate size and boxes.

Prompt: one authoritative positive text box and one negative text box. Manual input, agent tool writes, and layout compilation all land in the same `prompt` field; the negative prompt is stored separately and written at run time into the negative text node wired to the sampler.

Comments: draw a box on the image and write a note; the author (`user` / `agent`) is recorded. Comments are stored in the document and embedded in the exported PNG; when the agent reads a comment it also gets a screenshot of that region.

Workflows: list and load ComfyUI `userdata/workflows` and local JSON; edit the node graph, parameters, titles, bypass/mute; save back to the server or export; injection bindings; queue, cancel, and backfill results to the canvas. The model list comes from ComfyUI's `/models`, `/models/{folder}`, and `object_info` combos; model dropdowns in nodes are selectable directly.

Persistence: one workspace directory per session, `.comfy-cowork/<sessionId>/`, holding `document.json`, image and mask assets, and `runs/`. Writes are atomic; everything is restored after a refresh or restart.

Not in v1: a video-editing UI (timeline, multitrack, cutting); arbitrary node add/delete or rewiring; Comfy Cloud and multi-server accounts; model download, deletion, or directory management; real-time multi-user collaboration; built-in smart masks such as matting, depth, or pose (delegated to ComfyUI nodes).

## 3. Canvas and mask

- Mask semantics: white/opaque = editable area; an Invert switch is provided.
- Brush: size 1–400 px in source-image pixels, hardness 0–100%, opacity 1–100%; `[` and `]` change size, `Alt` temporarily switches to the eraser.
- Shapes: rectangle and ellipse; drag to create, `Shift` constrains to a square/circle, and creation can be undone.
- Mask operations: grow/shrink first (−128–128 px), then feather (0–128 px Gaussian blur); the mask can be cleared. The overlay preview is red or a chosen color with adjustable opacity, and it can be hidden to show the image alone.
- Export: `mask.png` (grayscale, white = editable area) and `canvas_rgba.png` (original RGB + alpha = mask). ComfyUI's `LoadImage` takes the mask from alpha and `LoadImageMask` from color channels; both files are provided, and the workflow binding picks one.

## 4. MOSS-Image layout

The actual interface in ComfyUI 0.41.0: the `MOSSImageLayoutPrompt` node takes `prompt`, `element`, `width`, `height`, and `character_boxes`, and outputs one line of JSON:

```json
{
  "summary": { "caption": "<whole-image caption>" },
  "items": [
    { "label": "object", "caption": "...", "bbox": [y1-H/2, x1-W/2, y2-H/2, x2-W/2] }
  ],
  "bbox_coord_space": "abs_centralized",
  "bbox_format": "yxyx"
}
```

- Box coordinates are normalized to 0–1000 first, then converted to pixels: `floor(y1*H/1000)-H//2`, `floor(x1*W/1000)-W//2`, `ceil(y2*H/1000)-H//2`, `ceil(x2*W/1000)-W//2`. Compilation matches the Python node's rounding byte for byte.
- A `text` item carries an extra `"text"`; when a palette is set it carries `"palette"` with at most 5 colors.
- `CreateBoundingBoxes`' `bboxes` accepts a JSON string: `[{type:"obj"|"text", bbox:[ymin,xmin,ymax,xmax] (0–1000), text?, desc?, color_palette?}]`.
- With no boxes, the text box holds a plain caption and no JSON; with boxes, it holds the compiled one-line JSON.
- Validation covers canvas size (multiple of 16), out-of-bounds boxes, negative width/height, and empty text on `text` items. On failure the panel reports the error and the prompt keeps the last usable content.

## 5. Single prompt source

`document.prompt` is the single authoritative prompt. There are only three writers: the user typing in the text box, automatic compilation after a layout change, and the agent's prompt tools.

- The agent's prompt tools write only `document.prompt` (plus the structured summary and per-box captions), and the result echoes the final text; the agent may not keep the only copy in chat. While the user is typing, an agent update does not steal focus: an "agent updated" notice appears and the user loads it.
- Every write carries a `rev`; running a workflow injects the text box's current content. A compiled result the user edited by hand is sent as the user's version, not recompiled over.

## 6. ComfyUI compatibility

- HTTP prefix `/api/comfy-cowork`. The default connection is `http://127.0.0.1:8188`, proxied by the DSH Host; the browser never connects directly. A direct request carrying `Origin: http://127.0.0.1:3080` returns 403 from ComfyUI, so the Host proxy is the only path. Endpoints used: `system_stats`, `models`, `models/{folder}`, `object_info`, `userdata` (read/write/delete workflows), `upload/image`, `prompt`, `history/{prompt_id}`, `queue`, `interrupt`, `view`.
- Prompt text, canvas image, mask, canvas width/height, and seed are injected by binding; before a run the plugin validates locally (required inputs, nodes exist, types match) and then submits to `/prompt`.

Workflow conversion covers widget parameters, links, `Reroute`, `Primitive`, `Note`, bypass (mode 4), mute (mode 2), and the `control_after_generate` extra widget on seed. API-format workflows are used directly. A subgraph or unknown custom node produces an explicit error naming the node; nodes are never dropped silently.

Bindings are saved with the workflow in `document.workflow.bindings`; when no node matches, the workflow can still run, and the result states which roles were not injected.

| Role | Injected value | Inferred from |
|---|---|---|
| prompt | prompt text box content | `CLIPTextEncode` with positive/prompt in the title; MOSS layout node |
| image | uploaded name of the canvas image | the first `LoadImage` |
| mask | RGBA image or standalone mask | `LoadImage`'s mask output / `LoadImageMask` |
| width/height | canvas size | `Empty*LatentImage` / `MOSSImageLayoutPrompt` |

## 7. Agent tools

Tools share the `comfy_coworking_` prefix and all work through the Host's session document:

- Read: `state` (canvas, boxes, prompt, bindings, recent runs, asset paths), `health` (connection and diagnostics).
- Prompt and layout: `set_prompt`, `set_layout`, `upsert_box`, `remove_box`.
- Canvas: `load_image` (workspace paths only), `set_canvas`.
- Workflows and models: `list_workflows`, `load_workflow`, `list_models`, `bind_workflow`.
- Runs: `run`, `run_status`, `interrupt`.
- Comments: `comments` (list, add, update, remove; returns region screenshot paths).
- Panel: `open_canvas` (raises the canvas tab in an open frontend page).

The Host system prompt requires that image-generation prompts go through these tools into the text box. `state` returns absolute paths to the canvas and mask so the agent can inspect them with an image-reading tool, keeping large images out of every tool result.

## 8. Non-functional requirements

- Theme: only `--dsw-alias-*` tokens, readable in dark and light; all UI copy goes through the locale catalog: Chinese, English, Japanese; other languages fall back to English.
- Performance: thumbnails for display, source pixels for masks and export; `object_info` is cached with a manual refresh; document changes go over SSE; run status polls once per second.
- Reliability: atomic document writes (temp file + rename); a corrupt document is backed up and rebuilt; the canvas stays editable when ComfyUI is disconnected; a failed run keeps the error and node id. No telemetry; images go only to the user's configured ComfyUI; logs do not print full prompts by default.
- Tests: 100 `node:test` unit tests covering MOSS compilation, workflow conversion, document storage, and the HTTP routes; image generation was verified by hand on a real ComfyUI (MOSS text-to-image, MOSS layout, SDXL inpaint).

## 9. Confirmed decisions

- Workflow editing depth: view the graph, change parameters/title/bypass, save; no arbitrary node add/delete or rewiring.
- Panel placement: a right-sidebar tab beside the chat, fullscreen-capable.
- Default workflow: no built-in template, loaded from the ComfyUI server; compatibility verified with `moss_template.json`, `coworking_smoke.json`, `coworking_inpaint.json`, and `coworking_moss_layout.json`.
- Local editing: a generic workflow plus bindings; SDXL `VAEEncodeForInpaint` is the reference chain.
- Agent capabilities: read and write the canvas, write prompts and boxes, run workflows, view results; runs are visible and cancellable.
- MOSS prompt shape: the whole-image caption is a layout box (type `summary`, exactly one) and the text box holds the final compiled one-line layout JSON; the render resolution follows the canvas size.
- Video: no video-editing UI; existing video workflows can load, run, and preview outputs.

## 10. Known limitations

- Subgraph workflows are unsupported and raise an explicit error; API-format workflows can run and save, but the graph view is read-only.
- One ComfyUI server only.
- The agent's `open_canvas` only raises a tab in an open frontend page; it does not open one when no page is open.
- Video is generic workflow runs plus `<video>` previews; there is no timeline.
- Masks are processed at source resolution in the browser; scale images above 4K down first.
