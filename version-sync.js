//the purpose of this file is to write a change to the version-sync file in each
//package, so that when we build all three projects move verisons together.
const fs = require('fs')
const { execSync } = require('child_process')
const data = Date.now()

fs.writeFileSync('packages/backend/version-sync', data)
fs.writeFileSync('packages/client/version-sync', data)
fs.writeFileSync('packages/bridge/version-sync', data)
fs.writeFileSync('packages/example/version-sync', data)

execSync('git add packages/backend/version-sync')
execSync('git add packages/client/version-sync')
execSync('git add packages/bridge/version-sync')
execSync('git add packages/example/version-sync')
execSync('git commit -m "docs: version-sync"')
