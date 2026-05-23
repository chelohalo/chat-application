import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';
import { LlmHealthService } from './llm-health.service';
import { LLM_PROVIDER, LlmProvider } from './providers/llm-provider.interface';
import { GeminiLlmProvider } from './providers/gemini.provider';
import { MockLlmProvider } from './providers/mock.provider';
import { OpenAICompatibleLlmProvider } from './providers/openai-compatible.provider';
import { AnthropicLlmProvider } from './providers/anthropic.provider';

/**
 * Decide which LlmProvider implementation backs LlmService.
 *
 * Resolution order:
 *   1. LLM_PROVIDER=mock                       → MockLlmProvider (no network).
 *   2. LLM_PROVIDER=gemini                     → Google AI Studio (Gemini + Gemma).
 *   3. LLM_PROVIDER=anthropic|claude           → Anthropic Messages API.
 *   4. LLM_PROVIDER=openai|groq|cerebras|      → OpenAI Chat Completions-
 *      together|openrouter|mistral|ollama|       compatible endpoint. The
 *      openai-compatible                         vendor alias determines the
 *                                                default base URL; LLM_BASE_URL
 *                                                overrides for self-hosted gateways.
 *   5. No LLM_PROVIDER set                     → auto-detect:
 *        - "claude-*" model → Anthropic
 *        - generativelanguage.googleapis.com base URL → Gemini
 *        - otherwise → OpenAI-compatible
 *      Defaults to mock if no key is configured.
 */
function selectProvider(
  config: ConfigService,
  gemini: GeminiLlmProvider,
  openai: OpenAICompatibleLlmProvider,
  anthropic: AnthropicLlmProvider,
  mock: MockLlmProvider,
  logger: Logger,
): LlmProvider {
  const apiKey = config.get<string>('LLM_API_KEY');
  const explicit = (config.get<string>('LLM_PROVIDER') ?? '').toLowerCase().trim();
  const baseUrl = config.get<string>('LLM_BASE_URL') ?? '';
  const model = config.get<string>('LLM_MODEL') ?? '(default)';

  if (explicit === 'mock' || !apiKey) {
    logger.log('Using MockLlmProvider (no LLM_API_KEY or LLM_PROVIDER=mock)');
    return mock;
  }

  if (explicit === 'gemini') {
    logger.log(`Using GeminiLlmProvider (model=${model})`);
    return gemini;
  }

  if (explicit === 'anthropic' || explicit === 'claude') {
    logger.log(`Using AnthropicLlmProvider (model=${model})`);
    return anthropic;
  }

  // Any of these aliases route to the OpenAI-compatible provider; LLM_BASE_URL
  // determines the actual vendor (Groq, OpenAI, Cerebras, Together, etc.).
  const openaiAliases = new Set([
    'openai',
    'groq',
    'cerebras',
    'together',
    'openrouter',
    'mistral',
    'ollama',
    'openai-compatible',
  ]);
  if (openaiAliases.has(explicit)) {
    logger.log(
      `Using OpenAICompatibleLlmProvider (vendor=${explicit || 'openai'}, model=${model}, baseUrl=${openai.resolvedBaseUrl})`,
    );
    return openai;
  }

  // No explicit provider: infer from model name first (cheapest signal), then
  // from LLM_BASE_URL host.
  if (/^claude-/i.test(model)) {
    logger.log(`Auto-detected AnthropicLlmProvider from model=${model}`);
    return anthropic;
  }
  if (/generativelanguage\.googleapis\.com/.test(baseUrl)) {
    logger.log(`Auto-detected GeminiLlmProvider from base URL (model=${model})`);
    return gemini;
  }
  if (/api\.anthropic\.com/.test(baseUrl)) {
    logger.log(`Auto-detected AnthropicLlmProvider from base URL (model=${model})`);
    return anthropic;
  }

  logger.log(
    `Defaulting to OpenAICompatibleLlmProvider (model=${model}, baseUrl=${openai.resolvedBaseUrl})`,
  );
  return openai;
}

@Module({
  imports: [ConfigModule],
  providers: [
    LlmService,
    LlmHealthService,
    GeminiLlmProvider,
    OpenAICompatibleLlmProvider,
    AnthropicLlmProvider,
    MockLlmProvider,
    {
      provide: LLM_PROVIDER,
      inject: [
        ConfigService,
        GeminiLlmProvider,
        OpenAICompatibleLlmProvider,
        AnthropicLlmProvider,
        MockLlmProvider,
      ],
      useFactory: (
        config: ConfigService,
        gemini: GeminiLlmProvider,
        openai: OpenAICompatibleLlmProvider,
        anthropic: AnthropicLlmProvider,
        mock: MockLlmProvider,
      ) =>
        selectProvider(
          config,
          gemini,
          openai,
          anthropic,
          mock,
          new Logger('LlmModule'),
        ),
    },
  ],
  exports: [LlmService, LlmHealthService],
})
export class LlmModule {}
