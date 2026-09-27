import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createShapeId, type Editor, type TLAssetId, type TLCreateShapePartial, type TLImageAsset, type TLImageShape } from 'tldraw'
import { blobToDataUrl } from '../browser-image-utils.js'
import { fetchAttachmentBlob } from '../image-cache.js'
import { CANVAS_MAX_PROMPT_CHARS } from '../../shared.js'
import type { TlLandingItem } from './tl-canvas-bridge.js'

const MAX_DISPLAY_SIDE = 380
const GRID_GAP = 40
const GRID_COLS = 3

function tlAssetIdFor(galleryId: string): TLAssetId {
  return `asset:ig-${galleryId.replace(/[^A-Za-z0-9_-]/g, '_')}` as TLAssetId
}

function displaySizeOf(attachment: ImageAttachmentRef): { w: number; h: number } {
  const width = attachment.width > 0 ? attachment.width : 512
  const height = attachment.height > 0 ? attachment.height : 512
  const scale = MAX_DISPLAY_SIDE / Math.max(width, height)
  return { w: Math.round(width * scale), h: Math.round(height * scale) }
}

function landedIdsOf(editor: Editor): Set<string> {
  const landedIds = new Set<string>()
  for (const shape of editor.store.allRecords()) {
    if (shape.typeName !== 'shape' || shape.type !== 'image') continue
    const galleryId = (shape.meta as { galleryId?: unknown } | undefined)?.galleryId
    if (typeof galleryId === 'string') landedIds.add(galleryId)
  }
  return landedIds
}

function metaPromptOf(prompt: string | undefined): string | undefined {
  if (typeof prompt !== 'string') return undefined
  const collapsed = prompt.replace(/\s+/g, ' ').trim()
  return collapsed.length === 0 ? undefined : collapsed.slice(0, CANVAS_MAX_PROMPT_CHARS)
}

export async function landTlItems(editor: Editor, items: readonly TlLandingItem[], isActive: () => boolean): Promise<boolean> {
  const landedIds = landedIdsOf(editor)
  const pending = items.filter(item => !landedIds.has(item.galleryId))
  if (pending.length === 0) return true

  const assets: TLImageAsset[] = []
  const landed: Array<{ galleryId: string; assetId: TLAssetId; w: number; h: number; attachmentId: string; name: string; fromConversation: boolean; prompt?: string; provider?: string; model?: string }> = []
  for (const item of pending) {
    if (!isActive()) return false
    const assetId = tlAssetIdFor(item.galleryId)
    if (editor.getAsset(assetId) === undefined) {
      try {
        const blob = await fetchAttachmentBlob(item.attachment)
        const src = await blobToDataUrl(blob)
        assets.push({
          id: assetId,
          typeName: 'asset',
          type: 'image',
          meta: {},
          props: {
            name: item.attachment.name ?? item.galleryId,
            src,
            w: item.attachment.width > 0 ? item.attachment.width : 512,
            h: item.attachment.height > 0 ? item.attachment.height : 512,
            mimeType: blob.type || item.attachment.mediaType,
            isAnimated: item.attachment.mediaType === 'image/gif',
            fileSize: item.attachment.bytes,
          },
        })
      } catch (error) {
        console.warn('[dsh-image-gen] canvas landing skipped (attachment unreadable):', item.galleryId, error)
        continue
      }
    }
    const size = displaySizeOf(item.attachment)
    const prompt = metaPromptOf(item.prompt)
    landed.push({
      galleryId: item.galleryId,
      assetId,
      attachmentId: String(item.attachment.attachmentId),
      name: item.attachment.name ?? item.galleryId,
      fromConversation: item.fromConversation === true,
      w: size.w,
      h: size.h,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(typeof item.provider === 'string' && item.provider.length > 0 ? { provider: item.provider } : {}),
      ...(typeof item.model === 'string' && item.model.length > 0 ? { model: item.model } : {}),
    })
  }
  if (!isActive()) return false
  const nowLanded = landedIdsOf(editor)
  const ready = landed.filter(item => !nowLanded.has(item.galleryId))
  if (ready.length === 0) return true
  if (assets.length > 0) editor.createAssets(assets)

  const rows: Array<typeof ready> = []
  for (let index = 0; index < ready.length; index += GRID_COLS) rows.push(ready.slice(index, index + GRID_COLS))
  const rowSizes = rows.map(row => ({
    width: row.reduce((sum, cell) => sum + cell.w, 0) + GRID_GAP * (row.length - 1),
    height: Math.max(...row.map(cell => cell.h)),
  }))
  const blockWidth = Math.max(...rowSizes.map(size => size.width))
  const blockHeight = rowSizes.reduce((sum, size) => sum + size.height, 0) + GRID_GAP * (rows.length - 1)
  const viewport = editor.getViewportPageBounds()
  const originX = viewport.center.x - blockWidth / 2
  let originY = viewport.center.y - blockHeight / 2

  const existing = editor.getCurrentPageShapes()
  if (existing.length > 0) {
    const cushion = GRID_GAP / 2
    const candidateX = originX - cushion
    const candidateY = originY - cushion
    const candidateW = blockWidth + cushion * 2
    const candidateH = blockHeight + cushion * 2
    let occupied = false
    let contentBottom = Number.NEGATIVE_INFINITY
    for (const shape of existing) {
      const bounds = editor.getShapePageBounds(shape.id)
      if (bounds === undefined) continue
      if (bounds.maxY > contentBottom) contentBottom = bounds.maxY
      if (!occupied && candidateX < bounds.maxX && candidateX + candidateW > bounds.minX
        && candidateY < bounds.maxY && candidateY + candidateH > bounds.minY) occupied = true
    }
    if (occupied) originY = contentBottom + GRID_GAP
  }
  let cursorY = originY
  const shapes: TLCreateShapePartial<TLImageShape>[] = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!
    const rowSize = rowSizes[rowIndex]!
    let cursorX = originX + (blockWidth - rowSize.width) / 2
    for (const cell of row) {
      shapes.push({
        id: createShapeId(`ig-${cell.galleryId}`),
        type: 'image',
        x: Math.round(cursorX),
        y: Math.round(cursorY),
        props: { assetId: cell.assetId, w: cell.w, h: cell.h },
        meta: {
          galleryId: cell.galleryId,
          attachmentId: cell.attachmentId,
          name: cell.name,
          fromConversation: cell.fromConversation,
          ...(cell.prompt !== undefined ? { prompt: cell.prompt } : {}),
          ...(cell.provider !== undefined ? { provider: cell.provider } : {}),
          ...(cell.model !== undefined ? { model: cell.model } : {}),
        },
      })
      cursorX += cell.w + GRID_GAP
    }
    cursorY += rowSize.height + GRID_GAP
  }
  editor.createShapes(shapes)

  const visible = originX >= viewport.minX && originY >= viewport.minY
    && originX + blockWidth <= viewport.maxX && originY + blockHeight <= viewport.maxY
  if (!visible) {
    if (blockWidth <= viewport.w && blockHeight <= viewport.h) {
      editor.centerOnPoint({ x: originX + blockWidth / 2, y: originY + blockHeight / 2 }, { animation: { duration: 240 } })
    } else {
      editor.zoomToBounds({ x: originX, y: originY, w: blockWidth, h: blockHeight }, { animation: { duration: 240 }, inset: GRID_GAP })
    }
  }
  return true
}
