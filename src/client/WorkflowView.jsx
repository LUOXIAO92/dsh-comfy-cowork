import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  assetUrl,
  deleteAsset,
  interruptRun,
  listModels,
  listWorkflows,
  loadWorkflowFile,
  objectInfo,
  patchWorkflow,
  runWorkflow,
  saveCanvas,
  saveWorkflowFile,
  uploadAsset,
} from './api.js'
import {
  comboOptions,
  nodeSize,
  nodeTitle,
  nodeWidgets,
  setNodeWidget,
  workflowBounds,
  workflowLinks,
} from './workflow-ui.js'

function NodeCard({ node, selected, left, top, info, onClick }) {
  const size = nodeSize(node)
  const height = Math.min(180, Math.max(74, size.height))
  const widgets = nodeWidgets(node, info).slice(0, 4)
  return React.createElement('div', {
    className: `ccw-gnode ${selected ? 'is-selected' : ''} ${node.mode === 4 ? 'is-bypassed' : ''} ${node.mode === 2 ? 'is-muted' : ''}`,
    style: { left, top, width: Math.max(150, Math.min(280, size.width)), height },
    onClick: (event) => {
      event.stopPropagation()
      onClick()
    },
  },
  React.createElement('div', { className: 'ccw-gnode-title' }, nodeTitle(node)),
  React.createElement('div', { className: 'ccw-gnode-type' }, node.type),
  React.createElement('div', { className: 'ccw-gnode-widgets' },
    widgets.map((widget) => React.createElement('div', { key: widget.name, className: 'ccw-gnode-widget' },
      React.createElement('span', null, widget.name),
      React.createElement('b', null, formatValue(widget.value))))))
}

