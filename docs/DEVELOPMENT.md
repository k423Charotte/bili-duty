# 开发文档

面向要改这个插件、或写同类 DSH 插件的人。**所有"坑"都是实测踩出来的**，不是推测。

---

## 一、架构：三层，各管各的

```
┌─ 调度层（本插件的 Host 半，lib/index.js）────────────────────────┐
│ 定时器 ctx.interval（60 秒一跳）→ 到点判定 → agent.followup()      │
│ 把「一轮值班任务」投进你指定的那个会话                            │
├─ 通道层（lib/bili-api.js + lib/bili-login.js）──────────────────┤
│ 用插件自持的凭证走 B 站官方 Web 接口：                            │
│   搜索 / 视频详情 / 字幕原文 / 评论 / 发评论                      │
│ 凭证来自 lib/bili-login.js 的扫码登录，只落本机                   │
├─ 判断层（**被唤醒的那个会话里的 AI**）──────────────────────────┤
│ 读字幕与评论 → 按判据筛选 → 写「为什么值得」→ 写日报              │
│ 插件不参与这一步，也不调 ctx.llm.stream()                        │
└─ 记录层（lib/index.js）─────────────────────────────────────────┘
  runs.md（执行记录）/ seen.md（判重表）/ out/（日报）
```

**为什么把判断留在会话里**：判断质量取决于上下文（使用者的人设、他的项目、他关心什么）。
在插件里再造一个"分身 AI"，等于把最有价值的部分降级成一个没有上下文的摘要器。

---

## 二、目录结构

```
.
├── package.json          # bundle manifest（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      # 把插件行 insert 进内核（只有这一段，不碰 profile）
├── icon.svg              # 插件卡片图标（顶层 icon 字段引用）
├── locale/{en,zh}.json   # 显示元数据（meta.title / meta.description）
├── lib/
│   ├── index.js          # Host：工具注册、定时器、路由、runs/seen 读写
│   ├── client.js         # Client：设置页（slot 注册 + 随组件渲染的样式）
│   ├── bili-api.js       # 数据面：搜索/详情/字幕/评论/发评论
│   ├── bili-login.js     # 扫码登录、凭证、带重试的 fetch
│   ├── qr.js             # 自实现的 QR 编码器（零依赖）
│   └── qr-tables.js      # QR 常量表（脚本生成，勿手改）
├── prompts/duty.md       # 投递给被唤醒会话的「判断准则」全文
└── tools/                # 测试与运维脚本
```

---

## 三、实测踩过的坑（**每一条都值得记住**）

### 1. `timer` 不 inject 就是硬错

`ctx.interval` / `ctx.timeout` 由 `timer` 服务提供。不写 `export const inject = ['timer', ...]`
会在激活时直接抛 `cannot get property "timer" without inject`。

### 2. 路由的 disposer 必须交给 `ctx.effect`

`webServer.register()` 返回 disposer；丢掉它，插件禁用/重载后再启用会被拒：
`webserver: duplicate exact route`。

### 3. ⛔ 客户端 `inject` 里**不能写模块内置对象**

`styles` / `React` / `host` / `console` 是 client factory 的**形参**，不是 Cordis 服务。
把 `'styles'` 写进客户端 `inject`，插件会**永久 pending**（等一个永不存在的服务），
而待激活的 entry 会把 **web boot 卡死** —— 使用者看到的是「应用无法启动」。
客户端 `inject` 只留真实服务（本插件是 `['slots']`）。

### 4. `ctx.styles` 并不存在

Host 侧有 `ctx.styles` 的错觉很常见。客户端组件要用样式，写成随组件渲染的 `<style>` 元素
（卸载时 React 自动移除），不要去找 `ctx.styles.insert()`。

### 5. 冷启动竞态：`apply` 可能早于 `webServer` 就绪

`ctx.get('webServer')` 在冷启动时可能返回 `undefined` → 路由一条都没注册（**热重载时服务早就绪，开发中完全看不出来**）。
正确写法：先试一次，拿不到就 `ctx.inject(['webServer'], cb)` 等服务就绪。本插件的 `whenWebServer()` 就是这个模式。

### 6. `apply` 抛错会带走整个启动流程

