import { Module } from '@nestjs/common';
import { AIController } from './ai.controller';
import { AIService } from './ai.service';
import { SuggestionsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';
import { GeminiProvider } from './providers/gemini.provider';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { TestSuitesModule } from '../test-suites/test-suites.module';
import { TestCasesModule } from '../test-cases/test-cases.module';

@Module({
  imports: [AuthModule, ProjectsModule, TestSuitesModule, TestCasesModule],
  controllers: [AIController, SuggestionsController],
  providers: [AIService, SuggestionsService, GeminiProvider],
  exports: [AIService, SuggestionsService],
})
export class AIModule {}
