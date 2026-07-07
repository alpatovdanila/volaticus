// One-off: rewrite inventory JSONs through the canonical stringifier
// (fixes files mangled by external tools). Usage: npx tsx scripts/reformat.ts <files...>
import fs from 'node:fs'
import { stringifyPretty } from '../src/inventory/json'

for (const f of process.argv.slice(2)) {
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'))
  fs.writeFileSync(f, stringifyPretty(doc))
  console.log('reformatted', f)
}
