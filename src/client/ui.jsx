import * as React from 'react'

/**
 * Small presentational primitives shared by the canvas and workflow panes.
 *
 * Icons are hand-built 24px Lucide-style outlines. They inherit `currentColor`
 * and stay decorative unless the surrounding control supplies a label.
 */
const ICONS = {
  image: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    ['circle', { cx: 8.5, cy: 8.5, r: 1.5 }],
    ['path', { d: 'm21 15-5-5L5 21' }],
  ],
  workflow: [
    ['rect', { x: 3, y: 3, width: 6, height: 6, rx: 1.5 }],
    ['rect', { x: 15, y: 15, width: 6, height: 6, rx: 1.5 }],
    ['rect', { x: 15, y: 3, width: 6, height: 6, rx: 1.5 }],
    ['path', { d: 'M9 6h6' }],
    ['path', { d: 'M18 9v6' }],
    ['path', { d: 'M6 9v6a3 3 0 0 0 3 3h6' }],
  ],
  layout: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    ['path', { d: 'M3 9h18' }],
    ['path', { d: 'M9 21V9' }],
  ],
  layers: [
    ['path', { d: 'm12 3 9 5-9 5-9-5 9-5Z' }],
    ['path', { d: 'm3 12 9 5 9-5' }],
    ['path', { d: 'm3 16 9 5 9-5' }],
  ],
  brush: [
    ['path', { d: 'M9.5 14.5 4 20v-4.5l5.5-5.5' }],
    ['path', { d: 'm14.5 4.5-5 5 5 5 5-5a3.54 3.54 0 0 0-5-5Z' }],
    ['path', { d: 'M4 20c2.5 0 4.5-1 4.5-3.5S6.5 14 5.5 14' }],
  ],
  eraser: [
    ['path', { d: 'm7 21-4.3-4.3a1.7 1.7 0 0 1 0-2.4L14 3a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L9 21' }],
    ['path', { d: 'M22 21H7' }],
    ['path', { d: 'm5 11 9 9' }],
  ],
  square: [
    ['rect', { x: 4, y: 4, width: 16, height: 16, rx: 1.5 }],
  ],
  box: [
    ['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 1.5, strokeDasharray: '3 3' }],
    ['path', { d: 'M8 8h8v8H8z' }],
  ],
  circle: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
  ],
  pointer: [
    ['path', { d: 'M5 3.5 19 11l-6.2 1.8L10 19 5 3.5Z' }],
  ],
  hand: [
    ['path', { d: 'M18 11V6a2 2 0 0 0-4 0v5' }],
    ['path', { d: 'M14 10V4a2 2 0 0 0-4 0v6' }],
    ['path', { d: 'M10 10.5V6a2 2 0 0 0-4 0v8' }],
    ['path', { d: 'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15' }],
  ],
  undo: [
    ['path', { d: 'M9 14 4 9l5-5' }],
    ['path', { d: 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11' }],
  ],
  redo: [
    ['path', { d: 'm15 14 5-5-5-5' }],
    ['path', { d: 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13' }],
  ],
  maximize: [
    ['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }],
    ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
    ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }],
    ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }],
  ],
  zoomIn: [
    ['circle', { cx: 11, cy: 11, r: 7.5 }],
    ['path', { d: 'm21 21-4.35-4.35' }],
    ['path', { d: 'M11 8v6' }],
    ['path', { d: 'M8 11h6' }],
  ],
  zoomOut: [
    ['circle', { cx: 11, cy: 11, r: 7.5 }],
    ['path', { d: 'm21 21-4.35-4.35' }],
    ['path', { d: 'M8 11h6' }],
  ],
  upload: [
    ['path', { d: 'M12 16V3' }],
    ['path', { d: 'm7 8 5-5 5 5' }],
    ['path', { d: 'M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4' }],
  ],
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }],
    ['path', { d: 'm19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
    ['path', { d: 'M10 11v6' }],
    ['path', { d: 'M14 11v6' }],
  ],
  copy: [
    ['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
  ],
  check: [
    ['path', { d: 'm20 6-11 11-5-5' }],
  ],
  chevronDown: [
    ['path', { d: 'm6 9 6 6 6-6' }],
  ],
  chevronRight: [
    ['path', { d: 'm9 18 6-6-6-6' }],
  ],
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }],
  ],
  minus: [
    ['path', { d: 'M5 12h14' }],
  ],
  refresh: [
    ['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }],
    ['path', { d: 'M21 3v6h-6' }],
  ],
  play: [
    ['path', { d: 'm7 4 13 8-13 8V4Z' }],
  ],
  stop: [
    ['rect', { x: 5, y: 5, width: 14, height: 14, rx: 1.5 }],
  ],
  save: [
    ['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z' }],
    ['path', { d: 'M17 21v-8H7v8' }],
    ['path', { d: 'M7 3v5h8' }],
  ],
  folder: [
    ['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z' }],
  ],
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
  ],
  unlink: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }],
    ['path', { d: 'm3 3 18 18' }],
  ],
  comment: [
    ['path', { d: 'M20 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4v4l5-4h7a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z' }],
    ['path', { d: 'M8 9h8' }],
    ['path', { d: 'M8 12.5h5' }],
  ],
  lock: [
    ['rect', { x: 4, y: 10, width: 16, height: 11, rx: 2 }],
    ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }],
  ],
  sliders: [
    ['path', { d: 'M4 21v-7' }],
    ['path', { d: 'M4 10V3' }],
    ['path', { d: 'M12 21v-9' }],
    ['path', { d: 'M12 8V3' }],
    ['path', { d: 'M20 21v-5' }],
    ['path', { d: 'M20 12V3' }],
    ['path', { d: 'M1 14h6' }],
    ['path', { d: 'M9 8h6' }],
    ['path', { d: 'M17 16h6' }],
  ],
  sparkles: [
    ['path', { d: 'm12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z' }],
    ['path', { d: 'm19 15 .9 2.1 2.1.9-2.1.9L19 21l-.9-2.1-2.1-.9 2.1-.9L19 15Z' }],
    ['path', { d: 'm5 15 .7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15Z' }],
  ],
  circleSlash: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'm5.6 5.6 12.8 12.8' }],
  ],
  eyeOff: [
    ['path', { d: 'M10.7 5.1A10.9 10.9 0 0 1 12 5c7 0 10 7 10 7a17.8 17.8 0 0 1-3.2 3.9' }],
    ['path', { d: 'M6.6 6.6C3.6 8.3 2 12 2 12s3 7 10 7c1.6 0 3-.35 4.3-.9' }],
    ['path', { d: 'M9.9 9.9a3 3 0 0 0 4.2 4.2' }],
    ['path', { d: 'm2 2 20 20' }],
  ],
  imageOff: [
    ['path', { d: 'M3 3h18v18H3z' }],
    ['path', { d: 'm3 3 18 18' }],
    ['path', { d: 'm21 15-5-5L5 21' }],
  ],
  cornerDownLeft: [
    ['path', { d: 'm9 10-5 5 5 5' }],
    ['path', { d: 'M20 4v7a4 4 0 0 1-4 4H4' }],
  ],
  alert: [
    ['path', { d: 'M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 11v5' }],
    ['path', { d: 'M12 8h.01' }],
  ],
  dot: [
    ['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor', stroke: 'none' }],
  ],
}

