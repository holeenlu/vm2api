/** Pure response projection for VM seed-settings reads. */
export function projectSeedSettings({
  vmId,
  seedPolicy,
  telemetry = {},
  observed = {},
  telemetryLog,
  telemetryLogError,
} = {}) {
  const payload = {
    vm_id: vmId,
    seed_policy: seedPolicy,
    ...telemetry,
    ...observed,
  }
  if (telemetryLog !== undefined) payload.telemetry_log = telemetryLog
  if (telemetryLogError) payload.telemetry_log_error = telemetryLogError
  return payload
}