Host 插件的 `apply` 抛错 = entry `failed`。所以：外层必须捕获后**绝不重新抛出**，只记录 + 静默降级。
同理，**任何定时器回调**里的异常都没有调用方接住，必须自我兜底。

### 7. Node 的 `fetch` 优先 IPv6，在 Electron 宿主里会变成一句光秃秃的 `fetch failed`

`api.bilibili.com` 有 AAAA 记录。系统 node 有时能侥幸回退 IPv4，所以**命令行里测是通的、放进宿主就挂**。
修法：`dns.setDefaultResultOrder('ipv4first')`。
⚠️ 但**别写在 import 顶层**（那是进程级全局副作用，会改变整个宿主与其它插件的 fetch 行为）—— 本插件改成了首次发请求时才设置。

### 8. 命令行探测插件自己的路由会 401 —— 那不是 bug

插件路由有来源校验，宿主还有一层认证栅栏。设置页同源带认证所以正常；
从命令行/本机脚本打过去拿不到任何东西。**要探测插件状态就读文件**（`apply-probe.json` / `runs.md`）。

### 9. ⭐⭐ 注入消息必须走官方 `createUserMessage`（**本项目最贵的一条**）

给 `agent.followup()` 传**裸对象**（只有 `content` + `source`）时，DSH 会把这条消息原样存进
**接收它的那个会话**，而它**缺 `role` 字段**。此后该会话的**每一次**模型请求都被网关拒绝：

```
Failed to deserialize the JSON body into the target type:
messages[120]: missing field 'role'
```

**症状极具误导性**：插件侧一切正常（投递返回成功、`runs.md` 记 `ok`），
坏掉的是**接收方的会话** —— 它从此说不了话，且症状看起来像"模型服务故障"。

修法：`agent.followup(createUserMessage({ content, source }))`（`@deepseek-ai/dsh-llm`），
它会补齐 `role: 'user'` 与 `id`。**这类消息一旦写进会话存储就是 append-only，只能靠外科手术修。**

⚠️ 但**别用顶层静态 import**。宿主版本一变、或这个导出没了，静态 import 失败会让**整个插件模块**加载不了 ——
而它只影响「唤醒」与「延迟复核」两处。本插件改成**动态 import + 等价兜底**：

```js
let createUserMessage = (input) => ({ ...input, role: 'user', id: randomUUID() })  // 先兜底
void import('@deepseek-ai/dsh-llm').then((mod) => {                                 // 异步升级
  if (typeof mod?.createUserMessage === 'function') createUserMessage = mod.createUserMessage
})
```

实际用的是哪一路，会记进 `<DSH_HOME>/bili-duty/apply-probe.json` 的 `createUserMessage` 字段
（`official` 或 `fallback(...)`）—— 排障时一眼可见，不用猜。

### 10. `source.kind` 不能是 `"plugin"`

DSH session format v4 明确拒绝：`value["kind"] === "plugin"` 直接抛
`format v4 message requires a producer-owned source kind`，而且它**只吃 `kind` 一个字段**。
官方 `dsh-schedule` 的写法是 `source: { kind: "schedule" }` —— 用自己的名字（本插件用 `bili-duty`）。

### 11. mock 必须复制真实约束，不能只记录调用

上面的第 9、10 条都曾经**测试全绿**却线上必挂 —— 因为 mock 对 `followup` 照单全收。
离线测试里要**照抄宿主的校验规则**，并加断言"已发出的每条消息都必须过校验"。

### 12. 工具返回值里的**孤立代理项**会让宿主拒绝整个包

字幕文本可能含孤立代理项（lone surrogate），宿主会以 `value is not lossless JSON` 拒绝**整包**返回。
出口统一做 well-formed 兜底（`String.prototype.toWellFormed()` 或等价实现）。

### 13. B 站的 AI 字幕轨**不保证属于这个视频**

实测：两条视频的 `ai-zh` 返回的是**别人视频**的内容，同一条轨两次请求还能返回不同内容。
所以：选轨优先**人工中文轨**（`zh-Hans`），并且**采信前必须核对主题**，
对不上就弃用该轨、在报告里标明「字幕轨与主题不符」。拿错字幕当判据，比没有字幕更危险。

