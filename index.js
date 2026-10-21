/**
 * MCP 管理器 · 宿主半边。
 *
 * 只做“观测”，不改任何配置：
 * 1. 从 Loader 条目里列出所有 `@deepseek-ai/dsh-mcp-client` 行（= 已注册的 MCP 服务器）；
 * 2. 把 Loader 条目状态、工具注册表里的 `mcp__<server>__*` 工具、以及 mcp-client 自己打的
 *    连接日志合成一份“运行状态”；
 * 3. 在 `/api/mcp-manager.state` 与 `/api/mcp-manager.probe` 上给设置页提供数据；
 * 4. 注册一个 agent 工具 `mcp_manager_status`，让模型也能查询同一份快照；
 * 5. 把同一份快照写进 `$DSH_HOME/mcp-manager.status.json`，作为浏览器之外的现场。
 *
 * 设计取舍：mcp-client 没有导出连接状态，所以状态由三层证据合成 ——
 * 被动证据（条目状态 / 工具清单 / 连接日志）+ 主动探测（resources/list 往返）。
 * 主动探测只在用户点“测试连接”时执行，不参与自动刷新，避免打扰服务器。
 *
 * ⚠ 硬性约束：`cordis.patch.yml` 里的行名**必须是包名本身**
 * （`@local/dsh-mcp-manager`，不能写成 `@local/dsh-mcp-manager/host` 之类的子路径）。
 * `dsh-client-modules` 用 `exactPackageSpecifier(行名)` 反查包清单，子路径会解析失败，
 * 结果就是宿主半边正常、但浏览器半边永远不被装配 —— 设置页里也就永远看不到入口。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

/** 稳定插件名。 */
export const name = 'mcp-manager'

/**
 * 全部依赖都是可选的：缺少某个服务时降级为“缺少该证据”，而不是让插件加载失败。
 * 依次使用 loader / tools / mcpResources / connection / logger。
 */
export const inject = []

/** 本插件自己的客户端包名：用来判断浏览器半边有没有进装配表。 */
const CLIENT_MODULE_ID = '@local/dsh-mcp-manager'

/** 每个 MCP 服务器在 Loader 里的包名。 */
const MCP_PLUGIN_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** 设置页使用的同源路由前缀。 */
const ROUTE = '/api/mcp-manager'
const STATE_ROUTE = `${ROUTE}.state`
const PROBE_ROUTE = `${ROUTE}.probe`

/** mcp-client 日志行：`mcp-client(<server>): ...`。 */
const LOG_LINE = /^mcp-client\(([A-Za-z0-9_-]{1,32})\):\s*([\s\S]*)$/

/** serverName 的合法形状（与 mcp-client 的 Config 校验一致）。 */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** 日志与探测的“新鲜期”：超出就不再压过工具清单这类持续证据。 */
const LOG_FRESH_MS = 10 * 60 * 1000
const PROBE_FRESH_MS = 5 * 60 * 1000

/** Cordis FiberState 的取值顺序（const enum，运行时没有导出）。 */
const FIBER_STATE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading']

/** mcp-client 的 reconnect 默认值，仅在条目未显式配置时用于展示。 */
const RECONNECT_DEFAULTS = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30000,
  maxAttempts: 10,
})

const DEFAULT_LOG_LIMIT = 240
const DEFAULT_PROBE_TIMEOUT_MS = 8000
const LOG_TEXT_LIMIT = 400
const PUBLIC_LOG_ROWS = 40
const NOTES_LIMIT = 20

/* ------------------------------------------------------------------ 小工具 */

