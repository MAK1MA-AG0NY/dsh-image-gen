import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from 'tldraw'
import { startCanvasSync } from '../src/client/tl/canvas-sync.js'
import { CANVAS_STATE_ROUTE, type CanvasStatePush } from '../src/shared.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function fixture(count: number) {
  const shapes = Array.from({ length: count }, (_, n) => ({ id: `shape:${n}`, type: 'image', meta: {}, props: { assetId: `asset:${n}`, w: 1024, h: 1024 } }))
  const assets = shapes.map((s, n) => ({ id: s.props.assetId, type: 'image', props: { src: `data:image/png;base64,AA${n}=`, name: `image-${n}`, w: 1024, h: 1024 } }))
  let listener: (event: unknown) => void = () => {}
  const editor = {
    id: 'editor-test', getCurrentPageShapes: () => shapes, getSelectedShapes: () => shapes,
    getSelectedShapeIds: () => shapes.map(s => s.id), getSelectionPageBounds: () => ({ w: 2048, h: 2048 }),
    getShapePageBounds: (id: string) => ({ minX: Number(id.split(':')[1]) * 1024, minY: 0, maxX: Number(id.split(':')[1]) * 1024 + 1024, maxY: 1024, w: 1024, h: 1024 }),
    getAsset: (id: string) => assets.find(a => a.id === id),
    resolveAssetUrl: async (id: string) => assets.find(a => a.id === id)?.props.src,
    store: { listen: (fn: typeof listener) => { listener = fn; return () => {} } },
    toImageDataUrl: vi.fn().mockResolvedValueOnce({ url: 'data:image/png;base64,' + 'A'.repeat(7_000_000) }).mockResolvedValue({ url: 'data:image/jpeg;base64,AQID' }),
  }
  const pushes: CanvasStatePush[] = []
  let uploads = 0
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('data:')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    if (url === CANVAS_STATE_ROUTE) {
      pushes.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }
    if (!init?.method || init.method === 'GET') return Response.json({ maxImageBytes: 5_000_000 })
    uploads++
    return Response.json({ attachment: { attachmentId: `sha256:${uploads}`, mediaType: 'image/png', bytes: 3, width: 1024, height: 1024 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { editor: editor as unknown as Editor, exportImage: editor.toImageDataUrl, pushes, fetchMock, change: () => listener({ changes: { added: {}, removed: {}, updated: { shape: [{ typeName: 'shape' }, { typeName: 'shape' }] } } }) }
}

function annotationFixture() {
  const image = { id: 'shape:image', type: 'image', meta: { galleryId: 'gallery-1' }, props: { assetId: 'asset:image', w: 1024, h: 1024 } }
  const annotation = {
    id: 'shape:annotation', type: 'geo', x: 100, y: 200,
    meta: {
      targetShapeId: image.id,
      canvasEditAnnotation: { id: 'annotation-1', kind: 'point', x: 0.25, y: 0.5, instruction: '修复此处' },
    },
    props: { geo: 'ellipse', w: 24, h: 24, assetId: null },
  }
  let listener: (event: unknown) => void = () => {}
  const asset = { id: 'asset:image', type: 'image', props: { src: 'data:image/png;base64,AA==', name: 'image', w: 1024, h: 1024 } }
  const editor = {
    id: 'editor-annotation', getCurrentPageShapes: () => [image, annotation], getSelectedShapes: () => [image],
    getSelectedShapeIds: () => [image.id], getSelectionPageBounds: () => ({ w: 1024, h: 1024 }),
    getShapePageBounds: (id: string) => id === image.id ? { minX: 0, minY: 0, maxX: 1024, maxY: 1024, w: 1024, h: 1024 } : undefined,
    getAsset: (id: string) => id === asset.id ? asset : undefined,
    resolveAssetUrl: async () => asset.props.src,
    store: { listen: (fn: typeof listener) => { listener = fn; return () => {} } },
    toImageDataUrl: vi.fn().mockResolvedValue({ url: 'data:image/png;base64,AQID' }),
  }
  const pushes: CanvasStatePush[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('data:')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    if (url === CANVAS_STATE_ROUTE) {
      pushes.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true })
    }
    if (!init?.method || init.method === 'GET') return Response.json({ maxImageBytes: 5_000_000 })
    return Response.json({ attachment: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 3, width: 1024, height: 1024 } })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { editor: editor as unknown as Editor, image, annotation, exportImage: editor.toImageDataUrl, pushes }
}

describe('canvas selection sync', () => {
  it.each([2, 4])('keeps a usable preview when %i selected images exceed the PNG budget', async count => {
    vi.useFakeTimers()
    const f = fixture(count)
    const stop = startCanvasSync(f.editor)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.pushes.some(push => push.selectionImage === 'data:image/jpeg;base64,AQID')).toBe(true)
    expect(f.exportImage.mock.calls.length).toBeGreaterThan(1)
    stop()
  })

  it('sends all four originals as durable references, independent of conversation history', async () => {
    vi.useFakeTimers()
    const f = fixture(4)
    const stop = startCanvasSync(f.editor)
    await vi.advanceTimersByTimeAsync(2000)
    const ready = [...f.pushes].reverse().find(p => p.selectionStatus === 'ready')
    expect(ready?.selection?.items?.map(item => item.attachment?.attachmentId)).toEqual(['sha256:1', 'sha256:2', 'sha256:3', 'sha256:4'])
    stop()
  })

  it('exports and summarizes linked annotations when only their image is selected', async () => {
    vi.useFakeTimers()
    const f = annotationFixture()
    const stop = startCanvasSync(f.editor)
    await vi.advanceTimersByTimeAsync(2000)

    expect(f.exportImage.mock.calls[0]?.[0]).toEqual([f.image, f.annotation])
    const ready = [...f.pushes].reverse().find(push => push.selectionStatus === 'ready')
    expect(ready?.selection?.count).toBe(1)
    expect(ready?.selection?.items).toHaveLength(1)
    expect(ready?.selectionImage).toBe('data:image/png;base64,AQID')
    expect(ready?.selection?.items?.[0]?.attachment?.attachmentId).toBe('sha256:image')
    expect(ready?.selection?.items?.[0]).toMatchObject({
      kind: 'image', shapeId: 'shape:image',
      annotations: [{ id: 'annotation-1', kind: 'point', x: 0.25, y: 0.5, instruction: '修复此处' }],
    })
    stop()
  })
})
