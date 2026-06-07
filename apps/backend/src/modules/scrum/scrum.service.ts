import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import type {
  ScrumBoard,
  ScrumCard,
  ScrumColumn,
  ScrumEpic,
  ScrumIssueType,
  ScrumPriority,
} from '../../shared-types';

const GITHUB_GRAPHQL = 'https://api.github.com/graphql';
// Orden de columnas del kanban (coincide con el Status del board, rules/96).
const COLUMN_ORDER = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];
const CACHE_TTL_MS = 60_000;

const TYPE_MAP: Record<string, ScrumIssueType> = {
  Épica: 'epic', Epica: 'epic', Historia: 'story', Tarea: 'task', Bug: 'bug', Spike: 'spike',
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

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    config: ConfigService,
  ) {
    this.token = config.get<string>('GITHUB_TOKEN');
    this.owner = config.get<string>('GITHUB_PROJECT_OWNER') ?? 'fridaKhalo';
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
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.board;

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
      updated_at: new Date().toISOString(),
    };

    if (!client) return { ...base, reason: 'client_not_found' };
    if (!this.token) return { ...base, reason: 'missing_github_token' };

    try {
      const project = await this.resolveProject(client.display_name, slug);
      if (!project) return this.store(slug, { ...base, reason: 'board_not_found' });
      const built = await this.buildBoard(base, project.number, project.url);
      return this.store(slug, built);
    } catch (err) {
      this.logger.error(`getBoard(${slug}) falló: ${(err as Error).message}`);
      return { ...base, reason: 'github_error' };
    }
  }

  private store(slug: string, board: ScrumBoard): ScrumBoard {
    this.cache.set(slug, { ts: Date.now(), board });
    return board;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
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

  /** Encuentra el Project del cliente por título "Cliente: <nombre>" (o que contenga el slug). */
  private async resolveProject(displayName: string, slug: string) {
    const data = await this.gql<{
      user: { projectsV2: { nodes: { number: number; title: string; url: string }[] } } | null;
    }>(
      `query($owner:String!){ user(login:$owner){ projectsV2(first:80){ nodes{ number title url } } } }`,
      { owner: this.owner },
    );
    const nodes = data.user?.projectsV2?.nodes ?? [];
    const want = `cliente: ${displayName}`.toLowerCase();
    return (
      nodes.find((n) => n.title.toLowerCase() === want) ??
      nodes.find((n) => n.title.toLowerCase().includes(slug.toLowerCase())) ??
      null
    );
  }

  private async buildBoard(base: ScrumBoard, number: number, url: string): Promise<ScrumBoard> {
    const columns = new Map<string, ScrumColumn>(
      COLUMN_ORDER.map((k) => [k, { key: k, title: k, cards: [] as ScrumCard[] }]),
    );
    const epics: ScrumEpic[] = [];
    const sprints = new Set<string>();

    let cursor: string | null = null;
    do {
      const data: any = await this.gql(ITEMS_QUERY, { owner: this.owner, number, cursor });
      const items = data.user?.projectV2?.items;
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
          labels: (content.labels?.nodes ?? []).map((l: any) => l.name),
          assignees: (content.assignees?.nodes ?? []).map((a: any) => ({
            login: a.login,
            avatarUrl: a.avatarUrl ?? null,
          })),
        };

        if (type === 'epic') {
          epics.push({ number: card.number, title: card.title, url: card.url });
        }
        const colKey = status && columns.has(status) ? status : 'Backlog';
        columns.get(colKey)!.cards.push(card);
      }
      cursor = items?.pageInfo?.hasNextPage ? items.pageInfo.endCursor : null;
    } while (cursor);

    return {
      ...base,
      configured: true,
      project_number: number,
      project_url: url,
      columns: COLUMN_ORDER.map((k) => columns.get(k)!),
      epics,
      sprints: Array.from(sprints).sort(),
      updated_at: new Date().toISOString(),
    };
  }
}

// Items del Project con sus campos y el contenido del issue. Sin `parent` para
// que la query sea robusta entre variantes de la API (la jerarquía de épicas se
// agrega en una iteración futura).
const ITEMS_QUERY = `
query($owner:String!, $number:Int!, $cursor:String) {
  user(login:$owner) {
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
