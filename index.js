/**
 * preset-bridge · 宿主半边
 *
 * 读 <DSH_HOME>/preset-bridge/presets/*.json（SillyTavern chat-completion 预设），
 * 把「启用的文本块」拼成一段系统提示，通过 systemPrompt.section 每轮注入。
 * 用户对每块的开关与编辑存进 overrides.json，原预设文件保持只读。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { appendFile, existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCardFile, renderCard } from './cards.js'

// sessions / sessionTitle 是可选的：拿不到就不显示会话标题，不影响主流程
export const inject = ['systemPrompt', 'webServer']

const ROUTE_PREFIX = '/preset-bridge'
const SECTION_ORDER = 35
const MAX_BODY = 8 * 1024 * 1024
const MAX_BLOCK_CHARS = 40000

// ST 内置占位块：内容靠角色卡在运行时填充，DSH 没有对应物
const PLACEHOLDER_IDS = new Set([
  'main', 'dialogue', 'chatHist', 'worldInf', 'charDesc', 'charPers',
  'scenario', 'personaD', 'nsfw', 'jailbreak', 'enhanceDefinitions',
])

function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function paths() {
  const root = join(homeDir(), 'preset-bridge')
  return {
    root,
    config: join(root, 'config.json'),
    overrides: join(root, 'overrides.json'),
    presets: join(root, 'presets'),
    cards: join(root, 'cards'),
    personas: join(root, 'personas'),
    // 用户改过的「基础角色」放这里；包内那份始终是出厂默认
    role: join(root, 'default-role.md'),
  }
}

/** 包内出厂默认的基础角色。 */
async function readRoleBuiltin() {
  try {
    return (await readFile(fileURLToPath(new URL('./default-role.md', import.meta.url)), 'utf8')).trim()
  } catch {
    return ''
  }
}

/** 生效的基础角色：用户覆盖层优先，否则用出厂默认。 */
async function readRoleEffective() {
  const p = paths()
  try {
    const custom = (await readFile(p.role, 'utf8')).trim()
    if (custom) return { text: custom, custom: true }
  } catch {
    // 没有用户版本
  }
  return { text: await readRoleBuiltin(), custom: false }
}

// ── 会话级人格（AGENT.md 那一层，按会话各选一份）────────────────────────────
function safePersonaId(raw) {
  return String(raw || '')
    .replace(/\.md$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
}

export function listPersonas() {
  const p = paths()
  try {
    return readdirSync(p.personas)
      .filter((n) => /\.md$/i.test(n))
      .sort()
      .map((n) => {
        const id = n.replace(/\.md$/i, '')
        let chars = 0
        try {
          chars = readFileSync(join(p.personas, n), 'utf8').trim().length
        } catch {
          chars = 0
        }
        return { id, name: id, chars }
      })
  } catch {
    return []
  }
}

export async function readPersona(id) {
  const safe = safePersonaId(id)
  if (!safe) return null
  try {
    const text = (await readFile(join(paths().personas, `${safe}.md`), 'utf8')).trim()
    if (!text) return null
    return { name: safe, text }
  } catch {
    return null
  }
}

async function ensureDirs() {
  const p = paths()
  await mkdir(p.presets, { recursive: true })
  await mkdir(p.cards, { recursive: true })
  await mkdir(p.personas, { recursive: true })
  return p
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 把任意来源的配置对象规整成完整字段（缺的用默认值补齐） */
function normalizeConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    active: typeof raw.active === 'string' && raw.active ? raw.active : null,
    // ST 的 {{user}} / {{char}} 在 DSH 里没有对应字段，用这两项顶替
    userName: typeof raw.userName === 'string' && raw.userName.trim() ? raw.userName.trim() : '用户',
    charName: typeof raw.charName === 'string' && raw.charName.trim() ? raw.charName.trim() : '角色',
    // 「我的设定」：用户自己的人设
    userPersona: typeof raw.userPersona === 'string' ? raw.userPersona : '',
    // 角色卡：AI 扮演谁
    activeCard: typeof raw.activeCard === 'string' && raw.activeCard ? raw.activeCard : null,
    // 没选角色卡时，注入内置的「基础角色」
    useDefaultRole: raw.useDefaultRole !== false,
    // 这个会话用的「人格」.md（按会话各自一份）
    personaFile: typeof raw.personaFile === 'string' && raw.personaFile ? raw.personaFile : null,
  }
}

