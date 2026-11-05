export async function requestVendorAccount(gw, cookie, body, rawRequest) {
  const draftBody = {
    ...body,
    ...(!body.proxy_id && !body.proxy_endpoint ? { proxy_endpoint: '127.0.0.1:4555:test:example' } : {}),
  }
  const draft = await rawRequest(gw, 'POST', '/api/vendor/account-drafts', cookie, draftBody)
  if (draft.status >= 400) return draft
  if (draft.json.data?.reused) return { ...draft, status: 200 }
  const id = draft.json.data.draft.id
  if (String(draftBody.authorization_kind || '').startsWith('codex_')) {
    const imported = await rawRequest(gw, 'POST', `/api/vendor/account-drafts/${id}/import`, cookie, {
      type: 'codex',
      mode: 'json',
      auth_json: JSON.stringify({
        access_token: 'at-test',
        refresh_token: 'rt-test',
        email: 'codex-test@example.invalid',
        chatgpt_account_id: 'acct-test',
      }),
    })
    return { ...imported, status: imported.status === 200 ? 201 : imported.status }
  }
  const link = await rawRequest(gw, 'POST', `/api/vendor/account-drafts/${id}/oauth/generate-auth-url`, cookie, {
    flavor: 'cai',
  })
  const completed = await rawRequest(gw, 'POST', `/api/vendor/account-drafts/${id}/oauth/exchange-code`, cookie, {
    session_id: link.json.data?.session_id,
    code: 'fake#state',
  })
  return { ...completed, status: completed.status === 200 ? 201 : completed.status }
}
