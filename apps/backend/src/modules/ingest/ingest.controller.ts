import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IngestService } from './ingest.service';
import { IngestApiKeyGuard } from './guards/ingest-api-key.guard';
import { Public } from '../auth/decorators/public.decorator';
import { IngestRunDto, IngestActivityDto, IngestUniverseDto, IngestCredentialsDto } from './dto/ingest-run.dto';

/**
 * Endpoints de ingesta máquina-a-máquina. Los llama el CI del monorepo, no un
 * usuario: por eso van con @Public() (sin JWT de Supabase) + IngestApiKeyGuard
 * (header X-Ingest-Key).
 */
@Controller('ingest')
@Public()
@UseGuards(IngestApiKeyGuard)
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post('runs')
  ingestRun(@Body() dto: IngestRunDto) {
    return this.ingestService.ingestRun(dto);
  }

  @Post('activity')
  ingestActivity(@Body() dto: IngestActivityDto) {
    return this.ingestService.ingestActivity(dto);
  }

  @Post('universe')
  ingestUniverse(@Body() dto: IngestUniverseDto) {
    return this.ingestService.ingestUniverse(dto);
  }

  @Post('credentials')
  ingestCredentials(@Body() dto: IngestCredentialsDto) {
    return this.ingestService.ingestCredentials(dto);
  }
}
