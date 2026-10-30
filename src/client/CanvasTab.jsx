import React, { useEffect, useRef, useState } from 'react'
import {
  assetUrl,
  deleteAsset,
  deleteBox,
  eventUrl,
  getDoc,
  health,
  saveCanvas,
  saveLayout,
  savePrompt,
  saveSelection,
  upsertBox,
  uploadAsset,
} from './api.js'
import { CanvasStage } from './CanvasStage.jsx'
import { WorkflowView } from './WorkflowView.jsx'
import { Icon, IconButton, Section } from './ui.jsx'

function useDoc(sessionId, setError) {
  const [doc, setDoc] = useState(null)
  const [status, setStatus] = useState('connecting')

  useEffect(() => {
    if (!sessionId) return undefined
    const streamUrl = eventUrl(sessionId)
    if (streamUrl === '') return undefined
    let alive = true
    getDoc(sessionId)
      .then((value) => {
        if (alive) setDoc(value.doc)
      })
      .catch((error) => {
        if (alive) {
          setError(error.message)
          setStatus('offline')
        }
      })
    const source = new EventSource(streamUrl)
    source.addEventListener('open', () => setStatus('live'))
    source.addEventListener('hello', (event) => {
      try {
        setDoc(JSON.parse(event.data).doc)
      } catch {}
      setStatus('live')
    })
    source.addEventListener('doc', (event) => {
      try {
        setDoc(JSON.parse(event.data).doc)
      } catch {}
      setStatus('live')
    })
    source.addEventListener('error', () => setStatus('offline'))
    return () => {
      alive = false
      source.close()
    }
  }, [sessionId, setError])

  return { doc, setDoc, status }
}

const TOOL_ICONS = {
  brush: 'brush',
  eraser: 'eraser',
  rect: 'square',
  ellipse: 'circle',
  select: 'pointer',
  box: 'box',
  pan: 'hand',
}

