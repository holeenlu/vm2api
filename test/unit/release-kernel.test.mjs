import test from 'node:test'
import assert from 'node:assert/strict'
import {
  downloadReleaseKernel,
  isAllowedKernelUrl,
  selectKernelAsset,
  selectCliNodeAsset,
} from '../../src/lib/admin/release-kernel.mjs'

function fakeElf64Amd64() {
  const buf = Buffer.alloc(64)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2
  buf[5] = 1
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(62, 18)
  return buf
}

test('selectKernelAsset accepts only the kin-kernel GitHub asset', () => {
  const picked = selectKernelAsset({
    tag_name: 'v1.3.2',
    assets: [
      { name: 'kin-worker', url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/1' },
      {
        name: 'kin-kernel',
        size: 64,
        url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/9',
        browser_download_url: 'https://evil.example/kin-kernel',
      },
    ],
  })
  assert.equal(picked.ok, true)
  assert.equal(picked.tag, 'v1.3.2')
  assert.equal(picked.url, 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/9')
  assert.equal(selectKernelAsset({ tag_name: 'v1.3.2', assets: [] }).code, 'kernel_asset_missing')
  assert.equal(
    selectCliNodeAsset({
      tag_name: 'v1.3.2',
      assets: [
        {
          name: 'cli-node',
          size: 64,
          url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/8',
        },
      ],
    }).asset,
    'cli-node',
  )
  assert.equal(selectCliNodeAsset({ tag_name: 'v1.3.2', assets: [] }).code, 'cli_node_asset_missing')
  assert.equal(
    selectKernelAsset({
      tag_name: 'v1.3.2',
      assets: [{ name: 'kin-kernel', size: 64, url: 'https://evil.example/kin-kernel' }],
    }).code,
    'kernel_asset_url',
  )
  assert.equal(
    selectKernelAsset({
      tag_name: 'v1.3.2',
      assets: [
        {
          name: 'kin-kernel',
          size: 33 * 1024 * 1024,
          url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/9',
        },
      ],
    }).code,
    'kernel_too_large',
  )
})

for (const tag of ['v1.2.3', 'v1.3.204.1', 'v1.3.208.0']) {
  test('kernel download validates legacy and fork tags: ' + tag, async () => {
    assert.equal(isAllowedKernelUrl('http://api.github.com/repos/holeenlu/vm2api/releases/latest'), false)
    assert.equal(isAllowedKernelUrl('https://api.github.com/repos/holeenlu/vm2api/releases/tags/' + tag), true)
    assert.equal(isAllowedKernelUrl('https://evil.example/kin-kernel', { redirect: true }), false)
    const elf = fakeElf64Amd64()
    const seen = []
    const fetched = await downloadReleaseKernel({
      tag,
      fetchImpl: async (url, opts) => {
        seen.push(String(url))
        assert.equal(opts.redirect, 'manual')
        if (String(url).endsWith('/releases/tags/' + tag)) {
          return new Response(
            JSON.stringify({
              tag_name: tag,
              assets: [
                {
                  name: 'kin-kernel',
                  size: elf.length,
                  browser_download_url: 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/kin-kernel',
                },
                {
                  name: 'cli-node',
                  size: elf.length,
                  browser_download_url: 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/cli-node',
                },
                {
                  name: 'cc-node',
                  size: elf.length,
                  browser_download_url: 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/cc-node',
                },
                {
                  name: 'kin-kernel-crag',
                  size: elf.length,
                  browser_download_url:
                    'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/kin-kernel-crag',
                },
              ],
            }),
            { status: 200 },
          )
        }
        if (String(url) === 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/kin-kernel') {
          return new Response(null, {
            status: 302,
            headers: {
              location: 'https://release-assets.githubusercontent.com/github-production-release-asset/kin-kernel',
            },
          })
        }
        if (String(url).includes('release-assets.githubusercontent.com')) {
          assert.equal(opts.headers.Authorization, undefined)
          return new Response(elf, { status: 200 })
        }
        if (
          String(url) === 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/cli-node' ||
          String(url) === 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/cc-node' ||
          String(url) === 'https://github.com/holeenlu/vm2api/releases/download/' + tag + '/kin-kernel-crag'
        ) {
          return new Response(elf, { status: 200 })
        }
        throw new Error(`unexpected ${url}`)
      },
    })
    assert.equal(fetched.ok, true, fetched.error)
    assert.equal(fetched.tag, tag)
    assert.ok(Buffer.from(fetched.bytes).equals(elf))
    assert.ok(Buffer.from(fetched.cliNode.bytes).equals(elf))
    assert.ok(Buffer.from(fetched.ccNode.bytes).equals(elf))
    assert.ok(Buffer.from(fetched.crag.bytes).equals(elf))
    assert.equal(fetched.crag.skipped, undefined)
    assert.equal(seen.length, 6)
    assert.equal(isAllowedKernelUrl('https://github.com/holeenlu/vm2api/releases/download/' + tag + '/cc-node'), true)

    const blocked = await downloadReleaseKernel({
      fetchImpl: async (url) => {
        if (String(url).endsWith('/releases/latest')) {
          return new Response(
            JSON.stringify({
              tag_name: 'v9.9.9',
              assets: [
                {
                  name: 'kin-kernel',
                  size: 64,
                  url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/4',
                },
                {
                  name: 'cli-node',
                  size: 64,
                  url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/5',
                },
                {
                  name: 'cc-node',
                  size: 64,
                  url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/6',
                },
                {
                  name: 'kin-kernel-crag',
                  size: 64,
                  url: 'https://api.github.com/repos/holeenlu/vm2api/releases/assets/7',
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })
      },
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'kernel_redirect_blocked')
    assert.equal(
      await downloadReleaseKernel({
        tag: 'v1.2;rm',
        fetchImpl: async () => {
          throw new Error('fetched')
        },
      }).then((r) => r.code),
      'kernel_tag_invalid',
    )
  })
}
