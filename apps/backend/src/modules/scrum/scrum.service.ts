import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import type {
  ScrumAssignee,
  ScrumBoard,
  ScrumCard,
  ScrumColumn,
  ScrumEpic,
  ScrumIssueType,
  ScrumPriority,
  ScrumQaInfo,
  ScrumSprint,
} from '../../shared-types';

interface RawIteration {
  title: string;
  startDate: string | null;
  duration: number | null;
}

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
// Fallback de columnas si el board no tiene campo Status o falla la consulta. El
// orden REAL es dinámico: sale de las opciones del Status del board (fetchStatusColumns),
// sembradas desde el workflow del cliente extraído de Jira (rules/96).
const COLUMN_ORDER = ['Backlog', 'Por hacer', 'En curso', 'En revisión', 'Listo'];
// El board se invalida en cada move/assign (cache.delete), así que un TTL alto es
// seguro: solo afecta re-imports out-of-band, no la interacción del usuario.
const CACHE_TTL_MS = 5 * 60_000;
// Caché compartido en Supabase (sobrevive cold-starts de Vercel). TTL más alto:
// reconstruir desde GitHub es caro y los cambios reales ya invalidan la fila.
const SHARED_TTL_MS = 15 * 60_000;
const BOARD_CACHE_TABLE = 'scrum_board_cache';
// El número de Project de un cliente es estable; cachearlo evita listar los ~80
// proyectos de la org en cada carga en frío (resolveProject).
const PROJECT_TTL_MS = 30 * 60_000;

const TYPE_MAP: Record<string, ScrumIssueType> = {
  Épica: 'epic', Epica: 'epic', Historia: 'story', Tarea: 'task',
  Bug: 'bug', Incidencia: 'incident', Spike: 'spike',
};

function mapType(tipo: string | null): ScrumIssueType {
  if (!tipo) return 'unknown';
  return TYPE_MAP[tipo.normalize('NFC')] ?? 'unknown';
}
function mapPriority(p: string | null): ScrumPriority {
  if (!p) return null;
  if (p.includes('Alta')) return 'high';
  if (p.includes('Media')) return 'medium';
  if (p.includes('Baja')) return 'low';
  return null;
}

