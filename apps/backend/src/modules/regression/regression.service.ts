import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Dispara la regresión de un cliente desde el portal (botón ▶ del widget de avance).
 *
 * Flujo: portal → workflow_dispatch de `qa-regression.yml` en el monorepo →
 * Actions corre Playwright → qa-summary.mjs empuja el resumen al portal (/ingest)
 * → el widget se actualiza solo. El botón SOLO inicia el pipeline que ya existe.
 *
 * El input `project` del workflow es un `choice`: el slug debe coincidir con una de
 * sus opciones (cliente con proyecto en el monorepo) o GitHub responde 422.
 */
const GITHUB_API = 'https://api.github.com';
const WORKFLOW_FILE = 'qa-regression.yml';
// Espejo de los `type: choice` de qa-regression.yml (input `suite`).
const ALLOWED_SUITES = ['e2e', 'perf', 'security', 'mobile-android', 'both'] as const;
type Suite = (typeof ALLOWED_SUITES)[number];

export interface RegressionRun {
  id: number;
  status: string | null; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null (en curso)
  event: string;
  url: string;
  created_at: string;
  display_title: string;
}

@Injectable()
export class RegressionService {
  private readonly logger = new Logger(RegressionService.name);
  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;

  constructor(private readonly config: ConfigService) {
    this.owner = config.get<string>('GITHUB_PROJECT_OWNER') ?? 'Imaginamos-Workspace';
    this.repo = config.get<string>('GITHUB_MONOREPO') ?? 'qa-automation-monorepo';
    this.ref = config.get<string>('GITHUB_MONOREPO_REF') ?? 'main';
  }

  private token(): string {
    // Necesita scope Actions:write sobre el monorepo. Reutiliza el PAT de escritura
    // del portal (asignaciones de board); cae al de lectura si no hay uno separado.
    const token = process.env.GITHUB_WRITE_TOKEN || this.config.get<string>('GITHUB_TOKEN');
    if (!token) {
      throw new ServiceUnavailableException(
        'GitHub token no configurado en el servidor (GITHUB_WRITE_TOKEN/GITHUB_TOKEN).',
      );
    }
    return token;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'qa-portal-regression',
    };
  }

  private normalizeSuite(suite?: string): Suite {
    const s = (suite ?? 'e2e').trim();
    if (!ALLOWED_SUITES.includes(s as Suite)) {
      throw new BadRequestException(
        `Suite inválida: "${s}". Permitidas: ${ALLOWED_SUITES.join(', ')}.`,
      );
    }
    return s as Suite;
  }

  /** Dispara qa-regression.yml para un cliente. Devuelve el enlace a Actions. */
  async run(slug: string, suite?: string): Promise<{ ok: true; suite: Suite; actions_url: string }> {
    const project = (slug ?? '').trim();
    if (!project) throw new BadRequestException('Falta el slug del cliente.');
    const chosen = this.normalizeSuite(suite);

    const url = `${GITHUB_API}/repos/${this.owner}/${this.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ref: this.ref, inputs: { project, suite: chosen } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.error(`workflow_dispatch falló (${project}/${chosen}): ${String(err)}`);
      throw new ServiceUnavailableException('No se pudo contactar a GitHub Actions.');
    }

    if (res.status === 204) {
      this.logger.log(`Regresión disparada: ${project} · ${chosen}`);
      return {
        ok: true,
        suite: chosen,
        actions_url: `https://github.com/${this.owner}/${this.repo}/actions/workflows/${WORKFLOW_FILE}`,
      };
    }

    const detail = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new UnauthorizedException(
        'El token del portal no puede disparar Actions (necesita scope Actions:write sobre el monorepo). Configurá GITHUB_WRITE_TOKEN en qa-backend.',
      );
    }
    if (res.status === 422) {
      throw new BadRequestException(
        `GitHub rechazó la corrida (422): el cliente "${project}" no es una opción del workflow, o la rama/inputs son inválidos.`,
      );
    }
    this.logger.error(`workflow_dispatch ${res.status}: ${detail}`);
    throw new ServiceUnavailableException(`GitHub respondió ${res.status} al disparar la regresión.`);
  }

  /** Últimas corridas del workflow (para reflejar el estado en el widget). */
  async listRuns(limit = 5): Promise<RegressionRun[]> {
    const per = Math.min(Math.max(limit, 1), 20);
    const url = `${GITHUB_API}/repos/${this.owner}/${this.repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${per}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      this.logger.warn(`No se pudieron leer las corridas: ${String(err)}`);
      return [];
    }
    if (!res.ok) {
      this.logger.warn(`runs ${res.status} al leer corridas del workflow`);
      return [];
    }
    const json = (await res.json()) as { workflow_runs?: RawRun[] };
    return (json.workflow_runs ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      event: r.event,
      url: r.html_url,
      created_at: r.created_at,
      display_title: r.display_title ?? r.name ?? 'QA Regression',
    }));
  }
}

interface RawRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  event: string;
  html_url: string;
  created_at: string;
  display_title?: string;
  name?: string;
}
