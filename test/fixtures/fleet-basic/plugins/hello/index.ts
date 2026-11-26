import { API_VERSION } from 'airstack'
export function register(config: { who?: string }) {
  return { name: 'hello', scope: 'stack', greeting: `hello ${config?.who ?? 'nobody'} (api ${API_VERSION})` }
}
