import React from 'react'
import { createRoot } from 'react-dom/client'
import { CanvasStage } from '../../src/client/CanvasStage.jsx'

function Harness() {
  const stageRef = React.useRef(null)
  const [message, setMessage] = React.useState('waiting')
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const wrap = document.querySelector('.ccw-stage-wrap')
      if (!wrap) { setMessage('no stage'); return }
      const rect = wrap.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const fire = (type, x, y) => wrap.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true,
      }))
      fire('pointerdown', cx - 80, cy)
      fire('pointermove', cx + 80, cy)
      fire('pointerup', cx + 80, cy)
      setMessage('dispatched')
    }, 300)
    return () => clearTimeout(timer)
  }, [])
  return React.createElement('div', { style: { width: 560, height: 560, padding: 10, background: '#111820' } },
    React.createElement('div', { style: { position: 'relative', width: 520, height: 520 } },
      React.createElement(CanvasStage, {
        ref: stageRef,
        sessionId: 'session-test',
        imageUrl: null,
        width: 512,
        height: 512,
        tool: 'brush',
        brush: { size: 64 },
        maskSettings: { feather: 8, grow: 0, color: '#ff3b30', opacity: 0.45 },
        boxes: [],
        selectedId: null,
        onMaskReady: (result) => {
          window.__maskReady = result
          setMessage(`ready hasMask=${result.hasMask} maskBytes=${result.maskBlob.size}`)
        },
        onMessage: (error) => setMessage(`error ${error}`),
      })),
    React.createElement('pre', { id: 'log' }, message))
}
createRoot(document.getElementById('root')).render(React.createElement(Harness))
