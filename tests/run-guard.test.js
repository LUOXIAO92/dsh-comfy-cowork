import test from 'node:test'
import assert from 'node:assert/strict'
import { maskGuard } from '../lib/run.js'

test('does nothing when no mask is painted', () => {
  assert.deepEqual(maskGuard({ painted: false, hasImage: true, hasMask: false, agent: true }), { error: null, note: null })
})

test('does nothing when the workflow has an inpaint node', () => {
  assert.deepEqual(maskGuard({ painted: true, hasImage: true, hasMask: true, agent: true }), { error: null, note: null })
})

test('refuses an agent run that would silently drop the painted mask', () => {
  const verdict = maskGuard({ painted: true, hasImage: true, hasMask: false, agent: true })
  assert.match(verdict.error, /no inpaint node/)
  assert.match(verdict.error, /ignore_mask/)
  assert.equal(verdict.note, null)
})

test('records a note for a pure generation graph instead of refusing', () => {
  const verdict = maskGuard({ painted: true, hasImage: false, hasMask: false, agent: true })
  assert.equal(verdict.error, null)
  assert.match(verdict.note, /not used/)
})

test('lets an explicit ignore_mask through with a note', () => {
  const verdict = maskGuard({ painted: true, hasImage: true, hasMask: false, agent: true, ignoreMask: true })
  assert.equal(verdict.error, null)
  assert.match(verdict.note, /not used/)
})

test('human runs are never refused, only noted', () => {
  const verdict = maskGuard({ painted: true, hasImage: true, hasMask: false, agent: false })
  assert.equal(verdict.error, null)
  assert.match(verdict.note, /not used/)
})
