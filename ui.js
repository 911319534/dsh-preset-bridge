/* preset-bridge UI（注入式，不依赖 client 模块系统） */
(function () {
  if (window.__presetBridgeMounted) return
  window.__presetBridgeMounted = true

  var API = '/preset-bridge'
  var state = null
  var open = false
  var view = 'list'
  var editing = null

  // ── 当前会话探测 ──────────────────────────────────────────────────────────
  // 面板是页面级的，切换会话时页面不刷新。这里不监听 DOM（上次全文档
  // MutationObserver 把渲染器拖死过），而是旁观前端自己的请求，从 URL 里
  // 认出会话 id（UUID）。拿到后：面板状态按会话存，切会话就自动收起。
  var sessionHint = null
  var sessionTitleHint = ''
  var openBySession = {}
  // DSH 的会话 id 是 session- 开头；只认这个形状，别的 UUID（消息/资源）一律不碰
  var SID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

  var reqLog = []
  var rejectedIds = {}
  var checkingId = null

  /** 采纳一个会话 id：记下旧会话的面板状态，切到新的，收起面板 */
  function adoptSession(id, title) {
    if (!id || id === sessionHint) return
    if (sessionHint) openBySession[sessionHint] = open
    sessionHint = id
    sessionTitleHint = title || ''
    open = openBySession[id] === true ? true : false
    state = null
    view = 'list'
    editing = null
    render()
    refresh()
  }

  /** 认到 session- 开头的 id 就采纳；标题去问宿主，拿不到也不影响绑定 */
  function considerSession(id) {
    if (!id || id === sessionHint) return
    adoptSession(id, '')
    var rawFetch = window.__pbOrigFetch || window.fetch
    try {
      rawFetch.call(window, API + '/checksid?sid=' + encodeURIComponent(id), { headers: { accept: 'application/json' } })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d && d.ok && d.title && id === sessionHint) {
            sessionTitleHint = String(d.title)
            render()
          }
        })
        .catch(function () { /* 标题拿不到就算了 */ })
    } catch (e) { /* ignore */ }
  }

  function noteSessionId(url) {
    try {
      var urlStr = String(url || '')
      var m = SID_RE.exec(urlStr)
      if (m) considerSession(m[0].toLowerCase())
    } catch (e) { /* ignore */ }
  }

  /** 看请求体 / WebSocket 消息：DSH 的 RPC 参数都在这里 */
  function noteBody(text, source) {
    try {
      if (!text || text.length > 20000) return
      var method = ''
      var keys = ''
      if (text.charAt(0) === '{') {
        try {
          var obj = JSON.parse(text)
          keys = Object.keys(obj).slice(0, 10).join(',')
          if (typeof obj.method === 'string') method = obj.method.slice(0, 40)
        } catch (e) { keys = '' }
      }
      var m = SID_RE.exec(text)
      reqLog.push({ s: source, k: method || keys, u: m ? m[0].slice(0, 12) : '' })
      if (reqLog.length > 30) reqLog.shift()
      if (m) considerSession(m[0].toLowerCase())
    } catch (e) { /* ignore */ }
  }

  function installSessionProbe() {
    try {
      var origFetch = window.fetch
      if (typeof origFetch === 'function' && !window.__pbFetchPatched) {
        window.__pbFetchPatched = true
        window.__pbOrigFetch = origFetch
        window.fetch = function (input, init) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url) || ''
            var body = init && typeof init.body === 'string' ? init.body : null
            noteSessionId(u)
            if (body) noteBody(body, u)
          } catch (e) { /* ignore */ }
          return origFetch.apply(this, arguments)
        }
      }
      var XO = XMLHttpRequest.prototype.open
      if (typeof XO === 'function' && !window.__pbXhrPatched) {
        window.__pbXhrPatched = true
        XMLHttpRequest.prototype.open = function (method, url) {
          try { noteSessionId(url) } catch (e) { /* ignore */ }
          return XO.apply(this, arguments)
        }
        var XS = XMLHttpRequest.prototype.send
        XMLHttpRequest.prototype.send = function (data) {
          try {
            if (typeof data === 'string') noteBody(data, 'xhr')
          } catch (e) { /* ignore */ }
          return XS.apply(this, arguments)
        }
      }
      // WebSocket：很多前端把 RPC 走 ws，会话 id 在消息体里。
      // 只包 prototype 的 send/addEventListener，不替换构造函数（换构造容易影响前端判断）。
      var WS = window.WebSocket
      if (typeof WS === 'function' && WS.prototype && !window.__pbWsPatched) {
        window.__pbWsPatched = true
        try {
          var sendP = WS.prototype.send
          WS.prototype.send = function (data) {
            try { if (typeof data === 'string') noteBody(data, 'ws-out') } catch (e) { /* ignore */ }
            return sendP.call(this, data)
          }
          var addP = WS.prototype.addEventListener
          WS.prototype.addEventListener = function (type, fn, opts) {
            if (type === 'message' && typeof fn === 'function') {
              var wrapped = function (ev) {
                try { if (ev && typeof ev.data === 'string') noteBody(ev.data, 'ws-in') } catch (e) { /* ignore */ }
                return fn.call(this, ev)
              }
              return addP.call(this, type, wrapped, opts)
            }
            return addP.call(this, type, fn, opts)
          }
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  // ── 显示层解码：把正文里的 \uXXXX 还原成汉字（只改显示，不改模型行为）──
  // 默认关闭：全局扫描/改写文本会把主线程拖死，且与开屏类插件抢 DOM。
  // 需要时手动在控制台设 localStorage.setItem('pb-decode','1') 再刷新。
  var decodeOn = localStorage.getItem('pb-decode') === '1'
  var decoding = false
  function decodeText(s) {
    return String(s).replace(/\\u([0-9a-fA-F]{4})/g, function (all, hex) {
      try { return String.fromCharCode(parseInt(hex, 16)) } catch (e) { return all }
    })
  }
  function decodeWalk(node) {
    if (!node) return
    if (node.nodeType === 3) {
      var p = node.parentNode
      if (p && /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA)$/.test(p.nodeName)) return
      if (node.nodeValue && node.nodeValue.indexOf('\\u') !== -1) {
        node.nodeValue = decodeText(node.nodeValue)
      }
      return
    }
    if (node.nodeType !== 1) return
    for (var i = 0; i < node.childNodes.length; i++) decodeWalk(node.childNodes[i])
  }
  // 去掉全文档 MutationObserver：页面每次渲染都会触发它，遍历+改写文本节点
  // 会持续占用主线程，导致 Renderer 无法上报 boot health，启动直接卡死。
  try {
    if (decodeOn) setTimeout(function () { decodeWalk(document.body) }, 800)
  } catch (e) { /* ignore */ }

  var draft = ''
  var error = ''
  var pendingDelete = null
  var meName = '用户'
  var mePersona = ''
  var cardText = ''
  var cardEditId = null
  var roleText = ''
  var roleCustom = false
  var personaList = []
  var personaText = ''
  var personaId = null
  var panelScroll = 0

  var css = [
    '#pb-fab{position:fixed;right:18px;bottom:104px;z-index:2147483000;display:flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:15px;',
    'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));background:var(--dsw-alias-bg-overlay,#1b1f24);color:var(--dsw-alias-label-secondary,#ccc);',
    'font:12px/1 -apple-system,"Segoe UI",sans-serif;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.28);opacity:.92}',
    '#pb-fab.on{border-color:var(--dsw-alias-brand-primary,#4a9eff);color:var(--dsw-alias-brand-primary,#4a9eff)}',
    '#pb-fab:hover{opacity:1}',
    '#pb-panel{position:fixed;right:18px;bottom:142px;z-index:2147483001;width:420px;max-height:66vh;display:flex;flex-direction:column;',
    'border:1px solid var(--pb-border,rgba(255,255,255,.14));border-radius:12px;background:var(--pb-bg,#171b21);',
    'color:var(--dsw-alias-label-primary,#eee);font:12px/1.5 -apple-system,"Segoe UI",sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.55);overflow:hidden}',
    '#pb-panel .pb-scope{padding:5px 12px;font-size:11px;color:var(--dsw-alias-label-secondary,#aaa);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.15))}',
    '#pb-panel .pb-scope.warn{color:#e0b062}',
    '#pb-panel .pb-diag{font-size:10px;opacity:.75;margin-top:3px;line-height:1.5;word-break:break-all}',
    '#pb-fab.unattached{color:#e0b062}',
    '#pb-panel .pb-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}',
    '#pb-panel .pb-body{padding:8px;overflow:auto}',
    '#pb-panel .pb-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25))}',
    '.pb-row{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer}',
    '.pb-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16))}',
    '.pb-row.active{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.22))}',
    '.pb-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pb-meta{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;white-space:nowrap}',
    '.pb-btn{padding:3px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));background:transparent;color:inherit;font-size:12px;cursor:pointer}',
    '.pb-btn.primary{border-color:var(--dsw-alias-brand-primary,#4a9eff);color:var(--dsw-alias-brand-primary,#4a9eff)}',
    '.pb-ta{width:100%;box-sizing:border-box;min-height:200px;padding:8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));',
    'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:inherit;font:12px/1.55 inherit;resize:vertical}',
    '.pb-err{color:#ff7a7a;padding:4px 8px}',
    '.pb-status{padding:6px 8px;margin-bottom:6px;border-radius:6px;background:rgba(255,255,255,.07);',
    'color:var(--dsw-alias-label-secondary,#ccc);font-size:11px;line-height:1.7;word-break:break-all}',
    '.pb-in{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;border:1px solid var(--pb-border,rgba(255,255,255,.14));',
    'background:rgba(255,255,255,.06);color:inherit;font:12px/1.4 inherit}',
    '.pb-sep{padding:8px 6px 2px;color:var(--dsw-alias-label-tertiary,#999);font-size:11px}',
  ].join('')

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        if (k === 'style') node.setAttribute('style', attrs[k])
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), attrs[k])
        else if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k])
      }
    }
    ;(children || []).forEach(function (c) {
      if (c === null || c === undefined) return
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return node
  }

  function request(path, init) {
    // 每个请求都带上探测到的会话 id，宿主据此读写「这个会话」的配置
    var sep = path.indexOf('?') === -1 ? '?' : '&'
    var url = API + path + (sessionHint ? sep + 'sid=' + encodeURIComponent(sessionHint) : '')
    var opts = Object.assign({
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    }, init || {})
    if (opts.body && sessionHint) {
      try {
        var parsed = JSON.parse(opts.body)
        if (parsed && typeof parsed === 'object' && !parsed.sessionId) {
          parsed.sessionId = sessionHint
          opts.body = JSON.stringify(parsed)
        }
      } catch (e) { /* 原样发 */ }
    }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
        return data
      })
    })
  }

  function refresh() {
    return request('/state').then(function (s) {
      state = s
      error = ''
      render()
    }).catch(function (e) {
      error = String(e.message || e)
      render()
    })
  }

  function currentPreset() {
    if (!state || !state.active) return null
    return (state.presets || []).filter(function (p) { return p.id === state.active })[0] || null
  }

  function applyPatch(patch) {
    request('/state', { method: 'POST', body: JSON.stringify(patch) }).then(function (s) {
      state = s; error = ''; render()
    }).catch(function (e) { error = String(e.message || e); render() })
  }

  function patchBlock(blockId, body) {
    body.preset = state.active
    body.block = blockId
    request('/block', { method: 'POST', body: JSON.stringify(body) }).then(function (s) {
      state = s; error = ''; render()
    }).catch(function (e) { error = String(e.message || e); render() })
  }

  var root = null

  function loadCardText(id) {
    if (!id) { cardText = ''; cardEditId = null; render(); return }
    cardEditId = id
    request('/card?id=' + encodeURIComponent(id)).then(function (r) {
      cardText = r.text || ''
      render()
    }).catch(function (e) { error = String(e.message || e); render() })
  }

  function loadPersonas() {
    request('/persona').then(function (r) {
      personaList = (r && r.personas) || []
      personaId = (r && r.active) || null
      personaText = (r && r.text) || ''
      error = ''
      render()
    }).catch(function (e) { error = String(e.message || e); render() })
  }

  function pickPersona(id) {
    request('/persona', { method: 'POST', body: JSON.stringify({ action: 'select', id: id }) })
      .then(function (s) { state = s; error = ''; loadPersonas() })
      .catch(function (e) { error = String(e.message || e); render() })
  }

  function loadRole() {
    request('/role').then(function (r) {
      roleText = r.text || ''
      roleCustom = !!r.custom
      render()
    }).catch(function (e) { error = String(e.message || e); render() })
  }

  function ensureRoot() {
    if (root && document.body.contains(root)) return root
    root = el('div', { id: 'pb-root' })
    root.appendChild(el('style', null, [css]))
    document.body.appendChild(root)
    return root
  }

  // 启动就装探针，然后拉一次状态
  installSessionProbe()
  setTimeout(function () { refresh() }, 0)

  function render() {
    var host = ensureRoot()
    var fab = document.getElementById('pb-fab')
    var panel = document.getElementById('pb-panel')
    if (!fab) {
      fab = el('button', { id: 'pb-fab', type: 'button', onclick: function () { open = !open; view = 'list'; render() } })
      host.appendChild(fab)
    }
    var preset = currentPreset()
    var on = state && state.enabled && preset
    // 胶囊上也标出作用域，收起面板时也看得出绑的是哪个对话
    var scopeTag = sessionHint ? String(sessionHint).slice(-4) : '共享'
    fab.textContent = on ? ('酒馆 · ' + preset.id + ' · ' + scopeTag) : ('酒馆 · 关 · ' + scopeTag)
    fab.className = (on ? 'on' : '') + (sessionHint ? '' : ' unattached')
    fab.title = sessionHint
      ? ('这个面板只影响当前对话（' + ((state && state.sessionTitle) || sessionHint.slice(0, 8)) + '）')
      : '没能识别当前对话，设置会写到默认（所有对话共享）'

    if (!open) {
      if (panel) panel.remove()
      return
    }
    if (panel) panel.remove()

    var enabledNow = !!(state && state.enabled)
    var head = el('div', { class: 'pb-head' }, [
      el('strong', null, [
        view === 'edit' ? '编辑块'
          : view === 'me' ? '我的设定'
            : view === 'card' ? '角色卡'
              : view === 'base' ? '基础角色'
                : view === 'persona' ? '人格 · .md'
                  : '场景预设',
      ]),
      el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        view !== 'list'
          ? el('button', { class: 'pb-btn', onclick: function () { view = 'list'; render() } }, ['← 返回'])
          : el('button', {
              class: 'pb-btn' + (enabledNow ? ' primary' : ''),
              style: 'min-width:84px;font-weight:600',
              title: enabledNow ? '一键关掉整套酒馆系统（预设/卡/人设全部停止注入）' : '一键开启整套酒馆系统',
              onclick: function () { applyPatch({ enabled: !enabledNow }) },
            }, [enabledNow ? '● 整套开启' : '○ 整套关闭']),
        el('button', {
          class: 'pb-btn', title: '从磁盘重新读取',
          onclick: function () { refresh() },
        }, ['↻']),
        el('button', {
          class: 'pb-btn', title: '角色卡（AI 扮演谁）',
          onclick: function () {
            view = 'card'
            render()
            loadCardText(state && state.activeCard)
          },
        }, ['卡']),
        el('button', {
          class: 'pb-btn' + (decodeOn ? ' primary' : ''),
          title: decodeOn ? '已开启：正文里的 \\uXXXX 自动解码成汉字（只改显示）' : '已关闭：原样显示转义内容',
          onclick: function () {
            decodeOn = !decodeOn
            try { localStorage.setItem('pb-decode', decodeOn ? '1' : '0') } catch (e) { /* ignore */ }
            if (decodeOn) decodeWalk(document.body)
            render()
          },
        }, ['解']),
        el('button', {
          class: 'pb-btn', title: '我的设定（用户名 · 人设）',
          onclick: function () {
            meName = (state && state.userName) || '用户'
            mePersona = (state && state.userPersona) || ''
            view = 'me'
            render()
          },
        }, ['我']),
        el('button', { class: 'pb-btn', onclick: function () { open = false; render() } }, ['×']),
      ]),
    ])

    var body = el('div', { class: 'pb-body' })
    // 重绘会丢滚动位置（点一个块就跳回顶部），这里记住再还原
    body.addEventListener('scroll', function () { panelScroll = body.scrollTop })
    if (error) body.appendChild(el('div', { class: 'pb-err' }, [error]))

    if (view === 'persona') {
      var pl = personaList || []
      body.appendChild(el('div', { class: 'pb-status' }, [
        personaId ? ('● 本会话人格：' + personaId) : '○ 本会话未选人格（只注入预设 / 卡）',
      ]))
      body.appendChild(el('div', {
        class: 'pb-row' + (personaId ? '' : ' active'),
        onclick: function () { pickPersona(null) },
      }, [
        el('span', { class: 'pb-name' }, ['（不使用人格）']),
        el('span', { class: 'pb-meta' }, ['—']),
      ]))
      pl.forEach(function (p) {
        var active = p.id === personaId
        var row = el('div', {
          class: 'pb-row' + (active ? ' active' : ''),
          title: '点一下选给本会话',
          onclick: function () { pickPersona(p.id) },
        }, [
          el('span', { class: 'pb-name', style: active ? 'font-weight:700' : '' }, [(active ? '● ' : '') + p.id]),
          el('span', { class: 'pb-meta' }, [p.chars + ' 字']),
        ])
        var del = el('button', { class: 'pb-btn', style: 'padding:1px 7px', title: '删除这个人格文件' }, ['✕'])
        del.addEventListener('click', function (ev) {
          ev.stopPropagation()
          request('/persona', { method: 'POST', body: JSON.stringify({ action: 'delete', id: p.id }) })
            .then(function (s) { state = s; error = ''; loadPersonas() })
            .catch(function (e) { error = String(e.message || e); render() })
        })
        row.appendChild(del)
        body.appendChild(row)
      })

      var nameIn = el('input', { class: 'pb-in', placeholder: '人格文件名（不含 .md）' })
      nameIn.value = personaId || ''
      var pta = el('textarea', { class: 'pb-ta', style: 'min-height:200px' })
      pta.value = personaText
      pta.addEventListener('input', function () { personaText = pta.value })

      body.appendChild(el('div', { class: 'pb-sep' }, ['人格正文（像 AGENT.md 那样写：我是谁、怎么说话、边界）']))
      body.appendChild(pta)
      body.appendChild(el('div', { class: 'pb-foot' }, [
        nameIn,
        el('button', {
          class: 'pb-btn primary',
          onclick: function () {
            var id = String(nameIn.value || personaId || '').trim()
            if (!id) { error = '先填个文件名'; render(); return }
            request('/persona', { method: 'POST', body: JSON.stringify({ action: 'save', id: id, text: personaText, select: true }) })
              .then(function (s) { state = s; personaId = id; error = ''; loadPersonas() })
              .catch(function (e) { error = String(e.message || e); render() })
          },
        }, ['保存并选用']),
      ]))
    } else if (view === 'base') {
      body.appendChild(el('div', { class: 'pb-sep' }, [
        '基础角色（无卡且有预设时生效）' + (roleCustom ? ' · 已自定义' : ' · 出厂默认'),
      ]))
      var rta = el('textarea', { class: 'pb-ta', style: 'min-height:260px' })
      rta.value = roleText
      rta.addEventListener('input', function () { roleText = rta.value })
      body.appendChild(rta)
      body.appendChild(el('div', { class: 'pb-foot' }, [
        el('button', {
          class: 'pb-btn',
          title: '删除自定义版本，回到包内出厂默认',
          onclick: function () {
            request('/role', { method: 'POST', body: JSON.stringify({ reset: true }) })
              .then(function (r) { roleText = r.text; roleCustom = false; error = ''; render() })
              .catch(function (e) { error = String(e.message || e); render() })
          },
        }, ['恢复默认']),
        el('span', { class: 'pb-meta' }, [roleText.length + ' 字']),
        el('button', {
          class: 'pb-btn primary',
          onclick: function () {
            request('/role', { method: 'POST', body: JSON.stringify({ text: roleText }) })
              .then(function (r) { roleText = r.text; roleCustom = r.custom; error = ''; render() })
              .catch(function (e) { error = String(e.message || e); render() })
          },
        }, ['保存']),
      ]))
    } else if (view === 'card') {
      var cards = (state && state.cards) || []
      var activeCardId = (state && state.activeCard) || ''
      body.appendChild(el('div', { class: 'pb-status' }, [
        activeCardId ? ('● 正在使用：' + activeCardId) : '○ 未使用角色卡 → 使用内置「基础角色」',
      ]))
      body.appendChild(el('div', {
        class: 'pb-row' + (activeCardId ? '' : ' active'),
        onclick: function () {
          request('/card', { method: 'POST', body: JSON.stringify({ action: 'select', id: null }) })
            .then(function (s) { state = s; error = ''; cardText = ''; cardEditId = null; render() })
            .catch(function (e) { error = String(e.message || e); render() })
        },
      }, [
        el('span', { class: 'pb-name' }, ['（不使用任何卡）']),
        el('span', { class: 'pb-meta' }, ['—']),
      ]))
      if (cards.length === 0) {
        body.appendChild(el('div', { class: 'pb-sep' }, ['还没有角色卡。点下面「导入卡」选一张 PNG 或 JSON。']))
      }
      cards.forEach(function (c) {
        var isActive = c.id === activeCardId
        var row = el('div', {
          class: 'pb-row' + (isActive ? ' active' : ''),
          title: c.error ? '解析失败' : (c.name + ' · ' + c.chars + ' 字'),
          onclick: function () {
            request('/card', { method: 'POST', body: JSON.stringify({ action: 'select', id: c.id }) })
              .then(function (s) { state = s; error = ''; loadCardText(c.id) })
              .catch(function (e) { error = String(e.message || e); render() })
          },
        }, [
          el('span', { class: 'pb-name', style: isActive ? 'font-weight:700' : '' },
            [(isActive ? '● ' : '') + (c.name || c.id) + (c.edited ? ' *' : '')]),
          el('span', { class: 'pb-meta' }, [c.error ? '!' : (isActive ? '使用中' : (c.chars + ' 字'))]),
        ])
        var del = el('button', { class: 'pb-btn', style: 'padding:1px 7px', title: '删除这张卡' }, ['✕'])
        del.addEventListener('click', function (ev) {
          ev.stopPropagation()
          request('/card', { method: 'POST', body: JSON.stringify({ action: 'delete', id: c.id }) })
            .then(function (s) { state = s; error = ''; cardText = ''; cardEditId = null; render() })
            .catch(function (e) { error = String(e.message || e); render() })
        })
        row.appendChild(del)
        body.appendChild(row)
      })

      // 导入
      var fileInput = el('input', { type: 'file', accept: '.png,.json,image/png,application/json', style: 'display:none' })
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0]
        fileInput.value = ''
        if (!f) return
        var reader = new FileReader()
        reader.onload = function () {
          var dataUrl = String(reader.result || '')
          var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
          request('/card', { method: 'POST', body: JSON.stringify({ action: 'import', name: f.name, data: b64 }) })
            .then(function (s) { state = s; error = ''; loadCardText(s.activeCard) })
            .catch(function (e) { error = String(e.message || e); render() })
        }
        reader.readAsDataURL(f)
      })

      if (state && state.activeCard) {
        body.appendChild(el('div', { class: 'pb-sep' }, ['卡面文本（可改，改完点保存）']))
        var cta = el('textarea', { class: 'pb-ta', style: 'min-height:220px' })
        cta.value = cardText
        cta.addEventListener('input', function () { cardText = cta.value })
        body.appendChild(cta)
        body.appendChild(el('div', { class: 'pb-foot' }, [
          el('button', {
            class: 'pb-btn',
            onclick: function () {
              request('/card', { method: 'POST', body: JSON.stringify({ action: 'text', id: state.activeCard, text: '' }) })
                .then(function (s) { state = s; error = ''; loadCardText(state.activeCard) })
                .catch(function (e) { error = String(e.message || e); render() })
            },
          }, ['恢复默认']),
          el('span', { class: 'pb-meta' }, [cardText.length + ' 字']),
          el('button', {
            class: 'pb-btn primary',
            onclick: function () {
              request('/card', { method: 'POST', body: JSON.stringify({ action: 'text', id: state.activeCard, text: cardText }) })
                .then(function (s) { state = s; error = ''; render() })
                .catch(function (e) { error = String(e.message || e); render() })
            },
          }, ['保存']),
        ]))
      }

      body.appendChild(el('div', {
        class: 'pb-row',
        title: '没有角色卡时注入的身份声明（可编辑）',
        onclick: function () { view = 'base'; render(); loadRole() },
      }, [
        el('span', { class: 'pb-name' }, ['（基础角色 · 无卡时生效）']),
        el('span', { class: 'pb-meta' }, [roleCustom ? '已改' : '默认']),
      ]))

      body.appendChild(el('div', {
        class: 'pb-row',
        title: '会话级人格 .md（对应 AGENT.md 那一层，按会话各选一份）',
        onclick: function () { view = 'persona'; render(); loadPersonas() },
      }, [
        el('span', { class: 'pb-name' }, ['（人格 · .md，按会话）']),
        el('span', { class: 'pb-meta' }, [(state && state.personaFile) ? state.personaFile : '未选']),
      ]))

      body.appendChild(el('div', { class: 'pb-foot' }, [
        el('button', { class: 'pb-btn', onclick: function () { fileInput.click() } }, ['导入卡']),
        fileInput,
        el('span', { class: 'pb-meta' }, [cards.length + ' 张']),
      ]))
    } else if (view === 'me') {
      var nameInput = el('input', { type: 'text', class: 'pb-in', placeholder: '称呼（{{user}} 会替换成它）' })
      nameInput.value = meName
      nameInput.addEventListener('input', function () { meName = nameInput.value })

      var personaTa = el('textarea', { class: 'pb-ta', style: 'min-height:240px' })
      personaTa.value = mePersona
      personaTa.addEventListener('input', function () { mePersona = personaTa.value })

      body.appendChild(el('div', { class: 'pb-sep' }, ['称呼（会替换预设里的 {{user}}）']))
      body.appendChild(nameInput)
      body.appendChild(el('div', { class: 'pb-sep' }, ['我的人设（注入在预设块之前，支持 {{char}}）']))
      body.appendChild(personaTa)
      body.appendChild(el('div', { class: 'pb-foot' }, [
        el('span', { class: 'pb-meta' }, [mePersona.length + ' 字']),
        el('button', {
          class: 'pb-btn primary',
          onclick: function () {
            applyPatch({ userName: meName, userPersona: mePersona })
            view = 'list'
          },
        }, ['保存']),
      ]))
    } else if (view === 'edit' && editing) {
      var ta = el('textarea', { class: 'pb-ta' })
      ta.value = draft
      ta.addEventListener('input', function () { draft = ta.value })
      body.appendChild(el('div', { class: 'pb-sep' }, ['名称：' + editing.name + '　角色：' + editing.role]))
      body.appendChild(ta)
      body.appendChild(el('div', { class: 'pb-foot' }, [
        el('button', { class: 'pb-btn', onclick: function () { patchBlock(editing.id, { reset: true }); view = 'list' } }, ['恢复默认']),
        el('span', { class: 'pb-meta' }, [draft.length + ' 字']),
        el('button', { class: 'pb-btn primary', onclick: function () { patchBlock(editing.id, { content: draft }); view = 'list' } }, ['保存']),
      ]))
    } else if (state) {
      var list = state.presets || []
      // 一行状态：不看别的也知道现在到底注入了什么
      var st = state || {}
      var cardName = st.activeCard
        ? st.activeCard
        : (st.useDefaultRole === false ? '无' : '基础角色（内置）')
      var hasPersona = !!(st.userPersona && st.userPersona.trim())
      var scopeLabel = st.sessionId
        ? ('本会话 · ' + String(st.sessionId).slice(-6))
        : '默认（还没有会话）'
      body.appendChild(el('div', {
        class: 'pb-status',
        title: '设置按会话各自保存；「鱼的记忆」本身也是按会话开关的，这里不再联动',
      }, [
        (st.enabled ? '● ' : '○ ') + (st.enabled ? '整套开启' : '整套关闭'),
        '　' + scopeLabel,
        '　预设：' + (st.active || '无') + (st.active ? '' : '（不注入）'),
        '　卡：' + cardName,
        '　人设：' + (hasPersona ? st.userName : '无'),
        '　' + (st.chars || 0) + ' 字',
      ]))

      body.appendChild(el('div', {
        class: 'pb-row' + (state.active === null ? ' active' : ''),
        onclick: function () { applyPatch({ active: null }) },
      }, [el('span', { class: 'pb-name' }, ['（不使用预设）']), el('span', { class: 'pb-meta' }, ['—'])]))

      list.forEach(function (p) {
        var row = el('div', {
          class: 'pb-row' + (p.id === state.active ? ' active' : ''),
          onclick: function () { if (!p.error) applyPatch({ active: p.id, enabled: true }) },
          title: p.error ? '解析失败' : (p.enabledBlocks + ' / ' + p.blocks.length + ' 块启用'),
        }, [
          el('span', { class: 'pb-name' }, [p.id]),
          el('span', { class: 'pb-meta' }, [p.error ? '!' : (p.enabledBlocks + '/' + p.blocks.length)]),
        ])
        var del = el('button', {
          class: 'pb-btn',
          style: 'padding:1px 7px;color:' + (pendingDelete === p.id ? '#ff7a7a' : ''),
          title: pendingDelete === p.id ? '再点一次确认删除' : '删除这个预设',
        }, [pendingDelete === p.id ? '确认?' : '✕'])
        del.addEventListener('click', function (ev) {
          ev.stopPropagation()
          if (pendingDelete !== p.id) {
            pendingDelete = p.id
            render()
            setTimeout(function () {
              if (pendingDelete === p.id) { pendingDelete = null; render() }
            }, 4000)
            return
          }
          pendingDelete = null
          request('/delete', { method: 'POST', body: JSON.stringify({ id: p.id }) })
            .then(function (s) { state = s; error = ''; render() })
            .catch(function (e) { error = String(e.message || e); render() })
        })
        row.appendChild(del)
        body.appendChild(row)
      })

      if (list.length === 0) {
        body.appendChild(el('div', { class: 'pb-sep' }, ['把预设 JSON 放到 ' + (state.dir || '~/.dsh/preset-bridge/presets')]))
      }

      if (preset) {
        body.appendChild(el('div', { class: 'pb-sep' }, ['「' + preset.id + '」的块（' + preset.blocks.length + '）']))
        preset.blocks.forEach(function (b) {
          var cb = el('input', { type: 'checkbox' })
          cb.checked = !!b.enabled
          cb.disabled = !!b.placeholder
          cb.addEventListener('change', function () { patchBlock(b.id, { enabled: cb.checked }) })
          var row = el('div', { class: 'pb-row' }, [
            cb,
            el('span', { class: 'pb-name', style: b.placeholder ? 'opacity:.45' : '' }, [b.name + (b.edited ? ' *' : '')]),
            el('span', { class: 'pb-meta' }, [b.placeholder ? '占位' : String(b.chars)]),
          ])
          if (!b.placeholder) {
            row.appendChild(el('button', {
              class: 'pb-btn', style: 'padding:1px 6px',
              onclick: function (ev) {
                ev.stopPropagation()
                editing = b
                draft = typeof b.content === 'string' ? b.content : ''
                view = 'edit'
                render()
              },
            }, ['✎']))
          }
          body.appendChild(row)
        })
      }
    }

    var foot = el('div', { class: 'pb-foot' }, [
      (function () {
        var input = el('input', { type: 'file', accept: '.json', style: 'display:none' })
        input.addEventListener('change', function () {
          var f = input.files && input.files[0]
          input.value = ''
          if (!f) return
          f.text().then(function (text) {
            return request('/import', { method: 'POST', body: JSON.stringify({ name: f.name.replace(/\.json$/i, ''), content: text }) })
          }).then(function (s) { state = s; error = ''; render() })
            .catch(function (e) { error = String(e.message || e); render() })
        })
        setTimeout(function () { if (!document.body.contains(input)) body.appendChild(input) }, 0)
        var btn = el('button', { class: 'pb-btn', onclick: function () { input.click() } }, ['导入预设'])
        var wrap = el('span', null, [btn, input])
        return wrap
      })(),
      el('span', { class: 'pb-meta' }, [on ? (preset.chars + ' 字') : '未启用']),
    ])

    var scopeBar = el('div', { class: 'pb-scope' + (sessionHint ? '' : ' warn') }, [
      sessionHint
        ? ('会话：' + (sessionTitleHint || (state && state.sessionTitle) || ('…' + String(sessionHint).slice(-6))) + '　·　只影响这个对话')
        : '未能识别当前对话 · 设置会写入默认（所有对话共享）',
    ])
    if (!sessionHint) {
      var seen = reqLog.slice(-6).map(function (r) {
        return r.s + (r.k ? '[' + r.k + ']' : '') + (r.u ? ' ' + r.u : '')
      }).join(' · ')
      scopeBar.appendChild(el('div', { class: 'pb-diag' }, [
        seen ? ('探针看到：' + seen) : '探针还没抓到任何请求（发一条消息或切个会话试试）',
      ]))
    }
    panel = el('div', { id: 'pb-panel' }, [head, scopeBar, body, foot])
    host.appendChild(panel)
    if (panelScroll > 0) body.scrollTop = panelScroll
  }

  function boot() {
    if (!document.body) return setTimeout(boot, 300)
    refresh()
    setInterval(function () { if (!state) refresh() }, 4000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
