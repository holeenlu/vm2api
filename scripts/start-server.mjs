import { prepareRuntimeSecrets } from '../src/lib/core/runtime-secrets.mjs'
prepareRuntimeSecrets()
await import('../src/server.mjs')
