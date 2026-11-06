// Wallpaper for Hermes Desktop — put any image, GIF or short video from your
// drive behind the whole Hermes Desktop window.
//
// How it works (and everything it touches):
// - The user picks files with a plain <input type="file"> (or drag & drop onto
//   the settings page). Each file is copied into this plugin's own IndexedDB
//   database ("hermes-wallpaper", origin-local, on this computer only) so it
//   survives restarts and the original may move. Nothing is uploaded; there
//   are no network calls, no backend and no gateway RPC.
// - Settings live in ctx.storage (keys under hermes.plugin.hermes-wallpaper.).
// - The background is the plugin's own fixed element (#hermes-wallpaper-layer,
//   z-index -1) plus one <style> tag. While a wallpaper is shown, that style
//   applies the same transparent-surface rules Desktop's own glass mode uses
//   (surface CSS variables, the two full-window shell painters) under the
//   plugin's own <html data-hermes-wallpaper> attribute, so the layer shows
//   through. Turning the wallpaper off or disabling the plugin removes the
//   attribute, the element and the style tag.
// - UI: a status-bar popover, a /wallpaper page, a Settings → Plugins page,
//   an Appearance section and four command-palette commands.
import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-wallpaper'
const ROUTE = '/wallpaper'
const SETTINGS_KEY = 'settings.v1' // ctx.storage key
const DB_NAME = 'hermes-wallpaper'
const LAYER_ID = 'hermes-wallpaper-layer'
const STYLE_ID = 'hermes-wallpaper-style'
const ATTR = 'data-hermes-wallpaper'
const BIG_FILE = 400 * 1024 * 1024

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|apng|jfif)$/i
const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogv|ogg|mkv)$/i

const DEFAULTS = {
  enabled: true,
  activeId: null,
  opacity: 70,
  blur: 0,
  brightness: 90,
  saturation: 100,
  contrast: 100,
  fit: 'cover',
  position: 'center',
  zoom: 100,
  vignette: 0,
  mirror: false,
  videoSpeed: 1,
  pauseWhenHidden: true,
  pauseWhenUnfocused: false,
  stillOnReducedMotion: true,
  slideshow: 0,
  shuffle: false,
}

// ───────────────────────── tiny store ─────────────────────────

// ctx.storage (namespaced to this plugin) once register() runs.
let pluginStorage = null

function loadSettings() {
  try {
    const raw = pluginStorage ? pluginStorage.get(SETTINGS_KEY, {}) : {}
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

const store = {
  settings: loadSettings(),
  library: [], // [{ id, name, kind, mime, size, added, thumb, w, h, duration }]
  libraryLoaded: false,
  current: { id: null, url: null, kind: null }, // object URL of the active media
  busy: '',
  version: 0,
}
const listeners = new Set()
function emit() {
  store.version++
  for (const fn of [...listeners]) {
    try { fn() } catch { /* ignore */ }
  }
}
function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function useStoreVersion() {
  return useSyncExternalStore(subscribe, () => store.version)
}
function setSettings(patch) {
  store.settings = { ...store.settings, ...patch }
  try { if (pluginStorage) pluginStorage.set(SETTINGS_KEY, store.settings) } catch { /* ignore */ }
  emit()
}
function setBusy(text) {
  store.busy = text
  emit()
}

// ───────────────────────── host helpers ─────────────────────────

const host = sdk.host
function notify(kind, message) {
  try {
    if (host && typeof host.notify === 'function') return host.notify({ kind, message })
  } catch { /* ignore */ }
  ;(kind === 'error' ? console.error : console.info)('[wallpaper]', message)
}
function navigate(path) {
  try {
    if (host && typeof host.navigate === 'function') return host.navigate(path)
  } catch { /* ignore */ }
  location.hash = '#' + path
}

// ───────────────────────── IndexedDB ─────────────────────────

let dbPromise = null
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => {
        const d = r.result
        if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' })
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' })
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => { dbPromise = null; reject(r.error) }
      r.onblocked = () => { dbPromise = null; reject(new Error('Wallpaper database is blocked by another window')) }
    })
  }
  return dbPromise
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
async function idb(stores, mode, fn) {
  const d = await openDb()
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode)
    let result
    Promise.resolve(fn(t)).then((v) => { result = v }, (e) => { try { t.abort() } catch { /* */ } reject(e) })
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('Transaction aborted'))
  })
}
const dbListItems = () => idb(['items'], 'readonly', (t) => reqP(t.objectStore('items').getAll()))
const dbGetBlob = (id) => idb(['blobs'], 'readonly', (t) => reqP(t.objectStore('blobs').get(id))).then((r) => (r ? r.blob : null))
const dbPut = (item, blob) => idb(['items', 'blobs'], 'readwrite', (t) => {
  t.objectStore('blobs').put({ id: item.id, blob })
  return reqP(t.objectStore('items').put(item))
})
const dbDelete = (id) => idb(['items', 'blobs'], 'readwrite', (t) => {
  t.objectStore('blobs').delete(id)
  return reqP(t.objectStore('items').delete(id))
})

