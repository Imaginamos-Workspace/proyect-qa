import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TeamMember {
  github_user: string;
  name?: string;
  email?: string | null;
  allowed_roles?: string[];
  active?: boolean;
}

// Fuente ÚNICA de roles: el team.json del monorepo (rules/01-roles.md). El portal
// lo LEE directo (no mantiene copia) → sincronía estricta, cero drift.
const TEAM_REPO = 'Imaginamos-Workspace/qa-automation-monorepo';
const TEAM_PATH = 'team.json';
const CACHE_TTL_MS = 60_000;

// Roles que pueden MOVER tarjetas (cambiar Status) en el board. Espejo del modelo
// de rules/01 del monorepo: los roles de EJECUCIÓN que trabajan el board día a día.
// vendedor / designer / stakeholder solo ven. Ajustable acá.
const MOVE_ROLES = new Set(['tl', 'pm', 'qa', 'dev', 'devops']);

// Rol que puede operar el módulo de Ventas (chatear el brief, sincronizar al
// monorepo, hacer el handoff a TL). Espejo del mismo modelo de rules/01.
const SELL_ROLES = new Set(['vendedor']);

// Roles que pueden cargar evidencia y comentar en un issue del board desde la
// plataforma (mismo set de EJECUCIÓN que mueve tarjetas — el QA es el caso
// principal, pero TL/PM/dev/devops también trabajan el board).
const EVIDENCE_ROLES = MOVE_ROLES;

/** Identidad resuelta de quien hace una acción — sirve para autorizar Y para
 *  atribuir en el contenido (el comentario que se postea a GitHub). Un QA sin
 *  GitHub se resuelve por email (team.json ya trae el email por miembro). */
export interface ResolvedActor {
  githubLogin: string | null;
  displayName: string;
  roles: string[];
}

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);
  private readonly token: string | undefined;
  private cache: { ts: number; byUser: Map<string, TeamMember>; byEmail: Map<string, TeamMember> } | null = null;

  constructor(config: ConfigService) {
    // Lectura del repo privado: GITHUB_TOKEN (read) o el write si está elevado.
    this.token = config.get<string>('GITHUB_TOKEN') || process.env.GITHUB_WRITE_TOKEN;
  }

  /** Roles autorizados de un usuario de GitHub (login), desde team.json del monorepo. */
  async rolesFor(login: string | null | undefined): Promise<string[]> {
    if (!login) return [];
    const team = await this.load();
    const m = team.get(login.toLowerCase());
    return m && m.active !== false ? m.allowed_roles ?? [] : [];
  }

  /** Miembro activo de team.json por login de GitHub O por email (para QA sin
   *  GitHub, que se loguea con email/contraseña). El login tiene prioridad. */
  private async memberFor(login: string | null, email: string | null): Promise<TeamMember | null> {
    await this.load();
    const byUser = this.cache!.byUser;
    const byEmail = this.cache!.byEmail;
    const m =
      (login ? byUser.get(login.toLowerCase()) : undefined) ??
      (email ? byEmail.get(email.toLowerCase()) : undefined);
    return m && m.active !== false ? m : null;
  }

  /** Resuelve la identidad de quien actúa (login de GitHub o email). Devuelve
   *  roles + un displayName para atribuir en el contenido posteado a GitHub. */
  async resolveActor(login: string | null, email: string | null): Promise<ResolvedActor> {
    const m = await this.memberFor(login, email);
    const displayName =
      m?.name?.trim() ||
      (m?.github_user ? `@${m.github_user}` : null) ||
      (login ? `@${login}` : null) ||
      email ||
      'usuario de la plataforma';
    return {
      githubLogin: m?.github_user ?? login ?? null,
      displayName,
      roles: m?.allowed_roles ?? [],
    };
  }

  /** ¿Puede cargar evidencia / comentar en un issue del board? (por login o email) */
  async canUploadEvidence(login: string | null, email: string | null): Promise<boolean> {
    const m = await this.memberFor(login, email);
    return (m?.allowed_roles ?? []).some((r) => EVIDENCE_ROLES.has(r));
  }

  /** ¿El usuario puede mover tarjetas (cambiar Status) en el board? Resuelve por
   *  login de GitHub O por email (para roles que entran a la plataforma sin
   *  GitHub) — mismo criterio que /scrum/me y que la carga de evidencia. */
  async canMove(login: string | null | undefined, email: string | null = null): Promise<boolean> {
    const m = await this.memberFor(login ?? null, email);
    return (m?.allowed_roles ?? []).some((r) => MOVE_ROLES.has(r));
  }

  /** ¿El usuario puede operar el módulo de Ventas? */
  async canSell(login: string | null | undefined): Promise<boolean> {
    const roles = await this.rolesFor(login);
    return roles.some((r) => SELL_ROLES.has(r));
  }

  /** Vendedores activos de team.json — para el selector de "ceder proceso".
   *  Devuelve login + nombre (si team.json lo tiene). */
  async listVendedores(): Promise<{ login: string; name: string | null }[]> {
    const team = await this.load();
    const out: { login: string; name: string | null }[] = [];
    for (const m of team.values()) {
      if (m.active === false) continue;
      if ((m.allowed_roles ?? []).some((r) => SELL_ROLES.has(r))) {
        out.push({ login: m.github_user, name: m.name ?? null });
      }
    }
    return out.sort((a, b) => (a.name ?? a.login).localeCompare(b.name ?? b.login));
  }

  private async load(): Promise<Map<string, TeamMember>> {
    if (this.cache && Date.now() - this.cache.ts < CACHE_TTL_MS) return this.cache.byUser;
    const byUser = new Map<string, TeamMember>();
    const byEmail = new Map<string, TeamMember>();
    try {
      const res = await fetch(`https://api.github.com/repos/${TEAM_REPO}/contents/${TEAM_PATH}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.raw+json',
          'User-Agent': 'qa-portal-roles',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GitHub contents ${res.status}`);
      const json = JSON.parse(await res.text()) as { members?: TeamMember[] };
      for (const m of json.members ?? []) {
        if (m.github_user) byUser.set(m.github_user.toLowerCase(), m);
        if (m.email) byEmail.set(m.email.toLowerCase(), m); // QA sin GitHub → resuelto por email
      }
    } catch (err) {
      // Fail-closed: si no se puede leer team.json, nadie tiene roles → nadie mueve.
      this.logger.error(`No se pudo leer team.json del monorepo: ${(err as Error).message}`);
    }
    this.cache = { ts: Date.now(), byUser, byEmail };
    return byUser;
  }
}
