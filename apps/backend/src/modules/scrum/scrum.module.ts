import { Module } from '@nestjs/common';
import { ScrumController } from './scrum.controller';
import { ScrumService } from './scrum.service';
import { RolesService } from './roles.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ScrumController],
  providers: [ScrumService, RolesService],
  exports: [RolesService],
})
export class ScrumModule {}