async function readConfig() {
  return (migrated(await readConfigRaw())).defaults
}

async function readConfigRaw() {
  const p = await ensureDirs()
  return readJson(p.config, {})
}

/** 老版本的扁平配置迁移成 { defaults, sessions } 结构 */
function migrated(raw) {
  if (raw && raw.defaults && typeof raw.defaults === 'object') {
    return { defaults: normalizeConfig(raw.defaults), sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {} }
  }
  return { defaults: normalizeConfig(raw), sessions: {} }
}

/** 某个会话最终生效的配置：默认模板 + 该会话的覆盖 */
export async function configFor(sid) {
  const cfg = migrated(await readConfigRaw())
  if (!sid) return cfg.defaults
  const patch = cfg.sessions[sid]
  return patch && typeof patch === 'object' ? normalizeConfig({ ...cfg.defaults, ...patch }) : cfg.defaults
}

/** 只写这个会话的覆盖，不动别人的 */
export async function patchSession(sid, patch) {
  const cfg = migrated(await readConfigRaw())
  if (sid) {
    cfg.sessions[sid] = { ...(cfg.sessions[sid] || {}), ...patch }
  } else {
    cfg.defaults = { ...cfg.defaults, ...patch }
  }
  const p = await ensureDirs()
  await writeFile(p.config, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}


async function readOverrides() {
  const p = await ensureDirs()
  const raw = await readJson(p.overrides, {})
  return raw && typeof raw === 'object' ? raw : {}
}

async function writeOverrides(next) {
  const p = await ensureDirs()
  await writeFile(p.overrides, JSON.stringify(next, null, 2), 'utf8')
}

/** 解析 ST 预设 → 全量文本块（含 prompt_order 的默认开关）。 */
export function parsePreset(raw) {
  const prompts = Array.isArray(raw?.prompts) ? raw.prompts : []
  const orderSets = Array.isArray(raw?.prompt_order) ? raw.prompt_order : []
  // ST 的选择顺序：全局 dummy 集 100001 → 旧 dummy 100000 → 第一个非空组 → 第一组
  // （有的预设在前面放了一组空 order，直接取第一个会解析出"全关"）
  const usable = orderSets.filter((entry) => Array.isArray(entry?.order) && entry.order.length > 0)
  const set = usable.find((entry) => entry.character_id === 100001)
    ?? usable.find((entry) => entry.character_id === 100000)
    ?? usable[0]
    ?? orderSets.find((entry) => Array.isArray(entry?.order))
    ?? null
  const enabledById = new Map()
  let seq = 0
  if (set) {
    for (const item of set.order) {
      if (item && typeof item.identifier === 'string') {
        enabledById.set(item.identifier, item.enabled !== false)
      }
    }
  }

  const blocks = []
  for (const p of prompts) {
    if (!p || typeof p !== 'object') continue
    const id = typeof p.identifier === 'string' ? p.identifier : `blk-${seq}`
    seq += 1
    const content = typeof p.content === 'string' ? p.content : ''
    // 丢掉「纯脚手架块」：只有宏和 ST 的字段名（|用户：{{user}}|、<{{user}} Description>、
    // [Understood] 这类）。它们靠 ST 的 user/char persona 字段撑起来，DSH 没有对应物，
    // 保留下来只会变成一句没有信息量的空壳。
    const scaffold = content
      .replace(/\{\{[^}]*\}\}/g, '')
      .replace(/描述|设定|简介|名字|称呼|description|player|char|user|persona/gi, '')
      .replace(/[()[\]{}<>\s:：|,，.。\-*_'"`/]/g, '')
    // <{{char}}> / </{{char}}> / /char 是 ST 的角色卡槽位标记，内容本身就是标记，
    // 剥完宏是空的，但必须保留——卡正文要插在它们中间
    const charSlotMark = /^<\/?\s*\{\{\s*char\s*\}\}\s*>$|^\s*\/char\s*$/i.test(content.trim())
    if (!charSlotMark && scaffold === '') continue
    // 世界书占位：ST 在这里插 lorebook，DSH 没有世界书
    if (/^\[\s*world\s*settings?\s*\]$/i.test(content.trim())) continue
    if (/^\[?\s*(understood|ok|确定)\s*\]?$/i.test(content.trim())) continue
    const isPlaceholder = PLACEHOLDER_IDS.has(id) || content.trim() === ''
    blocks.push({
      id,
      name: (p.name || id || 'block').trim(),
      role: p.role || 'system',
      content,
      placeholder: isPlaceholder,
      // ST 只注入 prompt_order 里列出的块；没有 order 表时才默认全开
      defaultEnabled: set
        ? enabledById.get(id) === true
        : true,
    })
  }
  return blocks
}

/** 套用用户覆盖层，得到最终块集合。 */
export function applyOverrides(blocks, override = {}) {
  return blocks.map((b) => {
    const ov = override[b.id]
    const content = typeof ov?.content === 'string' ? ov.content : b.content
    const enabled = typeof ov?.enabled === 'boolean' ? ov.enabled : b.defaultEnabled
    return {
      ...b,
      content,
      enabled: enabled && !b.placeholder && content.trim() !== '',
      edited: typeof ov?.content === 'string' && ov.content !== b.content,
      toggled: typeof ov?.enabled === 'boolean' && ov.enabled !== b.defaultEnabled,
    }
  })
}

export function renderPreset(name, blocks, opts = {}) {
  const active = blocks.filter((b) => b.enabled)
  const userName = (opts.userName || '用户').trim() || '用户'
  const charName = (opts.charName || '角色').trim() || '角色'
  const persona = typeof opts.userPersona === 'string' ? opts.userPersona.trim() : ''
  const cardText = typeof opts.cardText === 'string' ? opts.cardText.trim() : ''
  // 会话级「人格」.md（对应 AGENT.md 那一层），跟角色卡分开：人格是"我是谁"，卡是"演谁"
  const personaDoc = opts.personaDoc && opts.personaDoc.text ? opts.personaDoc : null
  if (active.length === 0 && !persona && !cardText && !personaDoc) return ''
  const normalize = (text) => text
    .replace(/\{\{\s*lastMessage\s*\}\}/gi, '')
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
    .replace(/\{\{\s*original\s*\}\}/gi, '')
    .replace(/\{\{\s*persona\s*\}\}/gi, persona)
  const parts = []
  if (active.length > 0) {
    parts.push(
      `## 场景预设：${name}`,
      '以下内容来自 SillyTavern 预设，仅在当前启用的场景中生效。',
    )
  }
  if (active.length > 0 || persona || cardText || personaDoc) {
    parts.push('（分层优先级：用户当前的明确指令 > 人格 > 我的设定 > 角色卡 > 预设各块；冲突时以前者为准。）')
  }
  if (personaDoc) {
    parts.push('', `### 人格（${personaDoc.name || 'persona'}）`, normalize(personaDoc.text).trim())
  }
  // ST 的角色卡槽位：/char 块（内容 </{{char}}>）标出卡正文该插在哪，
  // 通常还有配对的 char 块（<{{char}}>）把它包起来。有槽位就填进槽位，
  // 没有才退回「放在最前面」的默认位置。
  const closeChar = /^<\/\s*\{\{\s*char\s*\}\}\s*>$/
  const charMark = /^\s*\/char\s*$/i
  const hasSlot = active.some((b) => closeChar.test(b.content.trim()) || charMark.test(b.content.trim()))
  if (cardText && !hasSlot) {
    parts.push('', normalize(cardText))
  }
  // 「我的设定」：玩家自己的身份/处境
  if (persona) {
    parts.push('', `### 用户设定（${userName}）`, normalize(persona))
  }
  const openChar = /^<\s*\{\{\s*char\s*\}\}\s*>$/
  for (const b of active) {
    const rawContent = b.content.trim()
    const body = normalize(b.content).trim()
    const isSlotOpen = openChar.test(rawContent)
    const isSlotClose = closeChar.test(rawContent)
    const isSlotMark = isSlotOpen || isSlotClose || charMark.test(rawContent)
    // 标记块不加「### 块名」标题，否则会变成 ### /char 这种噪音
    if (!isSlotMark) parts.push('', `### ${b.name}`)
    // 闭合槽位：卡正文插在闭合标签前面
    if (cardText && (isSlotClose || charMark.test(rawContent))) {
      parts.push('', normalize(cardText).trim())
    }
    parts.push(body)
  }
  return parts.join('\n').trim()
}

export function listCardFiles() {
  const p = paths()
  try {
    return readdirSync(p.cards)
      .filter((n) => /\.(png|json)$/i.test(n))
      .sort()
  } catch {
    return []
  }
}

/** 读一张卡：优先取用户改过的文本，否则按原卡字段组装。 */
export async function cardTextOf(id, overrides) {
  const p = paths()
  const name = listCardFiles().find((n) => n.replace(/\.(png|json)$/i, '') === id)
  if (!name) return ''
  const edited = overrides?.[`card:${id}`]?.text
  if (typeof edited === 'string' && edited.trim()) return edited.trim()
  const buf = await readFile(join(p.cards, name))
  const card = parseCardFile(buf)
  return card ? renderCard(card) : ''
}

export async function listCards() {
  const p = paths()
  const overrides = await readOverrides()
  const out = []
  for (const file of listCardFiles()) {
    const id = file.replace(/\.(png|json)$/i, '')
    try {
      const buf = await readFile(join(p.cards, file))
      const card = parseCardFile(buf)
      const text = await cardTextOf(id, overrides)
      out.push({
        id,
        file,
        name: card?.name ?? id,
        chars: text.length,
        edited: typeof overrides?.[`card:${id}`]?.text === 'string',
        fields: card
          ? {
              description: card.description.length,
              personality: card.personality.length,
              scenario: card.scenario.length,
              firstMes: card.firstMes.length,
              mesExample: card.mesExample.length,
              greetings: card.alternateGreetings.length,
            }
          : null,
        error: card ? false : true,
      })
    } catch {
      out.push({ id, file, name: id, chars: 0, error: true })
    }
  }
  return out
}

async function activeCardText(cfg, overrides) {
  if (!cfg.activeCard) return ''
  try {
    return await cardTextOf(cfg.activeCard, overrides)
  } catch {
    return ''
  }
}

async function loadPresetFile(id) {
  const p = await ensureDirs()
  const file = join(p.presets, `${id}.json`)
  if (!existsSync(file)) return null
  const raw = await readJson(file, null)
  if (!raw) return null
  return raw
}

async function describePreset(id) {
  const raw = await loadPresetFile(id)
  if (!raw) return null
  const overrides = await readOverrides()
  const cfg = await readConfig()
  const blocks = applyOverrides(parsePreset(raw), overrides[id] || {})
  const text = renderPreset(id, blocks, {
    userName: cfg.userName,
    charName: cfg.charName,
    userPersona: cfg.userPersona,
  })
  return {
    id,
    blocks: blocks.map((b) => ({
      id: b.id,
      name: b.name,
      role: b.role,
      enabled: b.enabled,
      placeholder: b.placeholder,
      edited: b.edited,
      toggled: b.toggled,
      chars: b.content.length,
      content: b.content,
      preview: b.content.slice(0, 120),
    })),
    chars: text.length,
    enabledBlocks: blocks.filter((b) => b.enabled).length,
    text,
  }
}

async function listPresets() {
  const p = await ensureDirs()
  let names = []
  try {
    names = (await readdir(p.presets)).filter((n) => n.toLowerCase().endsWith('.json'))
  } catch {
    names = []
  }
  const out = []
  for (const file of names.sort()) {
    const id = file.replace(/\.json$/i, '')
    const info = await describePreset(id)
    if (!info) {
      out.push({ id, error: true, blocks: [], chars: 0, enabledBlocks: 0 })
      continue
    }
    out.push({
      id,
      blocks: info.blocks,
      chars: info.chars,
      enabledBlocks: info.enabledBlocks,
      error: false,
    })
  }
  return out
}

/** 从装配上下文里取会话 id（不同版本字段名不一样，逐个探） */
export function sessionIdOf(context) {
  const s = context?.agent?.session
  if (!s || typeof s !== 'object') return null
  for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    const v = s[k]
    if (typeof v === 'string' && v) return v
  }
  const h = s.header
  if (h && typeof h === 'object') {
    for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
      const v = h[k]
      if (typeof v === 'string' && v) return v
    }
  }
  return null
}

