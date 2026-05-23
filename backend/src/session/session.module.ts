import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { Clock, SystemClock } from './clock';

@Module({
  providers: [
    SessionService,
    { provide: Clock, useClass: SystemClock },
  ],
  exports: [SessionService, Clock],
})
export class SessionModule {}
