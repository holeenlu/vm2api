export async function backupListSnapshot(service) {
  return {
    items: await service.list(),
    config: service.getSchedule(),
    next_auto_at: await service.nextAutoAt(),
    restoring: service.isRestoring,
  }
}

export async function backupConfigSnapshot(service) {
  return { config: service.getSchedule(), next_auto_at: await service.nextAutoAt() }
}

export async function backupDownloadSnapshot(service, id, fs) {
  const record = await service.get(id)
  if (!record || !record.file_path || !fs.existsSync(record.file_path)) return null
  return { record, size: fs.statSync(record.file_path).size }
}
