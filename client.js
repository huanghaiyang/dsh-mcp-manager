/**
 * MCP 管理器 · 浏览器半边。
 *
 * 在「设置 → MCP 管理器」注册一页，展示宿主上已注册的 MCP 服务器及其运行状态：
 * - 条目生命周期（Loader fiber 状态）、传输方式与地址、调用超时、重连策略；
 * - 已注册的 `mcp__<server>__*` 工具清单与数量；
 * - mcp-client 最近一次连接日志（连接失败 / 重试 / 放弃 / 重连成功）；
 * - 点「测试连接」时由宿主做一次 `resources/list` 往返，给出确定的连通性。
 *
 * 与宿主半边的通信走同源 `/api/mcp-manager.*`（连接层负责信任围栏与 Cookie 鉴权），
 * 不使用任何 Harness Client 包，样式只用 `--dsw-alias-*` 主题令牌。
 *
 * ⚠ 必须整体包在 IIFE 里。client 半边是**经典脚本**（不是 ESM），同页面所有客户端插件
 * 共用一个全局词法作用域：任何顶层 `const`/`let`（ROUTE、DICT、CSS…）都会变成全局绑定，
 * 后加载的同名声明直接 `SyntaxError: Identifier 'xxx' has already been declared`，
 * 把那个插件的整段脚本打挂（`plugins/?? loaded without registering ...` 就是这个后果）。
 */
