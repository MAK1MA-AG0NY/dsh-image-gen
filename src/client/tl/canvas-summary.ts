import type { Editor, TLShape } from 'tldraw'
import { CANVAS_MAX_PROMPT_CHARS, type CanvasEditAnnotation, type CanvasNodeKind, type CanvasNodeSummary } from '../../shared.js'

const MAX_TEXT_CHARS = 96

export function kindOf(shapeType: string): CanvasNodeKind {
  switch (shapeType) {
    case 'image': return 'image'
    case 'draw':
    case 'highlight': return 'draw'
    case 'text': return 'text'
    case 'note': return 'note'
    case 'geo': return 'geo'
    case 'arrow':
    case 'line': return 'arrow'
    case 'frame': return 'frame'
    default: return 'other'
  }
}

function richTextPreview(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string') parts.push(record.text)
    if (Array.isArray(record.content)) for (const child of record.content) visit(child)
  }
  visit(value)
  return parts.length === 0 ? undefined : parts.join(' ')
}

function previewOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length === 0 ? undefined : collapsed.slice(0, MAX_TEXT_CHARS)
}

export function annotationOf(shape: TLShape): CanvasEditAnnotation | undefined {
  const meta = shape.meta as { targetShapeId?: unknown; canvasEditAnnotation?: unknown } | undefined
  if (typeof meta?.targetShapeId !== 'string' || meta.canvasEditAnnotation === null || typeof meta.canvasEditAnnotation !== 'object') return undefined
  const value = meta.canvasEditAnnotation as Record<string, unknown>
  if (typeof value.id !== 'string' || typeof value.instruction !== 'string') return undefined
  if (value.instruction.trim().length === 0 || value.instruction.length > 200 || typeof value.x !== 'number' || typeof value.y !== 'number'
    || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) return undefined
  if (value.kind === 'region' && typeof value.width === 'number' && typeof value.height === 'number'
    && value.width > 0 && value.height > 0 && value.x + value.width <= 1 && value.y + value.height <= 1) {
    return { id: value.id, kind: 'region', x: value.x, y: value.y, width: value.width, height: value.height, instruction: value.instruction }
  }
  if ((value.kind === 'point' || value.kind === 'arrow') && value.width === undefined && value.height === undefined) {
    return { id: value.id, kind: value.kind, x: value.x, y: value.y, instruction: value.instruction }
  }
  return undefined
}

export function supportsAnnotationCoordinates(shape: TLShape): boolean {
  if (shape.type !== 'image') return false
  const props = shape.props
  return !('crop' in props && props.crop !== null && props.crop !== undefined)
    && !('flipX' in props && props.flipX === true)
    && !('flipY' in props && props.flipY === true)
}

export function describeShape(editor: Editor, shape: TLShape, includeAnnotations = false): CanvasNodeSummary {
  const node: CanvasNodeSummary = { kind: kindOf(shape.type) }
  if (shape.type === 'image') {
    if (includeAnnotations) {
      node.shapeId = String(shape.id)
      const annotations = supportsAnnotationCoordinates(shape) ? editor.getCurrentPageShapes().flatMap(annotation => {
        const meta = annotation.meta as { targetShapeId?: unknown } | undefined
        const value = annotationOf(annotation)
        return meta?.targetShapeId === shape.id && value !== undefined ? [value] : []
      }).slice(0, 16) : []
      if (annotations.length > 0) node.annotations = annotations
    }
    const meta = shape.meta as { galleryId?: unknown; attachmentId?: unknown; name?: unknown; prompt?: unknown; provider?: unknown; model?: unknown } | undefined
    const galleryId = meta?.galleryId
    if (typeof galleryId === 'string' && galleryId.length > 0) node.galleryId = galleryId
    if (typeof meta?.attachmentId === 'string' && meta.attachmentId.length > 0) node.attachmentId = meta.attachmentId
    if (typeof meta?.prompt === 'string' && meta.prompt.trim().length > 0) node.prompt = meta.prompt.replace(/\s+/g, ' ').trim().slice(0, CANVAS_MAX_PROMPT_CHARS)
    if (typeof meta?.provider === 'string' && meta.provider.length > 0) node.provider = meta.provider
    if (typeof meta?.model === 'string' && meta.model.length > 0) node.model = meta.model
    const asset = shape.props.assetId === null ? undefined : editor.getAsset(shape.props.assetId)
    const assetName = typeof meta?.name === 'string' && meta.name.length > 0
      ? meta.name : asset !== undefined && asset.type === 'image' ? asset.props.name : undefined
    if (typeof assetName === 'string' && assetName.length > 0) node.name = assetName.slice(0, 128)
    if (asset !== undefined && asset.type === 'image') {
      node.width = Math.round(asset.props.w)
      node.height = Math.round(asset.props.h)
    } else {
      node.width = Math.round(shape.props.w)
      node.height = Math.round(shape.props.h)
    }
  } else if (shape.type === 'text' || shape.type === 'note') {
    const preview = previewOf(richTextPreview(shape.props.richText))
    if (preview !== undefined) node.text = preview
    if (shape.type === 'text') node.width = Math.round(shape.props.w)
  } else if (shape.type === 'geo') {
    node.name = String(shape.props.geo)
    const preview = previewOf(richTextPreview(shape.props.richText))
    if (preview !== undefined) node.text = preview
    node.width = Math.round(shape.props.w)
    node.height = Math.round(shape.props.h)
  }
  return node
}
