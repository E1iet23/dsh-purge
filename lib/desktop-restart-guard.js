import fs from 'node:fs'
import path from 'node:path'

/** The desktop owns confirmation; a plugin must not confirm or discard its journal. */
export function desktopRestartBarrier(home) {
  if (!home) return { ready: true }
  const journal = path.join(home, 'profiles', 'web', '.generations-pre-migration.json')
  let state
  try {
    state = JSON.parse(fs.readFileSync(journal, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { ready: true }
    return { ready: false, error: '桌面插件迁移状态无法读取，已取消应用和重启；请先在桌面端完成恢复。' }
  }
  if (state.phase === 'confirmed') return { ready: true }
  if (state.phase === 'awaiting-boot') {
    return {
      ready: false,
      waitingForMigration: true,
      error: '桌面端尚未确认插件迁移成功。请保持正常窗口打开至少 60 秒，等待桌面端完成确认后再点应用；本次未修改补丁，也不会结束 Harness。',
    }
  }
  return { ready: false, error: '桌面端正在迁移或回滚插件，已取消应用和重启；请先完成桌面端的恢复流程。' }
}

export function assertDesktopRestartReady(home) {
  const state = desktopRestartBarrier(home)
  if (!state.ready) throw new Error(state.error)
}
