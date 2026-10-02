#!/usr/bin/env node
// pi-handoff entry: re-exec with --experimental-strip-types on Node <22.6 typeless runtimes.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.ts')

if (!process.features.typescript) {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
    },
  )
  process.exit(r.status ?? 1)
} else {
  await import(cliPath)
}
