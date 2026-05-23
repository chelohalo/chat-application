import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';
import { LLM_PROVIDER } from './providers/llm-provider.interface';
import { GeminiLlmProvider } from './providers/gemini.provider';
import { MockLlmProvider } from './providers/mock.provider';

@Module({
  imports: [ConfigModule],
  providers: [
    LlmService,
    GeminiLlmProvider,
    MockLlmProvider,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService, GeminiLlmProvider, MockLlmProvider],
      useFactory: (
        config: ConfigService,
        gemini: GeminiLlmProvider,
        mock: MockLlmProvider,
      ) => {
        const apiKey = config.get<string>('LLM_API_KEY');
        const useMock = config.get<string>('LLM_PROVIDER') === 'mock' || !apiKey;
        const logger = new Logger('LlmModule');
        if (useMock) {
          logger.log('Using MockLlmProvider (no LLM_API_KEY or LLM_PROVIDER=mock)');
          return mock;
        }
        logger.log(`Using GeminiLlmProvider (model=${config.get('LLM_MODEL') ?? 'gemini-2.0-flash'})`);
        return gemini;
      },
    },
  ],
  exports: [LlmService],
})
export class LlmModule {}
