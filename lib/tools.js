/** Agent-facing tools. Every prompt write lands in the shared canvas document. */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { validateLayout } from './moss.js'
import { imageSize } from './image-size.js'
import { inferBindings } from './workflow.js'
import { compileDocPrompt, layoutErrors } from './doc.js'
import { errorMessage } from './config.js'

function sessionIdOf(exec) {
  const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('Comfy coworking tools require an Agent-backed session')
  return sessionId
}

function resolveWorkspacePath(ctx, exec, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('path is required')
  const session = exec?.agent?.session
  const cwd = session ? ctx.workingDirectory.get(session) : null
  if (typeof cwd !== 'string' || cwd === '') throw new Error('cannot resolve the session workspace')
  const target = path.resolve(cwd, value)
  const relative = path.relative(cwd, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path must stay inside the session workspace')
  return target
}

function textOutput(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function objectSchema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function summaryState(doc, dir) {
  const prompt = typeof doc.prompt === 'string' ? doc.prompt : ''
  const runs = Array.isArray(doc.runs) ? doc.runs.slice(0, 3) : []
  return {
    rev: doc.rev,
    mode: doc.mode,
    canvas: {
      width: doc.canvas.width,
      height: doc.canvas.height,
      image: doc.canvas.image === null || doc.canvas.image === undefined
        ? null
        : {
            asset: doc.canvas.image.asset ?? '',
            width: doc.canvas.image.width ?? 0,
            height: doc.canvas.image.height ?? 0,
            name: doc.canvas.image.name ?? '',
          },
    },
    prompt,
    negative: typeof doc.negative === 'string' ? doc.negative : '',
    promptSource: doc.promptSource,
    promptError: doc.promptError ?? '',
    layout: {
      summary: doc.layout.summary,
      items: doc.layout.items,
    },
    comments: Array.isArray(doc.comments) ? doc.comments.length : 0,
    selected: doc.selected,
    mask: {
      feather: doc.mask.feather,
      grow: doc.mask.grow,
      inverted: doc.mask.inverted,
      rev: doc.mask.rev,
    },
    workflow: doc.workflow === null || doc.workflow === undefined
      ? null
      : {
          name: doc.workflow.name,
          nodes: Array.isArray(doc.workflow.json?.nodes) ? doc.workflow.json.nodes.length : null,
          apiNodes: doc.workflow.api && typeof doc.workflow.api === 'object' ? Object.keys(doc.workflow.api).length : 0,
          bindings: doc.workflow.bindings ?? {},
        },
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      promptId: run.promptId,
      outputs: Array.isArray(run.outputs) ? run.outputs.map((output) => ({ asset: output.asset ?? '', url: output.url ?? '', type: output.type ?? '' })) : [],
      error: run.error ?? null,
      createdAt: run.createdAt,
    })),
    paths: {
      dir,
      canvas: doc.canvas.image?.asset ? `${dir}/assets/${doc.canvas.image.asset}` : null,
      mask: `${dir}/assets/mask.png`,
    },
  }
}

function boxAt(box, width, height) {
  const [x1, y1, x2, y2] = box.bbox
  if (!(x1 >= 0 && y1 >= 0 && x2 <= width && y2 <= height && x2 > x1 && y2 > y1)) {
    throw new Error(`bbox must be inside the ${width}x${height} canvas with a positive size`)
  }
}

function commentImage(doc) {
  const image = doc.canvas?.image
  if (image === null || image === undefined || typeof image !== 'object') return null
  return {
    name: typeof image.name === 'string' && image.name !== ''
      ? image.name
      : (typeof image.asset === 'string' ? image.asset : ''),
    width: Number(image.width) || 0,
    height: Number(image.height) || 0,
  }
}

/** Attach the crop the browser exported for a comment, if it exists yet. */
async function commentWithCrop(store, sessionId, comment) {
  const name = `comment-${comment.id}.png`
  const crop = await store.assetExists(sessionId, name)
    ? path.resolve(store.assetPath(sessionId, name))
    : null
  return { ...comment, crop }
}

/**
 * Register the agent tools on one scoped context. `register` defaults to the
 * plugin context (global tools); the plugin passes the session-scoped
 * `scope.tools.register` instead so tools only exist for enabled sessions.
 */
