import React, { useEffect, useRef, useState } from 'react'
import {
  assetUrl,
  deleteAsset,
  deleteBox,
  eventUrl,
  getConfig,
  getDoc,
  health,
  refreshModels,
  saveConfig,
  saveCanvas,
  patchWorkflow,
  saveComment,
  saveEnabled,
  saveLayout,
  saveMaskPrompt,
  saveNegative,
  savePrompt,
  saveSelection,
  unloadTools,
  removeComment,
  upsertBox,
  uploadAsset,
} from './api.js'
import { CanvasStage } from './CanvasStage.jsx'
import { WorkflowView } from './WorkflowView.jsx'
import { setNodeWidget } from './workflow-ui.js'
import { HelpTip, Icon, IconButton, Section } from './ui.jsx'
import { ColorField } from './ColorField.jsx'
import { embedPngText } from './png.js'

/** Canvas presets in 16-pixel steps, the grid MOSS-Image requires. */
const CANVAS_PRESETS = [
  { key: '1:1', label: '1:1', width: 1024, height: 1024 },
  { key: '5:4', label: '5:4', width: 1280, height: 1024 },
  { key: '4:5', label: '4:5', width: 1024, height: 1280 },
  { key: '4:3', label: '4:3', width: 1152, height: 864 },
  { key: '3:4', label: '3:4', width: 864, height: 1152 },
  { key: '16:9', label: '16:9', width: 1280, height: 720 },
  { key: '9:16', label: '9:16', width: 720, height: 1280 },
]

/** Round a pixel count onto the 8-pixel grid and keep it inside the bounds. */
function snapSize(value) {
  return Math.min(16384, Math.max(16, Math.round(value / 8) * 8))
}