async function refreshLibrary() {
  try {
    const items = await dbListItems()
    items.sort((a, b) => (b.added || 0) - (a.added || 0))
    store.library = items
  } catch (e) {
    notify('error', `Wallpaper library could not be read: ${e && e.message ? e.message : e}`)
  }
  store.libraryLoaded = true
  emit()
}

// ───────────────────────── media probing / thumbnails ─────────────────────────

function kindOf(file) {
  const t = (file.type || '').toLowerCase()
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (IMAGE_EXT.test(file.name || '')) return 'image'
  if (VIDEO_EXT.test(file.name || '')) return 'video'
  return null
}

function drawThumb(source, sw, sh) {
  const W = 320
  const H = 180
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  const s = Math.max(W / sw, H / sh)
  const dw = sw * s
  const dh = sh * s
  g.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh)
  return c.toDataURL('image/jpeg', 0.78)
}

function probeImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    const t = setTimeout(() => { URL.revokeObjectURL(url); reject(new Error('Timed out reading the image')) }, 20000)
    img.onload = () => {
      clearTimeout(t)
      try {
        const w = img.naturalWidth || 1280
        const h = img.naturalHeight || 720
        resolve({ thumb: drawThumb(img, w, h), w, h })
      } catch (e) {
        reject(e)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => { clearTimeout(t); URL.revokeObjectURL(url); reject(new Error('This image format cannot be displayed')) }
    img.src = url
  })
}

function probeVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.playsInline = true
    let done = false
    const finish = (err, out) => {
      if (done) return
      done = true
      clearTimeout(timer)
      v.removeAttribute('src')
      try { v.load() } catch { /* */ }
      URL.revokeObjectURL(url)
      err ? reject(err) : resolve(out)
    }
    const timer = setTimeout(() => finish(new Error('Timed out reading the video')), 20000)
    const grab = () => {
      try {
        if (!v.videoWidth) return finish(new Error('The file has no playable video track'))
        finish(null, { thumb: drawThumb(v, v.videoWidth, v.videoHeight), w: v.videoWidth, h: v.videoHeight, duration: v.duration })
      } catch (e) {
        finish(e)
      }
    }
    v.onerror = () => finish(new Error('This video codec cannot be played here (use MP4/H.264 or WebM)'))
    v.onloadeddata = () => {
      const target = Math.min(1, (v.duration || 0) / 3)
      if (!isFinite(target) || target < 0.05) return grab()
      v.onseeked = grab
      v.currentTime = target
    }
    v.src = url
  })
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

async function addFiles(fileList, { activate = true } = {}) {
  const files = Array.from(fileList || [])
  if (!files.length) return
  let lastId = null
  for (const file of files) {
    const kind = kindOf(file)
    if (!kind) {
      notify('warning', `${file.name}: not an image or video`)
      continue
    }
    if (file.size > BIG_FILE) {
      notify('warning', `${file.name} is ${fmtSize(file.size)} — large videos use a lot of disk space and memory.`)
    }
    setBusy(`Importing ${file.name}…`)
    try {
      const meta = kind === 'image' ? await probeImage(file) : await probeVideo(file)
      const item = {
        id: uid(),
        name: file.name || (kind === 'image' ? 'Image' : 'Video'),
        kind,
        mime: file.type || '',
        size: file.size,
        added: Date.now(),
        ...meta,
      }
      await dbPut(item, file)
      lastId = item.id
    } catch (e) {
      const msg = e && e.name === 'QuotaExceededError' ? 'not enough storage space' : (e && e.message) || String(e)
      notify('error', `${file.name}: ${msg}`)
    }
  }
  setBusy('')
  await refreshLibrary()
  if (lastId && activate) {
    setSettings({ activeId: lastId, enabled: true })
    notify('success', 'Wallpaper set')
  }
}

async function removeItem(id) {
  try {
    await dbDelete(id)
  } catch (e) {
    notify('error', `Could not remove: ${e && e.message ? e.message : e}`)
  }
  if (store.settings.activeId === id) {
    const next = store.library.find((it) => it.id !== id)
    setSettings({ activeId: next ? next.id : null })
  }
  await refreshLibrary()
}

