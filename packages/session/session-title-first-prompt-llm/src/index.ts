/** First-human-message model brief provider for `ctx.sessionTitle`: name plus summary. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  registerSessionBriefLlmProvider,
  SessionBriefLlmConfigFields,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionBriefLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

export const name = 'session-title-first-prompt-llm'
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Required LLM policy; this plugin adds no defaults. */
export type Config = SessionBriefLlmConfig
/** Loader schema shared with the shared brief registration helper. */
/* jscpd:ignore-start -- Loader requires each plugin to export its own statically walkable schema; the field validators remain shared. */
export const Config: z<Config> = z.object({
  targetWords: SessionBriefLlmConfigFields.targetWords,
  targetCjkCharacters: SessionBriefLlmConfigFields.targetCjkCharacters,
  targetSummaryWords: SessionBriefLlmConfigFields.targetSummaryWords,
  targetSummaryCjkCharacters: SessionBriefLlmConfigFields.targetSummaryCjkCharacters,
  maxInputBytes: SessionBriefLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionBriefLlmConfigFields.maxOutputTokens,
  maxSummaryBytes: SessionBriefLlmConfigFields.maxSummaryBytes,
  timeoutMs: SessionBriefLlmConfigFields.timeoutMs,
  provider: SessionBriefLlmConfigFields.provider,
  model: SessionBriefLlmConfigFields.model,
})
/* jscpd:ignore-end */

/**
 * Register the first-prompt model brief provider. One auxiliary call names the
 * session and appends the `session/summary` event whose projection feeds the
 * client hover cards.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - required route, target, byte, token, and timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  registerSessionBriefLlmProvider(ctx, config, name, 'first-prompt', (messages) => {
    const first = messages[0]
    if (first === undefined) throw new Error('first-prompt title provider requires one human message')
    return [first]
  })
}
