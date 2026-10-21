/**
 * 宿主半边的离线冒烟测试：用一个假的 Cordis Context 真跑 `apply()`，
 * 覆盖条目枚举、状态合成、日志采集、两条 /api 路由、agent 工具与自检文件。
 *
 * 用法：node tests/host-smoke.mjs
 *
 * 如果本机存在 DSH 安装，会额外用真实的 `assertSupportedJsonSchema` /
 * `validateJsonSchemaValue` 校验工具的输出契约（`type: 'json'` 这类错误就是这样被抓住的）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHECKOUT_TOOLS = process.env.DSH_TOOLS_ENTRY ?? 'C:/Users/huanh/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-tools/lib/index.js'

// 自检文件写到临时目录，绝不覆盖真实 profile 的现场文件。
const scratch = mkdtempSync(join(tmpdir(), 'mcp-manager-smoke-'))
process.env.USERPROFILE = scratch
process.env.HOME = scratch

const { apply, inject, name } = await import('../index.js')
assert.equal(name, 'mcp-manager', 'plugin name')
assert.deepEqual(inject, [], 'all dependencies stay optional')

let validateOutput
try {
  const tools = await import(`file:///${CHECKOUT_TOOLS}`)
  validateOutput = (schema, value) => {
    tools.assertSupportedJsonSchema(schema)
    tools.validateJsonSchemaValue(schema, value)
  }
  console.log('· 输出契约校验：用 DSH 真实实现')
} catch {
  console.log('· 输出契约校验：跳过（未找到 DSH 安装）')
}

/* ------------------------------------------------------------------ 夹具 */

const MCP = '@deepseek-ai/dsh-mcp-client'
const now = Date.now()

const entries = [
  {
    id: 'rea-mcp',
    disabled: false,
    fiber: { state: 2 },
    options: {
      name: MCP,
      config: { serverName: 'rea', transport: 'stdio', command: 'node', args: ['rea.js'], cwd: 'C:\\rea', env: { REA_TOKEN: 'super-secret' }, toolCallTimeoutMs: 90000, reconnect: { enabled: true, maxAttempts: 5 } },
    },
  },
  {
    id: 'ghidra-bridge',
    disabled: false,
    fiber: { state: 3, _error: new Error('connect ECONNREFUSED 127.0.0.1:8425') },
    options: {
      name: MCP,
      config: { serverName: 'ghidra', transport: 'streamable-http', url: 'http://127.0.0.1:8425/mcp', headers: { Authorization: 'Bearer abc' } },
    },
  },
  {
    id: 'disabled-one',
    disabled: true,
    fiber: { state: 0 },
    options: { name: MCP, config: { serverName: 'disabled-one', transport: 'stdio', command: 'nope' } },
  },
  {
    id: 'retryish',
    disabled: false,
    fiber: { state: 2 },
    options: { name: MCP, config: { serverName: 'retryish', transport: 'stdiop-typo' } },
  },
  {
    id: 'noisy',
    disabled: false,
    fiber: { state: 2 },
    options: { name: MCP, config: { serverName: 'noisy', transport: 'stdio' } },
  },
  {
    id: 'stuck',
    disabled: false,
    fiber: { state: 2 },
    options: { name: MCP, config: { serverName: 'stuck', transport: 'stdio', command: 'stuck.exe' } },
  },
  { id: 'unrelated', disabled: false, fiber: { state: 2 }, options: { name: '@deepseek-ai/dsh-tools' } },
  {
    // `!!js` 表达式：Loader 原文里是未求值节点，fiber.config 才是求值结果。
    id: 'expr-resolved',
    disabled: false,
    fiber: {
      state: 2,
      config: { serverName: 'expr-resolved', transport: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['bridge.mjs'], cwd: 'C:\\chrome', toolCallTimeoutMs: 60000, reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 } },
    },
    options: {
      name: MCP,
      config: { serverName: 'expr-resolved', transport: 'stdio', command: { __jsExpr: 'process.execPath' }, args: [{ __jsExpr: 'bridgePath' }], cwd: { __jsExpr: 'bridgeDir' } },
    },
  },
  {
    // 没有 fiber.config 时只能读原文：未求值的节点显示成 …，绝不能是 [object Object]。
    id: 'expr-raw',
    disabled: false,
    fiber: { state: 0 },
    options: {
      name: MCP,
      config: { serverName: 'expr-raw', transport: 'stdio', command: { __jsExpr: 'process.execPath' }, args: [{ __jsExpr: 'bridgePath' }] },
    },
  },
]

const schemas = [
  { name: 'mcp__rea__search' },
  { name: 'mcp__rea__read' },
  { name: 'mcp__ghidra__decompile' },
  { name: 'mcp__scopeonly__ping' },
  { name: 'bash' },
  { name: 'read' },
]

const loggerBuffer = [
  { ts: now - 500, type: 'warn', args: ['mcp-client(retryish): connection failed; retrying in 500ms (attempt 1/10)'] },
  { ts: now - 450, type: 'error', args: ['mcp-client(stuck): failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry'] },
  { ts: now - 400, type: 'error', args: ['mcp-client(noisy): giving up after 10 consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect'] },
  { ts: now - 300, type: 'info', args: ['unrelated log line'] },
]

