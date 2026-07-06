import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TeamMember {
  github_user: string;
  name?: string;
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

@Injectable()
export class RolesService {
  private readonly logger = new Logger(RolesService.name);
  private readonly token: string | undefined;
  private cache: { ts: number; byUser: Map<string, TeamMember> } | null = null;

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

  /** ¿El usuario puede mover tarjetas (cambiar Status) en el board? */
  async canMove(login: string | null | undefined): Promise<boolean> {
    const roles = await this.rolesFor(login);
    return roles.some((r) => MOVE_ROLES.has(r));
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
      }
    } catch (err) {
      // Fail-closed: si no se puede leer team.json, nadie tiene roles → nadie mueve.
      this.logger.error(`No se pudo leer team.json del monorepo: ${(err as Error).message}`);
    }
    this.cache = { ts: Date.now(), byUser };
    return byUser;
  }
}
