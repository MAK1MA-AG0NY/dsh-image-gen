import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createShapeId, Mat, type Editor, type TLCreateShapePartial, type TLGeoShape, type TLImageShape, type TLShapeId } from 'tldraw'

const MAX_IMAGE_ANNOTATIONS = 16
const MAX_ANNOTATION_INSTRUCTION = 200
type AnnotationKind = 'point' | 'arrow' | 'region'
type AnnotationMode = AnnotationKind | undefined
type AnnotationGesture = { readonly image: TLImageShape; readonly start: { readonly x: number; readonly y: number } }
export const ANNOTATION_REGION_FILL = 'none'

function supportedImageVariant(image: TLImageShape): boolean {
  const props = image.props
  return !('crop' in props && props.crop !== null && props.crop !== undefined)
    && !('flipX' in props && props.flipX === true)
    && !('flipY' in props && props.flipY === true)
}

function imageAnnotations(editor: Editor, imageId: string): number {
  return imageAnnotationEntries(editor, imageId).length
}

interface ImageAnnotationEntry {
  readonly id: TLShapeId
  readonly kind: string
  readonly instruction: string
}

function imageAnnotationEntries(editor: Editor, imageId: string): ImageAnnotationEntry[] {
  return editor.getCurrentPageShapes().flatMap(shape => {
    const meta = shape.meta as { targetShapeId?: unknown; canvasEditAnnotation?: { kind?: unknown; instruction?: unknown } } | undefined
    if (meta?.targetShapeId !== imageId || meta.canvasEditAnnotation === undefined
      || typeof meta.canvasEditAnnotation.instruction !== 'string') return []
    return [{ id: shape.id, kind: String(meta.canvasEditAnnotation.kind ?? ''), instruction: meta.canvasEditAnnotation.instruction }]
  })
}

export function createAnnotationShapeId(): TLShapeId {
  return createShapeId()
}

export function imagePointFromScreen(editor: Editor, image: TLImageShape, screen: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } | undefined {
  if (!supportedImageVariant(image)) return undefined
  const page = editor.screenToPage(screen)
  const local = Mat.applyToPoint(Mat.Inverse(editor.getShapePageTransform(image)), page)
  const point = { x: local.x / image.props.w, y: local.y / image.props.h }
  return point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : undefined
}

export function annotationArrowPlacement(target: { readonly x: number; readonly y: number }, rotation: number, width: number, height: number) {
  const originOffsetX = Math.cos(rotation) * width - Math.sin(rotation) * height / 2
  const originOffsetY = Math.sin(rotation) * width + Math.cos(rotation) * height / 2
  return { x: target.x - originOffsetX, y: target.y - originOffsetY, w: width, h: height, rotation }
}

export function annotationBoxPlacement(center: { readonly x: number; readonly y: number }, rotation: number, width: number, height: number) {
  const originOffsetX = Math.cos(rotation) * width / 2 - Math.sin(rotation) * height / 2
  const originOffsetY = Math.sin(rotation) * width / 2 + Math.cos(rotation) * height / 2
  return { x: center.x - originOffsetX, y: center.y - originOffsetY, w: width, h: height, rotation }
}

export function createLockedAnnotation(editor: Editor, shape: TLCreateShapePartial<TLGeoShape>): void {
  editor.createShape({ ...shape, isLocked: true })
}

export function deleteCanvasAnnotation(editor: Editor, shapeId: TLShapeId): void {
  editor.run(() => editor.deleteShapes([shapeId]), { ignoreShapeLock: true })
}