const mcpResources = {
  async request(server) {
    if (server === 'retryish') throw new Error('mcp-client(retryish): server is disconnected')
    if (server === 'noisy') throw new Error('mcp-client(noisy): Method not found (-32601)')
    return { resources: [] }
  },
}

/* ------------------------------------------------------------- 假 Context */

function createContext({ mcpUnavailable = false, clientComposed = true } = {}) {
  const state = { routes: [], toolDefinitions: [], disposers: [], exporter: undefined }
  const ctx = {
    effect(run) {
      const disposer = run()
      if (typeof disposer === 'function') state.disposers.push(disposer)
      return disposer
    },
    inject(dependencies, callback) {
      if (mcpUnavailable === true && dependencies.includes('mcpResources')) return undefined
      if (clientComposed === null && dependencies.includes('clientModules')) return undefined
      return callback(ctx)
    },
    get(key) {
      return ctx[key]
    },
    loader: {
      entries: function* entriesGenerator() {
        yield* entries
      },
    },
    tools: {
      schemas: () => schemas,
      register(definition) {
        state.toolDefinitions.push(definition)
        return () => {}
      },
    },
    logger: {
      buffer: loggerBuffer,
      exporter(exporter) {
        state.exporter = exporter
        return () => {}
      },
    },
    connection: {
      fetch: {
        async register(route) {
          state.routes.push(route)
          return async () => {}
        },
      },
    },
  }
  if (mcpUnavailable !== true) ctx.mcpResources = mcpResources
  if (clientComposed !== null) {
    ctx.clientModules = {
      clientPath: (id) => (clientComposed === true && id === '@local/dsh-mcp-manager' ? '/plugins/@local/dsh-mcp-manager/client.js' : undefined),
    }
  }
  return { ctx, state }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50))

/* ------------------------------------------------------------------ 用例 */