/** 读属性，出错一律返回兜底值。 */
function safe(read, fallback) {
  try {
    const value = read()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** 从注入作用域里取服务（`scope.x` 与 `scope.get('x')` 两种形状都兼容）。 */
function serviceOf(scope, key) {
  return safe(() => scope?.[key], undefined) ?? safe(() => scope?.get?.(key), undefined)
}

/** 把任意异常压成一行可读文本。 */
function messageOf(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  const message = safe(() => error.message, '')
  if (typeof message === 'string' && message !== '') return message
  const code = safe(() => error.code, '')
  if (typeof code === 'string' && code !== '') return code
  return safe(() => String(error), '未知错误')
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** 只保留键名，绝不把密钥值送进浏览器。 */
function keysOf(record) {
  return isPlainObject(record) ? Object.keys(record).sort() : []
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/* ------------------------------------------------------------- 运行时状态 */

/**
 * 建立一次插件运行期状态。
 * @param {object} config 条目里的原始 config（本插件不声明 Config，按缺省值归一化）。
 */
function createRuntime(config) {
  const raw = isPlainObject(config) ? config : {}
  return {
    appliedAt: Date.now(),
    settings: {
      logLimit: positiveInteger(raw.logLimit, DEFAULT_LOG_LIMIT),
      probeTimeoutMs: positiveInteger(raw.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
    },
    /** 最近的 mcp-client 日志，最新在最前。 */
    log: [],
    /** serverName → { at, status, detail }，只有主动探测会写。 */
    probe: new Map(),
    notes: [],
    routes: [],
    services: {},
    mcpResources: undefined,
    clientModules: undefined,
    lastStatusWrite: 0,
    statusFile: join(homedir(), '.dsh', 'mcp-manager.status.json'),
  }
}

/** 记录一条诊断（最多 NOTES_LIMIT 条、连续重复去重），用于设置页底部自检。 */
function note(runtime, text) {
  const line = clip(text, 300)
  if (runtime.notes[runtime.notes.length - 1] === line) return
  runtime.notes.push(line)
  if (runtime.notes.length > NOTES_LIMIT) runtime.notes.splice(0, runtime.notes.length - NOTES_LIMIT)
}

/** 记录一条 mcp-client 日志并裁剪环形缓冲。 */
function pushLog(runtime, row) {
  runtime.log.unshift(row)
  if (runtime.log.length > runtime.settings.logLimit) runtime.log.length = runtime.settings.logLimit
}

/* ------------------------------------------------------------------ 快照 */

/**
 * 取一个条目**实际生效**的配置。
 *
 * `entry.options.config` 是 YAML 原文，`!!js` 表达式在里面还是未求值的节点；
 * `entry.fiber.config` 才是求值并被插件 Config 补齐默认值之后的那份。
 * 展示必须用后者，前者只作为条目还没激活时的兜底。
 */
function pickConfig(entry) {
  const applied = safe(() => entry?.fiber?.config, undefined)
  if (isPlainObject(applied)) return applied
  const raw = safe(() => entry?.options?.config, undefined)
  return isPlainObject(raw) ? raw : {}
}

/** 把配置值渲染成可读文本；未求值的表达式节点显示成 `…`，不输出 [object Object]。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined || value === null) return ''
  return '…'
}

/**
 * 列出 Loader 里所有 mcp-client 条目。
 * @returns {{ entry: object, config: object, serverName: string }[]}
 */
function listMcpEntries(ctx, runtime) {
  const loader = serviceOf(ctx, 'loader')
  if (loader === undefined || typeof loader.entries !== 'function') {
    // 不记 note：启动早期的服务就绪顺序会造成噪声，页脚的 `services` 已经给出实时答案。
    return []
  }
  const rows = []
  try {
    for (const entry of loader.entries()) {
      try {
        const entryName = safe(() => entry?.options?.name, '')
        if (entryName !== MCP_PLUGIN_PACKAGE) continue
        const settings = pickConfig(entry)
        const declared = textOf(safe(() => settings.serverName, ''))
        const serverName = SERVER_NAME.test(declared) ? declared : String(safe(() => entry.id, 'unknown'))
        rows.push({ entry, config: settings, serverName })
      } catch (error) {
        // 单条坏掉不影响其余条目：这是观测工具，宁可少一行也不要整页空白。
        note(runtime, `读取一个 MCP 条目失败：${messageOf(error)}`)
      }
    }
  } catch (error) {
    note(runtime, `枚举 Loader 条目中断：${messageOf(error)}`)
  }
  return rows
}

/** 当前注册表里所有工具名（全局作用域）。 */
function listToolNames(ctx, runtime) {
  const tools = serviceOf(ctx, 'tools')
  if (tools === undefined || typeof tools.schemas !== 'function') {
    // 同上：缺服务时保持安静，由页脚 `services` 暴露。
    return []
  }
  try {
    const schemas = tools.schemas()
    if (!Array.isArray(schemas)) return []
    return schemas.map((schema) => safe(() => schema?.name, '')).filter((entry) => typeof entry === 'string' && entry !== '')
  } catch (error) {
    note(runtime, `读取工具清单失败：${messageOf(error)}`)
    return []
  }
}

/** 工具名 → `<server>`（`mcp__<server>__<tool>` 的 server 段）。 */
function serverOfToolName(toolName, knownServers) {
  for (const serverName of knownServers) {
    if (toolName.startsWith(`mcp__${serverName}__`)) return serverName
  }
  const match = /^mcp__([A-Za-z0-9_-]{1,32})__/.exec(toolName)
  return match === null ? undefined : match[1]
}

/** 条目的 Cordis 生命周期状态。 */
function entryState(entry) {
  const state = safe(() => entry?.fiber?.state, undefined)
  if (typeof state !== 'number') return 'unknown'
  return FIBER_STATE[state] ?? 'unknown'
}

/** 条目加载失败时的原因（Cordis 把内部错误放在 fiber._error 上）。 */
function entryError(entry) {
  const error = safe(() => entry?.fiber?._error, undefined)
  return error === undefined ? undefined : clip(messageOf(error), 600)
}

/** 把一条 mcp-client 日志翻译成“一次状态变化”，供状态合成使用。 */
function logSignal(row) {
  if (!isPlainObject(row)) return undefined
  const text = String(row.text ?? '')
  // 「重连预算用尽」和「无法确认上一代传输已关闭所以停止重连」都是终态：工具多半已被移除。
  if (row.level === 'error' && /giving up after \d+ consecutive failed reconnect attempts|could not confirm transport closure|reconnect stopped/iu.test(text)) {
    return 'gave-up'
  }
  if (row.level === 'error' && /connection lost and reconnect is disabled|connection failed and reconnect is disabled/iu.test(text)) {
    return 'disabled-reconnect'
  }
  if (row.level === 'warn' && /connection lost; reconnecting|connection failed; retrying/iu.test(text)) {
    return 'retrying'
  }
  if (row.level === 'warn' && /connection attempt failed/iu.test(text)) return 'attempt-failed'
  if (row.level === 'info' && /reconnected and re-synced tools/iu.test(text)) return 'recovered'
  return undefined
}

/**
 * 合成一台服务器的运行状态。
 *
 * 证据强度从高到低：条目未启用/加载失败 > 5 分钟内的主动探测 > 10 分钟内的连接日志
 * > 已注册的工具 > 生命周期。日志压过工具数的原因是：断线期间 mcp-client 会保留
 * 上一代工具，此时工具存在并不代表连接还活着。
 * @returns {string} connected | connected-no-tools | retrying | failed | disabled | loading | unknown
 */
function synthesizeStatus({ disabled, state, error, toolCount, signal, probe, logAt }) {
  if (disabled) return 'disabled'
  if (state === 'failed') return 'failed'
  if (isPlainObject(probe) && typeof probe.at === 'number' && Date.now() - probe.at <= PROBE_FRESH_MS) {
    return probe.status === 'connected' ? 'connected' : 'failed'
  }
  const freshSignal = typeof logAt === 'number' && Date.now() - logAt <= LOG_FRESH_MS ? signal : undefined
  if (freshSignal === 'gave-up' || freshSignal === 'disabled-reconnect') return 'failed'
  if (freshSignal === 'retrying' || freshSignal === 'attempt-failed') return 'retrying'
  if (freshSignal === 'recovered') return 'connected'
  if (toolCount > 0) return 'connected'
  if (state === 'loading' || state === 'pending') return 'loading'
  if (state === 'active' && error === undefined) return 'connected-no-tools'
  return 'unknown'
}

/** 一台服务器对外的稳定结构。 */
function describeServer(runtime, { entry, config, serverName }, toolNames) {
  const disabled = safe(() => entry.disabled, false) === true
  const state = entryState(entry)
  const error = entryError(entry)
  const prefix = `mcp__${serverName}__`
  const mine = toolNames.filter((toolName) => toolName.startsWith(prefix)).map((toolName) => toolName.slice(prefix.length)).sort()
  const transport = config.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
  const reconnect = isPlainObject(config.reconnect) ? config.reconnect : {}
  const lastLog = runtime.log.find((row) => row.server === serverName)
  const probe = runtime.probe.get(serverName)
  const signal = lastLog === undefined ? undefined : logSignal(lastLog)
  const running = synthesizeStatus({
    disabled,
    state,
    error,
    toolCount: mine.length,
    signal,
    probe,
    logAt: lastLog?.at,
  })

  const endpoint = transport === 'streamable-http'
    ? clip(textOf(config.url), 400)
    : clip([textOf(config.command), ...(Array.isArray(config.args) ? config.args.map((part) => textOf(part)) : [])].filter((part) => part !== '').join(' '), 400)

  return {
    serverName,
    entryId: String(safe(() => entry.id, '')),
    source: 'loader',
    disabled,
    state,
    error: error ?? null,
    transport,
    endpoint,
    cwd: transport === 'stdio' ? textOf(config.cwd) : '',
    envKeys: transport === 'stdio' ? keysOf(config.env) : [],
    headerKeys: transport === 'streamable-http' ? keysOf(config.headers) : [],
    toolCallTimeoutMs: positiveInteger(config.toolCallTimeoutMs, 60000),
    failOnStartupError: config.failOnStartupError === true,
    maxInstructionBytes: positiveInteger(config.maxInstructionBytes, 32768),
    reconnect: {
      enabled: typeof reconnect.enabled === 'boolean' ? reconnect.enabled : RECONNECT_DEFAULTS.enabled,
      initialDelayMs: positiveInteger(reconnect.initialDelayMs, RECONNECT_DEFAULTS.initialDelayMs),
      maxDelayMs: positiveInteger(reconnect.maxDelayMs, RECONNECT_DEFAULTS.maxDelayMs),
      maxAttempts: positiveInteger(reconnect.maxAttempts, RECONNECT_DEFAULTS.maxAttempts),
    },
    tools: mine,
    toolCount: mine.length,
    lastLog: lastLog ?? null,
    probe: probe ?? null,
    status: running,
  }
}

/** 由一组服务器算出汇总数字；过滤视图也用它，避免「1 台服务器 / 已连接 5」这种自相矛盾。 */function summarize(servers) {
  return {
    total: servers.length,
    connected: servers.filter((server) => server.status === 'connected' || server.status === 'connected-no-tools').length,
    issues: servers.filter((server) => server.status === 'failed' || server.status === 'retrying').length,
    disabled: servers.filter((server) => server.status === 'disabled').length,
    tools: servers.reduce((sum, server) => sum + server.toolCount, 0),
  }
}

/**
 * 浏览器半边有没有被组合进页面的模块图。
 *
 * `clientModules.clientPath(id)` 只有在该包已进入当前 boot 图时才返回路径。
 * 新装的插件会立刻进图，但**已经打开的页面**要刷新一次才会去拉它的模块 ——
 * 这正是「设置页看不到新入口」的唯一原因，值得直接写在面板上。
 */
function describeClient(runtime) {
  const modules = runtime.clientModules
  if (modules === undefined || typeof modules.clientPath !== 'function') {
    return { composed: null, path: null }
  }
  const path = safe(() => modules.clientPath(CLIENT_MODULE_ID), undefined)
  return {
    composed: typeof path === 'string' && path !== '',
    path: typeof path === 'string' && path !== '' ? path : null,
  }
}

/** 采集一份完整快照（纯读，无副作用，除诊断 note 之外）。 */
function collect(runtime, ctx) {  const at = Date.now()
  const toolNames = listToolNames(ctx, runtime)
  const entries = listMcpEntries(ctx, runtime)
  const servers = entries.map((item) => describeServer(runtime, item, toolNames))

  // 兜底：有 `mcp__<server>__` 工具却没有对应 Loader 条目（例如挂在 agent preset 作用域里）。
  const known = new Set(entries.map((item) => item.serverName))
  const orphans = new Map()
  for (const toolName of toolNames) {
    const serverName = serverOfToolName(toolName, known)
    if (serverName === undefined || known.has(serverName)) continue
    const group = orphans.get(serverName) ?? []
    group.push(toolName.slice(`mcp__${serverName}__`.length))
    orphans.set(serverName, group)
  }
  for (const [serverName, tools] of [...orphans.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    const lastLog = runtime.log.find((row) => row.server === serverName) ?? null
    const probe = runtime.probe.get(serverName) ?? null
    servers.push({
      serverName,
      entryId: '',
      source: 'tools',
      disabled: false,
      state: 'active',
      error: null,
      transport: 'unknown',
      endpoint: '',
      cwd: '',
      envKeys: [],
      headerKeys: [],
      toolCallTimeoutMs: 0,
      failOnStartupError: false,
      maxInstructionBytes: 0,
      reconnect: null,
      tools: tools.sort(),
      toolCount: tools.length,
      lastLog,
      probe,
      status: synthesizeStatus({
        disabled: false,
        state: 'active',
        error: undefined,
        toolCount: tools.length,
        signal: lastLog === null ? undefined : logSignal(lastLog),
        probe,
        logAt: lastLog?.at,
      }),
    })
  }

  servers.sort((left, right) => left.serverName.localeCompare(right.serverName))

  return {
    at,
    summary: summarize(servers),
    servers,
    log: runtime.log.slice(0, PUBLIC_LOG_ROWS),
    notes: runtime.notes.slice(),
    routes: runtime.routes.slice(),
    services: {
      ...runtime.services,
      // 这两个服务按“此刻能否拿到”实时判定：注入回调的落地时序不该影响页脚结论。
      loader: serviceOf(ctx, 'loader') === undefined ? 'missing' : 'ok',
      tools: serviceOf(ctx, 'tools') === undefined ? 'missing' : 'ok',
    },
    settings: { ...runtime.settings },
    client: describeClient(runtime),
    package: MCP_PLUGIN_PACKAGE,
    appliedAt: runtime.appliedAt,
  }
}

/* ------------------------------------------------------------- 主动探测 */

/** 把探测异常归类成 connected / offline / timeout / unknown。 */
function classifyProbeError(error) {
  const text = messageOf(error).replace(/^mcp-client\([A-Za-z0-9_-]{1,32}\):\s*/u, '')
  const name = safe(() => error?.name, '')
  if (/server is disconnected/iu.test(text)) return { status: 'offline', detail: text }
  if (/unavailable in this agent/iu.test(text)) return { status: 'offline', detail: text }
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out/iu.test(text)) return { status: 'timeout', detail: clip(text, 300) }
  // 协议层错误（例如服务器不支持 resources/list）说明传输是通的。
  if (/method not found|-32601|not supported|does not support|MethodNotFound/iu.test(text)) {
    return { status: 'connected', detail: clip(`已连通；服务器未实现 resources/list：${text}`, 300) }
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|EPIPE|spawn/iu.test(text)) {
    return { status: 'offline', detail: clip(text, 300) }
  }
  return { status: 'unknown', detail: clip(text, 300) }
}

/**
 * 探测一台服务器的连通性。
 *
 * 走 mcp-resources 的 provider：它绑定当前连接代，未连接时立刻抛
 * `server is disconnected`，已连接时才会真正发一次 `resources/list`。
 */
async function probeOne(runtime, serverName) {
  const at = Date.now()
  const service = runtime.mcpResources
  if (service === undefined || typeof service.request !== 'function') {
    return { at, serverName, status: 'unknown', detail: '宿主未加载 mcp-resources 服务，无法探测' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), runtime.settings.probeTimeoutMs)
  try {
    await service.request(serverName, { method: 'resources/list' }, { signal: controller.signal })
    return { at, serverName, status: 'connected', detail: 'resources/list 往返成功' }
  } catch (error) {
    const classified = classifyProbeError(error)
    return { at, serverName, ...classified }
  } finally {
    clearTimeout(timer)
  }
}

/** 探测指定的服务器（省略则全部）。 */
async function probeServers(runtime, ctx, requested) {
  const snapshot = collect(runtime, ctx)
  const targets = Array.isArray(requested) && requested.length > 0
    ? snapshot.servers.filter((server) => requested.includes(server.serverName))
    : snapshot.servers
  const results = []
  for (const server of targets) {
    // 串行执行：同一批探测里不让多台服务器同时拉扯宿主线程。
    const result = await probeOne(runtime, server.serverName)
    runtime.probe.set(server.serverName, { at: result.at, status: result.status, detail: result.detail })
    results.push(result)
  }
  return results
}

/* ------------------------------------------------------- 自检状态文件 */

const STATUS_THROTTLE_MS = 10000

/**
 * 把快照与自检信息落到 `$DSH_HOME/mcp-manager.status.json`。
 *
 * 两个理由：插件加载失败时设置页根本没机会渲染，这个文件是唯一现场；
 * 正常运行时它让“宿主到底看到了什么”可以在浏览器之外独立核对。
 * 只写不读、不参与任何判定，写失败也不影响插件。
 */
async function writeStatus(runtime, ctx, force) {
  const now = Date.now()
  if (force !== true && now - runtime.lastStatusWrite < STATUS_THROTTLE_MS) return
  runtime.lastStatusWrite = now
  try {
    const snapshot = collect(runtime, ctx)
    const payload = {
      plugin: name,
      status: 'ok',
      writtenAt: new Date(now).toISOString(),
      appliedAt: new Date(runtime.appliedAt).toISOString(),
      services: snapshot.services,
      client: snapshot.client,
      routes: snapshot.routes,
      notes: snapshot.notes,
      summary: snapshot.summary,
      servers: snapshot.servers.map((server) => ({
        serverName: server.serverName,
        entryId: server.entryId,
        status: server.status,
        state: server.state,
        transport: server.transport,
        endpoint: server.endpoint,
        toolCount: server.toolCount,
        tools: server.tools,
        error: server.error,
        probe: server.probe,
        lastLog: server.lastLog,
      })),
      log: snapshot.log.slice(0, 20),
    }
    await mkdir(join(homedir(), '.dsh'), { recursive: true })
    await writeFile(runtime.statusFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    /* 诊断文件永远不能影响插件本身 */
  }
}

/* ---------------------------------------------------------------- 路由 */

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** 在已鉴权的 `/api` 通道上挂两条路由。 */
function registerRoutes(runtime, ctx, connection) {
  const routes = [
    {
      path: STATE_ROUTE,
      methods: ['GET'],
      // 契约只有 'buffered' | 'streaming' 两种。写成别的值，连接层的 bridge 会走“流式”
      // 分支给 GET 挂上请求体，`new Request(GET + body)` 抛错 → 客户端收到 400。
      requestBody: 'buffered',
      fetch: async () => {
        const snapshot = collect(runtime, ctx)
        void writeStatus(runtime, ctx)
        return jsonResponse(snapshot)
      },
    },
    {
      path: PROBE_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await request.json().catch(() => ({}))
        const requested = isPlainObject(body) && Array.isArray(body.servers)
          ? body.servers.filter((value) => typeof value === 'string')
          : undefined
        const results = await probeServers(runtime, ctx, requested)
        const snapshot = collect(runtime, ctx)
        void writeStatus(runtime, ctx, true)
        return jsonResponse({ at: Date.now(), results, ...snapshot })
      },
    },
  ]

  return ctx.effect(() => {
    const disposers = []
    let disposed = false
    for (const route of routes) {
      try {
        const pending = connection.fetch.register(route)
        runtime.routes.push(`${route.methods.join('/')} ${route.path}`)
        if (typeof pending === 'function') {
          disposers.push(pending)
        } else if (pending !== undefined && typeof pending.then === 'function') {
          void pending.then((dispose) => {
            if (typeof dispose !== 'function') return
            if (disposed) void Promise.resolve(dispose()).catch(() => {})
            else disposers.push(dispose)
          }).catch((error) => note(runtime, `注册 ${route.path} 失败：${messageOf(error)}`))
        }
      } catch (error) {
        note(runtime, `注册 ${route.path} 失败：${messageOf(error)}`)
      }
    }
    return () => {
      disposed = true
      runtime.routes.length = 0
      for (const dispose of disposers) {
        try {
          const result = dispose()
          if (result !== undefined && typeof result.then === 'function') void result.catch(() => {})
        } catch {
          /* 卸载阶段的失败不改变插件结论 */
        }
      }
      disposers.length = 0
    }
  }, 'mcp-manager: /api routes')
}

/* ---------------------------------------------------------------- 工具 */

/** 把快照压成模型可读的多行文本。 */
function renderSnapshot(snapshot) {
  const lines = [
    `MCP 服务器 ${snapshot.summary.total} 台：已连接 ${snapshot.summary.connected}，异常 ${snapshot.summary.issues}，停用 ${snapshot.summary.disabled}，工具合计 ${snapshot.summary.tools}`,
  ]
  for (const server of snapshot.servers) {
    lines.push('')
    lines.push(`- ${server.serverName} [${server.status}] ${server.transport}${server.endpoint === '' ? '' : ` · ${server.endpoint}`}`)
    lines.push(`  条目 ${server.entryId === '' ? '(无)' : server.entryId} · 生命周期 ${server.state} · 工具 ${server.toolCount}`)
    if (server.tools.length > 0) lines.push(`  工具：${server.tools.join(', ')}`)
    if (server.error !== null) lines.push(`  加载错误：${server.error}`)
    if (server.probe !== null) lines.push(`  探测(${new Date(server.probe.at).toISOString()}) ${server.probe.status}：${server.probe.detail}`)
    if (server.lastLog !== null) lines.push(`  最近事件 ${new Date(server.lastLog.at).toISOString()} [${server.lastLog.level}]：${server.lastLog.text}`)
  }
  if (snapshot.notes.length > 0) {
    lines.push('')
    lines.push(`诊断：${snapshot.notes.join(' | ')}`)
  }
  return lines.join('\n')
}

/** 注册 agent 工具；没有 tools 服务时静默跳过。 */
function registerTool(runtime, ctx) {
  return ctx.inject(['tools'], (scope) => {
    const tools = serviceOf(scope, 'tools')
    runtime.services.tools = tools === undefined ? 'missing' : 'ok'
    if (tools === undefined || typeof tools.register !== 'function') {
      note(runtime, 'tools 服务不可用：mcp_manager_status 未注册')
      return undefined
    }
    return ctx.effect(() => tools.register({
      name: 'mcp_manager_status',
      description: '查看当前注册的 MCP 服务器及其运行状态：条目生命周期、传输方式与地址、已注册的 mcp__<server>__* 工具、最近一次连接日志，以及可选的主动连通性探测（probe=true 时对每台服务器做一次 resources/list 往返）。',
      parameters: {
        type: 'object',
        properties: {
          probe: { type: 'boolean', description: 'true 时当场探测每台服务器的连通性（会向服务器发一次 resources/list，未连接时立刻返回）' },
          server: { type: 'string', description: '只看一台服务器（serverName）；省略表示全部' },
        },
        additionalProperties: false,
      },
      output: {
        // 必须是受限 JSON Schema 子集里的类型：`type: 'json'` 会被 assertSupportedJsonSchema 拒绝。
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          if (!isPlainObject(value)) return [{ type: 'text', text: JSON.stringify(value) }]
          return [{ type: 'text', text: typeof value.text === 'string' ? value.text : JSON.stringify(value) }]
        },
      },
      execute: async (args) => {
        const wantProbe = isPlainObject(args) && args.probe === true
        const only = isPlainObject(args) && typeof args.server === 'string' && args.server !== '' ? args.server : undefined
        if (wantProbe) await probeServers(runtime, ctx, only === undefined ? undefined : [only])
        const snapshot = collect(runtime, ctx)
        void writeStatus(runtime, ctx, wantProbe)
        const servers = only === undefined ? snapshot.servers : snapshot.servers.filter((server) => server.serverName === only)
        const scoped = { ...snapshot, servers, summary: summarize(servers) }
        return { ...scoped, text: renderSnapshot(scoped) }
      },
    }), 'mcp-manager: mcp_manager_status')
  })
}

/** 把一条 logger 记录解析成 mcp-client 连接事件；不是这种行就忽略。 */
function absorbMessage(runtime, message) {
  try {
    const args = safe(() => message?.args, undefined)
    if (!Array.isArray(args) || args.length === 0) return
    const first = args[0]
    if (typeof first !== 'string') return
    const match = LOG_LINE.exec(first)
    if (match === null) return
    pushLog(runtime, {
      at: typeof message.ts === 'number' ? message.ts : Date.now(),
      server: match[1],
      level: String(message.type ?? 'info'),
      text: clip(match[2].replace(/\s+/gu, ' ').trim(), LOG_TEXT_LIMIT),
    })
  } catch {
    /* 日志采集永远不能影响别人打日志 */
  }
}

/* ---------------------------------------------------------------- 入口 */

/** 插件入口。 */
export function apply(ctx, config) {
  const runtime = createRuntime(config)

  // 1. 连接日志：mcp-client 自己不导出连接状态，日志是唯一实时的连接证据。
  const logger = serviceOf(ctx, 'logger')
  if (logger === undefined || typeof logger.exporter !== 'function') {
    note(runtime, 'logger 服务不可用：无法采集 mcp-client 连接事件')
  } else {
    runtime.services.logger = 'ok'
    // 先回填 logger 的环形缓冲：插件加载前发生的事件（例如启动时就连不上的服务器）也不丢。
    const buffered = safe(() => logger.buffer, undefined)
    if (Array.isArray(buffered)) for (const message of buffered) absorbMessage(runtime, message)
    ctx.effect(() => logger.exporter({
      export: (message) => absorbMessage(runtime, message),
    }), 'mcp-manager: mcp-client log capture')
  }

  // 2. 可选服务：逐个记录可用性，设置页底部能看出“哪条证据缺失”。
  ctx.inject(['loader'], () => {
    runtime.services.loader = 'ok'
  })
  ctx.inject(['mcpResources'], (scope) => {
    const resources = serviceOf(scope, 'mcpResources')
    runtime.mcpResources = resources
    runtime.services.mcpResources = resources === undefined ? 'missing' : 'ok'
  })
  ctx.inject(['clientModules'], (scope) => {
    const modules = serviceOf(scope, 'clientModules')
    runtime.clientModules = modules
    runtime.services.clientModules = modules === undefined ? 'missing' : 'ok'
  })

  // 3. 同源 /api 路由（由连接层的信任围栏保护，浏览器靠同源 Cookie 鉴权）。
  ctx.inject(['connection'], (scope) => {
    const connection = serviceOf(scope, 'connection')
    runtime.services.connection = connection === undefined ? 'missing' : 'ok'
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      note(runtime, 'connection 服务不可用：/api 路由未注册（设置页会报 404）')
      return
    }
    registerRoutes(runtime, ctx, connection)
  })

  // 4. agent 工具：让模型也能查同一份快照。
  registerTool(runtime, ctx)

  // 5. 自检现场：不管设置页能否渲染，先把“宿主看到了什么”落盘。
  void writeStatus(runtime, ctx, true)
  // 6. 注入回调是异步落地的，稍后再写一次，让 routes / services 反映最终接线。
  const wiringTimer = setTimeout(() => void writeStatus(runtime, ctx, true), 400)
  ctx.effect(() => () => clearTimeout(wiringTimer), 'mcp-manager: wiring snapshot')
}
