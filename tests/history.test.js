import test from 'node:test'
import assert from 'node:assert/strict'
import { measureHistory } from '../lib/plugin.js'

test('history counts the model-visible surface, not the event log', () => {
  // A chat that was compacted keeps every old message in the log; only the
  // surface shrink is what the next request actually re-sends.
  const logEvents = Array.from({ length: 1000 }, () => ({ type: 'user/message' }))
  const session = {
    snapshotEvents: () => logEvents,
    deriveMessages: () => [{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }],
  }
  assert.deepEqual(measureHistory(session, null), { messages: 3, tokens: null })
})

test('a compacted chat reports the shorter surface and its token price', () => {
  const session = { deriveMessages: () => new Array(4) }
  const meter = { measure: () => ({ surfaceTokens: 97400 }) }
  assert.deepEqual(measureHistory(session, meter), { messages: 4, tokens: 97400 })
})

test('a missing meter or a failing measurement leaves tokens null', () => {
  const session = { deriveMessages: () => [1, 2] }
  assert.deepEqual(measureHistory(session, undefined), { messages: 2, tokens: null })
  const throwing = {
    measure() {
      throw new Error('no routed model')
    },
  }
  assert.deepEqual(measureHistory(session, throwing), { messages: 2, tokens: null })
})

test('a session without deriveMessages counts zero instead of throwing', () => {
  assert.deepEqual(measureHistory({}, null), { messages: 0, tokens: null })
  assert.deepEqual(measureHistory(undefined, null), { messages: 0, tokens: null })
})
