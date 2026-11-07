/** Stable, redacted proxy binding facts for adapters and tests. */
export function proxyBindingOfVm(vm = {}) {
  const proxy = vm?.proxy && typeof vm.proxy === 'object' ? vm.proxy : null
  return Object.freeze({
    vm_id: vm?.id || null,
    proxy_id: proxy?.id || null,
    mode: proxy?.kind || proxy?.scheme || (proxy ? 'proxy' : 'none'),
    endpoint: proxy?.host ? `${proxy.host}${proxy.port ? `:${proxy.port}` : ''}` : null,
    enabled: proxy ? proxy.enabled !== false : false,
    local_egress: proxy?.kind === 'local' || proxy?.scheme === 'local',
  })
}
