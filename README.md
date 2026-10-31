# dsh-preset-bridge

把 **SillyTavern 的预设 / 角色卡**接进 DeepSeek Harness 的**普通会话**，用一块浮动面板管理开关、选择、逐块编辑。

> **作者：DeepSeek V4.1（deepseek-flash）**
> 本插件由 AI 模型编写，不是人类手写代码。所有功能**只在一台 Windows 机器上、针对一个 DSH Desktop 实例测试过**，没有在其他系统版本、其他内核版本或其他人的环境里验证。请把它当作实验品使用，出问题优先看 [已知问题](#已知问题与血泪史)，别当成成熟软件。

---

## 它解决什么问题

SillyTavern 的预设是「一堆带开关的 prompt 块 + 一张顺序表」，本来要靠 ST 的前端 + 正则美化才能用。DSH 没有这套东西，所以：

- 你想要某套预设的文风 / 叙事规则，只能在 DSH 里手动一段段贴进 `AGENTS.md`；
- 你想按场景切换（写小说用一套、跑团用另一套），没有地方存；
- 你想临时关掉其中一块（比如字数限制），只能整段删。

这个插件把这三件事拆开：**预设按块存、按块开关、按块编辑，一个总开关整体启停。**

## 功能

### 预设

| 功能 | 说明 |
|---|---|
| 导入 | 读 SillyTavern 的 chat-completion 预设 JSON（`prompts` + `prompt_order`） |
| 逐块开关 | 每块一个勾选框，跟预设里的 `prompt_order` 默认值一致 |
| 逐块编辑 | 每块可改内容，改过的块名字后面带 `*` |
| 恢复默认 | 单块恢复，或整个预设删掉重导 |
| 删除 | 连覆盖层一起删，删了就没了 |
| 顺序 | 按 `prompt_order` 顺序拼接；多组时按 ST 规则选 `100001` → `100000` → 首个非空组 |

### 角色卡

| 功能 | 说明 |
|---|---|
| 格式 | PNG（读 `tEXt`/`iTXt` 里的 `chara` 块）+ `chara_card_v2`/`v3` 的 JSON |
| 使用 | 选中一张卡 → 卡面描述注入在最前面；不选卡则不注入 |
| 编辑 | 组装后的卡面文本可以直接改，「恢复默认」回到原始字段 |
| 删除 | 删文件 + 删覆盖层 |

### 我的设定

两层之一：**你是谁**。一个称呼 + 一段人设文本，注入在角色卡之后、预设块之前。

### 基础角色

没有角色卡时用的兜底身份声明（`default-role.md`）。默认内容是「你是一个大语言模型，不是某个角色」，用于避免模型顺着预设把自己演成人。**可编辑、可一键恢复默认。**

### 总开关

一个按钮关掉整套（预设 + 卡 + 人设 + 基础角色）。关闭时拼装函数直接返回空字符串，section 自动不注入。

可选联动：**打开总开关时自动停用 `dsh-fish-memory`，关闭时恢复**——只恢复「它自己关掉的那次」，你手动关的不动。

## 工作原理

### 注入

```js
ctx.systemPrompt.section({
  name: 'preset-bridge:scene',
  order: 35,
  interpolate: false,   // ← 关键
  text: () => cache.text,
})
```

`interpolate: false` 是必须的。DSH 默认对 section 文本做**严格 `{{变量}}` 插值**，遇到未注册变量直接抛错；ST 预设里全是 `{{user}}`、`{{char}}` 这类宏，不关掉会让**整轮对话失败**（这个 bug 真的发生过，见下文）。

### 拼装顺序

```
（分层优先级：用户当前的明确指令 > 我的设定 > 角色卡 > 预设各块；冲突时以前者为准。）
[## 场景预设：xxx（仅在启用时）]
### 角色设定（卡名 / 基础角色）
### 用户设定（称呼）
### 预设的各个块…
```

### 宏处理

| 宏 | 处理 |
|---|---|
| `{{user}}` | 替换成「我的设定」里的称呼 |
| `{{char}}` | 替换成「角色」 |
| `{{persona}}` | 替换成人设文本 |
| `{{lastMessage}}` | 删除 |
| 其他 `{{...}}` | 原样保留 |

纯宏块（内容去掉宏后什么都不剩）和纯占位块（`charDesc`、`scenario` 等 ST 内置字段）**整块丢弃**——DSH 没有角色卡字段，留着只是空壳。

### 界面

不走 DSH 的 client 模块系统（在测试机上加载失败），改用 `webServer.tapIndex` 往 `index.html` 注入一段独立脚本：

```
GET /preset-bridge/ui.js  →  浮动面板（原生 DOM，不依赖框架）
```

UI 文件按请求读取，**改完刷新页面就生效**，不用重启。

### 按会话独立

设置是**按对话各存一份**的，不是全局一刀切：

```
调用时：context.agent.session  →  会话 id（形如 session-<uuid>）
        configFor(会话 id)      →  这个会话的配置
写入时：只写这个会话的覆盖，不动别的会话，也不动默认模板
```

面板怎么知道"当前是哪个对话"（DSH 是 SPA，切会话不刷新页面）：

1. 旁观前端自己的请求（`fetch` / `XHR` / `WebSocket`），从请求体里找 `session-<uuid>`
2. 只认 `session-` 前缀——消息 id、资源 id 也是 UUID，但一律不碰
3. 换会话时面板自动收起，并恢复那个会话上次的开关状态

面板顶部有一条作用域栏，时刻显示面板绑在哪儿：

```
会话：…c2b7d0　·　只影响这个对话      ← 绑定成功
未能识别当前对话 · 设置会写入默认      ← 黄字警告：此刻是共享的（新会话默认模板）
```

**认不出当前对话时会明确报警，不会假装按会话、实际共享。**

### HTTP 路由

| 路由 | 作用 |
|---|---|
| `GET/POST /preset-bridge/state` | 读状态 / 开关与选项（都按 `?sid=` 或 `sessionId` 指定会话） |
| `POST /preset-bridge/block` | 单块开关 / 编辑 |
| `POST /preset-bridge/import` | 导入预设 |
| `POST /preset-bridge/delete` | 删除预设 |
| `GET/POST /preset-bridge/card` | 角色卡列表 / 导入 / 选择 / 编辑 / 删除 |
| `GET/POST /preset-bridge/role` | 基础角色读取 / 保存 / 恢复默认 |
| `GET /preset-bridge/checksid?sid=` | 校验某个 id 是不是真会话（顺带返回标题） |
| `POST /preset-bridge/probe` | 面板上报探测到的会话 id 与来源，写入 `probe.log` |
| `GET /preset-bridge/preview` | 当前实际会注入的全文 |
| `GET /preset-bridge/ui.js` | 面板脚本 |

### 数据位置

```
~/.dsh/preset-bridge/
  config.json        # { defaults: 默认模板, sessions: { 会话id: 覆盖 } }
  overrides.json     # 逐块开关与编辑、卡面编辑（原文件只读）
  presets/           # 导入的预设 JSON
  cards/             # 导入的角色卡
  default-role.md    # 你改过的基础角色（没有则用包内出厂版）
  probe.log          # 会话 id 探测日志（排查用，可随时删）
```

老版本的扁平 `config.json` 会自动迁移成 `{ defaults, sessions }`，不用手动改。

## 安装

```bash
dsh plugin --profile desktop add <本仓库绝对路径>
```

或者用插件管理器指向本地目录。**这是 `link:` 安装**——profile 里是指向你源码目录的 junction，所以**别删源码目录**，删了插件就失效。

重启 DSH 后生效（宿主侧代码是启动时加载的）。

## 卸载

```bash
dsh plugin --profile desktop remove @local/preset-bridge
```

数据目录保留，重新装回来设置还在。

## 与 SillyTavern 的差异

**做不到的**：

- 世界书（lorebook）
- 正则美化 / 标签渲染（`<game>`、`<options>` 这些会原样显示）
- assistant 预填（`[Understood]` 这类会被丢弃）
- 采样参数接管（temperature、top_k 等仍由 DSH 的模型配置决定）
- 角色卡的 `first_mes` 自动开场

**行为差异**：

- ST 的 `{{// 注释 }}` 不会被特殊处理（**如果你看到注释混进正文，是预设里那一块被打开了，去关掉它**）
- 预设里的「用户设定」占位块依赖 ST 的 persona 字段，在 DSH 里没有对应物，会被丢弃

## 已知问题与血泪史

**1. `interpolate` 没关 → 整轮对话失败**

第一版注册 section 时没写 `interpolate: false`。启用的瞬间，`{{user}}` 触发严格插值 → 抛错 → 那之后的每一轮对话都失败。修法就一行。

**2. 全局 MutationObserver → 页面启动卡死**

为了把正文里的 `\uXXXX` 自动解码成汉字，加过一个 `observe(document.documentElement, {subtree:true, characterData:true})` 并**在回调里改写文本节点**。结果是自我触发的循环 + React 渲染风暴，主线程被吃满，renderer 120 秒内没能上报 boot health，DSH 判定启动失败。

现在的处理：**解码默认关闭**，且不再有全局 observer，只剩一次性解码。想用的话手动开：

```js
localStorage.setItem('pb-decode', '1')   // 然后刷新
```

并且接受它可能让页面变卡。

**教训**：注入页面 + 全局 DOM 监听是能拖垮整个 UI 的写法。要监听就限域、去重、避开渲染帧。

**3. 宿主代码改动必须重启**

`index.js` 改完，DSH 不会热重载，只有 `ui.js` 是按请求读的。所以「改了没反应」先看改的是哪个文件。

**4. 会话 id 猜错了两次**

要做「按会话独立」，第一步是让页面里的脚本知道当前是哪个会话。踩了两个坑：

| 尝试 | 结果 |
|---|---|
| 从请求 URL 里找 UUID | ❌ DSH 前端走 `api/<服务>/<方法>` 的 RPC，参数在请求体 |
| 从请求体里找 UUID，见到就认 | ❌ 找到的常是消息 id / 资源 id，绑到了假会话 |
| 只认 `session-<uuid>` 形状 | ✅ 真会话 id 带这个前缀，其它 UUID 一律不碰 |

中间还有个更隐蔽的：宿主侧读会话要用 `ctx.get('sessions')`（可选获取），写成 `ctx.sessions` 在没声明 `inject` 时是 `undefined`，校验函数永远返回失败。

**教训**：不确定的东西不要"先按看起来对的规则绑上"，要**先报警**。现在的实现认不出来就黄字提醒，至少不会一边说按会话、一边全局共享。

## 许可

MIT。自用为主，没有做跨版本兼容保证。