export function registerTools({ ctx, store, comfy, config, log, runManager, diagnostics, register, activate }) {
  const rawRegister = typeof register === 'function'
    ? register
    : (definition) => ctx.effect(() => ctx.tools.register(definition), `comfy-cowork: ${definition.name}`)

  /** Every tool runs against the ComfyUI address this chat's workspace saved. */
  const registerTool = (definition) => rawRegister({
    ...definition,
    execute: async (args, exec) => {
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
      if (typeof activate === 'function' && typeof sessionId === 'string') {
        try {
          await activate(sessionId)
        } catch {}
      }
      return await definition.execute(args, exec)
    },
  })

  registerTool({
    name: 'comfy_coworking_health',
    description: 'Check the ComfyUI connection and whether the browser canvas bundle has checked in. Use this when the canvas or a run behaves unexpectedly.',
    parameters: objectSchema(),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOutput(value),
    },
    async execute() {
      let stats = null
      let error = null
      try {
        stats = await comfy.systemStats()
      } catch (caught) {
        error = errorMessage(caught)
      }
      let module = null
      try {
        const graph = ctx.get('clientModules')?.graph?.()
        const entry = graph?.entries?.find?.((row) => row.id === 'dsh-comfy-cowork')
        if (entry !== undefined) module = { id: entry.id, url: entry.url, rev: entry.rev }
      } catch {}
      return {
        baseUrl: config.baseUrl,
        comfy: stats === null ? { connected: false, error } : { connected: true, version: stats?.system?.comfyui_version ?? null },
        client: diagnostics?.clientHello ?? null,
        errors: diagnostics?.errors?.slice(0, 10) ?? [],
        clientModule: module,
      }
    },
  })

  registerTool({
    name: 'comfy_coworking_state',
    description: 'Read the shared Comfy canvas: the prompt textbox, canvas size, layout boxes, selection, loaded workflow binding, and recent runs. Also returns the absolute paths of the canvas image and mask so you can inspect them with read_image.',
    parameters: objectSchema(),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOutput(value),
    },
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const doc = await store.snapshot(sessionId)
      const dir = store.sessionDir(sessionId)
      return summaryState(doc, dir)
    },
  })

  registerTool({
    name: 'comfy_coworking_set_prompt',
    description: 'Write the plugin prompt textbox (positive) or the negative prompt box. This is the only prompt the canvas and ComfyUI runs use; the user sees the text appear in the box. Use it for captions and for MOSS-Image layout prompts.',
    parameters: objectSchema({
      prompt: { type: 'string', description: 'Prompt text to place in the canvas prompt box. Pass the final text, not instructions about it.' },
      mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) overwrites the box; append adds a paragraph after the current text.' },
      target: { type: 'string', enum: ['positive', 'negative'], description: 'Which box to write: positive (default) or negative.' },
    }, ['prompt']),
    output: {
      schema: objectSchema({
        rev: { type: 'number' },
        prompt: { type: 'string' },
        promptError: { type: 'string' },
      }, ['rev', 'prompt']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const text = typeof args.prompt === 'string' ? args.prompt : ''
      if (text.length > config.maxPromptChars) throw new Error(`prompt exceeds ${config.maxPromptChars} characters`)
      if (args.target === 'negative') {
        const current = await store.snapshot(sessionId)
        const next = args.mode === 'append' && current.negative.trim() !== ''
          ? `${current.negative.trimEnd()}\n\n${text}`
          : text
        const doc = await store.setNegative(sessionId, next, { source: 'agent' })
        return { rev: doc.rev, prompt: doc.negative, promptError: '' }
      }
      const current = await store.snapshot(sessionId)
      const next = args.mode === 'append' && current.prompt.trim() !== ''
        ? `${current.prompt.trimEnd()}\n\n${text}`
        : text
      const doc = await store.setPrompt(sessionId, next, { source: 'agent', manual: true })
      return { rev: doc.rev, prompt: doc.prompt, promptError: doc.promptError ?? '' }
    },
  })

  registerTool({
    name: 'comfy_coworking_set_layout',
    description: 'Replace the canvas layout boxes and their captions, then compile the MOSS-Image layout prompt into the prompt textbox. Coordinates are pixels [x1,y1,x2,y2] from the top-left. The whole-image caption must be non-empty. This is how you create a bbox layout for MOSS-Image.',
    parameters: objectSchema({
      summary: { type: 'string', description: 'Whole-image caption (summary.caption).' },
      items: {
        type: 'array',
        description: 'Layout items; each has a label, caption, pixel bbox, optional text for text items, and optional palette.',
        items: objectSchema({
          id: { type: 'string' },
          label: { type: 'string', enum: ['object', 'character', 'text'] },
          caption: { type: 'string' },
          text: { type: 'string', description: 'Exact visible text; required for a text item.' },
          bbox: { type: 'array', items: { type: 'number' }, description: '[x1,y1,x2,y2] in canvas pixels.' },
          palette: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
        }, ['label', 'caption', 'bbox']),
      },
    }, ['summary', 'items']),
    output: {
      schema: objectSchema({
        rev: { type: 'number' },
        prompt: { type: 'string' },
        boxCount: { type: 'number' },
      }, ['rev', 'prompt', 'boxCount']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const doc = await store.snapshot(sessionId)
      const items = Array.isArray(args.items) ? args.items : []
      const errors = validateLayout({ width: doc.canvas.width, height: doc.canvas.height, summary: args.summary, items })
      if (errors.length > 0) throw new Error(`invalid layout: ${errors.join('; ')}`)
      const next = await store.setLayout(sessionId, { summary: args.summary, items }, { source: 'agent' })
      const compiled = compileDocPrompt(next)
      if (compiled.error !== null) throw new Error(`layout compiled with errors: ${compiled.error}`)
      return { rev: next.rev, prompt: next.prompt, boxCount: next.layout.items.length }
    },
  })

  registerTool({
    name: 'comfy_coworking_upsert_box',
    description: 'Add one bbox to the canvas layout, or update an existing bbox by id, and recompile the MOSS-Image prompt. Use comfy_coworking_set_layout when replacing the whole layout.',
    parameters: objectSchema({
      id: { type: 'string', description: 'Existing box id; omit to create a new box.' },
      label: { type: 'string', enum: ['object', 'character', 'text'] },
      caption: { type: 'string' },
      text: { type: 'string' },
      bbox: { type: 'array', items: { type: 'number' }, description: '[x1,y1,x2,y2] in canvas pixels.' },
      palette: { type: 'array', items: { type: 'string' } },
    }, ['label', 'caption', 'bbox']),
    output: {
      schema: objectSchema({ rev: { type: 'number' }, box: { type: 'object' }, promptError: { type: 'string' } }, ['rev', 'box']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const doc = await store.snapshot(sessionId)
      boxAt(args, doc.canvas.width, doc.canvas.height)
      const box = {
        id: args.id ?? '',
        label: args.label,
        caption: args.caption,
        text: args.text ?? '',
        bbox: args.bbox,
        palette: args.palette ?? [],
      }
      const next = await store.upsertBox(sessionId, box, { source: 'agent' })
      const selected = next.layout.items.find((item) => item.id === next.selected?.id) ?? null
      return { rev: next.rev, box: selected ?? {}, promptError: next.promptError ?? '' }
    },
  })

  registerTool({
    name: 'comfy_coworking_remove_box',
    description: 'Remove one bbox from the canvas layout by its id and recompile the MOSS-Image prompt.',
    parameters: objectSchema({ id: { type: 'string' } }, ['id']),
    output: {
      schema: objectSchema({ rev: { type: 'number' }, boxCount: { type: 'number' }, prompt: { type: 'string' } }, ['rev', 'boxCount', 'prompt']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const next = await store.removeBox(sessionId, args.id, { source: 'agent' })
      return { rev: next.rev, boxCount: next.layout.items.length, prompt: next.prompt }
    },
  })

  registerTool({
    name: 'comfy_coworking_comments',
    description: 'Read or edit the annotation comments the user draws on the canvas image: each comment is a boxed region plus feedback such as "这个图不行 这里细节不好". Call with action "list" to read them; every comment includes crop (absolute PNG path of the region, or null), so read each crop with the image-reading tool and fix the canvas image accordingly. "add" creates a comment (automatically marked source "agent"), "update" edits one by id and keeps its original source, "remove" deletes it. Never silently rewrite the user\'s text.',
    parameters: objectSchema({
      action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: '"list" reads comments, "add" creates one, "update" edits one by id, "remove" deletes one.' },
      id: { type: 'string', description: 'Comment id (cm-…). Required for update and remove.' },
      bbox: { type: 'array', items: { type: 'number' }, description: '[x1,y1,x2,y2] in canvas pixels; required for add, optional for update.' },
      text: { type: 'string', description: 'The feedback: what is wrong and how it should look; required for add, optional for update.' },
    }, ['action']),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const action = typeof args.action === 'string' ? args.action : 'list'
      if (action === 'list') {
        const doc = await store.snapshot(sessionId)
        const comments = await Promise.all(
          (Array.isArray(doc.comments) ? doc.comments : []).map((comment) => commentWithCrop(store, sessionId, comment)),
        )
        return {
          comments,
          canvas: { width: doc.canvas.width, height: doc.canvas.height },
          image: commentImage(doc),
        }
      }
      if (action === 'add') {
        const doc = await store.upsertComment(sessionId, {
          bbox: args.bbox,
          text: args.text,
          source: 'agent',
        }, { source: 'agent' })
        const comment = doc.comments[doc.comments.length - 1]
        return { rev: doc.rev, comment: await commentWithCrop(store, sessionId, comment) }
      }
      if (action === 'update') {
        if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error('id is required to update a comment')
        if (args.bbox === undefined && args.text === undefined) throw new Error('update needs bbox or text')
        const doc = await store.upsertComment(sessionId, {
          id: args.id,
          bbox: args.bbox,
          text: args.text,
          source: 'agent',
        }, { source: 'agent' })
        const comment = doc.comments.find((entry) => entry.id === args.id.trim())
        return { rev: doc.rev, comment: comment === undefined ? null : await commentWithCrop(store, sessionId, comment) }
      }
      if (action === 'remove') {
        if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error('id is required to remove a comment')
        const id = args.id.trim()
        const before = await store.snapshot(sessionId)
        const removed = (Array.isArray(before.comments) ? before.comments : []).some((entry) => entry.id === id)
        const doc = await store.removeComment(sessionId, id, { source: 'agent' })
        return { rev: doc.rev, id, removed }
      }
      throw new Error('action must be list, add, update or remove')
    },
  })

  registerTool({
    name: 'comfy_coworking_load_image',
    description: 'Load an image from the session workspace onto the shared canvas. Use this before asking the user to mask it, or to replace the canvas with a reference. An optional mask file is copied as the canvas mask.',
    parameters: objectSchema({
      path: { type: 'string', description: 'Image path relative to the session workspace.' },
      mask_path: { type: 'string', description: 'Optional mask image path relative to the workspace; white/opaque means editable.' },
      mode: { type: 'string', enum: ['image', 'layout'], description: 'Canvas mode after loading; defaults to image.' },
    }, ['path']),
    output: {
      schema: objectSchema({
        rev: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        asset: { type: 'string' },
        mask: { type: 'boolean' },
      }, ['rev', 'width', 'height', 'asset']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const target = resolveWorkspacePath(ctx, exec, args.path)
      const buffer = await fs.readFile(target)
      const size = imageSize(buffer)
      if (size === null) throw new Error(`cannot read image dimensions: ${args.path}`)
      const asset = 'canvas.png'
      await store.saveAsset(sessionId, asset, buffer)
      await store.saveAsset(sessionId, 'source.png', buffer)
      await store.deleteAsset(sessionId, 'mask.png')
      await store.deleteAsset(sessionId, 'canvas_rgba.png')
      let mask = false
      if (typeof args.mask_path === 'string' && args.mask_path.trim() !== '') {
        const maskTarget = resolveWorkspacePath(ctx, exec, args.mask_path)
        const maskBuffer = await fs.readFile(maskTarget)
        await store.saveAsset(sessionId, 'mask.png', maskBuffer)
        mask = true
      }
      const doc = await store.setCanvas(sessionId, {
        mode: args.mode === 'layout' ? 'layout' : 'image',
        width: size.width,
        height: size.height,
        image: { asset, name: path.basename(target), width: size.width, height: size.height, rev: Date.now() },
        mask: mask ? { rev: Date.now(), hasMask: true } : { rev: Date.now(), hasMask: false },
      }, { source: 'agent' })
      return { rev: doc.rev, width: size.width, height: size.height, asset, mask }
    },
  })

  registerTool({
    name: 'comfy_coworking_set_canvas',
    description: 'Set the shared canvas size and mode. MOSS-Image layout canvases need width and height as multiples of 16.',
    parameters: objectSchema({
      width: { type: 'number', description: 'Canvas width in pixels.' },
      height: { type: 'number', description: 'Canvas height in pixels.' },
      mode: { type: 'string', enum: ['image', 'layout'] },
    }),
    output: {
      schema: objectSchema({ rev: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, mode: { type: 'string' } }, ['rev', 'width', 'height', 'mode']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const doc = await store.snapshot(sessionId)
      const width = Number.isInteger(args.width) ? args.width : doc.canvas.width
      const height = Number.isInteger(args.height) ? args.height : doc.canvas.height
      if (width < 16 || height < 16 || width > 16384 || height > 16384) throw new Error('canvas size must be between 16 and 16384')
      const next = await store.setCanvas(sessionId, {
        width,
        height,
        mode: args.mode === 'image' || args.mode === 'layout' ? args.mode : doc.mode,
      }, { source: 'agent' })
      return { rev: next.rev, width: next.canvas.width, height: next.canvas.height, mode: next.mode }
    },
  })

  registerTool({
    name: 'comfy_coworking_list_workflows',
    description: 'List the workflow files saved in ComfyUI userdata/workflows. Use comfy_coworking_load_workflow to open one on the canvas.',
    parameters: objectSchema(),
    output: {
      schema: objectSchema({ workflows: { type: 'array', items: { type: 'object' } } }, ['workflows']),
      render: (_args, value) => textOutput(value),
    },
    async execute(_args, exec) {
      sessionIdOf(exec)
      return { workflows: await comfy.listWorkflows() }
    },
  })

  registerTool({
    name: 'comfy_coworking_load_workflow',
    description: 'Load a ComfyUI workflow by file name into the shared canvas, replacing the currently loaded workflow. Returns node titles and the input bindings the run will inject.',
    parameters: objectSchema({
      name: { type: 'string', description: 'Workflow path under ComfyUI userdata/workflows, for example moss_template.json.' },
    }, ['name']),
    output: {
      schema: objectSchema({
        rev: { type: 'number' },
        name: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
        bindings: { type: 'object' },
      }, ['rev', 'name', 'nodes']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const workflow = await comfy.readWorkflow(args.name)
      const nodes = Array.isArray(workflow?.nodes)
        ? workflow.nodes.map((node) => ({ id: node.id, type: node.type, title: node.title ?? null }))
        : []
      let bindings = {}
      try {
        bindings = inferBindings(workflow, await comfy.objectInfo())
      } catch {}
      const doc = await store.setWorkflow(sessionId, {
        name: args.name,
        json: workflow,
        bindings,
        dirty: false,
      }, { source: 'agent' })
      return { rev: doc.rev, name: doc.workflow.name, nodes, bindings: doc.workflow.bindings }
    },
  })

  registerTool({
    name: 'comfy_coworking_list_models',
    description: 'List ComfyUI model folders, or the model files inside one folder. Use folder names from the returned list, for example diffusion_models or loras.',
    parameters: objectSchema({
      folder: { type: 'string', description: 'Omit to list folders; supply a folder name to list its files.' },
    }),
    output: {
      schema: objectSchema({ folders: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } } }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      sessionIdOf(exec)
      if (typeof args.folder === 'string' && args.folder.trim() !== '') {
        return { folders: [], files: await comfy.modelFiles(args.folder.trim()) }
      }
      return { folders: await comfy.models(), files: [] }
    },
  })

  registerTool({
    name: 'comfy_coworking_open_canvas',
    description: 'Request that the Web UI open the Comfy canvas tab for this session. If the tab does not appear, ask the user to run /dsh-comfy-cowork.',
    parameters: objectSchema(),
    output: {
      schema: objectSchema({ requested: { type: 'boolean' }, rev: { type: 'number' } }, ['requested', 'rev']),
      render: (_args, value) => textOutput(value),
    },
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const doc = await store.requestOpen(sessionId, { source: 'agent' })
      return { requested: true, rev: doc.rev }
    },
  })

  registerTool({
    name: 'comfy_coworking_bind_workflow',
    description: 'Set which nodes of the loaded workflow receive the prompt, image, mask, width/height, seed, and CreateBoundingBoxes elements. Use comfy_coworking_state to see the current bindings and comfy_coworking_load_workflow to load a workflow.',
    parameters: objectSchema({
      prompt: { type: 'string' }, image: { type: 'string' }, mask: { type: 'string' },
      width: { type: 'string' }, height: { type: 'string' }, seed: { type: 'string' },
      bboxes: { type: 'string' },
    }),
    output: {
      schema: objectSchema({ rev: { type: 'number' }, bindings: { type: 'object' } }, ['rev', 'bindings']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const doc = await store.snapshot(sessionId)
      if (doc.workflow === null) throw new Error('no workflow is loaded')
      const bindings = { ...(doc.workflow.bindings ?? {}) }
      for (const key of ['prompt', 'image', 'mask', 'width', 'height', 'seed', 'bboxes']) {
        if (typeof args[key] === 'string') bindings[key] = args[key]
      }
      const next = await store.patchWorkflow(sessionId, { bindings }, { source: 'agent' })
      return { rev: next.rev, bindings: next.workflow.bindings }
    },
  })

  registerTool({
    name: 'comfy_coworking_run',
    description: 'Queue the loaded workflow with the current canvas prompt, image, mask, size, and seed. Returns a run id immediately; use comfy_coworking_run_status to follow it and comfy_coworking_state to see outputs after it settles.',
    parameters: objectSchema({
      bindings: { type: 'object', description: 'Optional binding overrides for this run only.' },
      seed: { type: 'number', description: 'Optional seed override; the bound seed node is set to this value.' },
      wait_seconds: { type: 'number', description: 'Wait up to this many seconds for completion (max 120); omit to return immediately.' },
    }),
    output: {
      schema: objectSchema({ run: { type: 'object' } }, ['run']),
      render: (_args, value) => textOutput(value),
    },
    timeoutMs: 150_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const result = await runManager.start(sessionId, {
        bindings: args.bindings,
        seed: typeof args.seed === 'number' ? args.seed : undefined,
      }, { agent: true })
      let run = result.run
      if (typeof args.wait_seconds === 'number' && args.wait_seconds > 0) {
        run = await runManager.waitFor(sessionId, run.id, Math.min(120, args.wait_seconds) * 1000) ?? run
      }
      return { run }
    },
  })

  registerTool({
    name: 'comfy_coworking_run_status',
    description: 'Read one ComfyUI run by id, or the latest run, including status, errors, and downloaded output assets. Optionally wait for it to settle.',
    parameters: objectSchema({
      run_id: { type: 'string' },
      wait_seconds: { type: 'number', description: 'Wait up to this many seconds for a terminal state (max 120).' },
    }),
    output: {
      schema: { type: 'object' },
      render: (_args, value) => textOutput(value),
    },
    timeoutMs: 150_000,
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      if (typeof args.wait_seconds === 'number' && args.wait_seconds > 0) {
        const run = await runManager.waitFor(sessionId, args.run_id, Math.min(120, args.wait_seconds) * 1000)
        return { run }
      }
      const doc = await store.snapshot(sessionId)
      const run = args.run_id ? doc.runs.find((entry) => entry.id === args.run_id) : doc.runs[0]
      return { run: run ?? null }
    },
  })

  registerTool({
    name: 'comfy_coworking_interrupt',
    description: 'Cancel the current ComfyUI run (or one run by id). The run is marked cancelled and stops being polled.',
    parameters: objectSchema({ run_id: { type: 'string' } }),
    output: {
      schema: objectSchema({ run: { type: 'object' } }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const run = await runManager.interrupt(sessionId, args.run_id)
      return { run }
    },
  })

  // The canvas prompt section lives in lib/plugin.js; this section carries the
  // comment workflow guidance so it reaches the model's system prompt too.
  if (typeof ctx.systemPrompt?.section === 'function') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'comfy-cowork-comments',
      order: 621,
      text: 'Comfy canvas comments: users draw annotation boxes on the image with feedback such as "这个图不行 这里细节不好". Call comfy_coworking_comments with action list, read each comment crop image with the image-reading tool, then fix the canvas image accordingly. Comments you add are automatically marked source "agent"; never silently rewrite the user\'s text.',
    }), 'comfy-cowork: comments system prompt')
  }

  // Kept for a future run tool; surfaces the current layout errors to the agent.
  void layoutErrors
  void errorMessage
  void log
}
