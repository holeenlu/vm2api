export function backupListSnapshot(service) {
  return {
    items: service.list(),
    config: service.getSchedule(),
    next_auto_at: service.nextAutoAt(),
    restoring: service.isRestoring,
  }
}

export function backupConfigSnapshot(service) {
  return { config: service.getSchedule(), next_auto_at: service.nextAutoAt() }
}

export function backupDownloadSnapshot(service, id, fs) {
  const record = service.get(id)
  if (!record || !record.file_path || !fs.existsSync(record.file_path)) return null
  return { record, size: fs.statSync(record.file_path).size }
}
