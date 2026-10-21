/**
 * 浏览器半边的离线冒烟测试：把 `client.js` 当普通脚本喂进 Node，
 * 用桩 `window.__ModuleLoader__` / 桩 React / 桩 slots+locale 跑一遍装配与渲染。
 *
 * 目的不是替代真浏览器，而是把“刷新页面就白屏”的常见原因挡在门外：
 * 模块求值报错、factory 形状不对、槽位注册参数不对、组件渲染时踩到 undefined。
 *
 * 用法：node tests/client-smoke.mjs
 */
import assert from 'node:assert/strict'

/* ---------------------------------------------------------- 桩 React */

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) }
}

/** 按调用顺序喂 useState 初值，模拟“已经拿到数据”的那一次渲染。 */
function reactWithState(queue) {
  let index = 0
  return {
    createElement,
    useState: (initial) => {
      const value = index < queue.length ? queue[index] : initial
      index += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/* ------------------------------------------------------- 桩 window/loader */

const captures = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captures.push(definition)
    },
  },
  setInterval: () => 0,
  clearInterval: () => {},
}

await import('../client.js')

assert.equal(captures.length, 1, 'client.js 必须注册一个模块')
const [definition] = captures
assert.equal(definition.id, '@local/dsh-mcp-manager', '模块 id 必须等于包名')

const react = reactWithState([])
const api = definition.factory((name) => (name === 'react' ? react : undefined))
assert.deepEqual(api.inject, ['slots', 'locale'], '只依赖 slots 与 locale')

/* ------------------------------------------------------------ 桩 Context */

const dictionaries = []
const registrations = []
const disposers = []
const injected = []

