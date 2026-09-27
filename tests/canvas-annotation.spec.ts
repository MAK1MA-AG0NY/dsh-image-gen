import { describe, expect, it, vi } from 'vitest'
import { annotationArrowPlacement, annotationBoxPlacement, ANNOTATION_REGION_FILL, createAnnotationShapeId, createLockedAnnotation, deleteCanvasAnnotation, imagePointFromScreen, syncLinkedAnnotationPositions } from '../src/client/tl/canvas-annotation-panel.js'
import { canvasSyncError } from '../src/client/tl/studio-tl-canvas.js'
import type { Editor } from 'tldraw'

describe('canvas annotation bindings', () => {
  it('keeps region interiors transparent while preserving point and arrow fill styles', () => {
    expect(ANNOTATION_REGION_FILL).toBe('none')
  })

  it('shows the specific crop/flip guidance before the generic unsupported format message', () => {
    expect(canvasSyncError('annotation-image-variant-unsupported', 'zh')).toContain('裁剪或翻转')
  })

  it('uses a different stable shape id for each new annotation', () => {
    const first = createAnnotationShapeId()
    const second = createAnnotationShapeId()

    expect(first).not.toBe(second)
  })

  it('does not intercept coordinates outside the target image', () => {
    const image = { id: 'shape:image', type: 'image', props: { w: 100, h: 80 } }
    const editor = {
      screenToPage: (point: { x: number; y: number }) => point,
      getShapePageTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }),
    } as unknown as Editor

    expect(imagePointFromScreen(editor, image as never, { x: 60, y: 60 })).toEqual({ x: 0.5, y: 0.5 })
    expect(imagePointFromScreen(editor, image as never, { x: 111, y: 60 })).toBeUndefined()
  })

  it('places the arrow head at its target rather than centering the shape there', () => {
    const target = { x: 100, y: 100 }
    const arrow = annotationArrowPlacement(target, Math.PI / 2, 80, 24)

    expect(arrow).toMatchObject({ x: 112, y: 20, w: 80, h: 24, rotation: Math.PI / 2 })
    expect({
      x: arrow.x + Math.cos(arrow.rotation) * arrow.w - Math.sin(arrow.rotation) * arrow.h / 2,
      y: arrow.y + Math.sin(arrow.rotation) * arrow.w + Math.cos(arrow.rotation) * arrow.h / 2,
    }).toEqual(target)
  })

  it('maps all region corners through a rotated image transform', () => {
    const placement = annotationBoxPlacement({ x: 256, y: 160 }, Math.PI / 2, 40, 40)
    const localCorners = [[0, 0], [40, 0], [40, 40], [0, 40]]
    const corners = localCorners.map(([x, y]) => ({
      x: placement.x - y,
      y: placement.y + x,
    }))

    expect(placement).toMatchObject({ x: 276, y: 140, rotation: Math.PI / 2 })
    expect(corners).toEqual([{ x: 276, y: 140 }, { x: 276, y: 180 }, { x: 236, y: 180 }, { x: 236, y: 140 }])
  })

  it('synchronizes a locked region to all four transformed image corners', () => {
    const image = { id: 'shape:image-rotated', type: 'image', props: { w: 100, h: 80 } }
    const region = {
      id: 'shape:region', type: 'geo', x: 0, y: 0, rotation: 0,
      meta: { targetShapeId: image.id, canvasEditAnnotation: { kind: 'region', x: 0.2, y: 0.3, width: 0.4, height: 0.5 } },
      props: { w: 1, h: 1 },
    }
    const updateShapes = vi.fn()
    const editor = {
      getCurrentPageShapes: () => [image, region],
      getShapePageTransform: () => ({ a: 0, b: 1, c: -1, d: 0, e: 300, f: 120 }),
      updateShapes,
      run: (operation: () => void) => operation(),
    } as unknown as Editor

    syncLinkedAnnotationPositions(editor, new Set([image.id]))

    const placement = updateShapes.mock.calls[0]?.[0][0]
    expect(placement).toMatchObject({ x: 276, y: 140, rotation: Math.PI / 2, props: { w: 40, h: 40 } })
    const corners = [[0, 0], [40, 0], [40, 40], [0, 40]].map(([x, y]) => ({
      x: placement.x - y,
      y: placement.y + x,
    }))
    expect(corners).toEqual([{ x: 276, y: 140 }, { x: 276, y: 180 }, { x: 236, y: 180 }, { x: 236, y: 140 }])
  })

  it('creates locked annotation shapes', () => {
    const createShape = vi.fn()
    const editor = { createShape } as unknown as Editor

    createLockedAnnotation(editor, { id: createAnnotationShapeId(), type: 'geo' })

    expect(createShape.mock.calls[0]?.[0]).toMatchObject({ isLocked: true })
  })

  it('deletes locked annotations in undoable history while bypassing their lock', () => {
    const shapeId = createAnnotationShapeId()
    const deleteShapes = vi.fn()
    const run = vi.fn((operation: () => void, options?: { ignoreShapeLock?: boolean }) => {
      operation()
      return options
    })
    const editor = { run, deleteShapes } as unknown as Editor

    deleteCanvasAnnotation(editor, shapeId)

    expect(deleteShapes).toHaveBeenCalledWith([shapeId])
    expect(run.mock.calls[0]?.[1]).toEqual({ ignoreShapeLock: true })
  })

  it('skips geometry writes when annotation position is already synchronized', () => {
    const image = { id: 'shape:image', type: 'image', props: { w: 100, h: 100 } }
    const note = {
      id: 'shape:note', type: 'geo', x: 38, y: 38, rotation: 0,
      meta: { targetShapeId: image.id, canvasEditAnnotation: { x: 0.5, y: 0.5 } },
      props: { w: 24, h: 24 },
    }
    const updateShapes = vi.fn()
    const editor = {
      getCurrentPageShapes: () => [image, note],
      getShapePageTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      updateShapes,
    } as unknown as Editor

    syncLinkedAnnotationPositions(editor, new Set([image.id]))

    expect(updateShapes).not.toHaveBeenCalled()
  })

  it('updates only annotations linked to changed images', () => {
    const imageA = { id: 'shape:image-a', type: 'image', props: { w: 100, h: 100 } }
    const imageB = { id: 'shape:image-b', type: 'image', props: { w: 100, h: 100 } }
    const noteA = { id: 'shape:note-a', type: 'geo', x: 1, y: 1, rotation: 0, meta: { targetShapeId: imageA.id, canvasEditAnnotation: { x: 0.5, y: 0.5 } }, props: { w: 20, h: 20 } }
    const noteB = { id: 'shape:note-b', type: 'geo', x: 2, y: 2, rotation: 0, meta: { targetShapeId: imageB.id, canvasEditAnnotation: { x: 0.5, y: 0.5 } }, props: { w: 20, h: 20 } }
    const updateShapes = vi.fn()
    const editor = {
      getCurrentPageShapes: () => [imageA, imageB, noteA, noteB],
      getShapePageTransform: (image: { id: string }) => ({ a: 1, b: 0, c: 0, d: 1, e: image.id === imageA.id ? 10 : 50, f: 0 }),
      updateShapes,
      run: (operation: () => void) => operation(),
    } as unknown as Editor

    syncLinkedAnnotationPositions(editor, new Set([imageA.id]))

    expect(updateShapes).toHaveBeenCalledTimes(1)
    expect(updateShapes.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ id: noteA.id, x: 50, y: 40 })])
  })
})