export function syncLinkedAnnotationPositions(editor: Editor, changedImageIds: ReadonlySet<string>): void {
  if (changedImageIds.size === 0) return
  const images = new Map(editor.getCurrentPageShapes().filter((shape): shape is TLImageShape => shape.type === 'image').map(shape => [String(shape.id), shape]))
  const updates = editor.getCurrentPageShapes().flatMap(shape => {
    if (shape.type !== 'geo') return []
    const meta = shape.meta as { targetShapeId?: unknown; canvasEditAnnotation?: { kind?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; angle?: unknown } } | undefined
    if (typeof meta?.targetShapeId !== 'string' || meta.canvasEditAnnotation === undefined) return []
    const image = images.get(meta.targetShapeId)
    const x = meta.canvasEditAnnotation.x
    const y = meta.canvasEditAnnotation.y
    if (image === undefined || !changedImageIds.has(String(image.id)) || typeof x !== 'number' || typeof y !== 'number') return []
    const regionWidth = meta.canvasEditAnnotation.width
    const regionHeight = meta.canvasEditAnnotation.height
    const isRegion = typeof regionWidth === 'number' && typeof regionHeight === 'number'
    const width = isRegion ? regionWidth * image.props.w : shape.props.w
    const height = isRegion ? regionHeight * image.props.h : shape.props.h
    const transform = editor.getShapePageTransform(image)
    const point = Mat.applyToPoint(transform, {
      x: (x + (typeof regionWidth === 'number' ? regionWidth / 2 : 0)) * image.props.w,
      y: (y + (typeof regionHeight === 'number' ? regionHeight / 2 : 0)) * image.props.h,
    })
    const angle = Mat.Rotation(transform) + (typeof meta.canvasEditAnnotation.angle === 'number' ? meta.canvasEditAnnotation.angle : 0)
    const placement = meta.canvasEditAnnotation.kind === 'arrow'
      ? annotationArrowPlacement(point, angle, width, height)
      : annotationBoxPlacement(point, angle, width, height)
    const widthChanged = isRegion && Math.abs(shape.props.w - width) > 0.01
    const heightChanged = isRegion && Math.abs(shape.props.h - height) > 0.01
    if (Math.abs(shape.x - placement.x) <= 0.01 && Math.abs(shape.y - placement.y) <= 0.01
      && Math.abs(shape.rotation - placement.rotation) <= 0.0001 && !widthChanged && !heightChanged) return []
    return [{ id: shape.id, type: 'geo' as const, ...placement, ...(isRegion ? { props: { w: width, h: height } } : {}) }]
  })
  if (updates.length > 0) editor.run(() => editor.updateShapes(updates), { ignoreShapeLock: true, history: 'ignore' })
}

interface CanvasAnnotationPanelProps {
  readonly editor: Editor | undefined
  readonly image: TLImageShape | undefined
  readonly lang: 'zh' | 'en'
}

