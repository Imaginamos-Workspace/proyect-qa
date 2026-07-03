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
import { SupabaseAuthGuard } from '../auth/guards/supabase-auth.guard';
import { CreateIssueDto, SetDatesDto, CarryOverDto, AssignSprintDto } from './dto/create-issue.dto';

// El guard pone el usuario de Supabase en request.user. De GitHub OAuth, el login
// viene en user_metadata (user_name / preferred_username).
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

@Controller('scrum')
@UseGuards(SupabaseAuthGuard)
export class ScrumController {
  constructor(
    private readonly scrum: ScrumService,
    private readonly roles: RolesService,
  ) {}

  /** Clientes con board disponible. */
  @Get('boards')
  listBoards() {
    return this.scrum.listBoards();
  }

  /** El usuario actual: login de GitHub, sus roles (team.json del monorepo) y si
   *  puede mover tarjetas. El frontend usa `canMove` para habilitar el drag. */
  @Get('me')
  async me(@Req() req: RequestWithUser) {
    const login = githubLogin(req);
    const [roles, canMove] = await Promise.all([
      this.roles.rolesFor(login),
      this.roles.canMove(login),
    ]);
    return { login, roles, canMove };
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
    if (!(await this.roles.canMove(githubLogin(req)))) {
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
    if (!(await this.roles.canMove(githubLogin(req)))) {
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
