import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ScrumService } from './scrum.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';

@Controller('scrum')
@UseGuards(SupabaseAuthGuard)
export class ScrumController {
  constructor(private readonly scrum: ScrumService) {}

  /** Clientes con board disponible. */
  @Get('boards')
  listBoards() {
    return this.scrum.listBoards();
  }

  /** Board normalizado de un cliente (kanban tipo Jira). */
  @Get('boards/:slug')
  getBoard(@Param('slug') slug: string) {
    return this.scrum.getBoard(slug);
  }

  /** Asigna/desasigna un responsable a un issue (login null = quitar). */
  @Post('boards/:slug/assign')
  assign(
    @Param('slug') slug: string,
    @Body() body: { issue: number; login: string | null },
  ) {
    return this.scrum.assignIssue(slug, Number(body.issue), body.login ?? null);
  }
}