async function currentText(sid) {
  const cfg = await configFor(sid)
  // 人格是"我是谁"，跟预设开关无关：选了就该一直在
  const personaDoc = cfg.personaFile ? await readPersona(cfg.personaFile) : null
  if (!cfg.enabled) {
    // 预设关着也要保留人格
    return personaDoc ? renderPreset('', [], { personaDoc }) : ''
  }
  const overrides = await readOverrides()
  let cardText = await activeCardText(cfg, overrides)
  // 基础角色只在「开了预设但没选卡」时兜底；没开预设就不注入，保持干净
  if (!cardText && cfg.useDefaultRole && cfg.active) {
    cardText = (await readRoleEffective()).text
  }
  let blocks = []
  let presetName = ''
  if (cfg.active) {
    const raw = await loadPresetFile(cfg.active)
    if (raw) {
      presetName = cfg.active
      blocks = applyOverrides(parsePreset(raw), overrides[cfg.active] || {})
    }
  }
  return renderPreset(presetName, blocks, {
    userName: cfg.userName,
    charName: cfg.charName,
    userPersona: cfg.userPersona,
    cardText,
    personaDoc,
  })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

export function apply(ctx) {
  // key = sessionId（或 '__default__'）→ 该会话拼好的注入文本
  const cache = new Map()

  // ── 注入式 UI ────────────────────────────────────────────────────────────
  // 不走 client 模块系统（那条路在这台机器上加载失败），改为往 index.html
  // 注入一段自己的脚本，画一个浮动按钮 + 面板。文件按请求读，改完刷新即生效。
  const uiPath = fileURLToPath(new URL('./ui.js', import.meta.url))
  const disposeUi = ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/ui.js`,
    handler: async (_req, res) => {
      try {
        const text = await readFile(uiPath, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        })
        res.end(text)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(String(error))
      }
    },
  })
  const disposeTap = ctx.webServer.tapIndex((html) => {
    const tag = `<script src="${ROUTE_PREFIX}/ui.js" defer></script>`
    if (html.includes(`${ROUTE_PREFIX}/ui.js`)) return html
    return html.includes('</body>') ? html.replace('</body>', `${tag}</body>`) : html + tag
  })

  // 每个会话各存一份拼好的文本；lastSid 记录最近一次装配的会话（面板据此判断"本会话"）
  let lastSid = null
  const refresh = async (sid) => {
    const key = sid || '__default__'
    const text = await currentText(sid)
    cache.set(key, text)
    return text
  }

  ctx.systemPrompt.section({
    name: 'preset-bridge:scene',
    order: SECTION_ORDER,
    // 预设原文含 SillyTavern 宏（{{user}}/{{char}}/{{lastMessage}} 等），
    // 而 DSH 会对 section 文本做严格 {{变量}} 插值：遇到未注册变量直接抛错，
    // 导致整轮 agent turn 失败。这里关闭插值，原样注入预设文本。
    interpolate: false,
    text: (context) => {
      const sid = sessionIdOf(context)
      if (sid) lastSid = sid
      const key = sid || '__default__'
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      // 这个会话第一次装配：先用默认模板顶上（新会话通常就是默认状态），
      // 同时排一次本会话的计算，下一轮起用会话自己的配置。
      void refresh(sid)
      return cache.get('__default__') || ''
    },
  })

  void refresh(null)

  // 请求里带来的会话 id 优先（面板会带），其次用最近一次装配的会话
  const sidFromReq = (req, body) => {
    if (body && typeof body.sessionId === 'string' && body.sessionId) return body.sessionId
    try {
      const q = new URL(String(req.url || '/'), 'http://x').searchParams.get('sid')
      if (q) return q
    } catch {
      // ignore
    }
    return lastSid
  }

  // 会话标题（面板上要显示"这个面板绑在哪个对话上"）
  const titleOf = (sid) => {
    if (!sid) return ''
    try {
      const s = ctx.get?.('sessions')?.get?.(sid)
      if (!s) return ''
      const snap = ctx.get?.('sessionTitle')?.get?.(s)
      return snap && snap.title ? String(snap.title) : ''
    } catch {
      return ''
    }
  }

  const state = async (sid) => {
    const key = sid || lastSid
    const cfg = await configFor(key)
    const overrides = await readOverrides()
    const cardText = await activeCardText(cfg, overrides)
    return {
      ...cfg,
      sessionId: key || null,
      sessionTitle: titleOf(key),
      isDefaultScope: !key,
      presets: await listPresets(),
      cards: await listCards(),
      personas: listPersonas(),
      cardChars: cardText.length,
      dir: paths().presets,
      cardsDir: paths().cards,
      personasDir: paths().personas,
      chars: (cache.get(key || '__default__') || '').length,
    }
  }

  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET') return sendJson(res, 200, await state(sidFromReq(req)))
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        // 作用域：默认写当前会话；body.scope === 'default' 时才写默认模板
        const sid = body.scope === 'default' ? null : sidFromReq(req, body)
        const cfg = await configFor(sid)
        const patch = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (body.active === null) patch.active = null
        else if (typeof body.active === 'string') patch.active = body.active
        if (typeof body.userName === 'string') patch.userName = body.userName.slice(0, 60)
        if (typeof body.charName === 'string') patch.charName = body.charName.slice(0, 60)
        if (typeof body.userPersona === 'string') patch.userPersona = body.userPersona.slice(0, 8000)
        if (typeof body.activeCard === 'string' || body.activeCard === null) patch.activeCard = body.activeCard

        // 打开总开关时，如果这个会话还没选预设，自动选第一个可用的
        if (patch.enabled === true && !('active' in patch) && !cfg.active) {
          const presets = await listPresets()
          patch.active = presets.find((x) => !x.error)?.id ?? null
        }

        await patchSession(sid, patch)
        await refresh(sid)
        return sendJson(res, 200, await state(sid))
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // 单块开关 / 内容编辑
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/block`,
    handler: async (req, res) => {
      if (String(req.method ?? '').toUpperCase() !== 'POST') {
        return sendJson(res, 405, { error: 'method not allowed' })
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const preset = typeof body.preset === 'string' ? body.preset : ''
        const block = typeof body.block === 'string' ? body.block : ''
        if (!preset || !block) return sendJson(res, 400, { error: 'preset/block required' })

        const raw = await loadPresetFile(preset)
        if (!raw) return sendJson(res, 404, { error: 'preset not found' })
        const known = parsePreset(raw).find((b) => b.id === block)
        if (!known) return sendJson(res, 404, { error: 'block not found' })

        const overrides = await readOverrides()
        const perPreset = { ...(overrides[preset] || {}) }
        const entry = { ...(perPreset[block] || {}) }

        if (typeof body.enabled === 'boolean') entry.enabled = body.enabled
        if (typeof body.content === 'string') {
          entry.content = body.content.slice(0, MAX_BLOCK_CHARS)
        }
        if (body.reset === true) {
          delete entry.content
          delete entry.enabled
        }
        if (Object.keys(entry).length === 0) delete perPreset[block]
        else perPreset[block] = entry

        overrides[preset] = perPreset
        await writeOverrides(overrides)
        await refresh(lastSid)
        return sendJson(res, 200, await state(lastSid))
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // 导入预设 JSON
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/import`,
    handler: async (req, res) => {
      if (String(req.method ?? '').toUpperCase() !== 'POST') {
        return sendJson(res, 405, { error: 'method not allowed' })
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const name = String(body.name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.json$/i, '').trim()
        if (!name) return sendJson(res, 400, { error: 'name required' })
        const content = body.content
        const parsed = typeof content === 'string' ? JSON.parse(content) : content
        if (!parsed || !Array.isArray(parsed.prompts)) {
          return sendJson(res, 400, { error: '不是 SillyTavern 预设（缺少 prompts 数组）' })
        }
        const p = await ensureDirs()
        await writeFile(join(p.presets, `${name}.json`), JSON.stringify(parsed, null, 2), 'utf8')
        await refresh(lastSid)
        return sendJson(res, 200, { ok: true, id: name, ...(await state(lastSid)) })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // 删除预设（连同它的块覆盖层）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/delete`,
    handler: async (req, res) => {
      if (String(req.method ?? '').toUpperCase() !== 'POST') {
        return sendJson(res, 405, { error: 'method not allowed' })
      }
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const id = String(body.id || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\.json$/i, '').trim()
        if (!id) return sendJson(res, 400, { error: 'id required' })
        const p = await ensureDirs()
        const file = join(p.presets, `${id}.json`)
        if (!existsSync(file)) return sendJson(res, 404, { error: 'preset not found' })
        await rm(file, { force: true })
        const overrides = await readOverrides()
        if (overrides[id]) {
          delete overrides[id]
          await writeOverrides(overrides)
        }
        // 删掉的预设如果正被某个会话用着，顺手清掉引用，免得留下悬空的 active
        const raw = migrated(await readConfigRaw())
        let touched = false
        if (raw.defaults.active === id) {
          raw.defaults.active = null
          touched = true
        }
        for (const [sid, patch] of Object.entries(raw.sessions)) {
          if (patch && patch.active === id) {
            raw.sessions[sid] = { ...patch, active: null }
            touched = true
          }
        }
        if (touched) {
          const p = await ensureDirs()
          await writeFile(p.config, JSON.stringify(raw, null, 2), 'utf8')
        }
        await refresh(lastSid)
        return sendJson(res, 200, { ok: true, ...(await state(lastSid)) })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // ── 角色卡 ────────────────────────────────────────────────────────────────
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/card`,
    handler: async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        const url = new URL(String(req.url || '/'), 'http://x')
        const wantId = url.searchParams.get('id')
        if (wantId) {
          const overrides = await readOverrides()
          const text = await cardTextOf(wantId, overrides)
          return sendJson(res, 200, { id: wantId, text })
        }
        const sid = sidFromReq(req);
        return sendJson(res, 200, { cards: await listCards(), activeCard: (await configFor(sid)).activeCard, sessionId: sid })
      }
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const action = String(body.action || '')

        if (action === 'import') {
          const bytes = Buffer.from(String(body.data || ''), 'base64')
          if (bytes.length === 0) return sendJson(res, 400, { error: 'empty file' })
          if (bytes.length > 20 * 1024 * 1024) return sendJson(res, 400, { error: 'file too large (>20MB)' })
          const card = parseCardFile(bytes)
          if (!card) return sendJson(res, 400, { error: '不是可识别的角色卡（支持 PNG 角色卡 / chara_card_v2 JSON）' })
          const base = String(body.name || card.name || 'card')
            .replace(/\.(png|json)$/i, '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .trim() || 'card'
          const ext = /\.json$/i.test(String(body.name || '')) ? 'json' : 'png'
          const p = await ensureDirs()
          await writeFile(join(p.cards, `${base}.${ext}`), bytes)
          const sid = sidFromReq(req, body)
          await patchSession(sid, { activeCard: base })
          await refresh(sid)
          return sendJson(res, 200, { ok: true, id: base, name: card.name, ...(await state(sid)) })
        }

        if (action === 'select') {
          const id = body.id === null ? null : String(body.id || '')
          const sid = sidFromReq(req, body)
          await patchSession(sid, { activeCard: id })
          await refresh(sid)
          return sendJson(res, 200, await state(sid))
        }

        if (action === 'text') {
          const id = String(body.id || '')
          if (!id) return sendJson(res, 400, { error: 'id required' })
          const overrides = await readOverrides()
          const key = `card:${id}`
          if (typeof body.text === 'string' && body.text.trim()) {
            overrides[key] = { text: body.text.slice(0, 40000) }
          } else {
            delete overrides[key]
          }
          await writeOverrides(overrides)
          await refresh(lastSid)
          return sendJson(res, 200, await state(lastSid))
        }

        if (action === 'delete') {
          const id = String(body.id || '')
          const p = await ensureDirs()
          const file = listCardFiles().find((n) => n.replace(/\.(png|json)$/i, '') === id)
          if (!file) return sendJson(res, 404, { error: 'card not found' })
          await rm(join(p.cards, file), { force: true })
          const overrides = await readOverrides()
          delete overrides[`card:${id}`]
          await writeOverrides(overrides)
          // 清掉所有指向这张卡的引用
          const raw = migrated(await readConfigRaw())
          let touched = false
          if (raw.defaults.activeCard === id) {
            raw.defaults.activeCard = null
            touched = true
          }
          for (const [sid, patch] of Object.entries(raw.sessions)) {
            if (patch && patch.activeCard === id) {
              raw.sessions[sid] = { ...patch, activeCard: null }
              touched = true
            }
          }
          if (touched) {
            const p2 = await ensureDirs()
            await writeFile(p2.config, JSON.stringify(raw, null, 2), 'utf8')
          }
          await refresh(lastSid)
          return sendJson(res, 200, { ok: true, ...(await state(lastSid)) })
        }

        return sendJson(res, 400, { error: `unknown action: ${action}` })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // 探针报上来一个 UUID，问宿主「这到底是不是会话 id」：是就返回标题，不是就 ok:false。
  // 这样前端请求里混着的消息 id / 资源 id 不会被误当成会话。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/checksid`,
    handler: async (req, res) => {
      let sid = ''
      try {
        sid = new URL(String(req.url || '/'), 'http://x').searchParams.get('sid') || ''
      } catch {
        sid = ''
      }
      if (!sid) return sendJson(res, 200, { ok: false })
      try {
        const s = ctx.get?.('sessions')?.get?.(sid)
        if (!s) return sendJson(res, 200, { ok: false })
        const snap = ctx.get?.('sessionTitle')?.get?.(s)
        return sendJson(res, 200, { ok: true, sid, title: snap && snap.title ? String(snap.title) : '' })
      } catch {
        return sendJson(res, 200, { ok: false })
      }
    },
  }))

  // 探针日志：面板把「认出来的会话 id + 来源 URL」报上来，用来验证探测是否生效
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/probe`,
    handler: async (req, res) => {
      if (String(req.method ?? 'GET').toUpperCase() !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const p = await ensureDirs()
        const line = JSON.stringify({ at: new Date().toISOString(), sid: body.sid ?? null, url: String(body.url || '').slice(0, 300), title: body.title ?? null })
        await appendFile(join(p.root, 'probe.log'), `${line}\n`, 'utf8')
        return sendJson(res, 200, { ok: true })
      } catch (error) {
        return sendJson(res, 200, { ok: false })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/preview`,
    handler: async (_req, res) => sendJson(res, 200, { chars: (cache.get(lastSid || '__default__') || '').length, text: cache.get(lastSid || '__default__') || '', sessionId: lastSid }),
  }))

  // 会话级人格：选、存、删（文件在 ~/.dsh/preset-bridge/personas/*.md）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/persona`,
    handler: async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        const sid = sidFromReq(req)
        const cfg = await configFor(sid)
        const doc = cfg.personaFile ? await readPersona(cfg.personaFile) : null
        return sendJson(res, 200, {
          personas: listPersonas(),
          active: cfg.personaFile || null,
          text: doc ? doc.text : '',
          dir: paths().personas,
        })
      }
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const action = String(body.action || '')
        const sid = sidFromReq(req, body)
        const p = await ensureDirs()

        if (action === 'select') {
          const id = body.id === null ? null : safePersonaId(body.id)
          await patchSession(sid, { personaFile: id || null })
          await refresh(sid)
          return sendJson(res, 200, await state(sid))
        }

        if (action === 'save') {
          const id = safePersonaId(body.id)
          if (!id) return sendJson(res, 400, { error: 'id required' })
          const text = String(body.text || '')
          await writeFile(join(p.personas, `${id}.md`), text.slice(0, 40000), 'utf8')
          if (body.select === true) await patchSession(sid, { personaFile: id })
          await refresh(sid)
          return sendJson(res, 200, { ok: true, ...(await state(sid)) })
        }

        if (action === 'delete') {
          const id = safePersonaId(body.id)
          if (!id) return sendJson(res, 400, { error: 'id required' })
          await rm(join(p.personas, `${id}.md`), { force: true })
          const raw = migrated(await readConfigRaw())
          let touched = false
          for (const [k, patch] of Object.entries(raw.sessions)) {
            if (patch && patch.personaFile === id) {
              raw.sessions[k] = { ...patch, personaFile: null }
              touched = true
            }
          }
          if (touched) {
            const p2 = await ensureDirs()
            await writeFile(p2.config, JSON.stringify(raw, null, 2), 'utf8')
          }
          await refresh(sid)
          return sendJson(res, 200, { ok: true, ...(await state(sid)) })
        }

        return sendJson(res, 400, { error: `unknown action: ${action}` })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // 基础角色：读取 / 保存 / 恢复默认
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/role`,
    handler: async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        const eff = await readRoleEffective()
        return sendJson(res, 200, {
          text: eff.text,
          custom: eff.custom,
          builtin: await readRoleBuiltin(),
        })
      }
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        const p = await ensureDirs()
        if (body.reset === true) {
          await rm(p.role, { force: true })
        } else if (typeof body.text === 'string') {
          const text = body.text.trim()
          if (!text) {
            await rm(p.role, { force: true })
          } else {
            await writeFile(p.role, body.text.slice(0, 20000), 'utf8')
          }
        }
        await refresh(lastSid)
        const eff = await readRoleEffective()
        return sendJson(res, 200, { ok: true, text: eff.text, custom: eff.custom, ...(await state(lastSid)) })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  disposers.push(disposeUi)
  disposers.push(disposeTap)

  ctx.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  })
}
