import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { absoluteAnchorModule, repairMigratedPresetText, repairDesktopPresetMigration, declarePresetCompat } from '../lib/redteam/desktop-compat.js'
import { apply, installPreset } from '../lib/redteam/index.js'

const presetDir = join(tmpdir(), 'dsh fixture with spaces', 'redteam')
const anchorUrl = JSON.stringify(pathToFileURL(join(presetDir, 'anchor-gate.mjs')).href)
const migrated = '# user configuration\n- id: model\n  config:\n    model: unchanged\n# dsh-desktop legacy presets begin\n- insert:\n    - id: preset-redteam\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: redteam\n        plugins:\n          - id: persona\n            name: persona\n            config:\n              prompt: |\n                KEEP THIS PROMPT {{cwd}}\n                - id: anchor-gate\n                  name: ./anchor-gate.mjs\n          - id: anchor-gate\n            name: ./anchor-gate.mjs\n            config:\n              anchorGate: true\n- insert:\n    - id: preset-another\n      config:\n        plugins:\n          - id: anchor-gate\n            name: ./anchor-gate.mjs\n# dsh-desktop legacy presets end\n# user tail\n'

test('absolute module reference changes only the top-level anchor field', () => {
  const source = '- id: persona\n  config:\n    prompt: |\n      - id: anchor-gate\n        name: ./anchor-gate.mjs\n- id: anchor-gate\n  name: ./anchor-gate.mjs # keep comment\n'
  const expected = source.replace('  name: ./anchor-gate.mjs # keep comment', '  name: ' + anchorUrl + ' # keep comment')
  assert.equal(absoluteAnchorModule(source, presetDir), expected)
  assert.equal(absoluteAnchorModule(expected, presetDir), expected)
})

test('desktop migration repair preserves prompts, other presets and mixed line endings', () => {
  for (const text of [migrated, migrated.replaceAll('\n', '\r\n'), migrated.replace('# user tail\n', '# user tail\r\n')]) {
    const expected = text.replace(/^            name: \.\/anchor-gate\.mjs(?=\r?$)/m, '            name: ' + anchorUrl)
    assert.equal(repairMigratedPresetText(text, presetDir), expected)
    assert.equal(repairMigratedPresetText(expected, presetDir), expected)
  }
  assert.equal(repairMigratedPresetText(migrated.replace('preset-redteam','preset-other'), presetDir), migrated.replace('preset-redteam','preset-other'))
  assert.equal(repairMigratedPresetText(migrated.replace('# dsh-desktop legacy presets end', ''), presetDir), migrated.replace('# dsh-desktop legacy presets end', ''))
})

test('on-disk repair backs up once, is idempotent and keeps all other bytes', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-migration-test-'))
  try {
    const dir = join(home, 'profiles', 'web'); mkdirSync(dir, {recursive:true})
    const file = join(dir, 'cordis.patch.yml'); writeFileSync(file, migrated)
    assert.equal(repairDesktopPresetMigration(home, presetDir), true)
    assert.equal(readFileSync(file + '.dsh-purge-desktop-compat.bak','utf8'), migrated)
    assert.equal(readFileSync(file,'utf8'), repairMigratedPresetText(migrated, presetDir))
    assert.equal(repairDesktopPresetMigration(home, presetDir), false)
    writeFileSync(file, migrated + '# extra\n')
    repairDesktopPresetMigration(home, presetDir)
    assert.equal(readFileSync(file + '.dsh-purge-desktop-compat.bak','utf8'), migrated)
  } finally { rmSync(home, {recursive:true, force:true}) }
})

test('host-owned preset is reused without registering or disposing it', async () => {
  const row = {id:'redteam'}
  const registry = {list:async()=>[row],register:()=>{throw new Error('must not register')}}
  assert.deepEqual(await declarePresetCompat(registry,row), {owned:false})
})

test('plugin-owned preset retains its disposer', async () => {
  const dispose = ()=>{}
  assert.deepEqual(await declarePresetCompat({list:async()=>[],register:async()=>dispose},{id:'redteam'}), {owned:true,dispose})
})

test('desktop declaration starting later retains registration ownership', async () => {
  let reads = 0
  const registry = {list:async()=>++reads < 3 ? [] : [{id:'redteam'}],register:()=>{throw new Error('must not race host')}}
  assert.deepEqual(await declarePresetCompat(registry,{id:'redteam'},{hostManaged:true}),{owned:false})
  await assert.rejects(declarePresetCompat({list:async()=>[],register:()=>{throw new Error('must not register')}},{id:'redteam'},{hostManaged:true,waitForHostMs:0}),/Desktop-managed/)
})

test('a racing host registration is shared and unrelated errors propagate', async () => {
  let listed=0
  const registry={list:async()=>++listed===1?[]:[{id:'redteam'}],register:async()=>{throw new Error('Duplicate agent preset: redteam')}}
  assert.deepEqual(await declarePresetCompat(registry,{id:'redteam'}), {owned:false})
  await assert.rejects(declarePresetCompat({list:async()=>[],register:async()=>{throw new Error('load failed')}},{id:'redteam'}),/load failed/)
})

test('real plugin startup repairs a migrated fixture and shares the host registration', async () => {
  const home=mkdtempSync(join(tmpdir(),'dsh-startup-test-')), previous=process.env.DSH_HOME
  process.env.DSH_HOME=home
  const cleanups=[]
  try {
    installPreset()
    // Settle the existing 1.1.71 preset self-repair before measuring our startup changes.
    installPreset()
    const source=join(home,'.agent-presets','redteam','agent.cordis.yml')
    const preset=readFileSync(source,'utf8')
    assert(preset.includes('name: "file:///'))
    assert(!preset.includes('name: ./anchor-gate.mjs'))
    mkdirSync(join(home,'profiles','web'),{recursive:true})
    writeFileSync(join(home,'profiles','web','cordis.patch.yml'),migrated)
    const registry={list:async()=>[{id:'redteam'}],register:()=>{throw new Error('duplicate registration attempted')}}
    const ctx={agentPresets:registry,effect:fn=>cleanups.push(fn()),provide:()=>{},logger:{info:()=>{},warn:()=>{},error:()=>{}}}
    apply(ctx)
    for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve))
    const status=JSON.parse(readFileSync(join(home,'redteam','preset-declare.json'),'utf8'))
    assert.equal(status.phase,'host-registered');assert.equal(status.ok,true)
    assert.equal(readFileSync(source,'utf8'),preset)
    assert(readFileSync(join(home,'profiles','web','cordis.patch.yml'),'utf8').includes('file:///'))
  } finally {
    for(const cleanup of cleanups)if(typeof cleanup==='function')await cleanup()
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
    rmSync(home,{recursive:true,force:true})
  }
})
