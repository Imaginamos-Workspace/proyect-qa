import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SalesService } from './sales.service';
import { ProspectsService } from './prospects.service';
import { RolesService } from '../scrum/roles.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CreateOpportunityDto, HandoffDto, MarkNotificationsSeenDto, SearchProspectsDto, SendMessageDto, TransferOpportunityDto } from './dto/sales.dto';

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
    private readonly prospects: ProspectsService,
    private readonly roles: RolesService,
  ) {}

  /** Notificaciones del pipeline del que consulta (el TL publicó la propuesta,
   *  negociación, ganada, congelada…), con CTA a la acción que sigue. */
  @Get('notifications')
  notifications(@Req() req: RequestWithUser) {
    return this.sales.listNotifications(githubLogin(req));
  }

  /** Marca notificaciones como vistas (todas las propias, o solo `ids`). */
  @Post('notifications/seen')
  markNotificationsSeen(@Body() body: MarkNotificationsSeenDto, @Req() req: RequestWithUser) {
    return this.sales.markNotificationsSeen(githubLogin(req), body.ids);
  }

  /** ¿Está configurada la API key de Apollo? Lectura abierta a autenticados —
   *  el frontend decide si muestra el buscador o la guía de configuración. */
  @Get('prospects/status')
  prospectsStatus() {
    return this.prospects.status();
  }

  /** Busca prospectos B2B en Apollo.io. Solo vendedor (consume cuota del plan). */
  @Post('prospects/search')
  async searchProspects(@Body() body: SearchProspectsDto, @Req() req: RequestWithUser) {
    await this.requireSeller(req);
    return this.prospects.search(body);
  }

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

  /** Detalle: draft + historial. El historial solo viaja si el que consulta es
   *  el dueño (o si el proceso no tiene dueño). Lectura abierta a autenticados
   *  — el candado por propiedad lo aplica el service. */
  @Get('opportunities/:id')
  get(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.sales.getOpportunityDetail(id, githubLogin(req));
  }

  /** Vendedores elegibles para recibir un proceso cedido (team.json). */
  @Get('vendedores')
  vendedores() {
    return this.roles.listVendedores();
  }

  /** Reconstruye la base de conocimiento del RAG (metodología + negocios
   *  ganados). Idempotente. Solo vendedor. */
  @Post('rag/reindex')
  async reindexKnowledge(@Req() req: RequestWithUser) {
    await this.requireSeller(req);
    return this.sales.reindexKnowledge();
  }

  /** Link + contraseña de la propuesta ya generada (si existe). El service
   *  bloquea si el proceso es de otro vendedor (la contraseña es sensible). */
  @Get('opportunities/:id/proposal')
  getProposal(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.sales.getProposalAccess(id, githubLogin(req));
  }

  /** Total de aperturas + última fecha. Bloqueado a procesos ajenos. */
  @Get('opportunities/:id/proposal/metrics')
  getProposalMetrics(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.sales.getProposalMetrics(id, githubLogin(req));
  }

  /** Regenera la contraseña y vuelve a publicar (dispara CI). Solo el dueño. */
  @Post('opportunities/:id/proposal/regenerate')
  async regenerateProposal(@Param('id') id: string, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    return this.sales.regenerateProposalPassword(id, login);
  }

  /** Envía un mensaje del vendedor; el LLM responde y actualiza el draft. Solo el dueño. */
  @Post('opportunities/:id/messages')
  async sendMessage(@Param('id') id: string, @Body() body: SendMessageDto, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    return this.sales.sendMessage(id, body.content, login);
  }

  /** Renderiza el draft a brief.md y lo escribe en el monorepo. Solo el dueño. */
  @Post('opportunities/:id/sync-brief')
  async syncBrief(@Param('id') id: string, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    return this.sales.syncBrief(id, login);
  }

  /** Sincroniza el brief, pasa status.md a "propuesta-en-armado" y asigna el
   *  Owner TL elegido por el vendedor (rules/13 §Cerrar el brief). Solo el dueño. */
  @Post('opportunities/:id/handoff')
  async handoff(@Param('id') id: string, @Body() body: HandoffDto, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    return this.sales.handoff(id, login, body.tlLogin);
  }

  /** Team Leads elegibles para recibir el handoff (team.json). */
  @Get('tls')
  tls() {
    return this.roles.listTls();
  }

  /** Reclama un proceso sin dueño ('desconocido'/legacy). Solo vendedor. */
  @Post('opportunities/:id/claim')
  async claim(@Param('id') id: string, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    if (!login) throw new ForbiddenException('No se pudo identificar tu usuario de GitHub.');
    return this.sales.claimOpportunity(id, login);
  }

  /** Cede el proceso a otro vendedor (el histórico viaja con él). Solo el dueño;
   *  el destino debe ser un vendedor de team.json. */
  @Post('opportunities/:id/transfer')
  async transfer(@Param('id') id: string, @Body() body: TransferOpportunityDto, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    if (!login) throw new ForbiddenException('No se pudo identificar tu usuario de GitHub.');
    if (!(await this.roles.canSell(body.toLogin))) {
      throw new ForbiddenException(`@${body.toLogin} no es un vendedor — solo se puede ceder a otro vendedor.`);
    }
    return this.sales.transferOpportunity(id, login, body.toLogin);
  }

  /** Borra la oportunidad COMPLETA: archivos del monorepo + fila de Supabase.
   *  No es reversible desde la plataforma. Solo el dueño. */
  @Delete('opportunities/:id')
  async remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    const login = await this.requireSeller(req);
    return this.sales.deleteOpportunity(id, login);
  }

  /** Rol vendedor o 403. Devuelve el login para que el service verifique la
   *  propiedad del proceso (rol ≠ dueño: ambos gates se aplican). */
  private async requireSeller(req: RequestWithUser): Promise<string | null> {
    const login = githubLogin(req);
    if (!(await this.roles.canSell(login))) {
      throw new ForbiddenException('Tu rol no tiene permiso para operar el módulo de ventas.');
    }
    return login;
  }
}
