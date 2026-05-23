import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExpertConfigService } from './expert-config.service';

/**
 * Wraps ExpertConfigService so any module that needs the persona config
 * (LlmModule, ChatModule) can `imports: [ExpertConfigModule]` and inject
 * the service. AppModule already registers ConfigModule globally, but
 * importing it here keeps this module self-sufficient in isolated tests.
 */
@Module({
  imports: [ConfigModule],
  providers: [ExpertConfigService],
  exports: [ExpertConfigService],
})
export class ExpertConfigModule {}
