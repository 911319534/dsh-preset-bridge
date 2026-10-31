/**
 * 角色卡解析：SillyTavern 的两种常见载体
 *   - PNG：tEXt / iTXt 块里的 `chara`（base64 后的 JSON）
 *   - JSON：chara_card_v2 / v3（{spec, spec_version, data:{...}}）或裸 data
 * 不依赖任何第三方库。
 */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 从 PNG 里抠出 tEXt/iTXt 的 chara 文本。 */
export function readPngChara(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  let offset = 8
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) break
    const data = buf.subarray(dataStart, dataEnd)
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul)
        if (keyword === 'chara' || keyword === 'ccv3') {
          return { keyword, text: data.toString('utf8', nul + 1) }
        }
      }
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0)
      if (nul > 0) {
        const keyword = data.toString('latin1', 0, nul)
        if (keyword === 'chara' || keyword === 'ccv3') {
          // keyword\0 compFlag compMethod langTag\0 transKeyword\0 text
          let p = nul + 1
          const compFlag = data[p]
          p += 2
          const langEnd = data.indexOf(0, p)
          p = langEnd + 1
          const transEnd = data.indexOf(0, p)
          p = transEnd + 1
          const raw = data.subarray(p)
          if (compFlag === 0) return { keyword, text: raw.toString('utf8') }
          // 压缩过的 iTXt 极少见，跳过（返回 null 交给 JSON 兜底）
          return null
        }
      }
    }
    offset = dataEnd + 4 // 跳过 CRC
  }
  return null
}

/** base64 → JSON（ST 存的是 base64 后的 JSON 文本）。 */
export function decodeCharaText(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) } catch { return null }
  }
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

/** 统一成 v2/v3 的 data 结构。 */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw
  const name = String(data.name || raw.name || '').trim()
  if (!name) return null
  const str = (v) => (typeof v === 'string' ? v : '')
  return {
    name,
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    firstMes: str(data.first_mes),
    mesExample: str(data.mes_example),
    systemPrompt: str(data.system_prompt),
    postHistory: str(data.post_history_instructions),
    creatorNotes: str(data.creator_notes),
    alternateGreetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.filter((x) => typeof x === 'string' && x.trim())
      : [],
    tags: Array.isArray(data.tags) ? data.tags.filter((x) => typeof x === 'string') : [],
  }
}

/** 组装成注入用的文本（每个字段一个小标题；空的跳过）。 */
export function renderCard(card) {
  if (!card) return ''
  const parts = [`### 角色设定（${card.name}）`]
  if (card.description.trim()) parts.push('', '【角色描述】', card.description.trim())
  if (card.personality.trim()) parts.push('', '【性格】', card.personality.trim())
  if (card.scenario.trim()) parts.push('', '【场景】', card.scenario.trim())
  if (card.systemPrompt.trim()) parts.push('', '【角色专属系统提示】', card.systemPrompt.trim())
  if (card.mesExample.trim()) parts.push('', '【对话示例】', card.mesExample.trim())
  if (card.postHistory.trim()) parts.push('', '【post-history 指令】', card.postHistory.trim())
  return parts.join('\n').trim()
}

/** 从文件字节解析：先认 PNG，再退回 JSON 文本。 */
export function parseCardFile(buf) {
  const chara = readPngChara(buf)
  if (chara) {
    const card = normalizeCard(decodeCharaText(chara.text))
    if (card) return card
  }
  try {
    const text = buf.toString('utf8')
    const card = normalizeCard(JSON.parse(text))
    if (card) return card
  } catch {
    // 不是 JSON
  }
  return null
}
