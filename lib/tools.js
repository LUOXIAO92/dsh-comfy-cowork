/** Agent-facing tools. Every prompt write lands in the shared canvas document. */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { validateLayout } from './moss.js'
import { imageSize } from './image-size.js'
import { inferBindings } from './workflow.js'
import { compileDocPrompt, layoutErrors } from './doc.js'
import { cleanCategory } from './node-catalog.js'
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

/**
 * Feature groups, with the one-line description `discover` shows at the top.
 * The agent walks groups → features → input schema, so the tool list stays one
 * fixed entry no matter how many capabilities the plugin grows.
 */
const GROUPS = {
  canvas: {
    description: 'Read and edit the shared canvas: size, prompt, layout boxes, masks, comments, and the image.',
    aliases: ['画布', 'canvas', '提示词', '蒙版', '批注', '布局', '图片'],
  },
  workflow: {
    description: 'Bind canvas elements into the loaded workflow, and list, load, or save workflow files.',
    aliases: ['工作流', 'workflow', '绑定', '保存', '载入'],
  },
  runs: {
    description: 'Queue a ComfyUI run, follow its progress, or cancel it.',
    aliases: ['跑图', '运行', '生成', '队列', 'run'],
  },
  catalog: {
    description: 'Browse model files and node types, and refresh the cached directories.',
    aliases: ['模型', '节点', '目录', '缓存', '刷新', 'model', 'node'],
  },
  misc: {
    description: 'Server health: ComfyUI connection, plugin version, and recent errors.',
    aliases: ['健康', '连接', '版本', 'health'],
  },
}

/** Per-feature metadata: its group and the words `discover` matches (English and Chinese). */
const FEATURE_META = {
  health: { group: 'misc', aliases: ['health', '健康', '连接', '版本'] },
  state: { group: 'canvas', aliases: ['state', '画布状态', '现状', 'read canvas'] },
  open_canvas: { group: 'canvas', aliases: ['打开画布', '显示画布', 'open', 'tab'] },
  set_canvas: { group: 'canvas', aliases: ['尺寸', '宽高', '画布大小', 'size'] },
  set_prompt: { group: 'canvas', aliases: ['提示词', 'prompt', '正向'] },
  set_layout: { group: 'canvas', aliases: ['布局', 'layout', 'bbox', '框'] },
  upsert_box: { group: 'canvas', aliases: ['布局框', 'box', '新建框', 'caption'] },
  remove_box: { group: 'canvas', aliases: ['删除框', 'remove box'] },
  comments: { group: 'canvas', aliases: ['批注', 'comment', '反馈', '意见'] },
  load_image: { group: 'canvas', aliases: ['图片', '图像', '导入', 'image', '参考图'] },
  bind_workflow: { group: 'workflow', aliases: ['绑定', 'bind', '节点绑定'] },
  list_workflows: { group: 'workflow', aliases: ['工作流列表', 'workflows', '有哪些工作流'] },
  load_workflow: { group: 'workflow', aliases: ['载入工作流', '打开工作流', 'load workflow'] },
  save_workflow: { group: 'workflow', aliases: ['保存工作流', 'save workflow', '导出工作流'] },
  run: { group: 'runs', aliases: ['跑图', '运行', '生成', 'run', 'queue'] },
  run_status: { group: 'runs', aliases: ['运行状态', '进度', 'status', '结果'] },
  interrupt: { group: 'runs', aliases: ['取消', '中断', 'cancel', 'interrupt'] },
  list_models: { group: 'catalog', aliases: ['模型', '模型列表', 'checkpoint', 'lora', 'model'] },
  list_nodes: { group: 'catalog', aliases: ['节点', '节点列表', 'node', '节点分类'] },
  node_info: { group: 'catalog', aliases: ['节点参数', '节点详情', 'schema', '下拉', '参数'] },
  refresh: { group: 'catalog', aliases: ['刷新', '重建缓存', 'refresh'] },
}

/** Page size for one node input's combo values. */
const NODE_OPTION_PAGE = 100

