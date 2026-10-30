import * as React from 'react'
import css from './styles.css'
import { CanvasTab } from './CanvasTab.jsx'
import { en, zh } from './locales.js'

const PACKAGE_ID = 'dsh-comfy-coworking'
const NS = 'comfy-coworking'
const TAB_ID = 'comfy-coworking'
const TAB_KIND = 'comfy-coworking'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout']

function openCanvas(ctx, sessionId) {
  try {
    if (typeof ctx.sidebarRight?.openTabIn === 'function' && sessionId) {
      ctx.sidebarRight.openTabIn(sessionId, TAB_KIND, {})
      return
    }
    ctx.sidebarRight?.openTab?.(TAB_KIND, {})
  } catch (error) {
    console.error('[comfy-coworking] could not open canvas tab', error)
  }
}

function CanvasIcon({ size = 16 }) {
  return React.createElement('svg', {
    viewBox: '0 0 20 20',
    width: size,
    height: size,
    'aria-hidden': true,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  React.createElement('rect', { x: 2.5, y: 3, width: 15, height: 14, rx: 2.5 }),
  React.createElement('path', { d: 'M6 13.5c1.4-3.4 3.2-5.6 6-7.2' }),
  React.createElement('path', { d: 'M12.6 6.6c.9.3 1.6.9 2 1.8-1.7 2.1-3.7 3.7-6.1 4.7' }),
  React.createElement('rect', { x: 12.2, y: 11.4, width: 4.4, height: 3.2, rx: 0.6, strokeDasharray: '1.5 1.2' }))
}

function OpenCanvasButton(props) {
  const t = props.t
  return React.createElement('button', {
    type: 'button',
    className: 'ccw-icon-btn',
    title: t('composer.title'),
    onClick: () => props.onOpen?.(),
    'aria-label': t('composer.open'),
  }, React.createElement(CanvasIcon, { size: 17 }), React.createElement('span', { className: 'ccw-icon-btn-label' }, t('composer.open')))
}

function CanvasTitle(props) {
  const t = props.t
  return React.createElement('span', { className: 'ccw-tab-title' },
    React.createElement(CanvasIcon, { size: 15 }),
    React.createElement('span', null, t('tab.title')))
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, 'en', en), 'comfy-coworking: en locale')
  ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'comfy-coworking: zh locale')

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.comfyCoworking = PACKAGE_ID
    style.textContent = css
    document.head.appendChild(style)
    return () => style.remove()
  }, 'comfy-coworking: styles')

  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    multiple: false,
    title: () => t('tab.title'),
  }), 'comfy-coworking: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: NS,
    inject: (sessionId) => ({ sessionId }),
  }, CanvasTab)), 'comfy-coworking: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB_ID,
    locale: NS,
  }, CanvasTitle)), 'comfy-coworking: tab title')

  ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'comfy-canvas-open',
    order: 40,
    locale: NS,
    inject: (sessionId) => ({
      sessionId,
      onOpen: () => openCanvas(ctx, sessionId),
    }),
  }, OpenCanvasButton)), 'comfy-coworking: composer button')

  fetch('/api/comfy-coworking/client-hello', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.1.0', tabId: TAB_ID, kind: TAB_KIND, slots: true }),
  }).catch(() => {})

  // Make the tab visible in the right sidebar's add-tab guide where supported.
  try {
    const maybeRegisterGuide = ctx.sidebarRightTabs?.registerGuide
    if (typeof maybeRegisterGuide === 'function') {
      ctx.effect(() => maybeRegisterGuide({
        id: 'comfy-coworking-guide',
        kind: TAB_KIND,
        order: 60,
        title: () => t('tab.title'),
        description: () => t('composer.title'),
      }), 'comfy-coworking: guide entry')
    }
  } catch (error) {
    console.warn('[comfy-coworking] guide entry unavailable', error)
  }
}
