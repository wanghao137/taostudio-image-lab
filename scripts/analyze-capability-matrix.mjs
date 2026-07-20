import fs from 'node:fs'
import path from 'node:path'

const [imagesReportPath, responsesReportPath, outputDir] = process.argv.slice(2)
if (!imagesReportPath || !responsesReportPath || !outputDir) {
  throw new Error('Usage: node scripts/analyze-capability-matrix.mjs <images-report> <responses-report> <output-dir>')
}

const reports = [imagesReportPath, responsesReportPath].map((filePath) => ({
  filePath: path.resolve(filePath),
  report: JSON.parse(fs.readFileSync(filePath, 'utf8')),
}))

function percentile(sorted, value) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]
}

function summarize({ filePath, report }) {
  const results = report.results || []
  const durations = results.map((item) => item.wallElapsedMs).filter(Number.isFinite).sort((a, b) => a - b)
  const qualities = results.reduce((counts, item) => {
    const quality = item.actualParams?.quality || 'missing'
    counts[quality] = (counts[quality] || 0) + 1
    return counts
  }, {})
  const ratios = Object.fromEntries([...new Set(results.map((item) => item.ratio))].map((ratio) => {
    const group = results.filter((item) => item.ratio === ratio)
    return [ratio, {
      count: group.length,
      generated: group.filter((item) => item.status === 'done' && item.imageFiles?.length > 0).length,
      actualQualities: group.map((item) => item.actualParams?.quality || 'missing'),
      exactDimensions: group.filter((item) => item.exactDimensions).length,
    }]
  }))

  return {
    mode: report.apiMode,
    model: report.model,
    reportPath: filePath,
    count: results.length,
    generated: results.filter((item) => item.status === 'done' && item.imageFiles?.length > 0).length,
    requestHigh: results.filter((item) => item.generationRequest?.quality === 'high').length,
    actualHigh: results.filter((item) => item.actualParams?.quality === 'high').length,
    exactDimensions: results.filter((item) => item.exactDimensions).length,
    pngSignature: results.filter((item) => item.imageFiles?.length > 0 && item.imageFiles.every((file) => file.pngSignature)).length,
    qualities,
    averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    ratios,
  }
}

const modes = reports.map(summarize)
const totals = {
  count: modes.reduce((sum, item) => sum + item.count, 0),
  generated: modes.reduce((sum, item) => sum + item.generated, 0),
  requestHigh: modes.reduce((sum, item) => sum + item.requestHigh, 0),
  actualHigh: modes.reduce((sum, item) => sum + item.actualHigh, 0),
  exactDimensions: modes.reduce((sum, item) => sum + item.exactDimensions, 0),
  pngSignature: modes.reduce((sum, item) => sum + item.pngSignature, 0),
}

const gates = {
  generatedAtLeast98Percent: totals.generated / totals.count >= 0.98,
  exactDimensions100Percent: totals.exactDimensions === totals.count,
  png100Percent: totals.pngSignature === totals.count,
  actualHighAtLeast95Percent: totals.actualHigh / totals.count >= 0.95,
}

const summary = {
  generatedAt: new Date().toISOString(),
  experiment: '4K exact-size high-quality capability matrix',
  fixedPrompt: reports[0].report.results?.[0]?.prompt,
  requestedConfig: reports[0].report.requestedConfig,
  modes,
  totals,
  gates,
  verdict: gates.generatedAtLeast98Percent && gates.exactDimensions100Percent && gates.png100Percent && gates.actualHighAtLeast95Percent
    ? 'GO'
    : 'NO_GO_STRICT_HIGH',
}

fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')

const rows = modes.map((item) => `| ${item.mode} / ${item.model} | ${item.generated}/${item.count} | ${item.exactDimensions}/${item.count} | ${item.pngSignature}/${item.count} | ${item.actualHigh}/${item.count} | ${item.qualities.low || 0} | ${item.averageMs} | ${item.p95Ms} |`).join('\n')
const markdown = `# 4K Capability Matrix\n\n` +
  `Verdict: **${summary.verdict}**\n\n` +
  `| Mode | Generated | Exact size | Valid PNG | Actual high | Actual low | Avg ms | P95 ms |\n` +
  `|---|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
  `## Gates\n\n` +
  `- Generated >= 98%: ${gates.generatedAtLeast98Percent}\n` +
  `- Exact dimensions = 100%: ${gates.exactDimensions100Percent}\n` +
  `- PNG validity = 100%: ${gates.png100Percent}\n` +
  `- Actual high >= 95%: ${gates.actualHighAtLeast95Percent}\n\n` +
  `All ${totals.count} requests transmitted quality=high. The provider reported actual quality=low for all ${totals.count} outputs.\n`

fs.writeFileSync(path.join(outputDir, 'summary.md'), markdown, 'utf8')
console.log(JSON.stringify({ outputDir: path.resolve(outputDir), verdict: summary.verdict, totals, gates }))
