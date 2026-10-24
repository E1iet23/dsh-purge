import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Only rewrite the module field of the anchor-gate row, never literal prompt text. */
export function absoluteAnchorModule(text, presetDir, rowIndent = 0) {
  const lines = String(text).split(/(\r?\n)/)
  const url = JSON.stringify(pathToFileURL(join(presetDir, 'anchor-gate.mjs')).href)
  for (let i = 0; i < lines.length; i += 2) {
    const row = /^(\s*)- id: anchor-gate\s*(?:#.*)?$/.exec(lines[i])
    if (!row || row[1].length !== rowIndent) continue
    const indent = row[1].length
    for (let j = i + 2; j < lines.length; j += 2) {
      const line = lines[j]
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const fieldIndent = /^\s*/.exec(line)[0].length
      if (fieldIndent <= indent) break
      if (fieldIndent !== indent + 2) continue
      const field = /^(\s*name:\s*)(?:\.\/anchor-gate\.mjs|'\.\/anchor-gate\.mjs'|"\.\/anchor-gate\.mjs")(\s*(?:#.*)?)$/.exec(line)
      if (field) lines[j] = field[1] + url + field[2]
    }
  }
  return lines.join('')
}

/** Desktop 0.12 imports .agent-presets into a profile without rebasing relative names. */
export function repairMigratedPresetText(text, presetDir) {
  const startMark = '# dsh-desktop legacy presets begin'
  const endMark = '# dsh-desktop legacy presets end'
  const start = text.indexOf(startMark), end = text.indexOf(endMark, start)
  if (start < 0 || end < start) return text
  const section = text.slice(start, end)
  // Scope the repair to the desktop-generated redteam entry. Other presets are untouched.
  const row = /^    - id: preset-redteam\s*\r?$/m.exec(section)
  if (!row) return text
  const after = section.slice(row.index + row[0].length)
  const boundary = /^(?:- |    - id:)/m.exec(after)
  const stop = boundary ? row.index + row[0].length + boundary.index : section.length
  const entry = section.slice(row.index, stop)
  const plugins = /^( *)plugins:\s*\r?$/m.exec(entry)
  if (!plugins) return text
  const repaired = absoluteAnchorModule(entry, presetDir, plugins[1].length + 2)
  return text.slice(0, start) + section.slice(0, row.index) + repaired + section.slice(stop) + text.slice(end)
}

/** Repair just our generated module path, preserving the first backup and all other bytes. */
export function repairDesktopPresetMigration(home, presetDir) {
  const file = join(home, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(file)) return false
  const before = readFileSync(file, 'utf8')
  const after = repairMigratedPresetText(before, presetDir)
  if (after === before) return false
  const backup = file + '.dsh-purge-desktop-compat.bak'
  try { writeFileSync(backup, before, { encoding: 'utf8', flag: 'wx' }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const temporary = `${file}.dsh-purge-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(temporary, after, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* no temporary file */ }
    throw error
  }
  return true
}

export function desktopOwnsPreset(home) {
  const file = join(home, 'profiles', 'web', 'cordis.patch.yml')
  if (!existsSync(file)) return false
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf('# dsh-desktop legacy presets begin')
  const end = text.indexOf('# dsh-desktop legacy presets end', start)
  return start >= 0 && end > start && /^    - id: preset-redteam\s*\r?$/m.test(text.slice(start, end))
}

/** A desktop-migrated declaration belongs to the desktop, not this plugin's disposer. */
export async function declarePresetCompat(registry, definition, options = {}) {
  const existing = async () => typeof registry.list === 'function'
    ? (await registry.list()).find(row => row.id === definition.id)
    : undefined
  if (await existing()) return { owned: false }
  if (options.hostManaged) {
    // The declaring profile row can start after the bundle. Never race it to register().
    const deadline = Date.now() + (options.waitForHostMs ?? 5000)
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (await existing()) return { owned: false }
    }
    throw new Error('Desktop-managed redteam preset has not registered; inspect the profile preset row')
  }
  try {
    return { owned: true, dispose: await registry.register(definition) }
  } catch (error) {
    // Another declaring plugin may register while our asynchronous roster check is pending.
    if (error?.message === `Duplicate agent preset: ${definition.id}` && await existing()) {
      return { owned: false }
    }
    throw error
  }
}
