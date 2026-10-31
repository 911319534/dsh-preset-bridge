/**
 * 检查 GitHub 仓库的反馈（星标 / issue / 评论），与基线对比。
 * 公开仓库走未认证 API（api.github.com 不受代理限制，每小时 60 次足够）。
 *
 * 用法：node check-feedback.mjs [--json]
 * 退出码恒为 0；输出 JSON：{ changed, summary, baseline }
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const OWNER = '911319534'
const REPO = 'dsh-preset-bridge'
const STATE = 'C:/Users/HP/.dsh/preset-bridge-feedback.json'

const api = (path) => `https://api.github.com/repos/${OWNER}/${REPO}${path}`

async function get(path) {
  const res = await fetch(api(path), {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-preset-bridge-feedback-check',
    },
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

function saveBaseline(data) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(data, null, 2), 'utf8')
}

async function main() {
  const repo = await get('')
  const rawIssues = await get('/issues?state=all&per_page=100')
  const issues = rawIssues.filter((i) => !i.pull_request)

  const current = {
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.subscribers_count ?? 0,
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      comments: i.comments,
      updatedAt: i.updated_at,
      user: i.user?.login ?? '',
    })),
    checkedAt: new Date().toISOString(),
  }

  const prev = loadBaseline()
  const changes = []

  if (!prev) {
    changes.push(`首次建立基线：${current.stars} 星标、${current.issues.length} 个 issue`)
  } else {
    if (current.stars > prev.stars) changes.push(`新增 ${current.stars - prev.stars} 个星标（共 ${current.stars}）`)
    if (current.stars < prev.stars) changes.push(`星标减少到 ${current.stars}`)

    const prevMap = new Map((prev.issues || []).map((i) => [i.number, i]))
    for (const issue of current.issues) {
      const old = prevMap.get(issue.number)
      if (!old) {
        changes.push(`新 issue #${issue.number}「${issue.title}」by ${issue.user}`)
      } else {
        if (issue.comments > old.comments) {
          changes.push(`issue #${issue.number} 新增 ${issue.comments - old.comments} 条评论`)
        }
        if (issue.state !== old.state) {
          changes.push(`issue #${issue.number} 状态：${old.state} → ${issue.state}`)
        }
      }
    }
  }

  saveBaseline(current)

  const out = {
    changed: changes.length > 0,
    summary: changes.length > 0 ? changes : ['无变化'],
    stars: current.stars,
    issues: current.issues.length,
    url: repo.html_url,
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((error) => {
  console.log(JSON.stringify({ changed: false, error: String(error?.message || error) }, null, 2))
})