(() => {
const ROUTE = '/api/mcp-manager'
const AUTO_REFRESH_MS = 8000

/** 浏览器模块表在 factory 里注入 React；本模块的函数在外层定义，靠这个自由变量取用。 */
let React = undefined

const DICT = {
  zh: {
    nav: 'MCP 管理器',
    subtitle: '查看宿主上已注册的 MCP 服务器、连接状态、工具清单与最近的连接事件。',
    refresh: '刷新',
    refreshing: '刷新中…',
    testAll: '测试全部连接',
    testing: '探测中…',
    testOne: '测试连接',
    autoRefresh: '自动刷新',
    lastUpdated: '更新于',
    never: '尚未获取',
    totalServers: '服务器',
    connectedCount: '已连接',
    issueCount: '异常',
    disabledCount: '停用',
    toolsTotal: '工具',
    statusConnected: '已连接',
    statusConnectedNoTools: '已加载 · 无工具',
    statusRetrying: '重连中',
    statusFailed: '不可用',
    statusDisabled: '已停用',
    statusLoading: '启动中',
    statusUnknown: '未知',
    transport: '传输',
    tools: '工具',
    entry: '条目',
    lifecycle: '生命周期',
    timeout: '调用超时',
    reconnect: '重连',
    reconnectOff: '关闭',
    reconnectOn: '开 · 最多 {n} 次',
    endpoint: '地址',
    cwd: '工作目录',
    lastEvent: '最近事件',
    probeResult: '探测结果',
    probeConnected: '连通',
    probeOffline: '不通',
    probeTimeout: '超时',
    probeUnknown: '不确定',
    expandTools: '展开 {n} 个工具',
    collapseTools: '收起工具',
    toolsOnly: '仅工具',
    secretKeys: '已配置的键',
    recentEvents: '最近的连接事件',
    noEvents: '还没有采集到 mcp-client 的连接事件（服务器没有报错或重连时本来就不会打日志）。',
    noServers: '当前没有注册任何 MCP 服务器。',
    noServersHint: '在 profile 的 cordis.patch.yml 里插入一行 `@deepseek-ai/dsh-mcp-client`（每台服务器一行）后重启即可。',
    diagnostics: '宿主持久自查',
    clientModule: '前端模块',
    clientComposed: '已装配进页面模块图',
    clientMissing: '未装配',
    clientUnknown: '未知',
    refreshHint: '刚安装或更新本插件后，需要刷新一次页面，浏览器才会加载它的前端模块并显示本页。',
    loadFailed: '读取状态失败',
    hostUnreachable: '无法访问宿主路由',
    retryHint: '宿主半边可能还没加载，重启 dsh web 后再试。',
    probeAllDone: '已完成 {n} 台服务器的连通性探测。',
    refreshFailed: '刷新失败',
    scopeNote: '工具数量来自当前全局工具注册表；挂在本 Agent 作用域里的服务器会额外显示为「仅工具」条目。',
  },
  en: {
    nav: 'MCP Manager',
    subtitle: 'Inspect registered MCP servers, their connection status, tool inventory, and recent connection events.',
    refresh: 'Refresh',
    refreshing: 'Refreshing…',
    testAll: 'Test all connections',
    testing: 'Probing…',
    testOne: 'Test',
    autoRefresh: 'Auto refresh',
    lastUpdated: 'Updated',
    never: 'not fetched yet',
    totalServers: 'Servers',
    connectedCount: 'Connected',
    issueCount: 'Issues',
    disabledCount: 'Disabled',
    toolsTotal: 'Tools',
    statusConnected: 'Connected',
    statusConnectedNoTools: 'Loaded · no tools',
    statusRetrying: 'Reconnecting',
    statusFailed: 'Unavailable',
    statusDisabled: 'Disabled',
    statusLoading: 'Starting',
    statusUnknown: 'Unknown',
    transport: 'Transport',
    tools: 'Tools',
    entry: 'Entry',
    lifecycle: 'Lifecycle',
    timeout: 'Call timeout',
    reconnect: 'Reconnect',
    reconnectOff: 'off',
    reconnectOn: 'on · max {n}',
    endpoint: 'Endpoint',
    cwd: 'Working directory',
    lastEvent: 'Last event',
    probeResult: 'Probe',
    probeConnected: 'reachable',
    probeOffline: 'unreachable',
    probeTimeout: 'timeout',
    probeUnknown: 'inconclusive',
    expandTools: 'Show {n} tools',
    collapseTools: 'Hide tools',
    toolsOnly: 'tools only',
    secretKeys: 'Configured keys',
    recentEvents: 'Recent connection events',
    noEvents: 'No mcp-client connection events yet — the bridge only logs failures and reconnects.',
    noServers: 'No MCP server is registered right now.',
    noServersHint: 'Insert one `@deepseek-ai/dsh-mcp-client` row per server in the profile cordis.patch.yml, then restart.',
    diagnostics: 'Host self-check',
    clientModule: 'Client module',
    clientComposed: 'composed into the page module graph',
    clientMissing: 'not composed',
    clientUnknown: 'unknown',
    refreshHint: 'After installing or updating this plugin, reload the page once so the browser loads its Client half and shows this panel.',
    loadFailed: 'Could not read status',
    hostUnreachable: 'Cannot reach the host route',
    retryHint: 'The Host half is probably not loaded yet; restart dsh web and retry.',
    probeAllDone: 'Probed {n} server(s).',
    refreshFailed: 'Refresh failed',
    scopeNote: 'Tool counts come from the global tool registry; servers mounted in an agent scope show up as extra "tools only" entries.',
  },
}

const CSS = `
.mcm-root { display: flex; flex-direction: column; gap: 14px; padding: 4px 0 28px; color: var(--dsw-alias-label-primary); }
.mcm-head { display: flex; flex-direction: column; gap: 4px; }
.mcm-title { font-size: 15px; font-weight: 600; }
.mcm-sub { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.mcm-stats { display: flex; flex-wrap: wrap; gap: 8px; }
.mcm-stat { display: flex; flex-direction: column; gap: 2px; min-width: 74px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.mcm-stat-v { font-size: 17px; font-weight: 600; line-height: 1.2; }
.mcm-stat-k { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mcm-stat-v.ok { color: var(--dsw-alias-state-success-primary); }
.mcm-stat-v.bad { color: var(--dsw-alias-state-error-primary); }
.mcm-stat-v.warn { color: var(--dsw-alias-state-warn-primary); }
.mcm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mcm-toolbar .mcm-spacer { flex: 1 1 auto; }
.mcm-stamp { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.mcm-btn { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; cursor: pointer; }
.mcm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.mcm-btn:disabled { cursor: not-allowed; opacity: .4; }
.mcm-btn.primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.mcm-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.mcm-check input { width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.mcm-list { display: flex; flex-direction: column; gap: 10px; }
.mcm-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.mcm-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mcm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: 0 0 auto; }
.mcm-dot.on { background: var(--dsw-alias-state-success-primary); }
.mcm-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.mcm-dot.bad { background: var(--dsw-alias-state-error-primary); }
.mcm-name { font-size: 13px; font-weight: 600; }
.mcm-tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.mcm-status { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mcm-status.on { color: var(--dsw-alias-state-success-primary); }
.mcm-status.warn { color: var(--dsw-alias-state-warn-primary); }
.mcm-status.bad { color: var(--dsw-alias-state-error-primary); }
.mcm-grow { flex: 1 1 auto; }
.mcm-line { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.mcm-line .mcm-k { color: var(--dsw-alias-label-secondary); opacity: .85; }
.mcm-line .mcm-v { color: var(--dsw-alias-label-primary); }
.mcm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; word-break: break-all; }
.mcm-alert { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); }
.mcm-warn-note { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-warn-primary); }
.mcm-ok-note { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-success-primary); }
.mcm-hint { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.mcm-link { align-self: flex-start; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font-size: 12px; cursor: pointer; }
.mcm-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.mcm-tool { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); }
.mcm-log { display: flex; flex-direction: column; gap: 5px; max-height: 240px; overflow: auto; }
.mcm-log-row { display: flex; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.mcm-log-row .mcm-log-time { flex: 0 0 auto; opacity: .8; }
.mcm-log-row .mcm-log-server { flex: 0 0 auto; color: var(--dsw-alias-label-primary); }
.mcm-log-row.err .mcm-log-text { color: var(--dsw-alias-state-error-primary); }
.mcm-log-row.warn .mcm-log-text { color: var(--dsw-alias-state-warn-primary); }
.mcm-log-text { word-break: break-word; }
.mcm-foot { font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-secondary); word-break: break-word; }
`

/** 同源 `/api` 调用：浏览器靠同源 Cookie 通过信任围栏。 */
async function api(path, body) {
  let response
  try {
    response = await fetch(`${ROUTE}${path}`, body === undefined
      ? { method: 'GET', headers: { accept: 'application/json' } }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  } catch (error) {
    return { ok: false, status: 0, detail: `${error && error.message ? error.message : String(error)}` }
  }
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (parsed === undefined) {
    const detail = response.status === 404
      ? `HTTP 404 · 宿主路由未注册`
      : `HTTP ${response.status} · ${text.slice(0, 160)}`
    return { ok: false, status: response.status, detail }
  }
  return { ok: response.ok, status: response.status, data: parsed }
}

function timeLabel(at) {
  try {
    return new Date(at).toLocaleTimeString()
  } catch {
    return String(at)
  }
}

function msLabel(value) {
  if (typeof value !== 'number' || value <= 0) return '—'
  return value >= 1000 ? `${Math.round(value / 100) / 10}s` : `${value}ms`
}

/** 状态 → 颜色与文案。 */
function statusInfo(t, status) {
  switch (status) {
    case 'connected': return { tone: 'on', label: t('statusConnected') }
    case 'connected-no-tools': return { tone: 'on', label: t('statusConnectedNoTools') }
    case 'retrying': return { tone: 'warn', label: t('statusRetrying') }
    case 'loading': return { tone: 'warn', label: t('statusLoading') }
    case 'failed': return { tone: 'bad', label: t('statusFailed') }
    case 'disabled': return { tone: '', label: t('statusDisabled') }
    default: return { tone: '', label: t('statusUnknown') }
  }
}

function probeInfo(t, probe) {
  if (probe === null || probe === undefined) return undefined
  const tone = probe.status === 'connected' ? 'ok' : (probe.status === 'timeout' ? 'warn' : 'bad')
  const label = probe.status === 'connected'
    ? t('probeConnected')
    : (probe.status === 'timeout' ? t('probeTimeout') : (probe.status === 'offline' ? t('probeOffline') : t('probeUnknown')))
  const className = tone === 'ok' ? 'mcm-ok-note' : (tone === 'warn' ? 'mcm-warn-note' : 'mcm-alert')
  return { tone, className, label, detail: String(probe.detail ?? ''), at: probe.at }
}

/** 一台服务器的卡片。 */
function ServerCard({ server, t, busy, onProbe, open, onToggle }) {
  const h = React.createElement
  const status = statusInfo(t, server.status)
  const probe = probeInfo(t, server.probe)
  const reconnect = server.reconnect === null
    ? '—'
    : (server.reconnect.enabled === true ? t('reconnectOn').replace('{n}', String(server.reconnect.maxAttempts)) : t('reconnectOff'))
  const keys = [...(server.envKeys ?? []), ...(server.headerKeys ?? [])]

  return h('div', { className: 'mcm-card' },
    h('div', { className: 'mcm-card-head' },
      h('span', { className: `mcm-dot ${status.tone}` }),
      h('span', { className: 'mcm-name' }, server.serverName),
      server.transport === 'unknown' ? null : h('span', { className: 'mcm-tag' }, server.transport),
      server.source === 'tools' ? h('span', { className: 'mcm-tag' }, t('toolsOnly')) : null,
      h('span', { className: 'mcm-tag' }, `${t('tools')} ${server.toolCount}`),
      h('span', { className: `mcm-status ${status.tone}` }, status.label),
      h('span', { className: 'mcm-grow' }),
      h('button', {
        className: 'mcm-btn',
        disabled: busy !== '',
        onClick: () => void onProbe(server.serverName),
      }, busy === `probe:${server.serverName}` ? t('testing') : t('testOne'))),

    h('div', { className: 'mcm-line' },
      h('span', { className: 'mcm-k' }, `${t('endpoint')}:`),
      h('span', { className: `mcm-v mcm-mono` }, server.endpoint === '' ? '—' : server.endpoint)),

    h('div', { className: 'mcm-line' },
      h('span', null, `${t('entry')} ${server.entryId === '' ? '—' : server.entryId}`),
      h('span', null, `${t('lifecycle')} ${server.state}`),
      h('span', null, `${t('timeout')} ${msLabel(server.toolCallTimeoutMs)}`),
      h('span', null, `${t('reconnect')} ${reconnect}`),
      server.cwd === '' ? null : h('span', { className: 'mcm-mono' }, `${t('cwd')} ${server.cwd}`)),

    server.error === null ? null : h('div', { className: 'mcm-alert' }, server.error),

    probe === undefined ? null : h('div', { className: probe.className },
      `${t('probeResult')} · ${probe.label}${probe.detail === '' ? '' : ` · ${probe.detail}`}`),

    server.lastLog === null ? null : h('div', { className: 'mcm-line' },
      h('span', { className: 'mcm-k' }, `${t('lastEvent')} ${timeLabel(server.lastLog.at)}`),
      h('span', { className: `mcm-v ${server.lastLog.level === 'error' ? 'mcm-alert' : ''} mcm-mono` }, server.lastLog.text)),

    keys.length === 0 ? null : h('div', { className: 'mcm-line' },
      h('span', { className: 'mcm-k' }, `${t('secretKeys')}:`),
      h('span', { className: 'mcm-v mcm-mono' }, keys.join(', '))),

    server.toolCount === 0 ? null : h('button', { className: 'mcm-link', onClick: () => onToggle(server.serverName) },
      open ? t('collapseTools') : t('expandTools').replace('{n}', String(server.toolCount))),

    open ? h('div', { className: 'mcm-tools' }, server.tools.map((tool) => h('span', { className: 'mcm-tool', key: tool }, tool))) : null)
}

/** 浏览器半边装配状态 → 文案。 */
function clientLabel(t, client) {
  if (client === undefined || client === null) return t('clientUnknown')
  if (client.composed === true) return t('clientComposed')
  if (client.composed === false) return t('clientMissing')
  return t('clientUnknown')
}

/** 设置页主体。 */
function Page(props) {
  const h = React.createElement
  const t = props.t
  const [state, setState] = React.useState(undefined)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [auto, setAuto] = React.useState(true)
  const [open, setOpen] = React.useState({})

  /**
   * 取一份快照。
   *
   * 正常情况下走 `GET /api/mcp-manager.state`。旧版宿主把这条 GET 路由注册成了
   * `requestBody: 'none'`（契约只允许 buffered/streaming），连接层会给 GET 挂请求体
   * 直接 400；此时退回到 `POST .probe` 并显式声明一台不存在的服务器 ——
   * 「探测 0 台」的语义就是只取快照、不碰任何服务器。宿主重启后走主路径，回退自然闲置。
   */
  const load = React.useCallback(async () => {
    const direct = await api('.state')
    if (direct.ok) return direct
    if (direct.status === 400 || direct.status === 404) {
      const fallback = await api('.probe', { servers: ['__none__'] })
      if (fallback.ok) return fallback
      return { ok: false, status: fallback.status, detail: `${direct.detail ?? ''}；回退 ${fallback.detail ?? ''}` }
    }
    return direct
  }, [])

  const refresh = React.useCallback(async () => {
    setBusy((current) => (current === '' ? 'refresh' : current))
    const result = await load()
    setBusy((current) => (current === 'refresh' ? '' : current))
    if (!result.ok) {
      setError(`${t('hostUnreachable')}${result.status === 0 || result.status === 404 ? ` · ${t('retryHint')}` : ''}${result.detail ? ` (${result.detail})` : ''}`)
      return
    }
    setError('')
    setState(result.data)
  }, [load, t])

  const probeAll = React.useCallback(async () => {
    setBusy('probe')
    const result = await api('.probe', {})
    setBusy('')
    if (!result.ok) {
      setError(`${t('refreshFailed')}: ${result.detail ?? ''}`)
      return
    }
    setError('')
    setState(result.data)
    setNotice(t('probeAllDone').replace('{n}', String((result.data.results ?? []).length)))
  }, [t])

  const probeOne = React.useCallback(async (serverName) => {
    setBusy(`probe:${serverName}`)
    const result = await api('.probe', { servers: [serverName] })
    setBusy('')
    if (!result.ok) {
      setError(`${t('refreshFailed')}: ${result.detail ?? ''}`)
      return
    }
    setError('')
    setState(result.data)
  }, [t])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (auto !== true) return undefined
    const timer = window.setInterval(() => {
      if (busy !== '') return
      void refresh()
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [auto, busy, refresh])

  const toggle = React.useCallback((serverName) => {
    setOpen((current) => ({ ...current, [serverName]: current[serverName] !== true }))
  }, [])

  const s = state
  const summary = s === undefined ? undefined : s.summary

  return h('div', { className: 'mcm-root' },
    h('style', null, CSS),
    h('div', { className: 'mcm-head' },
      h('div', { className: 'mcm-title' }, t('nav')),
      h('div', { className: 'mcm-sub' }, t('subtitle'))),

    summary === undefined ? null : h('div', { className: 'mcm-stats' },
      h('div', { className: 'mcm-stat' }, h('span', { className: 'mcm-stat-v' }, String(summary.total)), h('span', { className: 'mcm-stat-k' }, t('totalServers'))),
      h('div', { className: 'mcm-stat' }, h('span', { className: 'mcm-stat-v ok' }, String(summary.connected)), h('span', { className: 'mcm-stat-k' }, t('connectedCount'))),
      h('div', { className: 'mcm-stat' }, h('span', { className: `mcm-stat-v ${summary.issues > 0 ? 'bad' : ''}` }, String(summary.issues)), h('span', { className: 'mcm-stat-k' }, t('issueCount'))),
      h('div', { className: 'mcm-stat' }, h('span', { className: 'mcm-stat-v' }, String(summary.disabled)), h('span', { className: 'mcm-stat-k' }, t('disabledCount'))),
      h('div', { className: 'mcm-stat' }, h('span', { className: 'mcm-stat-v' }, String(summary.tools)), h('span', { className: 'mcm-stat-k' }, t('toolsTotal')))),

    h('div', { className: 'mcm-toolbar' },
      h('button', { className: 'mcm-btn primary', disabled: busy !== '', onClick: () => void refresh() },
        busy === 'refresh' ? t('refreshing') : t('refresh')),
      h('button', { className: 'mcm-btn', disabled: busy !== '' || s === undefined || (s.servers ?? []).length === 0, onClick: () => void probeAll() },
        busy === 'probe' ? t('testing') : t('testAll')),
      h('label', { className: 'mcm-check' },
        h('input', { type: 'checkbox', checked: auto, onChange: (event) => setAuto(event.target.checked) }),
        t('autoRefresh')),
      h('span', { className: 'mcm-grow' }),
      h('span', { className: 'mcm-stamp' }, s === undefined ? t('never') : `${t('lastUpdated')} ${timeLabel(s.at)}`)),

    error === '' ? null : h('div', { className: 'mcm-alert' }, error),
    notice === '' ? null : h('div', { className: 'mcm-ok-note' }, notice),

    s === undefined
      ? h('div', { className: 'mcm-hint' }, '…')
      : (s.servers.length === 0
        ? h('div', { className: 'mcm-card' },
          h('div', { className: 'mcm-name' }, t('noServers')),
          h('div', { className: 'mcm-hint' }, t('noServersHint')))
        : h('div', { className: 'mcm-list' }, s.servers.map((server) => h(ServerCard, {
          key: server.serverName,
          server,
          t,
          busy,
          open: open[server.serverName] === true,
          onProbe: probeOne,
          onToggle: toggle,
        })))),

    s === undefined ? null : h('div', { className: 'mcm-card' },
      h('div', { className: 'mcm-name' }, t('recentEvents')),
      (s.log ?? []).length === 0
        ? h('div', { className: 'mcm-hint' }, t('noEvents'))
        : h('div', { className: 'mcm-log' }, (s.log ?? []).map((row, index) => h('div', {
          className: `mcm-log-row ${row.level === 'error' ? 'err' : (row.level === 'warn' ? 'warn' : '')}`,
          key: `${String(row.at)}-${String(index)}`,
        },
        h('span', { className: 'mcm-log-time' }, timeLabel(row.at)),
        h('span', { className: 'mcm-log-server' }, row.server),
        h('span', { className: 'mcm-log-text' }, row.text))))),

    s === undefined ? null : h('div', { className: 'mcm-foot' },
      h('div', null, t('scopeNote')),
      h('div', null, `${t('clientModule')}: ${clientLabel(t, s.client)}`),
      h('div', null, t('refreshHint')),
      h('div', null, `${t('diagnostics')}: ${(s.notes ?? []).length === 0 ? 'ok' : (s.notes ?? []).join(' | ')}`),
      h('div', null, `API: ${(s.routes ?? []).join(' · ')}`),
      h('div', null, `services: ${Object.entries(s.services ?? {}).map(([key, value]) => `${key}=${String(value)}`).join(', ')}`)))
}

window.__ModuleLoader__.load({
  id: '@local/dsh-mcp-manager',
  factory(require) {
    React = require('react')
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('mcp-manager', DICT), 'mcp-manager: dictionaries')
        const t = ctx.locale.bind('mcp-manager')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mcp-manager',
          order: 45,
          label: () => t('nav'),
          locale: 'mcp-manager',
        }, (props) => React.createElement(Page, { ...props, t })))
      },
    }
  },
})
})()
