import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { SalesRagService } from './sales-rag.service';
import { AuthModule } from '../auth/auth.module';
import { AIModule } from '../ai/ai.module';
import { ScrumModule } from '../scrum/scrum.module';

@Module({
  imports: [AuthModule, AIModule, ScrumModule],
  controllers: [SalesController],
  providers: [SalesService, SalesRagService],
})
export class SalesModule {}
