export async function createManualBackup(service) {
  return service.createBackup({ kind: 'manual' })
}

export async function updateBackupSchedule(service, body) {
  return service.updateSchedule(body || {})
}

export async function restoreBackup(service, id) {
  return service.restoreBackup(id)
}

export async function removeBackup(service, id) {
  return service.remove(id)
}
