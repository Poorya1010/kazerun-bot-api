import { Module } from '@nestjs/common';
import { KazerunYarService } from './kazerun-yar.service';

@Module({
  providers: [KazerunYarService],
  exports: [KazerunYarService],
})
export class KazerunYarModule {}