/** Compact a context size for the warning: 987, 12.4k, 1.2M. */
function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  if (value < 1000) return String(Math.round(value))
  if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`
  return `${(value / 1000000).toFixed(1)}M`
}

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

/**
 * A slider that also accepts a typed number: the value box is an input, so a
 * brush size or feather radius can be entered directly instead of dragged.
 */
function Slider({ label, value, min, max, step = 1, onChange, suffix = '', help = '' }) {
  const [draft, setDraft] = useState(null)
  const span = max - min
  const ratio = span > 0 ? Math.min(1, Math.max(0, (value - min) / span)) : 0
  const commit = (raw) => {
    setDraft(null)
    const next = Number(raw)
    if (!Number.isFinite(next) || raw === '') return
    onChange(Math.min(max, Math.max(min, Math.round(next / step) * step)))
  }
  return (
    <div className="ccw-range">
      <span className="ccw-range-head">
        {/* The tip hugs the label text: a "?" floating mid-row reads as if it
            belonged to the number box. */}
        <span className="ccw-range-title">
          <span className="ccw-range-label">{label}</span>
          {help === '' ? null : <HelpTip text={help} />}
        </span>
        <span className="ccw-range-edit">
          <input
            className="ccw-range-number"
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft ?? value}
            aria-label={label}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(event.target.value)
            }}
          />
          {suffix !== '' ? <span className="ccw-range-suffix">{suffix}</span> : null}
        </span>
      </span>
      <input
        className="ccw-range-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ '--ccw-range-fill-pct': `${(ratio * 100).toFixed(2)}%` }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  )
}

function MaskSliders({ brush, setBrush, mask, setMask, t }) {
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
            help={t('help.brushSize')}
          />
          {/* Display only: it tints the red overlay, never the mask or a run. */}
          <Slider
            label={t('brush.overlay')}
            value={Math.round(mask.opacity * 100)}
            min={10}
            max={100}
            onChange={(value) => setMask((current) => ({ ...current, opacity: value / 100 }))}
            suffix="%"
            help={t('help.overlay')}
          />
        </div>
      </div>

      <div className="ccw-control-group">
        <div className="ccw-group-label">{t('mask.group')}</div>
        <div className="ccw-range-grid">
          <Slider
            label={t('mask.strength')}
            value={Math.round(mask.denoise * 100)}
            min={0}
            max={100}
            onChange={(value) => setMask((current) => ({ ...current, denoise: value / 100 }))}
            suffix="%"
            help={t('help.strength')}
          />
          <Slider
            label={t('mask.feather')}
            value={mask.feather}
            min={0}
            max={128}
            onChange={(value) => setMask((current) => ({ ...current, feather: value }))}
            suffix="px"
            help={t('help.feather')}
          />
          <Slider
            label={t('mask.grow')}
            value={mask.grow}
            min={-128}
            max={128}
            onChange={(value) => setMask((current) => ({ ...current, grow: value }))}
            suffix="px"
            help={t('help.grow')}
          />
        </div>
      </div>
    </div>
  )
}

function BoxEditor({ selected, summaryExists, updateSelected, removeSelected, t }) {
  const palette = Array.isArray(selected.palette) ? selected.palette : []
  const isSummary = selected.label === 'summary'
  return (
    <div className="ccw-box-editor">
      <div className="ccw-box-editor-top">
        <label className="ccw-field">
          <span>{t('box.label')}</span>
          <select
            value={selected.label}
            onChange={(event) => updateSelected({ label: event.target.value })}
          >
            <option value="object">{t('box.type.object')}</option>
            <option value="character">{t('box.type.character')}</option>
            <option value="text">{t('box.type.text')}</option>
            <option value="summary" disabled={summaryExists}>
              {t('box.type.summary')}
            </option>
          </select>
        </label>
        {isSummary ? null : (
          <div className="ccw-bbox-readout">
            <span>{t('layout.bbox')}</span>
            <code>{selected.bbox.map((number) => Math.round(number)).join(', ')}</code>
          </div>
        )}
      </div>
      <div className="ccw-field">
        <span className="ccw-field-head">
          <span>{isSummary ? t('layout.summary') : t('box.caption')}</span>
          {isSummary ? <HelpTip text={t('help.summary')} /> : null}
        </span>
        <textarea
          rows={2}
          value={selected.caption}
          aria-label={isSummary ? t('layout.summary') : t('box.caption')}
          placeholder={isSummary ? t('layout.summaryPlaceholder') : undefined}
          onChange={(event) => updateSelected({ caption: event.target.value })}
        />
      </div>
      {!isSummary && selected.label === 'text' ? (
        <label className="ccw-field">
          <span>{t('box.text')}</span>
          <input
            type="text"
            value={selected.text}
            onChange={(event) => updateSelected({ text: event.target.value })}
          />
        </label>
      ) : null}
      {isSummary ? null : (
        <div className="ccw-field">
          <span>{t('box.palette')}</span>
          <div className="ccw-palette">
            {palette.map((color, index) => (
              <ColorField
                key={`${index}-${color}`}
                value={color}
                label={t('box.palette')}
                t={t}
                onChange={(nextColor) => {
                  const next = palette.slice()
                  next[index] = nextColor
                  updateSelected({ palette: next })
                }}
                onRemove={() => updateSelected({ palette: palette.filter((_, at) => at !== index) })}
              />
            ))}
            {palette.length < 5 ? (
              <button
                type="button"
                className="ccw-btn ccw-btn-ghost ccw-btn-small"
                onClick={() => updateSelected({ palette: [...palette, '#cccccc'] })}
              >
                <Icon name="plus" size={13} />
                <span>{t('box.paletteAdd')}</span>
              </button>
            ) : null}
          </div>
        </div>
      )}
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
  // The sidebar's own tab actions; `close()` removes the tab and runs the tab
  // type's close handler, which is what turns this chat's tools off.
  const tabInfoHook = typeof props.useTabInfo === 'function' ? props.useTabInfo : null
  const tabInfo = tabInfoHook === null ? null : tabInfoHook()
  const closeTabAction = tabInfo?.tab?.actions?.close ?? null
  const [error, setError] = useState('')
  const { doc, setDoc, status } = useDoc(sessionId, setError)
  const enabled = doc?.enabled === true
  const comments = doc?.comments ?? []
  const [draft, setDraft] = useState('')
  const [focused, setFocused] = useState(false)
  const [incoming, setIncoming] = useState('')
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [comfy, setComfy] = useState(null)
  const [probeError, setProbeError] = useState('')
  const [view, setView] = useState('canvas')
  // One modal, two decisions: turn the tools on (costs one cache miss in a chat
  // that already has history) or take them away (same cost).
  const [modal, setModal] = useState(null)
  const [historyCount, setHistoryCount] = useState({ messages: 0, tokens: null })
  const [comfyUrl, setComfyUrl] = useState('')
  const [comfyUrlDraft, setComfyUrlDraft] = useState('')
  const [comfyUrlSaving, setComfyUrlSaving] = useState(false)
  const [modelsRefreshing, setModelsRefreshing] = useState(false)
  const [modelsNote, setModelsNote] = useState('')
  const autoEnableTried = useRef(false)
  const unloaded = useRef(false)
  useEffect(() => {
    if (modal === null) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') setModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  // Opening the canvas is how a chat gets the tools, so try once on mount. A
  // chat with history answers `needsConfirmation` and the modal explains the
  // cache cost before anything changes.
  useEffect(() => {
    if (autoEnableTried.current || unloaded.current) return
    if (doc === null || doc === undefined) return
    autoEnableTried.current = true
    if (doc.enabled !== true) void enableTools()
  }, [doc])
  // The ComfyUI address belongs to the workspace, so read it with the chat.
  useEffect(() => {
    let cancelled = false
    getConfig(sessionId)
      .then((result) => {
        if (cancelled) return
        setComfyUrl(result.baseUrl ?? '')
        setComfyUrlDraft(result.baseUrl ?? '')
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [sessionId])
  const [widthInput, setWidthInput] = useState(null)
  const [negative, setNegative] = useState('')
  const [negativeFocused, setNegativeFocused] = useState(false)
  const [stageHeight, setStageHeight] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem('ccw.stageHeight'))
      return Number.isFinite(stored) && stored >= 200 ? stored : null
    } catch {
      return null
    }
  })
  const sizeTimer = useRef(null)
  const widthInputRef = useRef(null)
  const heightInputRef = useRef(null)
  const negativeRef = useRef('')
  const negativeFocusedRef = useRef(false)
  const negativeTimer = useRef(null)
  const [heightInput, setHeightInput] = useState(null)
  const [selectedComment, setSelectedComment] = useState(null)
  const [commentDraft, setCommentDraft] = useState(null)
  const commentTimer = useRef(null)
  const assetTimer = useRef(null)
  const [lockRatio, setLockRatio] = useState(() => {
    try {
      return window.localStorage.getItem('ccw.lockRatio') === '1'
    } catch {
      return false
    }
  })
  const ratioRef = useRef(null)
  const [tool, setTool] = useState('brush')
  // The brush has no opacity setting: it always writes full-alpha mask pixels,
  // so the mask stays a 0/1 selection and the repaint strength is the only
  // knob (A1111 inpaint semantics). The red overlay's opacity is the mask's
  // display setting below.
  const [brush, setBrush] = useState({ size: 64 })
  const [mask, setMask] = useState({ feather: 8, grow: 0, color: '#ff3b30', opacity: 0.45, denoise: 0.85, hasMask: false })
  // The local repaint prompt belongs to the mask, not to the whole image: while
  // a mask is painted a run sends it instead of the canvas prompt.
  const [maskPrompt, setMaskPrompt] = useState('')
  const [maskPromptFocused, setMaskPromptFocused] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [showMaskTools] = useState(true)
  const maskInit = useRef(false)
  const saveTimer = useRef(null)
  const maskSaveTimer = useRef(null)
  const maskPromptTimer = useRef(null)
  const maskPromptRef = useRef('')
  const maskPromptFocusedRef = useRef(false)
  const maskPromptPending = useRef(false)
  const dragTimer = useRef(null)
  const loadImageRef = useRef(null)
  const docRef = useRef(null)
  const focusedRef = useRef(false)
  const draftRef = useRef('')
  const stageRef = useRef(null)

  docRef.current = doc
  widthInputRef.current = widthInput
  heightInputRef.current = heightInput
  focusedRef.current = focused
  draftRef.current = draft
  negativeRef.current = negative
  negativeFocusedRef.current = negativeFocused
  maskPromptRef.current = maskPrompt
  maskPromptFocusedRef.current = maskPromptFocused
  loadImageRef.current = loadImage

  // Keyboard: undo/redo, tool letters, brush size and Delete on the selection.
  useEffect(() => {
    const toolKeys = { b: 'brush', e: 'eraser', r: 'rect', o: 'ellipse', v: 'select', h: 'pan', m: 'box' }
    const onKeyDown = (event) => {
      const target = event.target
      const tag = target?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true
      const inCanvas = typeof target?.closest === 'function' && target.closest('.ccw-root') !== null
      const meta = event.ctrlKey || event.metaKey
      if (typing) return
      if (meta && !event.altKey) {
        const key = String(event.key).toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) stageRef.current?.redo()
          else stageRef.current?.undo()
          return
        }
        if (key === 'y') {
          event.preventDefault()
          stageRef.current?.redo()
        }
        return
      }
      if (!inCanvas || event.altKey || event.defaultPrevented) return
      const key = String(event.key).toLowerCase()
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        stageRef.current?.deleteSelection()
        return
      }
      if (event.key === 'Escape') {
        stageRef.current?.clearSelection()
        return
      }
      if (event.key === '[' || event.key === ']') {
        event.preventDefault()
        const delta = event.key === ']' ? 8 : -8
        setBrush((current) => ({ ...current, size: Math.min(400, Math.max(1, current.size + delta)) }))
        return
      }
      if (key === 'c') {
        event.preventDefault()
        if (docRef.current?.mode === 'layout') setMode('image')
        setTool('comment')
        return
      }
      const nextTool = toolKeys[key]
      if (nextTool === undefined) return
      const maskTools = ['brush', 'eraser', 'rect', 'ellipse']
      if (docRef.current?.mode === 'layout') {
        if (nextTool === 'box' || nextTool === 'select' || nextTool === 'pan') {
          event.preventDefault()
          setTool(nextTool)
          return
        }
        // Mask shortcuts flip back to edit mode rather than disappearing.
        if (maskTools.includes(nextTool)) {
          event.preventDefault()
          setMode('image')
          setTool(nextTool)
        }
        return
      }
      event.preventDefault()
      setTool(nextTool)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Pasting an image anywhere outside a text field imports it, the same way a
  // drop on the stage does. Text pastes keep going to their inputs untouched.
  useEffect(() => {
    function onPaste(event) {
      const target = event.target
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true) return
      const items = Array.from(event.clipboardData?.items ?? [])
      const image = items.find((item) => item.kind === 'file' && String(item.type).startsWith('image/'))
      if (image === undefined) return
      const file = image.getAsFile()
      if (file === null) return
      event.preventDefault()
      setError('')
      void loadImageRef.current?.(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const shapesKey = JSON.stringify(doc?.mask?.shapes ?? [])
  useEffect(() => {
    if (!doc) return
    const nextShapes = doc.mask?.shapes ?? []
    setMask((current) => {
      if (JSON.stringify(current.shapes ?? []) === JSON.stringify(nextShapes)) return current
      return { ...current, shapes: nextShapes }
    })
  }, [shapesKey])

  // hasMask is written by other paths too (a newly loaded image, an applied run
  // output, the agent), so the local copy follows the document instead of
  // sticking to the last brush stroke.
  const hasMask = doc?.mask?.hasMask === true
  useEffect(() => {
    setMask((current) => (current.hasMask === hasMask ? current : { ...current, hasMask }))
  }, [hasMask])

  const commentsKey = comments.map((comment) => `${comment.id}:${comment.bbox.join(',')}:${comment.text}`).join('|')
  const commentsLoaded = useRef(false)
  useEffect(() => {
    if (!commentsLoaded.current) {
      commentsLoaded.current = true
      return
    }
    scheduleCommentAssets(comments)
  }, [commentsKey])

  useEffect(() => () => {
    if (sizeTimer.current !== null) clearTimeout(sizeTimer.current)
    if (commentTimer.current !== null) clearTimeout(commentTimer.current)
    if (assetTimer.current !== null) clearTimeout(assetTimer.current)
  }, [])

  useEffect(() => {
    if (!doc) return
    if (!maskInit.current) {
      maskInit.current = true
      setMask((current) => ({ ...current, ...doc.mask }))
      if (!negativeFocusedRef.current) setNegative(doc.negative ?? '')
      setMaskPrompt(doc.mask?.prompt ?? '')
      setTool(doc.mode === 'layout' ? 'box' : 'brush')
    }
    // Another writer (the agent) may have changed the mask prompt; follow it
    // unless the user is typing or a local save is already on its way.
    const incomingMaskPrompt = doc.mask?.prompt ?? ''
    if (!maskPromptFocusedRef.current && !maskPromptPending.current && maskPromptTimer.current === null && incomingMaskPrompt !== maskPromptRef.current) {
      setMaskPrompt(incomingMaskPrompt)
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
    if (maskPromptTimer.current !== null) clearTimeout(maskPromptTimer.current)
    if (dragTimer.current !== null) clearTimeout(dragTimer.current)
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
            color: mask.color,
            opacity: mask.opacity,
            denoise: mask.denoise,
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
  }, [mask.feather, mask.grow, mask.color, mask.opacity, mask.denoise, sessionId])

  /** A hand-written prompt also updates the text node, so the graph and the box agree. */
  async function pushPromptToNode(current, value) {
    const workflow = current?.workflow
    const nodeId = workflow?.bindings?.prompt
    if (!nodeId || !workflow?.json || current.promptSource === 'layout') return
    const node = (workflow.json.nodes ?? []).find((entry) => String(entry.id) === String(nodeId))
    if (node === undefined || node.type === 'MOSSImageLayoutPrompt') return
    try {
      const result = await patchWorkflow(sessionId, { json: setNodeWidget(workflow.json, node.id, 'text', value) })
      if (result.doc) setDoc(result.doc)
    } catch {}
  }

  async function persistPrompt(value) {
    if (!sessionId || value === docRef.current?.prompt) return
    setSaving(true)
    try {
      const result = await savePrompt(sessionId, value, true)
      setDoc(result.doc)
      setError('')
      await pushPromptToNode(result.doc, value)
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

  async function persistNegative(value) {
    if (!sessionId || value === docRef.current?.negative) return
    try {
      const result = await saveNegative(sessionId, value)
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  function onNegativeChange(value) {
    setNegative(value)
    if (negativeTimer.current !== null) clearTimeout(negativeTimer.current)
    negativeTimer.current = setTimeout(() => persistNegative(value), 500)
  }

  function onNegativeBlur() {
    setNegativeFocused(false)
    if (negativeTimer.current !== null) clearTimeout(negativeTimer.current)
    persistNegative(negativeRef.current)
  }

  async function persistMaskPrompt(value) {
    if (!sessionId || value === (docRef.current?.mask?.prompt ?? '')) return
    maskPromptPending.current = true
    try {
      const result = await saveMaskPrompt(sessionId, value)
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    } finally {
      maskPromptPending.current = false
    }
  }

  function onMaskPromptChange(value) {
    setMaskPrompt(value)
    if (maskPromptTimer.current !== null) clearTimeout(maskPromptTimer.current)
    maskPromptTimer.current = setTimeout(() => {
      maskPromptTimer.current = null
      persistMaskPrompt(value)
    }, 450)
  }

  function onMaskPromptBlur() {
    setMaskPromptFocused(false)
    if (maskPromptTimer.current !== null) clearTimeout(maskPromptTimer.current)
    maskPromptTimer.current = null
    persistMaskPrompt(maskPromptRef.current)
  }

  /** Drag the canvas viewport height; remembered per browser. */
  function startResize(event) {
    event.preventDefault()
    const startY = event.clientY
    const wrap = event.currentTarget.parentElement?.querySelector('.ccw-canvas-wrap')
    const startHeight = stageHeight ?? Math.round(wrap?.getBoundingClientRect().height ?? 420)
    let last = startHeight
    const move = (moveEvent) => {
      last = Math.max(200, Math.min(1200, Math.round(startHeight + (moveEvent.clientY - startY))))
      setStageHeight(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      try {
        window.localStorage.setItem('ccw.stageHeight', String(last))
      } catch {}
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
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

  /** Re-read the cached model folders and node tree, and say what came back. */
  async function refreshModelList() {
    setModelsRefreshing(true)
    setModelsNote('')
    try {
      const result = await refreshModels(sessionId)
      const folders = Array.isArray(result.folders) ? result.folders.length : 0
      const nodes = typeof result.nodes === 'number' ? result.nodes : 0
      setModelsNote(t('comfy.catalogRefreshed').replace('{folders}', String(folders)).replace('{nodes}', String(nodes)))
      setError('')
    } catch (caught) {
      setError(caught.message)
    } finally {
      setModelsRefreshing(false)
    }
  }

  /** Save the workspace's ComfyUI address and reconnect with it. */
  async function saveComfyUrl() {
    const value = comfyUrlDraft.trim()
    if (value === '' || value === comfyUrl) return
    setComfyUrlSaving(true)
    try {
      const result = await saveConfig(sessionId, value)
      setComfyUrl(result.baseUrl)
      setComfyUrlDraft(result.baseUrl)
      setError('')
      await probe()
    } catch (caught) {
      setError(caught.message)
    } finally {
      setComfyUrlSaving(false)
    }
  }

  async function applyIncoming() {
    setDraft(incoming)
    setIncoming('')
    await persistPrompt(incoming)
  }

  async function recompile() {
    if (!doc) return
    const incomplete = doc.layout.items.findIndex((item) => String(item.caption ?? '').trim() === '')
    if (incomplete !== -1) {
      await selectBox(doc.layout.items[incomplete].id)
      setError(t('layout.captionRequired').replace('{n}', String(incomplete + 1)))
      return
    }
    try {
      const result = await saveLayout(sessionId, doc.layout.items)
      setDoc(result.doc)
      setDraft(result.doc.prompt)
      setError(result.doc.promptError ?? '')
    } catch (caught) {
      setError(caught.message)
    }
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

  /**
   * Commit the width/height fields, rounding to the 8-pixel grid. `live`
   * commits keep the typed text in the inputs, so debounced updates while the
   * user is still typing never rewrite the field under their cursor.
   */
  function applyCanvasSize(options = {}) {
    const live = options.live === true
    if (sizeTimer.current !== null) {
      clearTimeout(sizeTimer.current)
      sizeTimer.current = null
    }
    const rawWidth = widthInputRef.current
    const rawHeight = heightInputRef.current
    const width = Number(rawWidth ?? docRef.current?.canvas?.width ?? 1024)
    const height = Number(rawHeight ?? docRef.current?.canvas?.height ?? 1024)
    if (!live) {
      setWidthInput(null)
      setHeightInput(null)
    }
    if (!Number.isFinite(width) || !Number.isFinite(height)) return
    if (live && (width < 16 || height < 16)) return
    const nextWidth = Math.min(16384, Math.max(16, Math.round(width / 8) * 8))
    const nextHeight = Math.min(16384, Math.max(16, Math.round(height / 8) * 8))
    if (nextWidth === docRef.current?.canvas?.width && nextHeight === docRef.current?.canvas?.height) return
    setCanvasSize(nextWidth, nextHeight)
  }

  /** Debounced live commit, so the canvas resizes while the number is typed. */
  function scheduleCanvasSize() {
    if (sizeTimer.current !== null) clearTimeout(sizeTimer.current)
    sizeTimer.current = setTimeout(() => {
      sizeTimer.current = null
      applyCanvasSize({ live: true })
    }, 300)
  }

  /** Current canvas aspect ratio, used the moment the ratio lock is enabled. */
  function canvasRatio() {
    const canvasWidth = Number(docRef.current?.canvas?.width ?? 1024)
    const canvasHeight = Number(docRef.current?.canvas?.height ?? 1024)
    return canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 1
  }

  /**
   * While the ratio is locked, typing one side fills the other side with the
   * matching value, so the canvas never leaves the chosen aspect ratio.
   */
  function changeWidth(raw) {
    setWidthInput(raw)
    if (lockRatio) {
      const width = Number(raw)
      if (Number.isFinite(width) && width >= 16) {
        const ratio = ratioRef.current ?? canvasRatio()
        setHeightInput(String(snapSize(width / ratio)))
      }
    }
    scheduleCanvasSize()
  }

  function changeHeight(raw) {
    setHeightInput(raw)
    if (lockRatio) {
      const height = Number(raw)
      if (Number.isFinite(height) && height >= 16) {
        const ratio = ratioRef.current ?? canvasRatio()
        setWidthInput(String(snapSize(height * ratio)))
      }
    }
    scheduleCanvasSize()
  }

  function toggleLockRatio() {
    setLockRatio((current) => {
      const next = !current
      if (next) ratioRef.current = canvasRatio()
      try {
        window.localStorage.setItem('ccw.lockRatio', next ? '1' : '0')
      } catch {
        /* storage may be unavailable; the lock still works for this page */
      }
      return next
    })
  }

  function applyPreset(preset) {
    if (sizeTimer.current !== null) {
      clearTimeout(sizeTimer.current)
      sizeTimer.current = null
    }
    setWidthInput(null)
    setHeightInput(null)
    ratioRef.current = preset.width / preset.height
    setCanvasSize(preset.width, preset.height)
  }

  async function removeBox(id) {
    if (!id) return
    try {
      const result = await deleteBox(sessionId, id)
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  /** Delete/Backspace on a focused box row removes that row's box. */
  function handleBoxRowKey(event, id) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    event.preventDefault()
    event.stopPropagation()
    removeBox(id)
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

  /** Clipboard can be unavailable in a sandboxed desktop shell; fall back. */
  async function copyPrompt() {
    const text = draft
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        document.body.removeChild(area)
      } catch {
        setError('could not copy to the clipboard')
        return
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  /**
   * Turn the canvas tools on for this chat. The host answers with
   * `needsConfirmation` when the chat already has messages, because attaching
   * tools rewrites the request prefix and costs one full-context cache miss.
   */
  async function enableTools() {
    try {
      const result = await saveEnabled(sessionId, true)
      if (result?.needsConfirmation === true) {
        setHistoryCount({ messages: result.messages ?? 0, tokens: result.tokens ?? null })
        setModal('enable')
        return
      }
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  /** Confirmed enable: the user accepted the cache miss. */
  async function enableAnyway() {
    setModal(null)
    try {
      const result = await saveEnabled(sessionId, true, { confirm: true })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  /**
   * The appbar's ✕: close the canvas and keep the tools. Removing tools
   * rewrites the request prefix, so the chat keeps them until the user asks
   * for the explicit unload.
   */
  function closeCanvas() {
    if (closeTabAction !== null) {
      try {
        closeTabAction()
        return
      } catch (caught) {
        setError(caught.message)
      }
    }
    saveEnabled(sessionId, false).then((result) => setDoc(result.doc)).catch((caught) => setError(caught.message))
  }

  /** The deliberate exit: confirm first, then drop the tools and close the tab. */
  async function unloadAndClose() {
    setModal(null)
    unloaded.current = true
    try {
      const result = await unloadTools(sessionId)
      setDoc(result.doc)
      if (closeTabAction !== null) {
        try {
          closeTabAction()
          return
        } catch {}
      }
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function createComment(bbox) {
    try {
      const result = await saveComment(sessionId, { bbox, text: '' })
      setDoc(result.doc)
      const created = (result.doc.comments ?? []).slice(-1)[0]
      setSelectedComment(created?.id ?? null)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function commitComment(comment) {
    try {
      const result = await saveComment(sessionId, { id: comment.id, bbox: comment.bbox, text: comment.text })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  /** Typing in the comment editor is local-first and saved after a pause. */
  function editCommentText(id, text) {
    setCommentDraft({ id, text })
    if (commentTimer.current !== null) clearTimeout(commentTimer.current)
    commentTimer.current = setTimeout(() => {
      commentTimer.current = null
      setCommentDraft(null)
      updateCommentText(id, text)
    }, 600)
  }

  async function updateCommentText(id, text) {
    const comment = (docRef.current?.comments ?? []).find((item) => item.id === id)
    if (comment === undefined) return
    await commitComment({ ...comment, text })
  }

  async function deleteComment(id) {
    try {
      const result = await removeComment(sessionId, id)
      setDoc(result.doc)
      if (selectedComment === id) setSelectedComment(null)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function removeSelected() {
    if (selectedComment !== null) {
      await deleteComment(selectedComment)
      return
    }
    await removeBox(docRef.current?.selected?.id)
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
      await deleteAsset(sessionId, 'mask-brush.png')
      await deleteAsset(sessionId, 'canvas_rgba.png')
      const result = await saveCanvas(sessionId, {
        mode: 'image',
        width: bitmap.width,
        height: bitmap.height,
        image: { asset: 'canvas.png', name: file.name, width: bitmap.width, height: bitmap.height, rev: Date.now() },
        // A new image starts a new edit; the old local repaint prompt does not
        // describe it, so it goes away with the old mask.
        mask: { rev: Date.now(), hasMask: false, feather: mask.feather, grow: mask.grow, prompt: '', promptSource: 'user' },
      })
      setDoc(result.doc)
      setMaskPrompt('')
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
      await deleteAsset(sessionId, 'mask-brush.png')
      await deleteAsset(sessionId, 'canvas_rgba.png')
      const result = await saveCanvas(sessionId, { mode: 'layout', image: null, mask: { rev: Date.now(), hasMask: false, prompt: '', promptSource: 'user' } })
      setDoc(result.doc)
      setMaskPrompt('')
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

  /** Whether a drag carries at least one image file (true during dragover too). */
  function hasImageFile(transfer) {
    if (transfer === null || transfer === undefined) return false
    for (const item of Array.from(transfer.items ?? [])) {
      if (item.kind === 'file' && String(item.type).startsWith('image/')) return true
    }
    for (const file of Array.from(transfer.files ?? [])) {
      if (String(file.type).startsWith('image/')) return true
    }
    return false
  }

  function carriesFiles(transfer) {
    return transfer !== null && transfer !== undefined && Array.from(transfer.types ?? []).includes('Files')
  }

  function onStageDragEnter(event) {
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    if (dragTimer.current !== null) {
      clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    if (hasImageFile(event.dataTransfer)) setDragOver(true)
  }

  function onStageDragOver(event) {
    if (!carriesFiles(event.dataTransfer)) return
    // Swallow the browser's default (open the file), even for a non-image drop;
    // the empty state keeps showing the ordinary canvas background.
    event.preventDefault()
    if (dragTimer.current !== null) {
      clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    const image = hasImageFile(event.dataTransfer)
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = image ? 'copy' : 'none'
    if (image && !dragOver) setDragOver(true)
  }

  function onStageDragLeave() {
    // dragleave fires for every child too; clear only after the pointer stopped
    // producing dragover events over the stage.
    if (dragTimer.current !== null) clearTimeout(dragTimer.current)
    dragTimer.current = setTimeout(() => {
      dragTimer.current = null
      setDragOver(false)
    }, 140)
  }

  function onStageDrop(event) {
    const transfer = event.dataTransfer
    if (!carriesFiles(transfer)) return
    event.preventDefault()
    if (dragTimer.current !== null) {
      clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
    setDragOver(false)
    const file = Array.from(transfer?.files ?? []).find((entry) => String(entry.type).startsWith('image/'))
    if (file === undefined) {
      setError(t('image.dropUnsupported'))
      return
    }
    setError('')
    void loadImage(file)
  }

  async function setCanvasSize(nextWidth, nextHeight) {
    if (!sessionId) return
    if (!Number.isInteger(nextWidth) || !Number.isInteger(nextHeight)) return
    if (nextWidth < 16 || nextHeight < 16 || nextWidth > 16384 || nextHeight > 16384) return
    const current = docRef.current
    const previousWidth = Number(current?.canvas?.width ?? nextWidth)
    const previousHeight = Number(current?.canvas?.height ?? nextHeight)
    if (!(previousWidth > 0) || !(previousHeight > 0)) return
    const scaleX = nextWidth / previousWidth
    const scaleY = nextHeight / previousHeight
    const scaled = scaleX !== 1 || scaleY !== 1
    const scaleBbox = (bbox) => bbox.map((value, index) => Math.round(value * (index % 2 === 0 ? scaleX : scaleY)))
    const items = current?.layout?.items ?? []
    const nextItems = scaled ? items.map((item) => ({ ...item, bbox: scaleBbox(item.bbox) })) : items
    const shapes = current?.mask?.shapes ?? []
    const nextShapes = scaled ? shapes.map((shape) => ({ ...shape, bbox: scaleBbox(shape.bbox) })) : shapes
    const comments = current?.comments ?? []
    const nextComments = scaled ? comments.map((comment) => ({ ...comment, bbox: scaleBbox(comment.bbox) })) : comments
    try {
      const result = await saveCanvas(sessionId, {
        width: nextWidth,
        height: nextHeight,
        ...(scaled ? { mask: { shapes: nextShapes } } : {}),
      })
      setDoc(result.doc)
      if (scaled && items.length > 0) {
        const layoutResult = await saveLayout(sessionId, nextItems)
        setDoc(layoutResult.doc)
      }
      if (scaled) {
        for (const comment of nextComments) {
          const commentResult = await saveComment(sessionId, { id: comment.id, bbox: comment.bbox, text: comment.text })
          setDoc(commentResult.doc)
        }
      }
    } catch (caught) {
      setError(caught.message)
    }
  }

  /** Comments travel inside the exported PNG as a tEXt/iTXt chunk. */
  async function annotatePng(blob, sessionComments) {
    if (!blob || sessionComments.length === 0) return blob
    try {
      return await embedPngText(blob, 'ccw-comments', JSON.stringify(sessionComments))
    } catch {
      return blob
    }
  }

  /**
   * Comments need server-side crops so the agent can look at the exact region.
   * The canvas is the only place that can crop, so it exports one PNG per
   * comment (plus a comments.json) whenever the list changes.
   */
  async function exportCommentAssets(sessionComments) {
    if (!sessionId) return
    try {
      await uploadAsset(sessionId, 'comments.json', new Blob([JSON.stringify(sessionComments, null, 2)], { type: 'application/json' }))
    } catch {
      // Comments still live in the document; the asset copy is a convenience.
      return
    }
    if (!image || sessionComments.length === 0) return
    try {
      const response = await fetch(assetUrl(sessionId, image.asset, image.rev))
      const bitmap = await createImageBitmap(await response.blob())
      for (const comment of sessionComments) {
        const [x1, y1, x2, y2] = comment.bbox
        const width = Math.max(1, Math.round(x2 - x1))
        const height = Math.max(1, Math.round(y2 - y1))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        canvas.getContext('2d').drawImage(bitmap, x1, y1, width, height, 0, 0, width, height)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (blob !== null) await uploadAsset(sessionId, `comment-${comment.id}.png`, blob)
      }
    } catch {
      /* crops are a best-effort convenience for the agent */
    }
  }

  function scheduleCommentAssets(sessionComments) {
    if (assetTimer.current !== null) clearTimeout(assetTimer.current)
    assetTimer.current = setTimeout(() => {
      assetTimer.current = null
      exportCommentAssets(sessionComments)
      stageRef.current?.exportNow?.()
    }, 650)
  }

  async function handleMaskReady({ maskBlob, brushBlob, rgbaBlob, hasMask, shapes }) {
    if (!sessionId) return
    try {
      await uploadAsset(sessionId, 'mask.png', maskBlob)
      if (brushBlob) await uploadAsset(sessionId, 'mask-brush.png', brushBlob)
      if (rgbaBlob !== null) {
        const annotated = await annotatePng(rgbaBlob, docRef.current?.comments ?? [])
        await uploadAsset(sessionId, 'canvas_rgba.png', annotated)
      }
      const patch = { rev: Date.now(), hasMask }
      if (Array.isArray(shapes)) patch.shapes = shapes
      const result = await saveCanvas(sessionId, { mask: patch })
      setDoc(result.doc)
      setMask((current) => ({ ...current, hasMask, shapes: patch.shapes ?? current.shapes }))
    } catch (caught) {
      setError(caught.message)
    }
  }

  const workflowNodeTypes = (doc?.workflow?.json?.nodes ?? []).map((node) => String(node?.type ?? ''))
  const hasWorkflowNodes = workflowNodeTypes.length > 0
  const hasMossNodes = workflowNodeTypes.some((type) => /MOSS|CreateBoundingBoxes/i.test(type))
  // Layout boxes compile to the MOSS-Image layout schema, so the mode only
  // exists while a workflow that consumes it is loaded.
  const workflowNodes = doc?.workflow?.json?.nodes ?? []
  const mossWorkflow = workflowNodes.some((node) => node?.type === 'MOSSImageLayoutPrompt' || node?.type === 'CreateBoundingBoxes')
  const items = doc?.layout?.items ?? []
  // The whole-image description is one layout item (label summary); the
  // remaining items are the spatial boxes.
  const summaryItem = items.find((item) => item.label === 'summary') ?? null
  const summaryTaken = summaryItem !== null
  const spatialCount = items.filter((item) => item.label !== 'summary').length
  const selected = items.find((item) => item.id === doc?.selected?.id) ?? null
  const image = doc?.canvas?.image ?? null
  // The ratio chips stay highlighted whenever the canvas sits on their ratio,
  // not only on the exact preset resolution.
  const canvasWidthValue = Number(widthInput ?? doc?.canvas?.width ?? 1024)
  const canvasHeightValue = Number(heightInput ?? doc?.canvas?.height ?? 1024)
  const activePresetKey =
    canvasWidthValue > 0 && canvasHeightValue > 0
      ? CANVAS_PRESETS.find(
          (preset) => Math.abs(preset.width / preset.height - canvasWidthValue / canvasHeightValue) < 0.01,
        )?.key
      : undefined
  const imageUrl = image ? assetUrl(sessionId, image.asset, image.rev) : null
  const selectedCommentItem = comments.find((item) => item.id === selectedComment) ?? null
  const hasBoxes = items.length > 0
  const compiled = hasBoxes && doc?.promptSource === 'layout'
  const tools = tool === 'comment'
    ? [{ id: 'comment', label: t('tool.comment') }, { id: 'select', label: t('tool.select') }, { id: 'pan', label: t('tool.pan') }]
    : doc?.mode === 'layout'
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
  const canvasLabel = tool === 'comment'
    ? t('mode.comment')
    : doc?.mode === 'layout' ? t('mode.layout') : t('mode.edit')

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
          <IconButton icon="x" label={t('tab.close')} onClick={closeCanvas} className="ccw-appbar-close" />
        </div>
      </header>

      {enabled ? null : (
        <div className="ccw-notices">
          <div className="ccw-banner ccw-banner-enable" role="status">
            <Icon name="info" size={15} />
            <span>{t('enable.hint')}</span>
            <button type="button" className="ccw-btn ccw-btn-primary ccw-btn-small" onClick={enableTools}>
              {t('enable.cta')}
            </button>
          </div>
        </div>
      )}

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
              active={doc?.mode === 'image' && tool !== 'comment'}
              onClick={() => {
                setMode('image')
                if (tool === 'comment') setTool('brush')
              }}
            />
            <IconButton
              icon="layout"
              label={mossWorkflow ? t('mode.layout') : t('mode.layoutMossOnly')}
              active={doc?.mode === 'layout' && tool !== 'comment'}
              disabled={!mossWorkflow}
              onClick={() => {
                if (!mossWorkflow) return
                setMode('layout')
                if (tool === 'comment') setTool('box')
              }}
            />
            <IconButton
              icon="comment"
              label={t('mode.comment')}
              active={tool === 'comment'}
              onClick={() => {
                // Leave layout mode first: setMode resets the tool to brush.
                if (doc?.mode === 'layout') setMode('image')
                setTool('comment')
              }}
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

          <div
            className={`ccw-canvas-wrap${dragOver ? ' is-dragover' : ''}`}
            style={stageHeight === null ? undefined : { '--ccw-stage-height': `${stageHeight}px` }}
            onDragEnter={onStageDragEnter}
            onDragOver={onStageDragOver}
            onDragLeave={onStageDragLeave}
            onDrop={onStageDrop}
          >
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
              shapes={mask.shapes ?? []}
              comments={comments}
              selectedComment={selectedComment}
              onCommentCreate={createComment}
              onCommentCommit={commitComment}
              onCommentText={updateCommentText}
              onCommentSelect={setSelectedComment}
              onBoxCreate={createBox}
              onBoxCommit={commitBox}
              onBoxCaption={(box, caption) => commitBox({ ...box, caption })}
              onBoxEdit={(box, patch) => commitBox({ ...box, ...patch })}
              onBoxSelect={selectBox}
              t={t}
              onMaskReady={handleMaskReady}
              onMessage={setError}
              onDeleteKey={removeSelected}
            />
            {dragOver ? (
              <div className="ccw-dropzone" aria-hidden="true">
                <div className="ccw-dropzone-inner">
                  <Icon name="upload" size={22} />
                  <span>{t('image.drop')}</span>
                </div>
              </div>
            ) : null}
          </div>

          <div
            className="ccw-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('canvas.resize')}
            title={t('canvas.resize')}
            onPointerDown={startResize}
          />

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
          <Section
            title={t('canvasSize.title')}
            icon="maximize"
            help={t('help.canvasSize')}
            className="ccw-section-canvas"
          >
            {image ? (
              <div className="ccw-size-readout">
                <span className="ccw-size-value">{image.width} × {image.height}</span>
              </div>
            ) : (
              <>
                <div className="ccw-size-bar">
                  <div className="ccw-size-grid">
                    <label className="ccw-field ccw-size-field">
                      <span>{t('canvasSize.width')}</span>
                      <input
                        type="number"
                        min={16}
                        max={16384}
                        step={8}
                        value={widthInput ?? doc?.canvas?.width ?? 1024}
                        onChange={(event) => changeWidth(event.target.value)}
                        onBlur={() => applyCanvasSize()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') applyCanvasSize()
                        }}
                      />
                    </label>
                    <label className="ccw-field ccw-size-field">
                      <span>{t('canvasSize.height')}</span>
                      <input
                        type="number"
                        min={16}
                        max={16384}
                        step={8}
                        value={heightInput ?? doc?.canvas?.height ?? 1024}
                        onChange={(event) => changeHeight(event.target.value)}
                        onBlur={() => applyCanvasSize()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') applyCanvasSize()
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className={`ccw-ratio-lock ${lockRatio ? 'is-on' : ''}`}
                      aria-pressed={lockRatio}
                      title={t('canvasSize.lock')}
                      aria-label={t('canvasSize.lock')}
                      onClick={toggleLockRatio}
                    >
                      <Icon name="lock" size={14} />
                    </button>
                    <label className="ccw-field ccw-ratio-field">
                      <span>{t('canvasSize.presets')}</span>
                      <select
                        value={activePresetKey ?? 'custom'}
                        aria-label={t('canvasSize.presets')}
                        onChange={(event) => {
                          const preset = CANVAS_PRESETS.find((item) => item.key === event.target.value)
                          if (preset !== undefined) applyPreset(preset)
                        }}
                      >
                        <option value="custom">{t('canvasSize.custom')}</option>
                        {CANVAS_PRESETS.map((preset) => (
                          <option key={preset.key} value={preset.key}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              </>
            )}
          </Section>

          {showMaskTools ? (
            <Section
              title={t('mask.title')}
              icon="sliders"
              help={t('help.mask')}
              className="ccw-section-mask"
            >
              <MaskSliders
                brush={brush}
                setBrush={setBrush}
                mask={mask}
                setMask={setMask}
                t={t}
              />
              <label className="ccw-subfield ccw-mask-prompt">
                <span>{t('mask.prompt')}</span>
                <textarea
                  className="ccw-negative"
                  value={maskPrompt}
                  placeholder={t('mask.promptPlaceholder')}
                  spellCheck={false}
                  aria-label={t('mask.prompt')}
                  onChange={(event) => onMaskPromptChange(event.target.value)}
                  onFocus={() => setMaskPromptFocused(true)}
                  onBlur={onMaskPromptBlur}
                />
              </label>
              <p className="ccw-hint">{mask.hasMask
                ? (maskPrompt.trim() !== '' ? t('mask.promptActive') : t('mask.promptEmpty'))
                : t('mask.promptHint')}</p>
              <div className="ccw-danger-zone">
                <button type="button" className="ccw-btn ccw-btn-danger-ghost" onClick={() => stageRef.current?.clearMask()}>
                  <Icon name="eraser" size={14} />
                  <span>{t('mask.clear')}</span>
                </button>
              </div>
            </Section>
          ) : null}

          <Section
            title={t('prompt.title')}
            icon="sparkles"
            count={hasBoxes ? items.length : undefined}
            help={t('help.prompt')}
            className="ccw-section-prompt"
          >
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
            <div className="ccw-subfield">
              <span className="ccw-field-head">
                <span>{t('prompt.negative')}</span>
                <HelpTip text={t('help.negative')} />
              </span>
              <textarea
                className="ccw-negative"
                value={negative}
                placeholder={t('prompt.negativePlaceholder')}
                spellCheck={false}
                aria-label={t('prompt.negative')}
                onChange={(event) => onNegativeChange(event.target.value)}
                onFocus={() => setNegativeFocused(true)}
                onBlur={onNegativeBlur}
              />
            </div>
            {doc?.promptError ? (
              <div className="ccw-inline-error" role="alert">{doc.promptError}</div>
            ) : null}
            {hasBoxes ? (
              <div className="ccw-prompt-source">
                <span>{t('prompt.compiled').replace('{count}', String(spatialCount))}</span>
                <span className={`ccw-source-mode ${compiled ? 'is-layout' : ''}`}>
                  {compiled ? t('prompt.modeLayout') : t('prompt.manual')}
                </span>
              </div>
            ) : null}
            <div className="ccw-action-row">
              <button
                type="button"
                className="ccw-btn ccw-btn-ghost ccw-btn-small"
                onClick={copyPrompt}
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

          {mossWorkflow ? (
          <Section
            title={t('layout.title')}
            icon="layout"
            count={items.length}
            help={t('help.layout')}
            className="ccw-section-layout"
            actions={(
              <IconButton icon="plus" label={t('layout.add')} onClick={addBox} />
            )}
          >
            {hasWorkflowNodes && !hasMossNodes ? (
              <p className="ccw-hint ccw-warn-hint" role="status">
                <Icon name="alert" size={13} />
                <span>{t('layout.mossMismatch')}</span>
              </p>
            ) : null}
            {items.length > 0 && summaryItem === null ? (
              <p className="ccw-hint ccw-warn-hint" role="status">
                <Icon name="alert" size={13} />
                <span>{t('layout.summaryMissing')}</span>
              </p>
            ) : null}
            <div className="ccw-subhead-row">
              <div className="ccw-subhead">{t('layout.list')}</div>
              <span className="ccw-subhead-meta">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="ccw-hint">{t('layout.empty')}</p>
            ) : (
              <ul className="ccw-boxes">
                {items.map((item, index) => {
                  const isSelected = doc?.selected?.id === item.id
                  const missingCaption = String(item.caption ?? '').trim() === ''
                  return (
                    <li key={item.id || index} className={`ccw-box-item ${isSelected ? 'is-selected' : ''}`}>
                      <button
                        type="button"
                        className={`ccw-box-row ${isSelected ? 'is-selected' : ''} ${item.label === 'summary' ? 'is-summary' : ''}`}
                        aria-pressed={isSelected}
                        aria-expanded={isSelected}
                        title={item.caption || undefined}
                        onClick={() => selectBox(isSelected ? null : item.id)}
                        onKeyDown={(event) => handleBoxRowKey(event, item.id)}
                      >
                        <span className="ccw-box-index">{String(index + 1).padStart(2, '0')}</span>
                        <span className="ccw-box-main">
                          <span className="ccw-box-label">{t(`box.type.${item.label}`)}</span>
                          <span className={`ccw-box-caption ${missingCaption ? 'is-missing' : ''}`}>
                            {item.caption || t('layout.captionMissing')}
                          </span>
                        </span>
                        {missingCaption ? <span className="ccw-box-badge">{t('layout.captionBadge')}</span> : null}
                        <Icon name={isSelected ? 'chevronDown' : 'chevronRight'} size={13} className="ccw-box-chevron" />
                      </button>
                      {isSelected ? (
                        <BoxEditor
                          selected={item}
                          summaryExists={summaryTaken && item.label !== 'summary'}
                          updateSelected={updateSelected}
                          removeSelected={removeSelected}
                          t={t}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
          ) : (
            <Section title={t('layout.title')} icon="layout" className="ccw-section-layout">
              <p className="ccw-hint ccw-moss-gate">
                <Icon name="info" size={13} />
                <span>{t('layout.gated')}</span>
              </p>
            </Section>
          )}

          <Section
            title={t('comment.title')}
            icon="comment"
            count={comments.length}
            help={t('help.comments')}
            className="ccw-section-comment"
            actions={(
              <IconButton
                icon="plus"
                label={t('comment.add')}
                onClick={() => {
                  if (doc?.mode === 'layout') setMode('image')
                  setTool('comment')
                }}
              />
            )}
          >
            {comments.length === 0 ? (
              <p className="ccw-hint">{t('comment.empty')}</p>
            ) : (
              <ul className="ccw-comments">
                {comments.map((comment, index) => {
                  const isSelected = selectedComment === comment.id
                  const text = commentDraft !== null && commentDraft.id === comment.id ? commentDraft.text : comment.text
                  const missing = String(text ?? '').trim() === ''
                  return (
                    <li key={comment.id} className={`ccw-comment ${isSelected ? 'is-selected' : ''}`}>
                      <button
                        type="button"
                        className="ccw-comment-row"
                        aria-expanded={isSelected}
                        onClick={() => setSelectedComment(isSelected ? null : comment.id)}
                      >
                        <span className="ccw-comment-index">C{index + 1}</span>
                        <span className={`ccw-comment-source is-${comment.source}`}>
                          {comment.source === 'agent' ? t('comment.agent') : t('comment.user')}
                        </span>
                        <span className={`ccw-comment-text ${missing ? 'is-empty' : ''}`}>
                          {missing ? t('comment.emptyText') : text}
                        </span>
                      </button>
                      {isSelected ? (
                        <div className="ccw-comment-editor">
                          <textarea
                            rows={3}
                            value={text}
                            placeholder={t('comment.placeholder')}
                            aria-label={t('comment.title')}
                            onChange={(event) => editCommentText(comment.id, event.target.value)}
                          />
                          <div className="ccw-comment-actions">
                            <span className="ccw-hint">{t('comment.sourceHint')}</span>
                            <button
                              type="button"
                              className="ccw-btn ccw-btn-danger-ghost ccw-btn-small"
                              onClick={() => deleteComment(comment.id)}
                            >
                              <Icon name="trash" size={13} />
                              <span>{t('comment.delete')}</span>
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          <Section
            title={t('comfy.title')}
            icon="link"
            help={t('help.comfy')}
            className="ccw-section-comfy"
          >
            <label className="ccw-field">
              <span>{t('comfy.url')}</span>
              <input
                value={comfyUrlDraft}
                placeholder={t('comfy.placeholder')}
                spellCheck={false}
                onChange={(event) => setComfyUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') saveComfyUrl()
                }}
              />
            </label>
            <div className="ccw-inline-actions">
              <button
                type="button"
                className="ccw-btn ccw-btn-primary ccw-btn-small"
                disabled={comfyUrlSaving || comfyUrlDraft.trim() === comfyUrl}
                onClick={saveComfyUrl}
              >
                {comfyUrlSaving ? t('comfy.saving') : t('comfy.save')}
              </button>
              <button type="button" className="ccw-btn ccw-btn-small" onClick={probe}>
                {t('comfy.test')}
              </button>
              <button type="button" className="ccw-btn ccw-btn-small" disabled={modelsRefreshing} onClick={refreshModelList}>
                {modelsRefreshing ? t('comfy.catalogRefreshing') : t('comfy.refreshCatalog')}
              </button>
            </div>
            {modelsNote === '' ? null : <p className="ccw-hint">{modelsNote}</p>}
          </Section>

          <Section
            title={t('session.title')}
            icon="lock"
            help={t('help.session')}
            className="ccw-section-session"
          >
            <div className="ccw-danger-zone">
              <button type="button" className="ccw-btn ccw-btn-danger-ghost ccw-btn-small" onClick={() => setModal('unload')}>
                <Icon name="unlink" size={13} />
                <span>{t('session.unload')}</span>
              </button>
            </div>
          </Section>
        </aside>
      </div>

      {view === 'workflow' ? (
        <div className="ccw-workflow-host">
          <WorkflowView sessionId={sessionId} doc={doc} setDoc={setDoc} t={t} setError={setError} />
        </div>
      ) : null}

      {modal === null ? null : (
        <div
          className="ccw-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setModal(null)
          }}
        >
          <div className="ccw-modal" role="alertdialog" aria-modal="true" aria-labelledby="ccw-modal-title">
            <div className="ccw-modal-head">
              <Icon name="alert" size={16} />
              <h2 className="ccw-modal-title" id="ccw-modal-title">
                {modal === 'enable' ? t('enableWarning.title') : t('unload.title')}
              </h2>
            </div>
            <p className="ccw-modal-body">
              {modal === 'enable'
                ? `${t('enableWarning.body').replace('{count}', String(historyCount.messages ?? 0))}${
                    formatTokens(historyCount.tokens) === null
                      ? ''
                      : ` ${t('enableWarning.tokens').replace('{tokens}', formatTokens(historyCount.tokens))}`
                  }`
                : t('unload.body')}
            </p>
            <p className="ccw-modal-advice">
              {modal === 'enable' ? t('enableWarning.advice') : t('unload.advice')}
            </p>
            <div className="ccw-modal-actions">
              <button type="button" className="ccw-btn" onClick={() => setModal(null)}>
                {modal === 'enable' ? t('enableWarning.cancel') : t('unload.cancel')}
              </button>
              <button
                type="button"
                className={modal === 'enable' ? 'ccw-btn ccw-btn-primary' : 'ccw-btn ccw-btn-danger'}
                onClick={modal === 'enable' ? enableAnyway : unloadAndClose}
              >
                {modal === 'enable' ? t('enableWarning.confirm') : t('unload.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
