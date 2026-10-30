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
  const routes = createRoutes({ ctx, config, store, comfy, runManager })
  ctx.effect(() => () => runManager.dispose(), 'comfy-coworking: runs')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: routes.handle,
  }), 'comfy-coworking: http routes')

  registerTools({ ctx, store, comfy, config, log, runManager, diagnostics: routes.diagnostics })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'comfy-coworking',
    order: 620,
    text: [
      'Comfy canvas: this session has a shared image/layout canvas next to the chat.',
      'When the user asks you to compose, edit, or generate an image with it, write the prompt with comfy_coworking_set_prompt or comfy_coworking_set_layout so it appears in the canvas prompt box; do not leave the only copy in chat.',
      'Call comfy_coworking_state before changing coordinates or captions. Use comfy_coworking_open_canvas when the user should see the canvas.',
    ].join(' '),
  }), 'comfy-coworking: system prompt section')

  log(`mounted at ${ROUTE_PREFIX} (ComfyUI ${config.baseUrl})`)
  return () => routes.close()
}
