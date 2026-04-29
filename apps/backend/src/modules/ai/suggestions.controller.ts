import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { SuggestionsService } from './suggestions.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { AISuggestExploreRequest } from '../../shared-types';

@Controller('ai/suggestions')
@UseGuards(SupabaseAuthGuard)
export class SuggestionsController {
  constructor(private readonly suggestions: SuggestionsService) {}

  @Get('project/:projectId')
  async listForProject(
    @Param('projectId') projectId: string,
    @Query('all') all?: string,
  ) {
    return this.suggestions.findByProject(projectId, {
      includeAll: all === 'true' || all === '1',
    });
  }

  @Post('explore')
  async explore(@Body() body: AISuggestExploreRequest) {
    return this.suggestions.exploreAndSuggest(body);
  }

  @Post(':id/dismiss')
  async dismiss(@Param('id') id: string) {
    return this.suggestions.dismiss(id);
  }

  @Post(':id/convert')
  async convert(@Param('id') id: string) {
    return this.suggestions.convertToTestCase(id);
  }

  @Delete(':id')
  async hardDelete(@Param('id') id: string) {
    await this.suggestions.hardDelete(id);
    return { ok: true };
  }
}
