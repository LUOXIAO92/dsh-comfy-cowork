import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  assetUrl,
  deleteAsset,
  interruptRun,
  listWorkflows,
  loadWorkflowFile,
  objectInfo,
  patchWorkflow,
  runWorkflow,
  saveCanvas,
  saveNegative,
  savePrompt,
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
import { Icon, IconButton, Section } from './ui.jsx'

function formatValue(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value.length > 34 ? `${value.slice(0, 32)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return '…'
}

function formatWidgetType(type) {
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return 'COMBO'
  return ''
}

function NodeCard({ node, selected, left, top, info, onClick, t }) {
  const size = nodeSize(node)
  const height = Math.min(180, Math.max(74, size.height))
  const widgets = nodeWidgets(node, info).slice(0, 4)
  const flag = node.mode === 4
    ? t('workflow.bypass')
    : node.mode === 2 ? t('workflow.mute') : ''
  return (
    <button
      type="button"
      className={`ccw-gnode ${selected ? 'is-selected' : ''} ${node.mode === 4 ? 'is-bypassed' : ''} ${node.mode === 2 ? 'is-muted' : ''}`}
      style={{ left, top, width: Math.max(150, Math.min(280, size.width)), height }}
      aria-pressed={selected}
      title={`${nodeTitle(node)} · ${node.type}`}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <span className="ccw-gnode-head">
        <span className="ccw-gnode-title">{nodeTitle(node)}</span>
        {flag !== '' ? <span className="ccw-gnode-flag">{flag}</span> : null}
      </span>
      <span className="ccw-gnode-type">{node.type}</span>
      <span className="ccw-gnode-widgets">
        {widgets.map((widget) => (
          <span key={widget.name} className="ccw-gnode-widget">
            <span>{widget.name}</span>
            <b>{formatValue(widget.value)}</b>
          </span>
        ))}
      </span>
    </button>
  )
}

function Graph({ workflow, title, infos, selectedId, onSelect, t }) {
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

  function zoomBy(factor) {
    const el = wrapRef.current
    if (!el) return
    touchedRef.current = true
    const rect = el.getBoundingClientRect()
    setView((current) => {
      const nextScale = Math.min(3, Math.max(0.15, current.scale * factor))
      const cx = rect.width / 2
      const cy = rect.height / 2
      const gx = (cx - current.x) / current.scale
      const gy = (cy - current.y) / current.scale
      return { scale: nextScale, x: cx - gx * nextScale, y: cy - gy * nextScale }
    })
  }

  const fitRef = useRef(fit)
  fitRef.current = fit
  const touchedRef = useRef(false)

  // The graph lives inside a pane that is still settling when it mounts, so a
  // one-shot fit frames the wrong box. Refit on resize until the human takes
  // over with a pan or a zoom.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    fitRef.current()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => {
      if (!touchedRef.current) fitRef.current()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      touchedRef.current = true
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

  return (
    <div
      className="ccw-graph"
      ref={wrapRef}
      aria-label={t('workflow.graph')}
      onPointerDown={(event) => {
        if (event.target.closest?.('.ccw-graph-actions, .ccw-graph-hud') !== null) return
        if (event.target !== event.currentTarget && event.target.closest?.('.ccw-gnode') !== null) return
        touchedRef.current = true
        gestureRef.current = { x: event.clientX, y: event.clientY, view, moved: false }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        const gesture = gestureRef.current
        if (gesture === null) return
        const dx = event.clientX - gesture.x
        const dy = event.clientY - gesture.y
        if (Math.abs(dx) + Math.abs(dy) > 2) gesture.moved = true
        setView({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy })
      }}
      onPointerUp={(event) => {
        const gesture = gestureRef.current
        gestureRef.current = null
        if (gesture !== null && !gesture.moved) onSelect(null)
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {}
      }}
    >
      <div
        className="ccw-graph-inner"
        style={{
          width: bounds.width,
          height: bounds.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
      >
        <svg className="ccw-graph-links" width={bounds.width} height={bounds.height}>
          {links.map((link) => {
            const from = byId.get(link.originId)
            const to = byId.get(link.targetId)
            if (from === undefined || to === undefined) return null
            const fs = nodeSize(from)
            const fx = (from.pos?.[0] ?? 0) - bounds.minX + Math.max(150, Math.min(280, fs.width))
            const fy = (from.pos?.[1] ?? 0) - bounds.minY + 38 + link.originSlot * 15
            const tx = (to.pos?.[0] ?? 0) - bounds.minX
            const ty = (to.pos?.[1] ?? 0) - bounds.minY + 38 + link.targetSlot * 15
            const dx = Math.max(30, Math.abs(tx - fx) * 0.45)
            return (
              <path
                key={link.id}
                d={`M ${fx} ${fy} C ${fx + dx} ${fy}, ${tx - dx} ${ty}, ${tx} ${ty}`}
                className={from.mode === 4 ? 'is-bypassed' : ''}
              />
            )
          })}
        </svg>
        {nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            info={infos[node.type]}
            selected={String(selectedId) === String(node.id)}
            left={(node.pos?.[0] ?? 0) - bounds.minX}
            top={(node.pos?.[1] ?? 0) - bounds.minY}
            onClick={() => onSelect(node.id)}
            t={t}
          />
        ))}
      </div>

      <div className="ccw-graph-hud">
        <span>{t('workflow.nodes').replace('{count}', String(nodes.length))}</span>
        <span className="ccw-graph-hud-sep" aria-hidden="true" />
        <span>{t('workflow.links').replace('{count}', String(links.length))}</span>
      </div>

      <div className="ccw-graph-actions" role="toolbar" aria-label={t('workflow.graph')}>
        <span className="ccw-zoom-readout" aria-hidden="true">{Math.round(view.scale * 100)}%</span>
        <IconButton icon="zoomOut" label={t('canvas.zoomOut')} onClick={() => zoomBy(1 / 1.2)} />
        <IconButton icon="zoomIn" label={t('canvas.zoomIn')} onClick={() => zoomBy(1.2)} />
        <IconButton icon="maximize" label={t('canvas.fit')} onClick={() => {
          touchedRef.current = false
          fit()
        }} />
      </div>
    </div>
  )
}

function WidgetEditor({ node, info, onChange, t }) {
  if (info === undefined) {
    return (
      <p className="ccw-hint ccw-widgets-nodinfo">
        <Icon name="alert" size={13} />
        <span>{t('workflow.noNodeInfo').replace('{type}', String(node.type ?? ''))}</span>
      </p>
    )
  }
  const widgets = nodeWidgets(node, info)
  if (widgets.length === 0) {
    return <p className="ccw-hint">{t('workflow.noWidgets')}</p>
  }
  return (
    <div className="ccw-widgets">
      {widgets.map((widget) => {
        const options = comboOptions(widget)
        // A widget the workflow never stored keeps ComfyUI's default and stays
        // read-only: writing it needs positional padding we cannot guarantee.
        const locked = widget.missing === true
        let control
        if (options.length > 0) {
          control = (
            <select
              value={String(widget.value ?? '')}
              onChange={(event) => onChange(widget.name, event.target.value)}
            >
              {options.map((option) => (
                <option key={String(option)} value={String(option)}>{String(option)}</option>
              ))}
            </select>
          )
        } else if (typeof widget.value === 'boolean') {
          control = (
            <input
              type="checkbox"
              checked={widget.value}
              onChange={(event) => onChange(widget.name, event.target.checked)}
            />
          )
        } else if (typeof widget.value === 'number') {
          const integer = widget.type === 'INT'
          control = (
            <input
              type="number"
              value={widget.value}
              step={integer ? 1 : 'any'}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (Number.isFinite(value)) onChange(widget.name, integer ? Math.round(value) : value)
              }}
            />
          )
        } else if (widget.options?.multiline === true || (typeof widget.value === 'string' && widget.value.length > 70)) {
          control = (
            <textarea
              rows={3}
              value={String(widget.value ?? '')}
              onChange={(event) => onChange(widget.name, event.target.value)}
            />
          )
        } else {
          control = (
            <input
              type="text"
              value={String(widget.value ?? '')}
              onChange={(event) => onChange(widget.name, event.target.value)}
            />
          )
        }
        const lockedControl = locked && control !== null
          ? React.cloneElement(control, { disabled: true, title: t('workflow.defaultValue') })
          : control
        return (
          <label key={widget.name} className={`ccw-field ccw-widget-field ${locked ? 'is-default' : ''}`}>
            <span className="ccw-widget-label">
              <span>{widget.name}</span>
              {locked ? <span className="ccw-widget-chip">{t('workflow.defaultValue')}</span> : null}
              <em>{formatWidgetType(widget.type)}</em>
            </span>
            {lockedControl}
          </label>
        )
      })}
    </div>
  )
}

function NodeEditor({ node, info, onChange, onTitle, onToggleMode, t }) {
  return (
    <div className="ccw-node-editor">
      <div className="ccw-node-meta">
        <span className="ccw-node-id">#{node.id}</span>
        <span className="ccw-node-type">{node.type}</span>
      </div>
      <input
        className="ccw-node-title-input"
        value={node.title ?? ''}
        placeholder={t('workflow.title')}
        title={t('workflow.title')}
        aria-label={t('workflow.title')}
        onChange={(event) => onTitle(event.target.value)}
      />
      <div className="ccw-node-mode-row">
        <button
          type="button"
          className={`ccw-chip-toggle ${node.mode === 4 ? 'is-active' : ''}`}
          aria-pressed={node.mode === 4}
          onClick={() => onToggleMode(4)}
        >
          <Icon name="circleSlash" size={14} />
          <span>{t('workflow.bypass')}</span>
        </button>
        <button
          type="button"
          className={`ccw-chip-toggle ${node.mode === 2 ? 'is-active' : ''}`}
          aria-pressed={node.mode === 2}
          onClick={() => onToggleMode(2)}
        >
          <Icon name="eyeOff" size={14} />
          <span>{t('workflow.mute')}</span>
        </button>
      </div>
      <WidgetEditor node={node} info={info} onChange={onChange} t={t} />
    </div>
  )
}

function runTone(status) {
  if (status === 'completed' || status === 'success') return 'is-ok'
  if (status === 'failed' || status === 'error') return 'is-error'
  if (status === 'running' || status === 'queued') return 'is-live'
  return ''
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
  const [graphHeight, setGraphHeight] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('ccw.graphHeight'))
      return Number.isFinite(stored) && stored >= 200 ? stored : null
    } catch {
      return null
    }
  })
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

  function setNodeField(nodeId, patch) {
    const next = JSON.parse(JSON.stringify(workflow))
    const node = (next.nodes ?? []).find((entry) => String(entry.id) === String(nodeId))
    if (node === undefined) return
    Object.assign(node, patch)
    commitLocal(next)
  }

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

  async function save(name = saveName || selectedName) {
    if (workflow === null || !name) return
    setBusy(true)
    try {
      const result = await saveWorkflowFile(sessionId, name, workflow)
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

  /** Save the graph under a new name, typed in a small dialog. */
  async function saveAs() {
    if (workflow === null) return
    const suggested = saveName || selectedName || 'workflow.json'
    const name = window.prompt(t('workflow.saveAsPrompt'), suggested)
    if (name === null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    setSaveName(trimmed)
    await save(trimmed)
  }

  /** Drag the graph band height; remembered per browser. */
  function startGraphResize(event) {
    event.preventDefault()
    const startY = event.clientY
    const graph = event.currentTarget.parentElement?.querySelector('.ccw-graph')
    const startHeight = graphHeight ?? Math.round(graph?.getBoundingClientRect().height ?? 320)
    let last = startHeight
    const move = (moveEvent) => {
      last = Math.max(200, Math.min(900, Math.round(startHeight + (moveEvent.clientY - startY))))
      setGraphHeight(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      try {
        window.localStorage.setItem('ccw.graphHeight', String(last))
      } catch {}
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  /** Keep the canvas prompt boxes and the text node the workflow uses in step. */
  async function syncCanvasText(node, name, value) {
    const bindings = doc?.workflow?.bindings ?? {}
    if (typeof value !== 'string') return
    const isPrompt = String(bindings.prompt ?? '') === String(node.id)
    const isNegative = String(bindings.negative ?? '') === String(node.id)
    if (!isPrompt && !isNegative) return
    if (!['text', 'prompt', 'string', 'value'].includes(name)) return
    try {
      const result = isPrompt ? await savePrompt(sessionId, value, true) : await saveNegative(sessionId, value)
      if (result.doc) setDoc(result.doc)
    } catch (error) {
      setError(error.message)
    }
  }

  async function run() {
    setBusy(true)
    try {
      await runWorkflow(sessionId, {})
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
  const outputs = (latestRun?.outputs ?? []).filter((output) => output.asset)
  const selected = workflow?.nodes?.find((node) => String(node.id) === String(selectedNode)) ?? null

  return (
    <section className="ccw-workflow" aria-label={t('view.workflow')}>
      <div className="ccw-workflow-bar">
        <div className="ccw-workflow-picker">
          <span className="ccw-selector-icon" aria-hidden="true"><Icon name="workflow" size={15} /></span>
          <select
            className="ccw-workflow-select"
            value={selectedName}
            aria-label={t('workflow.pick')}
            title={t('workflow.pick')}
            onChange={(event) => {
              setSelectedName(event.target.value)
              load(event.target.value)
            }}
          >
            <option value="">{t('workflow.pick')}</option>
            {workflows.map((entry) => <option key={entry.path} value={entry.path}>{entry.path}</option>)}
          </select>
        </div>
        <div className="ccw-workflow-file-actions">
          <button
            type="button"
            className="ccw-btn ccw-btn-ghost ccw-btn-small"
            disabled={busy || workflow === null || dirty === false}
            onClick={() => save()}
          >
            <Icon name="save" size={14} />
            <span>{t('workflow.save')}</span>
          </button>
          <button
            type="button"
            className="ccw-btn ccw-btn-ghost ccw-btn-small"
            disabled={busy || workflow === null}
            onClick={saveAs}
          >
            <Icon name="copy" size={14} />
            <span>{t('workflow.saveAs')}</span>
          </button>
        </div>
      </div>

      {workflow === null ? (
        <div className="ccw-workflow-empty">
          <span className="ccw-empty-icon"><Icon name="workflow" size={22} /></span>
          <p>{t('workflow.empty')}</p>
        </div>
      ) : (
        <div className="ccw-workflow-grid">
          <div
            className="ccw-workflow-graph-col"
            aria-label={t('workflow.graph')}
            style={graphHeight === null ? undefined : { '--ccw-graph-height': `${graphHeight}px` }}
          >
            <Graph
              key={doc?.workflow?.loadedAt ?? 'workflow'}
              workflow={workflow}
              title={selectedName || doc?.workflow?.name || t('workflow.graph')}
              infos={infos}
              selectedId={selectedNode}
              onSelect={setSelectedNode}
              t={t}
            />
            {Array.isArray(workflow.nodes) && workflow.nodes.length === 0 ? (
              <p className="ccw-hint">{t('workflow.apiOnly')}</p>
            ) : null}
          </div>

          <div
            className="ccw-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('workflow.resize')}
            title={t('workflow.resize')}
            onPointerDown={startGraphResize}
          />

          <aside className="ccw-workflow-rail" aria-label={t('workflow.settings')}>
            <Section
              title={t('workflow.node')}
              icon="box"
              defaultOpen
              className="ccw-section-node"
              actions={selected !== null ? (
                <IconButton icon="x" label={t('workflow.close')} onClick={() => setSelectedNode(null)} />
              ) : null}
            >
              {selected !== null ? (
                <>
                  <NodeEditor
                    node={selected}
                    info={infos[selected.type]}
                    t={t}
                    onTitle={(value) => setNodeField(selected.id, { title: value })}
                    onToggleMode={(mode) => setNodeField(selected.id, { mode: selected.mode === mode ? 0 : mode })}
                    onChange={(name, value) => {
                      commitLocal(setNodeWidget(workflow, selected.id, name, value, infos[selected.type]))
                      syncCanvasText(selected, name, value)
                    }}
                  />
                </>
              ) : (
                <div className="ccw-rail-empty">
                  <Icon name="pointer" size={16} />
                  <p>{t('workflow.noSelection')}</p>
                </div>
              )}
            </Section>

            <Section title={t('run.section')} icon="play" defaultOpen className="ccw-section-run">
              <div className="ccw-run-controls">
                <button
                  type="button"
                  className="ccw-btn ccw-btn-primary ccw-btn-run"
                  disabled={busy}
                  onClick={run}
                >
                  <Icon name="play" size={15} />
                  <span>{t('run.start')}</span>
                </button>
                {latestRun && ['queued', 'running'].includes(latestRun.status) ? (
                  <button type="button" className="ccw-btn ccw-btn-secondary ccw-btn-small" onClick={cancel}>
                    <Icon name="stop" size={14} />
                    <span>{t('run.cancel')}</span>
                  </button>
                ) : null}
              </div>

              <div className="ccw-run-meta">
                <span className={`ccw-run-state ${latestRun ? runTone(latestRun.status) : ''}`}>
                  <span className="ccw-statusdot" aria-hidden="true" />
                  {latestRun ? latestRun.status : t('run.none')}
                </span>
                {latestRun ? <code title={latestRun.id}>{latestRun.id}</code> : null}
              </div>
              {latestRun?.error ? <div className="ccw-inline-error" role="alert">{latestRun.error}</div> : null}
              {latestRun?.notes?.length > 0 ? <div className="ccw-hint">{latestRun.notes.join(' · ')}</div> : null}
            </Section>

            <Section
              title={t('run.output')}
              icon="image"
              count={outputs.length > 0 ? outputs.length : undefined}
              defaultOpen
              className="ccw-section-outputs"
            >
              {outputs.length > 0 ? (
                <div className="ccw-outputs">
                  {outputs.map((output) => (
                    <div key={output.asset} className="ccw-output">
                      {String(output.contentType ?? '').startsWith('video/') ? (
                        <video src={assetUrl(sessionId, output.asset)} controls />
                      ) : (
                        <img src={assetUrl(sessionId, output.asset)} alt={output.filename} />
                      )}
                      <div className="ccw-output-meta">
                        <span title={output.filename}>{output.filename}</span>
                        <button type="button" className="ccw-btn ccw-btn-ghost ccw-btn-small" onClick={() => useOutput(output)}>
                          <Icon name="cornerDownLeft" size={13} />
                          <span>{t('run.use')}</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ccw-output-empty">
                  <span className="ccw-empty-icon"><Icon name="image" size={18} /></span>
                  <p className="ccw-hint">{t('run.outputsEmpty')}</p>
                </div>
              )}
            </Section>
          </aside>
        </div>
      )}
    </section>
  )
}
