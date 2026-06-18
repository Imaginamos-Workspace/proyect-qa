import { Module } from '@nestjs/common';
import { RegressionController } from './regression.controller';
import { RegressionService } from './regression.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [RegressionController],
  providers: [RegressionService],
})
export class RegressionModule {}
