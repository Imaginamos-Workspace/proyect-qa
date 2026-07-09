import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type {
  SalesProspect,
  SalesProspectSearchInput,
  SalesProspectSearchResult,
  SalesProspectsStatus,
} from '../../shared-types/sales.types';

// Búsqueda de personas de Apollo.io (People Search). La key va en el header
// X-Api-Key y se configura SOLO como variable de entorno del backend
// (APOLLO_API_KEY) — nunca viaja al frontend ni se persiste en ningún lado.
const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_people/search';
const APOLLO_TIMEOUT_MS = 15_000;
const PER_PAGE = 24;
// Tope defensivo por filtro — Apollo acepta listas largas pero acá nadie
// necesita más, y acota el tamaño del request.
const MAX_FILTER_ITEMS = 10;

// Shape mínimo que usamos de la respuesta de Apollo (el real trae mucho más).
interface ApolloPerson {
  id?: string;
  name?: string;
  title?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  linkedin_url?: string | null;
  organization?: { name?: string | null; website_url?: string | null; industry?: string | null } | null;
}

interface ApolloSearchResponse {
  people?: ApolloPerson[];
  contacts?: ApolloPerson[];
  pagination?: { page?: number; total_pages?: number; total_entries?: number };
}

@Injectable()
export class ProspectsService {
  private readonly logger = new Logger(ProspectsService.name);

  private get apiKey(): string | null {
    return process.env.APOLLO_API_KEY?.trim() || null;
  }

  /** ¿Está el flujo activo? El frontend usa esto para mostrar la guía de
   *  configuración en vez del buscador cuando falta la key. */
  status(): SalesProspectsStatus {
    return { configured: !!this.apiKey };
  }

  async search(input: SalesProspectSearchInput): Promise<SalesProspectSearchResult> {
    const key = this.apiKey;
    if (!key) {
      throw new BadRequestException(
        'Falta configurar APOLLO_API_KEY en el backend. Agrégala en Vercel (proyecto del backend → Settings → Environment Variables) y redeploya; en local va en apps/backend/.env.',
      );
    }

    const clean = (arr?: string[]) =>
      (arr ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, MAX_FILTER_ITEMS);
    const titles = clean(input.titles);
    const locations = clean(input.locations);
    const employeeRanges = clean(input.employeeRanges);
    const keywords = (input.keywords ?? '').trim();
    if (!keywords && !titles.length && !locations.length && !employeeRanges.length) {
      throw new BadRequestException('Da al menos un criterio de búsqueda (texto, cargo o ubicación).');
    }

    const body: Record<string, unknown> = {
      page: Math.max(1, Math.trunc(input.page ?? 1)),
      per_page: PER_PAGE,
    };
    if (keywords) body.q_keywords = keywords;
    if (titles.length) body.person_titles = titles;
    if (locations.length) body.person_locations = locations;
    if (employeeRanges.length) body.organization_num_employees_ranges = employeeRanges;

    let res: Response;
    try {
      res = await fetch(APOLLO_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.error(`Apollo no respondió: ${(err as Error).message}`);
      throw new ServiceUnavailableException('Apollo.io no respondió (timeout/red). Intenta de nuevo en un momento.');
    }

    if (res.status === 401 || res.status === 403) {
      // El cuerpo trae el motivo REAL (key inválida vs plan sin acceso a la
      // API vs endpoint que exige master key) — sin esto solo se puede adivinar.
      const detail = (await res.text().catch(() => '')).slice(0, 250);
      throw new BadRequestException(`Apollo rechazó la petición (${res.status}). Motivo de Apollo: ${detail || '(sin detalle)'}`);
    }
    if (res.status === 429) {
      throw new ServiceUnavailableException('Apollo devolvió rate limit (429). Espera un momento antes de buscar de nuevo.');
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      this.logger.error(`Apollo search ${res.status}: ${detail}`);
      throw new ServiceUnavailableException(`Apollo devolvió ${res.status}. ${detail}`);
    }

    const data = (await res.json().catch(() => ({}))) as ApolloSearchResponse;
    const people = [...(data.people ?? []), ...(data.contacts ?? [])];

    return {
      prospects: people.map((p) => this.toProspect(p)).filter((p): p is SalesProspect => !!p),
      page: data.pagination?.page ?? Number(body.page),
      totalPages: data.pagination?.total_pages ?? 1,
      totalEntries: data.pagination?.total_entries ?? people.length,
    };
  }

  private toProspect(p: ApolloPerson): SalesProspect | null {
    if (!p?.id || !p?.name) return null;
    const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;
    // Apollo manda placeholders tipo "email_not_unlocked@domain.com" cuando el
    // email requiere crédito de enriquecimiento — eso no es un email real.
    const email = p.email && !p.email.includes('not_unlocked') ? p.email : null;
    return {
      id: p.id,
      name: p.name,
      title: p.title ?? null,
      company: p.organization?.name ?? null,
      companyWebsite: p.organization?.website_url ?? null,
      industry: p.organization?.industry ?? null,
      location,
      linkedinUrl: p.linkedin_url ?? null,
      email,
    };
  }
}
