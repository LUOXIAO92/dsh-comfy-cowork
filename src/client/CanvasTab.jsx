import React, { useEffect, useMemo, useRef, useState } from 'react'
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

function useDoc(sessionId, setError) {
  const [doc, setDoc] = useState(null)
  const [status, setStatus] = useState('connecting')

  useEffect(() => {
    if (!sessionId) return undefined
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
    const source = new EventSource(eventUrl(sessionId))
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

function Slider({ label, value, min, max, step = 1, onChange, suffix = '' }) {
  return React.createElement('label', { className: 'ccw-slider' },
    React.createElement('span', { className: 'ccw-slider-label' }, label),
    React.createElement('input', {
      type: 'range', min, max, step, value,
      onChange: (event) => onChange(Number(event.target.value)),
    }),
    React.createElement('span', { className: 'ccw-slider-value' }, `${value}${suffix}`))
}

function ToolButton({ active, onClick, children, title }) {
  return React.createElement('button', {
    type: 'button',
    className: `ccw-tool-btn ${active ? 'is-active' : ''}`,
    onClick,
    title,
  }, children)
}

function MaskSliders({ brush, setBrush, mask, setMask, t, onClear }) {
  return React.createElement('section', { className: 'ccw-tools-row' },
    React.createElement('div', { className: 'ccw-tools-col' },
      React.createElement(Slider, {
        label: t('brush.size'), value: brush.size, min: 1, max: 400,
        onChange: (value) => setBrush((current) => ({ ...current, size: value })),
      }),
      React.createElement(Slider, {
        label: t('brush.hardness'), value: Math.round(brush.hardness * 100), min: 0, max: 100,
        onChange: (value) => setBrush((current) => ({ ...current, hardness: value / 100 })), suffix: '%',
      }),
      React.createElement(Slider, {
        label: t('brush.opacity'), value: Math.round(brush.opacity * 100), min: 1, max: 100,
        onChange: (value) => setBrush((current) => ({ ...current, opacity: value / 100 })), suffix: '%',
      })),
    React.createElement('div', { className: 'ccw-tools-col' },
      React.createElement(Slider, {
        label: t('mask.feather'), value: mask.feather, min: 0, max: 128,
        onChange: (value) => setMask((current) => ({ ...current, feather: value })), suffix: 'px',
      }),
      React.createElement(Slider, {
        label: t('mask.grow'), value: mask.grow, min: -128, max: 128,
        onChange: (value) => setMask((current) => ({ ...current, grow: value })), suffix: 'px',
      }),
      React.createElement('div', { className: 'ccw-row' },
        React.createElement('label', { className: 'ccw-check' },
          React.createElement('input', {
            type: 'checkbox', checked: mask.inverted,
            onChange: (event) => setMask((current) => ({ ...current, inverted: event.target.checked })),
          }),
          t('mask.invert')),
        React.createElement('label', { className: 'ccw-check' },
          React.createElement('input', {
            type: 'checkbox', checked: mask.visible,
            onChange: (event) => setMask((current) => ({ ...current, visible: event.target.checked })),
          }),
          t('mask.visible')),
        React.createElement('button', {
          type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: onClear,
        }, t('mask.clear')))))
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
  const [showMaskTools, setShowMaskTools] = useState(true)
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
    try {
      const result = await saveCanvas(sessionId, { mode })
      setDoc(result.doc)
    } catch (caught) {
      setError(caught.message)
    }
  }

  async function setCanvasSize(nextWidth, nextHeight) {
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

  if (!sessionId) return React.createElement('div', { className: 'ccw-empty' }, 'This tab needs a session.')

  const toolbar = React.createElement('div', { className: 'ccw-toolbar' },
    React.createElement('div', { className: 'ccw-segmented ccw-viewswitch' },
      React.createElement('button', {
        type: 'button', className: view === 'canvas' ? 'is-active' : '', onClick: () => setView('canvas'),
      }, t('view.canvas')),
      React.createElement('button', {
        type: 'button', className: view === 'workflow' ? 'is-active' : '', onClick: () => setView('workflow'),
      }, t('view.workflow'))),
    React.createElement('div', { className: 'ccw-segmented' },
      React.createElement('button', {
        type: 'button', className: doc?.mode === 'image' ? 'is-active' : '', onClick: () => setMode('image'),
      }, t('mode.edit')),
      React.createElement('button', {
        type: 'button', className: doc?.mode === 'layout' ? 'is-active' : '', onClick: () => setMode('layout'),
      }, t('mode.layout'))),
    tools.map((item) => React.createElement(ToolButton, {
      key: item.id, active: tool === item.id, onClick: () => setTool(item.id), title: item.label,
    }, item.label)),
    React.createElement('span', { className: 'ccw-spacer' }),
    React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: () => stageRef.current?.undo() }, '↶'),
    React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: () => stageRef.current?.redo() }, '↷'),
    React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: () => stageRef.current?.fit() }, t('canvas.fit')))

  const workflowArea = view === 'workflow'
    ? React.createElement(WorkflowView, { sessionId, doc, setDoc, t, setError })
    : null

  return React.createElement('div', { className: 'ccw-root' },
    React.createElement('header', { className: 'ccw-header' },
      React.createElement('div', { className: 'ccw-title' },
        React.createElement('span', { className: `ccw-dot ccw-dot-${status}`, title: t(`status.${status}`) }),
        React.createElement('span', null, t('tab.title')),
        saving ? React.createElement('span', { className: 'ccw-muted' }, `· ${t('unsaved')}`) : null),
      React.createElement('div', { className: 'ccw-header-actions' },
        React.createElement('span', { className: 'ccw-muted' },
          t('status.comfy'), comfy?.comfy?.connected ? ` ${comfy.comfy.version ?? ''}` : ''),
        React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: probe }, t('probe')))),
    error !== '' ? React.createElement('div', { className: 'ccw-error', role: 'alert' }, error) : null,
    probeError !== '' ? React.createElement('div', { className: 'ccw-error' }, probeError) : null,
    incoming !== ''
      ? React.createElement('div', { className: 'ccw-banner' },
          React.createElement('span', null, t('agent.updated')),
          React.createElement('button', { type: 'button', className: 'ccw-btn', onClick: applyIncoming }, t('agent.load')),
          React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: () => setIncoming('') }, '×'))
      : null,
    toolbar,
    React.createElement('section', { className: 'ccw-canvas-wrap', style: view === 'workflow' ? { display: 'none' } : undefined },
      React.createElement(CanvasStage, {
        ref: stageRef,
        sessionId,
        imageUrl,
        width: doc?.canvas?.width ?? 1024,
        height: doc?.canvas?.height ?? 1024,
        tool,
        brush,
        maskSettings: mask,
        boxes: items,
        selectedId: doc?.selected?.id ?? null,
        onBoxCreate: createBox,
        onBoxCommit: commitBox,
        onBoxSelect: selectBox,
        onMaskReady: handleMaskReady,
        onMessage: setError,
      }),
      React.createElement('div', { className: 'ccw-canvas-tools' },
        image
          ? React.createElement(React.Fragment, null,
              React.createElement('label', { className: 'ccw-btn ccw-btn-ghost ccw-file' },
                t('image.load'),
                React.createElement('input', { type: 'file', accept: 'image/*', onChange: (event) => loadImage(event.target.files?.[0]) })),
              React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: clearImage }, t('image.clear')))
          : React.createElement('label', { className: 'ccw-btn ccw-file' },
              t('image.load'),
              React.createElement('input', { type: 'file', accept: 'image/*', onChange: (event) => loadImage(event.target.files?.[0]) }))),
      React.createElement('div', { className: 'ccw-canvas-status' },
        React.createElement('span', null,
          doc?.mode === 'layout' && !image
            ? `${doc?.canvas?.width ?? '—'} × ${doc?.canvas?.height ?? '—'}`
            : image ? `${image.width} × ${image.height}` : '—'),
        image ? React.createElement('span', { className: 'ccw-muted' }, image.name ?? '') : null,
        React.createElement('span', { className: 'ccw-muted' }, mask.hasMask ? t('mask.painted') : t('mask.empty')))),
    showMaskTools && view === 'canvas'
      ? React.createElement(MaskSliders, {
          brush, setBrush, mask, setMask, t,
          onClear: () => stageRef.current?.clearMask(),
        })
      : null,
    workflowArea,
    React.createElement('section', { className: 'ccw-panel' },
      React.createElement('div', { className: 'ccw-panel-head' },
        React.createElement('h3', null, t('prompt.title')),
        React.createElement('div', { className: 'ccw-row' },
          React.createElement('button', {
            type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: async () => {
              await navigator.clipboard.writeText(draft)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            },
          }, copied ? t('prompt.copied') : t('prompt.copy')),
          React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: recompile, disabled: !hasBoxes }, t('prompt.compile')))),
      React.createElement('p', { className: 'ccw-hint' }, t('prompt.hint')),
      React.createElement('textarea', {
        className: 'ccw-prompt',
        value: draft,
        placeholder: t('prompt.placeholder'),
        spellCheck: false,
        onChange: (event) => onPromptChange(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: onPromptBlur,
      }),
      doc?.promptError ? React.createElement('div', { className: 'ccw-error' }, doc.promptError) : null,
      hasBoxes
        ? React.createElement('div', { className: 'ccw-prompt-source' },
            React.createElement('span', null, t('prompt.compiled').replace('{count}', String(items.length))),
            React.createElement('span', { className: 'ccw-muted' }, compiled ? t('prompt.modeLayout') : t('prompt.manual')))
        : null),
    doc?.mode === 'layout' && view === 'canvas'
      ? React.createElement('section', { className: 'ccw-panel ccw-layout-settings' },
          React.createElement('div', { className: 'ccw-panel-head' }, React.createElement('h3', null, t('layout.canvas'))),
          image
            ? React.createElement('div', { className: 'ccw-muted' }, `${image.width} × ${image.height}`)
            : React.createElement('div', { className: 'ccw-row' },
                React.createElement('label', { className: 'ccw-field' }, t('layout.width'),
                  React.createElement('input', {
                    type: 'number', min: 16, max: 16384, step: 16, value: doc?.canvas?.width ?? 1024,
                    onChange: (event) => setCanvasSize(Number(event.target.value), doc?.canvas?.height ?? 1024),
                  })),
                React.createElement('label', { className: 'ccw-field' }, t('layout.height'),
                  React.createElement('input', {
                    type: 'number', min: 16, max: 16384, step: 16, value: doc?.canvas?.height ?? 1024,
                    onChange: (event) => setCanvasSize(doc?.canvas?.width ?? 1024, Number(event.target.value)),
                  }))),
          React.createElement('label', { className: 'ccw-field ccw-field-wide' }, t('layout.summary'),
            React.createElement('textarea', {
              rows: 2, value: summary, placeholder: t('layout.summaryPlaceholder'),
              onChange: (event) => saveSummary(event.target.value),
            })))
      : null,
    React.createElement('section', { className: 'ccw-panel ccw-layout' },
      React.createElement('div', { className: 'ccw-panel-head' },
        React.createElement('h3', null, t('layout.title')),
        React.createElement('div', { className: 'ccw-row' },
          React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: addBox }, t('layout.add')),
          React.createElement('button', { type: 'button', className: 'ccw-btn ccw-btn-ghost', onClick: removeSelected, disabled: !doc?.selected?.id }, t('layout.delete')))),
      selected
        ? React.createElement('div', { className: 'ccw-box-editor' },
            React.createElement('div', { className: 'ccw-row' },
              React.createElement('label', { className: 'ccw-field' }, t('box.label'),
                React.createElement('select', {
                  value: selected.label,
                  onChange: (event) => updateSelected({ label: event.target.value }),
                },
                React.createElement('option', { value: 'object' }, 'object'),
                React.createElement('option', { value: 'character' }, 'character'),
                React.createElement('option', { value: 'text' }, 'text'))),
              React.createElement('span', { className: 'ccw-muted' }, selected.bbox.map((n) => Math.round(n)).join(', '))),
            React.createElement('label', { className: 'ccw-field ccw-field-wide' }, t('box.caption'),
              React.createElement('textarea', {
                rows: 2, value: selected.caption,
                onChange: (event) => updateSelected({ caption: event.target.value }),
              })),
            selected.label === 'text'
              ? React.createElement('label', { className: 'ccw-field ccw-field-wide' }, t('box.text'),
                  React.createElement('input', {
                    type: 'text', value: selected.text,
                    onChange: (event) => updateSelected({ text: event.target.value }),
                  }))
              : null)
        : null,
      items.length === 0
        ? React.createElement('p', { className: 'ccw-hint' }, t('layout.empty'))
        : React.createElement('ul', { className: 'ccw-boxes' },
            items.map((item, index) => React.createElement('li', { key: item.id || index },
              React.createElement('button', {
                type: 'button',
                className: `ccw-box-row ${doc?.selected?.id === item.id ? 'is-selected' : ''}`,
                onClick: () => selectBox(item.id),
              },
              React.createElement('span', { className: 'ccw-box-index' }, index + 1),
              React.createElement('span', { className: 'ccw-box-label' }, item.label),
              React.createElement('span', { className: 'ccw-box-caption' }, item.caption || t('layout.caption'))))))))
}
