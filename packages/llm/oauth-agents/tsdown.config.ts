import { clientBundle } from '../../client/tsdown.client.ts'

/** Build the Host plugin during the Host pass and the Client card during the Client pass. */
export default clientBundle(
  '@deepseek-ai/dsh-oauth-agents',
  ['lib/types/index.js'],
  { hostPhase: true },
)