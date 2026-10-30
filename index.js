import { apply as applyHost } from './lib/plugin.js'

export const inject = ['tools', 'webServer', 'sessions', 'workingDirectory', 'systemPrompt', 'connection', 'agents']

export function apply(ctx, config) {
  return applyHost(ctx, config)
}
