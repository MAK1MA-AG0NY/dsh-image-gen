import { memo, useCallback, useId, useRef, useState, type FC } from 'react'
import {
  DefaultToolbar,
  Tldraw,
  type Editor,
  type TLImageShape,
} from 'tldraw'
import { clearAttachmentCache } from '../image-cache.js'
import { applyBrandTheme } from './tl-brand-theme.js'
import { startCanvasSync, type CanvasSyncStatus } from './canvas-sync.js'
import { clearTlLandings, getTlLandingGeneration, registerTlLandingConsumer } from './tl-canvas-bridge.js'
import { landTlItems } from './canvas-landing.js'
import { useCanvasAnnotationPanel, syncLinkedAnnotationPositions } from './canvas-annotation-panel.js'

/**
 * Infinite canvas surface for the Studio workbench, backed by tldraw.
 *
 * Both surfaces share one locally persisted document. The landing queue is
 * consumed once; tldraw owns subsequent edits, deletion, undo and persistence.
 */

const mountedCanvases = new Set<() => void>()
const mountedEditors = new Set<Editor>()

/** Reset canvas-owned data only. Gallery records and host attachments are untouched. */
export function clearStudioTlCanvases(): boolean {
  if (mountedCanvases.size === 0) return false
  clearTlLandings()
  for (const clear of mountedCanvases) clear()
  clearAttachmentCache()
  return true
}

/**
 * Cancel in-editor selection on every mounted canvas, keeping shapes and sync
 * untouched. Selection is interaction state tied to the surface: leaving the
 * studio page cancels it so a stale selection can neither resurface on return
 * nor linger in the host mirror.
 */
export function deselectStudioTlCanvases(): boolean {
  if (mountedEditors.size === 0) return false
  for (const editor of mountedEditors) editor.run(() => editor.selectNone())
  return true
}

/**
 * Dock the stock toolbar vertically along the left edge (Figma-style) instead
 * of tldraw's signature bottom-center pill. It is still the same
 * DefaultToolbar with the same tools and overflow handling — only the
 * orientation changes, which is what makes the whole composition read as our
 * own surface rather than stock tldraw. TL_THEME_CSS offsets it from the
 * screen edge like the other floating cards.
 */
const StudioToolbar = () => <DefaultToolbar orientation="vertical" />

const TL_COMPONENTS = { Toolbar: StudioToolbar }

