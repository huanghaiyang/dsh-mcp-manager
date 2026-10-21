# @local/dsh-mcp-manager

在 **设置 → MCP 管理器** 里查看当前注册的 MCP 服务器及其运行状态。只读观测，不写任何配置。

## 显示什么

每台 `@deepseek-ai/dsh-mcp-client` 条目一行卡片：

| 字段 | 来源 | 说明 |
|---|---|---|
| 服务器名 | 条目 `config.serverName` | 模型看到的工具命名空间（`mcp__<server>__*`） |
| 状态 | 多源合成 | 已连接 / 已加载·无工具 / 重连中 / 不可用 / 已停用 / 启动中 |
| 传输与地址 | 条目 config | `stdio` → `command + args`；`streamable-http` → `url` |
| 工具 | `ctx.tools.schemas()` | 该命名空间下当前**已注册**的工具数与清单 |
| 生命周期 | Loader `fiber.state` | pending / loading / active / failed / disposed / unloading |
| 加载错误 | `fiber._error` | 条目激活失败时的原因 |
| 最近事件 | `ctx.logger` 导出的 mcp-client 日志 | 连接失败、重试、放弃、重连成功 |
| 探测结果 | 点「测试连接」 | 一次 `resources/list` 往返 |

顶部是统计（服务器 / 已连接 / 异常 / 停用 / 工具合计），底部是最近的连接事件与宿主自检。

## 状态是怎么判定的

mcp-client 没有导出连接状态，所以状态由四层证据按优先级合成（见 `index.js` 的 `synthesizeStatus`）：

1. 条目 `disabled` → 已停用；条目 fiber `FAILED` → 不可用（附加载错误）。
2. **主动探测**（只有点按钮才跑）→ 连通 / 不通 / 超时。
3. **连接日志**最近一条 → `giving up after N consecutive failed reconnect attempts` 判不可用，
   `connection lost; reconnecting` / `connection failed; retrying` 判重连中。
4. 该服务器命名空间下有工具 → 已连接；否则看生命周期。

「已加载 · 无工具」是诚实的中间态：条目活着、没有报错、也没有注册到工具
（服务器本身没实现 tools，或工具清单已被清空）。要确定连接是否真的活着，点「测试连接」。

## 对外接口

宿主半边挂在已鉴权的 `/api` 通道上（浏览器靠同源 Cookie 通过连接层的信任围栏）：

- `GET /api/mcp-manager.state` — 一份完整快照。
- `POST /api/mcp-manager.probe` — body `{ "servers": ["name"] }`（省略 = 全部），先探测再返回快照。
- agent 工具 `mcp_manager_status`：参数 `{ probe?: boolean, server?: string }`，
  返回同一份快照的 JSON，并把可读摘要放在 `value.text` 里。
- 自检文件 `$DSH_HOME/mcp-manager.status.json`：宿主每次采集快照时（10s 节流）覆盖写入，
  内容与上面的 JSON 相同。插件**加载失败**时设置页根本没机会渲染，这个文件就是唯一现场；
  正常运行时它也能在浏览器之外独立核对“宿主到底看到了什么”。
- 快照里的 `client.composed` 说明浏览器半边有没有进页面模块图。**新装或更新后需要刷新一次页面**，
  已经打开的页面不会自动去拉新包的 `client.js`；这一行就是判断“是不是该刷新了”的依据。

包结构：`index.js` 是宿主实现，`client.js` 是浏览器实现，`cordis.patch.yml` 插入一行。

### ⚠ 行名必须是包名本身

`cordis.patch.yml` 里的 `name` 只能写 `@local/dsh-mcp-manager`，**不能写成
`@local/dsh-mcp-manager/host` 之类的子路径**。`dsh-client-modules` 用
`exactPackageSpecifier(行名)` 反查包清单来发现 `dsh.client`：

- 行名是包名 → 查到包 → 装配 `client.js` → 设置里出现「MCP 管理器」；
- 行名带子路径（例如 `pkg/host`，规范里是 3 段）→ `exactPackageSpecifier` 返回
  `undefined` → 找不到包 → **宿主半边照常工作，但浏览器半边永远不进装配表**，
  设置页里也就永远看不到入口（`mcp-manager.status.json` 里 `client.composed` 会是 `false`）。

代价是宿主代码改完必须重启 Host（Loader 的 ESM 模块缓存对同一说明符不会再求值）；
浏览器半边改完刷新页面即可。

### ⚠ client.js 必须整体包在 IIFE 里

