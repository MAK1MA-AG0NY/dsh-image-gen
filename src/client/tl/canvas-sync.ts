/**
 * Live canvas-state sync from one tldraw surface to the host mirror.
 *
 * The conversation agent runs in the host process and cannot see the browser
 * canvas, so this module is the canvas's voice: it watches the editor store,
 * summarizes the page (shape inventory + selection) and pushes a compact
 * snapshot to the canvas-state route. When the selection settles, it also
 * exports a fallback PNG screenshot (persistent images may come from a
 * different conversation), which the host
 * turns into a durable attachment (view_canvas / edit_image
 * source=canvas_selection read exactly that).
 *
 * Pushes are fire-and-forget: failures warn in the console and the next
 * change retries. Duplicate snapshots (e.g. camera pans that change nothing
 * in the summary) never hit the network.
 */
import type { Editor } from 'tldraw'
import { CANVAS_MAX_NODES, CANVAS_MAX_SELECTION_ITEMS, CANVAS_MAX_SELECTION_KINDS, CANVAS_STATE_ROUTE, type CanvasNodeKind, type CanvasNodeSummary, type CanvasStatePush } from '../../shared.js'
import { exportSelectionPreview, readCanvasImageLimit, syncCanvasOriginal, type CanvasOriginalCacheEntry } from './canvas-selection.js'
import { annotationOf, describeShape, kindOf, supportsAnnotationCoordinates } from './canvas-summary.js'

/** Debounce for ordinary document/session changes. */
const STATE_DEBOUNCE_MS = 600
/** Extra settle time before an expensive selection screenshot export. */
const SELECTION_EXPORT_DELAY_MS = 1200

interface CanvasSummary {
  nodeCount: number
  nodes: CanvasNodeSummary[]
  selectionCount: number
  selectionKinds: CanvasNodeKind[]
  /** Identity list of the selected shapes, capped at the selection-items limit. */
  selectionItems: CanvasNodeSummary[]
  /** Stable key over the summarized state; unchanged key = no HTTP push. */
  stateKey: string
  /** Stable key over just the selection; a change re-arms the screenshot export. */
  selectionKey: string
}

function summarize(editor: Editor): CanvasSummary {
  const shapes = editor.getCurrentPageShapes()
  const nodes: CanvasNodeSummary[] = []
  for (const shape of shapes.slice(0, CANVAS_MAX_NODES)) {
    nodes.push(describeShape(editor, shape))
  }

  const selected = editor.getSelectedShapes()
  const selectionKinds = [...new Set(selected.map(shape => kindOf(shape.type)))].slice(0, CANVAS_MAX_SELECTION_KINDS)
  const selectionItems = selected.slice(0, CANVAS_MAX_SELECTION_ITEMS).map(shape => describeShape(editor, shape, true))
  const selectionKey = selectionKeyOf(editor)
  return {
    nodeCount: shapes.length,
    nodes,
    selectionCount: selected.length,
    selectionKinds,
    selectionItems,
    // selectionItems must join the key: a selected shape beyond the
    // CANVAS_MAX_NODES truncation leaves no trace in `nodes`, so editing its
    // content would otherwise change nothing here and the push never fires.
    stateKey: JSON.stringify([shapes.length, nodes, selectionKinds, selected.length, selectionItems, selectionKey]),
    selectionKey,
  }
}

/**
 * Selection identity key: sorted shape ids joined with '|', 'none' when the
 * selection is empty. Both the hot listener path and `summarize()` call this
 * one function, so the two can never disagree on "did the selection change".
 */
function selectionKeyOf(editor: Editor): string {
  const ids = editor.getSelectedShapeIds().map(String).sort().join('|')
  return ids.length === 0 ? 'none' : ids
}

/**
 * Start mirroring one editor into the host canvas-state route.
 * Returns a disposer that stops listening and marks the instance offline.
 */
export interface CanvasSyncStatus {
  phase: 'idle' | 'preparing' | 'ready' | 'error'
  count: number
  error?: string
}

export type CanvasSyncHandle = (() => void) & { retry(): void }

