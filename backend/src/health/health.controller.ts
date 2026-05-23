import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  @Get()
  check(): { status: 'ok'; uptimeMs: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeMs: Date.now() - this.startedAt,
      timestamp: new Date().toISOString(),
    };
  }
}
