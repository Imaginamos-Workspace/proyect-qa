import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SalesService } from './sales.service';
import { RolesService } from '../scrum/roles.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CreateOpportunityDto, SendMessageDto } from './dto/sales.dto';

interface RequestWithUser {
  user?: { user_metadata?: Record<string, unknown> };
}

function githubLogin(req: RequestWithUser): string | null {
  const m = req.user?.user_metadata ?? {};
  return (
    (m.user_name as string) ||
    (m.preferred_username as string) ||
    (m.nickname as string) ||
    null
  );
}

@Controller('sales')
@UseGuards(SupabaseAuthGuard)
export class SalesController {
  constructor(
    private readonly sales: SalesService,
    private readonly roles: RolesService,
  ) {}

  /** Lista de oportunidades — lectura abierta a cualquier autenticado, igual que el board. */
  @Get('opportunities')
  list() {
    return this.sales.listOpportunities();
  }

  /** Crea la oportunidad (fila + scaffold completo en el monorepo). Solo vendedor. */
  @Post('opportunities')
  async create(@Body() body: CreateOpportunityDto, @Req() req: RequestWithUser) {
    const login = githubLogin(req);
    if (!(await this.roles.canSell(login))) {
      throw new ForbiddenException('Tu rol no tiene permiso para crear oportunidades de venta.');
    }
    if (!login) throw new ForbiddenException('No se pudo identificar tu usuario de GitHub.');
    return this.sales.createOpportunity(body.cliente, body.oportunidad, login);
  }

  /** Detalle: draft + historial de mensajes. */
  @Get('opportunities/:id')
  get(@Param('id') id: string) {
    return this.sales.getOpportunity(id);
  }

  /** Link + contraseña de la propuesta ya generada (si existe). Lectura
   *  abierta, igual que el detalle. */
  @Get('opportunities/:id/proposal')
  getProposal(@Param('id') id: string) {
    return this.sales.getProposalAccess(id);
  }

  /** Total de aperturas + última fecha. Lectura abierta. */
  @Get('opportunities/:id/proposal/metrics')
  getProposalMetrics(@Param('id') id: string) {
    return this.sales.getProposalMetrics(id);
  }

  /** Regenera la contraseña y vuelve a publicar (dispara CI). Solo vendedor. */
  @Post('opportunities/:id/proposal/regenerate')
  async regenerateProposal(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!(await this.roles.canSell(githubLogin(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para regenerar la contraseña de la propuesta.');
    }
    return this.sales.regenerateProposalPassword(id);
  }

  /** Envía un mensaje del vendedor; el LLM responde y actualiza el draft. Solo vendedor. */
  @Post('opportunities/:id/messages')
  async sendMessage(@Param('id') id: string, @Body() body: SendMessageDto, @Req() req: RequestWithUser) {
    if (!(await this.roles.canSell(githubLogin(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para operar el módulo de ventas.');
    }
    return this.sales.sendMessage(id, body.content);
  }

  /** Renderiza el draft a brief.md y lo escribe en el monorepo. Solo vendedor. */
  @Post('opportunities/:id/sync-brief')
  async syncBrief(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!(await this.roles.canSell(githubLogin(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para sincronizar el brief.');
    }
    return this.sales.syncBrief(id);
  }

  /** Sincroniza el brief y pasa status.md a "propuesta-en-armado" (handoff al TL). Solo vendedor. */
  @Post('opportunities/:id/handoff')
  async handoff(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!(await this.roles.canSell(githubLogin(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para pasar la oportunidad al TL.');
    }
    return this.sales.handoff(id);
  }

  /** Borra la oportunidad COMPLETA: archivos del monorepo + fila de Supabase.
   *  No es reversible desde la plataforma. Solo vendedor. */
  @Delete('opportunities/:id')
  async remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!(await this.roles.canSell(githubLogin(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para eliminar oportunidades.');
    }
    return this.sales.deleteOpportunity(id);
  }
}