function Slider({ label, value, min, max, step = 1, onChange, suffix = '' }) {
  return (
    <label className="ccw-range">
      <span className="ccw-range-head">
        <span>{label}</span>
        <span className="ccw-range-value">{value}{suffix}</span>
      </span>
      <input
        className="ccw-range-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function MaskSliders({ brush, setBrush, mask, setMask, t, onClear }) {
  return (
    <div className="ccw-mask-controls">
      <div className="ccw-control-group">
        <div className="ccw-group-label">{t('brush.group')}</div>
        <div className="ccw-range-grid">
          <Slider
            label={t('brush.size')}
            value={brush.size}
            min={1}
            max={400}
            onChange={(value) => setBrush((current) => ({ ...current, size: value }))}
          />
          <Slider
            label={t('brush.hardness')}
            value={Math.round(brush.hardness * 100)}
            min={0}
            max={100}
            onChange={(value) => setBrush((current) => ({ ...current, hardness: value / 100 }))}
            suffix="%"
          />
          <Slider
            label={t('brush.opacity')}
            value={Math.round(brush.opacity * 100)}
            min={1}
            max={100}
            onChange={(value) => setBrush((current) => ({ ...current, opacity: value / 100 }))}
            suffix="%"
          />
        </div>
      </div>

      <div className="ccw-control-group">
        <div className="ccw-group-label">{t('mask.group')}</div>
        <div className="ccw-range-grid">
          <Slider
            label={t('mask.feather')}
            value={mask.feather}
            min={0}
            max={128}
            onChange={(value) => setMask((current) => ({ ...current, feather: value }))}
            suffix="px"
          />
          <Slider
            label={t('mask.grow')}
            value={mask.grow}
            min={-128}
            max={128}
            onChange={(value) => setMask((current) => ({ ...current, grow: value }))}
            suffix="px"
          />
        </div>
        <div className="ccw-toggle-row">
          <label className="ccw-check">
            <input
              type="checkbox"
              checked={mask.inverted}
              onChange={(event) => setMask((current) => ({ ...current, inverted: event.target.checked }))}
            />
            <span>{t('mask.invert')}</span>
          </label>
          <label className="ccw-check">
            <input
              type="checkbox"
              checked={mask.visible}
              onChange={(event) => setMask((current) => ({ ...current, visible: event.target.checked }))}
            />
            <span>{t('mask.visible')}</span>
          </label>
        </div>
      </div>

      <div className="ccw-danger-zone">
        <button type="button" className="ccw-btn ccw-btn-danger-ghost" onClick={onClear}>
          <Icon name="eraser" size={14} />
          <span>{t('mask.clear')}</span>
        </button>
      </div>
    </div>
  )
}

function BoxEditor({ selected, updateSelected, removeSelected, t }) {
  return (
    <div className="ccw-box-editor">
      <div className="ccw-box-editor-top">
        <label className="ccw-field">
          <span>{t('box.label')}</span>
          <select
            value={selected.label}
            onChange={(event) => updateSelected({ label: event.target.value })}
          >
            <option value="object">object</option>
            <option value="character">character</option>
            <option value="text">text</option>
          </select>
        </label>
        <div className="ccw-bbox-readout">
          <span>{t('layout.bbox')}</span>
          <code>{selected.bbox.map((number) => Math.round(number)).join(', ')}</code>
        </div>
      </div>
      <label className="ccw-field">
        <span>{t('box.caption')}</span>
        <textarea
          rows={2}
          value={selected.caption}
          onChange={(event) => updateSelected({ caption: event.target.value })}
        />
      </label>
      {selected.label === 'text' ? (
        <label className="ccw-field">
          <span>{t('box.text')}</span>
          <input
            type="text"
            value={selected.text}
            onChange={(event) => updateSelected({ text: event.target.value })}
          />
        </label>
      ) : null}
      <div className="ccw-danger-zone">
        <button type="button" className="ccw-btn ccw-btn-danger-ghost" onClick={removeSelected}>
          <Icon name="trash" size={14} />
          <span>{t('layout.deleteBox')}</span>
        </button>
      </div>
    </div>
  )
}

export function CanvasTab(props) {
  const { sessionId } = props
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const [error, setError] = useState('')
  const { doc, setDoc, status } = useDoc(sessionId, setError)
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [incoming, setIncoming] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [comfy, setComfy] = useState(null)
  const [probeError, setProbeError] = useState('')
  const [view, setView] = useState('canvas')
  const [tool, setTool] = useState('brush')
  const [brush, setBrush] = useState({ size: 64, hardness: 0.7, opacity: 0.9 })
  const [mask, setMask] = useState({ feather: 8, grow: 0, inverted: false, visible: true, color: '#ff3b30', opacity: 0.45, hasMask: false })
  const [summary, setSummary] = useState('')
  const [showMaskTools] = useState(true)
  const maskInit = useRef(false)
  const saveTimer = useRef(null)
  const maskSaveTimer = useRef(null)
  const docRef = useRef(null)
  const focusedRef = useRef(false)
  const draftRef = useRef('')
  const stageRef = useRef(null)

  docRef.current = doc
  focusedRef.current = focused
  draftRef.current = draft

  useEffect(() => {
    if (!doc) return
    if (!maskInit.current) {
      maskInit.current = true
      setMask((current) => ({ ...current, ...doc.mask }))
      setSummary(doc.layout.summary ?? '')
      setTool(doc.mode === 'layout' ? 'box' : 'brush')
    }
    if (!focusedRef.current) {
      const current = draftRef.current
      if (doc.prompt !== current) {
        if (doc.promptSource === 'agent' && current.trim() !== '' && doc.prompt.trim() !== current.trim()) {
          setIncoming(doc.prompt)
        } else {
          setDraft(doc.prompt)
          setIncoming('')
        }
      }
    }
  }, [doc])

  useEffect(() => () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    if (maskSaveTimer.current !== null) clearTimeout(maskSaveTimer.current)
  }, [])

  useEffect(() => {
    if (probeError === '') return undefined
    const timer = setTimeout(() => setProbeError(''), 5000)
    return () => clearTimeout(timer)
  }, [probeError])

  useEffect(() => {
    if (!maskInit.current || !sessionId) return undefined
    if (maskSaveTimer.current !== null) clearTimeout(maskSaveTimer.current)
    maskSaveTimer.current = setTimeout(async () => {
      maskSaveTimer.current = null
      try {
        const result = await saveCanvas(sessionId, {
          mask: {
            feather: mask.feather,
            grow: mask.grow,
            inverted: mask.inverted,
            visible: mask.visible,
            color: mask.color,
            opacity: mask.opacity,
            rev: Date.now(),
          },
        })
        setDoc(result.doc)
        stageRef.current?.exportNow?.()
      } catch (caught) {
        setError(caught.message)
      }
    }, 380)
    return () => {
      if (maskSaveTimer.current !== null) clearTimeout(maskSaveTimer.current)
    }
  }, [mask.feather, mask.grow, mask.inverted, mask.visible, mask.color, mask.opacity, sessionId])

  async function persistPrompt(value) {
    if (!sessionId || value === docRef.current?.prompt) return
    setSaving(true)
    try {
      const result = await savePrompt(sessionId, value, true)
      setDoc(result.doc)
      setError('')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSaving(false)
    }
  }

  function onPromptChange(value) {
    setDraft(value)
    setIncoming('')
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => persistPrompt(value), 500)
  }

  function onPromptBlur() {
    setFocused(false)
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    persistPrompt(draftRef.current)
  }

  async function probe() {
    setProbeError('')
    try {
      setComfy(await health())
    } catch (caught) {
      setProbeError(caught.message)
      setComfy(null)
    }
  }

  async function applyIncoming() {
    setDraft(incoming)
    setIncoming('')
    await persistPrompt(incoming)
  }

  async function recompile() {
    if (!doc) return
    try {
      const result = await saveLayout(sessionId, summary, doc.layout.items)
      setDoc(result.doc)
      setDraft(result.doc.prompt)
      setError(result.doc.promptError ?? '')
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function saveSummary(value) {
    setSummary(value)
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null
      try {
        const result = await saveLayout(sessionId, value, docRef.current?.layout?.items ?? [])
        setDoc(result.doc)
        setDraft(result.doc.prompt)
      } catch (caught) {
        setError(caught.message)
      }
    }, 500)
  }

  async function addBox() {
    if (!doc) return
    const width = doc.canvas.width
    const height = doc.canvas.height
    const inset = Math.round(Math.min(width, height) * 0.2)
    try {
      const result = await upsertBox(sessionId, {
        label: 'object',
        caption: '',
        bbox: [inset, inset, width - inset, height - inset],
      })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function createBox(bbox) {
    try {
      const result = await upsertBox(sessionId, { label: 'object', caption: '', bbox })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function commitBox(box) {
    try {
      const result = await upsertBox(sessionId, box)
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function updateSelected(patch) {
    const selected = doc?.layout?.items?.find((item) => item.id === doc?.selected?.id)
    if (selected === undefined) return
    try {
      const result = await upsertBox(sessionId, { ...selected, ...patch })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function removeSelected() {
    if (!doc?.selected?.id) return
    try {
      const result = await deleteBox(sessionId, doc.selected.id)
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function selectBox(id) {
    if (!sessionId) return
    try {
      const result = await saveSelection(sessionId, id === null ? null : { kind: 'box', id })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function loadImage(file) {
    if (!file || !sessionId) return
    try {
      setSaving(true)
      const bitmap = await createImageBitmap(file)
      await uploadAsset(sessionId, 'canvas.png', file)
      await uploadAsset(sessionId, 'source.png', file)
      await deleteAsset(sessionId, 'mask.png')
      await deleteAsset(sessionId, 'canvas_rgba.png')
      const result = await saveCanvas(sessionId, {
        mode: 'image',
        width: bitmap.width,
        height: bitmap.height,
        image: { asset: 'canvas.png', name: file.name, width: bitmap.width, height: bitmap.height, rev: Date.now() },
        mask: { rev: Date.now(), hasMask: false, feather: mask.feather, grow: mask.grow, inverted: mask.inverted },
      })
      setDoc(result.doc)
      setTool('brush')
      setError('')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setSaving(false)
    }
  }

  async function clearImage() {
    if (!sessionId) return
    try {
      await deleteAsset(sessionId, 'mask.png')
      await deleteAsset(sessionId, 'canvas_rgba.png')
      const result = await saveCanvas(sessionId, { mode: 'layout', image: null, mask: { rev: Date.now(), hasMask: false } })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function setMode(mode) {
    setTool(mode === 'layout' ? 'box' : 'brush')
    if (!sessionId) return
    try {
      const result = await saveCanvas(sessionId, { mode })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function setCanvasSize(nextWidth, nextHeight) {
    if (!sessionId) return
    if (!Number.isInteger(nextWidth) || !Number.isInteger(nextHeight)) return
    if (nextWidth < 16 || nextHeight < 16 || nextWidth > 16384 || nextHeight > 16384) return
    try {
      const result = await saveCanvas(sessionId, { width: nextWidth, height: nextHeight })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function handleMaskReady({ maskBlob, rgbaBlob, hasMask }) {
    if (!sessionId) return
    try {
      await uploadAsset(sessionId, 'mask.png', maskBlob)
      if (rgbaBlob !== null) await uploadAsset(sessionId, 'canvas_rgba.png', rgbaBlob)
      const result = await saveCanvas(sessionId, { mask: { rev: Date.now(), hasMask } })
      setDoc(result.doc)
      setMask((current) => ({ ...current, hasMask }))
    } catch (caught) {
      setError(caught.message)
    }
  }

  const items = doc?.layout?.items ?? []
  const selected = items.find((item) => item.id === doc?.selected?.id) ?? null
  const image = doc?.canvas?.image ?? null
  const imageUrl = image ? assetUrl(sessionId, image.asset, image.rev) : null
  const hasBoxes = items.length > 0
  const compiled = hasBoxes && doc?.promptSource === 'layout'
  const tools = doc?.mode === 'layout'
    ? [{ id: 'box', label: t('tool.box') }, { id: 'select', label: t('tool.select') }, { id: 'pan', label: t('tool.pan') }]
    : [
        { id: 'brush', label: t('tool.brush') },
        { id: 'eraser', label: t('tool.eraser') },
        { id: 'rect', label: t('tool.rect') },
        { id: 'ellipse', label: t('tool.ellipse') },
        { id: 'select', label: t('tool.select') },
        { id: 'pan', label: t('tool.pan') },
      ]
  const activeTool = tools.find((item) => item.id === tool) ?? null

  if (!sessionId) {
    return (
      <div className="ccw-empty" role="status">
        <p>{t('tab.noSession')}</p>
      </div>
    )
  }

  const statusLabel = t(`status.${status}`)
  const comfyLabel = comfy?.comfy?.connected
    ? t('status.comfyOk').replace('{version}', String(comfy.comfy.version ?? '')).trim()
    : t('status.comfy')
  const canvasLabel = doc?.mode === 'layout' ? t('mode.layout') : t('mode.edit')

  return (
    <div className="ccw-root">
      <header className="ccw-appbar">
        <div className="ccw-appbar-brand">
          <span className="ccw-brandmark" aria-hidden="true"><Icon name="layers" size={17} /></span>
          <span className="ccw-brand-copy">
            <span className="ccw-appbar-title">{t('tab.title')}</span>
            <span className="ccw-appbar-meta">
              <span className={`ccw-statusdot is-${status}`} aria-hidden="true" />
              <span>{statusLabel}</span>
              {saving ? <><span className="ccw-meta-sep">·</span><span>{t('unsaved')}</span></> : null}
            </span>
          </span>
        </div>

        <nav className="ccw-viewtabs" aria-label={t('view.switch')}>
          <button
            type="button"
            className={`ccw-viewtab ${view === 'canvas' ? 'is-active' : ''}`}
            aria-pressed={view === 'canvas'}
            onClick={() => setView('canvas')}
          >
            <Icon name="image" size={15} />
            <span>{t('view.canvas')}</span>
          </button>
          <button
            type="button"
            className={`ccw-viewtab ${view === 'workflow' ? 'is-active' : ''}`}
            aria-pressed={view === 'workflow'}
            onClick={() => setView('workflow')}
          >
            <Icon name="workflow" size={15} />
            <span>{t('view.workflow')}</span>
          </button>
        </nav>

        <div className="ccw-appbar-actions">
          <span className={`ccw-health ${comfy?.comfy?.connected ? 'is-ok' : ''}`} title={comfyLabel}>
            <span className="ccw-health-dot" aria-hidden="true" />
            <span className="ccw-health-label">{comfyLabel}</span>
          </span>
          <IconButton icon="refresh" label={t('probe')} onClick={probe} className="ccw-appbar-probe" />
        </div>
      </header>

      {(error !== '' || probeError !== '' || incoming !== '') ? (
        <div className="ccw-notices">
          {error !== '' ? (
            <div className="ccw-error" role="alert">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          {probeError !== '' ? (
            <div className="ccw-error" role="alert">
              <Icon name="alert" size={15} />
              <span>{probeError}</span>
            </div>
          ) : null}
          {incoming !== '' ? (
            <div className="ccw-banner" role="status">
              <Icon name="sparkles" size={15} />
              <span>{t('agent.updated')}</span>
              <button type="button" className="ccw-btn ccw-btn-primary ccw-btn-small" onClick={applyIncoming}>{t('agent.load')}</button>
              <IconButton icon="x" label={t('banner.dismiss')} onClick={() => setIncoming('')} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={`ccw-editor ${view === 'workflow' ? 'is-hidden' : ''}`}>
        <aside className="ccw-toolrail" aria-label={t('tools.label')}>
          <div className="ccw-toolgroup" role="group" aria-label={t('mode.edit')}>
            <IconButton
              icon="image"
              label={t('mode.edit')}
              active={doc?.mode === 'image'}
              onClick={() => setMode('image')}
            />
            <IconButton
              icon="layout"
              label={t('mode.layout')}
              active={doc?.mode === 'layout'}
              onClick={() => setMode('layout')}
            />
          </div>
          <div className="ccw-rail-divider" aria-hidden="true" />
          <div className="ccw-toolgroup" role="group" aria-label={t('tools.label')}>
            {tools.map((item) => (
              <IconButton
                key={item.id}
                icon={TOOL_ICONS[item.id] ?? 'box'}
                label={item.label}
                active={tool === item.id}
                onClick={() => setTool(item.id)}
              />
            ))}
          </div>
          <div className="ccw-rail-spacer" aria-hidden="true" />
          <div className="ccw-toolgroup ccw-toolgroup-end" aria-hidden="true">
            <span className="ccw-rail-mark" />
          </div>
        </aside>

        <section className="ccw-stagecol" aria-label={t('view.canvas')}>
          <div className="ccw-stagebar">
            <div className="ccw-stagebar-title">
              <Icon name="image" size={15} />
              <span>{t('view.canvas')}</span>
              <span className="ccw-badge">{canvasLabel}</span>
            </div>
            <div className="ccw-stagebar-actions">
              <label className="ccw-iconbtn ccw-file" title={t('image.load')} aria-label={t('image.load')}>
                <Icon name="upload" size={15} />
                <input type="file" accept="image/*" onChange={(event) => loadImage(event.target.files?.[0])} />
              </label>
              {image ? (
                <IconButton
                  icon="trash"
                  label={t('image.clear')}
                  className="ccw-iconbtn-danger"
                  onClick={clearImage}
                />
              ) : null}
              <span className="ccw-bar-divider" aria-hidden="true" />
              <IconButton icon="undo" label={t('history.undo')} onClick={() => stageRef.current?.undo()} />
              <IconButton icon="redo" label={t('history.redo')} onClick={() => stageRef.current?.redo()} />
              <span className="ccw-bar-divider" aria-hidden="true" />
              <IconButton icon="maximize" label={t('canvas.fit')} onClick={() => stageRef.current?.fit()} />
            </div>
          </div>

          <div className="ccw-canvas-wrap">
            <CanvasStage
              ref={stageRef}
              sessionId={sessionId}
              imageUrl={imageUrl}
              width={doc?.canvas?.width ?? 1024}
              height={doc?.canvas?.height ?? 1024}
              tool={tool}
              brush={brush}
              maskSettings={mask}
              boxes={items}
              selectedId={doc?.selected?.id ?? null}
              onBoxCreate={createBox}
              onBoxCommit={commitBox}
              onBoxSelect={selectBox}
              onMaskReady={handleMaskReady}
              onMessage={setError}
            />
          </div>

          <footer className="ccw-statusbar" aria-label={t('canvas.status')}>
            <span className="ccw-status-item ccw-status-strong">
              {doc?.mode === 'layout' && !image
                ? `${doc?.canvas?.width ?? '—'} × ${doc?.canvas?.height ?? '—'}`
                : image ? `${image.width} × ${image.height}` : '—'}
            </span>
            {image ? <span className="ccw-status-item ccw-status-file" title={image.name ?? ''}>{image.name ?? ''}</span> : null}
            <span className="ccw-status-sep" aria-hidden="true" />
            <span className={`ccw-status-item ccw-mask-state ${mask.hasMask ? 'is-on' : ''}`}>
              <span className="ccw-statusdot" aria-hidden="true" />
              {mask.hasMask ? t('mask.painted') : t('mask.empty')}
            </span>
            <span className="ccw-status-spacer" aria-hidden="true" />
            {activeTool ? <span className="ccw-status-item">{activeTool.label}</span> : null}
          </footer>
        </section>

        <aside className="ccw-inspector" aria-label={t('inspector.label')}>
          {showMaskTools ? (
            <Section title={t('mask.title')} icon="sliders" className="ccw-section-mask">
              <MaskSliders
                brush={brush}
                setBrush={setBrush}
                mask={mask}
                setMask={setMask}
                t={t}
                onClear={() => stageRef.current?.clearMask()}
              />
            </Section>
          ) : null}

          <Section
            title={t('prompt.title')}
            icon="sparkles"
            count={hasBoxes ? items.length : undefined}
            className="ccw-section-prompt"
          >
            <p className="ccw-hint">{t('prompt.hint')}</p>
            <textarea
              className="ccw-prompt"
              value={draft}
              placeholder={t('prompt.placeholder')}
              spellCheck={false}
              aria-label={t('prompt.title')}
              onChange={(event) => onPromptChange(event.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={onPromptBlur}
            />
            {doc?.promptError ? (
              <div className="ccw-inline-error" role="alert">{doc.promptError}</div>
            ) : null}
            {hasBoxes ? (
              <div className="ccw-prompt-source">
                <span>{t('prompt.compiled').replace('{count}', String(items.length))}</span>
                <span className={`ccw-source-mode ${compiled ? 'is-layout' : ''}`}>
                  {compiled ? t('prompt.modeLayout') : t('prompt.manual')}
                </span>
              </div>
            ) : null}
            <div className="ccw-action-row">
              <button
                type="button"
                className="ccw-btn ccw-btn-ghost ccw-btn-small"
                onClick={async () => {
                  await navigator.clipboard.writeText(draft)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1200)
                }}
              >
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                <span>{copied ? t('prompt.copied') : t('prompt.copy')}</span>
              </button>
              <button
                type="button"
                className="ccw-btn ccw-btn-primary ccw-btn-compile"
                onClick={recompile}
                disabled={!hasBoxes}
              >
                <Icon name="sparkles" size={15} />
                <span>{t('prompt.compile')}</span>
              </button>
            </div>
          </Section>

          <Section
            title={t('layout.title')}
            icon="layout"
            count={items.length}
            className="ccw-section-layout"
            actions={(
              <IconButton icon="plus" label={t('layout.add')} onClick={addBox} />
            )}
          >
            <div className="ccw-subsection">
              <div className="ccw-subhead">{t('layout.settings')}</div>
              {image ? (
                <div className="ccw-size-readout">
                  <span className="ccw-size-value">{image.width} × {image.height}</span>
                  <span className="ccw-hint">{image.name ?? ''}</span>
                </div>
              ) : (
                <div className="ccw-size-grid">
                  <label className="ccw-field">
                    <span>{t('layout.width')}</span>
                    <input
                      type="number"
                      min={16}
                      max={16384}
                      step={16}
                      value={doc?.canvas?.width ?? 1024}
                      onChange={(event) => setCanvasSize(Number(event.target.value), doc?.canvas?.height ?? 1024)}
                    />
                  </label>
                  <label className="ccw-field">
                    <span>{t('layout.height')}</span>
                    <input
                      type="number"
                      min={16}
                      max={16384}
                      step={16}
                      value={doc?.canvas?.height ?? 1024}
                      onChange={(event) => setCanvasSize(doc?.canvas?.width ?? 1024, Number(event.target.value))}
                    />
                  </label>
                </div>
              )}
              <label className="ccw-field">
                <span>{t('layout.summary')}</span>
                <textarea
                  rows={2}
                  value={summary}
                  placeholder={t('layout.summaryPlaceholder')}
                  onChange={(event) => saveSummary(event.target.value)}
                />
              </label>
            </div>

            <div className="ccw-subsection">
              <div className="ccw-subhead-row">
                <div className="ccw-subhead">{t('layout.selected')}</div>
                {selected ? (
                  <span className="ccw-subhead-meta">#{items.findIndex((item) => item.id === selected.id) + 1}</span>
                ) : null}
              </div>
              {selected ? (
                <BoxEditor
                  selected={selected}
                  updateSelected={updateSelected}
                  removeSelected={removeSelected}
                  t={t}
                />
              ) : (
                <p className="ccw-hint ccw-select-hint">
                  <Icon name="pointer" size={14} />
                  <span>{t('layout.selectHint')}</span>
                </p>
              )}
            </div>

            <div className="ccw-subsection">
              <div className="ccw-subhead-row">
                <div className="ccw-subhead">{t('layout.list')}</div>
                <span className="ccw-subhead-meta">{items.length}</span>
              </div>
              {items.length === 0 ? (
                <p className="ccw-hint">{t('layout.empty')}</p>
              ) : (
                <ul className="ccw-boxes">
                  {items.map((item, index) => (
                    <li key={item.id || index}>
                      <button
                        type="button"
                        className={`ccw-box-row ${doc?.selected?.id === item.id ? 'is-selected' : ''}`}
                        aria-pressed={doc?.selected?.id === item.id}
                        title={item.caption || undefined}
                        onClick={() => selectBox(item.id)}
                      >
                        <span className="ccw-box-index">{String(index + 1).padStart(2, '0')}</span>
                        <span className="ccw-box-main">
                          <span className="ccw-box-label">{item.label}</span>
                          <span className="ccw-box-caption">{item.caption || t('layout.caption')}</span>
                        </span>
                        <Icon name="chevronRight" size={13} className="ccw-box-chevron" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>
        </aside>
      </div>

      {view === 'workflow' ? (
        <div className="ccw-workflow-host">
          <WorkflowView sessionId={sessionId} doc={doc} setDoc={setDoc} t={t} setError={setError} />
        </div>
      ) : null}
    </div>
  )
}