@Injectable()
export class ScrumService {
  private readonly logger = new Logger(ScrumService.name);
  private readonly token: string | undefined;
  private readonly owner: string;
  private readonly cache = new Map<string, { ts: number; board: ScrumBoard }>();
  private readonly projectCache = new Map<string, { ts: number; project: { number: number; url: string } }>();

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    config: ConfigService,
  ) {
    this.token = config.get<string>('GITHUB_TOKEN');
    this.owner = config.get<string>('GITHUB_PROJECT_OWNER') ?? 'Imaginamos-Workspace';
  }

  /** Clientes disponibles (mismo origen que el dashboard). */
  async listBoards() {
    const { data } = await this.supabase
      .from('qa_clients')
      .select('slug, display_name')
      .eq('enabled', true)
      .order('display_name');
    return (data ?? []).map((c) => ({ client_slug: c.slug, client_name: c.display_name }));
  }

  /** Board normalizado de un cliente (auto-descubre el GitHub Project por título). */
  async getBoard(slug: string): Promise<ScrumBoard> {
    // 1. Memoria (instancia caliente): lo más rápido, sin red.
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.board;

    // 2. Caché compartido en Supabase: sobrevive cold-starts, una lectura indexada
    //    en vez de reconstruir el board entero desde GitHub. Es la mejora clave de
    //    velocidad al ENTRAR al módulo (sobre todo clientes con muchos items).
    const shared = await this.readSharedCache(slug);
    if (shared && Date.now() - shared.ts < SHARED_TTL_MS) {
      this.cache.set(slug, { ts: Date.now(), board: shared.board });
      return shared.board;
    }

    const { data: client } = await this.supabase
      .from('qa_clients')
      .select('slug, display_name')
      .eq('slug', slug)
      .maybeSingle();

    const base: ScrumBoard = {
      client_slug: slug,
      client_name: client?.display_name ?? slug,
      configured: false,
      reason: null,
      project_number: null,
      project_url: null,
      columns: COLUMN_ORDER.map((k) => ({ key: k, title: k, cards: [] })),
      epics: [],
      sprints: [],
      sprintsMeta: [],
      members: [],
      qa: null,
      updated_at: new Date().toISOString(),
    };

    if (!client) return { ...base, reason: 'client_not_found' };
    if (!this.token) return { ...base, reason: 'missing_github_token' };

    try {
      const project = await this.resolveProject(client.display_name, slug);
      // board_not_found es transitorio (board recién creado) → solo memoria corta,
      // NO lo persistimos en el caché compartido para no enmascararlo 15 min.
      if (!project) {
        this.cache.set(slug, { ts: Date.now(), board: { ...base, reason: 'board_not_found' } });
        return { ...base, reason: 'board_not_found' };
      }
      const built = await this.buildBoard(base, project.number, project.url);
      return this.store(slug, built);
    } catch (err) {
      this.logger.error(`getBoard(${slug}) falló: ${(err as Error).message}`);
      return { ...base, reason: 'github_error' };
    }
  }

  /** Persiste el board en memoria y en el caché compartido (solo boards reales). */
  private async store(slug: string, board: ScrumBoard): Promise<ScrumBoard> {
    this.cache.set(slug, { ts: Date.now(), board });
    if (board.configured) {
      try {
        await this.supabase
          .from(BOARD_CACHE_TABLE)
          .upsert({ slug, board, updated_at: new Date().toISOString() });
      } catch (err) {
        // Si falla el upsert, el board igual se devuelve (memoria) — no rompemos.
        this.logger.warn(`No se pudo cachear el board de ${slug}: ${(err as Error).message}`);
      }
    }
    return board;
  }

  /** Lee el snapshot del board del caché compartido (Supabase). */
  private async readSharedCache(slug: string): Promise<{ ts: number; board: ScrumBoard } | null> {
    try {
      const { data } = await this.supabase
        .from(BOARD_CACHE_TABLE)
        .select('board, updated_at')
        .eq('slug', slug)
        .maybeSingle();
      if (!data?.board) return null;
      return { ts: new Date(data.updated_at as string).getTime(), board: data.board as ScrumBoard };
    } catch {
      return null; // sin acceso o tabla ausente → reconstruimos desde GitHub
    }
  }

  /** Invalida el board (memoria + caché compartido) tras un cambio real. */
  private async invalidate(slug: string): Promise<void> {
    this.cache.delete(slug);
    try {
      await this.supabase.from(BOARD_CACHE_TABLE).delete().eq('slug', slug);
    } catch {
      // si falla, el TTL del caché compartido lo refrescará igual
    }
  }

  private async gql<T>(
    query: string,
    variables: Record<string, unknown>,
    token: string | undefined = this.token,
  ): Promise<T> {
    const res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'qa-portal-scrum',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    return json.data as T;
  }

  /** Encuentra el Project del cliente por título "Cliente: <nombre>" (o que contenga el
   *  slug). Pagina TODOS los proyectos de la org (no solo los primeros 80): corta apenas
   *  hay match exacto; si no, devuelve el primer match por slug. Cachea el resultado
   *  encontrado (número estable). Un miss NO se cachea, así un board recién creado aparece. */
  private async resolveProject(displayName: string, slug: string) {
    const cached = this.projectCache.get(slug);
    if (cached && Date.now() - cached.ts < PROJECT_TTL_MS) return cached.project;

    const want = `cliente: ${displayName}`.toLowerCase();
    const wantSlug = slug.toLowerCase();
    let cursor: string | null = null;
    let includesMatch: { number: number; url: string } | null = null;

    do {
      const data: {
        organization: {
          projectsV2: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: { number: number; title: string; url: string }[];
          };
        } | null;
      } = await this.gql(PROJECTS_QUERY, { owner: this.owner, cursor });
      const conn = data.organization?.projectsV2;
      for (const n of conn?.nodes ?? []) {
        const title = n.title.toLowerCase();
        if (title === want) return this.cacheProject(slug, n); // exacto gana, corta ya
        if (!includesMatch && title.includes(wantSlug)) includesMatch = { number: n.number, url: n.url };
      }
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);

    return includesMatch ? this.cacheProject(slug, includesMatch) : null;
  }

  private cacheProject(slug: string, n: { number: number; url: string }) {
    const project = { number: n.number, url: n.url };
    this.projectCache.set(slug, { ts: Date.now(), project });
    return project;
  }

  /**
   * Columnas del kanban = opciones del campo "Status" del board, EN SU ORDEN.
   * Es DINÁMICO por cliente: refleja el workflow real de su Jira (p. ej. "Por
   * hacer", "En curso", "Pruebas QA", "Listo en Staging") en vez de una lista fija
   * en inglés. Las opciones las siembra `roadmap:sync` desde el `workflow` del
   * roadmap, extraído del export de Jira. Fallback a la lista genérica si el board
   * no tiene el campo o la consulta falla.
   */
  private async fetchStatusColumns(number: number): Promise<string[]> {
    try {
      const data = await this.gql<{
        organization: { projectV2: { field: { options?: { name: string }[] } | null } | null } | null;
      }>(
        `query($owner:String!,$number:Int!){ organization(login:$owner){ projectV2(number:$number){ field(name:"Status"){ ... on ProjectV2SingleSelectField { options { name } } } } } }`,
        { owner: this.owner, number },
      );
      const names = (data.organization?.projectV2?.field?.options ?? []).map((o) => o.name).filter(Boolean);
      return names.length ? names : COLUMN_ORDER;
    } catch {
      return COLUMN_ORDER;
    }
  }

  private async buildBoard(base: ScrumBoard, number: number, url: string): Promise<ScrumBoard> {
    // Estas 4 son independientes entre sí: en paralelo en vez de en serie (4
    // round-trips a GitHub/Supabase → 1 ola). Es la mayor ganancia de latencia.
    const [columnKeys, sprintsMeta, members, qa] = await Promise.all([
      this.fetchStatusColumns(number),
      this.fetchSprints(number),
      this.fetchMembers(base.client_slug),
      this.fetchQaInfo(base.client_slug),
    ]);
    const columns = new Map<string, ScrumColumn>(
      columnKeys.map((k) => [k, { key: k, title: k, cards: [] as ScrumCard[] }]),
    );
    const epics: ScrumEpic[] = [];
    const sprints = new Set<string>();

    let cursor: string | null = null;
    do {
      const data: any = await this.gql(ITEMS_QUERY, { owner: this.owner, number, cursor });
      const items = data.organization?.projectV2?.items;
      for (const item of items?.nodes ?? []) {
        const fields: Record<string, string> = {};
        for (const fv of item.fieldValues?.nodes ?? []) {
          const name = fv?.field?.name;
          if (!name) continue;
          if (fv.name) fields[name] = fv.name; // single-select
          else if (fv.title) fields[name] = fv.title; // iteration (Sprint)
        }
        const content = item.content ?? {};
        const type = mapType(fields['Tipo'] ?? null);
        const status = fields['Status'] ?? null;
        const sprint = fields['Sprint'] ?? null;
        if (sprint) sprints.add(sprint);

        const card: ScrumCard = {
          id: item.id,
          number: content.number ?? null,
          title: content.title ?? '(sin título)',
          url: content.url ?? null,
          type,
          status,
          area: fields['Área'] ?? fields['Area'] ?? null,
          priority: mapPriority(fields['Prioridad'] ?? null),
          estimate: fields['Estimación'] ?? fields['Estimacion'] ?? null,
          sprint,
          parent: content.parent?.number ?? null,
          labels: (content.labels?.nodes ?? []).map((l: any) => l.name),
          assignees: (content.assignees?.nodes ?? []).map((a: any) => ({
            login: a.login,
            avatarUrl: a.avatarUrl ?? null,
          })),
        };

        if (type === 'epic') {
          epics.push({ number: card.number, title: card.title, url: card.url });
        }
        const colKey = status && columns.has(status) ? status : columnKeys[0];
        columns.get(colKey)!.cards.push(card);
      }
      cursor = items?.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null;
    } while (cursor);

    return {
      ...base,
      configured: true,
      project_number: number,
      project_url: url,
      columns: columnKeys.map((k) => columns.get(k)!),
      epics,
      // Lista de sprints: preferimos la config de iteraciones (incluye vacíos y
      // respeta el orden cronológico); si falta, derivamos de los items.
      sprints: sprintsMeta.length ? sprintsMeta.map((s) => s.title) : Array.from(sprints).sort(),
      sprintsMeta,
      members,
      qa,
      updated_at: new Date().toISOString(),
    };
  }

  /** Asigna (o desasigna) un responsable a un issue del cliente. Requiere un
   *  token con permiso de ESCRITURA (Issues:write): GITHUB_WRITE_TOKEN, o el
   *  GITHUB_TOKEN si se elevó. login vacío/null = desasignar. */
  async assignIssue(slug: string, issueNumber: number, login: string | null) {
    const token = process.env.GITHUB_WRITE_TOKEN || this.token;
    if (!token) throw new Error('GitHub token no configurado en el servidor.');
    const repo = `${this.owner}/qa-${slug}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'qa-portal-scrum',
    };
    const issueUrl = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;
    const assigneesUrl = `${issueUrl}/assignees`;

    // Estado actual → dejamos como único responsable a `login` (estilo Jira).
    const cur = await fetch(issueUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!cur.ok) throw new Error(`No se pudo leer el issue #${issueNumber} (${cur.status}).`);
    const current: string[] = ((await cur.json()).assignees ?? []).map((a: { login: string }) => a.login);

    const target = login ? login.replace(/^@/, '').trim() : '';
    const toRemove = current.filter((l) => l !== target);
    if (toRemove.length) {
      await fetch(assigneesUrl, { method: 'DELETE', headers, body: JSON.stringify({ assignees: toRemove }), signal: AbortSignal.timeout(10_000) });
    }
    if (target) {
      const res = await fetch(assigneesUrl, { method: 'POST', headers, body: JSON.stringify({ assignees: [target] }), signal: AbortSignal.timeout(10_000) });
      if (res.status === 403 || res.status === 404) {
        throw new UnauthorizedException(
          'El token del portal no tiene permiso de escritura (Issues:write). Configurá GITHUB_WRITE_TOKEN en qa-backend.',
        );
      }
      if (!res.ok) throw new Error(`GitHub rechazó la asignación (${res.status}).`);
    }
    await this.invalidate(slug); // memoria + caché compartido → el board refleja el cambio
    return { ok: true, issue: issueNumber, login: target || null };
  }

  /** Mueve una tarjeta a otra columna = setea su campo `Status` en el board (como
   *  arrastrar en Jira). Requiere un token con ESCRITURA de Projects
   *  (GITHUB_WRITE_TOKEN). La autorización por ROL la hace el controller
   *  (RolesService) ANTES de llamar acá. */
  async moveCard(slug: string, issueNumber: number, statusName: string) {
    const token = process.env.GITHUB_WRITE_TOKEN || this.token;
    if (!token) throw new Error('GitHub token de escritura no configurado en el servidor.');

    const { data: client } = await this.supabase
      .from('qa_clients')
      .select('display_name')
      .eq('slug', slug)
      .maybeSingle();
    const project = await this.resolveProject(client?.display_name ?? slug, slug);
    if (!project) throw new Error('No se encontró el board del cliente.');

    // 1. El item del issue EN ESTE proyecto (+ node id del proyecto).
    const itemData = await this.gql<{
      repository: {
        issue: { projectItems: { nodes: { id: string; project: { id: string; number: number } }[] } } | null;
      } | null;
    }>(ISSUE_ITEM_QUERY, { owner: this.owner, name: `qa-${slug}`, number: issueNumber }, token);
    const item = (itemData.repository?.issue?.projectItems?.nodes ?? []).find(
      (n) => n.project?.number === project.number,
    );
    if (!item) throw new Error(`El issue #${issueNumber} no está en el board del cliente.`);

    // 2. El campo Status y la opción (columna) destino.
    const fieldData = await this.gql<{
      organization: {
        projectV2: { field: { id: string; options?: { id: string; name: string }[] } | null } | null;
      } | null;
    }>(STATUS_FIELD_QUERY, { owner: this.owner, number: project.number }, token);
    const field = fieldData.organization?.projectV2?.field;
    const option = (field?.options ?? []).find((o) => o.name === statusName);
    if (!field?.id || !option) throw new Error(`La columna "${statusName}" no existe en el board.`);

    // 3. Setear el Status del item.
    await this.gql(
      MOVE_MUTATION,
      { projectId: item.project.id, itemId: item.id, fieldId: field.id, optionId: option.id },
      token,
    );

    await this.invalidate(slug); // memoria + caché compartido → el board refleja el nuevo estado
    return { ok: true, issue: issueNumber, status: statusName };
  }

  /** Trazabilidad pruebas↔historias de la última corrida (qa_runs.coverage). */
  private async fetchQaInfo(slug: string): Promise<ScrumQaInfo | null> {
    try {
      const { data: run } = await this.supabase
        .from('qa_runs')
        .select('coverage, report_url, created_at')
        .eq('client_slug', slug)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!run) return null;
      const cov = (run.coverage ?? {}) as {
        story_map?: ScrumQaInfo['story_map'];
        unmapped_tests?: string[];
      };
      return {
        report_url: run.report_url ?? null,
        run_at: run.created_at ?? null,
        story_map: cov.story_map ?? [],
        unmapped_tests: cov.unmapped_tests ?? [],
      };
    } catch {
      return null; // sin corridas o sin acceso → el board degrada sin romper
    }
  }

  /** Usuarios asignables del repo del cliente (miembros de la org con acceso). */
  private async fetchMembers(slug: string): Promise<ScrumAssignee[]> {
    try {
      const data = await this.gql<{
        repository: { assignableUsers: { nodes: { login: string; avatarUrl: string | null }[] } } | null;
      }>(MEMBERS_QUERY, { owner: this.owner, name: `qa-${slug}` });
      return (data.repository?.assignableUsers?.nodes ?? []).map((u) => ({
        login: u.login,
        avatarUrl: u.avatarUrl,
      }));
    } catch {
      return []; // sin acceso al repo o repo inexistente → degradamos sin romper
    }
  }

  /** Iteraciones del campo Sprint (con fechas y estado abierto/cerrado). */
  private async fetchSprints(number: number): Promise<ScrumSprint[]> {
    try {
      const data = await this.gql<{
        organization: {
          projectV2: {
            field: {
              configuration?: {
                iterations: RawIteration[];
                completedIterations: RawIteration[];
              };
            } | null;
          } | null;
        } | null;
      }>(SPRINTS_QUERY, { owner: this.owner, number });

      const cfg = data.organization?.projectV2?.field?.configuration;
      if (!cfg) return [];

      const toSprint = (it: RawIteration, completed: boolean): ScrumSprint => {
        let endDate: string | null = null;
        if (it.startDate && it.duration) {
          const d = new Date(`${it.startDate}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() + it.duration - 1);
          endDate = d.toISOString().slice(0, 10);
        }
        return { title: it.title, startDate: it.startDate, endDate, completed };
      };

      return [
        ...(cfg.completedIterations ?? []).map((it) => toSprint(it, true)),
        ...(cfg.iterations ?? []).map((it) => toSprint(it, false)),
      ].sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
    } catch {
      return []; // si el campo no es de iteración o no hay acceso, degradamos sin romper
    }
  }
}

// Proyectos de la org, paginados (100/página) para encontrar el del cliente sin
// el techo de 80 que tenía la consulta vieja (se rompía al crecer la org).
const PROJECTS_QUERY = `
query($owner:String!, $cursor:String) {
  organization(login:$owner) {
    projectsV2(first:100, after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url }
    }
  }
}`;

// Usuarios asignables del repo del cliente = miembros de la org con acceso al
// repo. Pueblan el filtro "Persona" aunque ningún issue tenga asignados aún.
const MEMBERS_QUERY = `
query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    assignableUsers(first:50) { nodes { login avatarUrl } }
  }
}`;

// Config del campo Sprint (iteración): iteraciones activas + completadas con
// fechas. Permite mostrar rango de fechas y estado abierto/cerrado por sprint.
const SPRINTS_QUERY = `
query($owner:String!, $number:Int!) {
  organization(login:$owner) {
    projectV2(number:$number) {
      field(name:"Sprint") {
        ... on ProjectV2IterationField {
          configuration {
            iterations { title startDate duration }
            completedIterations { title startDate duration }
          }
        }
      }
    }
  }
}`;

// Items del Project con sus campos y el contenido del issue. Sin `parent` para
// que la query sea robusta entre variantes de la API (la jerarquía de épicas se
// agrega en una iteración futura).
const ITEMS_QUERY = `
query($owner:String!, $number:Int!, $cursor:String) {
  organization(login:$owner) {
    projectV2(number:$number) {
      items(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValues(first:20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } }
            }
          }
          content {
            ... on Issue {
              number title url
              parent { number }
              labels(first:10){ nodes { name } }
              assignees(first:5){ nodes { login avatarUrl } }
            }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}`;

// El item de un issue DENTRO de un proyecto (para moverlo). Trae el node id del
// item y del proyecto, filtrando por número de proyecto en el código.
const ISSUE_ITEM_QUERY = `
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    issue(number:$number) {
      projectItems(first:10) { nodes { id project { id number } } }
    }
  }
}`;

// El campo Status del board: id + opciones (columnas) con su id, para resolver la
// opción destino por nombre.
const STATUS_FIELD_QUERY = `
query($owner:String!, $number:Int!) {
  organization(login:$owner) {
    projectV2(number:$number) {
      field(name:"Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
    }
  }
}`;

// Setea el Status (columna) de un item del board.
const MOVE_MUTATION = `
mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {
  updateProjectV2ItemFieldValue(input:{
    projectId:$projectId, itemId:$itemId, fieldId:$fieldId,
    value:{ singleSelectOptionId:$optionId }
  }) { projectV2Item { id } }
}`;
