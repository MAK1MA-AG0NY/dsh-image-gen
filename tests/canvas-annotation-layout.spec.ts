import { describe, expect, it } from 'vitest'
import { TL_THEME_CSS } from '../src/client/tl/tl-theme-css.js'

describe('canvas annotation panel layout', () => {
  it('docks clear of the bottom-left opacity slider and sync status', () => {
    const panelLayout = TL_THEME_CSS.match(/\.dsh-ig-annotation-panel\s*\{([^}]+)\}/)?.[1]

    expect(panelLayout).toBeDefined()
    expect(panelLayout).toMatch(/position:\s*absolute/)
    expect(panelLayout).toMatch(/right:\s*16px/)
    expect(panelLayout).toMatch(/left:\s*auto/)
    expect(panelLayout).toMatch(/bottom:\s*88px/)
    expect(panelLayout).toMatch(/top:\s*auto/)
  })

  it('constrains panel size for narrow canvases and short viewports', () => {
    const panelLayout = TL_THEME_CSS.match(/\.dsh-ig-annotation-panel\s*\{([^}]+)\}/)?.[1]

    expect(panelLayout).toMatch(/width:\s*min\(320px,\s*calc\(100%\s*-\s*32px\)\)/)
    expect(panelLayout).toMatch(/box-sizing:\s*border-box/)
    expect(panelLayout).toMatch(/max-height:\s*min\(60vh,\s*calc\(100%\s*-\s*136px\)\)/)
    expect(panelLayout).toMatch(/overflow-y:\s*auto/)
  })
})
