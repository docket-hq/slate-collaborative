//the purpose of this file is to write a change to the version-sync file in each
//package, so that when we build all three projects move verisons together.
const fs = require('fs')
const data = Date.now()

fs.writeFile('packages/backend/version-sync', data, null, () => {})
fs.writeFile('packages/client/version-sync', data, null, () => {})
fs.writeFile('packages/bridge/version-sync', data, null, () => {})
fs.writeFile('packages/example/version-sync', data, null, () => {})
