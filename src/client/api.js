const BASE = '/api/comfy-coworking'

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
  return request(`/doc?session=${encodeURIComponent(sessionId)}`)
}

export function savePrompt(sessionId, prompt, manual = true) {
  return request('/doc/prompt', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, prompt, manual, source: 'user' }),
  })
}

export function saveLayout(sessionId, summary, items) {
  return request('/doc/layout', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, summary, items, source: 'user' }),
  })
}

export function saveCanvas(sessionId, patch) {
  return request('/doc/canvas', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, ...patch, source: 'user' }),
  })
}

export function saveSelection(sessionId, selection) {
  return request('/doc/selection', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, selection, source: 'user' }),
  })
}

export function saveWorkflow(sessionId, workflow) {
  return request('/doc/workflow', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, workflow, source: 'user' }),
  })
}

export function patchWorkflow(sessionId, patch) {
  return request('/doc/workflow/patch', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, patch, source: 'user' }),
  })
}

export function upsertBox(sessionId, box) {
  return request('/doc/box', {
    method: 'PUT',
    body: JSON.stringify({ sessionId, box, source: 'user' }),
  })
}

export function deleteBox(sessionId, id) {
  return request(`/doc/box/${encodeURIComponent(id)}?session=${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

export function notify(sessionId, text, kind = 'info') {
  return request('/doc/notify', {
    method: 'POST',
    body: JSON.stringify({ sessionId, text, kind }),
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
    body: JSON.stringify({ sessionId, name }),
  })
}

export function saveWorkflowFile(sessionId, name, workflow) {
  return request('/workflows/save', {
    method: 'POST',
    body: JSON.stringify({ sessionId, name, workflow }),
  })
}

export function runWorkflow(sessionId, payload = {}) {
  return request('/run', {
    method: 'POST',
    body: JSON.stringify({ sessionId, ...payload }),
  })
}

export function interruptRun(sessionId, runId) {
  return request(`/run/${encodeURIComponent(runId)}/interrupt`, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export function listModels(folder) {
  return folder ? request(`/models/${encodeURIComponent(folder)}`) : request('/models')
}

export function objectInfo(classes) {
  return request(`/object_info?classes=${encodeURIComponent((classes ?? []).join(','))}`)
}

export async function uploadAsset(sessionId, name, blob) {
  const response = await fetch(`${BASE}/asset?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`, {
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
  await fetch(`${BASE}/asset?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
}

export function assetUrl(sessionId, name, version = '') {
  const params = new URLSearchParams({ session: sessionId, name })
  if (version) params.set('v', String(version))
  return `${BASE}/asset?${params.toString()}`
}

export function eventUrl(sessionId) {
  return `${BASE}/events?session=${encodeURIComponent(sessionId)}`
}
