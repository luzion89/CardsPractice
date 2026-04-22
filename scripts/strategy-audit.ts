import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { simulateStrategyGames, type StrategyDiagnosticTag } from '../src/lib/guandan/strategyReport'

type AuditSample = {
  seed: number
  actionIndex: number
  seat: string
  tag: StrategyDiagnosticTag
  message: string
  note: string
}

function timestampLabel(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function main() {
  const count = Math.max(1, Number.parseInt(process.argv[2] ?? '60', 10) || 60)
  const baseSeed = Number.parseInt(process.argv[3] ?? String(Date.now()), 10) || Date.now()
  const seeds = Array.from({ length: count }, (_, index) => baseSeed + index)
  const report = simulateStrategyGames(seeds)
  const generatedAt = new Date()

  const samplesByTag: Partial<Record<StrategyDiagnosticTag, AuditSample[]>> = {}
  for (const gameReport of report.games) {
    for (const diagnostic of gameReport.diagnostics) {
      const bucket = samplesByTag[diagnostic.tag] ?? []
      if (bucket.length >= 5) {
        continue
      }

      const action = gameReport.game.actions[diagnostic.actionIndex]
      bucket.push({
        seed: gameReport.game.seed,
        actionIndex: diagnostic.actionIndex,
        seat: diagnostic.seat,
        tag: diagnostic.tag,
        message: diagnostic.message,
        note: action?.note ?? '无动作说明',
      })
      samplesByTag[diagnostic.tag] = bucket
    }
  }

  const payload = {
    generatedAt: generatedAt.toISOString(),
    count,
    baseSeed,
    seeds,
    summary: report.summary,
    samplesByTag,
    games: report.games,
  }

  const outputDir = path.resolve(process.cwd(), 'debug/strategy-audits')
  await mkdir(outputDir, { recursive: true })

  const latestPath = path.join(outputDir, 'latest.json')
  const stampedPath = path.join(outputDir, `${timestampLabel(generatedAt)}.json`)
  const content = `${JSON.stringify(payload, null, 2)}\n`

  await writeFile(latestPath, content, 'utf8')
  await writeFile(stampedPath, content, 'utf8')

  console.log(`Strategy audit saved to ${latestPath}`)
  console.log(`Timestamped copy saved to ${stampedPath}`)
  console.log(JSON.stringify(report.summary, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})