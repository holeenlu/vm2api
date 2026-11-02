import fs from 'node:fs'
import { corsHeadersForRequest } from '../http/cors.mjs'
import { backupConfigSnapshot, backupDownloadSnapshot, backupListSnapshot } from './ops/backup-query.mjs'
import { createManualBackup, removeBackup, restoreBackup, updateBackupSchedule } from './ops/backup-command.mjs'

/** Backup listing, scheduling, download, restore and deletion routes. */
export function createPanelBackupRoutes({ backupService, apiKeyStore, json, readBody }) {
  const respond = (...args) => {
    json(...args)
    return true
  }

  return async function handlePanelBackups(req, res, path) {
    if (req.method === 'GET' && path === '/api/panel/backups') {
      return respond(res, 200, { ok: true, ...backupListSnapshot(backupService) })
    }

    if (req.method === 'POST' && path === '/api/panel/backups') {
      try {
        const rec = await createManualBackup(backupService)
        return respond(res, 201, { ok: true, item: rec })
      } catch (e) {
        const status = e.code === 'backup_in_progress' ? 409 : 500
        return respond(res, status, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'backup_failed' },
        })
      }
    }

    if (req.method === 'GET' && path === '/api/panel/backups/config') {
      return respond(res, 200, { ok: true, ...backupConfigSnapshot(backupService) })
    }

    if (req.method === 'PUT' && path === '/api/panel/backups/config') {
      const body = await readBody(req, 8192).catch(() => ({}))
      try {
        const config = updateBackupSchedule(backupService, body)
        return respond(res, 200, { ok: true, config, next_auto_at: backupService.nextAutoAt() })
      } catch (e) {
        return respond(res, 400, { ok: false, error: { message: String(e.message || e), code: e.code } })
      }
    }

    if (req.method === 'GET' && /^\/api\/panel\/backups\/[^/]+\/download$/.test(path)) {
      const id = path.split('/')[4]
      const downloaded = backupDownloadSnapshot(backupService, id, fs)
      if (!downloaded) {
        return respond(res, 404, { ok: false, error: { message: 'backup file not found' } })
      }
      const { record: rec, size } = downloaded
      res.writeHead(
        200,
        corsHeadersForRequest(req, {
          'content-type': 'application/gzip',
          'content-length': size,
          'content-disposition': `attachment; filename="${rec.file_name}"`,
          'x-kin-backup-sha256': rec.sha256 || '',
          'access-control-expose-headers': 'content-disposition, x-kin-backup-sha256',
        }),
      )
      fs.createReadStream(rec.file_path).pipe(res)
      return true
    }

    if (req.method === 'POST' && /^\/api\/panel\/backups\/[^/]+\/restore$/.test(path)) {
      const id = path.split('/')[4]
      const body = await readBody(req, 4096).catch(() => ({}))
      if (body?.confirm !== true) {
        return respond(res, 400, {
          ok: false,
          error: { message: 'restore requires {"confirm": true}', code: 'confirm_required' },
        })
      }
      try {
        if (apiKeyStore.inflight.size)
          return respond(res, 409, {
            ok: false,
            error: { code: 'requests_inflight', message: '存在在途请求，请等待请求结束后再恢复备份' },
          })
        const out = await restoreBackup(backupService, id)
        return respond(res, 200, { ok: true, ...out })
      } catch (e) {
        const map = {
          backup_not_found: 404,
          backup_file_missing: 404,
          restore_in_progress: 409,
          backup_corrupt: 422,
          backup_not_ok: 422,
        }
        return respond(res, map[e.code] || 500, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'restore_failed' },
        })
      }
    }

    if (req.method === 'DELETE' && /^\/api\/panel\/backups\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      if (!removeBackup(backupService, id))
        return respond(res, 404, { ok: false, error: { message: 'backup not found' } })
      return respond(res, 200, { ok: true, deleted: id })
    }

    return false
  }
}
