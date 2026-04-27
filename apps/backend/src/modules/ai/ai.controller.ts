import { Controller, Post, Get, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { AIService } from './ai.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  AIRefineRequest,
  AICompleteTestRequest,
  AIHealIterateRequest,
  CreateGenerationJobDto,
} from '../../shared-types';

@Controller('ai')
@UseGuards(SupabaseAuthGuard)
export class AIController {
  constructor(private readonly aiService: AIService) {}

  @Post('generate-tests')
  async generateTests(
    @Body() body: CreateGenerationJobDto & { project_id: string },
    @CurrentUser('id') userId: string,
  ) {
    // Create a job record with status='pending' and return immediately.
    // The actual AI generation is handled by the agent, not this endpoint.
    const job = await this.aiService.createGenerationJob(
      body.project_id,
      userId,
      body.test_types,
    );
    return job;
  }

  @Post('complete-test-case')
  async completeTestCase(@Body() request: AICompleteTestRequest) {
    return this.aiService.completeSingleTest(request);
  }

  @Post('refine-test')
  async refineTest(@Body() request: AIRefineRequest) {
    return this.aiService.refineTest(request);
  }

  /**
   * Issue a scoped, short-lived heal token for one test case. Required
   * before the user can run the heal loop on their machine — the token
   * is embedded in the bash command and validated by /ai/heal-iterate.
   * Auth required (Supabase session via guard).
   */
  @Post('heal-token')
  async issueHealToken(@Body() body: { test_case_id: string }) {
    return this.aiService.issueHealToken(body?.test_case_id);
  }

  /**
   * Self-heal iteration — called from the user's local machine via the heal
   * loop CLI when a test fails. Receives the real DOM at the failure moment
   * and returns regenerated code.
   *
   * PUBLIC at the auth-guard level (the bash script has no Supabase
   * session), but the request body MUST carry a valid heal_token issued by
   * /ai/heal-token for the same test_case_id. The service validates the
   * HMAC before calling Gemini.
   */
  @Public()
  @Post('heal-iterate')
  async healIterate(@Body() request: AIHealIterateRequest) {
    return this.aiService.healIterate(request);
  }

  @Post('analyze-url')
  async analyzeUrl(
    @Body() body: { url: string; page_data: string },
  ) {
    return this.aiService.analyzeUrl(body.url, body.page_data);
  }

  @Get('generation-jobs/project/:projectId')
  async getJobsByProject(@Param('projectId') projectId: string) {
    return this.aiService.getJobsByProject(projectId);
  }

  @Get('generation-jobs/:id')
  async getJob(@Param('id') id: string) {
    return this.aiService.getJob(id);
  }

  @Patch('generation-jobs/:id/cancel')
  async cancelJob(@Param('id') id: string) {
    return this.aiService.cancelJob(id);
  }
}
