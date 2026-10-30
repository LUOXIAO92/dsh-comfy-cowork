/** Host half wiring: routes, tools, and the shared document store. */

import { ComfyClient } from './comfy.js'
import { normalizeConfig, ROUTE_PREFIX } from './config.js'
import { createRoutes } from './routes.js'
import { DocStore } from './store.js'
import { RunManager } from './run.js'
import { registerTools } from './tools.js'

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const log = typeof ctx.logger?.info === 'function'
    ? (...args) => ctx.logger.info('[comfy-coworking]', ...args)
    : () => {}
  const store = new DocStore(ctx, config)
  const comfy = new ComfyClient(config, ctx.logger)
  const runManager = new RunManager({ ctx, store, comfy, config })
  const hooks = {}
  const routes = createRoutes({ ctx, config, store, comfy, runManager, hooks })
  ctx.effect(() => () => runManager.dispose(), 'comfy-coworking: runs')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: routes.handle,
  }), 'comfy-coworking: http routes')

  // The plugin is dormant until a session turns it on (opening the canvas from
  // that chat). Tools and the prompt section are injected into that session's
  // agent scope only, so other chats never see them.
  const PROMPT_TEXT = [
    'Comfy canvas: this session has a shared image/layout canvas next to the chat.',
    'When the user asks you to compose, edit, or generate an image with it, write the prompt with comfy_coworking_set_prompt or comfy_coworking_set_layout so it appears in the canvas prompt box; do not leave the only copy in chat.',
    'Call comfy_coworking_state before changing coordinates or captions. Use comfy_coworking_open_canvas when the user should see the canvas; if the tab does not appear, ask them to click Canvas in the composer.',
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
        })
        scope.systemPrompt.section({ name: 'comfy-coworking', order: 620, text: PROMPT_TEXT })
      })
      attachments.set(sessionId, fiber)
      return true
    } catch (error) {
      log(`could not scope the canvas tools to ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  async function syncSession(sessionId) {
    let enabled = false
    try {
      const doc = await store.snapshot(sessionId)
      enabled = doc?.enabled === true
    } catch {}
    if (enabled) attach(sessionId)
    else detach(sessionId)
  }

  ctx.effect(() => () => {
    for (const sessionId of [...attachments.keys()]) detach(sessionId)
  }, 'comfy-coworking: scoped tools')

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

  hooks.onEnabledChange = async (sessionId, enabled) => {
    if (enabled) attach(sessionId)
    else detach(sessionId)
  }

  // The manual way in: `/dsh-comfy-coworks` in a chat turns the canvas on for
  // exactly that chat and asks the browser to show the tab. It is the only
  // command the plugin contributes, so the rest of the harness stays untouched.
  ctx.effect(() => ctx.commands.register({
    name: 'dsh-comfy-coworks',
    description: 'Open the Comfy canvas here and give this chat the canvas tools',
    handler: async (invocation) => {
      const sessionId = invocation.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { kind: 'error', text: 'comfy-coworking: no chat session owns this command' }
      }
      try {
        await store.setEnabled(sessionId, true, { source: 'user' })
        attach(sessionId)
        await store.requestOpen(sessionId, { source: 'user' })
        return { kind: 'success', text: 'Comfy canvas opened. Its tools are on for this chat only.' }
      } catch (error) {
        return { kind: 'error', text: `comfy-coworking: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }), 'comfy-coworking: canvas command')

  log(`mounted at ${ROUTE_PREFIX} (ComfyUI ${config.baseUrl})`)
  return () => routes.close()
}
