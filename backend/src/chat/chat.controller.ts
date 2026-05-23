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
import { RateLimitService, RATE_LIMIT_CONFIG } from './rate-limit.service';
import { Turn } from '../session/session.types';
import { LlmHealthService, LlmHealth } from '../llm/llm-health.service';
import {
  ExpertConfigService,
  ExpertConfigSnapshot,
} from '../config/expert-config.service';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly llmHealth: LlmHealthService,
    private readonly rateLimit: RateLimitService,
    private readonly expertConfig: ExpertConfigService,
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

  /**
   * Exposes the configured persona (domain, app title/subtitle, tool
   * metadata) so the Next.js Server Component can render labels from a
   * single backend source of truth instead of duplicating defaults.
   *
   * Whitelisted via ExpertConfigService.snapshot() — internal config
   * (LLM keys, base URLs, rate-limit constants) is NEVER exposed here.
   */
  @Get('config')
  getConfig(): ExpertConfigSnapshot {
    return this.expertConfig.snapshot();
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
   *
   * Wire contract (only these three frame shapes ever reach the client):
   *   data: {"token":"..."}                 -> partial visible text
   *   data: {"done":true,"turnIndex":N}     -> terminal success
   *   data: {"error":"..."}                 -> terminal failure
   *
   * Tool calling and `<think>` block buffering happen entirely inside
   * ChatService.streamReply; their internal events are swallowed so the
   * SSE stream stays silent until the first real token arrives.
   */
  @Post(':sessionId/message')
  @HttpCode(200)
  async sendMessage(
    @Param('sessionId', new ParseUUIDPipe({ version: '4' })) sessionId: string,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ): Promise<void> {
    // Authoritative rate-limit gate. Runs BEFORE beginStream so a denied
    // request never touches session history or the LLM. The BFF mirrors
    // these limits as an early-reject, but a caller bypassing the BFF
    // still hits this check.
    const rl = this.rateLimit.consume(sessionId);
    if (!rl.allowed) {
      const limit =
        rl.reason === 'minute'
          ? `${RATE_LIMIT_CONFIG.MINUTE_MAX}/min`
          : `${RATE_LIMIT_CONFIG.HOUR_MAX}/hour`;
      res.status(429);
      res.setHeader('Retry-After', String(rl.retryAfterSec));
      res.json({
        error: `Rate limit exceeded (${limit} per session). Try again in ${rl.retryAfterSec}s.`,
        reason: rl.reason,
        retryAfterSec: rl.retryAfterSec,
      });
      return;
    }

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
