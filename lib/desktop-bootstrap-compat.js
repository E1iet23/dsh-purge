/** Preserve packaged Office assets after app.asar has been unpacked to app/. */
export function patchDesktopBootstrap(text) {
  const marker = '// [dsh-purge] keep packaged Office assets after unpack'
  if (text.includes(marker)) return { changed: false, text, already: true }
  const pattern = /process\.env\.DSH_DESKTOP_OFFICE_RESOURCES = archive(\r?\n)([ \t]*)\? join\(resources, 'office-runtime'\)\r?\n[ \t]*: join\(resources, '\.\.', '\.build', 'office-runtime'\)/
  if (!pattern.test(text)) return { changed: false, text }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const importLine = "import { existsSync as dshPurgeAssetExists } from 'node:fs'"
  let next = text.replace(pattern, (_all, nl, indent) => (
    marker + nl + indent + "process.env.DSH_DESKTOP_OFFICE_RESOURCES = (archive || dshPurgeAssetExists(join(resources, 'office-runtime', 'primary-runtime', 'runtime.json')))" + nl
    + indent + "? join(resources, 'office-runtime')" + nl
    + indent + ": join(resources, '..', '.build', 'office-runtime')"
  ))
  next = importLine + newline + next
  return { changed: true, text: next }
}
