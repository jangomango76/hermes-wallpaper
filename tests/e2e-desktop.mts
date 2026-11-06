// End-to-end test: launches an isolated Hermes Desktop (sandboxed HOME/HERMES_HOME, the repo's mock
// LLM server) with this plugin installed, picks an image, an MP4 and a WebM through the real file
// chooser, tunes blur/opacity, reloads the window (persistence) and switches the wallpaper off.
// Needs a hermes-agent checkout (HERMES_AGENT_DIR), xvfb-run and ffmpeg. See tests/run-e2e.sh.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const REPO = process.env.HERMES_AGENT_DIR ?? '/usr/local/lib/hermes-agent'
const DESKTOP = path.join(REPO, 'apps/desktop')
const require = createRequire(path.join(DESKTOP, 'package.json'))
const { _electron } = require('@playwright/test')
const { startMockServer } = await import(path.join(REPO, 'tests-js/scripts/mock-server.ts'))
const { writeEnvFile, writeMockProviderConfig } = await import(path.join(REPO, 'tests-js/scripts/mock-provider-config.ts'))

const HERE = path.dirname(new URL(import.meta.url).pathname)
const WORK = path.resolve(HERE, '..')
const T = process.env.FIXTURES ?? path.join(HERE, 'fixtures')
const OUT = process.env.OUT ?? path.join(HERE, 'out')
const PLUGIN = process.env.PLUGIN ?? path.join(WORK, 'desktop', 'plugin.js')
const IMG = process.env.IMG ?? 'mountains.png'
const VID = process.env.VID ?? 'clip.mp4'
fs.mkdirSync(OUT, { recursive: true })

const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'wallpaper-e2e-'))
const hermesHome = path.join(root, 'hermes-home')
const userData = path.join(root, 'electron-user-data')
fs.mkdirSync(path.join(hermesHome, 'desktop-plugins', 'hermes-wallpaper'), { recursive: true })
fs.copyFileSync(PLUGIN, path.join(hermesHome, 'desktop-plugins', 'hermes-wallpaper', 'plugin.js'))

const mock = await startMockServer()
writeMockProviderConfig(hermesHome, mock.url)
writeEnvFile(hermesHome)

const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) {
  if (!v || /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|_ACCESS_KEY|_PRIVATE_KEY)$/.test(k)) continue
  if (k.startsWith('HERMES_') && !k.startsWith('HERMES_DESKTOP_')) continue
  env[k] = v
}
Object.assign(env, {
  HOME: root,
  HERMES_HOME: hermesHome,
  HERMES_DESKTOP_USER_DATA_DIR: userData,
  HERMES_DESKTOP_IGNORE_EXISTING: '1',
  HERMES_DESKTOP_ISOLATED_BACKEND: '1',
  HERMES_DESKTOP_HERMES_ROOT: REPO,
  HERMES_DESKTOP_APP_NAME: `WallpaperPreview-${Date.now()}`,
  HERMES_DESKTOP_SKIP_QUIT_CONFIRM: '1',
  HERMES_DESKTOP_SKIP_PROTOCOL_REGISTRATION: '1',
  TEST_WORKER_INDEX: '0'
})

const app = await _electron.launch({
  executablePath: path.join(DESKTOP, 'node_modules/electron/dist/electron'),
  args: [DESKTOP, '--disable-gpu', '--no-sandbox'],
  env,
  cwd: DESKTOP
})
const report: Record<string, unknown> = {}
const errors: string[] = []
const facts = async (page: any) => page.evaluate(() => {
  const layer = document.getElementById('hermes-wallpaper-layer')
  const media = layer?.querySelector('.hw-media') as HTMLElement | null
  const node = media?.firstElementChild as HTMLElement | null
  const sb = document.querySelector('[data-slot="sidebar"]') as HTMLElement | null
  const v = node && node.tagName === 'VIDEO' ? (node as HTMLVideoElement) : null
  return {
    attr: document.documentElement.hasAttribute('data-hermes-wallpaper'),
    layer: !!layer,
    layerZ: layer ? getComputedStyle(layer).zIndex : null,
    node: node?.tagName ?? null,
    opacity: media ? getComputedStyle(media).opacity : null,
    filter: media ? getComputedStyle(media).filter : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    sidebarBg: sb ? getComputedStyle(sb).backgroundColor : null,
    video: v ? { paused: v.paused, t: Number(v.currentTime.toFixed(2)), w: v.videoWidth, rate: v.playbackRate, err: v.error?.code ?? null } : null,
    toasts: [...document.querySelectorAll('[data-sonner-toast], [role="status"], [role="alert"]')].map(a => (a.textContent ?? '').slice(0, 160)).filter(Boolean)
  }
})

