// Unit tests for stopped local VMs must not inspect or mutate the developer's Docker daemon.
import { before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let server, directory
const connect = net.connect.bind(net)
before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-'))
  const socket = path.join(directory, 'sock')
  server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET', 'stopped-VM publication must not mutate a container')
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'No such container' }))
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  mock.method(net, 'connect', (target, ...rest) => connect(target === '/var/run/docker.sock' ? socket : target, ...rest))
})
after(async () => {
  mock.restoreAll()
  if (server) await new Promise((resolve) => server.close(resolve))
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
})
