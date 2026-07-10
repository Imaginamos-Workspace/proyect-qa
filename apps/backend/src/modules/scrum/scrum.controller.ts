import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ScrumService } from './scrum.service';
import { RolesService } from './roles.service';
import { EvidenceService } from './evidence.service';
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import {
  CreateIssueDto,
  SetDatesDto,
  CarryOverDto,
  AssignSprintDto,
  EvidenceUploadUrlDto,
  AddEvidenceDto,
} from './dto/create-issue.dto';

import { type AuthedUser, emailOf, githubLoginOf } from '../auth/github-identity';

// El guard pone el usuario de Supabase en request.user. El login de GitHub sale
// de la identidad OAuth (NO de user_metadata, que el propio usuario puede
// editar — ver github-identity.ts). El email identifica a un QA SIN GitHub.
interface RequestWithUser {
  user?: AuthedUser;
}

function githubLogin(req: RequestWithUser): string | null {
  return githubLoginOf(req.user);
}

function userEmail(req: RequestWithUser): string | null {
  return emailOf(req.user);
}

@Controller('scrum')
@UseGuards(SupabaseAuthGuard)
export class ScrumController {
  constructor(
    private readonly scrum: ScrumService,
    private readonly roles: RolesService,
    private readonly evidence: EvidenceService,
  ) {}

  /** Clientes con board disponible. */
  @Get('boards')
  listBoards() {
    return this.scrum.listBoards();
  }

  /** El usuario actual: identidad (login de GitHub O email), roles (team.json) y
   *  permisos. Resuelve por email para el QA sin GitHub (login por contraseña).
   *  El frontend usa `canMove`/`canUploadEvidence` para habilitar acciones. */
  @Get('me')
  async me(@Req() req: RequestWithUser) {
    const login = githubLogin(req);
    const email = userEmail(req);
    const [actor, canMove, canUploadEvidence] = await Promise.all([
      this.roles.resolveActor(login, email),
      this.roles.canMove(login, email),
      this.roles.canUploadEvidence(login, email),
    ]);
    return {
      login: actor.githubLogin,
      email,
      displayName: actor.displayName,
      roles: actor.roles,
      canMove,
      canUploadEvidence,
    };
  }

  /** Board normalizado de un cliente (kanban tipo Jira). */
  @Get('boards/:slug')
  getBoard(@Param('slug') slug: string) {
    return this.scrum.getBoard(slug);
  }

  /** Opciones del formulario de creación (tipos/áreas/prioridades/estimaciones/sprints). */
  @Get('boards/:slug/meta')
  meta(@Param('slug') slug: string) {
    return this.scrum.getCreateMeta(slug);
  }

  /** Detalle completo de un issue (cuerpo + comentarios + jerarquía) — panel
   *  lateral tipo Jira. Solo lectura, cualquier usuario logueado. */
  @Get('boards/:slug/issues/:number/detail')
  issueDetail(@Param('slug') slug: string, @Param('number') number: string) {
    return this.scrum.getIssueDetail(slug, Number(number));
  }

  /** URL firmada para subir un archivo de evidencia DIRECTO a la storage (evita
   *  el límite de body de Vercel). Solo roles de ejecución (QA/TL/PM/dev/devops),
   *  por login de GitHub o por email (QA sin GitHub). */
  @Post('boards/:slug/issues/:number/evidence/upload-url')
  async evidenceUploadUrl(
    @Param('slug') slug: string,
    @Param('number') number: string,
    @Body() body: EvidenceUploadUrlDto,
    @Req() req: RequestWithUser,
  ) {
    await this.requireEvidence(req);
    return this.evidence.createUploadUrl(slug, Number(number), body.filename);
  }

  /** Publica comentario + evidencias (links a la storage) en el issue del
   *  cliente, atribuido al QA real. Escribe con el token de servicio. */
  @Post('boards/:slug/issues/:number/evidence')
  async addEvidence(
    @Param('slug') slug: string,
    @Param('number') number: string,
    @Body() body: AddEvidenceDto,
    @Req() req: RequestWithUser,
  ) {
    const actor = await this.requireEvidence(req);
    // El detalle del issue (con sus comentarios) se lee en vivo de GitHub en
    // cada carga — no hay caché que invalidar; el comentario nuevo aparece solo.
    return this.evidence.postEvidenceComment(slug, Number(number), {
      comment: body.comment ?? '',
      files: body.files ?? [],
      actorName: actor.displayName,
    });
  }

