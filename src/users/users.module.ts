import { ApiKeyGuard } from '../messaging/api-key.guard';
import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [ApiKeyGuard, UsersService],
})
export class UsersModule {}