### 14. 「按最新排序」的搜索容易被风控（412）

同一时刻「综合 / 最多播放」通常正常。**不要硬重试**：退到其它排序，或用浏览器打开搜索页读候选。

### 15. 评论排序只有「热门」时，复核等于做不了

热门排序只回前 20 条，**低赞评论根本进不去** —— 刚发的评论查不到，于是既判不了成功也判不了失败。
所以 `bili_duty_comments` 必须支持 `order: "time"`（按时间）。

---

## 四、发评论的三道护栏（**代码强制**，不是提示词）

因为这是"使用者本人的账号在说话"，红线写在代码里，不靠模型自觉：

| 拒绝码 | 触发条件 |
| --- | --- |
| `AUTO_COMMENT_OFF` | 设置页「自动评论」是关着的 |
| `NO_AT` | 没有 @ 对象（设置页 `comment_at` 为空，本次也没传 `at`） |
| `BUDGET_ZERO` / `BUDGET_USED` | 每轮条数封顶（默认 1 条；额度持久化，重启不清零） |
| `SEEN_UNREADABLE` | 判重表读不出来（铁律：不许当成"没记录过"） |
| `ALREADY_COMMENTED` | 同一视频已经评过 |

被拒时**也会写一行执行记录**（失败不静默），且**不会发出任何网络请求**。
另外：发送**歧义失败**（超时/无响应）按「已评论（待确认）」记入判重表 —— 宁可不发，也不重复打扰真人账号。

---

## 五、测试

三套都是**离线**的：不连 DSH、不碰真实数据目录（`mkdtempSync` + 改写 `DSH_HOME`）、不发真实请求（mock fetch）。

```bash
npm test              # Host 半
npm run test:client   # Client 半（把 client.js 真求值、组件真渲染一遍）
npm run test:qr       # QR 编码器与参照实现逐格比对
```

- Client 半单独测的理由：客户端模块**任何一次 throw 都会被宿主当成致命错误**，用户看到的是「应用无法启动」——
  而这类错误不重启看不出来，重启一次又要打断使用者。
- `@deepseek-ai/dsh-llm` 这类裸导入由**宿主**解析，离线测试跑不动 → 用 `tools/dsh-llm-stub-hooks.mjs`
  （`module.register` 加载器钩子）把它指到等价 stub，同时保留"消息必须带 `role`"的断言。

---

## 六、发布（npm）

生态惯例（可对照 npm 上的 `dsh-bili-scroll`、`dshmarket`）：

```jsonc
{
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", ...],
  "publishConfig": { "registry": "https://registry.npmjs.org/" },  // 用了镜像源时不加这条会发布失败
  "files": ["lib", "prompts", "locale", "icon.svg", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE"],
  "peerDependencies": { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-llm": "*" },
  "peerDependenciesMeta": { "@deepseek-ai/dsh-llm": { "optional": true } }
}
```

- `private: true` 会**直接阻止** `npm publish`（本地开发用的 manifest 常带它，发布前务必去掉）。
- `@deepseek-ai/*` 由**宿主**提供，所以放 `peerDependencies`（宽范围）+ `optional`，而不是 `dependencies`。
- GitHub 仓库加 topic `dsh-plugin`，生态的插件检索就是按它找的。
- 发布前跑一次 `npm pack --dry-run`，**逐项核对清单**里没有隐私内容（凭证、本机路径、备份、会话记录）。

---

## 七、与 `dsh-bili-scroll` 的路线差异

| | dsh-bili-scroll | 本插件 |
| --- | --- | --- |
| 唤醒 | 另起 `dsh --profile headless` 子进程（其 README 自述桌面端会卡） | `agent.followup()` 注入**你正在用的那个会话** |
| 依赖 | Python 3.10+ / uv / 两个 venv（84 MB ～ 1 GB） | 零依赖（纯 Node） |
| 数据通道 | 内置 Python MCP（`bilibili-api-python`） | 插件内直连官方 Web 接口 |
| 判断体 | 另起进程里的"分身" | 带完整上下文的原会话 |

两者可以共存，但**同一时间只建议一边开自动评论**（否则可能重复评论同一视频）。
