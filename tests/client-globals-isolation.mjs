/**
 * 客户端插件「全局词法作用域」隔离测试。
 *
 * 客户端插件是经典脚本（不是 ESM），同一页面里所有插件共用**同一个全局词法作用域**：
 * 任一插件顶层的 `const`/`let`（ROUTE、DICT、CSS…）都会变成全局绑定，后加载的同名
 * 声明会抛 `SyntaxError: Identifier 'xxx' has already been declared`，把那个插件的
 * 整段脚本打挂 —— 浏览器里表现为 `plugins/?? loaded without registering "<包名>"`。
 *
 * 本测试用 vm 复现真实浏览器的多脚本环境，断言：
 * 1. 本插件无论独立加载、还是与钉钉插件任意先后顺序，都不报错；
 * 2. 本插件不向全局词法作用域泄漏任何名字（钉钉会泄漏，所以它必须在对比里体现）。
 *
 * 用法：node tests/client-globals-isolation.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const MINE = fileURLToPath(new URL('../client.js', import.meta.url))

/** 对照用的手写客户端插件；可用环境变量覆盖，找不到就跳过对比段而不是失败。 */
const PEER = process.env.DSH_PEER_CLIENT
  ?? join(process.env.DSH_PROFILE_DIR ?? 'C:/Users/huanh/.dsh/profiles/web', 'node_modules/@local/dsh-dingtalk-notify/client.js')
const HAS_PEER = existsSync(PEER)

/** 造一个“干净页面”：只有浏览器里 client 插件会碰到的全局。 */
function createPage() {
  const registrations = []
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (definition) => registrations.push(definition) } },
    document: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, addEventListener() {}, appendChild() {} }),
      head: { appendChild() {} },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => new Response('{}'),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  return { context, registrations }
}

function runScript(context, path, label) {
  try {
    vm.runInContext(readFileSync(path, 'utf8'), context, { filename: path })
    return { ok: true, label }
  } catch (error) {
    return { ok: false, label, error: `${error.name}: ${error.message}` }
  }
}

/** 全局词法作用域里是否出现了某个名字（`typeof` 对未声明返回 "undefined"）。 */
function globalNames(context, names) {
  return names.filter((name) => vm.runInContext(`typeof ${name} !== "undefined"`, context))
}

const MINE_TOP_LEVEL_NAMES = ['ROUTE', 'AUTO_REFRESH_MS', 'React', 'DICT', 'CSS', 'api', 'timeLabel', 'msLabel', 'statusInfo', 'probeInfo', 'clientLabel', 'ServerCard', 'Page']

/* 1) 独立加载：必须成功，且一个名字都不泄漏 */
{
  const { context, registrations } = createPage()
  const result = runScript(context, MINE, 'mcp-manager')
  assert.equal(result.ok, true, `独立加载失败：${result.error ?? ''}`)
  assert.equal(registrations.length, 1, '必须注册一个模块')
  assert.equal(registrations[0].id, '@local/dsh-mcp-manager')
  const leaked = globalNames(context, MINE_TOP_LEVEL_NAMES)
  assert.deepEqual(leaked, [], `顶层声明泄漏到全局词法作用域：${leaked.join(', ')}`)
  console.log('· 独立加载：成功，且不泄漏任何全局绑定')
}

/* 2) 与另一支手写客户端插件共存：两种加载顺序都必须成功 */
if (!HAS_PEER) {
  console.log(`· 跳过共存对比：找不到对照插件 ${PEER}（可用 DSH_PEER_CLIENT 指定）`)
} else {
  for (const [first, firstPath, second, secondPath] of [
    ['peer', PEER, 'mcp-manager', MINE],
    ['mcp-manager', MINE, 'peer', PEER],
  ]) {
    const { context, registrations } = createPage()
    const a = runScript(context, firstPath, first)
    assert.equal(a.ok, true, `${first} 先加载失败：${a.error ?? ''}`)
    const b = runScript(context, secondPath, second)
    assert.equal(b.ok, true, `${first} → ${second} 时后者失败：${b.error ?? ''}`)
    const ids = registrations.map((definition) => definition.id).sort()
    assert.equal(ids.length, 2, '两个模块都要注册')
    assert.ok(ids.includes('@local/dsh-mcp-manager'), '本插件注册成功')
    console.log(`· 顺序 ${first} → ${second}：两个插件都正常加载`)
  }
}

console.log('\nclient-globals-isolation: 全部通过')
