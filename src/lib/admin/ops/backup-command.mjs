export function createManualBackup(service) {
  return service.createBackup({ kind: 'manual' })
}

export function updateBackupSchedule(service, body) {
  return service.updateSchedule(body || {})
}

export function restoreBackup(service, id) {
  return service.restoreBackup(id)
}

export function removeBackup(service, id) {
  return service.remove(id)
}
