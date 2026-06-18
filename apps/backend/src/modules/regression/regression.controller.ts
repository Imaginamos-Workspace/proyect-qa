import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RegressionService } from './regression.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

/**
 * Disparo de regresión desde el portal. Mismo guard que el resto del dashboard
 * (SupabaseAuthGuard = sesión válida + lista blanca), así solo el equipo logueado
 * puede gatillar Actions.
 */
@Controller('regression')
@UseGuards(SupabaseAuthGuard)
export class RegressionController {
  constructor(private readonly regression: RegressionService) {}

  /** Dispara qa-regression.yml para un cliente (suite por defecto: e2e). */
  @Post(':slug/run')
  run(@Param('slug') slug: string, @Body() body: { suite?: string }) {
    return this.regression.run(slug, body?.suite);
  }

  /** Últimas corridas del workflow (estado/enlace para el widget). */
  @Get('runs')
  listRuns(@Query('limit') limit?: string) {
    return this.regression.listRuns(limit ? Number(limit) : 5);
  }
}
