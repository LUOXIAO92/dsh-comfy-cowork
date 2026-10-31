/** Configuration and small shared helpers for the Comfy Coworking Host half. */

export const ROUTE_PREFIX = '/api/comfy-cowork'

export const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8188',
  requestTimeoutMs: 60_000,
  uploadTimeoutMs: 120_000,
  allowAgentRun: true,
  storageDirName: '.comfy-cowork',
  maxAssetBytes: 96 * 1024 * 1024,
  maxPromptChars: 200_000,
  /** How long a model snapshot stays fresh before a refresh is due. */
  modelCacheTtlMs: 10 * 60_000,
}

/**
 * Accept an http(s) address or reject it. Returns the normalized form (no
 * trailing slash) or null, so callers can distinguish "not set" from "invalid".
 */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return trimmed
}

export function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  config.baseUrl = normalizeBaseUrl(config.baseUrl) ?? DEFAULTS.baseUrl
  for (const key of ['requestTimeoutMs', 'uploadTimeoutMs', 'maxAssetBytes', 'maxPromptChars']) {
    const value = Number(config[key])
    config[key] = Number.isFinite(value) && value > 0 ? value : DEFAULTS[key]
  }
  if (typeof config.storageDirName !== 'string' || /[\\/]/.test(config.storageDirName) || config.storageDirName.trim() === '') {
    config.storageDirName = DEFAULTS.storageDirName
  }
  config.allowAgentRun = config.allowAgentRun !== false
  return config
}

export function isSessionId(value) {
  if (typeof value !== 'string') return false
  // A missing session reaches the host as these literals through URL building;
  // accepting them would silently create a document for a session that is not real.
  if (value === 'undefined' || value === 'null') return false
  return /^[A-Za-z0-9._-]{1,200}$/.test(value)
}

export function isAssetName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value)
}

export function jsonResponse(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
