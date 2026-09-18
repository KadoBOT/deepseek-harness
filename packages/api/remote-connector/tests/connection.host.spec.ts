/**
 * REAL-composition transport proof for the connector: a credentials-local +
 * webserver + connection + frontend-static + typert + gateway + llm tree boots
 * through the vendored Loader, rejects the unauthenticated API read with 401,
 * and accepts the connector's token-exchange read. The Session Controller's
 * own composition needs the base session stack; its envelope behavior is
 * covered by validation.host.spec.ts against a scripted gateway.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { expect, it } from 'vitest'
import { connectRemote } from '../src/connection.ts'

it('exchanges a launch token and reads providers through the authenticated HTTP API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-connector-'))
  const ctx = new Context()
  try {
    const dist = join(root, 'dist')
    await mkdir(dist)
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>Remote fixture</title>')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-credentials-local'",
      '  config:',
      `    path: ${JSON.stringify(join(root, '.credentials.yaml'))}`,
      '    watch: false',
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      '    host: 127.0.0.1',
      '    port: 0',
      "- name: '@deepseek-ai/dsh-client-connection'",
      "- name: '@deepseek-ai/dsh-host-frontend-static'",
      '  config:',
      `    distIndex: ${JSON.stringify(join(dist, 'index.html'))}`,
      "- name: '@deepseek-ai/dsh-typert-registry'",
      "- name: '@deepseek-ai/dsh-api-gateway'",
      "- name: '@deepseek-ai/dsh-llm'",
      '',
    ].join('\n'))
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-client-connection', Connection],
      ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
      ['@deepseek-ai/dsh-typert-registry', TypertRegistry],
      ['@deepseek-ai/dsh-api-gateway', Gateway],
      ['@deepseek-ai/dsh-llm', LlmRuntime],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected fixture import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
    const unauthorized = await fetch(`${origin}/api/llm/listProviders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'unauthorized-read', method: 'llm/listProviders', payload: { args: {} } }),
    })
    expect(unauthorized.status).toBe(401)
    await unauthorized.body?.cancel()
    const connection = await connectRemote({
      loginUrl: ctx.connection.authenticatedUrl(origin),
      timeoutMs: 5_000,
      maxResponseBytes: 65_536,
    })
    try {
      expect(await connection.listProviders()).toEqual([])
    } finally {
      await connection.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
