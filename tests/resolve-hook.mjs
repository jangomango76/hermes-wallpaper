// The e2e mock server in hermes-agent/tests-js imports zod and js-yaml as bare specifiers; in a
// pnpm checkout they live only in node_modules/.pnpm. Resolve them from there without touching it.
import { register } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const repo = process.env.HERMES_AGENT_DIR ?? '/usr/local/lib/hermes-agent'
const store = path.join(repo, 'node_modules', '.pnpm')
const find = (pkg) => {
  const dir = fs.readdirSync(store).filter((d) => d.startsWith(`${pkg}@`)).sort().pop()
  return dir ? 'file://' + path.join(store, dir, 'node_modules', '_.js') : null
}
const parents = JSON.stringify({ zod: find('zod'), 'js-yaml': find('js-yaml') })
const hook = `const PARENTS = ${parents};
export async function resolve(spec, ctx, next) {
  if (PARENTS[spec]) return next(spec, { ...ctx, parentURL: PARENTS[spec] });
  return next(spec, ctx);
}`
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url)
