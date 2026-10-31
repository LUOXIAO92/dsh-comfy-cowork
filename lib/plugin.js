/** Host half wiring: routes, tools, and the shared document store. */

import { ComfyClient } from './comfy.js'
import { normalizeConfig, ROUTE_PREFIX } from './config.js'
import { WorkspaceConfig } from './workspace-config.js'
import { ModelCatalog } from './model-catalog.js'
import { WorkflowIndex } from './workflow-index.js'
import { createRoutes } from './routes.js'
import { DocStore } from './store.js'
import { RunManager } from './run.js'
import { registerTools } from './tools.js'

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = typeof ctx.logger?.info === 'function'
    ? (...args) => ctx.logger.info('[comfy-cowork]', ...args)
    : () => {}
  const store = new DocStore(ctx, config)
  const workspaceConfig = new WorkspaceConfig(config)
  const modelCatalog = new ModelCatalog(config)
  const workflowIndex = new WorkflowIndex(config)
  const comfy = new ComfyClient(config, ctx.logger)
  const runHooks = { activate: null }
  const runManager = new RunManager({ ctx, store, comfy, config, activate: (sessionId) => runHooks.activate?.(sessionId) })
  const hooks = {}
  const routes = createRoutes({ ctx, config, store, comfy, runManager, hooks, workspaceConfig, modelCatalog, workflowIndex })
  ctx.effect(() => () => runManager.dispose(), 'comfy-cowork: runs')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: routes.handle,
  }), 'comfy-cowork: http routes')

  // The plugin is dormant until a session turns it on (opening the canvas from
  // that chat). Tools and the prompt section are injected into that session's
  // agent scope only, so other chats never see them.
  const PROMPT_TEXT = [
    'Comfy canvas: this session has a shared image/layout canvas next to the chat.',
    'When the user asks you to compose, edit, or generate an image with it, write the prompt with comfy_coworking_set_prompt or comfy_coworking_set_layout so it appears in the canvas prompt box; do not leave the only copy in chat.',
    'Call comfy_coworking_state before changing coordinates or captions. Use comfy_coworking_open_canvas when the user should see the canvas; if the tab does not appear, ask them to run /dsh-comfy-cowork.',
  ].join(' ')

  const attachments = new Map()

  function detach(sessionId) {
    const fiber = attachments.get(sessionId)
    if (fiber === undefined) return
    attachments.delete(sessionId)
    try {
      Promise.resolve(fiber.dispose()).catch(() => {})
    } catch {}
  }

  function attach(sessionId) {
    if (attachments.has(sessionId)) return true
    const agents = ctx.agents
    const agent = agents?.get?.(sessionId)
    if (agent === undefined || agent === null) return false
    try {
      const fiber = agent.ctx.inject(['tools', 'systemPrompt'], (scope) => {
        registerTools({
          ctx,
          store,
          comfy,
          config,
          log,
          runManager,
          diagnostics: routes.diagnostics,
          register: (definition) => scope.tools.register(definition),
          activate: hooks.activate,
          modelCatalog,
          workflowIndex,
        })
        scope.systemPrompt.section({ name: 'comfy-cowork', order: 620, text: PROMPT_TEXT })
      })
      attachments.set(sessionId, fiber)
      return true
    } catch (error) {
      log(`could not scope the canvas tools to ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Tools follow the pin, not the open tab: a closed canvas keeps them so the
   * request prefix stays byte-identical and the prompt cache survives. Only the
   * explicit unload clears the pin.
   */
  function wantsTools(doc) {
    return doc?.enabled === true || doc?.toolsPinned === true
  }

  async function syncSession(sessionId) {
    let doc = null
    try {
      doc = await store.snapshot(sessionId)
    } catch {}
    if (wantsTools(doc)) attach(sessionId)
    else detach(sessionId)
  }

  ctx.effect(() => () => {
    for (const sessionId of [...attachments.keys()]) detach(sessionId)
  }, 'comfy-cowork: scoped tools')

  ctx.on('agent/created', async ({ agent }) => {
    if (agent === undefined || agent === null || typeof agent.id !== 'string') return
    await syncSession(agent.id)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent !== undefined && agent !== null && typeof agent.id === 'string') attachments.delete(agent.id)
  })

  for (const agent of ctx.agents?.list?.() ?? []) {
    if (typeof agent?.id === 'string') void syncSession(agent.id)
  }

  routes.diagnostics.scopedSessions = () => [...attachments.keys()]

  /**
   * Messages already in the chat. Enabling the tools rewrites the request
   * prefix, so a chat with history asks before paying that cache miss.
   */
  hooks.historyCount = (sessionId) => {
    const session = ctx.sessions?.get?.(sessionId)
    if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return 0
    let count = 0
    for (const event of session.snapshotEvents()) {
      if (event.type === 'user/message' || event.type === 'assistant/message') count += 1
    }
    return count
  }

  /**
   * Point the shared ComfyUI client at the address this workspace stores. The
   * client reads `config.baseUrl` on every call, so switching is a field write.
   */
  hooks.activate = async (sessionId) => {
    let root
    try {
      root = store.resolveRoot(sessionId)
    } catch {
      return config.baseUrl
    }
    if (typeof root !== 'string' || root === '') return config.baseUrl
    const baseUrl = await workspaceConfig.read(root)
    config.baseUrl = baseUrl
    return baseUrl
  }

  runHooks.activate = hooks.activate

  hooks.setBaseUrl = async (sessionId, rawBaseUrl) => {
    const root = store.resolveRoot(sessionId)
    const baseUrl = await workspaceConfig.write(root, rawBaseUrl)
    config.baseUrl = baseUrl
    comfy.objectInfoCache = null
    comfy.objectInfoAt = 0
    // A different server has different models and different saved workflows.
    modelCatalog.clear(root)
    workflowIndex.clear(root)
    return baseUrl
  }

  hooks.sync = async (sessionId, doc) => {
    if (wantsTools(doc)) attach(sessionId)
    else detach(sessionId)
  }

  log(`mounted at ${ROUTE_PREFIX} (ComfyUI ${config.baseUrl})`)
  return () => routes.close()
}
