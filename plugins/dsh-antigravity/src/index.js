/**
 * Standalone Cordis plugin for Google Antigravity CLI bridge.
 * Provides access to Gemini, Claude, and GPT-OSS models via local agy CLI binary.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-antigravity';
export const inject = ['llm'];

const CANDIDATE_AGY_PATHS = [
  process.env.AGY_BIN,
  path.join(os.homedir(), '.local', 'bin', 'agy'),
  '/opt/homebrew/bin/agy',
  '/usr/local/bin/agy',
].filter(Boolean);

export function resolveAgyBinary() {
  for (const candidate of CANDIDATE_AGY_PATHS) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir) {
      const candidate = path.join(dir, 'agy');
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {}
    }
  }
  return undefined;
}

export const ANTIGRAVITY_MODELS = {
  'gemini-3.8-flash-high': { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.8-flash-medium': { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.8-flash-low': { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.7-flash-high': { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (High)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.7-flash-medium': { id: 'gemini-3.7-flash-medium', name: 'Gemini 3.7 Flash (Medium)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.7-flash-low': { id: 'gemini-3.7-flash-low', name: 'Gemini 3.7 Flash (Low)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.6-flash-high': { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.6-flash-medium': { id: 'gemini-3.6-flash-medium', name: 'Gemini 3.6 Flash (Medium)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.6-flash-low': { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.1-pro-high': { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'gemini-3.1-pro-low': { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)', contextWindow: 1048576, maxTokens: 65536, reasoning: true },
  'claude-sonnet-4-6': { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)', contextWindow: 200000, maxTokens: 65536, reasoning: true },
  'claude-opus-4-6-thinking': { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)', contextWindow: 200000, maxTokens: 65536, reasoning: true },
  'gpt-oss-120b-medium': { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', contextWindow: 128000, maxTokens: 32768, reasoning: true },
};

export function resolveAgyModelFlag(modelId, effort) {
  // A pinned variant without an effort override stays exactly as picked;
  // otherwise the effort dial remaps within the model family (base ids from
  // older settings keep working through the same mapping).
  if (!effort && Object.hasOwn(ANTIGRAVITY_MODELS, modelId)) return modelId;
  if (modelId.startsWith('gemini-3.8-flash')) {
    if (effort === 'high' || effort === 'max') return 'gemini-3.8-flash-high';
    if (effort === 'low' || effort === 'minimal') return 'gemini-3.8-flash-low';
    return 'gemini-3.8-flash-medium';
  }
  if (modelId.startsWith('gemini-3.7-flash')) {
    if (effort === 'high' || effort === 'max') return 'gemini-3.7-flash-high';
    if (effort === 'low' || effort === 'minimal') return 'gemini-3.7-flash-low';
    return 'gemini-3.7-flash-medium';
  }
  if (modelId.startsWith('gemini-3.6-flash')) {
    if (effort === 'high' || effort === 'max') return 'gemini-3.6-flash-high';
    if (effort === 'low' || effort === 'minimal') return 'gemini-3.6-flash-low';
    return 'gemini-3.6-flash-medium';
  }
  if (modelId.startsWith('gemini-3.1-pro')) {
    if (effort === 'low' || effort === 'minimal') return 'gemini-3.1-pro-low';
    return 'gemini-3.1-pro-high';
  }
  return modelId;
}

function extractPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    let text = '';
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b) => b && (b.type === 'text' || b.text))
        .map((b) => b.text || '')
        .join('\n');
    }
    if (text) {
      parts.push(`[${role}]: ${text}`);
    }
  }
  return parts.join('\n\n');
}

export async function* streamFromAgy(binary, options) {
  const modelFlag = resolveAgyModelFlag(options.model, options.reasoningEffort);
  const prompt = extractPrompt(options.messages);

  const args = [
    '--model', modelFlag,
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];

  const proc = spawn(binary, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  const rl = readline.createInterface({ input: proc.stdout });

  const queue = [];
  let resolveNext = null;
  let finished = false;
  let procError = null;

  function pushChunk(chunk) {
    if (resolveNext) {
      const res = resolveNext;
      resolveNext = null;
      res({ value: chunk, done: false });
    } else {
      queue.push(chunk);
    }
  }

  function finishStream() {
    finished = true;
    if (resolveNext) {
      const res = resolveNext;
      resolveNext = null;
      res({ done: true });
    }
  }

  let hasThoughtBlock = false;
  let hasTextBlock = false;
  let fullThought = '';
  let fullText = '';
  let totalUsage = null;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch {
      return;
    }

    const step = data.event === 'step_update' && data.step_update ? data.step_update : null;
    if (step) {
      const thought = step.thinking || step.thought_text || step.delta_raw_thinking || '';
      if (thought) {
        if (!hasThoughtBlock) {
          hasThoughtBlock = true;
          pushChunk({ type: 'block-start', index: 0, blockType: 'reasoning' });
        }
        fullThought += thought;
        pushChunk({ type: 'reasoning-delta', index: 0, text: thought });
      }

      const text = step.text_delta || (step.state === 'DONE' && typeof step.response_text === 'string' ? step.response_text : '');
      if (text) {
        if (hasThoughtBlock && !hasTextBlock) {
          pushChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: fullThought } });
        }
        if (!hasTextBlock) {
          hasTextBlock = true;
          pushChunk({ type: 'block-start', index: 1, blockType: 'text' });
        }
        fullText += text;
        pushChunk({ type: 'text-delta', index: 1, text });
      }
    }

    const res = data.event === 'result' && data.result ? data.result : null;
    if (res) {
      if (res.usage) {
        totalUsage = {
          inputTokens: res.usage.input_tokens || 0,
          outputTokens: res.usage.output_tokens || 0,
          totalTokens: res.usage.total_tokens || 0,
          cacheReadTokens: res.usage.cache_read_tokens || 0,
          cacheWriteTokens: 0,
        };
      }
      if (res.response && !fullText) {
        if (!hasTextBlock) {
          hasTextBlock = true;
          pushChunk({ type: 'block-start', index: 1, blockType: 'text' });
        }
        fullText = res.response;
        pushChunk({ type: 'text-delta', index: 1, text: res.response });
      }
    }
  });

  proc.on('error', (err) => {
    procError = err;
    finishStream();
  });

  proc.on('close', (code) => {
    if (hasThoughtBlock && !hasTextBlock) {
      pushChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: fullThought } });
    }
    if (hasTextBlock) {
      pushChunk({ type: 'block-end', index: 1, block: { type: 'text', text: fullText } });
    }
    if (totalUsage) {
      pushChunk({ type: 'usage', usage: totalUsage });
    }
    pushChunk({ type: 'finish', reason: { kind: code === 0 || !code ? 'stop' : 'error' } });
    finishStream();
  });

  if (options.signal) {
    options.signal.addEventListener('abort', () => {
      try { proc.kill('SIGTERM'); } catch {}
      finishStream();
    }, { once: true });
  }

  // Send prompt
  proc.stdin.write(JSON.stringify({
    event: 'user',
    message: { role: 'user', content: prompt },
  }) + '\n');
  proc.stdin.end();

  while (true) {
    if (queue.length > 0) {
      yield queue.shift();
    } else if (finished) {
      if (procError) throw procError;
      break;
    } else {
      const item = await new Promise((res) => { resolveNext = res; });
      if (item.done) {
        if (procError) throw procError;
        break;
      }
      yield item.value;
    }
  }
}

class AntigravityAdapter extends LlmAdapter {
  async listModels(_provider) {
    return Object.values(ANTIGRAVITY_MODELS).map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
  }

  async resolveModel(provider, modelId) {
    const found = ANTIGRAVITY_MODELS[modelId] || { id: modelId, name: modelId };
    return {
      provider,
      id: found.id,
      name: found.name,
      contextWindow: found.contextWindow || 1048576,
      maxTokens: found.maxTokens || 65536,
      reasoning: found.reasoning ? { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }] } : undefined,
    };
  }

  async prepareCall(provider, modelId) {
    const resolved = await this.resolveModel(provider, modelId);
    const binary = resolveAgyBinary();
    return {
      model: resolved,
      stream: (options) => {
        if (!binary) {
          throw new Error('Antigravity CLI binary (agy) not found');
        }
        return streamFromAgy(binary, options);
      },
    };
  }
}

export function apply(ctx) {
  const binary = resolveAgyBinary();
  if (!binary) {
    ctx.logger?.warn('dsh-antigravity: agy CLI binary not found in standard locations or PATH');
  }

  const adapter = new AntigravityAdapter();

  try {
    ctx.llm.registerAdapter(['antigravity'], adapter);
  } catch (err) {
    ctx.logger?.warn?.('dsh-antigravity: failed to register adapter for antigravity route: ' + String(err));
  }

  try {
    ctx.llm.registerConfigurableProviders([
      {
        provider: 'antigravity',
        displayName: 'Google Antigravity',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'antigravity'],
      },
    ]);
  } catch {}

  // Waterfall interception for google or antigravity routes
  ctx.effect(() => {
    return ctx.on('llm/stream', async function* (options, next) {
      const isAntigravity = options.provider === 'antigravity';
      const isGoogle = options.provider === 'google';
      const isKnownModel = Boolean(ANTIGRAVITY_MODELS[options.model]);

      if (binary && (isAntigravity || (isGoogle && isKnownModel))) {
        yield* streamFromAgy(binary, options);
        return;
      }
      yield* next(options);
    });
  }, 'dsh-antigravity: stream interceptor');
}
