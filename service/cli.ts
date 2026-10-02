import { runCli } from './commands.ts'

try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`pi-handoff: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