try {
  const page = await app.firstWindow()
  page.on('console', (m: any) => { if (m.type() === 'error' || /wallpaper|plugin/i.test(m.text())) errors.push(`${m.type()}: ${m.text()}`.slice(0, 300)) })
  page.on('pageerror', (e: any) => errors.push(`pageerror: ${e.message}`))
  await app.evaluate(({ BrowserWindow }: any) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.center() })

  const composer = page.locator('[data-slot="composer-root"] [contenteditable="true"]:visible').first()
  await composer.waitFor({ state: 'visible', timeout: 180_000 })
  await composer.click({ trial: true, timeout: 240_000 })
  for (const text of ['Hello there, how does the wallpaper look?', 'Write a short haiku about backgrounds']) {
    await composer.click()
    await composer.pressSequentially(text)
    await composer.press('Enter')
    await page.waitForTimeout(3000)
  }
  await page.screenshot({ path: path.join(OUT, '01-before.png') })
  report.before = await facts(page)

  // 1) Status bar chip → popover → Choose file… (real file chooser)
  const chip = page.locator('button:has([data-hermes-wallpaper-chip])').first()
  await chip.waitFor({ state: 'visible', timeout: 30_000 })
  await chip.click()
  await page.locator('[data-hermes-wallpaper-quick]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: path.join(OUT, '02-popover.png') })
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.locator('[data-hermes-wallpaper-quick] button', { hasText: 'Choose file' }).click()
  ])
  await chooser.setFiles(path.join(T, IMG))
  await page.waitForFunction(() => !!document.querySelector('#hermes-wallpaper-layer .hw-media > *'), null, { timeout: 30_000 })
  await page.waitForTimeout(800)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, '03-image.png') })
  report.image = await facts(page)

  // 2) Settings page via palette route; tweak blur + opacity through the real range inputs
  await page.evaluate(() => { location.hash = '#/wallpaper' })
  await page.locator('[data-hermes-wallpaper-panel]').first().waitFor({ state: 'visible', timeout: 15_000 })
  const setRange = async (label: string, value: number) => {
    const r = page.locator(`[data-hermes-wallpaper-panel] input[aria-label="${label}"]`).first()
    await r.evaluate((el: HTMLInputElement, v: number) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, String(v))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, value)
  }
  await setRange('Blur', 12)
  await setRange('Opacity', 55)
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(OUT, '04-settings-page.png') })
  report.tuned = await facts(page)

  // 3) Video via drag&drop-less path: second file chooser from the page button
  const [chooser2] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.locator('[data-hermes-wallpaper-panel] button', { hasText: 'Choose file' }).first().click()
  ])
  await chooser2.setFiles([path.join(T, VID)])
  await page.waitForFunction(() => document.querySelector('#hermes-wallpaper-layer .hw-media > *')?.tagName === 'VIDEO', null, { timeout: 30_000 })
  await setRange('Blur', 0)
  await setRange('Opacity', 80)
  await page.waitForTimeout(1500)
  report.video = await facts(page)
  await page.keyboard.press('Control+N')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(OUT, '05-video-chat.png') })
  report.video2 = await facts(page)

  // 4) WebM too
  await page.evaluate(() => { location.hash = '#/wallpaper' })
  await page.locator('[data-hermes-wallpaper-panel]').first().waitFor({ state: 'visible', timeout: 15_000 })
  const [chooser3] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 10_000 }),
    page.locator('[data-hermes-wallpaper-panel] button', { hasText: 'Choose file' }).first().click()
  ])
  await chooser3.setFiles([path.join(T, 'life.webm')])
  await page.waitForTimeout(2500)
  report.webm = await facts(page)
  report.libraryCount = await page.locator('[data-hermes-wallpaper-panel] button[title^="Use "]').count()
  await page.screenshot({ path: path.join(OUT, '06-library.png') })

  // 5) Persistence: reload the window, wallpaper must come back from IndexedDB
  await page.evaluate(() => { location.hash = '#/' })
  await page.reload()
  await page.waitForFunction(() => !!document.querySelector('#hermes-wallpaper-layer .hw-media > *'), null, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  report.afterReload = await facts(page)
  await page.screenshot({ path: path.join(OUT, '07-after-reload.png') })

  // 6) Toggle off → everything restored
  const chip2 = page.locator('button:has([data-hermes-wallpaper-chip])').first()
  await chip2.click()
  await page.locator('[data-hermes-wallpaper-quick] [role="switch"], [data-hermes-wallpaper-quick] button[role="switch"]').first().click()
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  report.off = await facts(page)
  await page.screenshot({ path: path.join(OUT, '08-off.png') })
} catch (e: any) {
  report.failure = String(e?.stack ?? e)
  try { const p = await app.firstWindow(); await p.screenshot({ path: path.join(OUT, 'zz-failure.png') }) } catch { /* */ }
} finally {
  report.errors = errors.filter(e => !/favicon|DevTools/.test(e)).slice(0, 40)
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  const r: any = report
  const ok = !r.failure && r.image?.attr && r.image?.node === 'DIV' && r.tuned?.filter?.includes('blur(12px)') &&
    r.tuned?.opacity === '0.55' && r.video?.node === 'VIDEO' && r.video?.video && !r.video.video.paused &&
    r.webm?.video && !r.webm.video.paused && r.libraryCount === 3 && r.afterReload?.node === 'VIDEO' &&
    r.afterReload?.opacity === '0.8' && r.off?.attr === false && r.off?.node === null && !(r.errors ?? []).length
  console.log(ok ? 'E2E PASS' : 'E2E FAIL')
  process.exitCode = ok ? 0 : 1
  await app.close().catch(() => undefined)
  await mock.close()
  fs.rmSync(root, { recursive: true, force: true })
}
