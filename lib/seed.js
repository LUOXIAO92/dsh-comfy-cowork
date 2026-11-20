/**
 * Seed widgets and ComfyUI's "control after generate".
 *
 * A sampler's seed is a widget whose value lives in `widgets_values`, with a
 * UI-only control token stored directly after it (`"fixed"`, `"increment"`,
 * `"decrement"` or `"randomize"`). The front end advances that value after a
 * prompt is queued; this module reads the token and computes the next value so
 * the host can do the same, and writes both the positional and the named copy
 * back into the loaded workflow.
 */

export const CONTROL_VALUES = ['fixed', 'increment', 'decrement', 'randomize']
const CONTROL_SET = new Set(CONTROL_VALUES)

/** ComfyUI clamps every seed widget to ±2^50. */
export const SEED_MAX = 2 ** 50

/** The widget names the ComfyUI front end treats as seeds. */
const SEED_NAMES = new Set(['seed', 'noise_seed'])

function isSeedName(name) {
  return SEED_NAMES.has(name)
}

function namedValues(node) {
  const named = node?.widgets_values_named
  return named !== null && typeof named === 'object' && !Array.isArray(named) ? named : null
}

/**
 * Positional widget slots of one UI-format node.
 *
 * `widgets_values` is a flat array ordered by the node's widget inputs. A seed
 * widget is followed by its control token, which is not a widget of its own;
 * the walk consumes it without mapping it to the next input.
 *
 * @param node - one UI-format node from a workflow file.
 * @returns a Map of widget name → `{ index, value, control, controlIndex }`.
 */
export function widgetSlots(node) {
  const raw = Array.isArray(node?.widgets_values) ? node.widgets_values : []
  const slots = new Map()
  let index = 0
  for (const input of node?.inputs ?? []) {
    if (input?.widget === undefined) continue
    const name = input.widget.name ?? input.name
    if (index >= raw.length) break
    const value = raw[index]
    const slot = { index, value: undefined, control: null, controlIndex: -1 }
    index += 1
    // A standalone control token belongs to the preceding seed widget; it was
    // already attached there and must not become a widget value.
    if (typeof value === 'string' && CONTROL_SET.has(value)) continue
    slot.value = value
    slots.set(name, slot)
    if (isSeedName(name) && typeof raw[index] === 'string' && CONTROL_SET.has(raw[index])) {
      slot.control = raw[index]
      slot.controlIndex = index
      index += 1
    }
  }
  return slots
}

/**
 * Every seed widget a run would use, in document order.
 *
 * A widget whose input is driven by a link is skipped: its value does not reach
 * the prompt, so nothing is generated from it. Muted and bypassed nodes are
 * skipped for the same reason. A workflow without a control token gets
 * ComfyUI's default (`randomize`), which is what its own canvas would show.
 *
 * @param workflow - UI-format workflow (`{ nodes, links }`), not an API prompt.
 * @returns `{ nodeId, name, value, control, valueIndex, controlIndex }`.
 */
export function seedWidgetsOf(workflow) {
  if (!Array.isArray(workflow?.nodes)) return []
  const result = []
  for (const node of workflow.nodes) {
    if (node === null || typeof node !== 'object') continue
    if (node.mode === 2 || node.mode === 4) continue
    const slots = widgetSlots(node)
    const named = namedValues(node)
    const seen = new Set()
    for (const input of node.inputs ?? []) {
      if (input?.widget === undefined) continue
      const name = input.widget.name ?? input.name
      if (!isSeedName(name) || seen.has(name)) continue
      if (input.link !== null && input.link !== undefined) continue
      const slot = slots.get(name)
      const value = named !== null && Object.prototype.hasOwnProperty.call(named, name) ? named[name] : slot?.value
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      seen.add(name)
      result.push({
        nodeId: String(node.id),
        name,
        value,
        control: slot?.control ?? 'randomize',
        valueIndex: slot?.index ?? -1,
        controlIndex: slot?.controlIndex ?? -1,
      })
    }
  }
  return result
}

/**
 * The value a seed widget holds after this generate, following ComfyUI's
 * semantics: increment/decrement clamp to the 0…2^50 range (never wrap), and
 * randomize draws a fresh integer from it. `fixed` returns the value unchanged.
 *
 * @param value - the seed the run just used.
 * @param control - `fixed`, `increment`, `decrement` or `randomize`.
 * @param random - injectable RNG for tests.
 */
export function advanceSeedValue(value, control, random = Math.random) {
  const current = Number.isFinite(value) ? Math.max(0, Math.min(SEED_MAX, Math.round(value))) : 0
  switch (control) {
    case 'increment':
      return Math.min(SEED_MAX, current + 1)
    case 'decrement':
      return Math.max(0, current - 1)
    case 'randomize':
      return Math.floor(random() * SEED_MAX)
    default:
      return current
  }
}

/**
 * Advance seeds in the loaded workflow JSON.
 *
 * Both copies are kept in step: `widgets_values` is what ComfyUI serializes,
 * and `widgets_values_named` (when the file has it) is what the prompt
 * conversion prefers. Only the value moves; the control token stays where it
 * was, so the next run uses the same mode.
 *
 * @param workflow - the document's UI workflow JSON (mutated in place).
 * @param updates - `[{ nodeId, name, value }]` computed by the run.
 * @returns how many widget values were written.
 */
export function applySeedValues(workflow, updates) {
  if (!Array.isArray(workflow?.nodes) || !Array.isArray(updates)) return 0
  let applied = 0
  for (const update of updates) {
    const node = workflow.nodes.find((entry) => entry !== null && typeof entry === 'object' && String(entry.id) === String(update.nodeId))
    if (node === undefined) continue
    const slot = widgetSlots(node).get(update.name)
    const named = namedValues(node)
    let wrote = false
    if (slot !== undefined && Array.isArray(node.widgets_values) && slot.index < node.widgets_values.length) {
      node.widgets_values[slot.index] = update.value
      wrote = true
    }
    if (named !== null && Object.prototype.hasOwnProperty.call(named, update.name)) {
      named[update.name] = update.value
      wrote = true
    }
    if (wrote) applied += 1
  }
  return applied
}
