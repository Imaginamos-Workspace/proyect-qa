import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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
}