function pickFiles() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,video/*,.gif,.webp,.avif,.mp4,.webm,.mov,.m4v,.mkv,.ogv'
  input.multiple = true
  input.style.display = 'none'
  input.addEventListener('change', () => {
    const files = input.files ? Array.from(input.files) : []
    input.remove()
    addFiles(files)
  })
  document.body.appendChild(input)
  input.click()
}

function fmtSize(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ───────────────────────── background layer ─────────────────────────

const CSS = `
:root[${ATTR}] body { background: transparent !important; }
:root[${ATTR}] {
  --ui-chat-surface-background: transparent;
  --ui-sidebar-surface-background: transparent;
  --ui-editor-surface-background: transparent;
  --ui-terminal-surface-background: var(--ui-bg-chrome);
}
:root[${ATTR}] [data-contrib-shell],
:root[${ATTR}] [data-slot='sidebar-wrapper'] { background-color: transparent !important; }
:root[${ATTR}] [data-glass-opaque] {
  --ui-chat-surface-background: var(--ui-bg-chrome);
  --ui-editor-surface-background: var(--ui-bg-chrome);
  --ui-sidebar-surface-background: var(--ui-bg-sidebar);
}
:root[${ATTR}] [data-glass-raised] {
  --ui-chat-surface-background: color-mix(in srgb, var(--ui-bg-chrome) 94%, transparent);
  --ui-sidebar-surface-background: color-mix(in srgb, var(--ui-bg-sidebar) 94%, transparent);
  --ui-editor-surface-background: var(--ui-bg-chrome);
}
#${LAYER_ID} {
  position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden;
  background: var(--ui-bg-chrome, #111);
  contain: strict;
}
#${LAYER_ID} > .hw-media { position: absolute; inset: 0; will-change: opacity, filter; transition: opacity .35s ease; }
#${LAYER_ID} > .hw-media > * { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#${LAYER_ID} > .hw-vignette { position: absolute; inset: 0; }
`

const POS = {
  center: 'center center',
  top: 'center top',
  bottom: 'center bottom',
  left: 'left center',
  right: 'right center',
}

function mediaStyle(s, forPreview) {
  const blur = forPreview ? s.blur * 0.35 : s.blur
  const filter = [
    blur > 0 ? `blur(${blur}px)` : '',
    s.brightness !== 100 ? `brightness(${s.brightness / 100})` : '',
    s.saturation !== 100 ? `saturate(${s.saturation / 100})` : '',
    s.contrast !== 100 ? `contrast(${s.contrast / 100})` : '',
  ].filter(Boolean).join(' ')
  const scale = (s.zoom || 100) / 100
  const pad = blur > 0 ? Math.ceil(blur * 2.5) : 0 // bleed past the edges so blur has no faded rim
  return {
    opacity: String(Math.max(0, Math.min(100, s.opacity)) / 100),
    filter: filter || 'none',
    transform: `scale(${s.mirror ? -scale : scale}, ${scale})`,
    inset: `${-pad}px`,
  }
}

function vignetteStyle(s) {
  const v = Math.max(0, Math.min(100, s.vignette || 0)) / 100
  if (!v) return { background: 'none' }
  return { background: `radial-gradient(ellipse at center, transparent ${Math.round(55 - v * 30)}%, rgba(0,0,0,${(0.85 * v).toFixed(3)}) 100%)` }
}

function buildMediaNode(kind, url, s) {
  if (kind === 'video') {
    const v = document.createElement('video')
    v.muted = true
    v.defaultMuted = true
    v.loop = true
    v.autoplay = true
    v.playsInline = true
    v.disablePictureInPicture = true
    v.setAttribute('muted', '')
    v.setAttribute('playsinline', '')
    v.preload = 'auto'
    v.src = url
    applyVideoFit(v, s)
    return v
  }
  const d = document.createElement('div')
  d.style.backgroundImage = `url("${url}")`
  applyImageFit(d, s)
  return d
}

function applyImageFit(d, s) {
  const fit = s.fit
  d.style.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat'
  d.style.backgroundSize = fit === 'cover' ? 'cover' : fit === 'contain' ? 'contain' : fit === 'fill' ? '100% 100%' : 'auto'
  d.style.backgroundPosition = POS[s.position] || POS.center
}
function applyVideoFit(v, s) {
  const fit = s.fit
  v.style.objectFit = fit === 'contain' ? 'contain' : fit === 'fill' ? 'fill' : fit === 'center' ? 'none' : 'cover'
  v.style.objectPosition = POS[s.position] || POS.center
}

const runtime = {
  layer: null,
  mediaWrap: null,
  vignette: null,
  node: null,
  loadingId: null,
  lastSwitch: Date.now(),
  focused: typeof document !== 'undefined' ? document.hasFocus() : true,
  reducedMq: null,
}

function ensureLayer() {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style')
    st.id = STYLE_ID
    st.textContent = CSS
    document.head.appendChild(st)
  }
  let layer = document.getElementById(LAYER_ID)
  if (!layer) {
    layer = document.createElement('div')
    layer.id = LAYER_ID
    layer.setAttribute('aria-hidden', 'true')
    const m = document.createElement('div')
    m.className = 'hw-media'
    const vg = document.createElement('div')
    vg.className = 'hw-vignette'
    layer.append(m, vg)
    document.body.prepend(layer)
  }
  runtime.layer = layer
  runtime.mediaWrap = layer.querySelector('.hw-media')
  runtime.vignette = layer.querySelector('.hw-vignette')
  return layer
}

function teardownLayer() {
  document.documentElement.removeAttribute(ATTR)
  const layer = document.getElementById(LAYER_ID)
  if (layer) layer.remove()
  const st = document.getElementById(STYLE_ID)
  if (st) st.remove()
  runtime.layer = runtime.mediaWrap = runtime.vignette = runtime.node = null
  if (store.current.url) URL.revokeObjectURL(store.current.url)
  store.current = { id: null, url: null, kind: null }
}

function shouldBeStill(s) {
  return !!(s.stillOnReducedMotion && runtime.reducedMq && runtime.reducedMq.matches)
}

function updatePlayback() {
  const v = runtime.node
  if (!v || v.tagName !== 'VIDEO') return
  const s = store.settings
  v.playbackRate = Math.max(0.1, Math.min(4, Number(s.videoSpeed) || 1))
  const hidden = s.pauseWhenHidden && document.visibilityState === 'hidden'
  const unfocused = s.pauseWhenUnfocused && !runtime.focused
  if (hidden || unfocused || shouldBeStill(s)) {
    if (!v.paused) v.pause()
  } else if (v.paused) {
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }
}

function applyLook() {
  const s = store.settings
  if (!runtime.mediaWrap) return
  Object.assign(runtime.mediaWrap.style, mediaStyle(s, false))
  Object.assign(runtime.vignette.style, vignetteStyle(s))
  const n = runtime.node
  if (n) {
    if (n.tagName === 'VIDEO') applyVideoFit(n, s)
    else applyImageFit(n, s)
  }
  updatePlayback()
}

async function syncLayer() {
  const s = store.settings
  const item = s.activeId ? store.library.find((it) => it.id === s.activeId) : null
  const active = s.enabled && item
  if (!active) {
    if (!store.libraryLoaded && s.enabled && s.activeId) return // wait for the library
    document.documentElement.removeAttribute(ATTR)
    if (runtime.node) { runtime.node.remove(); runtime.node = null }
    if (store.current.url) { URL.revokeObjectURL(store.current.url); store.current = { id: null, url: null, kind: null }; emit() }
    return
  }
  ensureLayer()
  if (store.current.id !== item.id && runtime.loadingId !== item.id) {
    runtime.loadingId = item.id
    let blob = null
    try {
      blob = await dbGetBlob(item.id)
    } catch (e) {
      notify('error', `Wallpaper could not be loaded: ${e && e.message ? e.message : e}`)
    }
    if (runtime.loadingId !== item.id) return // superseded
    runtime.loadingId = null
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const node = buildMediaNode(item.kind, url, s)
    const old = runtime.node
    const oldUrl = store.current.url
    runtime.mediaWrap.appendChild(node)
    runtime.node = node
    if (old) old.remove()
    if (oldUrl) URL.revokeObjectURL(oldUrl)
    store.current = { id: item.id, url, kind: item.kind }
    runtime.lastSwitch = Date.now()
    emit()
  }
  document.documentElement.setAttribute(ATTR, '')
  applyLook()
}

function nextWallpaper(direction = 1) {
  const lib = store.library
  if (!lib.length) return
  const s = store.settings
  let idx = lib.findIndex((it) => it.id === s.activeId)
  if (s.shuffle && lib.length > 2) {
    let n = idx
    while (n === idx) n = Math.floor(Math.random() * lib.length)
    idx = n
  } else {
    idx = (idx + direction + lib.length) % lib.length
  }
  runtime.lastSwitch = Date.now()
  setSettings({ activeId: lib[idx].id, enabled: true })
}

// ───────────────────────── UI ─────────────────────────

function el(type, props, ...kids) {
  const p = props ? { ...props } : {}
  let key
  if ('key' in p) { key = p.key; delete p.key }
  const flat = kids.filter((k) => k !== undefined)
  if (flat.length === 1) p.children = flat[0]
  else if (flat.length > 1) p.children = flat
  return flat.length > 1 ? jsxs(type, p, key) : jsx(type, p, key)
}

const T = {
  text: 'var(--ui-text-primary, currentColor)',
  sub: 'var(--ui-text-secondary, currentColor)',
  faint: 'var(--ui-text-tertiary, currentColor)',
  stroke: 'var(--ui-stroke-secondary, rgba(127,127,127,.3))',
  stroke3: 'var(--ui-stroke-tertiary, rgba(127,127,127,.2))',
  accent: 'var(--ui-accent, #6aa0ff)',
  card: 'var(--ui-bg-tertiary, rgba(127,127,127,.08))',
  hover: 'var(--ui-bg-quaternary, rgba(127,127,127,.12))',
}

const S = {
  section: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0', borderTop: `1px solid ${T.stroke3}` },
  h: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: T.faint, margin: 0 },
  row: { display: 'grid', gridTemplateColumns: 'minmax(120px, 170px) 1fr auto', alignItems: 'center', gap: 12, minHeight: 28 },
  label: { fontSize: 12.5, color: T.text },
  hint: { fontSize: 11.5, color: T.faint, lineHeight: 1.45 },
  value: { fontSize: 11.5, color: T.sub, minWidth: 46, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  btn: {
    appearance: 'none', border: `1px solid ${T.stroke}`, background: T.card, color: T.text, borderRadius: 6,
    fontSize: 12, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.2,
  },
}

function Btn({ onClick, children, primary, danger, title, disabled, small }) {
  const style = {
    ...S.btn,
    ...(small ? { padding: '3px 8px', fontSize: 11.5 } : null),
    ...(primary ? { background: T.accent, borderColor: 'transparent', color: 'var(--ui-text-on-accent, white)' } : null),
    ...(danger ? { color: 'var(--ui-text-danger, #e5484d)' } : null),
    ...(disabled ? { opacity: 0.5, cursor: 'default' } : null),
  }
  return el('button', { type: 'button', style, onClick: disabled ? undefined : onClick, title, disabled }, children)
}

function Toggle({ checked, onChange, label }) {
  const SdkSwitch = sdk.Switch
  if (SdkSwitch) {
    return jsx(SdkSwitch, { checked: !!checked, onCheckedChange: (v) => onChange(!!v), 'aria-label': label })
  }
  return el('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': !!checked,
    'aria-label': label,
    onClick: () => onChange(!checked),
    style: {
      width: 32, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer', position: 'relative', padding: 0,
      background: checked ? T.accent : T.hover, transition: 'background .15s',
    },
  }, el('span', {
    style: {
      position: 'absolute', top: 2, left: checked ? 16 : 2, width: 14, height: 14, borderRadius: 7,
      background: 'white', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.3)',
    },
  }))
}

function Row({ label, hint, children, value, narrow }) {
  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
    el('div', { style: narrow ? { ...S.row, gridTemplateColumns: '78px 1fr 44px', gap: 8 } : S.row },
      el('div', { style: S.label }, label),
      el('div', { style: { minWidth: 0 } }, children),
      el('div', { style: S.value }, value == null ? '' : value),
    ),
    hint ? el('div', { style: { ...S.hint, paddingLeft: 0 } }, hint) : undefined,
  )
}

function Range({ k, min, max, step = 1, unit = '', label, hint, format, narrow }) {
  const v = store.settings[k]
  return jsx(Row, {
    label,
    hint,
    narrow,
    value: format ? format(v) : `${v}${unit}`,
    children: el('input', {
      type: 'range',
      min, max, step,
      value: v,
      'aria-label': label,
      onChange: (e) => setSettings({ [k]: Number(e.target.value) }),
      onDoubleClick: () => setSettings({ [k]: DEFAULTS[k] }),
      title: 'Double-click to reset',
      style: { width: '100%', accentColor: T.accent, cursor: 'pointer' },
    }),
  })
}

function Segments({ k, options, label, hint }) {
  const v = store.settings[k]
  return jsx(Row, {
    label,
    hint,
    children: el('div', {
      role: 'radiogroup',
      'aria-label': label,
      style: { display: 'inline-flex', flexWrap: 'wrap', gap: 2, padding: 2, borderRadius: 7, border: `1px solid ${T.stroke3}`, background: T.card },
    }, ...options.map(([val, text]) => el('button', {
      key: String(val),
      type: 'button',
      role: 'radio',
      'aria-checked': v === val,
      onClick: () => setSettings({ [k]: val }),
      style: {
        appearance: 'none', border: 'none', borderRadius: 5, padding: '3px 9px', fontSize: 11.5, cursor: 'pointer',
        background: v === val ? T.accent : 'transparent',
        color: v === val ? 'var(--ui-text-on-accent, white)' : T.sub,
      },
    }, text))),
  })
}

function Check({ k, label, hint }) {
  return jsx(Row, { label, hint, children: jsx(Toggle, { checked: store.settings[k], label, onChange: (v) => setSettings({ [k]: v }) }) })
}

function Preview() {
  const s = store.settings
  const cur = store.current
  const ref = useRef(null)
  useEffect(() => {
    const v = ref.current
    if (v && v.tagName === 'VIDEO') {
      v.playbackRate = Math.max(0.1, Math.min(4, Number(s.videoSpeed) || 1))
      const p = v.play()
      if (p && p.catch) p.catch(() => {})
    }
  })
  const ms = mediaStyle(s, true)
  const wrap = { position: 'absolute', inset: ms.inset, opacity: ms.opacity, filter: ms.filter, transform: ms.transform }
  let media = null
  if (cur.url && s.enabled) {
    if (cur.kind === 'video') {
      media = el('video', {
        ref, src: cur.url, muted: true, loop: true, autoPlay: true, playsInline: true,
        style: {
          width: '100%', height: '100%', display: 'block',
          objectFit: s.fit === 'contain' ? 'contain' : s.fit === 'fill' ? 'fill' : s.fit === 'center' ? 'none' : 'cover',
          objectPosition: POS[s.position] || POS.center,
        },
      })
    } else {
      media = el('div', {
        style: {
          width: '100%', height: '100%',
          backgroundImage: `url("${cur.url}")`,
          backgroundRepeat: s.fit === 'tile' ? 'repeat' : 'no-repeat',
          backgroundSize: s.fit === 'cover' ? 'cover' : s.fit === 'contain' ? 'contain' : s.fit === 'fill' ? '100% 100%' : (s.fit === 'tile' ? '30%' : '40%'),
          backgroundPosition: POS[s.position] || POS.center,
        },
      })
    }
  }
  return el('div', {
    style: {
      position: 'relative', width: '100%', maxWidth: 460, aspectRatio: '16 / 9', borderRadius: 10, overflow: 'hidden',
      border: `1px solid ${T.stroke}`, background: 'var(--ui-bg-chrome)', flexShrink: 0,
    },
  },
  media ? el('div', { style: wrap }, media) : el('div', {
    style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: T.faint, fontSize: 12 },
  }, s.enabled ? 'No wallpaper selected' : 'Wallpaper is off'),
  el('div', { style: { position: 'absolute', inset: 0, ...vignetteStyle(s) } }),
  // fake UI chrome so the preview reads like the app
  el('div', { style: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '24%', borderRight: `1px solid ${T.stroke3}` } },
    ...[0, 1, 2, 3].map((i) => el('div', { key: 'l' + i, style: { margin: `${i ? 6 : 14}px 8px 0`, height: 6, borderRadius: 3, background: T.hover } }))),
  el('div', { style: { position: 'absolute', left: '30%', right: '8%', top: '18%', display: 'flex', flexDirection: 'column', gap: 6 } },
    el('div', { style: { alignSelf: 'flex-end', width: '45%', height: 14, borderRadius: 7, background: 'var(--ui-chat-bubble-background, ' + T.hover + ')' } }),
    el('div', { style: { width: '90%', height: 5, borderRadius: 3, background: T.faint, opacity: 0.6 } }),
    el('div', { style: { width: '75%', height: 5, borderRadius: 3, background: T.faint, opacity: 0.6 } }),
    el('div', { style: { width: '82%', height: 5, borderRadius: 3, background: T.faint, opacity: 0.6 } })),
  el('div', { style: { position: 'absolute', left: '30%', right: '8%', bottom: '8%', height: 20, borderRadius: 8, border: `1px solid ${T.stroke}`, background: 'var(--ui-bg-elevated, transparent)' } }),
  )
}

function LibraryItem({ item, active }) {
  const [hover, setHover] = useState(false)
  return el('div', {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex', flexDirection: 'column', gap: 4, width: 150, padding: 4, borderRadius: 9,
      border: `2px solid ${active ? T.accent : 'transparent'}`, background: hover ? T.hover : 'transparent',
    },
  },
  el('button', {
    type: 'button',
    title: `Use ${item.name}`,
    onClick: () => setSettings({ activeId: item.id, enabled: true }),
    style: {
      position: 'relative', padding: 0, border: 'none', cursor: 'pointer', borderRadius: 6, overflow: 'hidden',
      width: '100%', aspectRatio: '16 / 9', background: `center / cover no-repeat url("${item.thumb || ''}")`,
    },
  }, item.kind === 'video'
    ? el('span', {
      style: {
        position: 'absolute', right: 4, bottom: 4, fontSize: 10, padding: '1px 5px', borderRadius: 4,
        background: 'rgba(0,0,0,.6)', color: 'white',
      },
    }, `▶ ${item.duration && isFinite(item.duration) ? Math.round(item.duration) + 's' : 'video'}`)
    : undefined),
  el('div', { style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } },
    el('div', { style: { flex: 1, minWidth: 0 } },
      el('div', { style: { fontSize: 11.5, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, title: item.name }, item.name),
      el('div', { style: { fontSize: 10.5, color: T.faint } }, `${item.w || '?'}×${item.h || '?'} · ${fmtSize(item.size)}`)),
    el('button', {
      type: 'button',
      title: 'Remove from library',
      'aria-label': `Remove ${item.name}`,
      onClick: () => removeItem(item.id),
      style: { appearance: 'none', border: 'none', background: 'transparent', color: T.faint, cursor: 'pointer', fontSize: 14, padding: '0 4px', visibility: hover ? 'visible' : 'hidden' },
    }, '✕')),
  )
}

function DropZone({ children }) {
  const [over, setOver] = useState(false)
  return el('div', {
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true) },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { e.preventDefault(); setOver(false); addFiles(e.dataTransfer.files) },
    style: {
      borderRadius: 10, border: `1.5px dashed ${over ? T.accent : T.stroke}`, padding: 10,
      background: over ? T.hover : 'transparent', transition: 'background .12s, border-color .12s',
    },
  }, children)
}

function WallpaperPanel({ compact }) {
  useStoreVersion()
  const s = store.settings
  const lib = store.library
  const hasVideo = store.current.kind === 'video'
  return el('div', {
    'data-hermes-wallpaper-panel': '',
    style: { display: 'flex', flexDirection: 'column', gap: 4, color: T.text, maxWidth: 760, userSelect: 'none' },
  },
  el('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', paddingBottom: 12 } },
    jsx(Preview, {}),
    el('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 220, flex: 1 } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        jsx(Toggle, { checked: s.enabled, label: 'Show wallpaper', onChange: (v) => setSettings({ enabled: v }) }),
        el('span', { style: { fontSize: 13, fontWeight: 500 } }, s.enabled ? 'Wallpaper on' : 'Wallpaper off')),
      el('div', { style: S.hint }, 'Pick any image, GIF or short video from your drive. It is copied into Hermes on this computer, sits behind the whole window and stays after restarts.'),
      el('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        jsx(Btn, { primary: true, onClick: pickFiles, children: 'Choose file…' }),
        lib.length > 1 ? jsx(Btn, { onClick: () => nextWallpaper(-1), children: '‹ Prev', title: 'Previous wallpaper' }) : undefined,
        lib.length > 1 ? jsx(Btn, { onClick: () => nextWallpaper(1), children: 'Next ›', title: 'Next wallpaper' }) : undefined,
        jsx(Btn, {
          onClick: () => setSettings({ ...DEFAULTS, activeId: s.activeId, enabled: s.enabled }),
          title: 'Reset all look settings to defaults (keeps your files)',
          children: 'Reset look',
        })),
      store.busy ? el('div', { style: { ...S.hint, color: T.accent } }, store.busy) : undefined)),

  el('div', { style: S.section },
    el('h4', { style: S.h }, `Library${lib.length ? ` · ${lib.length}` : ''}`),
    jsx(DropZone, {
      children: lib.length
        ? el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
          ...lib.map((it) => jsx(LibraryItem, { item: it, active: it.id === s.activeId }, it.id)))
        : el('div', { style: { ...S.hint, padding: '18px 8px', textAlign: 'center' } },
          store.libraryLoaded ? 'Drop images or videos here, or use “Choose file…”.' : 'Loading…'),
    })),

  el('div', { style: S.section },
    el('h4', { style: S.h }, 'Look'),
    jsx(Range, { k: 'opacity', label: 'Opacity', min: 0, max: 100, unit: '%', hint: compact ? undefined : 'How strongly the wallpaper shows through. Lower values blend it into the theme colour, keeping text readable.' }),
    jsx(Range, { k: 'blur', label: 'Blur', min: 0, max: 60, unit: 'px' }),
    jsx(Range, { k: 'brightness', label: 'Brightness', min: 10, max: 160, unit: '%', hint: compact ? undefined : 'Dim a bright picture so chat text stays legible.' }),
    jsx(Range, { k: 'saturation', label: 'Saturation', min: 0, max: 200, unit: '%' }),
    jsx(Range, { k: 'contrast', label: 'Contrast', min: 30, max: 170, unit: '%' }),
    jsx(Range, { k: 'vignette', label: 'Vignette', min: 0, max: 100, unit: '%' })),

  el('div', { style: S.section },
    el('h4', { style: S.h }, 'Layout'),
    jsx(Segments, { k: 'fit', label: 'Fit', options: [['cover', 'Fill'], ['contain', 'Fit'], ['fill', 'Stretch'], ['center', 'Center'], ['tile', 'Tile']] }),
    jsx(Segments, { k: 'position', label: 'Anchor', options: [['center', 'Center'], ['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']] }),
    jsx(Range, { k: 'zoom', label: 'Zoom', min: 100, max: 200, unit: '%' }),
    jsx(Check, { k: 'mirror', label: 'Mirror horizontally' })),

  el('div', { style: S.section },
    el('h4', { style: S.h }, `Video${hasVideo ? '' : ' (applies to video wallpapers)'}`),
    jsx(Range, { k: 'videoSpeed', label: 'Playback speed', min: 0.25, max: 2, step: 0.05, format: (v) => `${Number(v).toFixed(2)}×` }),
    jsx(Check, { k: 'pauseWhenHidden', label: 'Pause when minimized', hint: compact ? undefined : 'Saves battery and GPU while Hermes is not visible.' }),
    jsx(Check, { k: 'pauseWhenUnfocused', label: 'Pause when unfocused', hint: compact ? undefined : 'Freeze the video while you work in another app.' }),
    jsx(Check, { k: 'stillOnReducedMotion', label: 'Respect reduced motion', hint: compact ? undefined : 'Show a still frame when the system asks for reduced motion.' })),

  el('div', { style: S.section },
    el('h4', { style: S.h }, 'Slideshow'),
    jsx(Segments, { k: 'slideshow', label: 'Change every', options: [[0, 'Off'], [1, '1 min'], [5, '5 min'], [15, '15 min'], [60, '1 h']], hint: lib.length < 2 && s.slideshow ? 'Add at least two files to the library.' : undefined }),
    jsx(Check, { k: 'shuffle', label: 'Shuffle' })),
  )
}

function WallpaperPage() {
  return el('div', { style: { height: '100%', overflow: 'auto' } },
    el('div', { style: { padding: '28px 32px 48px', maxWidth: 820 } },
      el('h2', { style: { fontSize: 18, fontWeight: 600, margin: '0 0 4px', color: T.text } }, 'Wallpaper'),
      el('div', { style: { ...S.hint, marginBottom: 18 } }, 'Your own picture or video behind the entire Hermes window.'),
      jsx(WallpaperPanel, {})))
}

// Quick controls in the status-bar popover.
function QuickPanel({ close }) {
  useStoreVersion()
  const s = store.settings
  return el('div', { 'data-hermes-wallpaper-quick': '', style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, width: 300, boxSizing: 'border-box', color: T.text } },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      jsx(Toggle, { checked: s.enabled, label: 'Show wallpaper', onChange: (v) => setSettings({ enabled: v }) }),
      el('span', { style: { fontSize: 12.5, fontWeight: 500, flex: 1 } }, 'Wallpaper'),
      jsx(Btn, { small: true, primary: true, onClick: pickFiles, children: 'Choose file…' })),
    store.busy ? el('div', { style: { ...S.hint, color: T.accent } }, store.busy) : undefined,
    jsx(Range, { narrow: true, k: 'opacity', label: 'Opacity', min: 0, max: 100, unit: '%' }),
    jsx(Range, { narrow: true, k: 'blur', label: 'Blur', min: 0, max: 60, unit: 'px' }),
    jsx(Range, { narrow: true, k: 'brightness', label: 'Brightness', min: 10, max: 160, unit: '%' }),
    el('div', { style: { display: 'flex', gap: 6, justifyContent: 'space-between' } },
      store.library.length > 1 ? jsx(Btn, { small: true, onClick: () => nextWallpaper(1), children: 'Next ›' }) : el('span', {}),
      jsx(Btn, { small: true, onClick: () => { if (close) close(); navigate(ROUTE) }, children: 'All settings…' })))
}

// ───────────────────────── plugin entry ─────────────────────────

export default {
  id: ID,
  name: 'Wallpaper',
  version: '1.0.0',
  description: 'Use any image, GIF or short video from your drive as the background behind the whole Hermes window.',
  register(ctx) {
    pluginStorage = ctx.storage || null
    store.settings = loadSettings()
    const unsub = subscribe(() => { syncLayer() })
    ctx.onDispose(() => { unsub(); teardownLayer() })

    try {
      runtime.reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)')
      const onMq = () => updatePlayback()
      runtime.reducedMq.addEventListener('change', onMq)
      ctx.onDispose(() => runtime.reducedMq && runtime.reducedMq.removeEventListener('change', onMq))
    } catch { /* ignore */ }

    ctx.addEventListener(document, 'visibilitychange', () => updatePlayback())
    ctx.addEventListener(window, 'focus', () => { runtime.focused = true; updatePlayback() })
    ctx.addEventListener(window, 'blur', () => { runtime.focused = false; updatePlayback() })
    // Keep the layer if something re-renders <body> children, and re-check the slideshow.
    ctx.setInterval(() => {
      const s = store.settings
      if (s.enabled && s.activeId && !document.getElementById(LAYER_ID)) {
        runtime.layer = null
        store.current = { id: null, url: null, kind: null }
        syncLayer()
      }
      if (s.enabled && s.slideshow > 0 && store.library.length > 1 && Date.now() - runtime.lastSwitch >= s.slideshow * 60000) {
        nextWallpaper(1)
      }
    }, 5000)

    refreshLibrary().then(() => syncLayer())

    const reg = (c) => { try { return ctx.register(c) } catch (e) { console.warn('[wallpaper] register failed', c.id, e) } }

    if (sdk.ROUTES_AREA) reg({ id: 'page', area: sdk.ROUTES_AREA, title: 'Wallpaper', data: { path: ROUTE }, render: () => jsx(WallpaperPage, {}) })

    if (typeof ctx.registerSettingsPage === 'function') {
      try {
        ctx.registerSettingsPage({ id: 'wallpaper', title: 'Wallpaper', icon: 'file-media', render: () => jsx(WallpaperPanel, {}) })
      } catch (e) { console.warn('[wallpaper] settings page failed', e) }
    }

    if (sdk.APPEARANCE_AREAS && sdk.APPEARANCE_AREAS.extra) {
      reg({
        id: 'appearance',
        area: sdk.APPEARANCE_AREAS.extra,
        title: 'Wallpaper',
        render: () => el('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 } },
          el('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, 'Wallpaper'),
          jsx(WallpaperPanel, { compact: true })),
      })
    }

    if (sdk.STATUSBAR_AREAS && sdk.STATUSBAR_AREAS.right) {
      reg({
        id: 'chip',
        area: sdk.STATUSBAR_AREAS.right,
        order: 900,
        data: {
          id: `${ID}:chip`,
          icon: el('span', { 'data-hermes-wallpaper-chip': '', style: { display: 'inline-flex', alignItems: 'center' } }, sdk.Codicon ? jsx(sdk.Codicon, { name: 'file-media' }) : '🖼'),
          title: 'Wallpaper',
          toggleLabel: 'Wallpaper',
          variant: 'menu',
          menuAlign: 'end',
          menuClassName: 'w-auto',
          menuContent: (close) => jsx(QuickPanel, { close }),
        },
      })
    }

    if (sdk.PALETTE_AREA) {
      const cmds = [
        ['choose', 'Wallpaper: Choose image or video…', ['background', 'wallpaper', 'image', 'video', 'picture'], pickFiles],
        ['toggle', 'Wallpaper: Turn on/off', ['background', 'wallpaper', 'toggle'], () => setSettings({ enabled: !store.settings.enabled })],
        ['next', 'Wallpaper: Next', ['background', 'wallpaper', 'next', 'slideshow'], () => nextWallpaper(1)],
        ['settings', 'Wallpaper: Settings', ['background', 'wallpaper', 'blur', 'opacity'], () => navigate(ROUTE)],
      ]
      for (const [id, label, keywords, run] of cmds) {
        reg({ id: `cmd-${id}`, area: sdk.PALETTE_AREA, data: { id: `${ID}.${id}`, label, keywords, run } })
      }
    }
  },
}
