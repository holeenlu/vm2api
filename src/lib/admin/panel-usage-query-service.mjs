import { UsageLogsView } from '../db/repos/usage-logs-view.mjs'
import { getDb } from '../db/database.mjs'

/** Query adapter for the keyset usage-log surface. */
export function createPanelUsageQueryService({ db, mutedErrorClasses } = {}) {
  const view = () => new UsageLogsView(db || getDb(), { mutedErrorClasses })
  return Object.freeze({
    listBatch: (filters) => view().listBatch(filters),
    ranking: (filters, scope) => view().ranking(filters, scope),
    summary: (filters) => view().summary(filters),
    filterOptions: (filters) => view().filterOptions(filters),
    sessionSuggestions: (filters) => view().sessionSuggestions(filters),
    activeSessions: (filters) => view().activeSessions(filters),
    overview: (filters) => view().overview(filters),
    exportRows: (filters) => view().exportRows(filters),
  })
}
