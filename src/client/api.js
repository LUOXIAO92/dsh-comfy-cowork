const BASE = '/api/comfy-coworking'
const SESSION_ID = /^[A-Za-z0-9._-]{1,200}$/

/**
 * A session id the host accepts. The right sidebar can hand a tab a missing
 * session (a pane not bound to a chat yet), and a request carrying `null`
 * would only surface as an opaque rejection, so every session-scoped call
 * fails locally with a message the panel can show instead.
 */
function requireSession(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new Error('canvas is not bound to a session yet; open it from a chat')
  }
  return sessionId
}

function sessionQuery(sessionId) {
  return `session=${encodeURIComponent(requireSession(sessionId))}`
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let body = null
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    body = null
  }
  if (!response.ok) {
    const message = body?.error ?? `request failed (${response.status})`
    throw new Error(`${message} [${path}]`)
  }
  return body
}

export function getDoc(sessionId) {
  return request(`/doc?${sessionQuery(sessionId)}`)
}

export function savePrompt(sessionId, prompt, manual = true) {
  return request('/doc/prompt', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), prompt, manual, source: 'user' }),
  })
}

export function saveLayout(sessionId, summary, items) {
  return request('/doc/layout', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), summary, items, source: 'user' }),
  })
}

export function saveCanvas(sessionId, patch) {
  return request('/doc/canvas', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), ...patch, source: 'user' }),
  })
}

export function saveSelection(sessionId, selection) {
  return request('/doc/selection', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), selection, source: 'user' }),
  })
}

export function saveWorkflow(sessionId, workflow) {
  return request('/doc/workflow', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), workflow, source: 'user' }),
  })
}

export function patchWorkflow(sessionId, patch) {
  return request('/doc/workflow/patch', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), patch, source: 'user' }),
  })
}

export function upsertBox(sessionId, box) {
  return request('/doc/box', {
    method: 'PUT',
    body: JSON.stringify({ sessionId: requireSession(sessionId), box, source: 'user' }),
  })
}

export function deleteBox(sessionId, id) {
  return request(`/doc/box/${encodeURIComponent(id)}?${sessionQuery(sessionId)}`, {
    method: 'DELETE',
  })
}

export function notify(sessionId, text, kind = 'info') {
  return request('/doc/notify', {
    method: 'POST',
    body: JSON.stringify({ sessionId: requireSession(sessionId), text, kind }),
  })
}

export function health() {
  return request('/health')
}

export function listWorkflows() {
  return request('/workflows')
}

export function readWorkflow(name) {
  return request(`/workflows/${encodeURIComponent(name)}`)
}

export function loadWorkflowFile(sessionId, name) {
  return request('/workflows/load', {
    method: 'POST',
    body: JSON.stringify({ sessionId: requireSession(sessionId), name }),
  })
}

export function saveWorkflowFile(sessionId, name, workflow) {
  return request('/workflows/save', {
    method: 'POST',
    body: JSON.stringify({ sessionId: requireSession(sessionId), name, workflow }),
  })
}

export function runWorkflow(sessionId, payload = {}) {
  return request('/run', {
    method: 'POST',
    body: JSON.stringify({ sessionId: requireSession(sessionId), ...payload }),
  })
}

export function interruptRun(sessionId, runId) {
  return request(`/run/${encodeURIComponent(runId)}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: requireSession(sessionId) }),
  })
}

export function listModels(folder) {
  return folder ? request(`/models/${encodeURIComponent(folder)}`) : request('/models')
}

export function objectInfo(classes) {
  return request(`/object_info?classes=${encodeURIComponent((classes ?? []).join(','))}`)
}

export async function uploadAsset(sessionId, name, blob) {
  const response = await fetch(`${BASE}/asset?${sessionQuery(sessionId)}&name=${encodeURIComponent(name)}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': blob.type || 'image/png' },
    body: blob,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text || `asset upload failed (${response.status})`)
  return text === '' ? null : JSON.parse(text)
}

export async function deleteAsset(sessionId, name) {
  await fetch(`${BASE}/asset?${sessionQuery(sessionId)}&name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
}

export function assetUrl(sessionId, name, version = '') {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return ''
  const params = new URLSearchParams({ session: sessionId, name })
  if (version) params.set('v', String(version))
  return `${BASE}/asset?${params.toString()}`
}

export function eventUrl(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return ''
  return `${BASE}/events?${sessionQuery(sessionId)}`
}
