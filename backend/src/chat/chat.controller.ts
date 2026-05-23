import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { Turn } from '../session/session.types';
import { LlmHealthService, LlmHealth } from '../llm/llm-health.service';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly llmHealth: LlmHealthService,
  ) {}

  @Post('session')
  @HttpCode(201)
  createSession(): { sessionId: string } {
    return this.chat.createSession();
  }

  /**
   * Reports the result of a proactive probe of the configured LLM provider:
   * auth/quota state, whether tool calling works, whether the model leaks
   * `<think>` blocks, etc. The frontend renders a persistent banner from
   * this. Cached for 5 minutes inside LlmHealthService so polling is cheap.
   */
  @Get('health/llm')
  getLlmHealth(): Promise<LlmHealth> {
    return this.llmHealth.getHealth();
  }

  @Get(':sessionId/history')
  getHistory(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): { sessionId: string; turns: Turn[] } {
    return { sessionId, turns: this.chat.getHistory(sessionId) };
  }

  @Delete(':sessionId')
  @HttpCode(204)
  deleteSession(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
  ): void {
    this.chat.deleteSession(sessionId);
  }

  /**
   * Server-Sent Events streaming endpoint. We bypass the Nest @Sse() decorator
   * because we want fine-grained control over flush timing, error frames, and
   * the terminal "done" event format expected by the frontend.
   */
  @Post(':sessionId/message')
  @HttpCode(200)
  async sendMessage(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    // Synchronously validate session + record the user turn. This throws
    // 404 or 410 BEFORE we flush SSE headers, so Nest's exception filter
    // returns the proper HTTP status to the client.
    const history = this.chat.beginStream(sessionId, dto.message);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const write = (payload: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      for await (const evt of this.chat.streamReply(sessionId, dto.message, history)) {
        write(evt.data);
      }
    } catch {
      write({ error: 'LLM unavailable' });
    } finally {
      res.end();
    }
  }
}