export function useCanvasAnnotationPanel({ editor, image, lang }: CanvasAnnotationPanelProps) {
  const [mode, setMode] = useState<AnnotationMode>()
  const [instruction, setInstruction] = useState('')
  const [error, setError] = useState('')
  const [, setAnnotationRevision] = useState(0)
  const gesture = useRef<AnnotationGesture>()
  const activeImageId = useRef<string>()
  const imageId = image?.id
  useEffect(() => {
    if (activeImageId.current === imageId) return
    activeImageId.current = imageId
    setMode(undefined)
    setInstruction('')
    setError('')
  }, [imageId])
  useEffect(() => editor?.store.listen(event => {
    const changes = [...Object.values(event.changes.added), ...Object.values(event.changes.removed), ...Object.values(event.changes.updated).map(pair => pair[1])]
    if (changes.some(record => record.typeName === 'shape' && record.meta.targetShapeId === imageId && record.meta.canvasEditAnnotation !== undefined)) {
      setAnnotationRevision(revision => revision + 1)
    }
  }, { source: 'all', scope: 'all' }), [editor, imageId])
  const localPoint = (event: ReactPointerEvent<HTMLDivElement>, target: TLImageShape): { x: number; y: number } | undefined => {
    return editor === undefined ? undefined : imagePointFromScreen(editor, target, { x: event.clientX, y: event.clientY })
  }
  const finish = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const current = gesture.current
    gesture.current = undefined
    if (current === undefined || editor === undefined || mode === undefined) return
    const end = localPoint(event, current.image)
    if (end === undefined) return
    const startX = Math.max(0, Math.min(1, current.start.x))
    const startY = Math.max(0, Math.min(1, current.start.y))
    const endX = Math.max(0, Math.min(1, end.x))
    const endY = Math.max(0, Math.min(1, end.y))
    const isRegion = mode === 'region'
    const x = isRegion ? Math.min(startX, endX) : mode === 'arrow' ? endX : startX
    const y = isRegion ? Math.min(startY, endY) : mode === 'arrow' ? endY : startY
    const width = Math.abs(endX - startX)
    const height = Math.abs(endY - startY)
    if (isRegion && (width < 0.005 || height < 0.005)) return
    if (imageAnnotations(editor, current.image.id) >= MAX_IMAGE_ANNOTATIONS) {
      setError(lang === 'en' ? 'Maximum 16 annotations per image.' : '每张图片最多添加 16 条标注。')
      return
    }
    const text = instruction.trim().slice(0, MAX_ANNOTATION_INSTRUCTION)
    if (text.length === 0) {
      setError(lang === 'en' ? 'Enter an instruction first.' : '请先填写修改说明。')
      return
    }
    const id = createAnnotationShapeId()
    const transform = editor.getShapePageTransform(current.image)
    const targetPoint = Mat.applyToPoint(transform, {
      x: endX * current.image.props.w,
      y: endY * current.image.props.h,
    })
    const startPoint = Mat.applyToPoint(transform, {
      x: startX * current.image.props.w,
      y: startY * current.image.props.h,
    })
    const center = Mat.applyToPoint(transform, {
      x: (x + (isRegion ? width / 2 : 0)) * current.image.props.w,
      y: (y + (isRegion ? height / 2 : 0)) * current.image.props.h,
    })
    const arrowAngle = Math.atan2(targetPoint.y - startPoint.y, targetPoint.x - startPoint.x)
    const localArrowAngle = arrowAngle - Mat.Rotation(transform)
    const shapeWidth = isRegion ? width * current.image.props.w : mode === 'arrow' ? Math.max(28, Math.hypot(targetPoint.x - startPoint.x, targetPoint.y - startPoint.y)) : 24
    const shapeHeight = isRegion ? height * current.image.props.h : mode === 'arrow' ? 28 : 24
    const arrow = annotationArrowPlacement(targetPoint, arrowAngle, shapeWidth, shapeHeight)
    const box = annotationBoxPlacement(center, Mat.Rotation(transform), shapeWidth, shapeHeight)
    const geo = isRegion ? 'rectangle' : mode === 'arrow' ? 'arrow-right' : 'ellipse'
    createLockedAnnotation(editor, {
      id,
      type: 'geo',
      x: mode === 'arrow' ? arrow.x : box.x,
      y: mode === 'arrow' ? arrow.y : box.y,
      rotation: mode === 'arrow' ? arrow.rotation : box.rotation,
      props: { geo, w: shapeWidth, h: shapeHeight, color: 'blue', fill: isRegion ? ANNOTATION_REGION_FILL : 'none', dash: 'solid', size: 'm' },
      meta: { targetShapeId: current.image.id, canvasEditAnnotation: {
        id: String(id), kind: mode, x, y, ...(isRegion ? { width, height } : {}),
        ...(mode === 'arrow' ? { angle: localArrowAngle } : {}), instruction: text,
      } },
    })
    editor.select(current.image.id)
    setError('')
  }
  const begin = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (mode === undefined || image === undefined || editor === undefined) return
    if (event.target instanceof Element && event.target.closest('[data-annotation-panel]') !== null) return
    const point = localPoint(event, image)
    if (point === undefined) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { image, start: point }
    if (mode === 'point') finish(event)
  }
  const panel = (
    <>
      {image !== undefined && (
        <div className="dsh-ig-annotation-panel" data-annotation-panel onPointerDown={event => event.stopPropagation()}>
          {mode === undefined ? (
            <button type="button" className="dsh-ig-annotation-trigger" onClick={() => { setInstruction(''); setError(''); setMode('point') }}>
              {lang === 'en' ? 'Annotate image' : '标注修改'}
            </button>
          ) : (
            <>
              <div className="dsh-ig-annotation-head">
                <strong>{lang === 'en' ? 'Annotate image' : '标注修改'}</strong>
                <button type="button" aria-label={lang === 'en' ? 'Close annotations' : '关闭标注'} onClick={() => { setMode(undefined); setError('') }}>×</button>
              </div>
              <fieldset className="dsh-ig-annotation-modes">
                <legend>{lang === 'en' ? 'Annotation type' : '标注类型'}</legend>
                {(['point', 'arrow', 'region'] as const).map(kind => (
                  <button key={kind} type="button" aria-pressed={mode === kind} onClick={() => setMode(kind)}>
                    {lang === 'en' ? { point: 'Point', arrow: 'Arrow', region: 'Region' }[kind] : { point: '点', arrow: '箭头', region: '区域' }[kind]}
                  </button>
                ))}
              </fieldset>
              <label className="dsh-ig-annotation-label">
                {lang === 'en' ? 'Change instruction' : '修改说明'}
                <input value={instruction} maxLength={MAX_ANNOTATION_INSTRUCTION} onChange={event => setInstruction(event.currentTarget.value)} placeholder={lang === 'en' ? 'e.g. soften the shadows' : '例如：把这里的阴影调柔和'} />
              </label>
              <small>{lang === 'en' ? "Click a point or drag an arrow/region. Then tell the agent: 'edit the selected canvas image'." : '点选位置或拖动绘制箭头 / 区域后，请告诉 Agent：“编辑当前选中的画布图片”。'}</small>
              {error.length > 0 && <small role="alert">{error}</small>}
            </>
          )}
          {mode !== undefined && image !== undefined && !supportedImageVariant(image) && (
            <small role="alert">{lang === 'en' ? 'Annotations do not support cropped or flipped images yet.' : '暂不支持对已裁剪或翻转的图片定位标注。'}</small>
          )}
          {mode !== undefined && editor !== undefined && image !== undefined && imageAnnotations(editor, image.id) >= MAX_IMAGE_ANNOTATIONS && (
            <small role="alert">{lang === 'en' ? 'Maximum 16 annotations per image.' : '每张图片最多添加 16 条标注。'}</small>
          )}
          {editor !== undefined && image !== undefined && imageAnnotationEntries(editor, image.id).length > 0 && (
            <ul className="dsh-ig-annotation-list" aria-label={lang === 'en' ? 'Image annotations' : '图片标注列表'}>
              {imageAnnotationEntries(editor, image.id).map(note => (
                <li key={note.id}>
                  <span>{note.instruction}</span>
                  <button type="button" aria-label={lang === 'en' ? `Redraw annotation: ${note.instruction}` : `重新绘制标注：${note.instruction}`} onClick={() => {
                    deleteCanvasAnnotation(editor, note.id)
                    setInstruction(note.instruction)
                    setMode(note.kind === 'arrow' || note.kind === 'region' ? note.kind : 'point')
                    setError('')
                  }}>
                    {lang === 'en' ? 'Redraw' : '重新绘制'}
                  </button>
                  <button type="button" aria-label={lang === 'en' ? `Delete annotation: ${note.instruction}` : `删除标注：${note.instruction}`} onClick={() => deleteCanvasAnnotation(editor, note.id)}>
                    {lang === 'en' ? 'Delete' : '删除'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  )
  return { panel, onPointerDownCapture: begin, onPointerUpCapture: finish }
}
