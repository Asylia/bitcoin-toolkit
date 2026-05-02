#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const packages = [
  '@asylia/btc-core',
  '@asylia/blockchain-data-btc',
  '@asylia/hw-ledger',
  '@asylia/hw-trezor',
]

for (const workspace of packages) {
  process.stdout.write('Checking npm package contents for ' + workspace + '\n')

  const result = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json', '--workspace', workspace],
    { stdio: 'inherit' },
  )

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
