#!/usr/bin/env node
/**
 * 仓库敏感信息扫描器。
 *
 * 用法：
 *   node scripts/scan-secrets.mjs                    扫描整个工作区（跳过 .git / node_modules / dist 等）
 *   node scripts/scan-secrets.mjs a.js b.json        只扫描指定文件
 *   node scripts/scan-secrets.mjs --from-file list   扫描清单文件里的路径（pre-commit 钩子这样调用）
 *
 * 设计约束：**不 spawn 任何子进程**。DSH 的沙箱下 Node 通过管道抓子进程输出会 EPERM，
 * 所以文件列表一律由参数或自身 fs 遍历得到，git 只在外层钩子里使用。
 *
 * 命中即 exit 1，并只回显值的头 4 个字符（避免把密钥又抄进终端日志）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache', '.learn', 'generate'])
const MAX_BYTES = 2 * 1024 * 1024
const MAX_LINE = 400

/** 明确是假值/占位符的取值，避免把测试夹具误报成密钥。 */
const FAKE_VALUES = [
  'super-secret', 'super-secret-value', 'secret-value', 'example', 'changeme', 'placeholder', 'dummy',
  'test', 'forbidden', 'unauthorized', 'not found', 'redacted', 'undefined', 'null', 'true', 'false',
]

/** 高置信度特征（无需再看上下文）。 */
const HARD_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/u },
  { id: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { id: 'dingtalk-webhook-token', re: /access_token=[0-9a-f]{32,}/u },
  { id: 'launch-token-url', re: /[?&]token=[A-Za-z0-9_-]{16,}/u },
]

/** 形如 `password: "<值>"` 的赋值：值还要过“像真凭据”的判定，避免误伤文档与夹具。 */
const ASSIGNMENT = /(api[_-]?key|secret|token|password|passwd|pwd|credential|private[_-]?key)["']?\s*[:=]\s*["']?([^\s"',;)\]}]{8,})/iu

/** 一个值是否“像真凭据”：够长、字母数字混合、不在假值表里。 */
function looksRealCredential(value) {
  if (value.length < 20) return false
  if (!/[A-Za-z]/u.test(value) || !/[0-9]/u.test(value)) return false
  const lower = value.toLowerCase()
  return !FAKE_VALUES.some((fake) => lower.includes(fake))
}

/** 只回显头 4 个字符，其余打码。 */
function redact(value) {
  return value.length <= 4 ? '***' : `${value.slice(0, 4)}${'*'.repeat(Math.min(12, value.length - 4))}`
}

function isBinary(buffer) {
  const probe = buffer.subarray(0, 8192)
  for (const byte of probe) if (byte === 0) return true
  return false
}

/** 解析命令行：支持 `--from-file <清单>`（NUL 或换行分隔）与直接给路径。 */
function targets() {
  const argv = process.argv.slice(2)
  const listIndex = argv.indexOf('--from-file')
  if (listIndex !== -1 && argv[listIndex + 1] !== undefined) {
    let list
    try {
      list = readFileSync(join(ROOT, argv[listIndex + 1])) ?? readFileSync(argv[listIndex + 1])
    } catch {
      try {
        list = readFileSync(argv[listIndex + 1])
      } catch {
        console.error('scan-secrets: 读不到文件清单，按全量扫描处理')
        return []
      }
    }
    return list.toString('utf8').split(/\0|\r?\n/u).map((path) => path.trim()).filter((path) => path !== '')
  }
  return argv.filter((value) => value !== '')
}

/** 递归收集待扫描文件。 */
function collect(targets) {
  if (targets.length > 0) return targets.map((path) => join(ROOT, path))
  const files = []
  const walk = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(directory, entry.name))
        continue
      }
      if (entry.isFile()) files.push(join(directory, entry.name))
    }
  }
  walk(ROOT)
  return files
}

const findings = []
for (const file of collect(targets())) {
  let info
  try {
    info = statSync(file)
  } catch {
    continue
  }
  if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES) continue
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    continue
  }
  if (isBinary(buffer)) continue
  const text = buffer.toString('utf8')
  const lines = text.split(/\r?\n/u)
  lines.forEach((line, index) => {
    if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE)
    let matched = false
    for (const pattern of HARD_PATTERNS) {
      const match = pattern.re.exec(line)
      if (match === null) continue
      findings.push({ file, line: index + 1, id: pattern.id, sample: redact(match[0]) })
      matched = true
    }
    // 同一行已经被高置信度规则命中过，就不再重复报“赋值”规则，减少噪声。
    if (matched) return
    const assignment = ASSIGNMENT.exec(line)
    if (assignment !== null && looksRealCredential(assignment[2])) {
      findings.push({ file, line: index + 1, id: 'credential-assignment', sample: redact(assignment[2]) })
    }
  })
}

if (findings.length === 0) {
  console.log('scan-secrets: 未发现敏感信息')
  process.exit(0)
}

console.error(`scan-secrets: 发现 ${findings.length} 处疑似敏感信息`)
for (const finding of findings) {
  const path = relative(ROOT, finding.file).split(sep).join('/')
  console.error(`  ${path}:${finding.line}  [${finding.id}]  ${finding.sample}`)
}
console.error('\n请删除/替换后再提交；确属假值请加入 scripts/scan-secrets.mjs 的 FAKE_VALUES。')
process.exit(1)