function formatValue(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value.length > 34 ? `${value.slice(0, 32)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '…'
}

function Graph({ workflow, infos, selectedId, onSelect, t }) {
  const wrapRef = useRef(null)
  const [view, setView] = useState({ scale: 1, x: 20, y: 20 })
  const gestureRef = useRef(null)
  const bounds = useMemo(() => workflowBounds(workflow), [workflow])
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const links = useMemo(() => workflowLinks(workflow), [workflow])
  const byId = useMemo(() => new Map(nodes.map((node) => [Number(node.id), node])), [nodes])

  function fit() {
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 10 || rect.height < 10) return
    const scale = Math.min((rect.width - 24) / bounds.width, (rect.height - 24) / bounds.height, 1.2)
    setView({
      scale,
      x: (rect.width - bounds.width * scale) / 2,
      y: (rect.height - bounds.height * scale) / 2,
    })
  }

  useEffect(() => {
    fit()
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * 0.0015)
      setView((current) => {
        const nextScale = Math.min(3, Math.max(0.15, current.scale * factor))
        const cx = event.clientX - rect.left
        const cy = event.clientY - rect.top
        const gx = (cx - current.x) / current.scale
        const gy = (cy - current.y) / current.scale
        return { scale: nextScale, x: cx - gx * nextScale, y: cy - gy * nextScale }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return React.createElement('div', {
    className: 'ccw-graph',
    ref: wrapRef,
    onPointerDown: (event) => {
      if (event.target !== event.currentTarget && event.target.closest?.('.ccw-gnode') !== null) return
      gestureRef.current = { x: event.clientX, y: event.clientY, view, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    onPointerMove: (event) => {
      const gesture = gestureRef.current
      if (gesture === null) return
      const dx = event.clientX - gesture.x
      const dy = event.clientY - gesture.y
      if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true
      setView({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy })
    },
    onPointerUp: (event) => {
      const gesture = gestureRef.current
      gestureRef.current = null
      if (gesture !== null && !gesture.moved) onSelect(null)
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {}
    },
  },
  React.createElement('div', {
    className: 'ccw-graph-inner',
    style: {
      width: bounds.width,
      height: bounds.height,
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    },
  },
  React.createElement('svg', { className: 'ccw-graph-links', width: bounds.width, height: bounds.height },
    links.map((link) => {
      const from = byId.get(link.originId)
      const to = byId.get(link.targetId)
      if (from === undefined || to === undefined) return null
      const fs = nodeSize(from)
      const fx = (from.pos?.[0] ?? 0) - bounds.minX + Math.max(150, Math.min(280, fs.width))
      const fy = (from.pos?.[1] ?? 0) - bounds.minY + 38 + link.originSlot * 15
      const tx = (to.pos?.[0] ?? 0) - bounds.minX
      const ty = (to.pos?.[1] ?? 0) - bounds.minY + 38 + link.targetSlot * 15
      const dx = Math.max(30, Math.abs(tx - fx) * 0.45)
      return React.createElement('path', {
        key: link.id,
        d: `M ${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`,
        className: from.mode === 4 ? 'is-bypassed' : '',
      })
    })),
  nodes.map((node) => React.createElement(NodeCard, {
    key: node.id,
    node,
    info: infos[node.type],
    selected: String(selectedId) === String(node.id),
    left: (node.pos?.[0] ?? 0) - bounds.minX,
    top: (node.pos?.[1] ?? 0) - bounds.minY,
    onClick: () => onSelect(node.id),
  }))),
  React.createElement('div', { className: 'ccw-graph-actions' },
    React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: fit }, t('canvas.fit')),
    React.createElement('span', { className: 'ccw-muted' }, `${Math.round(view.scale * 100)}%`)))
}

function WidgetEditor({ node, info, onChange, t }) {
  const widgets = nodeWidgets(node, info)
  if (widgets.length === 0) return React.createElement('p', { className: 'ccw-hint' }, t('workflow.noWidgets'))
  return React.createElement('div', { className: 'ccw-widgets' },
    widgets.map((widget) => {
      const options = comboOptions(widget)
      let control
      if (options.length > 0) {
        control = React.createElement('select', {
          value: String(widget.value ?? ''),
          onChange: (event) => onChange(widget.name, event.target.value),
        },
        options.map((option) => React.createElement('option', { key: String(option), value: String(option) }, String(option))))
      } else if (typeof widget.value === 'boolean') {
        control = React.createElement('input', {
          type: 'checkbox', checked: widget.value,
          onChange: (event) => onChange(widget.name, event.target.checked),
        })
      } else if (typeof widget.value === 'number') {
        const integer = widget.type === 'INT'
        control = React.createElement('input', {
          type: 'number', value: widget.value, step: integer ? 1 : 'any',
          onChange: (event) => {
            const value = Number(event.target.value)
            if (Number.isFinite(value)) onChange(widget.name, integer ? Math.round(value) : value)
          },
        })
      } else if (widget.options?.multiline === true || (typeof widget.value === 'string' && widget.value.length > 70)) {
        control = React.createElement('textarea', {
          rows: 3, value: String(widget.value ?? ''),
          onChange: (event) => onChange(widget.name, event.target.value),
        })
      } else {
        control = React.createElement('input', {
          type: 'text', value: String(widget.value ?? ''),
          onChange: (event) => onChange(widget.name, event.target.value),
        })
      }
      return React.createElement('label', { key: widget.name, className: 'ccw-field ccw-widget-field' },
        React.createElement('span', null, widget.name, React.createElement('em', null, widget.type)),
        control)
    }))
}

function ModelBrowser({ t, setError }) {
  const [folders, setFolders] = useState(null)
  const [folder, setFolder] = useState('')
  const [files, setFiles] = useState([])
  const [copied, setCopied] = useState('')

  useEffect(() => {
    listModels().then((result) => setFolders(result.folders ?? [])).catch((error) => setError(error.message))
  }, [setError])

  useEffect(() => {
    if (folder === '') return
    listModels(folder).then((result) => setFiles(result.files ?? [])).catch((error) => setError(error.message))
  }, [folder, setError])

  return React.createElement('div', { className: 'ccw-model-browser' },
    React.createElement('select', {
      value: folder,
      onChange: (event) => setFolder(event.target.value),
    },
    React.createElement('option', { value: '' }, t('models.folder')),
    (folders ?? []).map((name) => React.createElement('option', { key: name, value: name }, name))),
    React.createElement('div', { className: 'ccw-model-list' },
      files.slice(0, 300).map((file) => React.createElement('button', {
        key: file,
        type: 'button',
        className: `ccw-model-row ${copied === file ? 'is-copied' : ''}`,
        title: file,
        onClick: async () => {
          await navigator.clipboard.writeText(file)
          setCopied(file)
          setTimeout(() => setCopied(''), 900)
        },
      }, file))),
    React.createElement('p', { className: 'ccw-hint' }, t('models.hint')))
}

export function WorkflowView({ sessionId, doc, setDoc, t, setError }) {
  const [workflows, setWorkflows] = useState([])
  const [selectedName, setSelectedName] = useState('')
  const [saveName, setSaveName] = useState('')
  const [workflow, setWorkflow] = useState(doc?.workflow?.json ?? null)
  const [infos, setInfos] = useState({})
  const [selectedNode, setSelectedNode] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [seed, setSeed] = useState('')
  const [showModels, setShowModels] = useState(false)
  const syncKey = useRef('')
  const commitTimer = useRef(null)

  useEffect(() => {
    listWorkflows().then((result) => setWorkflows(result.workflows ?? [])).catch((error) => setError(error.message))
  }, [setError])

  useEffect(() => {
    const incoming = doc?.workflow?.json ?? null
    const key = doc?.workflow === null || doc?.workflow === undefined ? '' : `${doc.workflow.name}|${doc.workflow.loadedAt}`
    if (incoming !== null && key !== '' && key !== syncKey.current) {
      syncKey.current = key
      setWorkflow(incoming)
      setSelectedName(doc.workflow.name ?? '')
      setSaveName(doc.workflow.name ?? '')
      setDirty(doc.workflow.dirty === true)
      setSelectedNode(null)
    }
    if (incoming === null && syncKey.current !== '') {
      syncKey.current = ''
      setWorkflow(null)
      setDirty(false)
    }
  }, [doc])

  const nodeTypes = useMemo(() => {
    const set = new Set()
    for (const node of workflow?.nodes ?? []) if (typeof node.type === 'string') set.add(node.type)
    return [...set]
  }, [workflow])

  useEffect(() => {
    if (nodeTypes.length === 0) return
    objectInfo(nodeTypes).then((result) => setInfos(result.nodes ?? {})).catch((error) => setError(error.message))
  }, [nodeTypes.join('|'), setError])

  useEffect(() => () => {
    if (commitTimer.current !== null) clearTimeout(commitTimer.current)
  }, [])

  function commitLocal(next) {
    setWorkflow(next)
    setDirty(true)
    if (commitTimer.current !== null) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(async () => {
      commitTimer.current = null
      try {
        const result = await patchWorkflow(sessionId, { json: next, dirty: true })
        setDoc(result.doc)
      } catch (error) {
        setError(error.message)
      }
    }, 650)
  }

  async function load(name) {
    if (!name) return
    setBusy(true)
    try {
      const result = await loadWorkflowFile(sessionId, name)
      setDoc(result.doc)
      setSelectedName(name)
      setSaveName(name)
      setError('')
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    if (workflow === null) return
    setBusy(true)
    try {
      const result = await saveWorkflowFile(sessionId, saveName || selectedName, workflow)
      if (result.doc) setDoc(result.doc)
      setDirty(false)
      setError('')
      const listed = await listWorkflows()
      setWorkflows(listed.workflows ?? [])
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function updateBinding(key, value) {
    try {
      const result = await patchWorkflow(sessionId, {
        bindings: { ...(doc?.workflow?.bindings ?? {}), [key]: value },
      })
      setDoc(result.doc)
    } catch (error) {
      setError(error.message)
    }
  }

  async function run() {
    setBusy(true)
    try {
      await runWorkflow(sessionId, { seed: seed === '' ? undefined : Number(seed) })
      setError('')
    } catch (error) {
      setError(error.message)
    } finally {
      setBusy(false)
    }
  }

  async function cancel() {
    const latest = doc?.runs?.[0]
    if (!latest) return
    try {
      await interruptRun(sessionId, latest.id)
    } catch (error) {
      setError(error.message)
    }
  }

  async function useOutput(output) {
    try {
      const response = await fetch(assetUrl(sessionId, output.asset))
      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      await uploadAsset(sessionId, 'canvas.png', blob)
      await uploadAsset(sessionId, 'source.png', blob)
      await deleteAsset(sessionId, 'mask.png')
      await deleteAsset(sessionId, 'canvas_rgba.png')
      const result = await saveCanvas(sessionId, {
        mode: 'image',
        width: bitmap.width,
        height: bitmap.height,
        image: { asset: 'canvas.png', name: output.filename, width: bitmap.width, height: bitmap.height, rev: Date.now() },
      })
      setDoc(result.doc)
    } catch (error) {
      setError(error.message)
    }
  }

  const latestRun = doc?.runs?.[0] ?? null
  const selected = workflow?.nodes?.find((node) => String(node.id) === String(selectedNode)) ?? null
  const bindings = doc?.workflow?.bindings ?? {}

  return React.createElement('section', { className: 'ccw-workflow' },
    React.createElement('div', { className: 'ccw-workflow-bar' },
      React.createElement('select', {
        value: selectedName,
        onChange: (event) => setSelectedName(event.target.value),
        title: t('workflow.pick'),
      },
      React.createElement('option', { value: '' }, t('workflow.pick')),
      workflows.map((entry) => React.createElement('option', { key: entry.path, value: entry.path }, entry.path))),
      React.createElement('button', {
        type: 'button', className: 'ccw-btn', disabled: busy || selectedName === '', onClick: () => load(selectedName),
      }, t('workflow.load')),
      React.createElement('input', {
        className: 'ccw-name', value: saveName, placeholder: t('workflow.name'),
        title: t('workflow.name'), onChange: (event) => setSaveName(event.target.value),
      }),
      React.createElement('button', {
        type: 'button', className: 'ccw-btn', disabled: busy || workflow === null || dirty === false || (saveName || selectedName) === '', onClick: save,
      }, t('workflow.save')),
      React.createElement('button', {
        type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: () => setShowModels((value) => !value),
      }, t('models.open'))),
    showModels ? React.createElement(ModelBrowser, { t, setError }) : null,
    workflow === null
      ? React.createElement('div', { className: 'ccw-workflow-empty' }, t('workflow.empty'))
      : React.createElement(React.Fragment, null,
          React.createElement(Graph, {
            key: doc?.workflow?.loadedAt ?? 'workflow',
            workflow, infos, selectedId: selectedNode, onSelect: setSelectedNode, t,
          }),
          Array.isArray(workflow.nodes) && workflow.nodes.length === 0
            ? React.createElement('p', { className: 'ccw-hint' }, t('workflow.apiOnly'))
            : null,
          selected
            ? React.createElement('div', { className: 'ccw-node-editor' },
                React.createElement('div', { className: 'ccw-panel-head' },
                  React.createElement('h3', null, nodeTitle(selected), React.createElement('span', { className: 'ccw-muted' }, ` #${selected.id} · ${selected.type}`)),
                  React.createElement('button', {
                    type: 'button', className: 'ccw-btn ccw-btn-ghost',
                    onClick: () => setSelectedNode(null),
                  }, '×')),
                React.createElement(WidgetEditor, {
                  node: selected,
                  info: infos[selected.type],
                  t,
                  onChange: (name, value) => commitLocal(setNodeWidget(workflow, selected.id, name, value, infos[selected.type])),
                }))
            : null,
          React.createElement('details', { className: 'ccw-bindings' },
            React.createElement('summary', null, t('workflow.bindings')),
            React.createElement('div', { className: 'ccw-binding-grid' },
              ['prompt', 'image', 'mask', 'width', 'height', 'seed', 'bboxes'].map((key) => React.createElement('label', { key, className: 'ccw-field' },
                React.createElement('span', null, t(`bind.${key}`)),
                React.createElement('select', {
                  value: bindings[key] ?? '',
                  onChange: (event) => updateBinding(key, event.target.value),
                },
                React.createElement('option', { value: '' }, '—'),
                (workflow.nodes ?? []).map((node) => React.createElement('option', {
                  key: node.id, value: String(node.id),
                }, `#${node.id} ${nodeTitle(node)}`))))))),
          React.createElement('div', { className: 'ccw-runbar' },
            React.createElement('label', { className: 'ccw-field ccw-seed' }, t('run.seed'),
              React.createElement('input', {
                type: 'number', value: seed, placeholder: t('run.random'),
                onChange: (event) => setSeed(event.target.value),
              })),
            React.createElement('button', {
              type: 'button', className: 'ccw-btn', disabled: busy, onClick: run,
            }, t('run.start')),
            latestRun && ['queued', 'running'].includes(latestRun.status)
              ? React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: cancel }, t('run.cancel'))
              : null,
            React.createElement('span', { className: 'ccw-muted' }, latestRun ? `${latestRun.status} · ${latestRun.id}` : t('run.none'))),
          latestRun?.error ? React.createElement('div', { className: 'ccw-error' }, latestRun.error) : null,
          latestRun?.notes?.length > 0
            ? React.createElement('div', { className: 'ccw-hint' }, latestRun.notes.join(' · '))
            : null,
          latestRun?.outputs?.length > 0
            ? React.createElement('div', { className: 'ccw-outputs' },
                latestRun.outputs.filter((output) => output.asset).map((output) => React.createElement('div', { key: output.asset, className: 'ccw-output' },
                  String(output.contentType ?? '').startsWith('video/')
                    ? React.createElement('video', { src: assetUrl(sessionId, output.asset), controls: true })
                    : React.createElement('img', { src: assetUrl(sessionId, output.asset), alt: output.filename }),
                  React.createElement('div', { className: 'ccw-row' },
                    React.createElement('span', { className: 'ccw-muted' }, output.filename),
                    React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: () => useOutput(output) }, t('run.use'))))))
            : null))
}
