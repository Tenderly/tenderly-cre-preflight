import { describe, expect, it } from 'bun:test'
import { parseCreatedEnvironment } from '../src/environment.js'
import fixture from './fixtures/environment-create.json'

/**
 * The fixture is a real `POST /environments` response, captured from the live
 * Tenderly API and scrubbed of its credential-bearing RPC URL. Parsing against
 * a hand-written mock alone would let the mock drift away from the API.
 */
describe('parseCreatedEnvironment', () => {
  it('parses a real API response', () => {
    const parsed = parseCreatedEnvironment(JSON.stringify(fixture))

    expect(parsed.environmentId).toBe(fixture.id)
    expect(parsed.chainId).toBe(11155111)
    expect(parsed.adminRpcUrl).toStartWith('https://virtual.sepolia.eu.rpc.tenderly.co/')
  })

  it('confirms the response really does carry the chain id', () => {
    // This is what lets us skip an eth_chainId round trip.
    expect(fixture.active_instance.vnets[0]?.virtual_network_config.chain_config.chain_id).toBe(
      11155111,
    )
  })

  it('confirms the response carries no dashboard_url', () => {
    // Reading `vnet.dashboard_url` and defaulting to '' looks reasonable and
    // always yields '': the field does not exist in the response.
    expect(fixture.active_instance.vnets[0]).not.toHaveProperty('dashboard_url')
  })

  it('rejects a non-Tenderly Admin RPC host', () => {
    const tampered = JSON.parse(JSON.stringify(fixture))
    tampered.active_instance.vnets[0].rpcs[0].url = 'https://evil.example.com/rpc'
    expect(() => parseCreatedEnvironment(JSON.stringify(tampered))).toThrow(/trusted Admin RPC/)
  })

  it('rejects a response with no virtual network', () => {
    const tampered = JSON.parse(JSON.stringify(fixture))
    tampered.active_instance.vnets = []
    expect(() => parseCreatedEnvironment(JSON.stringify(tampered))).toThrow(/no virtual network/)
  })

  it('rejects a malformed body', () => {
    expect(() => parseCreatedEnvironment('not json')).toThrow(/malformed JSON/)
  })
})

describe('Admin RPC selection', () => {
  it('picks the HTTP Admin RPC regardless of ordering', () => {
    // A substring match on 'admin' also matches 'Admin websocket RPC', so a
    // reordered response would silently yield a websocket URL.
    const HTTP_ADMIN = 'https://virtual.sepolia.eu.rpc.tenderly.co/acct/proj/http-admin'
    const WS_ADMIN = 'https://virtual.sepolia.eu.rpc.tenderly.co/acct/proj/ws-admin'
    const reordered = JSON.parse(JSON.stringify(fixture))
    // Websocket entry deliberately first, with a distinct URL, so a substring
    // match on 'admin' would pick the wrong one and this assertion would fail.
    reordered.active_instance.vnets[0].rpcs = [
      { name: 'Admin websocket RPC', url: WS_ADMIN },
      { name: 'Public RPC', url: 'https://virtual.sepolia.eu.rpc.tenderly.co/acct/proj/public' },
      { name: 'Admin RPC', url: HTTP_ADMIN },
    ]

    const parsed = parseCreatedEnvironment(JSON.stringify(reordered))
    expect(parsed.adminRpcUrl).toBe(HTTP_ADMIN)
  })

  it('never selects a websocket endpoint', () => {
    const wsOnly = JSON.parse(JSON.stringify(fixture))
    wsOnly.active_instance.vnets[0].rpcs = [
      { name: 'Admin websocket RPC', url: 'wss://virtual.sepolia.eu.rpc.tenderly.co/a/b/c' },
      { name: 'Public RPC', url: 'https://virtual.sepolia.eu.rpc.tenderly.co/a/b/d' },
    ]
    expect(() => parseCreatedEnvironment(JSON.stringify(wsOnly))).toThrow(/trusted Admin RPC/)
  })

  it('does not fall back to the Public RPC', () => {
    // The public endpoint cannot run tenderly_setBalance or tenderly_sendTransaction,
    // so selecting it would fail later and more confusingly.
    const noAdmin = JSON.parse(JSON.stringify(fixture))
    noAdmin.active_instance.vnets[0].rpcs = [
      { name: 'Public RPC', url: 'https://virtual.sepolia.eu.rpc.tenderly.co/a/b/d' },
    ]
    expect(() => parseCreatedEnvironment(JSON.stringify(noAdmin))).toThrow(/trusted Admin RPC/)
  })
})
