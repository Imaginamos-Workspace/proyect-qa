import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

@Controller('dashboard')
@UseGuards(SupabaseAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('clients')
  getClients() {
    return this.dashboardService.getClients();
  }

  @Get('clients/:slug')
  async getClient(@Param('slug') slug: string) {
    const client = await this.dashboardService.getClient(slug);
    if (!client) throw new NotFoundException('Cliente no encontrado');
    return client;
  }

  @Get('activity')
  getActivity(
    @Query('actor') actor?: string,
    @Query('client') client?: string,
    @Query('limit') limit?: string,
  ) {
    return this.dashboardService.getActivity({
      actor,
      client,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('people')
  getPeople() {
    return this.dashboardService.getPeople();
  }
}
