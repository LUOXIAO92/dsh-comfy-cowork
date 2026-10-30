import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * In-app colour picker (saturation/value square + hue slider + hex field).
 *
 * The browser's native <input type="color"> opens an OS dialog, which is not
 * dependable inside an embedded desktop shell, so the panel is drawn with CSS
 * and a portal so it is never clipped by a scrolling inspector.
 */

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

export function hexToHsv(hex) {
  const text = String(hex ?? '').replace('#', '').trim()
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return { h: 0, s: 0, v: 0.8 }
  const r = parseInt(text.slice(0, 2), 16) / 255
  const g = parseInt(text.slice(2, 4), 16) / 255
  const b = parseInt(text.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max }
}

export function hsvToHex({ h, s, v }) {
  const c = v * s
  const hp = (h % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = v - c
  const toHex = (value) => Math.round((value + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function normalizeHex(raw) {
  const text = String(raw ?? '').trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null
  return `#${text.toLowerCase()}`
}

export function ColorField({ value, onChange, label = '', onRemove = null, t = (key) => key }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null)
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const anchorRef = useRef(null)
  const popRef = useRef(null)
  const draggingRef = useRef(null)
  const hsvRef = useRef(hsv)
  hsvRef.current = hsv

  useEffect(() => {
    const next = hexToHsv(value)
    hsvRef.current = next
    setHsv(next)
    setDraft(null)
  }, [value])

  useLayoutEffect(() => {
    if (!open || anchorRef.current === null) return
    const rect = anchorRef.current.getBoundingClientRect()
    const width = 196
    const height = 190
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const top = rect.bottom + height > window.innerHeight - 8
      ? Math.max(8, rect.top - height - 6)
      : rect.bottom + 6
    setPosition({ left, top })
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      const pop = popRef.current
      const anchor = anchorRef.current
      if (pop !== null && pop.contains(event.target)) return
      if (anchor !== null && anchor.contains(event.target)) return
      setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const apply = (next) => {
    const hex = normalizeHex(next)
    if (hex === null) return
    onChange?.(hex)
  }

  const dragColor = (event, area) => {
    const rect = area.getBoundingClientRect()
    const x = clamp01((event.clientX - rect.left) / Math.max(1, rect.width))
    const y = clamp01((event.clientY - rect.top) / Math.max(1, rect.height))
    if (draggingRef.current === 'sv') {
      const next = { ...hsvRef.current, s: x, v: 1 - y }
      hsvRef.current = next
      setHsv(next)
    } else if (draggingRef.current === 'hue') {
      const next = { ...hsvRef.current, h: Math.round(x * 359) }
      hsvRef.current = next
      setHsv(next)
    }
  }

  const startDrag = (kind) => (event) => {
    event.preventDefault()
    draggingRef.current = kind
    const target = event.currentTarget
    try {
      target.setPointerCapture?.(event.pointerId)
    } catch {}
    dragColor(event, target)
  }

  const endDrag = (event) => {
    if (draggingRef.current === null) return
    dragColor(event, event.currentTarget)
    draggingRef.current = null
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {}
    apply(hsvToHex(hsvRef.current))
  }

  const hex = normalizeHex(draft ?? value) ?? value
  const hueColor = `hsl(${Math.round(hsv.h)}, 100%, 50%)`

  return React.createElement('span', { className: 'ccw-colorfield' }, [
    React.createElement('button', {
      key: 'swatch',
      ref: anchorRef,
      type: 'button',
      className: 'ccw-colorfield-swatch',
      style: { background: value },
      'aria-label': label || t('box.palette'),
      'aria-expanded': open,
      onClick: () => setOpen((current) => !current),
    }),
    React.createElement('input', {
      key: 'hex',
      className: 'ccw-colorfield-hex',
      type: 'text',
      spellCheck: false,
      value: draft ?? value,
      'aria-label': label || t('box.palette'),
      onChange: (event) => setDraft(event.target.value),
      onBlur: (event) => {
        const next = normalizeHex(event.target.value)
        setDraft(null)
        if (next !== null) apply(next)
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') {
          const next = normalizeHex(event.target.value)
          if (next !== null) {
            setDraft(null)
            apply(next)
          }
        } else if (event.key === 'Escape') {
          setDraft(null)
        }
      },
    }),
    onRemove === null
      ? null
      : React.createElement('button', {
          key: 'remove',
          type: 'button',
          className: 'ccw-swatch-remove',
          'aria-label': t('layout.delete'),
          onClick: onRemove,
        }, '×'),
    open
      ? createPortal(
          React.createElement('div', {
            key: 'pop',
            ref: popRef,
            className: 'ccw-colorpop',
            style: { left: `${position.left}px`, top: `${position.top}px` },
            onPointerDown: (event) => event.stopPropagation(),
          }, [
            React.createElement('div', {
              key: 'sv',
              className: 'ccw-colorpop-sv',
              style: {
                background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})`,
              },
              onPointerDown: startDrag('sv'),
              onPointerMove: (event) => dragColor(event, event.currentTarget),
              onPointerUp: endDrag,
            }, React.createElement('span', {
              className: 'ccw-colorpop-handle',
              style: { left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` },
            })),
            React.createElement('div', {
              key: 'hue',
              className: 'ccw-colorpop-hue',
              onPointerDown: startDrag('hue'),
              onPointerMove: (event) => dragColor(event, event.currentTarget),
              onPointerUp: endDrag,
            }, React.createElement('span', {
              className: 'ccw-colorpop-hue-handle',
              style: { left: `${(hsv.h / 359) * 100}%` },
            })),
            React.createElement('div', { key: 'row', className: 'ccw-colorpop-row' }, [
              React.createElement('span', {
                key: 'preview',
                className: 'ccw-colorpop-preview',
                style: { background: hex },
              }),
              React.createElement('input', {
                key: 'hex',
                className: 'ccw-colorpop-hex',
                type: 'text',
                spellCheck: false,
                value: hex,
                'aria-label': t('box.palette'),
                onChange: (event) => {
                  const next = normalizeHex(event.target.value)
                  if (next !== null) {
                    setHsv(hexToHsv(next))
                    apply(next)
                  }
                },
              }),
            ]),
          ]),
          document.body,
        )
      : null,
  ])
}
