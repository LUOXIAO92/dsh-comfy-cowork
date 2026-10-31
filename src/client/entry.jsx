import * as React from 'react'
import css from './styles.css'
import { CanvasTab } from './CanvasTab.jsx'
import { en, ja, zh } from './locales.js'
import { BUILD, eventUrl } from './api.js'

const PACKAGE_ID = 'dsh-comfy-cowork'
const NS = 'comfy-cowork'
// The tab kind and id are persisted in session layouts; they keep their original
// spelling so a rename never strands an already-open canvas tab.
const TAB_ID = 'comfy-coworking'
const TAB_KIND = 'comfy-coworking'
const COMMAND = 'dsh-comfy-cowork'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'layout']

/**
 * Opening the canvas from a chat is what turns the plugin on for that session;
 * closing its tab turns it off again. Nothing here is global: every call names
 * one session, and the host only attaches its tools to that agent.
 */
function setEnabled(sessionId, enabled) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  fetch('/api/comfy-cowork/doc/enabled', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, enabled, source: 'user' }),
  }).catch(() => {})
}

function openCanvas(ctx, sessionId) {
  try {
    ctx.layout?.openRightbar?.(true, false)
  } catch {}
  const open = () => {
    try {
      if (typeof ctx.sidebarRight?.openTabIn === 'function' && sessionId) {
        ctx.sidebarRight.openTabIn(sessionId, TAB_KIND, {})
        return
      }
      ctx.sidebarRight?.openTab?.(TAB_KIND, {})
    } catch (error) {
      console.error('[comfy-cowork] could not open canvas tab', error)
    }
  }
  // The right sidebar adopts the session when it opens; give that one frame.
  setTimeout(open, 60)
}

/** The one pictogram the plugin owns: a frame with a painted stroke and a layout box. */
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

/**
 * The canvas belongs to one chat at a time. Follow the on-screen session's
 * document stream and turn an `openSeq` bump — what the `open_canvas` feature
 * writes — into a sidebar tab, so the agent can ask for the canvas too.
 */
function watchOpenRequests(ctx) {
  let source = null
  let watched = null
  let lastSeq = null

  const connect = (sessionId) => {
    if (sessionId === watched) return
    watched = typeof sessionId === 'string' ? sessionId : null
    lastSeq = null
    try {
      source?.close()
    } catch {}
    source = null
    if (watched === null || watched === '') return
    const streamUrl = eventUrl(watched)
    if (streamUrl === '') return
    const next = new EventSource(streamUrl)
    const onDoc = (event) => {
      try {
        const doc = JSON.parse(event.data).doc
        const seq = doc?.ui?.openSeq ?? 0
        if (lastSeq === null) {
          lastSeq = seq
        } else if (seq > lastSeq) {
          lastSeq = seq
          openCanvas(ctx, watched)
        }
      } catch {}
    }
    next.addEventListener('hello', onDoc)
    next.addEventListener('doc', onDoc)
    source = next
  }

  const mounted = ctx.sidebarRight?.mounted
  connect(mounted?.getSnapshot?.())
  const unsubscribe = mounted?.subscribe?.(() => connect(mounted.getSnapshot()))

  return () => {
    try {
      unsubscribe?.()
    } catch {}
    try {
      source?.close()
    } catch {}
  }
}

function CanvasTitle(props) {
  const t = props.t
  return React.createElement('span', { className: 'ccw-tab-title' },
    React.createElement(CanvasIcon, { size: 15 }),
    React.createElement('span', null, t('tab.title')))
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, 'en', en), 'comfy-cowork: en locale')
  ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'comfy-cowork: zh locale')
  ctx.effect(() => ctx.locale.register(NS, 'ja', ja), 'comfy-cowork: ja locale')

  // DSH ships Chinese and English only, and its fallback chain stops at a
  // language the catalog knows. Register Japanese for the plugin's own copy so
  // a Japanese reader gets it; every shell string we do not own stays English.
  try {
    const known = ctx.locale.getSnapshot?.().locales ?? []
    if (typeof ctx.locale.addLanguage === 'function' && !known.some((entry) => entry.id === 'ja')) {
      ctx.effect(() => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }), 'comfy-cowork: ja language')
    }
  } catch (error) {
    console.warn('[comfy-cowork] could not register the Japanese language', error)
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.comfyCoworking = PACKAGE_ID
    style.textContent = css
    document.head.appendChild(style)
    return () => style.remove()
  }, 'comfy-cowork: styles')

  const t = ctx.locale.bind(NS)

  // Closing the canvas tab only closes the canvas. The tools stay pinned to the
  // chat, because adding or removing them rewrites the request prefix and costs
  // one full-context cache miss. Removing them is the separate, warned action
  // inside the canvas (`/doc/unload`).
  try {
    const registerCloseHandler = ctx.sidebarRight?.registerCloseHandler
    if (typeof registerCloseHandler === 'function') {
      ctx.effect(() => registerCloseHandler.call(ctx.sidebarRight, TAB_KIND, (sessionId) => {
        setEnabled(sessionId, false)
      }), 'comfy-cowork: tab close handler')
    }
  } catch (error) {
    console.warn('[comfy-cowork] tab close handler unavailable', error)
  }

  const postHello = (extra = {}) => {
    fetch('/api/comfy-cowork/client-hello', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.1.0', build: BUILD, tabId: TAB_ID, kind: TAB_KIND, ...extra }),
    }).catch(() => {})
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    multiple: false,
    title: () => t('tab.title'),
  }), 'comfy-cowork: tab type')
  postHello({ tabType: true })

  // The whole entry surface is this one slash command: the menu row carries the
  // plugin's icon and its real name, and running it enables the chat and opens
  // the canvas. There is no composer button, because the plugin has no short
  // caption of its own and the command is already the discoverable way in.
  ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => scope.commandUi.register({
      name: COMMAND,
      label: () => t('command.label'),
      description: () => t('command.description'),
      icon: CanvasIcon,
      available: (session) => typeof session?.sessionId === 'string' && session.sessionId !== '',
      ui: {
        kind: 'action',
        run: (session) => {
          postHello({ command: true })
          const sessionId = session?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') return
          // The tab turns the tools on when it mounts, so a chat that already
          // has history gets the cache warning before anything changes.
          openCanvas(ctx, sessionId)
        },
      },
    }), 'comfy-cowork: slash command')
  })

  ctx.effect(() => watchOpenRequests(ctx), 'comfy-cowork: open requests')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => {
    postHello({ body: true })
    return ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      locale: NS,
      inject: (sessionId) => ({ sessionId, t: ctx.locale.bind(NS) }),
    }, CanvasTab)
  }), 'comfy-cowork: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => {
    postHello({ title: true })
    return ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TAB_ID,
      locale: NS,
      inject: () => ({ t: ctx.locale.bind(NS) }),
    }, CanvasTitle)
  }), 'comfy-cowork: tab title')

  postHello({ slots: true })

  // Make the tab visible in the right sidebar's add-tab guide where supported.
  try {
    const maybeRegisterGuide = ctx.sidebarRightTabs?.registerGuide
    if (typeof maybeRegisterGuide === 'function') {
      ctx.effect(() => maybeRegisterGuide({
        id: 'comfy-cowork-guide',
        kind: TAB_KIND,
        order: 60,
        title: () => t('tab.title'),
        description: () => t('guide.description'),
      }), 'comfy-cowork: guide entry')
    }
  } catch (error) {
    console.warn('[comfy-cowork] guide entry unavailable', error)
  }
}