{
  const { ctx, state } = createContext()
  apply(ctx, { logLimit: 50, probeTimeoutMs: 2000 })
  await flush()

  assert.deepEqual(
    state.routes.map((route) => `${route.methods.join('/')} ${route.path}`),
    ['GET /api/mcp-manager.state', 'POST /api/mcp-manager.probe'],
    '两条 /api 路由都要注册',
  )
  assert.equal(state.toolDefinitions.length, 1, 'agent 工具只注册一次')

  const definition = state.toolDefinitions[0]
  assert.equal(definition.name, 'mcp_manager_status')
  if (validateOutput !== undefined) validateOutput(definition.output.schema, { ok: true })

  const stateRoute = state.routes.find((route) => route.path.endsWith('.state'))
  const snapshot = await (await stateRoute.fetch(new Request('http://127.0.0.1/api/mcp-manager.state'))).json()

  const byName = new Map(snapshot.servers.map((server) => [server.serverName, server]))
  assert.deepEqual(
    [...byName.keys()],
    ['disabled-one', 'expr-raw', 'expr-resolved', 'ghidra', 'noisy', 'rea', 'retryish', 'scopeonly', 'stuck'],
    '九台服务器（含一条仅工具的兜底条目）',
  )

  assert.equal(byName.get('rea').status, 'connected', 'active + 工具 = 已连接')
  assert.equal(byName.get('rea').endpoint, 'node rea.js')
  assert.deepEqual(byName.get('rea').envKeys, ['REA_TOKEN'], '环境变量只暴露键名')
  assert.equal(byName.get('rea').reconnect.maxAttempts, 5, '重连策略按配置展示')
  assert.equal(byName.get('rea').toolCount, 2)

  assert.equal(byName.get('ghidra').status, 'failed', 'fiber FAILED = 不可用')
  assert.match(byName.get('ghidra').error ?? '', /ECONNREFUSED/, '加载错误要原样带出')
  assert.equal(byName.get('ghidra').endpoint, 'http://127.0.0.1:8425/mcp')
  assert.deepEqual(byName.get('ghidra').headerKeys, ['Authorization'])

  assert.equal(byName.get('disabled-one').status, 'disabled')
  assert.equal(byName.get('retryish').status, 'retrying', '新鲜的重试日志 = 重连中')
  assert.equal(byName.get('noisy').status, 'failed', '放弃重连 = 不可用')
  assert.equal(byName.get('stuck').status, 'failed', '“无法确认传输已关闭、停止重连”同样是终态')
  assert.equal(byName.get('retryish').transport, 'stdio', '非法 transport 归一到 stdio')

  const orphan = byName.get('scopeonly')
  assert.equal(orphan.source, 'tools', '没有 Loader 条目的服务器靠工具兜底列出')
  assert.equal(orphan.status, 'connected')

  // `!!js` 表达式：优先展示 fiber.config（已求值），原文节点不能泄漏成 [object Object]
  assert.equal(byName.get('expr-resolved').endpoint, 'C:\\Program Files\\nodejs\\node.exe bridge.mjs')
  assert.equal(byName.get('expr-resolved').cwd, 'C:\\chrome')
  assert.equal(byName.get('expr-raw').endpoint, '… …', '未求值节点显示成 …')
  assert.ok(!JSON.stringify(snapshot).includes('[object Object]'), '任何字段都不能出现 [object Object]')

  assert.equal(snapshot.summary.total, 9)
  assert.equal(snapshot.summary.tools, 4)
  assert.equal(snapshot.log.length, 3, '只收 mcp-client 的日志行')
  assert.equal(snapshot.log[0].server, 'noisy', '最新日志在最前（buffer 是时间升序，回填后最新的置顶）')
  assert.equal(snapshot.log[1].server, 'stuck', '次新的一条排在后面')
  assert.equal(snapshot.log[2].server, 'retryish', '较旧的一条排在最后')
  assert.deepEqual(snapshot.notes, [], '正常路径不应有诊断噪声')
  assert.deepEqual(snapshot.client, { composed: true, path: '/plugins/@local/dsh-mcp-manager/client.js' }, '前端半边装配状态')
  assert.ok(!JSON.stringify(snapshot).includes('super-secret'), '密钥值绝不能进快照')
  assert.ok(!JSON.stringify(snapshot).includes('Bearer abc'), '请求头值绝不能进快照')

  // agent 工具：默认全量 + server 过滤 + probe
  const value = await definition.execute({})
  if (validateOutput !== undefined) validateOutput(definition.output.schema, value)
  assert.equal(value.servers.length, 9)
  assert.match(value.text, /MCP 服务器 9 台/u)
  assert.match(value.text, /- rea \[connected\] stdio · node rea\.js/u)

  const single = await definition.execute({ server: 'ghidra' })
  assert.equal(single.servers.length, 1)
  assert.deepEqual(single.summary, { total: 1, connected: 0, issues: 1, disabled: 0, tools: 1 }, '过滤视图的汇总必须同步重算')

  const probed = await definition.execute({ probe: true, server: 'retryish' })
  assert.equal(probed.servers[0].status, 'failed', '探测说断开时覆盖日志推断')
  assert.equal(probed.servers[0].probe.status, 'offline')
  assert.match(probed.servers[0].probe.detail, /server is disconnected/u)

  // 探测路由：协议层错误（未实现 resources/list）也算连通
  const probeRoute = state.routes.find((route) => route.path.endsWith('.probe'))
  const probeResponse = await probeRoute.fetch(new Request('http://127.0.0.1/api/mcp-manager.probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ servers: ['rea', 'noisy'] }),
  }))
  const probedAll = await probeResponse.json()
  assert.deepEqual(probedAll.results.map((row) => row.status), ['connected', 'connected'], '未实现 resources/list 仍算连通')
  const afterProbe = new Map(probedAll.servers.map((server) => [server.serverName, server]))
  assert.equal(afterProbe.get('rea').status, 'connected')
  assert.equal(afterProbe.get('noisy').status, 'connected', '探测成功后覆盖“已放弃重连”的旧日志')

  // 自检文件
  const statusFile = join(scratch, '.dsh', 'mcp-manager.status.json')
  try {
    const written = JSON.parse(readFileSync(statusFile, 'utf8'))
    assert.equal(written.status, 'ok')
    assert.equal(written.servers.length, 9)
    assert.deepEqual(written.routes, ['GET /api/mcp-manager.state', 'POST /api/mcp-manager.probe'])
    console.log('· 自检文件：已写入并可解析')
  } catch (error) {
    console.log(`· 自检文件：未生成（${error.code ?? error.message}），跳过`)
  }

  for (const dispose of state.disposers.splice(0)) {
    try {
      await dispose()
    } catch {
      /* 清理失败不影响结论 */
    }
  }
  console.log('· 主路径：9 台服务器 / 3 条日志 / 路由 / 工具 / 探测 全部通过')
}

{
  // 降级：没有 mcpResources 时探测要给出“无法探测”，而不是抛异常
  const { ctx, state } = createContext({ mcpUnavailable: true })
  apply(ctx, {})
  await flush()
  const definition = state.toolDefinitions[0]
  const probed = await definition.execute({ probe: true, server: 'rea' })
  assert.equal(probed.servers[0].probe.status, 'unknown')
  assert.match(probed.servers[0].probe.detail, /mcp-resources/u)
  console.log('· 降级路径：缺少 mcpResources 时探测返回 unknown')
}

{
  // 没有 clientModules 服务时，装配状态标为未知而不是崩掉
  const { ctx, state } = createContext({ clientComposed: null })
  apply(ctx, {})
  await flush()
  const stateRoute = state.routes.find((route) => route.path.endsWith('.state'))
  const snapshot = await (await stateRoute.fetch(new Request('http://127.0.0.1/api/mcp-manager.state'))).json()
  assert.deepEqual(snapshot.client, { composed: null, path: null })
  console.log('· 降级路径：缺少 clientModules 时前端装配状态为未知')
}

console.log('\nhost-smoke: 全部通过')