客户端插件是**经典脚本**（不是 ESM），同一页面所有客户端插件共用一个全局词法作用域。
任一插件顶层的 `const`/`let`（`ROUTE`、`DICT`、`CSS`…）都会变成全局绑定，后加载的同名
声明直接 `SyntaxError: Identifier 'xxx' has already been declared`，把**那个插件**的整段
脚本打挂，浏览器里表现为：

```
plugins/?? loaded without registering "@local/dsh-dingtalk-notify" via __ModuleLoader__.load
```

所以 `client.js` 的全部顶层声明都收在 `(() => { … })()` 里，一个名字都不往外漏。
`tests/client-globals-isolation.mjs` 用 `node:vm` 复现这个多脚本环境，断言本插件无论与
钉钉插件谁先谁后都不报错、且不泄漏任何全局绑定。

（顺带：`@local/dsh-dingtalk-notify` 的 `client.js` 是手写的，它自己就泄漏 `ROUTE`/`DICT`/`CSS`，
所以任何另一个手写客户端插件只要用同名顶层变量，就会把它打挂。它不是本插件的依赖，
但值得一并 IIFE 包起来。）

## 验证

```bash
node tests/host-smoke.mjs              # 假 Context 真跑 apply()：状态合成/路由/工具/探测/自检文件
node tests/client-smoke.mjs            # 假 window/React/slots 真跑 client.js：装配 + 完整渲染
node tests/client-globals-isolation.mjs # vm 复现多插件共存：不撞名、不泄漏全局
node --check index.js && node --check client.js
```

`host-smoke` 会用 DSH 真实的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`
校验工具输出契约（`output.schema` 只接受受限子集，写 `type: 'json'` 会被拒）；
`client-smoke` 断言渲染结果里出现每台服务器的状态、端点、键名、探测细节与事件，
并且不会漏出 `[object Object]` / `undefined` / `NaN`。

## 仓库与敏感信息

仓库已 `git init`（分支 `main`），`core.hooksPath` 指向 `.githooks`：

```bash
node scripts/scan-secrets.mjs        # 全量扫描（跳过 node_modules/.git/dist；二进制与 >2MB 跳过）
npm run check:secrets                # 同上
git commit                           # 触发 .githooks/pre-commit，只扫暂存区，命中即拒绝提交
```

- 扫描器**不 spawn 任何子进程**（本沙箱下 Node 抓子进程管道会 EPERM）：文件清单由参数、
  `--from-file` 或自身 fs 遍历得到，git 只在外层钩子里用。
- 命中项只回显值的头 4 个字符，避免把密钥再抄进终端日志。
- 已知假值（测试夹具里的 `super-secret`、文档里的占位符）列在
  [scripts/scan-secrets.mjs](scripts/scan-secrets.mjs) 的 `FAKE_VALUES`，需要时往那里加。
- 忽略项见 [.gitignore](.gitignore)：`node_modules/`、`*.status.json`、`.env*`、密钥文件等。
  真实自检文件写在 `$DSH_HOME/mcp-manager.status.json`，本来就不在仓库里。
- 本插件自身**不采集任何凭据**：环境变量与请求头只出键名，密钥值连快照都不进（有测试断言）。

## 配置

本插件不声明 `Config`，`cordis.patch.yml` 里的两个键都可选：

```yaml
- id: mcp-manager
  config:
    logLimit: 240        # 保留多少条 mcp-client 连接日志
    probeTimeoutMs: 8000 # 「测试连接」单次往返超时
```

## 边界

- 工具数来自**全局**工具注册表。挂在某个 Agent 作用域里的 MCP 服务器没有 Loader 条目可枚举，
  会以「仅工具」条目（`source: tools`）额外列出：能看见工具，但看不到传输配置与重连策略。
- 自动刷新只读快照（默认 8s），**不会**自动探测，避免周期性打扰远端服务器。
- 探测走 `mcp-resources` 的 provider：未连接时它立刻抛 `server is disconnected`；
  已连接时才真正发一次 `resources/list`。服务器不支持 resources 时无法据此区分
  （会显示“已连通；服务器未实现 resources/list”这类协议错误）。
- 环境变量与请求头**只显示键名**，不显示值。
- `GET /api/mcp-manager.state` 的 `requestBody` 必须写 `buffered`（连接层契约只有
  `buffered`/`streaming`，写别的值会给 GET 挂上请求体并 400）。浏览器半边对旧宿主的
  400/404 有一条回退：改用 `POST .probe` 并声明一台不存在的服务器（“探测 0 台”），
  只取快照、不碰任何服务器；宿主重启后主路径生效，回退自然闲置。
