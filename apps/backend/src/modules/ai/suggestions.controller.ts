import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
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
    try {
      return await this.suggestions.exploreAndSuggest(body);
    } catch (err) {
      // Map common Gemini errors to actionable HTTP statuses so the UI
      // can show a friendly message instead of a generic 500.
      const message = err instanceof Error ? err.message : String(err);
      if (/cuota.*agotada|429/i.test(message)) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message:
              'La cuota diaria de Gemini está agotada. Espera al reset o configura un API key con más cuota.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (/sobrecargado|503/i.test(message)) {
        throw new ServiceUnavailableException(
          'Gemini está sobrecargado en este momento. Intenta de nuevo en 5-10 minutos.',
        );
      }
      throw err;
    }
  }

  @Post(':id/dismiss')
  async dismiss(@Param('id') id: string) {
    return this.suggestions.dismiss(id);
  }

  @Post(':id/convert')
  async convert(@Param('id') id: string) {
    try {
      return await this.suggestions.convertToTestCase(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cuota.*agotada|429/i.test(message)) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message:
              'Cuota AI agotada en todos los proveedores. Espera al reset diario o configura más API keys.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (/sobrecargado|503/i.test(message)) {
        throw new ServiceUnavailableException(
          'Los proveedores AI están sobrecargados. Intenta de nuevo en 5-10 minutos.',
        );
      }
      if (/syntax errors|invalid JSON/i.test(message)) {
        throw new HttpException(
          {
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            message: `La IA no pudo generar código válido para esta sugerencia tras varios intentos. Detalle: ${message}`,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      throw err;
    }
  }

  @Delete(':id')
  async hardDelete(@Param('id') id: string) {
    await this.suggestions.hardDelete(id);
    return { ok: true };
  }
}