const ctx = {
  effect(run) {
    const disposer = run()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.push({ namespace, dicts })
      return () => {}
    },
    bind(namespace) {
      return (key, vars) => {
        const dict = dictionaries.find((entry) => entry.namespace === namespace)?.dicts?.zh ?? {}
        const template = dict[key] ?? key
        if (vars === undefined) return template
        return Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), template)
      }
    },
  },
  slots: {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

api.apply(ctx)

assert.deepEqual(injected, ['settings.section'], '注册到设置页槽位')
assert.equal(registrations.length, 1)
const [{ options, component }] = registrations
assert.equal(options.name, 'settings.section')
assert.equal(options.id, 'mcp-manager')
assert.equal(options.order, 45)
assert.equal(typeof options.label, 'function')
assert.equal(options.label(), 'MCP 管理器', '导航文字走 locale')

const [localeEntry] = dictionaries
assert.equal(localeEntry.namespace, 'mcp-manager')
assert.equal(localeEntry.dicts.zh.nav, 'MCP 管理器')
assert.equal(localeEntry.dicts.en.nav, 'MCP Manager')

const t = ctx.locale.bind('mcp-manager')

/* -------------------------------------------------------- 渲染：加载态 */

{
  const tree = component({ t, close: () => {} })
  const text = collectText(tree)
  assert.match(text, /MCP 管理器/u, '加载中也要有标题')
  assert.match(text, /正在|刷新|…/u, '加载中给出占位')
  assert.match(text, /\.mcm-root\s*\{/u, '组件内联样式表存在（随卸载一并移除）')
}

/* ------------------------------------------------------ 渲染：真实快照 */

const snapshot = {
  at: Date.now(),
  summary: { total: 2, connected: 1, issues: 1, disabled: 0, tools: 3 },
  servers: [
    {
      serverName: 'rea',
      entryId: 'include:rea-mcp',
      source: 'loader',
      disabled: false,
      state: 'active',
      error: null,
      transport: 'stdio',
      endpoint: 'node rea.mjs mcp',
      cwd: 'C:\\rea',
      envKeys: ['REA_TOKEN'],
      headerKeys: [],
      toolCallTimeoutMs: 90000,
      failOnStartupError: false,
      maxInstructionBytes: 32768,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 5 },
      tools: ['search', 'read'],
      toolCount: 2,
      lastLog: null,
      probe: { at: Date.now(), status: 'connected', detail: 'resources/list 往返成功' },
      status: 'connected',
    },
    {
      serverName: 'godot-ai',
      entryId: 'include:mcp-godot-ai',
      source: 'loader',
      disabled: false,
      state: 'active',
      error: null,
      transport: 'stdio',
      endpoint: 'pythonw.exe launch.py',
      cwd: '',
      envKeys: [],
      headerKeys: [],
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
      maxInstructionBytes: 32768,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
      tools: [],
      toolCount: 0,
      lastLog: { at: Date.now() - 1000, server: 'godot-ai', level: 'error', text: 'reconnect stopped to avoid overlapping server processes' },
      probe: null,
      status: 'failed',
    },
  ],
  log: [
    { at: Date.now() - 1000, server: 'godot-ai', level: 'error', text: 'reconnect stopped to avoid overlapping server processes' },
    { at: Date.now() - 2000, server: 'rea', level: 'warn', text: 'connection failed; retrying in 500ms (attempt 1/10)' },
  ],
  notes: [],
  routes: ['GET /api/mcp-manager.state', 'POST /api/mcp-manager.probe'],
  services: { logger: 'ok', loader: 'ok', tools: 'ok', connection: 'ok', mcpResources: 'ok', clientModules: 'ok' },
  settings: { logLimit: 240, probeTimeoutMs: 8000 },
  client: { composed: true, path: 'D:\\sgames\\dsh-mcp-manager\\client.js' },
  package: '@deepseek-ai/dsh-mcp-client',
  appliedAt: Date.now(),
}

{
  // 用“已拿到快照”的 React 桩重新取一次组件
  const react2 = reactWithState([snapshot, '', '', '', true, {}])
  const api2 = definition.factory((name) => (name === 'react' ? react2 : undefined))
  const registrations2 = []
  api2.apply({
    ...ctx,
    slots: {
      inject: (key, callback) => callback(),
      register: (options2, component2) => {
        registrations2.push({ options: options2, component: component2 })
        return () => {}
      },
    },
  })
  const page = registrations2[0].component({ t, close: () => {} })
  const text = collectText(page)

  assert.match(text, /MCP 管理器/u, '标题')
  assert.match(text, /rea/u, '渲染 rea 卡片')
  assert.match(text, /godot-ai/u, '渲染 godot-ai 卡片')
  assert.match(text, /已连接/u, '已连接状态文案')
  assert.match(text, /不可用/u, '失败状态文案')
  assert.match(text, /node rea\.mjs mcp/u, '展示端点')
  assert.match(text, /REA_TOKEN/u, '展示环境变量键名')
  assert.match(text, /最多 5 次/u, '重连策略按配置展示')
  assert.match(text, /探测结果/u, '展示探测结果')
  assert.match(text, /resources\/list 往返成功/u, '展示探测细节')
  assert.match(text, /最近的连接事件/u, '展示事件区')
  assert.match(text, /reconnect stopped to avoid overlapping/u, '展示原始事件文本')
  assert.match(text, /前端模块: 已装配进页面模块图/u, '展示前端装配状态')
  assert.match(text, /刷新一次页面/u, '给出刷新提示')
  assert.ok(!text.includes('[object Object]'), '不能出现 [object Object]')
  assert.ok(!text.includes('undefined'), '不能把 undefined 渲染进页面')
  assert.ok(!text.includes('NaN'), '不能出现 NaN')
}

/* ------------------------------------------------------------ 空列表渲染 */

{
  const empty = { ...snapshot, summary: { total: 0, connected: 0, issues: 0, disabled: 0, tools: 0 }, servers: [], log: [] }
  const react3 = reactWithState([empty, '', '', '', true, {}])
  const api3 = definition.factory((name) => (name === 'react' ? react3 : undefined))
  let capturedComponent
  api3.apply({
    ...ctx,
    slots: {
      inject: (key, callback) => callback(),
      register: (options3, component3) => {
        capturedComponent = component3
        return () => {}
      },
    },
  })
  const text = collectText(capturedComponent({ t, close: () => {} }))
  assert.match(text, /没有注册任何 MCP 服务器/u, '空态文案')
  assert.match(text, /dsh-mcp-client/u, '空态给出配置提示')
}

console.log('client-smoke: 全部通过')

/** 把渲染树拍平成文本，便于断言；函数组件就地求值（等价于 React 的渲染阶段）。 */
function collectText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (typeof node.type === 'function') {
    const children = node.children.length === 1 ? node.children[0] : node.children
    return collectText(node.type({ ...node.props, children }))
  }
  return collectText(node.children)
}