export function startCanvasSync(editor: Editor, onStatus: (status: CanvasSyncStatus) => void = () => {}): CanvasSyncHandle {
  // A fresh sync instance (including after clear) must not reuse sequence ids.
  const clientInstance = `${String(editor.id).slice(0, 36)}-${Math.random().toString(36).slice(2, 10)}`
  let disposed = false
  let stateTimer: ReturnType<typeof setTimeout> | undefined
  let exportTimer: ReturnType<typeof setTimeout> | undefined
  let lastPushKey = ''
  let lastSelectionKey = selectionKeyOf(editor)
  let revision = 0
  let sequence = 0
  let imageLimit: number | undefined
  let inFlight = new AbortController()
  let exporting = false
  let exportAgain = false
  let prepared: Pick<CanvasStatePush, 'selectionImage' | 'selectionError' | 'selectionStatus'> = {}
  const originalCache = new Map<string, CanvasOriginalCacheEntry>()
  let preparedItems: CanvasNodeSummary[] | undefined

  const stopListening = editor.store.listen(event => {
    if (disposed) return
    const key = selectionKeyOf(editor)
    // Camera/hover changes need no export; edits to shapes/assets do, even
    // when the selected ids stay the same (drawing, cropping, moving, undo).
    const changes = event.changes
    const documentChanged = [...Object.values(changes.added), ...Object.values(changes.removed), ...Object.values(changes.updated).map(pair => pair[1])]
      .some(record => record.typeName === 'shape' || record.typeName === 'asset' || record.typeName === 'page')
    if (key !== lastSelectionKey || documentChanged) {
      lastSelectionKey = key
      invalidate()
    }
    if (stateTimer === undefined) {
      stateTimer = setTimeout(() => {
        stateTimer = undefined
        void pushState()
      }, STATE_DEBOUNCE_MS)
    }
  }, { source: 'all', scope: 'all' })

  function invalidate(): void {
    revision++
    inFlight.abort()
    inFlight = new AbortController()
    prepared = {}
    preparedItems = undefined
    const count = editor.getSelectedShapeIds().length
    onStatus({ phase: count > 0 ? 'preparing' : 'idle', count })
    if (exportTimer !== undefined) clearTimeout(exportTimer)
    if (count > 0) exportTimer = setTimeout(() => { exportTimer = undefined; void prepare() }, SELECTION_EXPORT_DELAY_MS)
  }

  async function pushState(force = false): Promise<void> {
    if (disposed) return
    const currentRevision = revision
    const summary = summarize(editor)
    const key = `${revision}:${summary.stateKey}`
    if (!force && key === lastPushKey) return
    const payload: CanvasStatePush = {
      clientInstance,
      connected: true,
      nodeCount: summary.nodeCount,
      nodes: summary.nodes,
      selection: { count: summary.selectionCount, kinds: summary.selectionKinds, items: preparedItems ?? summary.selectionItems },
      selectionRevision: String(revision),
      ...(summary.selectionCount > 0 ? { selectionStatus: 'preparing' as const } : {}),
      ...prepared,
      sequence: ++sequence,
      updatedAt: Date.now(),
    }
    const requestSequence = sequence
    try {
      const response = await fetch(CANVAS_STATE_ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([inFlight.signal, AbortSignal.timeout(30_000)]),
      })
      if (!response.ok) throw new Error(`state-sync-failed (${response.status})`)
      if (disposed || revision !== currentRevision || sequence !== requestSequence) return
      lastPushKey = key
      onStatus({ phase: payload.selectionStatus ?? 'idle', count: summary.selectionCount, ...(payload.selectionError ? { error: payload.selectionError } : {}) })
    } catch (error) {
      if (disposed || revision !== currentRevision || sequence !== requestSequence) return
      lastPushKey = ''
      onStatus({ phase: 'error', count: summary.selectionCount, error: error instanceof Error ? error.message : 'state-sync-failed' })
    }
  }

  async function prepare(): Promise<void> {
    if (disposed) return
    if (exporting) { exportAgain = true; return }
    exporting = true
    const currentRevision = revision
    const signal = AbortSignal.any([inFlight.signal, AbortSignal.timeout(30_000)])
    const shapes = editor.getSelectedShapes()
    const items = shapes.slice(0, CANVAS_MAX_SELECTION_ITEMS).map(shape => describeShape(editor, shape, true))
    const exportShapes = [...shapes]
    for (const image of shapes) {
      if (image.type !== 'image') continue
      const linked = editor.getCurrentPageShapes().filter(shape => {
        const meta = shape.meta as { targetShapeId?: unknown } | undefined
        return meta?.targetShapeId === image.id && annotationOf(shape) !== undefined
      }).slice(0, 16)
      for (const annotation of linked) if (!exportShapes.some(shape => shape.id === annotation.id)) exportShapes.push(annotation)
    }
    let selectionImage: string | undefined
    let failure: string | undefined
    try {
      if (shapes.some(image => image.type === 'image' && !supportsAnnotationCoordinates(image)
        && editor.getCurrentPageShapes().some(annotation => {
          const meta = annotation.meta as { targetShapeId?: unknown } | undefined
          return meta?.targetShapeId === image.id && annotationOf(annotation) !== undefined
        }))) throw new Error('annotation-image-variant-unsupported')
      imageLimit ??= await readCanvasImageLimit(signal)
      try {
        selectionImage = await exportSelectionPreview(editor, exportShapes, imageLimit, signal)
      } catch (error) {
        signal.throwIfAborted()
        failure = error instanceof Error ? error.message : 'preview-export-failed'
      }
      if (shapes.length > CANVAS_MAX_SELECTION_ITEMS && shapes.some(shape => shape.type === 'image')) throw new Error('too-many-selected-shapes')
      // Sequential uploads bound peak memory; each cached asset is reused on
      // re-selection. No dependency on the currently open conversation.
      for (const [index, shape] of shapes.entries()) {
        signal.throwIfAborted()
        if (shape.type !== 'image') continue
        const item = items[index]
        if (item === undefined) continue
        const attachment = await syncCanvasOriginal(editor, shape, imageLimit, signal, originalCache)
        item.attachment = attachment
        item.attachmentId = attachment.attachmentId
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : 'selection-sync-failed'
    } finally {
      exporting = false
    }
    if (!disposed && revision === currentRevision) {
      preparedItems = items
      prepared = {
        selectionStatus: failure === undefined ? 'ready' : 'error',
        ...(failure === undefined ? {} : { selectionError: failure.slice(0, 300) }),
        ...(selectionImage === undefined ? {} : { selectionImage }),
      }
      await pushState(true)
    }
    if (exportAgain && !disposed) { exportAgain = false; void prepare() }
  }

  invalidate()
  stateTimer = setTimeout(() => { stateTimer = undefined; void pushState() }, STATE_DEBOUNCE_MS)

  const stop = (): void => {
    if (disposed) return
    disposed = true
    if (stateTimer !== undefined) clearTimeout(stateTimer)
    if (exportTimer !== undefined) clearTimeout(exportTimer)
    stopListening()
    inFlight.abort()
    originalCache.clear()
    // Best-effort offline marker; keepalive lets it survive the unload path.
    void fetch(CANVAS_STATE_ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ clientInstance, connected: false, nodeCount: 0, sequence: ++sequence, updatedAt: Date.now() }),
    }).catch(() => {})
  }
  return Object.assign(stop, { retry: () => { invalidate(); void pushState(true) } })
}