  /** Rol de evidencia (QA/TL/PM/dev/devops) o 403. Devuelve el actor resuelto
   *  (por login de GitHub o email) para atribuir el comentario. */
  private async requireEvidence(req: RequestWithUser) {
    const login = githubLogin(req);
    const email = userEmail(req);
    if (!(await this.roles.canUploadEvidence(login, email))) {
      throw new ForbiddenException('Tu rol no tiene permiso para cargar evidencia en el board.');
    }
    return this.roles.resolveActor(login, email);
  }

  /** Crea un issue (cualquier tipo) en GitHub + el board, con autor = creador.
   *  Cualquier usuario logueado puede crear; la metodología la valida el servicio. */
  @Post('boards/:slug/issues')
  create(@Param('slug') slug: string, @Body() body: CreateIssueDto, @Req() req: RequestWithUser) {
    return this.scrum.createIssue(slug, githubLogin(req), body);
  }

  /** Cambia las fechas Inicio/Fin de un issue (drag-resize del roadmap). */
  @Post('boards/:slug/issues/:number/dates')
  setDates(@Param('slug') slug: string, @Param('number') number: string, @Body() body: SetDatesDto) {
    return this.scrum.setIssueDates(slug, Number(number), body);
  }

  // ── Ciclo de vida de sprints (iniciar/cerrar + carry-over) ──────────────
  /** Estados de los sprints del cliente (activo/cerrado + velocidad). */
  @Get('boards/:slug/sprints')
  sprintStates(@Param('slug') slug: string) {
    return this.scrum.listSprintStates(slug);
  }

  /** Inicia (activa) un sprint. */
  @Post('boards/:slug/sprints/:title/start')
  startSprint(@Param('slug') slug: string, @Param('title') title: string) {
    return this.scrum.startSprint(slug, title);
  }

  /** Estado de cierre: issues sin terminar + velocidad. El front lo usa para el guard. */
  @Get('boards/:slug/sprints/:title/status')
  sprintStatus(@Param('slug') slug: string, @Param('title') title: string) {
    return this.scrum.getSprintStatus(slug, title);
  }

  /** Mueve issues a un sprint destino (carry-over). `to` opcional = siguiente sprint.
   *  Gateado por ROL, igual que `move` — también escribe en GitHub. */
  @Post('boards/:slug/sprints/:title/carry-over')
  async carryOver(
    @Param('slug') slug: string,
    @Param('title') title: string,
    @Body() body: CarryOverDto,
    @Req() req: RequestWithUser,
  ) {
    if (!(await this.roles.canMove(githubLogin(req), userEmail(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para mover tarjetas de sprint.');
    }
    return this.scrum.carryOverIssues(slug, title, body.issues, body.to);
  }

  /** Asigna/cambia el sprint de UN issue puntual (dropdown por tarjeta).
   *  Gateado por ROL, igual que `move`/`carryOver`. */
  @Post('boards/:slug/issues/:number/sprint')
  async assignSprint(
    @Param('slug') slug: string,
    @Param('number') number: string,
    @Body() body: AssignSprintDto,
    @Req() req: RequestWithUser,
  ) {
    if (!(await this.roles.canMove(githubLogin(req), userEmail(req)))) {
      throw new ForbiddenException('Tu rol no tiene permiso para cambiar el sprint de una tarjeta.');
    }
    return this.scrum.assignSprint(slug, Number(number), body.title);
  }

  /** Cierra un sprint (bloquea si hay tareas sin finalizar). */
  @Post('boards/:slug/sprints/:title/close')
  closeSprint(@Param('slug') slug: string, @Param('title') title: string) {
    return this.scrum.closeSprint(slug, title);
  }

  /** Asigna/desasigna un responsable a un issue (login null = quitar). */
  @Post('boards/:slug/assign')
  assign(
    @Param('slug') slug: string,
    @Body() body: { issue: number; login: string | null },
  ) {
    return this.scrum.assignIssue(slug, Number(body.issue), body.login ?? null);
  }

  /** Mueve una tarjeta a otra columna (cambia el Status), como arrastrar en Jira.
   *  Gateado por ROL: solo roles de ejecución (team.json del monorepo) pueden. */
  @Post('boards/:slug/move')
  async move(
    @Param('slug') slug: string,
    @Body() body: { issue: number; status: string },
    @Req() req: RequestWithUser,
  ) {
    const login = githubLogin(req);
    if (!(await this.roles.canMove(login))) {
      throw new ForbiddenException(
        'Tu rol no tiene permiso para mover tarjetas en el board.',
      );
    }
    return this.scrum.moveCard(slug, Number(body.issue), String(body.status));
  }
}
