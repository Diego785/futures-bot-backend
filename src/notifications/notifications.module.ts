import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { FcmService } from './fcm.service';

@Module({
  imports: [HttpModule],
  providers: [FcmService],
  exports: [FcmService],
})
export class NotificationsModule {}
