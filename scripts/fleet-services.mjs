import { runFleetUpdate } from '../src/lib/vm/fleet-update.mjs'

const root = process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/tapmodels'
const concurrency = Number(process.argv[3] || 4)
const report = await runFleetUpdate(root, {
  action: 'telemetry',
  concurrency,
})
console.log(JSON.stringify(report))
if (report.failed_count) process.exit(1)