/** Split a discover query into lowercase terms; a Chinese phrase stays one term. */
function queryTerms(query) {
  return String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

/** Everything a discover query is matched against for one feature. */
function featureHaystack(feature) {
  return [feature.name, feature.group, feature.description, ...feature.aliases].join(' ').toLowerCase()
}

/**
 * Discover groups or features: no query and no group lists the groups, a group
 * lists its features, and a query matches names, groups, aliases, and
 * descriptions. Schemas are never part of this answer.
 */
export function discover(features, query = '', group = '') {
  const needle = String(query ?? '').trim()
  if (needle !== '') {
    const terms = queryTerms(needle)
    const groups = Object.entries(GROUPS)
      .filter(([id, entry]) => terms.every((term) => `${id} ${entry.aliases.join(' ')} ${entry.description}`.toLowerCase().includes(term)))
      .map(([id, entry]) => ({ group: id, description: entry.description }))
    const matched = [...features.values()]
      .filter((feature) => {
        const haystack = featureHaystack(feature)
        return terms.every((term) => haystack.includes(term))
      })
      .map((feature) => ({ feature: feature.name, group: feature.group, description: feature.description }))
    return { action: 'discover', query: needle, groups, features: matched, hint: 'describe one or more features to read their input schemas; execute one to run it.' }
  }
  const wanted = String(group ?? '').trim()
  if (wanted !== '') {
    const entry = GROUPS[wanted]
    if (entry === undefined) throw new Error(`request.group: unknown group ${JSON.stringify(wanted)}`)
    return {
      action: 'discover',
      group: wanted,
      description: entry.description,
      features: [...features.values()]
        .filter((feature) => feature.group === wanted)
        .map((feature) => ({ feature: feature.name, description: feature.description })),
      hint: 'describe one or more features to read their input schemas; execute one to run it.',
    }
  }
  return {
    action: 'discover',
    groups: Object.entries(GROUPS).map(([id, entry]) => ({
      group: id,
      description: entry.description,
      features: [...features.values()].filter((feature) => feature.group === id).length,
    })),
    hint: 'discover with group "canvas" (or another group) or with a query; describe returns input schemas; execute runs one feature.',
  }
}

/** Read the input schema of one or more features; never returns other features. */
export function describe(features, names) {
  const wanted = (Array.isArray(names) ? names : [names]).filter((name) => typeof name === 'string' && name.trim() !== '')
  if (wanted.length === 0) throw new Error('request.features: provide one or more feature names')
  const unknown = wanted.filter((name) => !features.has(name))
  if (unknown.length > 0) throw new Error(`request.features: unknown feature ${unknown.map((name) => JSON.stringify(name)).join(', ')}`)
  return {
    action: 'describe',
    features: wanted.map((name) => {
      const feature = features.get(name)
      return { feature: name, group: feature.group, description: feature.description, input_schema: feature.parameters }
    }),
  }
}

/**
 * The entry tool's dispatch: discover, describe, or execute one feature.
 * Kept at module scope so it is testable without a Cordis context.
 */
export async function dispatchEntry(features, args, exec) {
  const action = typeof args?.action === 'string' ? args.action : ''
  if (action === 'discover') return discover(features, args.query, args.group)
  if (action === 'describe') return describe(features, args.features ?? args.feature)
  if (action === 'execute') {
    const feature = typeof args.feature === 'string' ? args.feature.trim() : ''
    if (feature === '') throw new Error('request.feature: required')
    const definition = features.get(feature)
    if (definition === undefined) throw new Error(`request.feature: unknown feature ${JSON.stringify(feature)}`)
    const validated = validateArguments(definition.parameters, args.arguments ?? {}, 'arguments')
    return await definition.execute(validated, exec)
  }
  throw new Error(`request.action: expected "discover", "describe", or "execute" (received ${JSON.stringify(args?.action ?? null)})`)
}

/**
 * Validate execute arguments against one feature's parameter schema. Fails
 * closed on unknown keys, so a typo is named instead of silently ignored.
 */
export function validateArguments(schema, value, path = 'arguments') {
  const input = value ?? {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path}: expected an object`)
  const properties = schema?.properties ?? {}
  const required = Array.isArray(schema?.required) ? schema.required : []
  for (const name of required) {
    if (input[name] === undefined) throw new Error(`${path}.${name}: required`)
  }
  if (schema?.additionalProperties === false) {
    for (const name of Object.keys(input)) {
      if (properties[name] === undefined) throw new Error(`${path}.${name}: not a declared argument`)
    }
  }
  for (const [name, spec] of Object.entries(properties)) {
    if (input[name] === undefined) continue
    checkArgument(spec, input[name], `${path}.${name}`)
  }
  return input
}

function checkArgument(spec, value, path) {
  if (Array.isArray(spec?.enum) && !spec.enum.includes(value)) {
    throw new Error(`${path}: expected one of ${spec.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  const type = spec?.type
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path}: expected a string`)
    return
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path}: expected a number`)
    return
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path}: expected a boolean`)
    return
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path}: expected an array`)
    if (spec?.items?.type === 'string') {
      for (const [index, entry] of value.entries()) {
        if (typeof entry !== 'string') throw new Error(`${path}[${index}]: expected a string`)
      }
    }
    return
  }
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`)
  }
}

/** One node's inputs, with every combo paged to NODE_OPTION_PAGE values. */
function nodeInputs(definition, offset) {
  const required = definition?.input?.required ?? {}
  const optional = definition?.input?.optional ?? {}
  const ordered = [
    ...(Array.isArray(definition?.input_order?.required) ? definition.input_order.required : Object.keys(required)),
    ...(Array.isArray(definition?.input_order?.optional) ? definition.input_order.optional : Object.keys(optional)),
  ]
  const seen = new Set()
  const inputs = []
  for (const name of ordered) {
    if (seen.has(name)) continue
    seen.add(name)
    const inRequired = required[name] !== undefined
    const spec = inRequired ? required[name] : optional[name]
    if (spec === undefined) continue
    const input = { name, required: inRequired }
    if (Array.isArray(spec)) {
      const [type, options] = spec
      if (Array.isArray(type) || type === 'COMBO') {
        const values = Array.isArray(type) ? type : Array.isArray(options?.options) ? options.options : []
        input.type = 'COMBO'
        input.options = values.slice(offset, offset + NODE_OPTION_PAGE)
        input.optionsTotal = values.length
        input.optionsTruncated = offset + NODE_OPTION_PAGE < values.length
      } else {
        input.type = typeof type === 'string' ? type : 'UNKNOWN'
        if (options?.default !== undefined) input.default = options.default
        for (const key of ['min', 'max', 'step']) {
          if (options?.[key] !== undefined) input[key] = options[key]
        }
      }
      if (typeof options?.tooltip === 'string' && options.tooltip !== '') input.tooltip = options.tooltip
    } else {
      input.type = typeof spec === 'string' ? spec : 'UNKNOWN'
    }
    inputs.push(input)
  }
  return inputs
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
export function registerTools({ ctx, store, comfy, config, log, runManager, diagnostics, register, activate, modelCatalog, nodeCatalog, workflowIndex }) {
  const rawRegister = typeof register === 'function'
    ? register
    : (definition) => ctx.effect(() => ctx.tools.register(definition), `comfy-cowork: ${definition.name}`)

  /** Every tool runs against the ComfyUI address this chat's workspace saved. */
  /**
   * Features are collected here, not registered one by one: the agent sees one
   * entry tool (`comfy_coworking`) whose discover/describe/execute actions walk
   * this table, so the request's tool list never changes when capabilities are
   * added. Each stored execute first points the client at the session's
   * workspace address, exactly like the flat tools used to.
   */
  const features = new Map()
  const registerTool = (definition) => {
    const name = String(definition.name).replace(/^comfy_coworking_/, '')
    const meta = FEATURE_META[name] ?? { group: 'misc', aliases: [] }
    features.set(name, {
      ...definition,
      name,
      group: meta.group,
      aliases: meta.aliases ?? [],
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
  }

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
    description: [
      'List every workflow this workspace can open, with the file path of each entry.',
      'Sources: "comfyui" is the server\'s own userdata/workflows; "project" is the comfy skill\'s project convention (fragments/*.json and blueprints/*.compiled.json); "workspace" is what this plugin saved under .comfy-cowork/workflows.',
      'Pass an id to comfy_coworking_load_workflow to open one on the canvas.',
    ].join(' '),
    parameters: objectSchema({
      source: { type: 'string', enum: ['comfyui', 'project', 'workspace'], description: 'Only list entries from this source.' },
    }),
    output: {
      schema: objectSchema({
        workflows: { type: 'array', items: { type: 'object' } },
        updatedAt: { type: 'number' },
        stale: { type: 'boolean' },
        error: { type: 'string' },
      }, ['workflows']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const root = store.resolveRoot(sessionId)
      const index = await workflowIndex.build(root, comfy)
      const source = typeof args.source === 'string' ? args.source.trim() : ''
      const workflows = source === '' ? index.entries : index.entries.filter((entry) => entry.source === source)
      return { workflows, updatedAt: index.updatedAt, stale: index.stale, error: index.error }
    },
  })

  registerTool({
    name: 'comfy_coworking_load_workflow',
    description: 'Load one workflow from the index into the shared canvas, replacing the currently loaded one. Pass the id from comfy_coworking_list_workflows (a bare ComfyUI file name also works). Returns node titles and the input bindings the run will inject.',
    parameters: objectSchema({
      id: { type: 'string', description: 'Entry id from comfy_coworking_list_workflows, for example comfyui:workflows/moss_template.json.' },
      name: { type: 'string', description: 'Legacy alias for a ComfyUI userdata workflow file name.' },
    }),
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
      const root = store.resolveRoot(sessionId)
      const wanted = typeof args.id === 'string' && args.id.trim() !== '' ? args.id : args.name
      const index = await workflowIndex.build(root, comfy)
      const entry = workflowIndex.find(index, wanted)
      if (entry === null) throw new Error(`no workflow matches ${JSON.stringify(wanted ?? '')}; call comfy_coworking_list_workflows for ids`)
      const workflow = await workflowIndex.load(root, comfy, entry)
      const nodes = Array.isArray(workflow?.nodes)
        ? workflow.nodes.map((node) => ({ id: node.id, type: node.type, title: node.title ?? null }))
        : []
      let bindings = {}
      try {
        bindings = inferBindings(workflow, await comfy.objectInfo())
      } catch {}
      const doc = await store.setWorkflow(sessionId, {
        name: entry.name,
        json: workflow,
        bindings,
        dirty: false,
      }, { source: 'agent' })
      return { rev: doc.rev, name: doc.workflow.name, nodes, bindings: doc.workflow.bindings }
    },
  })

  registerTool({
    name: 'comfy_coworking_save_workflow',
    description: 'Save the loaded workflow (or a workflow JSON you pass) as a file this workspace can reopen. By default it is written to .comfy-cowork/workflows; target "comfyui" saves it into ComfyUI\'s own userdata/workflows instead.',
    parameters: objectSchema({
      name: { type: 'string', description: 'File name for the saved workflow, for example my_moss_flow.json.' },
      json: { type: 'object', description: 'Workflow body to save; omit to save the workflow currently loaded on the canvas.' },
      target: { type: 'string', enum: ['workspace', 'comfyui'], description: 'Where to write it; default workspace.' },
    }, ['name']),
    output: {
      schema: objectSchema({ id: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' }, path: { type: 'string' } }, ['id']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const root = store.resolveRoot(sessionId)
      let body = args.json
      if (body === undefined || body === null) {
        const doc = await store.snapshot(sessionId)
        body = doc?.workflow?.json
      }
      if (body === undefined || body === null || typeof body !== 'object') throw new Error('nothing to save: load a workflow first or pass json')
      const target = args.target === 'comfyui' ? 'comfyui' : 'workspace'
      const result = await workflowIndex.save(root, comfy, args.name, body, { target })
      if (result.entry === null || result.entry === undefined) throw new Error('the workflow was written but the index could not find it')
      return { id: result.entry.id, name: result.entry.name, source: result.entry.source, path: result.entry.path }
    },
  })

  registerTool({
    name: 'comfy_coworking_list_models',
    description: [
      'Browse the model files ComfyUI can load, like ls. No arguments lists the model folders (checkpoints, loras, vae, diffusion_models, text_encoders, upscale_models, ...) with their file counts.',
      'One folder reads its file names. A file name is exactly what a loader widget takes: use it as-is (for example "Illustrious/model.safetensors"), with no folder prefix and no absolute path.',
      'The list is cached until the refresh feature rebuilds it; nothing expires on a timer.',
    ].join(' '),
    parameters: objectSchema({
      folder: { type: 'string', description: 'Omit to list folders; supply one folder name to list the files inside it.' },
      query: { type: 'string', description: 'Only files whose path contains this text.' },
      offset: { type: 'number', description: 'Skip this many files; use it with limit to page a long folder.' },
      limit: { type: 'number', description: 'Page size, default 200, maximum 1000.' },
    }),
    output: {
      schema: objectSchema({
        folders: { type: 'array', items: { type: 'object' } },
        folder: { type: 'string' },
        total: { type: 'number' },
        files: { type: 'array', items: { type: 'string' } },
        offset: { type: 'number' },
        truncated: { type: 'boolean' },
        updatedAt: { type: 'number' },
        error: { type: 'string' },
      }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const root = store.resolveRoot(sessionId)
      const { snapshot } = await modelCatalog.ensure(root, comfy)
      const error = modelCatalog.errors.get(root) ?? ''
      if (typeof args.folder === 'string' && args.folder.trim() !== '') {
        const page = modelCatalog.files(snapshot, args.folder.trim(), {
          query: args.query ?? '',
          offset: Number(args.offset ?? 0),
          limit: Number(args.limit ?? 200),
        })
        return { folders: [], ...page, updatedAt: snapshot.updatedAt, error }
      }
      return {
        folders: modelCatalog.folders(snapshot),
        folder: '',
        total: 0,
        files: [],
        offset: 0,
        truncated: false,
        updatedAt: snapshot.updatedAt,
        error,
      }
    },
  })

  registerTool({
    name: 'comfy_coworking_refresh',
    description: 'Rebuild the cached model folders and node tree from ComfyUI. Call it after installing, deleting, or moving models or custom nodes; nothing refreshes on a timer.',
    parameters: objectSchema(),
    output: {
      schema: objectSchema({ updatedAt: { type: 'number' }, models: { type: 'object' }, nodes: { type: 'number' } }, ['updatedAt']),
      render: (_args, value) => textOutput(value),
    },
    async execute(_args, exec) {
      const sessionId = sessionIdOf(exec)
      const root = store.resolveRoot(sessionId)
      const [models, nodes] = await Promise.all([
        modelCatalog.refresh(root, comfy),
        nodeCatalog.refresh(root, comfy),
      ])
      const folders = Object.keys(models.folders).length
      const files = Object.values(models.folders).reduce((sum, list) => sum + list.length, 0)
      return { updatedAt: Date.now(), models: { folders, files }, nodes: nodes.tree?.count ?? 0 }
    },
  })

  registerTool({
    name: 'comfy_coworking_list_nodes',
    description: [
      'Browse the node types this ComfyUI installs as the same tree its own node palette shows. Every node carries a category path, so walk it: no arguments lists the top-level categories with counts, a category lists its subcategories and the nodes filed directly under it, and a deeper category reaches the leaves (for example "KJNodes" then "KJNodes/masking").',
      'Or pass a query to search type, display name, category, and description. It never returns input schemas: use node_info for one node\'s inputs, and remember the cache only changes when the refresh feature rebuilds it.',
    ].join(' '),
    parameters: objectSchema({
      category: { type: 'string', description: 'Category path to open, for example "KJNodes" or "KJNodes/masking". Omit to list the top level.' },
      query: { type: 'string', description: 'Case-insensitive text to match against type, display name, category, and description.' },
      offset: { type: 'number', description: 'Skip this many matches; use it with limit to page a search.' },
      limit: { type: 'number', description: 'Page size, default 200 for a category and 100 for a search, maximum 500.' },
    }),
    output: {
      schema: objectSchema({
        total: { type: 'number' },
        category: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
        categories: { type: 'array', items: { type: 'object' } },
        subcategories: { type: 'array', items: { type: 'object' } },
        offset: { type: 'number' },
        truncated: { type: 'boolean' },
        updatedAt: { type: 'number' },
        error: { type: 'string' },
      }),
      render: (_args, value) => textOutput(value),
    },
    async execute(args, exec) {
      const sessionId = sessionIdOf(exec)
      const root = store.resolveRoot(sessionId)
      const { snapshot } = await nodeCatalog.ensure(root, comfy)
      const error = nodeCatalog.errors.get(root) ?? ''
      const updatedAt = snapshot.updatedAt
      const empty = { total: 0, category: '', nodes: [], categories: [], subcategories: [], offset: 0, truncated: false }
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query !== '') {
        const page = nodeCatalog.list(snapshot, {
          query,
          offset: Number(args.offset ?? 0),
          limit: Number(args.limit ?? 100),
        })
        return { ...empty, ...page, updatedAt, error }
      }
      const category = cleanCategory(args.category)
      if (category !== '') {
        const limit = Math.min(Math.max(Math.floor(Number(args.limit ?? 200) || 200), 1), 500)
        const nodes = nodeCatalog.inCategory(snapshot, category)
        return {
          ...empty,
          total: nodeCatalog.subtreeSize(snapshot, category),
          category,
          nodes: nodes.slice(0, limit),
          subcategories: nodeCatalog.categories(snapshot, category),
          truncated: nodes.length > limit,
          updatedAt,
          error,
        }
      }
      return {
        ...empty,
        total: nodeCatalog.subtreeSize(snapshot, ''),
        categories: nodeCatalog.categories(snapshot),
        updatedAt,
        error,
      }
    },
  })

  registerTool({
    name: 'comfy_coworking_node_info',
    description: [
      'Read the exact definition of one or more ComfyUI node types straight from the server: every input with its type, defaults, ranges, tooltips, the values a dropdown accepts, and the node outputs.',
      'Use it for the node types a workflow already carries. Each dropdown is paged at 100 values; pass option_offset to read the next page. Model file lists are also in list_models.',
    ].join(' '),
    parameters: objectSchema({
      types: { type: 'array', items: { type: 'string' }, description: 'Node types to read, for example ["MOSSImageLayoutPrompt"].' },
      option_offset: { type: 'number', description: 'Skip this many values inside every dropdown before returning 100, for pagination.' },
    }, ['types']),
    output: {
      schema: objectSchema({
        option_offset: { type: 'number' },
        option_limit: { type: 'number' },
        nodes: { type: 'array', items: { type: 'object' } },
      }, ['nodes']),
      render: (_args, value) => textOutput(value),
    },
    async execute(args) {
      const types = Array.isArray(args.types)
        ? [...new Set(args.types.filter((value) => typeof value === 'string' && value.trim() !== '').map((value) => value.trim()))]
        : []
      if (types.length === 0) throw new Error('arguments.types: provide one or more node types')
      if (types.length > 20) throw new Error('arguments.types: at most 20 node types per call')
      const offset = Number.isFinite(args.option_offset) && args.option_offset > 0 ? Math.floor(args.option_offset) : 0
      const data = await comfy.nodeInfo(types)
      return {
        option_offset: offset,
        option_limit: NODE_OPTION_PAGE,
        nodes: types.map((type) => {
          const definition = data[type]
          if (definition === undefined) return { type, found: false }
          return {
            type,
            found: true,
            display: definition.display_name ?? type,
            category: definition.category ?? '',
            description: definition.description ?? '',
            inputs: nodeInputs(definition, offset),
            outputs: Array.isArray(definition.output) ? definition.output : [],
          }
        }),
      }
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

  /**
   * The single tool the agent sees. Everything above is a feature behind it:
   * the request carries one fixed schema, and a feature's arguments are read
   * with `describe` only when the model needs them.
   */
  rawRegister({
    name: 'comfy_coworking',
    description: [
      'One entry for the Comfy coworking canvas: discover what it can do, describe the exact arguments of one or more features, then execute one.',
      'Start with action "discover" and no other argument to list the feature groups; add group or query to narrow it; describe returns input schemas; execute runs a feature with arguments. Known features need no discovery.',
      'It covers the canvas (prompt, layout boxes, mask, comments, image), workflow binding and saving, ComfyUI runs, and the model/node catalogs.',
    ].join(' '),
    parameters: objectSchema({
      action: { type: 'string', enum: ['discover', 'describe', 'execute'], description: 'What to do: list or find features, read their input schemas, or run one.' },
      group: { type: 'string', description: 'discover: expand one group, for example "canvas", "workflow", "runs", "catalog", "misc".' },
      query: { type: 'string', description: 'discover: case-insensitive text matched against feature names, aliases (English and Chinese), and descriptions.' },
      features: { type: 'array', items: { type: 'string' }, description: 'describe: one or more feature names to read the input schemas of.' },
      feature: { type: 'string', description: 'execute: the feature name to run.' },
      arguments: { type: 'object', additionalProperties: true, description: 'execute: the arguments object for the feature, shaped by its describe output.' },
    }, ['action']),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => textOutput(value),
    },
    timeoutMs: 150_000,
    execute: (args, exec) => dispatchEntry(features, args, exec),
  })

  // The canvas prompt section lives in lib/plugin.js; this section carries the
  // comment workflow guidance so it reaches the model's system prompt too.
  if (typeof ctx.systemPrompt?.section === 'function') {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'comfy-cowork-comments',
      order: 621,
      text: 'Comfy canvas comments: users draw annotation boxes on the image with feedback such as "这个图不行 这里细节不好". Use comfy_coworking with action "execute", feature "comments", arguments {"action":"list"} to read them, then read each comment crop image with the image-reading tool and fix the canvas image accordingly. Comments you add are automatically marked source "agent"; never silently rewrite the user\'s text.',
    }), 'comfy-cowork: comments system prompt')
  }

  // Kept for a future run tool; surfaces the current layout errors to the agent.
  void layoutErrors
  void errorMessage
  void log
}