export const StudioTlCanvas: FC<{ lang?: 'zh' | 'en' }> = memo(function StudioTlCanvas({ lang = 'zh' }) {
  // Separate camera/selection state for editors sharing the document.
  const sessionId = useId()
  const [syncStatus, setSyncStatus] = useState<CanvasSyncStatus>({ phase: 'idle', count: 0 })
  const [editor, setEditor] = useState<Editor>()
  const [selectedImage, setSelectedImage] = useState<TLImageShape>()
  const annotation = useCanvasAnnotationPanel({ editor, image: selectedImage, lang })
  const retrySync = useRef<() => void>(() => {})
  const onMount = useCallback((editor: Editor) => {
          let active = true
          // tldraw restores instance state (including the selection) from the
          // persisted snapshot; every mount starts as fresh interaction state.
          editor.run(() => editor.selectNone())
          setEditor(editor)
          const syncSelectedImage = (): void => {
            const selected = editor.getSelectedShapes()
            const image = selected.length === 1 && selected[0]?.type === 'image' ? selected[0] : undefined
            setSelectedImage(image)
          }
          const stopSelectionWatch = editor.store.listen(event => {
            syncSelectedImage()
            const changedImages = [...Object.values(event.changes.added), ...Object.values(event.changes.updated).map(pair => pair[1])]
              .filter(record => record.typeName === 'shape' && record.type === 'image')
            if (changedImages.length > 0) syncLinkedAnnotationPositions(editor, new Set(changedImages.map(shape => String(shape.id))))
          }, { source: 'all', scope: 'all' })
          mountedEditors.add(editor)
          // Re-tint canvas-rendered colors (selection, marquee, "blue"
          // palette) to the plugin brand; UI chrome comes from TL_THEME_CSS.
          applyBrandTheme(editor)
          // Dot-grid backdrop: tldraw's built-in zoom-aware grid, re-tinted to
          // the workbench blue-grey. Gives the empty canvas spatial rhythm and
          // alignment reference without the graph-paper feel of line grids.
          editor.updateInstanceState({ isGridMode: true })
          // One console line proves the editor booted inside the webview;
          // useful when the host page swallows render errors.
          console.info(`[dsh-image-gen] tldraw mounted (instance ${editor.id})`)
          // tldraw calls onMount after the local document has loaded.
          const stopLanding = registerTlLandingConsumer(items => {
            const generation = getTlLandingGeneration()
            return landTlItems(editor, items, () => active && generation === getTlLandingGeneration())
          })
          // Mirror this canvas into the host so the conversation agent can
          // see it (canvas_state / view_canvas / edit_image canvas_selection).
          let stopSync = startCanvasSync(editor, setSyncStatus)
          retrySync.current = () => stopSync.retry()
          const clear = (): void => {
            // Stop outstanding screenshots as well as the old host selection.
            stopSync()
            editor.complete()
            editor.run(() => {
              editor.selectNone()
              const pages = editor.getPages()
              for (const page of pages) {
                editor.deleteShapes([...editor.getPageShapeIds(page.id)])
              }
              for (const page of pages.slice(1)) editor.deletePage(page.id)
              editor.deleteAssets(editor.getAssets())
              editor.setCamera({ x: 0, y: 0, z: 1 })
            }, { history: 'ignore', ignoreShapeLock: true })
            editor.clearHistory()
            stopSync = startCanvasSync(editor, setSyncStatus)
          }
          mountedCanvases.add(clear)
          return () => {
            active = false
            stopSelectionWatch()
            setEditor(undefined)
            setSelectedImage(undefined)
            mountedEditors.delete(editor)
            mountedCanvases.delete(clear)
            stopLanding()
            stopSync()
            retrySync.current = () => {}
          }
  }, [])
  const statusText = lang === 'en'
    ? syncStatus.phase === 'ready' ? `Selection ready · ${syncStatus.count} shapes`
      : syncStatus.phase === 'preparing' ? `Preparing selection · ${syncStatus.count} shapes…`
        : 'Selection sync failed'
    : syncStatus.phase === 'ready' ? `选区已就绪 · ${syncStatus.count} 个元素`
      : syncStatus.phase === 'preparing' ? `正在准备选区 · ${syncStatus.count} 个元素…`
        : '选区同步失败'

  return (
    <div className="dsh-ig-tl-canvas" onPointerDownCapture={annotation.onPointerDownCapture} onPointerUpCapture={annotation.onPointerUpCapture}>
      <Tldraw
        persistenceKey="dsh-image-gen-workbench-v1"
        sessionId={sessionId}
        components={TL_COMPONENTS}
        onMount={onMount}
      />
      {annotation.panel}
      {syncStatus.phase !== 'idle' && (
        <div className="dsh-ig-canvas-sync-status" data-phase={syncStatus.phase} role="status" aria-live="polite">
          <span>{statusText}{syncStatus.phase === 'error' ? `：${canvasSyncError(syncStatus.error, lang)}` : ''}</span>
          {syncStatus.phase === 'error' && <button type="button" onClick={() => retrySync.current()}>{lang === 'en' ? 'Retry' : '重试'}</button>}
        </div>
      )}
    </div>
  )
})

export function canvasSyncError(error: string | undefined, lang: 'zh' | 'en'): string {
  const en = lang === 'en'
  if (error?.includes('annotation-image-variant-unsupported')) return en ? 'Remove annotations before cropping or flipping this image.' : '裁剪或翻转图片前，请先移除其标注。'
  if (error?.includes('too-many-selected')) return en ? 'Select at most 16 shapes to edit with originals.' : '使用原图编辑时，请一次选择不超过 16 个元素。'
  if (error?.includes('too-large')) return en ? 'An image exceeds the size limit. Reduce its size and retry.' : '图片超出大小限制，请缩小后重试。'
  if (error?.includes('unsupported')) return en ? 'Use PNG, JPEG, WebP or GIF images.' : '请使用 PNG、JPEG、WebP 或 GIF 图片。'
  if (error?.includes('host-unavailable')) return en ? 'Restart DSH to load the updated plugin, then retry.' : '请重启 DSH 加载新版插件后重试。'
  return en ? 'Check the connection or re-import an unavailable image, then retry.' : '请检查连接；若原图已失效，请重新导入后重试。'
}
