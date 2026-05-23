import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { RateLimitService } from './rate-limit.service';
import { SessionModule } from '../session/session.module';
import { LlmModule } from '../llm/llm.module';
import { ExpertConfigModule } from '../config/expert-config.module';

@Module({
  imports: [SessionModule, LlmModule, ExpertConfigModule],
  controllers: [ChatController],
  providers: [ChatService, RateLimitService],
})
export class ChatModule {}