export function Icon({ name, size = 16, className = '', strokeWidth = 1.5 }) {
  const children = ICONS[name] ?? ICONS.image
  return React.createElement('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    className: `ccw-icon ${className}`.trim(),
    'aria-hidden': 'true',
    focusable: 'false',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, children.map(([tag, attrs], index) => React.createElement(tag, { ...attrs, key: index })))
}

export function IconButton({
  icon,
  label,
  title,
  active,
  className = '',
  size = 16,
  type = 'button',
  ...rest
}) {
  return React.createElement('button', {
    ...rest,
    type,
    className: `ccw-iconbtn ${active ? 'is-active' : ''} ${className}`.trim(),
    title: title ?? label,
    'aria-label': label,
    'aria-pressed': active === undefined ? undefined : active,
  }, React.createElement(Icon, { name: icon, size }))
}

export function Section({
  title,
  icon,
  count,
  actions,
  children,
  defaultOpen = true,
  className = '',
  bodyClassName = '',
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return React.createElement('section', { className: `ccw-section ${open ? 'is-open' : 'is-collapsed'} ${className}`.trim() },
    React.createElement('div', { className: 'ccw-section-head' },
      React.createElement('button', {
        type: 'button',
        className: 'ccw-section-toggle',
        'aria-expanded': open,
        title,
        onClick: () => setOpen((value) => !value),
      },
      React.createElement(Icon, { name: 'chevronDown', size: 14, className: 'ccw-chevron' }),
      icon ? React.createElement(Icon, { name: icon, size: 14, className: 'ccw-section-icon' }) : null,
      React.createElement('span', { className: 'ccw-section-title' }, title),
      count !== undefined && count !== null
        ? React.createElement('span', { className: 'ccw-count' }, String(count))
        : null),
      actions ? React.createElement('div', { className: 'ccw-section-actions' }, actions) : null),
    open ? React.createElement('div', { className: `ccw-section-body ${bodyClassName}`.trim() }, children) : null)
}
